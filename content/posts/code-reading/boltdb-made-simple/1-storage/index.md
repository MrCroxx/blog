---
title: "深入浅出boltdb —— 0x01 存储"
date: 2021-01-05T18:26:19+08:00
lastmod: 2021-01-05T18:26:22+08:00
draft: true
keywords: []
description: ""
tags: ["B+Tree"]
categories: ["深入浅出bolt"]
author: ""
resources:
- name: featured-image
  src: bbolt.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

boltdb使用单内存映射文件作为存储（single memory-mapped file on disk）。boltdb在启动时会通过mmap系统调用将数据库文件映射到内存，这样可以仅通过内存访问来对文件进行读写，而将磁盘I/O交给操作系统管理，只有在事务提交或更新元数据时，boltdb才会通过fdatasyc系统调用强制将脏页落盘，以保证事务的ACID语义。

在linux系统中，内存与磁盘间的换入换出是以页为单位的。为了充分利用这一特定，boltdb的数据库文件也是按页组织的，且页大小与操作系统的页大小相等。

由于mmap与unmmap系统调用的开销相对较大，因此boltdb在每次mmap时会预留一部分空间（小于1GB时倍增，超过1GB时每次额外申请1GB），这会产生一些空闲的页；同时，随着对数据库的操作，在更新值<sup>注1</sup>或删除值时，数据库也可能产生空闲页<sup>注2</sup>。为了高效地管理这些空闲页，boltdb学习操作系统引入了一个简化的空闲页表。

boltdb的页与空闲页表的实现分别在`page.go`与`freelist.go`中，本文主要围绕这两个文件，分析boltdb中页与空闲页表的设计与实现。

{{< admonition info 注1 >}}

为了在保证隔离性的同时支持“读读并发”、“读写并发”（boltdb不支持“写写并发”，即同一时刻只能有一个执行中的可写事务），boltdb在更新页时采用了CoW技术（copy-on-wriite）。在可写事务更新页时，boltdb首先会复制原页，然后在副本上更新，再将引用修改为新页上。这样，当可写事务更新页时，只读事务还可以读取原来的页；当只读提交时，boltdb会释放不再使用的页。这样，便实现了在支持“读读并发”、“读写并发”的同时保证事务的隔离性。

{{< /admonition >}}

{{< admonition info 注2 >}}

boltdb不会将空闲的页归还给系统。其原因有二：

1. 在不断增大的数据库中，被释放的页之后还会被重用。
2. boltdb为了保证读写并发的隔离性，使用CoW来更新页，因此会在任意位置产生空闲页，而不只是在文件末尾产生空闲页（详见[issue#308](https://github.com/boltdb/bolt/issues/308#issuecomment-74811638)）。

{{< /admonition >}}

## 1. page

### 1.1 page的总体结构

boltdb中每个页的元数据保存在该页的开头处，我们可以将其看做页的头部*Page Header*，页的其余部分为页的数据*Page Body*，不同用途的页的*Page Body*中的数据存储格式不同。

![页结构](assets/page-overview.svg "页结构")

页相关的代码主要在`page.go`中。*Page Header*是以`page`结构体表示的，其包含的字段如下：

```go

type pgid uint64

type page struct {
	id       pgid
	flags    uint16
	count    uint16
	overflow uint32
	ptr      uintptr
}

```

| 字段 | 描述 |
| :-: | :- |
| id | 页id。页id从0开始，随地址空间单调递增。 |
| flags | 页标识，用来表示页的类型（用途）。 |
| count | 页中元素个数。 |
| overflow | 溢出页个数。当单页无法容纳数据时，可以用与该页相邻的页保存溢出的数据（详见后文中介绍）。 |
| ptr | 页的数据（*Page Body*）的起始位置。 |

boltdb中的页共有三种用途：保存数据库的元数据（*meta page*）1、保存空闲页表(*freelist page*)、保存数据，因为boltdb中数据是按照B+树组织的，因此保存数据的页又可分为分支节点（*branch page*）和叶子节点（*leaf page*）两种。也就是说，boltdb中页的类型共有4种。

### 1.2 page的数据结构

本节将分别介绍boltdb中*meta page*、*leaf page*与*branch page*的数组结构，*free page*的数据结构与其行为关系较为密切，将在本文之后的章节中介绍。

#### 1.2.1 meta page

*meta page*是boltdb记录数据库元数据的页。*meta page*的格式非常简单，其*Page Body*就是一个`meta`结构体。`meta`结构体的字段如下：

```go

type meta struct {
	magic    uint32
	version  uint32
	pageSize uint32
	flags    uint32
	root     bucket
	freelist pgid
	pgid     pgid
	txid     txid
	checksum uint64
}

// bucket.go

type bucket struct {
	root     pgid   // page id of the bucket's root-level page
	sequence uint64 // monotonically incrementing, used by NextSequence()
}

```

| 字段 | 描述 |
| :-: | :- |
| magic | 一个固定值，用来标识该文件为boltdb数据库文件。 |
| version | 用来标识该文件采用的数据库版本号。 |
| pageSize | 用来标识改文件采用的页大小。 |
| flags | 保留字段，未使用。 |
| root | boltdb记录根bucket的结构体，其包含了该bucket的根页id与bucket编号（单调递增）。 |
| freelist | 空闲页表的首页id。 |
| pgid | 下一个分配的页id，即当前最大页id+1，用于mmap扩容时为新页编号。 |
| txid | 下一个事务的id，全局单调递增。 |
| checksum | meta页的校验和。 |

#### 1.2.2 branch page & leaf page

*branch page*与*leaf page*是boltdb中用来保存B+树节点的页。B+树的分支节点仅用来保存索引（key），而叶子节点既保存索引，又保存值（value）。boltdb支持任意长度的key和value，因此无法直接结构化保存key和value的列表。为了解决这一问题，*branch page*和*leaf page*的*Page Body*起始处是一个由定长的索引（`branchPageElement`或`leafPageElement`）组成的列表，第$i$个索引记录了第$i$个key或key/value的起始位置与key的长度或key/value各自的长度：

```go

// branchPageElement represents a node on a branch page.
type branchPageElement struct {
	pos   uint32
	ksize uint32
	pgid  pgid
}

// key returns a byte slice of the node key.
func (n *branchPageElement) key() []byte {
	buf := (*[maxAllocSize]byte)(unsafe.Pointer(n))
	return (*[maxAllocSize]byte)(unsafe.Pointer(&buf[n.pos]))[:n.ksize]
}

```

![branch page结构示意图](assets/branch-page.svg "branch page结构示意图")

```go

// leafPageElement represents a node on a leaf page.
type leafPageElement struct {
	flags uint32
	pos   uint32
	ksize uint32
	vsize uint32
}

// key returns a byte slice of the node key.
func (n *leafPageElement) key() []byte {
	buf := (*[maxAllocSize]byte)(unsafe.Pointer(n))
	return (*[maxAllocSize]byte)(unsafe.Pointer(&buf[n.pos]))[:n.ksize:n.ksize]
}

// value returns a byte slice of the node value.
func (n *leafPageElement) value() []byte {
	buf := (*[maxAllocSize]byte)(unsafe.Pointer(n))
	return (*[maxAllocSize]byte)(unsafe.Pointer(&buf[n.pos+n.ksize]))[:n.vsize:n.vsize]
}

```

![leaf page结构示意图](assets/leaf-page.svg "leaf page结构示意图")

### 1.3 page溢出结构

虽然B+树会拆分过大的节点，但当key或value过大时，或freelist过大时，不适合将其拆分为多个page。因此，boltdb允许过大的页的数据溢出到之后紧挨着的连续的页中，如下图所示：

![page溢出结构](assets/overflow.svg "page溢出结构")

如上图所示，一个页和其溢出页共用该页的*Page Header*，即溢出页只有*Page Body*部分。这样做的好处是，因为溢出页与首页是连续的且溢出页只有*Page Body*，那么相当于数据的内存地址是连续的，访问数据时只需要正常计算偏移量即可，不需要特殊处理溢出页。溢出页的数量记录在首页的*Page Header*的`overflow`字段中。

## 2. freelist

当页被释放或者数据库初始mmap页数大于需要的页数时，会有部分页空闲。根据数据库领域的经验，当数据库容量达到一定值时，其很快还会达到这一值。因此，大部分数据库不会立即释放小空间，而是等较大空间释放时一起回收或者定期回收。boltdb作为一个轻量级的kv数据库，其不会回收申请过的页。因此，boltdb需要维护一个空闲页表，当已使用的页无法容纳数据时，优先使用空闲页表中的空闲页。

boltdb中空闲页表是通过结构体`freelist`实现的，`freelist`本身也通过`page`存储。当数据库初始化或者恢复时，如果能够找到保存在页中的`freelist`，则直接使用该`freelist`，否则扫描数据库，构建新的`freelist`。

### 2.1 freelist的结构

`freelist`结构体中有3个字段：

```go

// freelist represents a list of all pages that are available for allocation.
// It also tracks pages that have been freed but are still in use by open transactions.
type freelist struct {
	ids     []pgid          // all free and available free page ids.
	pending map[txid][]pgid // mapping of soon-to-be free page ids by tx.
	cache   map[pgid]bool   // fast lookup of all free and pending page ids.
}

```

# ？？？？？？？？？？？？？？？？？？？？？？？？

其中，`ids`字段是已经释放了的页的id的有序列表。为了减少释放页时对`ids`排序的开销，在释放页时，boltdb不会立即将其有序插入`ids`中，而是先通过`pending`字段按照页所属的事务id（`txid`）保存页id，等到事务提交时再将该事务释放的所有页一并有序插入到`ids`中。这样设计的另一个好处是事务回滚时，可以直接删除`pending`字段中该事务id下保存的页id，而不需要从`ids`中删除。除此之外，为了快速检索页是否被释放，在`cache`中，所有已释放的页（`ids`）和所有待释放的页（`pending`）都被标记为`true`。

当`freelist`被写入磁盘（页）中时，需要写入`ids`和`pending`中的所有id。因此，保存`freelist`的`page`的结构如下：

