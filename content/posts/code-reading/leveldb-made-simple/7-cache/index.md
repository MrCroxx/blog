---
title: "深入浅出LevelDB —— 07 Cache"
date: 2021-03-10T11:17:19+08:00
lastmod: 2021-03-10T19:28:42+08:00
draft: false
keywords: []
description: ""
tags: ["LevelDB", "LSM-Tree"]
categories: ["深入浅出LevelDB"]
author: ""
featuredImage: img/leveldb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

## 0. 引言

为了减少热点数据访问时磁盘I/O频繁导致的效率问题，LevelDB在访问SSTable时加入了缓存。LevelDB中使用的缓存从功能上可分为两种：

- BlockCache：缓存最近使用的SSTable中DataBlock数据。
- TableCache：TableCache可以认为是一个双层Cache。其第一层Cache缓存最近打开的SSTable中的部分元数据（如索引等）；而第二层Cache即为BlockCache，缓存了当前SSTable中的DataBlock数据。TableCache提供的Get接口会同时查询两层缓存。

无论是BlockCache还是TableCache，其内部的核心实现都是分片的LRU缓存（Least-Recently-Used）。该LRU缓存实现了`include/leveldb/cache.h`定义的缓存接口。

本文主要介绍并分析LevelDB中Cache的设计与实现，并简单介绍了BlockCache与TableCache。

## 1. Cache接口

LevelDB的`include/leveldb/cache.h`定义了其内部使用的缓存接口，在介绍LevelDB中LRU缓存的实现前，我们首先关注该文件中定义的缓存接口：

```cpp

// Copyright (c) 2011 The LevelDB Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file. See the AUTHORS file for names of contributors.
//
// A Cache is an interface that maps keys to values.  It has internal
// synchronization and may be safely accessed concurrently from
// multiple threads.  It may automatically evict entries to make room
// for new entries.  Values have a specified charge against the cache
// capacity.  For example, a cache where the values are variable
// length strings, may use the length of the string as the charge for
// the string.
//
// A builtin cache implementation with a least-recently-used eviction
// policy is provided.  Clients may use their own implementations if
// they want something more sophisticated (like scan-resistance, a
// custom eviction policy, variable cache sizing, etc.)

#ifndef STORAGE_LEVELDB_INCLUDE_CACHE_H_
#define STORAGE_LEVELDB_INCLUDE_CACHE_H_

#include <cstdint>

#include "leveldb/export.h"
#include "leveldb/slice.h"

namespace leveldb {

class LEVELDB_EXPORT Cache;

// Create a new cache with a fixed size capacity.  This implementation
// of Cache uses a least-recently-used eviction policy.
LEVELDB_EXPORT Cache* NewLRUCache(size_t capacity);

class LEVELDB_EXPORT Cache {
 public:
  Cache() = default;

  Cache(const Cache&) = delete;
  Cache& operator=(const Cache&) = delete;

  // Destroys all existing entries by calling the "deleter"
  // function that was passed to the constructor.
  virtual ~Cache();

  // Opaque handle to an entry stored in the cache.
  struct Handle {};

  // Insert a mapping from key->value into the cache and assign it
  // the specified charge against the total cache capacity.
  //
  // Returns a handle that corresponds to the mapping.  The caller
  // must call this->Release(handle) when the returned mapping is no
  // longer needed.
  //
  // When the inserted entry is no longer needed, the key and
  // value will be passed to "deleter".
  virtual Handle* Insert(const Slice& key, void* value, size_t charge,
                         void (*deleter)(const Slice& key, void* value)) = 0;

  // If the cache has no mapping for "key", returns nullptr.
  //
  // Else return a handle that corresponds to the mapping.  The caller
  // must call this->Release(handle) when the returned mapping is no
  // longer needed.
  virtual Handle* Lookup(const Slice& key) = 0;

  // Release a mapping returned by a previous Lookup().
  // REQUIRES: handle must not have been released yet.
  // REQUIRES: handle must have been returned by a method on *this.
  virtual void Release(Handle* handle) = 0;

  // Return the value encapsulated in a handle returned by a
  // successful Lookup().
  // REQUIRES: handle must not have been released yet.
  // REQUIRES: handle must have been returned by a method on *this.
  virtual void* Value(Handle* handle) = 0;

  // If the cache contains entry for key, erase it.  Note that the
  // underlying entry will be kept around until all existing handles
  // to it have been released.
  virtual void Erase(const Slice& key) = 0;

  // Return a new numeric id.  May be used by multiple clients who are
  // sharing the same cache to partition the key space.  Typically the
  // client will allocate a new id at startup and prepend the id to
  // its cache keys.
  virtual uint64_t NewId() = 0;

  // Remove all cache entries that are not actively in use.  Memory-constrained
  // applications may wish to call this method to reduce memory usage.
  // Default implementation of Prune() does nothing.  Subclasses are strongly
  // encouraged to override the default implementation.  A future release of
  // leveldb may change Prune() to a pure abstract method.
  virtual void Prune() {}

  // Return an estimate of the combined charges of all elements stored in the
  // cache.
  virtual size_t TotalCharge() const = 0;

 private:
  void LRU_Remove(Handle* e);
  void LRU_Append(Handle* e);
  void Unref(Handle* e);

  struct Rep;
  Rep* rep_;
};

}  // namespace leveldb

#endif  // STORAGE_LEVELDB_INCLUDE_CACHE_H_

```

该文件的注释中，详细地说明了该`Cache`接口的设计与实现该`Cache`接口的一些需求。该接口定义了一个key/value的缓存结构，该接口要求在内部实现同步，以让使用者可以线程安全地使用该结构。`Cache`要求其实现能够自动逐出旧缓存项以为新缓存项腾出空间。使用者可以自定义`Cache`的容量，并需要在插入缓存项时提供该缓存项占用的容量，以便其计算剩余容量。

接下来我们来详细分析`Cache`接口声明。

首先关注`Cache`的构造与析构：

```cpp

  Cache() = default;

  Cache(const Cache&) = delete;
  Cache& operator=(const Cache&) = delete;

  // Destroys all existing entries by calling the "deleter"
  // function that was passed to the constructor.
  virtual ~Cache();

```

`Cache`要求析构时通过回调函数`deleter`来销毁其缓存的内容。该是插入缓存项时指定的，我们先继续分析。

```cpp

  // Opaque handle to an entry stored in the cache.
  struct Handle {};

```

Cache中声明一个结构体`Handle`。从Cache用户的视角来看，该Handle用来指向Cache中的一个缓存项，即Handle是用户访问Cache中缓存项的一个凭证。而在Cache内部，Handle其实与缓存项的生命周期有一定关系，我们先来看与Handle相关的几个方法，再来介绍这一关系：

```cpp

  // Insert a mapping from key->value into the cache and assign it
  // the specified charge against the total cache capacity.
  //
  // Returns a handle that corresponds to the mapping.  The caller
  // must call this->Release(handle) when the returned mapping is no
  // longer needed.
  //
  // When the inserted entry is no longer needed, the key and
  // value will be passed to "deleter".
  virtual Handle* Insert(const Slice& key, void* value, size_t charge,
                         void (*deleter)(const Slice& key, void* value)) = 0;

  // If the cache has no mapping for "key", returns nullptr.
  //
  // Else return a handle that corresponds to the mapping.  The caller
  // must call this->Release(handle) when the returned mapping is no
  // longer needed.
  virtual Handle* Lookup(const Slice& key) = 0;

  // Release a mapping returned by a previous Lookup().
  // REQUIRES: handle must not have been released yet.
  // REQUIRES: handle must have been returned by a method on *this.
  virtual void Release(Handle* handle) = 0;

```

`Insert`方法是Cache用户将key/value插入为Cache缓存项的方法，其参数`key`是Slice引用类型，`value`是任意类型指针，`size_t`用来告知Cache该缓存项占用容量。显然，Cache不需要知道value具体占用多大空间，也无从得知其类型，这说明Cache的用户需要自己控制value的空间释放。`Insert`方法的最后一个参数回调函数`*deleter`即用来释放value空间的方法（LevelDB内部实现的Cache会深拷贝`key`的数据，不需要用户释放）。

为了避免释放仍在使用的缓存项，同时提供线程安全地访问，缓存项的释放需要依赖引用计数。当用户更新了key相同的缓存或删除key相应的缓存时，Cache只会将其移出其管理结构，不会释放其内存空间。只有当其引用计数归零时才会通过之前传入的回调函数`deleter`释放。用户对缓存项引用计数的操作即通过`Handle`来实现。用户在通过`Insert`或`LookUp`方法得到缓存项的Handle时，缓存项的引用计数会+1。两个方法声明的注释部分指出，用户在不需要继续使用该缓存项时，需要调用`Release`方法并传入该缓存项的Handle。`Release`方法会使缓存项的引用计数-1。

`Cache`中还提供了如“删除缓存项”、“自然数生成”、“清空缓存”、“估算使用容量”等方法，这里不做关注的重点。

## 2. Cache的实现

### 2.1 LevelDB中LRU缓存设计

LevelDB中内建了一个`Cache`接口的实现，其位于`util/cache.cc`中。接下来，笔者将介绍LevelDB中`Cache`实现的设计与源码实现。

通过该文件开头的注释，我们能够对其实现有一个初步的认识：

```cpp

// LRU cache implementation
//
// Cache entries have an "in_cache" boolean indicating whether the cache has a
// reference on the entry.  The only ways that this can become false without the
// entry being passed to its "deleter" are via Erase(), via Insert() when
// an element with a duplicate key is inserted, or on destruction of the cache.
//
// The cache keeps two linked lists of items in the cache.  All items in the
// cache are in one list or the other, and never both.  Items still referenced
// by clients but erased from the cache are in neither list.  The lists are:
// - in-use:  contains the items currently referenced by clients, in no
//   particular order.  (This list is used for invariant checking.  If we
//   removed the check, elements that would otherwise be on this list could be
//   left as disconnected singleton lists.)
// - LRU:  contains the items not currently referenced by clients, in LRU order
// Elements are moved between these lists by the Ref() and Unref() methods,
// when they detect an element in the cache acquiring or losing its only
// external reference.

```

LevelDB的Cache实现中有两个用来保存缓存项`LRUHandle`的链表：*in-use*链表和*LRU*链表。*in-use*链表上无序保存着在LRUCache中且正在被client使用的LRUHandle（该链表仅用来保持LRUHandle引用计数）；*LRU*链表上按照最近使用的顺序保存着当前在LRUCache中但目前没有被用户使用的LRUHandle。LRUHandle在两个链表间的切换由`Ref`和`UnRef`实现。

另外，在LRUCache的实现中，在`Insert`方法插入LRUHandle时，只会从*LRU*链表中逐出LRUHandle，相当于*in-use*链表中的LRUHandle会被LRUCache “Pin”住，永远都不会逐出。也就是说，对于LRUCache中的每个LRUHandle，其只有如下几种状态：

- 对于还没存入LRUCache的LRUHandle，不在任一链表上（显然）。
- 当前在LRUCache中，且正在被client使用的LRUHandle，在*in-use*链表上无序保存。
- 当前在LRUCache中，当前未被client使用的LRUHandle，在*LRU*链表上按LRU顺序保存。
- 之前在LRUCache中，但①被用户通过`Erase`方法从LRUCache中删除，或②用户通过`Insert`方法更新了该key的LRUHandle，或③LRUCache被销毁时，LRUHandle既不在*in-use*链表上也不在*LRU*链表上。此时，该LRUHandle在等待client通过`Release`方法释放引用计数以销毁。

LRUCache为了能够快速根据key来找到相应的LRUHandle，而不需要遍历链表，其还组装了一个哈希表`HandleTable`。LevelDB的哈希表与哈希函数都使用了自己的实现。

LRUCache其实已经实现了完整的LRU缓存的功能。但是LevelDB又将其封装为`ShardedLRUCache`，并让`ShardedLRUCache`实现了`Cache`接口，供用户使用。ShardedLRUCache中保存了若干个`LRUCache`，并根据插入的key的哈希将其分配到相应的LRUCache中。因为每个LRUCache有独立的锁，这种方式可以减少锁的争用，以优化并行程序的性能。

接下来，我们自底向上地介绍并分析LevelDB中LRUHandle、HandleTable、LRUCache、ShardedLRUCache的实现。

### 2.2 LRUHandle

LRUHandle是表示缓存项的结构体，其源码如下：

```cpp

// An entry is a variable length heap-allocated structure.  Entries
// are kept in a circular doubly linked list ordered by access time.
struct LRUHandle {
  void* value;
  void (*deleter)(const Slice&, void* value);
  LRUHandle* next_hash;
  LRUHandle* next;
  LRUHandle* prev;
  size_t charge;  // TODO(opt): Only allow uint32_t?
  size_t key_length;
  bool in_cache;     // Whether entry is in the cache.
  uint32_t refs;     // References, including cache reference, if present.
  uint32_t hash;     // Hash of key(); used for fast sharding and comparisons
  char key_data[1];  // Beginning of key

  Slice key() const {
    // next_ is only equal to this if the LRU handle is the list head of an
    // empty list. List heads never have meaningful keys.
    assert(next != this);

    return Slice(key_data, key_length);
  }
};

```

`LRUHandle`中有记录key（深拷贝）、value（浅拷贝）及相关哈希值、引用计数、占用空间、是否仍在LRUCache中等字段，这里不再赘述。我们主要关注LRUHandle中的三个`LRUHandle*`类型的指针。其中`next`指针与`prev`指针，用来实现`LRUCache`中的两个链表，而`next_hash`是哈希表`HandleTable`为了解决哈希冲突采用拉链法的链指针。

### 2.3 HandleTable

接下来我们来分析`HandleTable`的实现。`HandleTable`实现了一个可扩展哈希表。`HandleTable`中只有3个字段：

```cpp

 private:
  // The table consists of an array of buckets where each bucket is
  // a linked list of cache entries that hash into the bucket.
  uint32_t length_;
  uint32_t elems_;
  LRUHandle** list_;

```

`length_`字段记录了`HandleTable`中solt的数量，`elems_`字段记录了当前`HandleTable`中已用solt的数量，`list_`字段是`HandleTable`的bucket数组。

接下来我们简单分析一下`HandleTable`对可扩展哈希表的实现。

```cpp

  // Return a pointer to slot that points to a cache entry that
  // matches key/hash.  If there is no such cache entry, return a
  // pointer to the trailing slot in the corresponding linked list.
  LRUHandle** FindPointer(const Slice& key, uint32_t hash) {
    LRUHandle** ptr = &list_[hash & (length_ - 1)];
    while (*ptr != nullptr && ((*ptr)->hash != hash || key != (*ptr)->key())) {
      ptr = &(*ptr)->next_hash;
    }
    return ptr;
  }

```

`FindPointer`方法是根据key与其hash查找LRUHandle的方法。如果key存在则返回其LRUHandle的指针，如果不存在则返回指向可插入的solt的指针。

```cpp

  void Resize() {
    uint32_t new_length = 4;
    while (new_length < elems_) {
      new_length *= 2;
    }
    LRUHandle** new_list = new LRUHandle*[new_length];
    memset(new_list, 0, sizeof(new_list[0]) * new_length);
    uint32_t count = 0;
    for (uint32_t i = 0; i < length_; i++) {
      LRUHandle* h = list_[i];
      while (h != nullptr) {
        LRUHandle* next = h->next_hash;
        uint32_t hash = h->hash;
        LRUHandle** ptr = &new_list[hash & (new_length - 1)];
        h->next_hash = *ptr;
        *ptr = h;
        h = next;
        count++;
      }
    }
    assert(elems_ == count);
    delete[] list_;
    list_ = new_list;
    length_ = new_length;
  }

```

`Resize`方法是扩展哈希表的方法。该方法会倍增solt大小，并重新分配空间。在重新分配solt的空间后，再对所有原有solt中的LRUHandle重哈希。最后释放旧的solt的空间。

```cpp

  LRUHandle* Lookup(const Slice& key, uint32_t hash) {
    return *FindPointer(key, hash);
  }

  LRUHandle* Insert(LRUHandle* h) {
    LRUHandle** ptr = FindPointer(h->key(), h->hash);
    LRUHandle* old = *ptr;
    h->next_hash = (old == nullptr ? nullptr : old->next_hash);
    *ptr = h;
    if (old == nullptr) {
      ++elems_;
      if (elems_ > length_) {
        // Since each cache entry is fairly large, we aim for a small
        // average linked list length (<= 1).
        Resize();
      }
    }
    return old;
  }

  LRUHandle* Remove(const Slice& key, uint32_t hash) {
    LRUHandle** ptr = FindPointer(key, hash);
    LRUHandle* result = *ptr;
    if (result != nullptr) {
      *ptr = result->next_hash;
      --elems_;
    }
    return result;
  }

```

`HandleTable`公开的`LookUp`、`Insert`、`Remove`是对`FindPointer`与`Resize`的封装，这里不再赘述。

### 2.4 LRUCache

```cpp

class LRUCache {

// ... ...

 private:

  // ... ...

  // Initialized before use.
  size_t capacity_;

  // mutex_ protects the following state.
  mutable port::Mutex mutex_;
  size_t usage_ GUARDED_BY(mutex_);

  // Dummy head of LRU list.
  // lru.prev is newest entry, lru.next is oldest entry.
  // Entries have refs==1 and in_cache==true.
  LRUHandle lru_ GUARDED_BY(mutex_);

  // Dummy head of in-use list.
  // Entries are in use by clients, and have refs >= 2 and in_cache==true.
  LRUHandle in_use_ GUARDED_BY(mutex_);

  HandleTable table_ GUARDED_BY(mutex_);
};

```

`LRUCache`中，除了容量`capacity_`外，其它字段都通过互斥锁`mutex_`来保护并发操作，这些字段包括：LRUCache的当前用量、*LRU*链表`lru_`、*in-use*链表`in_use_`、和哈希表`table_`。

```cpp

void LRUCache::Ref(LRUHandle* e) {
  if (e->refs == 1 && e->in_cache) {  // If on lru_ list, move to in_use_ list.
    LRU_Remove(e);
    LRU_Append(&in_use_, e);
  }
  e->refs++;
}

void LRUCache::Unref(LRUHandle* e) {
  assert(e->refs > 0);
  e->refs--;
  if (e->refs == 0) {  // Deallocate.
    assert(!e->in_cache);
    (*e->deleter)(e->key(), e->value);
    free(e);
  } else if (e->in_cache && e->refs == 1) {
    // No longer in use; move to lru_ list.
    LRU_Remove(e);
    LRU_Append(&lru_, e);
  }
}

void LRUCache::LRU_Remove(LRUHandle* e) {
  e->next->prev = e->prev;
  e->prev->next = e->next;
}

void LRUCache::LRU_Append(LRUHandle* list, LRUHandle* e) {
  // Make "e" newest entry by inserting just before *list
  e->next = list;
  e->prev = list->prev;
  e->prev->next = e;
  e->next->prev = e;
}

```

除了`LRU_Remove`与`LRU_Append`方法用来操作链表外，`LRUCache`还提供了`Ref`与`Unref`方法，在操作链表的同时处理LRUHandle的引用计数。`Ref`方法将LRUHandle的引用计数加一，并将其从`lru_`链表中转移到`in_use_`链表中；`Unref`方法将引用计数减一，当LRUHandle的引用计数减为1时，将其从`in_use_`链表中归还给`lru_`链表（其最后一个引用为链表指针的引用），当LRUHandle的引用计数减为0时，通过其`deleter`销毁该对象。

`LRUCache`中其它的方法实现比较简单，这里不再赘述。

### 2.5 ShardedLRUCache

`SharedLRUCache`是最终实现`Cache`接口的方法。正如前文所介绍的，ShardedLRUCache中保存了若干个`LRUCache`，并根据插入的key的哈希将其分配到相应的LRUCache中。因为每个LRUCache有独立的锁，这种方式可以减少锁的争用，以优化并行程序的性能。

```cpp

class ShardedLRUCache : public Cache {
 private:
  LRUCache shard_[kNumShards];
  port::Mutex id_mutex_;
  uint64_t last_id_;

  static inline uint32_t HashSlice(const Slice& s) {
    return Hash(s.data(), s.size(), 0);
  }

  static uint32_t Shard(uint32_t hash) { return hash >> (32 - kNumShardBits); }

  // ... ...

}

```

`ShardedLRUCache`通过`HashSlice`方法对key进行一次哈希，并通过`Shard`方法为其分配shard。`ShardedLRUCache`中其它方法都是对shard的操作与对`LRUCache`的封装，这里也不再赘述。

## 3. BlockCache与TableCache

### 3.1 BlockCache与TableCache概览

LevelDB在实现BlockCache与TableCache时，都用到了ShardedLRUCache。BlockCache直接使用了ShardedLRUCache，TableCache则对ShardedLRUCache又进行了一次封装。二者的主要区别在于key/value的类型及cache的大小：

- BlockCache：用户可通过Options.block_cache配置来自定义BlockCache的实现，其默认实现为8MB的ShardedLRUCache。其key/value为(table.cache_id,block.offset)->(Block*)。
- TableCache：用户可通过OptionTable.max_open_file配置来自定义TableCache的大小，其默认可以保存1000个Table的信息。其key/value为(SSTable.file_number)->(TableAndFile*)。

因为TableCache在ShardedLRUCache上又进行了一次封装，而读取TableCache时，所以本章主要关注TableCache及其实现。

### 3.2 TableCache

`TableCache`中key/value为(SSTable.file_number)->(TableAndFile*)，该类如下（位于`db/table_cache.h`）：

```cpp

class TableCache {
 public:
  TableCache(const std::string& dbname, const Options& options, int entries);
  ~TableCache();

  // Return an iterator for the specified file number (the corresponding
  // file length must be exactly "file_size" bytes).  If "tableptr" is
  // non-null, also sets "*tableptr" to point to the Table object
  // underlying the returned iterator, or to nullptr if no Table object
  // underlies the returned iterator.  The returned "*tableptr" object is owned
  // by the cache and should not be deleted, and is valid for as long as the
  // returned iterator is live.
  Iterator* NewIterator(const ReadOptions& options, uint64_t file_number,
                        uint64_t file_size, Table** tableptr = nullptr);

  // If a seek to internal key "k" in specified file finds an entry,
  // call (*handle_result)(arg, found_key, found_value).
  Status Get(const ReadOptions& options, uint64_t file_number,
             uint64_t file_size, const Slice& k, void* arg,
             void (*handle_result)(void*, const Slice&, const Slice&));

  // Evict any entry for the specified file number
  void Evict(uint64_t file_number);

 private:
  Status FindTable(uint64_t file_number, uint64_t file_size, Cache::Handle**);

  Env* const env_;
  const std::string dbname_;
  const Options& options_;
  Cache* cache_;
};

}  // namespace leveldb

```

从`TableCache`的声明中可以发现，其除了构造与析构方法和生成迭代器的方法外，只对外提供了`Get`方法和`Evict`方法。caller通过使用SSTable的编号、待查找的key调用`Get`方法查找键值对时，`TableCache`会自动将该SSTable相应的`TableAndFile`放入缓存。

`TableAndFile`结构体正如其名字一样，只有两个字段`table`和`file`：

```cpp

struct TableAndFile {
  RandomAccessFile* file;
  Table* table;
};

```

其中`file`字段表示SSTable相应的`RandomAccessFile`结构，即SSTable在文件中的表示；而`Table`字段表示SSTable的`Table`结构，其为SSTable在内存中的数据与接口，笔者将在下一节中介绍其结构。通过`TableAndFile`，caller可以获取其需要的结构。

`TableCache`中我们主要关注两个方法的实现：`Get`与`FindTable`方法：

```cpp

Status TableCache::FindTable(uint64_t file_number, uint64_t file_size,
                             Cache::Handle** handle) {
  Status s;
  char buf[sizeof(file_number)];
  EncodeFixed64(buf, file_number);
  Slice key(buf, sizeof(buf));
  *handle = cache_->Lookup(key);
  if (*handle == nullptr) {
    std::string fname = TableFileName(dbname_, file_number);
    RandomAccessFile* file = nullptr;
    Table* table = nullptr;
    s = env_->NewRandomAccessFile(fname, &file);
    if (!s.ok()) {
      std::string old_fname = SSTTableFileName(dbname_, file_number);
      if (env_->NewRandomAccessFile(old_fname, &file).ok()) {
        s = Status::OK();
      }
    }
    if (s.ok()) {
      s = Table::Open(options_, file, file_size, &table);
    }

    if (!s.ok()) {
      assert(table == nullptr);
      delete file;
      // We do not cache error results so that if the error is transient,
      // or somebody repairs the file, we recover automatically.
    } else {
      TableAndFile* tf = new TableAndFile;
      tf->file = file;
      tf->table = table;
      *handle = cache_->Insert(key, tf, 1, &DeleteEntry);
    }
  }
  return s;
}

```

内部方法`FindTable`首先会构造key并在TableCache查找是否已经缓存该SSTable。如果有则直接返回缓存结构；否则根据传入的`file_number`和`file_size`参数，通过`Table::Open`方法打开相应的`SSTable`，并将`file`与`table`写入`TableAndFile`结构体，放入自己的ShardedLRUCache缓存中。其中`Table::Open`方法会加载SSTable中的index和filter，笔者会在下一节介绍其实现。

```cpp

Status TableCache::Get(const ReadOptions& options, uint64_t file_number,
                       uint64_t file_size, const Slice& k, void* arg,
                       void (*handle_result)(void*, const Slice&,
                                             const Slice&)) {
  Cache::Handle* handle = nullptr;
  Status s = FindTable(file_number, file_size, &handle);
  if (s.ok()) {
    Table* t = reinterpret_cast<TableAndFile*>(cache_->Value(handle))->table;
    s = t->InternalGet(options, k, arg, handle_result);
    cache_->Release(handle);
  }
  return s;
}

```

`Get`方法是`TableCache`暴露给caller的外部方法，该方法首先通过`FindTable`方法打开所需的SSTable，然后通过`Table`结构体的`InternalGet`结构获取给定key对应的value。`Table::InternalGet`方法中既使用了SSTable的index和filter，又使用了BlockCache，下节中笔者将详细介绍其实现。

从`TableCache`的代码可以发现，`Table`是实现TableCache的关键。下一节中，笔者将介绍并分析其实现。

### 3.3 Table

`Table`接口定义位于`include/leveldb/table.h`中，LevelDB的用户可以该接口中的`Open`方法打开SSTable并通过迭代器来访问其中数据，或者通过`ApproximateOffsetOf`方法估算key在SSTable中的位置；而`TableCache`作为其友元类，可以访问其私有方法。

```cpp

// A Table is a sorted map from strings to strings.  Tables are
// immutable and persistent.  A Table may be safely accessed from
// multiple threads without external synchronization.
class LEVELDB_EXPORT Table {
 public:
  // Attempt to open the table that is stored in bytes [0..file_size)
  // of "file", and read the metadata entries necessary to allow
  // retrieving data from the table.
  //
  // If successful, returns ok and sets "*table" to the newly opened
  // table.  The client should delete "*table" when no longer needed.
  // If there was an error while initializing the table, sets "*table"
  // to nullptr and returns a non-ok status.  Does not take ownership of
  // "*source", but the client must ensure that "source" remains live
  // for the duration of the returned table's lifetime.
  //
  // *file must remain live while this Table is in use.
  static Status Open(const Options& options, RandomAccessFile* file,
                     uint64_t file_size, Table** table);

  Table(const Table&) = delete;
  Table& operator=(const Table&) = delete;

  ~Table();

  // Returns a new iterator over the table contents.
  // The result of NewIterator() is initially invalid (caller must
  // call one of the Seek methods on the iterator before using it).
  Iterator* NewIterator(const ReadOptions&) const;

  // Given a key, return an approximate byte offset in the file where
  // the data for that key begins (or would begin if the key were
  // present in the file).  The returned value is in terms of file
  // bytes, and so includes effects like compression of the underlying data.
  // E.g., the approximate offset of the last key in the table will
  // be close to the file length.
  uint64_t ApproximateOffsetOf(const Slice& key) const;

 private:
  friend class TableCache;
  struct Rep;

  static Iterator* BlockReader(void*, const ReadOptions&, const Slice&);

  explicit Table(Rep* rep) : rep_(rep) {}

  // Calls (*handle_result)(arg, ...) with the entry found after a call
  // to Seek(key).  May not make such a call if filter policy says
  // that key is not present.
  Status InternalGet(const ReadOptions&, const Slice& key, void* arg,
                     void (*handle_result)(void* arg, const Slice& k,
                                           const Slice& v));

  void ReadMeta(const Footer& footer);
  void ReadFilter(const Slice& filter_handle_value);

  Rep* const rep_;
};

```

`Table`的所有数据都通过`Table::Rep`类型的字段`rep_`保存，其实现位于`table/table.cc`中：

```cpp

struct Table::Rep {
  ~Rep() {
    delete filter;
    delete[] filter_data;
    delete index_block;
  }

  Options options;
  Status status;
  RandomAccessFile* file;
  uint64_t cache_id;
  FilterBlockReader* filter;
  const char* filter_data;

  BlockHandle metaindex_handle;  // Handle to metaindex_block: saved from footer
  Block* index_block;
};


```

`Table`中封装了用来读取SSTable元数据的方法`ReadMeta`，该方法会根据SSTable的Footer找到Filter Block，并通过`ReadFilter`方法将filter加载到`Table::Rep`结构体`rep_`中。`Table`在读取Block时使用的是`table/format.h`中定义的方法`ReadBlock`。这些方法主要用来反序列化数据，有关SSTable的数据格式可以参考[深入浅出LevelDB —— 05 SSTable](/posts/code-reading/leveldb-made-simple/5-sstable/)，本文不再赘述。本节我们介绍关注`Table`的`Open`、`BlockReader`、`InternalGet`方法的功能。

```cpp

Status Table::Open(const Options& options, RandomAccessFile* file,
                   uint64_t size, Table** table) {
  *table = nullptr;
  if (size < Footer::kEncodedLength) {
    return Status::Corruption("file is too short to be an sstable");
  }

  char footer_space[Footer::kEncodedLength];
  Slice footer_input;
  Status s = file->Read(size - Footer::kEncodedLength, Footer::kEncodedLength,
                        &footer_input, footer_space);
  if (!s.ok()) return s;

  Footer footer;
  s = footer.DecodeFrom(&footer_input);
  if (!s.ok()) return s;

  // Read the index block
  BlockContents index_block_contents;
  ReadOptions opt;
  if (options.paranoid_checks) {
    opt.verify_checksums = true;
  }
  s = ReadBlock(file, opt, footer.index_handle(), &index_block_contents);

  if (s.ok()) {
    // We've successfully read the footer and the index block: we're
    // ready to serve requests.
    Block* index_block = new Block(index_block_contents);
    Rep* rep = new Table::Rep;
    rep->options = options;
    rep->file = file;
    rep->metaindex_handle = footer.metaindex_handle();
    rep->index_block = index_block;
    rep->cache_id = (options.block_cache ? options.block_cache->NewId() : 0);
    rep->filter_data = nullptr;
    rep->filter = nullptr;
    *table = new Table(rep);
    (*table)->ReadMeta(footer);
  }

  return s;
}

```

`Open`方法实现的功能主要是读取SSTable的Footer并加载其filter block与index block中的数据到内存。该方法还会并为Table分配一个`cache_id`，在通过Table读取其中DataBlock的数据时，会拼接`cache_id`与Block的`offset`拼接作为BlockCache的key。

```cpp

// Convert an index iterator value (i.e., an encoded BlockHandle)
// into an iterator over the contents of the corresponding block.
Iterator* Table::BlockReader(void* arg, const ReadOptions& options,
                             const Slice& index_value) {
  Table* table = reinterpret_cast<Table*>(arg);
  Cache* block_cache = table->rep_->options.block_cache;
  Block* block = nullptr;
  Cache::Handle* cache_handle = nullptr;

  BlockHandle handle;
  Slice input = index_value;
  Status s = handle.DecodeFrom(&input);
  // We intentionally allow extra stuff in index_value so that we
  // can add more features in the future.

  if (s.ok()) {
    BlockContents contents;
    if (block_cache != nullptr) {
      char cache_key_buffer[16];
      EncodeFixed64(cache_key_buffer, table->rep_->cache_id);
      EncodeFixed64(cache_key_buffer + 8, handle.offset());
      Slice key(cache_key_buffer, sizeof(cache_key_buffer));
      cache_handle = block_cache->Lookup(key);
      if (cache_handle != nullptr) {
        block = reinterpret_cast<Block*>(block_cache->Value(cache_handle));
      } else {
        s = ReadBlock(table->rep_->file, options, handle, &contents);
        if (s.ok()) {
          block = new Block(contents);
          if (contents.cachable && options.fill_cache) {
            cache_handle = block_cache->Insert(key, block, block->size(),
                                               &DeleteCachedBlock);
          }
        }
      }
    } else {
      s = ReadBlock(table->rep_->file, options, handle, &contents);
      if (s.ok()) {
        block = new Block(contents);
      }
    }
  }

  Iterator* iter;
  if (block != nullptr) {
    iter = block->NewIterator(table->rep_->options.comparator);
    if (cache_handle == nullptr) {
      iter->RegisterCleanup(&DeleteBlock, block, nullptr);
    } else {
      iter->RegisterCleanup(&ReleaseBlock, block_cache, cache_handle);
    }
  } else {
    iter = NewErrorIterator(s);
  }
  return iter;
}

```

`BlockReader`方法可以将在IndexBlock中查到的value值转为相应DataBlock的Iterator（index block中key/value为(index key -> DataBlockHandle)，详见[深入浅出LevelDB —— 05 SSTable](/posts/code-reading/leveldb-made-simple/5-sstable/)）。关于数据的解析这里不再赘述，我们主要关注的是该方法使用BlockCache的方式：
1. 如果options中没有传入`block_cache`，则直接通过`ReadBlock`方法读取DataBlock的内容并返回构造好的`Block`实例。
2. 如果options中传入了`block_cache`，则通过当前`Table`的`cache_id`字段与DataBlock的`offset`以Fixed64编码拼接为一个Slice作为BlockCache（默认为8M的ShardedLRUCache）的key。
3. 拼接好key后，首先通过BlockCache查找key是否在其中，如果key存在直接将其相应的DataBlock作为结果。
4. 如果key不存在，则通过`ReadBlock`方法读取DataBlock的内容。此时，如果options的`fill_cache`为true且Block的`cachable`也为true，则通过BlockCache缓存该DataBlock。


了解了`Open`加载的内容和`BlockReader`的功能后，我们把重点放在`InternalGet`方法上。`InternalGet`方法是在SSTable中通过key查找value的方法：

```cpp

Status Table::InternalGet(const ReadOptions& options, const Slice& k, void* arg,
                          void (*handle_result)(void*, const Slice&,
                                                const Slice&)) {
  Status s;
  Iterator* iiter = rep_->index_block->NewIterator(rep_->options.comparator);
  iiter->Seek(k);
  if (iiter->Valid()) {
    Slice handle_value = iiter->value();
    FilterBlockReader* filter = rep_->filter;
    BlockHandle handle;
    if (filter != nullptr && handle.DecodeFrom(&handle_value).ok() &&
        !filter->KeyMayMatch(handle.offset(), k)) {
      // Not found
    } else {
      Iterator* block_iter = BlockReader(this, options, iiter->value());
      block_iter->Seek(k);
      if (block_iter->Valid()) {
        (*handle_result)(arg, block_iter->key(), block_iter->value());
      }
      s = block_iter->status();
      delete block_iter;
    }
  }
  if (s.ok()) {
    s = iiter->status();
  }
  delete iiter;
  return s;
}

```

`InternalGet`方法实现的方式可分为如下步骤：
1. 获取IndexBlock上的Iterator，并通过该Iterator来seek需要查找的key所在的BlockHandle。
2. 如果找到了key所在的BlockHandle则继续按下面步骤查找，否则释放Iterator并返回。
3. 如果使用了filter，但filter没有在该DataBlock中找到相应的key/value，则跳至2；否则继续查找。
4. 通过`BlockReader`方法获取该DataBlock上的Iterator，并通过DataBlock的Iterator来seek需要查找的key。如果找到则调用查找成功的回调方法`handle_result`。最后更新执行状态并释放DataBlock上的Iterator。

## 4. 小结

本文介绍并分析了LevelDB中Cache接口及其实现。同时，本文还介绍了BlockCache和TableCache的功能及其实现方式。

准确来说，TableCache其实是两层Cache。第一层Cache缓存了（默认）1000个SSTable的index与filter，第二层通过BlockCache缓存了当前SSTable中（默认）8M的DataBlock。

因为TableCache可以在cache miss时自动查找SSTable文件并替换其中缓存项，所以LevelDB在查找SSTable中的数据时，只需要通过TableCache查找即可，不需要再额外查找SSTable。