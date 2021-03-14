---
title: "深入浅出LevelDB —— 0x08 Iterator [施工中]"
date: 2021-03-11T11:17:19+08:00
lastmod: 2021-03-14T11:01:13+08:00
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

截至目前，本系列已经对LevelDB中的基本组件做了介绍。为了更方便的访问各种组件中的数据，LevelDB设计了各种迭代器Iterator。

本文将对LevelDB中迭代器Iterator的体系进行介绍，旨在梳理LevelDB中各种迭代器的功能与使用场景，对迭代器的实现介绍较少。迭代器的实现相对并不难，感兴趣的读者可以自行阅读源码。

## 1. Iterator接口

在介绍LevelDB的Iterator体系前，首先可以看一下LevelDB中对外提供的Iterator接口。该接口是用户访问LevelDB时可以使用的迭代器接口。虽然LevelDB内部的迭代器大多并没有实现这一接口，但是其提供的功能都类似：

```cpp

class LEVELDB_EXPORT Iterator {
 public:
  Iterator();

  Iterator(const Iterator&) = delete;
  Iterator& operator=(const Iterator&) = delete;

  virtual ~Iterator();

  // An iterator is either positioned at a key/value pair, or
  // not valid.  This method returns true iff the iterator is valid.
  virtual bool Valid() const = 0;

  // Position at the first key in the source.  The iterator is Valid()
  // after this call iff the source is not empty.
  virtual void SeekToFirst() = 0;

  // Position at the last key in the source.  The iterator is
  // Valid() after this call iff the source is not empty.
  virtual void SeekToLast() = 0;

  // Position at the first key in the source that is at or past target.
  // The iterator is Valid() after this call iff the source contains
  // an entry that comes at or past target.
  virtual void Seek(const Slice& target) = 0;

  // Moves to the next entry in the source.  After this call, Valid() is
  // true iff the iterator was not positioned at the last entry in the source.
  // REQUIRES: Valid()
  virtual void Next() = 0;

  // Moves to the previous entry in the source.  After this call, Valid() is
  // true iff the iterator was not positioned at the first entry in source.
  // REQUIRES: Valid()
  virtual void Prev() = 0;

  // Return the key for the current entry.  The underlying storage for
  // the returned slice is valid only until the next modification of
  // the iterator.
  // REQUIRES: Valid()
  virtual Slice key() const = 0;

  // Return the value for the current entry.  The underlying storage for
  // the returned slice is valid only until the next modification of
  // the iterator.
  // REQUIRES: Valid()
  virtual Slice value() const = 0;

  // If an error has occurred, return it.  Else return an ok status.
  virtual Status status() const = 0;

  // Clients are allowed to register function/arg1/arg2 triples that
  // will be invoked when this iterator is destroyed.
  //
  // Note that unlike all of the preceding methods, this method is
  // not abstract and therefore clients should not override it.
  using CleanupFunction = void (*)(void* arg1, void* arg2);
  void RegisterCleanup(CleanupFunction function, void* arg1, void* arg2);

  // ... ...

}

```

LevelDB中几乎所有的迭代器，都实现了`Valid`、`SeekToFirst`、`SeekToLast`、`Seek`、`Next`、`Prev`、`key`、`value`等功能。LevelDB对外提供的Iterator接口还支持注册若干个迭代器销毁时的回调函数，以便用户显式地控制一些资源的回收。

## 2. Iterator分类

![LevelDB Iterators](assets/iterator-system.svg "LevelDB Iterators")