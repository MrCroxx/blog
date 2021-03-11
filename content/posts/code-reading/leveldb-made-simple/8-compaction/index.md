---
title: "深入浅出LevelDB —— 0x08 Compaction [施工中]"
date: 2021-03-11T14:16:25+08:00
lastmod: 2021-03-11T14:16:22+08:00
draft: false
keywords: []
description: ""
tags: ["LevelDB", "LSM-Tree"]
categories: ["深入浅出LevelDB"]
author: ""
resources:
- name: featured-image
  src: leveldb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

正如Rebalance与Spill之于B+Tree，Compaction操作是LSM-Tree的核心。

本节将介绍并分析LevelDB中LSM-Tree的Compaction操作的实现。

## 1. Compaction的类型

LevelDB中LSM-Tree的Compaction操作分为两类，分别是Minor Compaction与Major Compaction。

- Minor Compaction（Immutable MemTable -> SSTable）：将Immutable MemTable转储为level-0 SSTable写入。
- Major Compaction（Low-level SSTable -> High-level SSTable）：合并压缩第i层的SSTable，生成第i+1层的SSTable。

在LevelDB中，Major Compaction还可以按照触发条件分为三类：

- Size Compaction：根据每层总SSTable大小触发（level-0根据SSTable数）的Major Compaction。
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

### 2.2 Compaction优先级

LevelDB中Compaction具有优先级，其顺序为：Minor Compaction > Manual Compaction > Size Compaction > Seek Compaction。本节将根据源码来分析这一优先级的体现。

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

Minor Compaction在MemTable大小超过限制时（默认为4MB）触发，LevelDB在写入变更前，首先会通过`DBImpl::MakeRoomForWrite`方法来在MemTable过大时将其转为Immutable MemTable，在该方法中，我们也能够找到尝试触发Compcation调度的调用。这里我们完整地看一下`DBImpl::MakeRoomForWrite`的实现：

```cpp

// REQUIRES: mutex_ is held
// REQUIRES: this thread is currently at the front of the writer queue
Status DBImpl::MakeRoomForWrite(bool force) {
  mutex_.AssertHeld();
  assert(!writers_.empty());
  bool allow_delay = !force;
  Status s;
  while (true) {
    if (!bg_error_.ok()) {
      // Yield previous error
      s = bg_error_;
      break;
    } else if (allow_delay && versions_->NumLevelFiles(0) >=
                                  config::kL0_SlowdownWritesTrigger) {
      // We are getting close to hitting a hard limit on the number of
      // L0 files.  Rather than delaying a single write by several
      // seconds when we hit the hard limit, start delaying each
      // individual write by 1ms to reduce latency variance.  Also,
      // this delay hands over some CPU to the compaction thread in
      // case it is sharing the same core as the writer.
      mutex_.Unlock();
      env_->SleepForMicroseconds(1000);
      allow_delay = false;  // Do not delay a single write more than once
      mutex_.Lock();
    } else if (!force &&
               (mem_->ApproximateMemoryUsage() <= options_.write_buffer_size)) {
      // There is room in current memtable
      break;
    } else if (imm_ != nullptr) {
      // We have filled up the current memtable, but the previous
      // one is still being compacted, so we wait.
      Log(options_.info_log, "Current memtable full; waiting...\n");
      background_work_finished_signal_.Wait();
    } else if (versions_->NumLevelFiles(0) >= config::kL0_StopWritesTrigger) {
      // There are too many level-0 files.
      Log(options_.info_log, "Too many L0 files; waiting...\n");
      background_work_finished_signal_.Wait();
    } else {
      // Attempt to switch to a new memtable and trigger compaction of old
      assert(versions_->PrevLogNumber() == 0);
      uint64_t new_log_number = versions_->NewFileNumber();
      WritableFile* lfile = nullptr;
      s = env_->NewWritableFile(LogFileName(dbname_, new_log_number), &lfile);
      if (!s.ok()) {
        // Avoid chewing through file number space in a tight loop.
        versions_->ReuseFileNumber(new_log_number);
        break;
      }
      delete log_;
      delete logfile_;
      logfile_ = lfile;
      logfile_number_ = new_log_number;
      log_ = new log::Writer(lfile);
      imm_ = mem_;
      has_imm_.store(true, std::memory_order_release);
      mem_ = new MemTable(internal_comparator_);
      mem_->Ref();
      force = false;  // Do not force another compaction if have room
      MaybeScheduleCompaction();
    }
  }
  return s;
}

```

`DBImpl::MakeRoomForWrite`方法执行了以下功能：
1. 通过断言确保当前持有着锁。
2. 如果后台线程报错，退出执行。
3. 如果当前level-0中的SSTable数即将超过最大限制（默认为8，而当level-0的SSTable数达到4时即可触发Minor Compaction），这可能是写入过快导致的。此时会开启流控，将每条写入都推迟1ms，以给Minor Compaction留出时间。如果调用该方法时参数`force`为true，则不会触发流控。
4. 如果`force`为false且MemTable估算的大小没有超过限制（默认为4MB），则直接退出，不需要进行Minor Compaction。
5. 如果此时有未完成Minor Compaction的Immutable MemTable，此时循环等待Minor Compaction执行完成再执行。
6. 如果当前level-0层的SSTable数过多（默认为8），此时循环等待level-0层SSTable数低于该上限，以避免level-0层SSTable过多
7. 否则，将当前的MemTable转为Immutable，并调用`MaybeScheduleCompaction`方法尝试通过后台线程调度Compcation执行（此时`imm_`会引用旧的MemTable，以让`MaybeScheduleCompaction`得知当前需要Minor Compaction）。

`DBImpl::MakeRoomForWrite`方法在判断是否需要进行Minor Compaction时，LevelDB通过流控与等待的方式，避免level-0层SSTable数过多。这是因为level-0层的key之间是有重叠的，因此当查询level-0层SSTable时，需要查找level-0层的所有SSTable。如果level-0层SSTable太多，会严重拖慢查询效率。

### 2.4 Size Compaction的触发

Size Compaction在非level-0层是根据该层的总SSTable大小触发的，而在level-0层是根据该层SSTable数触发的。也就是说，只有发生了Compaction，才有可能触发Size Compaction。因为Compaction的执行会导致Version的更新，因此LevelDB在`VersionSet::LogAndApply`方法更新Version后，让其调用`VersionSet::Finalize`方法来计算每层SSTable是否需要Size Compaction，并选出最需要进行Size Compaction的层作为下次Size Compaction的目标。

`VersionSet::Finalize`方法实现如下：

```cpp

void VersionSet::Finalize(Version* v) {
  // Precomputed best level for next compaction
  int best_level = -1;
  double best_score = -1;

  for (int level = 0; level < config::kNumLevels - 1; level++) {
    double score;
    if (level == 0) {
      // We treat level-0 specially by bounding the number of files
      // instead of number of bytes for two reasons:
      //
      // (1) With larger write-buffer sizes, it is nice not to do too
      // many level-0 compactions.
      //
      // (2) The files in level-0 are merged on every read and
      // therefore we wish to avoid too many files when the individual
      // file size is small (perhaps because of a small write-buffer
      // setting, or very high compression ratios, or lots of
      // overwrites/deletions).
      score = v->files_[level].size() /
              static_cast<double>(config::kL0_CompactionTrigger);
    } else {
      // Compute the ratio of current size to size limit.
      const uint64_t level_bytes = TotalFileSize(v->files_[level]);
      score =
          static_cast<double>(level_bytes) / MaxBytesForLevel(options_, level);
    }

    if (score > best_score) {
      best_level = level;
      best_score = score;
    }
  }

  v->compaction_level_ = best_level;
  v->compaction_score_ = best_score;
}

```

该方法计算了每层需要Size Compaction的`score`，并选出`score`最大的层作为下次Size Compaction的目标（如果`score`小于1，会被`MaybeScheduleCompaction`方法忽略）。其计算依据为：

1. 对于level-0，计算该层SSTable数与应触发level-0 Compaction的SSTable数的比值（默认为4）作为score。
2. 对于非level-0，计算该层SSTable总大小与该层预设大小的比值作为score。level-1层的预设大小为10MB，之后每层依次*10。

计算完score后，需要等待Size Compaction的触发。Size Compaction的触发发生在后台线程调用的`DBImpl::BackgroundCall`方法中。该方法在完成Compaction操作后，会再次调用`MaybeScheduleCompaction`方法，来触发因上次Compaction而需要的Size Compaction操作。

```cpp

void DBImpl::BackgroundCall() {
  
  // ... ...

  // Previous compaction may have produced too many files in a level,
  // so reschedule another compaction if needed.
  MaybeScheduleCompaction();
  background_work_finished_signal_.SignalAll();
}

```

### 2.5 Seek Compaction的触发

在介绍Seek Compaction触发条件前，我们先来看为什么需要Seek Compaction。

在LSM-Tree中，除了level-0外，虽然每个level的SSTable间相互没有overlap，但是level与level间的SSTable是可以有overlap的，如下图中的实例所示。

![overlap](assets/overlap.svg "overlap")

在本例中，如果查找键`18`时在level-k前都没有命中，则查询会下推到level-k。在level-k层中，因为SSTable(k, i)的key范围覆盖了`18`，LevelDB会在该SSTable中查找是否存在要查找的key `18`（实际上查找的是该SSTable在TableCache中的filter），该操作被称为“seek”。当LevelDB在level-k中没有找到要查找的key时，才会继续在level-(k+1)中查找。

![seek miss](assets/seek-miss.svg "seek miss")

在上图的示例中，每当LevelDB要查找key `18`时，因为SSTable(k, i)的key范围覆盖了`18`，所以其每次都必须在该SSTable中seek，这一不必要的seek操作会导致性能下降。因此，在FileMetaData结构体中引入了`allowed_seeks`字段，该字段初始为文件大小与16KB的比值，不足100则取100；每次无效seek发生时LevelDB都会将该字段值减1。当某SSTable的`allowed_seeks`减为0时，会触发seek compaction，该SSTable会与下层部分SSTable合并。合并后的SSTable如下图所示。

![match](assets/match.svg "match")

{{< admonition quote 引文 >}}

`allow_seeks`字段初始值取值原因：

      // We arrange to automatically compact this file after
      // a certain number of seeks.  Let's assume:
      //   (1) One seek costs 10ms
      //   (2) Writing or reading 1MB costs 10ms (100MB/s)
      //   (3) A compaction of 1MB does 25MB of IO:
      //         1MB read from this level
      //         10-12MB read from next level (boundaries may be misaligned)
      //         10-12MB written to next level
      // This implies that 25 seeks cost the same as the compaction
      // of 1MB of data.  I.e., one seek costs approximately the
      // same as the compaction of 40KB of data.  We are a little
      // conservative and allow approximately one seek for every 16KB
      // of data before triggering a compaction.

{{</ admonition >}}

合并后，当LevelDB需要查找key `18`时，在level-k中便没有了覆盖key `18`的SSTable，因此会直接在level-(k+1)中找到该key所在的SSTable。这样便避免这次无效的seek。

因为Seek Compcation的触发需要在SSTable上seek，因此我们从`DBImpl::Get`方法查找SSTable时开始分析。由于LevelDB的查找操作涉及到多层，笔者将在本系列的后续文章中详细介绍其流程，本文尽可能屏蔽目前不需要的细节。

```cpp

Status DBImpl::Get(const ReadOptions& options, const Slice& key,
                   std::string* value) {
  
  // ... ...
  
  Version::GetStats stats;

  // Unlock while reading from files and memtables
  {
    mutex_.Unlock();
    // First look in the memtable, then in the immutable memtable (if any).
    LookupKey lkey(key, snapshot);
    if (mem->Get(lkey, value, &s)) {
      // Done
    } else if (imm != nullptr && imm->Get(lkey, value, &s)) {
      // Done
    } else {
      s = current->Get(options, lkey, value, &stats);
      have_stat_update = true;
    }
    mutex_.Lock();
  }

  if (have_stat_update && current->UpdateStats(stats)) {
    MaybeScheduleCompaction();
  }

}

```

当LevelDB查找key时，会记录一些统计信息。当在SSTable上发生查找时，会记录发生seek miss的 SSTable，这样会更新Version中其相应的FileMetaData中的`allowed_seeks`字段，并通过`MaybeScheduleCompaction`检查是否需要触发Seek Compaction。

```cpp

  // Lookup the value for key.  If found, store it in *val and
  // return OK.  Else return a non-OK status.  Fills *stats.
  // REQUIRES: lock is not held
  struct GetStats {
    FileMetaData* seek_file;
    int seek_file_level;
  };

// ... ...

Status Version::Get(const ReadOptions& options, const LookupKey& k,
                    std::string* value, GetStats* stats) {
  stats->seek_file = nullptr;
  stats->seek_file_level = -1;

  struct State {
    Saver saver;
    GetStats* stats;
    const ReadOptions* options;
    Slice ikey;
    FileMetaData* last_file_read;
    int last_file_read_level;

    VersionSet* vset;
    Status s;
    bool found;

    static bool Match(void* arg, int level, FileMetaData* f) {
      State* state = reinterpret_cast<State*>(arg);

      if (state->stats->seek_file == nullptr &&
          state->last_file_read != nullptr) {
        // We have had more than one seek for this read.  Charge the 1st file.
        state->stats->seek_file = state->last_file_read;
        state->stats->seek_file_level = state->last_file_read_level;
      }

      state->last_file_read = f;
      state->last_file_read_level = level;

      state->s = state->vset->table_cache_->Get(*state->options, f->number,
                                                f->file_size, state->ikey,
                                                &state->saver, SaveValue);
      if (!state->s.ok()) {
        state->found = true;
        return false;
      }
      switch (state->saver.state) {
        case kNotFound:
          return true;  // Keep searching in other files
        case kFound:
          state->found = true;
          return false;
        case kDeleted:
          return false;
        case kCorrupt:
          state->s =
              Status::Corruption("corrupted key for ", state->saver.user_key);
          state->found = true;
          return false;
      }

      // Not reached. Added to avoid false compilation warnings of
      // "control reaches end of non-void function".
      return false;
    }
  };

  State state;
  state.found = false;
  state.stats = stats;
  state.last_file_read = nullptr;
  state.last_file_read_level = -1;

  state.options = &options;
  state.ikey = k.internal_key();
  state.vset = vset_;

  state.saver.state = kNotFound;
  state.saver.ucmp = vset_->icmp_.user_comparator();
  state.saver.user_key = k.user_key();
  state.saver.value = value;

  ForEachOverlapping(state.saver.user_key, state.ikey, &state, &State::Match);

  return state.found ? state.s : Status::NotFound(Slice());
}

```

这里笔者给出`Version::Get`方法的实现，但本文我们只需要关注其中`State`结构体及其`Match`方法的实现，其它部分笔者会在本系列后续文章中介绍。`Version::Get`方法会通过` Version::ForEachOverlapping`方法来逐层遍历覆盖了给定LookUpKey的SSTable，并在该SSTable上调用`State::Match`判断其中是否有我们想要查找的InternalKey，即只要发生了seek就会调用`State::Match`方法。如果在该SSTable中没有找到需要的key，该方法会返回true表示需要继续查找；如果找到了需要查找的key，则返回false表示不再需要继续查找。`State::Match`方法还会记录**第一次**发生seek miss的SSTable。随后`DBImpl::Get`会将该SSTable的`allowed_seeks`减一,并通过`MaybeScheduleCompaction`检查是否需要触发Seek Compaction。

### 2.6 Manual Compaction的触发

Manual Comapction的触发时机比较简单，当LevelDB的用户调用`DB::CompactRange`接口时，LevelDB会检查用户给定的Compact范围。

## 3. Compaction的范围

# 施工中 ... ...


## x. Minor Compaction

## x. Major Compaction


DBImpl::BackgroundCompaction

DBImplCompactMemTable

btw. Tier Compaction ( Tiering vs. Leveling )