---
title: "深入浅出LevelDB —— 0x09 Compaction [施工中]"
date: 2021-03-11T14:16:25+08:00
lastmod: 2021-03-13T16:48:24+08:00
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

1. 当前是否正在进行Compaction的调度，如果正在调度则不再调度。这里的“调度”开始于`Schedule`调度后台线程前，结束于后台线程中`BackgroundCompaction`方法中完成Compaction操作后。
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

Manual Comapction的触发时机比较简单，当LevelDB的用户调用`DB::CompactRange`接口时，LevelDB会检查用户给定的Compact范围与当前状态，判断是否需要执行Manual Compaction。如果确定执行Manual Compaction，则设置`manual_compaction_`，再调用` MaybeScheduleCompaction`方法以尝试触发Manual Compaction。

## 3. Compaction的范围

Compaction在触发后，首先要确定Compact的范围。本节，笔者将介绍并分析LevelDB中Comapction范围的确定。

LevelDB在确定Minor Compaction范围与Major Compaction范围的方法区别很大，因此这里分别介绍。

### 3.1 Minor Compaction范围的确定

在LST-Tree的基本概念中，Minor Compaction只需要将Immutable MemTable全量转储为SSTable，并将其推至level-0即可。而LevelDB对这一步骤进行了优化，其会将Minor Comapction生成的SSTable推至更高的层级。该优化的依据如下：

- 由于level 0中SSTable间可能存在overlap，发生在level 0=>1的Major Compaction开销相对较大。为了尽可能避免level 0=>1的Major Compaction开销并避免一些开销较大的Manifest文件操作，LevelDB会将Minor Comapction产生的MemTable尽可能推至更高level。
- LevelDB也不会将Minor Compaction产生的SSTable的level推得过高。SSTable的level越高越难被Compaction，因此如果该SSTable中很多Record是override操作，如果不被Compaction会造成很大的空间浪费。
- 该优化不能破坏LSM-Tree结构。

因此计算Minor Compaction范围时需要且只需要确定其生成的SSTable所在的level。其通过`Version::PickLevelForMemTableOutput`方法实现：

```cpp

int Version::PickLevelForMemTableOutput(const Slice& smallest_user_key,
                                        const Slice& largest_user_key) {
  int level = 0;
  if (!OverlapInLevel(0, &smallest_user_key, &largest_user_key)) {
    // Push to next level if there is no overlap in next level,
    // and the #bytes overlapping in the level after that are limited.
    InternalKey start(smallest_user_key, kMaxSequenceNumber, kValueTypeForSeek);
    InternalKey limit(largest_user_key, 0, static_cast<ValueType>(0));
    std::vector<FileMetaData*> overlaps;
    while (level < config::kMaxMemCompactLevel) {
      if (OverlapInLevel(level + 1, &smallest_user_key, &largest_user_key)) {
        break;
      }
      if (level + 2 < config::kNumLevels) {
        // Check that file does not overlap too many grandparent bytes.
        GetOverlappingInputs(level + 2, &start, &limit, &overlaps);
        const int64_t sum = TotalFileSize(overlaps);
        if (sum > MaxGrandParentOverlapBytes(vset_->options_)) {
          break;
        }
      }
      level++;
    }
  }
  return level;
}

```

`PickLevelForMemTableOutput`方法最初将目标level置为0，并循环判断是否可以将该level推高一层至目标level。其判断条件如下：
1. 目标level不能超过配置`config::kMaxMemCompactLevel`中限制的最大高度（默认为2）。
2. 目标level不能与该level的其它SSTable有overlap。
3. 目标level与其下一层level的overlap不能过多，其计算规则为：首先根据Immutable MemTable的key范围找出目标level的下一层level中与其存在overlap的所有文件；所有与之存在overlap的文件总大小不能超过LevelDB配置中`max_file_size`大小的10倍（默认为2MB）。
4. 如果满足以上所有条件，则将目标level推至下一层并继续循环。

### 3.2 Major Compaction

LevelDB在进行Major Compaction时，至少需要确定以下参数：
1. 确定Compaction起始层级i。
2. 确定level-i层SSTable input。
3. 确定level-(i+1)层中与待Compact的SSTable有overlap的SSTable input。

Major Compation生成的SSTable的level即为level-(i+1)。

由于三种Major Compaction的起始条件与目标都不同，其确定这三个参数的方式稍有不同。本节笔者将介绍并分析各种Major Compaction确定Compaction范围的方法与实现。

#### 3.2.1 Major Compaction的范围

LevelDB通过`Compaction`类（位于`db/version_set.h`）记录Major Compaction所需元数据：

```cpp

// A Compaction encapsulates information about a compaction.
class Compaction {
 
 // ... ...

 private:
  friend class Version;
  friend class VersionSet;

  Compaction(const Options* options, int level);

  int level_;
  uint64_t max_output_file_size_;
  Version* input_version_;
  VersionEdit edit_;

  // Each compaction reads inputs from "level_" and "level_+1"
  std::vector<FileMetaData*> inputs_[2];  // The two sets of inputs

  // State used to check for number of overlapping grandparent files
  // (parent == level_ + 1, grandparent == level_ + 2)
  std::vector<FileMetaData*> grandparents_;
  size_t grandparent_index_;  // Index in grandparent_starts_
  bool seen_key_;             // Some output key has been seen
  int64_t overlapped_bytes_;  // Bytes of overlap between current output
                              // and grandparent files

  // State for implementing IsBaseLevelForKey

  // level_ptrs_ holds indices into input_version_->levels_: our state
  // is that we are positioned at one of the file ranges for each
  // higher level than the ones involved in this compaction (i.e. for
  // all L >= level_ + 2).
  size_t level_ptrs_[config::kNumLevels];
};

```

本节中我们主要关注以下字段：
- `level`：Major Compaction的起始level（即上述level-i）。
- `input[0]`：level-i层需要Compact的SSTable编号。
- `input[1]`：level-(i+1)层需要Compact的SSTable编号。

#### 3.2.2 Size Compaction与Seek Compaction的范围

LevelDB在触发Size Compaction时，已知Compaction的起始层级i；而LevelDB在触发Seek Compaction时，已知Compaction的起始层级i和level-i层的输入SSTable。LevelDB通过`VersionSet::PickCompaction`方法来计算其它参数：

```cpp

Compaction* VersionSet::PickCompaction() {
  Compaction* c;
  int level;

  // We prefer compactions triggered by too much data in a level over
  // the compactions triggered by seeks.
  const bool size_compaction = (current_->compaction_score_ >= 1);
  const bool seek_compaction = (current_->file_to_compact_ != nullptr);
  if (size_compaction) {
    level = current_->compaction_level_;
    assert(level >= 0);
    assert(level + 1 < config::kNumLevels);
    c = new Compaction(options_, level);

    // Pick the first file that comes after compact_pointer_[level]
    for (size_t i = 0; i < current_->files_[level].size(); i++) {
      FileMetaData* f = current_->files_[level][i];
      if (compact_pointer_[level].empty() ||
          icmp_.Compare(f->largest.Encode(), compact_pointer_[level]) > 0) {
        c->inputs_[0].push_back(f);
        break;
      }
    }
    if (c->inputs_[0].empty()) {
      // Wrap-around to the beginning of the key space
      c->inputs_[0].push_back(current_->files_[level][0]);
    }
  } else if (seek_compaction) {
    level = current_->file_to_compact_level_;
    c = new Compaction(options_, level);
    c->inputs_[0].push_back(current_->file_to_compact_);
  } else {
    return nullptr;
  }

  c->input_version_ = current_;
  c->input_version_->Ref();

  // Files in level 0 may overlap each other, so pick up all overlapping ones
  if (level == 0) {
    InternalKey smallest, largest;
    GetRange(c->inputs_[0], &smallest, &largest);
    // Note that the next call will discard the file we placed in
    // c->inputs_[0] earlier and replace it with an overlapping set
    // which will include the picked file.
    current_->GetOverlappingInputs(0, &smallest, &largest, &c->inputs_[0]);
    assert(!c->inputs_[0].empty());
  }

  SetupOtherInputs(c);

  return c;
}

```

对于Size Compaction，level-i层的SSTable输入根据该level的Compaction Pointer（记录在Version中），选取上次Compaction后的第一个SSTable（如果该层还没发生过Compaction）。这是为了尽可能公平地为Size Compaction选取SSTable，避免某些SSTable永远不会被Compact。

对于Seek Compaction，该方法直接将触发Seek Compaction的SSTable加入到level-i层的输入中。

如果触发Compact的SSTable在level-0，`PickCompaction`方法会将level-0层中所有与该SSTable有overlap的SSTable加入level-0层的输入中。

在确定了`input[0]`后，`PickCompcation`方法会调用`VersionSet::SetupOtherInputs`方法。该方法首先扩展`input[0]`范围，然后确定`input[1]`，即参与Major Compaction的level-(i+1)层的SSTable。扩展`input`范围的目的是避免Compaction后无法正确查找key版本的问题。这里我们先来看一下这一问题的成因：

在Major Compaction发生前，UserKey `cat`在level-i层的SSTable中有两个版本，分别为`(cat, 101)`与`(cat, 100)`（这里仅关注UserKey与SequenceNumber）。此时，如果LevelDB查找UserKey `cat`的最新版本，其会首先查找到`(cat, 101)`，能够得到正常值。

![Major Compaction发生前](assets/boundary-before.svg "Major Compaction发生前")

此时，如果SSTable (i,x)在Major Compaction中与下一层SSTable合并，会导致`(cat, 101)`位于level-(i+1)，而`(cat, 100)`位于level-0。

![Major Compaction发生后](assets/boundary-after.svg "Major Compaction发生后")

此时，如果LevelDB再次查找UserKey `cat`的最新版本，其首先会在level-i中查找到`(cat, 100)`，因此不会再继续查询level-(i+1)，此时返回了陈旧的值。

为了避免这一问题，LevelDB在进行Major Compaction时，需要Compaction的范围。LevelDB中扩展Compaction输入范围的方法是`AddBoundaryInputs`，`SetupOtherInputs`中就是通过调用`AddBoundaryInputs`方法实现的输入扩展。

`AddBoundaryInputs`方法首先找到当前SSTable中最大的InternalKey记为`largest_key`，然后在这一level中查找满足其最小UserKey与`largest_key`相同且最小InternalKey大于`largest_key`的最小SSTable，将其加入到输入集中，并循环此过程，直到不再有新的SSTable被加入。`AddBoundaryInputs`方法依赖`FindLargestKey`与`FindSmallestBoundaryFile`方法实现了以上逻辑，这里不再赘述。

在介绍了扩展`input`的原因与方法后，我们来分段分析`SetupOtherInputs`的实现：

```cpp

void VersionSet::SetupOtherInputs(Compaction* c) {
  // (1)
  const int level = c->level();
  InternalKey smallest, largest;

  AddBoundaryInputs(icmp_, current_->files_[level], &c->inputs_[0]);
  GetRange(c->inputs_[0], &smallest, &largest);

  current_->GetOverlappingInputs(level + 1, &smallest, &largest,
                                 &c->inputs_[1]);

  // (2)
  // ... ...

  // (3)
  // ... ...

  // (4)
  // ... ...

}

```

首先我们来看(1)段。这部分通过`AddBoundaryInputs`方法扩展了level-i层参与Compaction的SSTable（即`input[0]`），然后在level-(i+1)中找到所有与level-i层参与Compaction的SSTable有overlap的SSTable，将其加入到`intput[1]`中。

初次确定的`input`范围可能出现下图示例中的情况（注：图中SSTable的宽度表示其key范围，而非文件大小）：

![初次确定的input范围](assets/reextend.svg "初次确定的input范围")

图中*黄色*的SSTable是初次选取的input。如图的示例中，由于level-(i+1)层SSTable中的key较为分散，其input范围能够容纳level-i中更多的SSTable（即图中level-i层*蓝色*的SSTable）。显然，将这些SSTable加入到`input[0]`中，不需要扩展`input[1]`的范围。因此，LevelDB会将这部分SSTable一同合并，以减少未来需要的Compaction。

`SetupOtherInputs`的段(2)实现了这一逻辑：

```cpp

  // (2)
  // Get entire range covered by compaction
  InternalKey all_start, all_limit;
  GetRange2(c->inputs_[0], c->inputs_[1], &all_start, &all_limit);

  // See if we can grow the number of inputs in "level" without
  // changing the number of "level+1" files we pick up.
  if (!c->inputs_[1].empty()) {
    std::vector<FileMetaData*> expanded0;
    current_->GetOverlappingInputs(level, &all_start, &all_limit, &expanded0);
    AddBoundaryInputs(icmp_, current_->files_[level], &expanded0);
    const int64_t inputs0_size = TotalFileSize(c->inputs_[0]);
    const int64_t inputs1_size = TotalFileSize(c->inputs_[1]);
    const int64_t expanded0_size = TotalFileSize(expanded0);
    if (expanded0.size() > c->inputs_[0].size() &&
        inputs1_size + expanded0_size <
            ExpandedCompactionByteSizeLimit(options_)) {
      InternalKey new_start, new_limit;
      GetRange(expanded0, &new_start, &new_limit);
      std::vector<FileMetaData*> expanded1;
      current_->GetOverlappingInputs(level + 1, &new_start, &new_limit,
                                     &expanded1);
      if (expanded1.size() == c->inputs_[1].size()) {
        Log(options_->info_log,
            "Expanding@%d %d+%d (%ld+%ld bytes) to %d+%d (%ld+%ld bytes)\n",
            level, int(c->inputs_[0].size()), int(c->inputs_[1].size()),
            long(inputs0_size), long(inputs1_size), int(expanded0.size()),
            int(expanded1.size()), long(expanded0_size), long(inputs1_size));
        smallest = new_start;
        largest = new_limit;
        c->inputs_[0] = expanded0;
        c->inputs_[1] = expanded1;
        GetRange2(c->inputs_[0], c->inputs_[1], &all_start, &all_limit);
      }
    }
  }

```

从段(2)可以看出，在再次扩展`input[0]`的范围时，除了需要保证不能引起`input[1]`的范围变化外，还需要扩展后的`input[0]`总的大小不超过扩展的限制（默认为25个`max_file_size`，即50MB）。

`SetupOtherInputs`其余部分的逻辑比较简单：

```cpp

  // (3)
  // Compute the set of grandparent files that overlap this compaction
  // (parent == level+1; grandparent == level+2)
  if (level + 2 < config::kNumLevels) {
    current_->GetOverlappingInputs(level + 2, &all_start, &all_limit,
                                   &c->grandparents_);
  }

  // (4)
  // Update the place where we will do the next compaction for this level.
  // We update this immediately instead of waiting for the VersionEdit
  // to be applied so that if the compaction fails, we will try a different
  // key range next time.
  compact_pointer_[level] = largest.Encode().ToString();
  c->edit_.SetCompactPointer(level, largest);

```

段(3)计算了level-(i+1)层中与Compaction的范围有overlap的SSTable，以便后续操作使用。段(4)用来设置VersionEdit中记录的Compact Pointer，在Compcation前更新Compact Pointer的好处是：如果本次Compaction失败，则下次Size Compaction发生时，可以跳过这一部分，从下一个位置Compact。

#### 3.2.3 Manual Compaction的范围

Manual Compaction通过LevelDB提供的接口`void CompactRange(const Slice* begin, const Slice* end)`触发，其所知Compaction的范围信息最少，只知道需要Compact的起始与终止key，甚至不知道发生Compaction的level。这也意味着，需要Compact的key范围，既可能在MemTable或Immutable Table中，也可能在不同level的SSTable中，甚至二者都有。因此，在Compact的时候需要考虑所有情形。

LevelDB为了确保用户给出的key范围都能够被Compact，其首先强制触发Minor Compaction，然后按照给定的key范围进行Major Compaction。

我们从`DB::CompactRange`的实现`DBImpl::CompactRange`开始分析：

```cpp

void DBImpl::CompactRange(const Slice* begin, const Slice* end) {
  int max_level_with_files = 1;
  {
    MutexLock l(&mutex_);
    Version* base = versions_->current();
    for (int level = 1; level < config::kNumLevels; level++) {
      if (base->OverlapInLevel(level, begin, end)) {
        max_level_with_files = level;
      }
    }
  }
  TEST_CompactMemTable();  // TODO(sanjay): Skip if memtable does not overlap
  for (int level = 0; level < max_level_with_files; level++) {
    TEST_CompactRange(level, begin, end);
  }
}

```

`DBImpl::CompactRange`方法首先根据给定key范围与每个level是否有overlap，得到需要Compact的最高level，然后通过`TEST_CompactMemTable`方法强制触发并等待Minor Compaction完成（当前版本因MemTable与给定key范围没有overlap而跳过Minor Compaction）。随后遍历从0到需要Compact的最高level，并按需对该层进行Major Compaction。

接下来我们来分析`TEST_CompactMemTable`与`TEST_CompactRange`的实现：

```cpp

Status DBImpl::TEST_CompactMemTable() {
  // nullptr batch means just wait for earlier writes to be done
  Status s = Write(WriteOptions(), nullptr);
  if (s.ok()) {
    // Wait until the compaction completes
    MutexLock l(&mutex_);
    while (imm_ != nullptr && bg_error_.ok()) {
      background_work_finished_signal_.Wait();
    }
    if (imm_ != nullptr) {
      s = bg_error_;
    }
  }
  return s;
}

```

`TEST_CompactMemTable`方法会通过一次“null write batch”来触发`force`参数为true的`MakeRoomForWrite`调用，`force`为true的调用会强制触发Minor Compaction（详见[2.3 Minor Compaction的触发](/posts/code-reading/leveldb-made-simple/8-compaction/#23-minor-compaction的触发)）。随后该方法等待Minor Compaction完成后返回。

```cpp

void DBImpl::TEST_CompactRange(int level, const Slice* begin,
                               const Slice* end) {
  assert(level >= 0);
  assert(level + 1 < config::kNumLevels);

  InternalKey begin_storage, end_storage;

  ManualCompaction manual;
  manual.level = level;
  manual.done = false;
  if (begin == nullptr) {
    manual.begin = nullptr;
  } else {
    begin_storage = InternalKey(*begin, kMaxSequenceNumber, kValueTypeForSeek);
    manual.begin = &begin_storage;
  }
  if (end == nullptr) {
    manual.end = nullptr;
  } else {
    end_storage = InternalKey(*end, 0, static_cast<ValueType>(0));
    manual.end = &end_storage;
  }

  MutexLock l(&mutex_);
  while (!manual.done && !shutting_down_.load(std::memory_order_acquire) &&
         bg_error_.ok()) {
    if (manual_compaction_ == nullptr) {  // Idle
      manual_compaction_ = &manual;
      MaybeScheduleCompaction();
    } else {  // Running either my compaction or another compaction.
      background_work_finished_signal_.Wait();
    }
  }
  if (manual_compaction_ == &manual) {
    // Cancel my manual compaction since we aborted early for some reason.
    manual_compaction_ = nullptr;
  }
}

```

该方法的工作也很简单，其生成了需要Compact的InternalKey范围，并配置了`manual_compaction_`字段，然后通过`MaybeScheduleCompaction`方法触发Manual Compaction，并等待期执行结束后返回。随后，Manual Compaction的执行交由后台线程来触发。后台线程在执行Manual Compaction时，会通过`VersionSet::CompactRange`方法计算其具体范围：

```cpp

Compaction* VersionSet::CompactRange(int level, const InternalKey* begin,
                                     const InternalKey* end) {
  std::vector<FileMetaData*> inputs;
  current_->GetOverlappingInputs(level, begin, end, &inputs);
  if (inputs.empty()) {
    return nullptr;
  }

  // Avoid compacting too much in one shot in case the range is large.
  // But we cannot do this for level-0 since level-0 files can overlap
  // and we must not pick one file and drop another older file if the
  // two files overlap.
  if (level > 0) {
    const uint64_t limit = MaxFileSizeForLevel(options_, level);
    uint64_t total = 0;
    for (size_t i = 0; i < inputs.size(); i++) {
      uint64_t s = inputs[i]->file_size;
      total += s;
      if (total >= limit) {
        inputs.resize(i + 1);
        break;
      }
    }
  }

  Compaction* c = new Compaction(options_, level);
  c->input_version_ = current_;
  c->input_version_->Ref();
  c->inputs_[0] = inputs;
  SetupOtherInputs(c);
  return c;
}

```

该方法会在给定level中查找与给定key范围有overlap的所有SSTable。对于非level-0的层级，该方法会限制参与Compaciton的大小不超过配置中每层最大文件大小（如果需要Compact的范围超过了每层最大文件大小，说明之前还有Size Compcation任务）；而对于level-0，由于其SSTable间可能存在overlap，因此不能舍弃参与Compaction的SSTable。在`input[0]`确定后，同样通过`SetupOtherInputs`方法，配置其它输入参数（详见[3.2.2 Size Compaction与Seek Compaction的范围](/posts/code-reading/leveldb-made-simple/8-compaction/#322-size-compaction与seek-compaction的范围)）。

## 4. Compaction的执行

从本节开始，笔者将介绍并分析LevelDB中Compaction执行的过程。

LevelDB将Compaction任务放入后台线程的Compaction任务队列后，由后台线程调度执行。其执行Compaction的行为可分为执行Minor Compaciton与Major Compaction两种。在介绍这两种Compaction的执行方法前，我们先从后台线程执行Comapciton的入口方法开始，分析Compaction的启动过程。

### 4.1 后台线程Compaction入口

```cpp

void DBImpl::BGWork(void* db) {
  reinterpret_cast<DBImpl*>(db)->BackgroundCall();
}

void DBImpl::BackgroundCall() {
  MutexLock l(&mutex_);
  assert(background_compaction_scheduled_);
  if (shutting_down_.load(std::memory_order_acquire)) {
    // No more background work when shutting down.
  } else if (!bg_error_.ok()) {
    // No more background work after a background error.
  } else {
    BackgroundCompaction();
  }

  background_compaction_scheduled_ = false;

  // Previous compaction may have produced too many files in a level,
  // so reschedule another compaction if needed.
  MaybeScheduleCompaction();
  background_work_finished_signal_.SignalAll();
}

```

`DBImpl::BGWork`方法是后台线程的执行入口，该方法直接调用了`DBImpl::BackgroundCall`方法。`DBImpl::BackgroundCall`方法通过`MutexLock`对该方法整体上锁，`MutexLock`在构造时会对传入的互斥锁上锁，析构时会对传入的互斥锁解锁，因此只需要实例化MutexLock即可在其声明周期内加锁。该方法会判断LevelDB此时既没有被关闭，也没有发生后台线程错误，然后调用`DBImpl::BackgroundCompaction`方法正式开始Compaction执行。最后，在本次Compaction执行结束后，会再次调用`MaybeScheduleCompaction`方法以免本次Compaction导致某一层文件过大超出限制（这也是Size Compaction的触发代码，上文曾介绍过这段代码）。

接着我们来分析`DBImpl::BackgroundCompaction`的实现。由于该方法较长，我们继续分段分析：

```cpp

void DBImpl::BackgroundCompaction() {
  // (1)
  mutex_.AssertHeld();

  if (imm_ != nullptr) {
    CompactMemTable();
    return;
  }

  // ... ...

}

```

`BackgroundCompaction`首先通过断言的方式确保当前持有锁，然后按照优先级来执行Compaction。首先其判断`imm_`是否存在，如果存在则通过`DBImpl::CompactionMemTable`方法来执行Minor Comapction并返回。

```cpp

  // (2)
  Compaction* c;
  bool is_manual = (manual_compaction_ != nullptr);
  InternalKey manual_end;
  if (is_manual) {
    ManualCompaction* m = manual_compaction_;
    c = versions_->CompactRange(m->level, m->begin, m->end);
    m->done = (c == nullptr);
    if (c != nullptr) {
      manual_end = c->input(0, c->num_input_files(0) - 1)->largest;
    }
    Log(options_.info_log,
        "Manual compaction at level-%d from %s .. %s; will stop at %s\n",
        m->level, (m->begin ? m->begin->DebugString().c_str() : "(begin)"),
        (m->end ? m->end->DebugString().c_str() : "(end)"),
        (m->done ? "(end)" : manual_end.DebugString().c_str()));
  } else {
    c = versions_->PickCompaction();
  }

```

接着，`BackgroundCompaction`方法计算Compaction的具体范围。这段代码我们在上一节中介绍过，这里不再赘述。

```cpp

  // (3)
  Status status;
  if (c == nullptr) {
    // Nothing to do
  } else if (!is_manual && c->IsTrivialMove()) {
    // Move file to next level
    assert(c->num_input_files(0) == 1);
    FileMetaData* f = c->input(0, 0);
    c->edit()->RemoveFile(c->level(), f->number);
    c->edit()->AddFile(c->level() + 1, f->number, f->file_size, f->smallest,
                       f->largest);
    status = versions_->LogAndApply(c->edit(), &mutex_);
    if (!status.ok()) {
      RecordBackgroundError(status);
    }
    VersionSet::LevelSummaryStorage tmp;
    Log(options_.info_log, "Moved #%lld to level-%d %lld bytes %s: %s\n",
        static_cast<unsigned long long>(f->number), c->level() + 1,
        static_cast<unsigned long long>(f->file_size),
        status.ToString().c_str(), versions_->LevelSummary(&tmp));
  } else {
    CompactionState* compact = new CompactionState(c);
    status = DoCompactionWork(compact);
    if (!status.ok()) {
      RecordBackgroundError(status);
    }
    CleanupCompaction(compact);
    c->ReleaseInputs();
    RemoveObsoleteFiles();
  }
  delete c;

```

接下来，`BackgroundCompaction`方法会根据上一步中准备好的记录了Major Compaction所需数据的`Compaction`类型的实例`c`，执行相应的方法：
1. 如果`c`为空，则无需执行，直接跳过这一步。
2. 如果当前任务不是Manual Compaction，则判断Compaction任务`c`是否只需要SSTable从一层移动到下一层即可（被称为“trivial move”），即既不需要合并SSTable也不需要拆分SSTable。Manual Compaction不使用“trivial move”，以为用户提供显式回收不再需要的文件的接口。
3. 否则，执行Compaction操作，依次调用`DoCompactionWork`、`CleanupCompaction`、`RemoveObsoleteFiles`。后文将详细分析每个方法的实现。

该方法的步骤2会通过`Compaction::IsTrivialMove`方法来判断当前Comapction任务是否不需要合并或删除SSTable，而只需要将SSTable移到下一层。如果可以“trivial move”，则LevelDB只需要通过VersionEdit来修改Version中记录的每个level的文件编号即可，而不需要读写SSTable。`Compaction::IsTrivialMove`的实现如下：

```cpp

bool Compaction::IsTrivialMove() const {
  const VersionSet* vset = input_version_->vset_;
  // Avoid a move if there is lots of overlapping grandparent data.
  // Otherwise, the move could create a parent file that will require
  // a very expensive merge later on.
  return (num_input_files(0) == 1 && num_input_files(1) == 0 &&
          TotalFileSize(grandparents_) <=
              MaxGrandParentOverlapBytes(vset->options_));
}

```

`Compaction::IsTrivialMove`方法判断规则如下：
1. 如果input[0]只有1个SSTable，input[1]中没有SSTable才可以“trivial move”，因为此时不需要合并多个SSTable。
2. 检查level-(i+2)层中与将移动到level-(i+1)层的SSTable有overlap的文件总大小，不能超过一定上限（默认为10倍`max_file_size`，即20MB）。否则，该trivial move的SSTable下一次参与Major Compaction时其合并开销会非常大。

下面，笔者将分别介绍Minor Compaction与Major Comapction的执行。

### 4.2 Minor Compaction

Minor Compaction主要通过`DBImpl::CompactionMemTable`方法实现：

```cpp

void DBImpl::CompactMemTable() {
  mutex_.AssertHeld();
  assert(imm_ != nullptr);

  // Save the contents of the memtable as a new Table
  VersionEdit edit;
  Version* base = versions_->current();
  base->Ref();
  Status s = WriteLevel0Table(imm_, &edit, base);
  base->Unref();

  if (s.ok() && shutting_down_.load(std::memory_order_acquire)) {
    s = Status::IOError("Deleting DB during memtable compaction");
  }

  // Replace immutable memtable with the generated Table
  if (s.ok()) {
    edit.SetPrevLogNumber(0);
    edit.SetLogNumber(logfile_number_);  // Earlier logs no longer needed
    s = versions_->LogAndApply(&edit, &mutex_);
  }

  if (s.ok()) {
    // Commit to the new state
    imm_->Unref();
    imm_ = nullptr;
    has_imm_.store(false, std::memory_order_release);
    RemoveObsoleteFiles();
  } else {
    RecordBackgroundError(s);
  }
}

```

`CompactionMemTable`方法首先调用`DBImpl::WriteLevel0Table`方法将Immutable MemTable转储为SSTable，由于该方法需要使用当前的Version信息，因此在调用前后增减了当前Version的引用计数以避免其被回收。接着，通过`VersionSet::LogAndApply`方法将增量的版本更新VersionEdit写入Manifest（其中prev log number已被弃用，不需要再关注）。如果上述操作都成功完成，则可以释放对Immutable MemTable的引用，并通过`RemoveObsoleteFiles`方法回收不再需要保留的文件（该方法放在后续的章节中介绍）。

接下来我们分析其中转储Immutable MemTable的方法：

```cpp

Status DBImpl::WriteLevel0Table(MemTable* mem, VersionEdit* edit,
                                Version* base) {
  mutex_.AssertHeld();
  const uint64_t start_micros = env_->NowMicros();
  FileMetaData meta;
  meta.number = versions_->NewFileNumber();
  pending_outputs_.insert(meta.number);
  Iterator* iter = mem->NewIterator();
  Log(options_.info_log, "Level-0 table #%llu: started",
      (unsigned long long)meta.number);

  Status s;
  {
    mutex_.Unlock();
    s = BuildTable(dbname_, env_, options_, table_cache_, iter, &meta);
    mutex_.Lock();
  }

  Log(options_.info_log, "Level-0 table #%llu: %lld bytes %s",
      (unsigned long long)meta.number, (unsigned long long)meta.file_size,
      s.ToString().c_str());
  delete iter;
  pending_outputs_.erase(meta.number);

  // Note that if file_size is zero, the file has been deleted and
  // should not be added to the manifest.
  int level = 0;
  if (s.ok() && meta.file_size > 0) {
    const Slice min_user_key = meta.smallest.user_key();
    const Slice max_user_key = meta.largest.user_key();
    if (base != nullptr) {
      level = base->PickLevelForMemTableOutput(min_user_key, max_user_key);
    }
    edit->AddFile(level, meta.number, meta.file_size, meta.smallest,
                  meta.largest);
  }

  CompactionStats stats;
  stats.micros = env_->NowMicros() - start_micros;
  stats.bytes_written = meta.file_size;
  stats_[level].Add(stats);
  return s;
}

```

`WriteLevel0Table`方法虽然较长但其逻辑非常简单，其获取了需要转储的MemTable的迭代器，并传给`BuildTable`方法。`BuildTable`方法会通过`TableBuilder`来构造SSTable文件然后写入，这里不再赘述。这里值得我们注意的是，`WriteLevel0Table`方法在处理完构造SSTable时需要的数据（及引用计数）后，在真正通过`BuildTable`方法转储SSTable时释放了全局的锁。因为Minor Compaction是由后台线程完成的，这样做可以在保证线程安全的前提下，避免后台线程执行耗时的Minor Compaction操作时阻塞LevelDB正常的读写。
### 4.3 Major Compaction

Major Compaction主要通过`DBImpl::DoCompactionWork`方法实现，其流程较为复杂，这里仍采用分段介绍的方式分析。

```cpp

Status DBImpl::DoCompactionWork(CompactionState* compact) {
  // (1)
  const uint64_t start_micros = env_->NowMicros();
  int64_t imm_micros = 0;  // Micros spent doing imm_ compactions

  Log(options_.info_log, "Compacting %d@%d + %d@%d files",
      compact->compaction->num_input_files(0), compact->compaction->level(),
      compact->compaction->num_input_files(1),
      compact->compaction->level() + 1);

  assert(versions_->NumLevelFiles(compact->compaction->level()) > 0);
  assert(compact->builder == nullptr);
  assert(compact->outfile == nullptr);

  // ... ...

}

```

首先`DoCompactionWork`通过断言避免编码错误，同时做好日志，这里不再赘述。

```cpp

  // (2)
  if (snapshots_.empty()) {
    compact->smallest_snapshot = versions_->LastSequence();
  } else {
    compact->smallest_snapshot = snapshots_.oldest()->sequence_number();
  }

  Iterator* input = versions_->MakeInputIterator(compact->compaction);

  // Release mutex while we're actually doing the compaction work
  mutex_.Unlock();

  // (...)
  // ... ...

  mutex_.Lock();
  stats_[compact->compaction->level() + 1].Add(stats);

  if (status.ok()) {
    status = InstallCompactionResults(compact);
  }
  if (!status.ok()) {
    RecordBackgroundError(status);
  }
  VersionSet::LevelSummaryStorage tmp;
  Log(options_.info_log, "compacted to: %s", versions_->LevelSummary(&tmp));
  return status;

```

接着我们来看第(2)段代码，这段代码看上去很长，但做的工作较为简单。`DoCompactionWork`方法在遍历和生成SSTable是解锁的，我们将其放在后面分析，第(2)代码主要关注解锁前和上锁后的部分。

在解锁前，该方法准备了需要避免竟态的数据：需要保留的最大SequenceNumber（以实现Snapshot Read），并通过`MakeInputIterator`方法生成了所有参与Major Compaction的SSTable的全局迭代器Input Iterator（详见[深入浅出LevelDB —— 0x08 Iterator](/posts/code-reading/leveldb-made-simple/8-iterator/)）。

在完成Compaction并上锁后，该方法更新了统计量和状态，输出日志后返回。

下面我们介绍的部分，几乎都是在解锁的情况下执行的，其不会阻塞LevelDB正常的读写操作。

```cpp

  // (3)
  input->SeekToFirst();
  Status status;
  ParsedInternalKey ikey;
  std::string current_user_key;
  bool has_current_user_key = false;
  SequenceNumber last_sequence_for_key = kMaxSequenceNumber;
  while (input->Valid() && !shutting_down_.load(std::memory_order_acquire)) {

    // (...)
    // ... ...

    input->Next();
  }

  if (status.ok() && shutting_down_.load(std::memory_order_acquire)) {
    status = Status::IOError("Deleting DB during compaction");
  }
  if (status.ok() && compact->builder != nullptr) {
    status = FinishCompactionOutputFile(compact, input);
  }
  if (status.ok()) {
    status = input->status();
  }
  delete input;
  input = nullptr;

  CompactionStats stats;
  stats.micros = env_->NowMicros() - start_micros - imm_micros;
  for (int which = 0; which < 2; which++) {
    for (int i = 0; i < compact->compaction->num_input_files(which); i++) {
      stats.bytes_read += compact->compaction->input(which, i)->file_size;
    }
  }
  for (size_t i = 0; i < compact->outputs.size(); i++) {
    stats.bytes_written += compact->outputs[i].file_size;
  }

```

第(3)段代码主要通过InputIterator顺序遍历参与Major Compaction的key/value，对每个key/value的处理会在下文介绍。在处理完所有key后，根据状态判断是否需要返回错误，同时通过`FinishCompactionOutputFile`方法关闭最后一个写入的SSTable。

因为LevelDB限制了每个SSTable的大小，因此在Major Compaction期间，如果当前写入的SSTable过大，会将其拆分成多个SSTable写入，所以这里关闭的是最后一个SSTable。该方法主要通过SSTable的Builder的`Finish`方法完成对SSTable的写入，这里不再赘述，感兴趣的读者可以自行阅读。

最后，这段代码更新了相关统计量。

接下来我们来看LevelDB对每个key/value的处理：


```cpp

    // (4)
    // Prioritize immutable compaction work
    if (has_imm_.load(std::memory_order_relaxed)) {
      const uint64_t imm_start = env_->NowMicros();
      mutex_.Lock();
      if (imm_ != nullptr) {
        CompactMemTable();
        // Wake up MakeRoomForWrite() if necessary.
        background_work_finished_signal_.SignalAll();
      }
      mutex_.Unlock();
      imm_micros += (env_->NowMicros() - imm_start);
    }

    // (5)
    Slice key = input->key();
    if (compact->compaction->ShouldStopBefore(key) &&
        compact->builder != nullptr) {
      status = FinishCompactionOutputFile(compact, input);
      if (!status.ok()) {
        break;
      }
    }

    // (6)
    // Handle key/value, add to state, etc.
    bool drop = false;
    // ... ...

    // (7)
    if (!drop) {
      // Open output file if necessary
      if (compact->builder == nullptr) {
        status = OpenCompactionOutputFile(compact);
        if (!status.ok()) {
          break;
        }
      }
      if (compact->builder->NumEntries() == 0) {
        compact->current_output()->smallest.DecodeFrom(key);
      }
      compact->current_output()->largest.DecodeFrom(key);
      compact->builder->Add(key, input->value());

      // Close output file if it is big enough
      if (compact->builder->FileSize() >=
          compact->compaction->MaxOutputFileSize()) {
        status = FinishCompactionOutputFile(compact, input);
        if (!status.ok()) {
          break;
        }
      }
    }

```

我们首先来看(4)、(5)、(7)。

段(4)判断当前是否有需要Minor Compaction的Immutable MemTable，如果有则让出任务，先进行Minor Compaction（该过程需要加锁）。

段(5)通过`ShouldStopBefore`方法估算当前SSTable大小，并判断其是否超过了`max_file_size`的限制，如果超过了则通过`FinishCompactionOutputFile`完整对当前SSTable的写入。

段(6)会判断当前key/value是否保留，如果保留则将`drop`置为true。其判断规则在下文介绍。

段(7)用来将需要保留的key/value加入到当前SSTable中。因为在段(5)中当前写入的SSTable可能已因文件过大而被关闭，所以这里需要在SSTable被关闭时通过`OpenCompactionOutputFIle`打开一个新的SSTable并为其分配新的编号。

最后我们来看段(6)中判断key/value是否需要保留的实现：


```cpp

    if (!ParseInternalKey(key, &ikey)) {
      // Do not hide error keys
      current_user_key.clear();
      has_current_user_key = false;
      last_sequence_for_key = kMaxSequenceNumber;
    } else {
      if (!has_current_user_key ||
          user_comparator()->Compare(ikey.user_key, Slice(current_user_key)) !=
              0) {
        // First occurrence of this user key
        current_user_key.assign(ikey.user_key.data(), ikey.user_key.size());
        has_current_user_key = true;
        last_sequence_for_key = kMaxSequenceNumber;
      }

      if (last_sequence_for_key <= compact->smallest_snapshot) {
        // Hidden by an newer entry for same user key
        drop = true;  // (A)
      } else if (ikey.type == kTypeDeletion &&
                 ikey.sequence <= compact->smallest_snapshot &&
                 compact->compaction->IsBaseLevelForKey(ikey.user_key)) {
        // For this user key:
        // (1) there is no data in higher levels
        // (2) data in lower levels will have larger sequence numbers
        // (3) data in layers that are being compacted here and have
        //     smaller sequence numbers will be dropped in the next
        //     few iterations of this loop (by rule (A) above).
        // Therefore this deletion marker is obsolete and can be dropped.
        drop = true;
      }

      last_sequence_for_key = ikey.sequence;
    }

```

段(6)中记录了当前key的UserKey的两个重要状态：
- `has_current_user_key`：当前key的UserKey之前是否出现过。
- `last_sequence_for_key`：当前key的UserKey的上一次出现时的SequenceNumber，如果该UserKey之前未出现过，则将其置为最大的SequenceNumber（`kMaxSequenceNumber`），以避免当前key的最新状态在小于需要保留的snapshot number时被丢弃。


段(6)执行了如下流程：
1. 解析当前key/value，如果解析失败则跳过当前key/value。
2. 如果当前key/value解析成功，判断其UserKey是否未出现过，如果是则更新`has_current_user_key`和`last_sequence_for_key`的状态。
3. 判断当前是否丢弃当前key/value：
    1. 如果当前key的UserKey不是第一次出现，且其SequenceNumber小于保留的最小snapshot number，则丢弃该key/value。
    2. 如果该key的InternalKey类型为`kTypeDeletion`、且其SequenceNumber小于需要保留的最小snapshot number，同时更高的level中不存在该key时，可以丢弃该key/value。



### 4.4 Compaction清理




`CleanupCompaction` -> 内存
`RemoveObsoleteFiles` -> 文件


btw. Tier Compaction ( Tiering vs. Leveling )