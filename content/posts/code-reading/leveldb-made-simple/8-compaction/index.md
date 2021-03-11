---
title: "深入浅出LevelDB —— 0x08 Compaction [施工中]"
date: 2021-03-11T14:16:25+08:00
lastmod: 2021-03-11T14:16:22+08:00
draft: false
keywords: []
description: ""
tags: ["LevelDB", "LSMTree"]
categories: ["深入浅出LevelDB"]
author: ""
resources:
- name: featured-image
  src: leveldb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

正如Rebalance与Spill之于B+Tree，Compaction操作是LSMTree的核心。

本节将介绍并分析LevelDB中LSMTree的Compaction操作的实现。

## 1. Compaction的类型

LevelDB中LSMTree的Compaction操作分为两类，分别是Minor Compaction与Major Compaction。

- Minor Compaction（Immutable MemTable -> SSTable）：将Immutable MemTable转储为level-0 SSTable写入。
- Major Compaction（Low-level SSTable -> High-level SSTable）：合并压缩第i层的SSTable，生成第i+1层的SSTable。

在LevelDB中，Major Compaction还可以按照触发条件分为三类：

- Size Compaction：根据每层文件大小触发（level-0根据文件数）的Major Compaction。
- Seek Compaction：根据SSTable的seek miss触发的Major Compaction。
- Manual Compaction：LevelDB使用者通过接口`void CompactRange(const Slice* begin, const Slice* end)`手动触发。

下面我们具体分析各种Compaction的触发时机。

## 2. Compaction的触发

在介绍LevelDB中Compaction的触发时机前，我们先来了解一下LevelDB的后台线程。

### 2.1 后台线程

为了防止Compaction执行时阻塞LevelDB的正常读写，LevelDB的所有Compaction都通过一个后台线程执行。LevelDB的后台线程的实现依赖系统环境，因此其接口定义在了`include/leveldb/env.h`中，在不同环境中的实现分别位于`util/env_windows.cc`与`env_posix.cc`中。本文只考虑其在POSIX环境下的实现。

如果需要Compaction，LevelDB会通过如下代码调度后台线程：

```cpp

void DBImpl::MaybeScheduleCompaction() {

    //... ...

    env_->Schedule(&DBImpl::BGWork, this);

}

void DBImpl::BGWork(void* db) {
  reinterpret_cast<DBImpl*>(db)->BackgroundCall();
}

```

该方法调用了`include/leveldb/env.h`中定义的`Schedule`接口，我们先来看看其接口定义上的注释：

```cpp

  // Arrange to run "(*function)(arg)" once in a background thread.
  //
  // "function" may run in an unspecified thread.  Multiple functions
  // added to the same Env may run concurrently in different threads.
  // I.e., the caller may not assume that background work items are
  // serialized.
  virtual void Schedule(void (*function)(void* arg), void* arg) = 0;

```

从该接口上的注释可以看出，该接口会安排后台线程执行一次传入的方法。且该接口既不保证后台线程仅单线程执行，也不传入的方法保序执行。

下面我们来分析`Schedule`及其相关方法在POSIX环境下的实现。

```cpp

void PosixEnv::Schedule(
    void (*background_work_function)(void* background_work_arg),
    void* background_work_arg) {
  background_work_mutex_.Lock();

  // Start the background thread, if we haven't done so already.
  if (!started_background_thread_) {
    started_background_thread_ = true;
    std::thread background_thread(PosixEnv::BackgroundThreadEntryPoint, this);
    background_thread.detach();
  }

  // If the queue is empty, the background thread may be waiting for work.
  if (background_work_queue_.empty()) {
    background_work_cv_.Signal();
  }

  background_work_queue_.emplace(background_work_function, background_work_arg);
  background_work_mutex_.Unlock();
}

```

该方法首先检测后台线程是否创建，如果没有创建创建后台线程。接下来会将任务放入后台线程的任务队列中，并通过信号量唤醒后台线程执行。创建后台线程与操作任务队列都需要通过锁来保护，因此该方法全程加锁。

下面是后台线程的逻辑：

```cpp

// ... ...

  static void BackgroundThreadEntryPoint(PosixEnv* env) {
    env->BackgroundThreadMain();
  }

// ... ...

void PosixEnv::BackgroundThreadMain() {
  while (true) {
    background_work_mutex_.Lock();

    // Wait until there is work to be done.
    while (background_work_queue_.empty()) {
      background_work_cv_.Wait();
    }

    assert(!background_work_queue_.empty());
    auto background_work_function = background_work_queue_.front().function;
    void* background_work_arg = background_work_queue_.front().arg;
    background_work_queue_.pop();

    background_work_mutex_.Unlock();
    background_work_function(background_work_arg);
  }
}

```

后台线程会循环获取任务丢列中的任务，为了避免线程空转，在队列为空时通过信号量等待唤醒。如果队列中有任务，则获取该任务并将任务出队，然后执行任务。后台线程中操作队列的部分需要通过锁来保护，而执行任务时没有上锁，可以并行执行（但是LevelDB只使用了1个后台线程，因此Compaction仍是串行而不是并行的）。

### 2.2 触发判断

无论是Minor Compaction还是Major Compaction，在设置了相应的参数后，都会通过`DBImpl::MaybeScheduleCompaction`方法来判断是否需要执行Compaction。该方法实现如下：

```cpp

void DBImpl::MaybeScheduleCompaction() {
  mutex_.AssertHeld();
  if (background_compaction_scheduled_) {
    // Already scheduled
  } else if (shutting_down_.load(std::memory_order_acquire)) {
    // DB is being deleted; no more background compactions
  } else if (!bg_error_.ok()) {
    // Already got an error; no more changes
  } else if (imm_ == nullptr && manual_compaction_ == nullptr &&
             !versions_->NeedsCompaction()) {
    // No work to be done
  } else {
    background_compaction_scheduled_ = true;
    env_->Schedule(&DBImpl::BGWork, this);
  }
}

```

`MaybeScheduleCompaction`方法是需要在上锁时被调用的，因此其首先断言当前正持有着锁。接下来，其按照顺序做了如下判断：

1. 当前是否正在进行Compaction的调度，如果正在调度则不再调度。这里的“调度”开始于`Schedule`调度后台线程前，结束于后台线程中`BackgroundCompaction`真正完成Compaction操作后。
2. 数据库是否正在关闭，如果数据库已被关闭，则不再调度。
3. 如果后台线程报告了错误，则不再调度。
4. 如果此时还没有Immutable MemTable产生，也没有Major Compaction被触发，则不需要调度。
5. 否则，通过`Schedule`方法开始新Compaction任务调度。

`MaybeScheduleCompaction`方法通过`imm_`是否为空判断是否需要Minor Compaction，通过`manual_compaction`判断是否需要Manual Compaction；而是否需要Size Compaction或Seek Compaction，则需要通过当前的VersionSet的`NeedsCompaction`方法来判断。该方法的实现如下：

```cpp

  // Returns true iff some level needs a compaction.
  bool NeedsCompaction() const {
    Version* v = current_;
    return (v->compaction_score_ >= 1) || (v->file_to_compact_ != nullptr);
  }

```

该方法只检查了当前Version的两个字段：`compaction_score_`是否大于1或`file_to_compact_`是否不为空。其中`compaction_score_`字段用来计算是否需要触发Size Compaction，`file_to_compact_`用来计算是否需要触发Seek Compaction。关于这两个字段的计算会在下文介绍。

在了解LevelDB中Compaction整体的触发条件后，下面我们来分析每种Compaction具体的触发方式。

### 2.3 Minor Compaction的触发




## 3. Minor Compaction

## 4. Major Compaction

# 施工中 ... ...

DBImpl::BackgroundCompaction

DBImplCompactMemTable

Minor Compaction > Manual Compaction > Size Compaction > Seek Compaction

btw. Tier Compaction ( Tiering vs. Leveling )