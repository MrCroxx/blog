---
title: "深入浅出LevelDB —— 08 Iterator"
date: 2021-03-11T11:17:19+08:00
lastmod: 2021-03-15T15:17:49+08:00
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

## 2. Iterators

LevelDB中，既有直接在集合上的基本迭代器，也有对一个迭代器进行封装来解析更复杂数据的迭代器，还有多个迭代器组成的组合迭代器，关系较为复杂。下图给出了LevelDB中数据结构与相应的迭代器的总览。其中绿的方框为数据结构，与之相连的黄色的方框为该数据结构上的迭代器。迭代器括号中指出了其本质是什么迭代器（该图并非类图，也没有严格标注类型）：

![LevelDB Iterators](assets/iterator-system.svg "LevelDB Iterators")

因为旨在梳理LevelDB中各种迭代器的功能与使用场景，因此不会分析其具体实现。下面，笔者将按照基本迭代器到组合迭代器的顺序介绍。

### 2.1 基本集合的迭代器

本文提到的“基本迭代器”指直接在集合类上实现的迭代器，是用来顺序访问或随机查找集合类中数据的游标结构。LevelDB中每个重要的集合类上几乎都实现了相应的迭代器。下表给出了有关这些迭代器的信息：

| Collection<div style='width:8em'></div> | Target<div style='width:16em'></div> | Creator<div style='width:60em'></div> |
| :-: | :-: | :- |
| `SkipList` | SkipList中的Node | `SkipList`::`Iterator(const SkipList* list)` |
| `MemTable` | MemTable中的key/value | `MemTable`.`Iterator* NewIterator();` |
| `Block` | Block中的Entry（按restart拼接） | `Block`.`Iterator* NewIterator(const Comparator* comparator)` |
| `FileMetaData*` | 每层SSTable的编号（按key顺序） | `Version`::`LevelFileNumIterator(const InternalKeyComparator& icmp, const std::vector<FileMetaData*>* flist)` |

其中，`MemTable`的iterator是对`SkipList`的iterator的封装，因为`SkipList`的iterator只需要关注`Node`即可，而`MemTable`的iterator需要关注`Node`中保存的key/value。这种封装在LevelDB的iterator中还有，下文不再赘述。

### 2.2 复杂集合的迭代器

了解的基本集合的迭代器之后，我们来学习LevelDB中复杂集合的迭代器实现。

如果直接在复杂集合上实现迭代器，其逻辑会非常复杂且难以复用。为了处理这一问题，LevelDB的方案是：通过“组合迭代器”，来讲多个迭代器组合在一起，来实现复杂的迭代器。LevelDB设计了两个组合迭代器`TwoLevelIterator`与`MergingIterator`。

#### 2.2.1 TwoLevelIterator

`TwoLevelIterator`在LevelDB中常用于有索引结构的二级查询。这里简单看一下创建`TwoLevelIterator`的接口：

```cpp

// Return a new two level iterator.  A two-level iterator contains an
// index iterator whose values point to a sequence of blocks where
// each block is itself a sequence of key,value pairs.  The returned
// two-level iterator yields the concatenation of all key/value pairs
// in the sequence of blocks.  Takes ownership of "index_iter" and
// will delete it when no longer needed.
//
// Uses a supplied function to convert an index_iter value into
// an iterator over the contents of the corresponding block.
Iterator* NewTwoLevelIterator(
    Iterator* index_iter,
    Iterator* (*block_function)(void* arg, const ReadOptions& options,
                                const Slice& index_value),
    void* arg, const ReadOptions& options);

} 

```

从创建`TwoLevelIterator`的接口可以看出，`TwoLevelIterator`可以将index的iterator和data的iterator组合到一起。在seek时，`TwoLevelIterator`会先通过index iterator，seek到相应的index处，并将index的value作为`arg`传给data iterator（`block_funciton`），通过data iterator来访问真正的数据。

如果从key顺序的角度来看`TwoLevelIterator`，其需要index有序、每个index下的data有序、所有index下的所有data全局有序。即`TwoLevelIterator`实际上是一个建立在多级查找结构上的iterator。LevelDB中主要有两个符合该结构的组件：

其一是level>0的SSTable，其每层SSTable可以按照key排序，每个SSTable内也按照key排序，且每层SSTable中的key没有overlap且全局有序。因此LevelDB中Version的Concaterating Iterator实际上就是一个`TwoLevelIterator`，其第一级iterator是`LevelFileNumIterator`，该iterator按照key的顺序遍历每层SSTable；其第二级iterator是Table Iterator，该iterator可以按照key的顺序遍历SSTable中的key/value。Table Iterator本身也是一个`TwoLevelIterator`，这也是LevelDB中第二个符合该结构的部分。

其二即为SSTable内部的index与data。Table Iterator作为`TwoLevelIterator`，其第一级iterator遍历SSTable中的index，第二级iterator遍历index相应的data block中的key/value。

| Collection<div style='width:8em'></div> | Iterator[0]<div style='width:12em'></div> | Iterator[1]<div style='width:12em'></div> |
| :-: | :-: | :-: |
| `SSTable` | IndexBlock的BlockIterator | DataBlock的BlockIterator |
| `SSTable*` (level>0) | LevelFileNumIterator | Table Iterator |

然而，如果每个iterator中的key有序，但是所有iterator中的所有key全局无序，就不能使用`TwoLevelIterator`来组装多个iterator。此时，需要一种能够“归并”多路有序iterator的结构。下一节中，笔者将介绍这一结构。

#### 2.2.2 MergingIterator

正如上一节中描述的情形，如果每个iterator中的key有序，但是所有iterator中的所有key全局无序，此时，需要一种能够“归并”多路有序iterator的结构。这一结构即为`MergingIterator`。

`MergingIterator`的creator方法如下：

```cpp

// Return an iterator that provided the union of the data in
// children[0,n-1].  Takes ownership of the child iterators and
// will delete them when the result iterator is deleted.
//
// The result does no duplicate suppression.  I.e., if a particular
// key is present in K child iterators, it will be yielded K times.
//
// REQUIRES: n >= 0
Iterator* NewMergingIterator(const Comparator* comparator, Iterator** children, int n);

```

在创建`MergingIterator`时，需要传入待组合的`Iterator`数组，及用来比较每个`Iterator`中的key的`Comparator`。在通过`MerginIterator`遍历所有iterator的key时，`MergingIterator`会比较其中所有iterator的key，并按照顺序选取最小的遍历；在所有iterator的空间中seek时，`MergingIterator`会调用所有iterator的`Seek`方法，然后比较所有iterator的seek结果，按顺序选取最小的返回。

LevelDB中主要有两处使用了`MergingIterator`：

其一是用来访问整个LevelDB中数据的迭代器`InternalIterator`。该迭代器组合了MemTable Iterator、Immutable MemTable Iterator、每个Level-0 SSTable的Iterator，和level>1的所有SSTable的Concatenating Iterator。

其二是执行Major Compaction时访问需要Compact的所有SSTable的迭代器`InputIterator`。对于level-0的SSTable，其直接组装了所有SSTable的Table Iterator，因为level-0中每个SSTable的key空间不保证全局有序；而对于其它level的SSTable，其通过Concatenating Iterator（即组装了LevelFileNumIterator和Table Iterator的TwoLevelIterator），该Concatenating Iterator中组装了该层需要参与Major Compaction的SSTable。

| Collection<div style='width:8em'></div> | Iterators<div style='width:60em'></div> |
| :-: | :-: |
| InternalIterator | MemTatble Iterator、Immutable MemTable Iterator、level-0 SSTavke Iterators、level>0 SSTable Concatenating Iterator |
| InputIterator | level-0 Table Iterator、level>0 Concatenating Iterator (if necessary) |

### 2.2.3 通过cache优化TwoLevelIterator与MergingIterator

无论是`TwoLevelIterator`还是`MergingIterator`，在使用时都反复需要获取其中iterator是否为valid或获取其value。比如在`MergingIterator`获取下一个key时，其需要比较所有iterator的key，但最终只会修改一个iterator的位置。

为了减少这一开销，LevelDB在`TwoLevelIterator`和`MergingIterator`中，通过`IteratorWrapper`对其组合的iterator进行了封装。`IteratorWrapper`会缓存iterator当前位置的valid状态和key，只有在iterator的位置改变时才会更新。这样，当访问`TwoLevelIterator`和`MergingIterator`时，不需要每次都访问到最下层的iterator，只需要访问缓存状态即可。

`IteratorWrapper`的实现较为简单，这里仅贴出其实现，不再赘述。

```cpp

// A internal wrapper class with an interface similar to Iterator that
// caches the valid() and key() results for an underlying iterator.
// This can help avoid virtual function calls and also gives better
// cache locality.
class IteratorWrapper {
 public:
  IteratorWrapper() : iter_(nullptr), valid_(false) {}
  explicit IteratorWrapper(Iterator* iter) : iter_(nullptr) { Set(iter); }
  ~IteratorWrapper() { delete iter_; }
  Iterator* iter() const { return iter_; }

  // Takes ownership of "iter" and will delete it when destroyed, or
  // when Set() is invoked again.
  void Set(Iterator* iter) {
    delete iter_;
    iter_ = iter;
    if (iter_ == nullptr) {
      valid_ = false;
    } else {
      Update();
    }
  }

  // Iterator interface methods
  bool Valid() const { return valid_; }
  Slice key() const {
    assert(Valid());
    return key_;
  }
  Slice value() const {
    assert(Valid());
    return iter_->value();
  }
  // Methods below require iter() != nullptr
  Status status() const {
    assert(iter_);
    return iter_->status();
  }
  void Next() {
    assert(iter_);
    iter_->Next();
    Update();
  }
  void Prev() {
    assert(iter_);
    iter_->Prev();
    Update();
  }
  void Seek(const Slice& k) {
    assert(iter_);
    iter_->Seek(k);
    Update();
  }
  void SeekToFirst() {
    assert(iter_);
    iter_->SeekToFirst();
    Update();
  }
  void SeekToLast() {
    assert(iter_);
    iter_->SeekToLast();
    Update();
  }

 private:
  void Update() {
    valid_ = iter_->Valid();
    if (valid_) {
      key_ = iter_->key();
    }
  }

  Iterator* iter_;
  bool valid_;
  Slice key_;
};

```