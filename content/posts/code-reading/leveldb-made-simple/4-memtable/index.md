---
title: "深入浅出LevelDB —— 0x04 memtable [施工中]"
date: 2021-03-05T20:03:13+08:00
lastmod: 2021-03-05T20:03:17+08:00
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

LSMTree中的memtable既作为整合随机写入的buffer，又最为加速热数据读取的cache，是LSMTree的重要组件之一。

由于memtable是保存在内存中的，其I/O开销比保存在稳定存储上的SSTable要小得多，因此LevelDB在实现memtable时，查找结构采用的是跳表SkipList。

无论是memtable还是immutable memtable，其实现均为`leveldb::Memtable`，当memtable写满后，LevelDB会将其从`DBImpl`的`mem_`字段转移到`imm_`字段，不再对其进行写入。

本文主要介绍并分析LevelDB中memtable的设计与实现。

相关文件：`db/skiplist.h`、`db/memtable.h`、`db/memtable.cc`、`db/dbformat.h`。

## 1. SkipList的实现

SkipList是一种多层链表查找结构，其实现较其它查找结构比简单很多。有关SkipList的概念本文不再赘述，不了解的读者可以自行查找其它资料。

LevelDB的跳表实现位于`db/skiplist.h`文件中，其对外提供了插入、判断键是否存在的功能，此外还提供了一个用来更细粒度访问跳表的迭代器，通过迭代器可以顺序地正反遍历跳表，或按照索引随机查找。

LevelDB中的SkipList只插入，不修改或删除，memtable的修改或删除是通过插入有响应标识或序号的key实现的。

SkipList通过template可以实现自定义Key类型与Key的比较方式。自定义`Comparator`只需要实现`include/comparator.h`中的虚类`Comparator`即可。

`leveldb::SkipList`及其迭代器`leveldb::SkipList::Iterator`的声明如下：

```cpp

template <typename Key, class Comparator>
class SkipList {
 private:
  struct Node;

 public:
  // Create a new SkipList object that will use "cmp" for comparing keys,
  // and will allocate memory using "*arena".  Objects allocated in the arena
  // must remain allocated for the lifetime of the skiplist object.
  explicit SkipList(Comparator cmp, Arena* arena);

  SkipList(const SkipList&) = delete;
  SkipList& operator=(const SkipList&) = delete;

  // Insert key into the list.
  // REQUIRES: nothing that compares equal to key is currently in the list.
  void Insert(const Key& key);

  // Returns true iff an entry that compares equal to key is in the list.
  bool Contains(const Key& key) const;

  // Iteration over the contents of a skip list
  class Iterator {
   public:
    // Initialize an iterator over the specified list.
    // The returned iterator is not valid.
    explicit Iterator(const SkipList* list);

    // Returns true iff the iterator is positioned at a valid node.
    bool Valid() const;

    // Returns the key at the current position.
    // REQUIRES: Valid()
    const Key& key() const;

    // Advances to the next position.
    // REQUIRES: Valid()
    void Next();

    // Advances to the previous position.
    // REQUIRES: Valid()
    void Prev();

    // Advance to the first entry with a key >= target
    void Seek(const Key& target);

    // Position at the first entry in list.
    // Final state of iterator is Valid() iff list is not empty.
    void SeekToFirst();

    // Position at the last entry in list.
    // Final state of iterator is Valid() iff list is not empty.
    void SeekToLast();

   private:
    const SkipList* list_;
    Node* node_;
    // Intentionally copyable
  };

 private:
  enum { kMaxHeight = 12 };

  inline int GetMaxHeight() const {
    return max_height_.load(std::memory_order_relaxed);
  }

  Node* NewNode(const Key& key, int height);
  int RandomHeight();
  bool Equal(const Key& a, const Key& b) const { return (compare_(a, b) == 0); }

  // Return true if key is greater than the data stored in "n"
  bool KeyIsAfterNode(const Key& key, Node* n) const;

  // Return the earliest node that comes at or after key.
  // Return nullptr if there is no such node.
  //
  // If prev is non-null, fills prev[level] with pointer to previous
  // node at "level" for every level in [0..max_height_-1].
  Node* FindGreaterOrEqual(const Key& key, Node** prev) const;

  // Return the latest node with a key < key.
  // Return head_ if there is no such node.
  Node* FindLessThan(const Key& key) const;

  // Return the last node in the list.
  // Return head_ if list is empty.
  Node* FindLast() const;

  // Immutable after construction
  Comparator const compare_;
  Arena* const arena_;  // Arena used for allocations of nodes

  Node* const head_;

  // Modified only by Insert().  Read racily by readers, but stale
  // values are ok.
  std::atomic<int> max_height_;  // Height of the entire list

  // Read/written only by Insert().
  Random rnd_;
};

```

SkipList的节点由`leveldb::SkipList::Node`类实现，`Node`的内存是在堆中分配的，其通过Arena分配器分配。有关Arena分配器的介绍详见本系列[深入浅出LevelDB —— 0x02 通用数据结构与工具](/posts/code-reading/leveldb-made-simple/2-basic-data-structure/#1-内存分配器arena)。

`Node`的实现如下：

```cpp

// Implementation details follow
template <typename Key, class Comparator>
struct SkipList<Key, Comparator>::Node {
  explicit Node(const Key& k) : key(k) {}

  Key const key;

  // Accessors/mutators for links.  Wrapped in methods so we can
  // add the appropriate barriers as necessary.
  Node* Next(int n) {
    assert(n >= 0);
    // Use an 'acquire load' so that we observe a fully initialized
    // version of the returned Node.
    return next_[n].load(std::memory_order_acquire);
  }
  void SetNext(int n, Node* x) {
    assert(n >= 0);
    // Use a 'release store' so that anybody who reads through this
    // pointer observes a fully initialized version of the inserted node.
    next_[n].store(x, std::memory_order_release);
  }

  // No-barrier variants that can be safely used in a few locations.
  Node* NoBarrier_Next(int n) {
    assert(n >= 0);
    return next_[n].load(std::memory_order_relaxed);
  }
  void NoBarrier_SetNext(int n, Node* x) {
    assert(n >= 0);
    next_[n].store(x, std::memory_order_relaxed);
  }

 private:
  // Array of length equal to the node height.  next_[0] is lowest level link.
  std::atomic<Node*> next_[1];
};

```

从`Node`的源码中，可以发现其next指针是通过原子类型`std::atomic<Node*>[]`实现的。为了优化原子类型的操作性能，`Node`分别提供了*Read Acquire*和*Write Release*、与*Relaxed*的**Memory Order**，以便在适当场景选择适当一致性，在保证**Memory Coherence**安全性的条件下优化原子类型性能。

有关**C++11 Memory Order**及有关体系结构的知识，可以参考知乎[高并发编程--多处理器编程中的一致性问题(上)](https://zhuanlan.zhihu.com/p/48157076)与[高并发编程--多处理器编程中的一致性问题(下)](https://zhuanlan.zhihu.com/p/48161056)（作者：[三四](https://www.zhihu.com/people/graysen)）

通过原子类实现的Node，SkipList能够保证“读读并发”、“读写并发”的线程安全。而对于并发写入，则需要使用者通过额外的同步机制实现。

{{< admonition quote 引用 >}}

Thread safety :

Writes require external synchronization, most likely a mutex. Reads require a guarantee that the SkipList will not be destroyed while the read is in progress.  Apart from that, reads progress without any internal locking or synchronization.

{{</ admonition >}}

而SkipList的仅插入及对Arena分配器的使用，让SkipList由两个不变的特性：

1. 在SkipList销毁前，其中Node永远不会被删除。SkipList的代码保证了永远不会删除跳表中的节点。

2. Node在被插入到SkipList中后，除了其next/prev指针外，其它数据都不会被修改。

## 2. MemTable的实现

### 2.1 MemTable概览

Memtable对SkipList进行了封装，SkipList只能提供key的插入与查找，而Memtable并对外提供了key/value的增删改查操作。MemTable还提供了正向迭代器与反向迭代器，让使用者能够更细粒度地访问MemTable中的数据。

MemTable的声明如下：

```cpp

class InternalKeyComparator;
class MemTableIterator;

class MemTable {
 public:
  // MemTables are reference counted.  The initial reference count
  // is zero and the caller must call Ref() at least once.
  explicit MemTable(const InternalKeyComparator& comparator);

  MemTable(const MemTable&) = delete;
  MemTable& operator=(const MemTable&) = delete;

  // Increase reference count.
  void Ref() { ++refs_; }

  // Drop reference count.  Delete if no more references exist.
  void Unref() {
    --refs_;
    assert(refs_ >= 0);
    if (refs_ <= 0) {
      delete this;
    }
  }

  // Returns an estimate of the number of bytes of data in use by this
  // data structure. It is safe to call when MemTable is being modified.
  size_t ApproximateMemoryUsage();

  // Return an iterator that yields the contents of the memtable.
  //
  // The caller must ensure that the underlying MemTable remains live
  // while the returned iterator is live.  The keys returned by this
  // iterator are internal keys encoded by AppendInternalKey in the
  // db/format.{h,cc} module.
  Iterator* NewIterator();

  // Add an entry into memtable that maps key to value at the
  // specified sequence number and with the specified type.
  // Typically value will be empty if type==kTypeDeletion.
  void Add(SequenceNumber seq, ValueType type, const Slice& key,
           const Slice& value);

  // If memtable contains a value for key, store it in *value and return true.
  // If memtable contains a deletion for key, store a NotFound() error
  // in *status and return true.
  // Else, return false.
  bool Get(const LookupKey& key, std::string* value, Status* s);

 private:
  friend class MemTableIterator;
  friend class MemTableBackwardIterator;

  struct KeyComparator {
    const InternalKeyComparator comparator;
    explicit KeyComparator(const InternalKeyComparator& c) : comparator(c) {}
    int operator()(const char* a, const char* b) const;
  };

  typedef SkipList<const char*, KeyComparator> Table;

  ~MemTable();  // Private since only Unref() should be used to delete it

  KeyComparator comparator_;
  int refs_;
  Arena arena_;
  Table table_;
};

}  // namespace leveldb

```

MemTable的实例采用了引用计数，其初始计数为0，因此其构造方法的调用者需要手动调用其`Ref`函数；当调动`Unref`方法使其引用计数器减至0时，MemTable会自己销毁。

本节，我们主要关注MemTable是如何封装SkipList以实现key/value的增删改查的。

# 施工中 ... ...

### 2.2 