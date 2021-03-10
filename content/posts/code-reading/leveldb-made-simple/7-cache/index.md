---
title: "深入浅出LevelDB —— 0x07 Cache [施工中]"
date: 2021-03-10T11:17:19+08:00
lastmod: 2021-03-10T11:17:22+08:00
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

为了减少热点数据访问时磁盘I/O频繁导致的效率问题，LevelDB在访问SSTable时加入了缓存。LevelDB中使用的缓存从功能上可分为两种：

- BlockCache（Options.boock_cache）：缓存最近使用的SSTable中DataBlock数据。
- TableCache（Options.max_open_files）：缓存最近打开的SSTable中的部分元数据（如索引等）。

无论是BlockCache还是TableCache，其内部的核心实现都是LRU缓存（Least-Recently-Used）。该LRU缓存实现了`include/leveldb/cache.h`定义的缓存接口。

本文主要介绍并分析LevelDB中Cache的设计与实现，并简单介绍BlockCache与TableCache对LRU缓存的封装。

## 1. LRU缓存设计与实现

### 1.1 Cache接口

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

`Cache`要求析构时通过`deleter`来销毁其缓存的内容。该是插入缓存项时指定的，我们先继续分析。

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

`Insert`方法是Cache用户将key/value插入为Cache缓存项的方法，其参数`key`是Slice引用类型，`value`是任意类型指针，`size_t`用来告知Cache该缓存项占用容量。显然，Cache不需要知道value具体占用多大空间，也无从得知其类型，这说明Cache的用户需要自己控制value的空间释放。`Insert`方法的最后一个参数`*deleter`即用来释放value空间的方法，当Cache逐出缓存项时，会调用该方法，用户通过该方法实现对value空间的回收（LevelDB内部实现的Cache会深拷贝`key`的数据，不需要用户释放）。

这里存在一个问题：用户在向容量已满的Cache插入新的缓存项时，Cache的要求自动逐出旧的缓存项，此时Cache会通过该缓存项的`deleter`释放该缓存项的空间。但如果此时该缓存项让在被使用，这会导致其内存被提前回收，后续对该缓存项的访问可能导致内存无效访问。

为了解决这一问题，Cache需要“Pin”住仍在使用中的缓存项，以避免逐出正在使用中的缓存。而通过`Handle`，用户可以告知Cache什么时候什么时候可以“UnPin”缓存项。在`Insert`和`LookUp`方法声明的注释中可以看到，用户在不需要继续使用该缓存项时，需要调用`Release`方法并传入该缓存项的Handle，这一过程即为通知Cache可以“UnPin”缓存项的过程。被“UnPin”的缓存项即可被Cache在必要时逐出。另外，因为同一个缓存项可能被多个线程同时适应，因此“Pin”与“UnPin”还要依赖引用计数，只有当所有的使用者都不再使用该缓存项时，才能“UnPin”该缓存项。

`Cache`中还提供了如“删除缓存项”、“自然数生成”、“清空缓存”、“估算使用容量”等方法，这里不做关注的重点。

接下来，我们自底向上地介绍并分析LevelDB中内建的对`Cache`接口的实现。

### 1.2 Cache实现 - LRUHandle、HandleTable














# 施工中 ... ...

### x.1 LRUHandle、HandleTable


`include/leveldb/cache.h`

`Cache` 内部保证同步，线程安全，k->v缓存接口 **详细分析**

内部实现：`util/cache.cc`  


`ShardedLRUCache`

