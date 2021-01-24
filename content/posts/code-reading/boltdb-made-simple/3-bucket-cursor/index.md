---
title: "深入浅出boltdb —— 0x03 Bucket & Cursor"
date: 2021-01-20T23:55:22+08:00
lastmod: 2021-01-20T23:55:26+08:00
draft: false
keywords: []

description: ""
tags: ["boltdb", "B+Tree"]
categories: ["深入浅出bolt"]
author: ""
resources:
- name: featured-image
  src: bbolt.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

在[深入浅出boltdb —— 0x02 B+Tree](/posts/code-reading/boltdb-made-simple/2-b+tree-copy/)中，笔者介绍了boltdb中B+Tree的实现。boltdb将B+Tree进一步封装成了bucket以便用户使用。

与大多数存储系统一样，bucket是一系列key/value的集合；同时，boltdb支持bucket无限嵌套。例如，一个银行的数据可以通过如下的多层嵌套的bucket以及其中的key/value表示：

![bucket嵌套](assets/nested-bucket.svg "bucket嵌套")

在boltdb中，每个桶都是一棵B+Tree，为了便于用户访问桶中B+Tree的节点，boltdb实现了cursor游标。

本文，笔者将分析介绍boltdb中桶与游标的实现。

# 施工中。。。 。。。

## 1. bucket

与B+Tree的节点类似，bucket也是按需打开的。因此，分析boltdb中bucket也可以从存储与内存两方面入手。

本节笔者将先介绍boltdb中bucket的存储结构，然后再介绍当bucket被事务打开时，其内存结构与相关方法。

### 1.1 bucket的存储结构

#### 1.1.1 bucket与B+Tree

在boltdb中，每个bucket中的数据都是一棵独立的B+Tree。boltdb中B+Tree的节点是通过page存储的，分支节点branchNodePage保存了每个孩子的key和pgid，叶子节点leafNodePage保存了其中每个元素的key/value与元素类型（表示普通kv还是表示bucket）。因此，boltdb的一棵B+Tree的存储结构可表示为下图中的样子。

![boltdb中B+Tree存储结构示意图](assets/b+tree.svg "boltdb中B+Tree存储结构示意图")

boltdb除了需要根据bucket的名称（`name`）找到其相应的B+Tree的根节点的pgid（`root`）外，还需要为每个bucket保存一个64为整型值，以便实现生成单调递增的序列号的功能（便于并行程序存储中间结果或实现锁）。这样，bucket的元数据也可以表示为一个key/value对，即$name -> (root,sequence)$，而boltdb也确实是这样实现的。

在boltdb中，bucekt是支持嵌套的，boltdb的数据库元数据meta中只保存了根bucket（即`meta`结构体中的`root`字段），所有签到的bucket组成了一个多叉树型结构，如下图所示。

![bucket多叉树型结构示意图](assets/bucket.svg "bucket多叉树型结构示意图")

既然bucket的元数据可以表示为key/value对，而bucket中存储的数据也是key/value对，且bucket是支持嵌套的，所以在boltdb中，bucket的元数据也以key/value的形式保存在其父bucket的B+Tree中叶子节点的元素中，只是该元素的`flag`字段有1位标识了该key/value表示的是bucket。只有根bucket不同，根bucket不需要通过`name`来索引，因此其只需要保存相当于其他bucket的元数据中value的数据，并直接通过boltdb的`meta`结构体的`root`字段索引。

例如，有3个bucket*b0*、*b1*、*b2*，其相应的B+Tree的根节点所在page分别为*r0*、*r1*、*r2*，*b0*是*b1*与*b2*的父bucket。其存储结构如下图所示：

![bucket与B+Tree示意图](assets/bucket-and-b+tree.svg "bucket与B+Tree示意图")

从上图中可以看出，*b1*和*b2*的元数据，分别保存在了*b0*的第0个（*page l0*的*elem 0*）和第11个（*page l2*的*elem 3*）键值对中。其中，键值对的key即为bucket的`name`，value为`bucket`结构体，该结构体由bucket的B+Tree树根节点的pgid `root`和64位整型序列号`sequence`组成：

```go

// bucket represents the on-file representation of a bucket.
// This is stored as the "value" of a bucket key. If the bucket is small enough,
// then its root page can be stored inline in the "value", after the bucket
// header. In the case of inline buckets, the "root" will be 0.
type bucket struct {
	root     pgid   // page id of the bucket's root-level page
	sequence uint64 // monotonically incrementing, used by NextSequence()
}

```

#### 1.1.2 inline bucket

由于每个bucket都是一棵B+Tree，而B+Tree至少需要有一个根节点，且boltdb中每个节点都是一个page，那么如果boltdb中有很多数据量达不到一页的bucket，则会浪费很多空间。为了避免这一问题，对于数据量较小的bucket，boltdb会将其数据放在其元数据后，直接保存在key/value结构的value中，此时该bucket的元数据的`root`值为0，其被称为*inline bucket*。为了简化实现，boltdb在保存inline bucket时采用了类似虚拟内存的做法：其数据仍按照page的方式组织，但是其实际大小并非真正的page大小。普通的bucket与inline bucket的存储结构示意图如下图所示。

![普通bucket与inline bucket存储结构示意图](assets/inline-bucket.svg "普通bucket与inline bucket存储结构示意图")

boltdb中判断bucket是否作为inline bucket存储的方法为`inlineable`。

```go

// inlineable returns true if a bucket is small enough to be written inline
// and if it contains no subbuckets. Otherwise returns false.
func (b *Bucket) inlineable() bool {
	var n = b.rootNode

	// Bucket must only contain a single leaf node.
	if n == nil || !n.isLeaf {
		return false
	}

	// Bucket is not inlineable if it contains subbuckets or if it goes beyond
	// our threshold for inline bucket size.
	var size = pageHeaderSize
	for _, inode := range n.inodes {
		size += leafPageElementSize + len(inode.key) + len(inode.value)

		if inode.flags&bucketLeafFlag != 0 {
			return false
		} else if size > b.maxInlineBucketSize() {
			return false
		}
	}

	return true
}

// Returns the maximum total size of a bucket to make it a candidate for inlining.
func (b *Bucket) maxInlineBucketSize() int {
	return b.tx.db.pageSize / 4
}

```

该方法判断bucket是否满足以下几点：
1. bucket是否只有一个节点（即根节点为叶子节点）。
2. bucket中是否不包含子bucket。
3. bucket中数据大小是否小于阈值（默认为$\frac{1}{4}$）。

如果以上3条都满足，那么该方法返回true，该bucket将作为inline bucket存储。

#### 1.1.3 bucket元数据的序列化与反序列化

由于bucket需要存储的元数据较少，且bucket的元数据是作为B+Tree中的key/value保存的，因此bucket的序列化与反序列化方法较为简单。

在序列化普通bucket时，只需要序列化其元数据，因此直接深拷贝`bucket`结构体即可。相关代码在`spill`方法中（该方法序列化的是子bucket的元数据），如下所示：

```go

value = make([]byte, unsafe.Sizeof(bucket{}))
var bucket = (*bucket)(unsafe.Pointer(&value[0]))
*bucket = *child.bucket

```

而`write`是序列化inline bucket的方法，其实现方式如下：

```go

// write allocates and writes a bucket to a byte slice.
func (b *Bucket) write() []byte {
	// Allocate the appropriate size.
	var n = b.rootNode
	var value = make([]byte, bucketHeaderSize+n.size())

	// Write a bucket header.
	var bucket = (*bucket)(unsafe.Pointer(&value[0]))
	*bucket = *b.bucket

	// Convert byte slice to a fake page and write the root node.
	var p = (*page)(unsafe.Pointer(&value[bucketHeaderSize]))
	n.write(p)

	return value
}

```

`write`方法的实现非常简单。其除了写入了`bucket`结构体中的数据，还将`value`的剩余空间作为虚拟页，将该bucket中唯一的B+Tree节点（也是根节点）的数据写入到该虚拟页中。这类似于操作系统中虚拟内存的实现。

`openBucket`是bucket反序列化方法中读取value部分元数据的方法，其实现方式如下：

```go

// Helper method that re-interprets a sub-bucket value
// from a parent into a Bucket
func (b *Bucket) openBucket(value []byte) *Bucket {
	var child = newBucket(b.tx)

	// If unaligned load/stores are broken on this arch and value is
	// unaligned simply clone to an aligned byte array.
	unaligned := brokenUnaligned && uintptr(unsafe.Pointer(&value[0]))&3 != 0

	if unaligned {
		value = cloneBytes(value)
	}

	// If this is a writable transaction then we need to copy the bucket entry.
	// Read-only transactions can point directly at the mmap entry.
	if b.tx.writable && !unaligned {
		child.bucket = &bucket{}
		*child.bucket = *(*bucket)(unsafe.Pointer(&value[0]))
	} else {
		child.bucket = (*bucket)(unsafe.Pointer(&value[0]))
	}

	// Save a reference to the inline page if the bucket is inline.
	if child.root == 0 {
		child.page = (*page)(unsafe.Pointer(&value[bucketHeaderSize]))
	}

	return &child
}

```

该方法会根据打开该bucket的事务类型不同，判断元数据拷贝的行为：
1. 如果以只读事务的方式打开，那么直接将bucket结构体的指针指向value位置（传入的value位置即为mmap memory，这也保证了mmap memory只读）；
2. 如果以读写事务的方式打开，那么需要将value中的数据拷贝到heap memory中，以用于更新。

如果反序列化的bucket是inline bucket，该方法还会将其虚拟页（value中元数据后的剩余部分）保存到`Bucket`示例的`page`字段中。

另外，该方法还会检测当前平台架构是否需要4字节对齐，如果需要对齐即使是只读事务，也需要将mmap memory中的数据拷贝到heap memory中以对齐（详见[pull#578](https://github.com/boltdb/bolt/pull/578)）。

### 1.2 bucket的内存结构

当bucket被事务打开时，boltdb还需要记录bucket打开过的node、打开过的子bucket等信息，以避免同一事务重复打开bucket或node，同时在事务提交时便于找到所有相关数据一并写入到存储。

本节笔者将介绍bucket打开时的内存结构`Bucket`的实现。

#### 1.2.1 Bucket结构体

被事务打开的bucket在内存中表示为`Bucket`结构体，其包含字段如下：

```go

// Bucket represents a collection of key/value pairs inside the database.
type Bucket struct {
	*bucket
	tx       *Tx                // the associated transaction
	buckets  map[string]*Bucket // subbucket cache
	page     *page              // inline page reference
	rootNode *node              // materialized node for the root page.
	nodes    map[pgid]*node     // node cache

	// Sets the threshold for filling nodes when they split. By default,
	// the bucket will fill to 50% but it can be useful to increase this
	// amount if you know that your write workloads are mostly append-only.
	//
	// This is non-persisted across transactions so it must be set in every Tx.
	FillPercent float64
}

```

| 字段<div style="width: 14em"> | 描述 |
| :-: | :- |
| `*bucket` | bucket需要存储的元数据的value部分（详见上节），被只读事务打开的`Bucket`中该指针指向mmap memory，被读写事务打开的`Bucket`中该指针指向heap memory。 |
| `tx *Tx` | 保存打开该bucket的事务示例。 |
| `buckets map[string]*Bucket` | 记录打开的子bucket。 |
| `page *page` | 如果该bucket为inline bucket，那么该字段指向了其虚拟页的位置。 |
| `rootNode *node` | 用来记录该bucket的B+Tree根节点实例化后的node（根节点同样是按需实例化的，因此该字段可能为nil）。 |
| `nodes map[pgid]*node` | 用来记录该bucket的B+Tree中已实例化的node。 |
| `FillPercent float64` | bucket中B+Tree的填充率阈值。 |

`Bucket`结构体中的字段基本都是对外不可见的，boltdb的用户需要通过`Bucket`提供的一些可见的方法来访问这些字段：

| 方法<div style="width: 14em"> | 描述 |
| :-: | :- |
| `Tx() *Tx` | 返回打开该bucket的事务。 |
| `Root() pgid` | 返回该bucket的B+Tree的根节点的pgid。 |
| ` Writable() bool` | 返回该bucket是否可写（打开该bucket的事务是否可写）。 |

#### 1.2.3 Bucket的操作与实现

boltdb为用户提供了创建、打开、删除bucket，与对bucket中数据进行增删改查的方法。

本节笔者将介绍这些方法与其实现。

##### 1.2.3.1 Coursor

Bucket中许多操作需要依赖游标`Cursor`，游标是`Bucket`用来遍历B+Tree寻找key/value的工具。`Cursor`的实现笔者放在本文后面的部分介绍，这里读者这需要知道`Cursor`的作用即可。游标的获取方法为`Cursor`：

```go

// Cursor creates a cursor associated with the bucket.
// The cursor is only valid as long as the transaction is open.
// Do not use a cursor after the transaction is closed.
func (b *Bucket) Cursor() *Cursor {
	// Update transaction statistics.
	b.tx.stats.CursorCount++

	// Allocate and return a cursor.
	return &Cursor{
		bucket: b,
		stack:  make([]elemRef, 0),
	}
}

```

`Cursor`的生命周期与打开该`Bucket`的事务的声明周期相同，在使用boltdb时需要注意。

#### 1.2.3.2 B+Tree节点的打开

由于Bucket操作涉及到B+Tree的更新，因此这里先介绍`Bucket`与`Cursor`访问或打开B+Tree节点的操作。这一部分与`Cursor`的实现关系更大，但由于`bucket.go`中包含了相关代码，因此笔者在这里先介绍B+Tree节点打开的方式。

当Cursor只需要读取B+Tree的内容时，其只需要根据节点的pgid，在mmap memory中找到相应位置读取即可；而在Cursor需要更新B+Tree时，由于boltdb只读取mmap memory中的内容，因此需要先读取page并实例化相应的node（但此时node的key/value还是直接指向mmap memory）。`Bucket`实例化node的方法是`node`：

```go

// node creates a node from a page and associates it with a given parent.
func (b *Bucket) node(pgid pgid, parent *node) *node {
	_assert(b.nodes != nil, "nodes map expected")

	// Retrieve node if it's already been created.
	if n := b.nodes[pgid]; n != nil {
		return n
	}

	// Otherwise create a node and cache it.
	n := &node{bucket: b, parent: parent}
	if parent == nil {
		b.rootNode = n
	} else {
		parent.children = append(parent.children, n)
	}

	// Use the inline page if this is an inline bucket.
	var p = b.page
	if p == nil {
		p = b.tx.page(pgid)
	}

	// Read the page into the node and cache it.
	n.read(p)
	b.nodes[pgid] = n

	// Update statistics.
	b.tx.stats.NodeCount++

	return n
}

```

`node`方法执行了如下操作：

1. 检查当前`Bucket`的`nodes`字段是否记录了该pgid，如果记录存在，说明当前事务已经实例化了该node，因此直接返回记录中缓存的node即可。
2. 如果还没打开过，则实例化新node并缓存，同时设置node的部分字段。
3. 选择需要读取的page，如果当前bucket不是inline bucket，则通过事务示例获取传入的pgid相应的page的指针（事务需要记录需要更新的page，以便事务提交后释放）；否则，直接使用bucket的虚拟页。
4. 调用该node的`read`方法，读取page数据并构建node，同时将该node记录到当前bucket的`nodes`字段中。
5. 更新统计变量，返回node实例。

`node`方法时是明确需要更新节点时才需要调用的。而如果只需要读取节点，`Bucket`提供了`pageNode`方法，该方法会返回给定pgid相应的page或node。即如果该节点已被实例化为node，则返回node，否则直接返回page：

```go

// pageNode returns the in-memory node, if it exists.
// Otherwise returns the underlying page.
func (b *Bucket) pageNode(id pgid) (*page, *node) {
	// Inline buckets have a fake page embedded in their value so treat them
	// differently. We'll return the rootNode (if available) or the fake page.
	if b.root == 0 {
		if id != 0 {
			panic(fmt.Sprintf("inline bucket non-zero page access(2): %d != 0", id))
		}
		if b.rootNode != nil {
			return nil, b.rootNode
		}
		return b.page, nil
	}

	// Check the node cache for non-inline buckets.
	if b.nodes != nil {
		if n := b.nodes[id]; n != nil {
			return nil, n
		}
	}

	// Finally lookup the page from the transaction if no node is materialized.
	return b.tx.page(id), nil
}

```

该方法首先判断当前bucket是否为inline bucket，如果是那么直接返回其虚拟页；否则，检查`nodes`中是否缓存了相应的node，如果缓存中有则返回已实例化的node，否则通过事务返回相应的page。

#### 1.2.3.3 Bucket的创建、打开与删除

boltdb的用户可以通过`CreateBucket`、`CreateBucketIfNotExists`方法创建并打开bucket，通过`Bucket`方法打开已创建的bucket，通过`DeleteBucket`方法删除bucket。由于boltdb将bucket的元数据作为B+Tree的key/value存储，因此需要访问bucket的元数据时也需要访问B+Tree。

```go

// Bucket retrieves a nested bucket by name.
// Returns nil if the bucket does not exist.
// The bucket instance is only valid for the lifetime of the transaction.
func (b *Bucket) Bucket(name []byte) *Bucket {
	if b.buckets != nil {
		if child := b.buckets[string(name)]; child != nil {
			return child
		}
	}

	// Move cursor to key.
	c := b.Cursor()
	k, v, flags := c.seek(name)

	// Return nil if the key doesn't exist or it is not a bucket.
	if !bytes.Equal(name, k) || (flags&bucketLeafFlag) == 0 {
		return nil
	}

	// Otherwise create a bucket and cache it.
	var child = b.openBucket(v)
	if b.buckets != nil {
		b.buckets[string(name)] = child
	}

	return child
}

```

当通过`Bucket`方法打开已创建的bucket时，首先会检查当前`Bucket`的`buckets`字段中是否保存了需要打开的bucket，该字段记录了当前事务已打开的当前bucket的子bucket。如果需要打开的bucket已被打开，则直接返回已实例化的`Bucket`。如果还没有打开，则先通过Cursor，根据bucket名找到其在B+Tree中的key/value。如果key不存在，或当前key的位置记录的不是bucekt，则返回空结果。如果找到了当前bucket相应的key/value，则在该value处调用`openBucket`方法反序列化bucket元数据并实例化`Bucket`示例，然后将其记录在当前`Bucket`结构体的`buckets`字段中，然后返回子`Bucket`示例。

```go

// CreateBucket creates a new bucket at the given key and returns the new bucket.
// Returns an error if the key already exists, if the bucket name is blank, or if the bucket name is too long.
// The bucket instance is only valid for the lifetime of the transaction.
func (b *Bucket) CreateBucket(key []byte) (*Bucket, error) {
	if b.tx.db == nil {
		return nil, ErrTxClosed
	} else if !b.tx.writable {
		return nil, ErrTxNotWritable
	} else if len(key) == 0 {
		return nil, ErrBucketNameRequired
	}

	// Move cursor to correct position.
	c := b.Cursor()
	k, _, flags := c.seek(key)

	// Return an error if there is an existing key.
	if bytes.Equal(key, k) {
		if (flags & bucketLeafFlag) != 0 {
			return nil, ErrBucketExists
		}
		return nil, ErrIncompatibleValue
	}

	// Create empty, inline bucket.
	var bucket = Bucket{
		bucket:      &bucket{},
		rootNode:    &node{isLeaf: true},
		FillPercent: DefaultFillPercent,
	}
	var value = bucket.write()

	// Insert into node.
	key = cloneBytes(key)
	c.node().put(key, key, value, 0, bucketLeafFlag)

	// Since subbuckets are not allowed on inline buckets, we need to
	// dereference the inline page, if it exists. This will cause the bucket
	// to be treated as a regular, non-inline bucket for the rest of the tx.
	b.page = nil

	return b.Bucket(key), nil
}

// CreateBucketIfNotExists creates a new bucket if it doesn't already exist and returns a reference to it.
// Returns an error if the bucket name is blank, or if the bucket name is too long.
// The bucket instance is only valid for the lifetime of the transaction.
func (b *Bucket) CreateBucketIfNotExists(key []byte) (*Bucket, error) {
	child, err := b.CreateBucket(key)
	if err == ErrBucketExists {
		return b.Bucket(key), nil
	} else if err != nil {
		return nil, err
	}
	return child, nil
}

```

`CreateBucket`方法是用来创建bucket的方法，该方法执行了如下操作：
1. 检查事务是否已被关闭，或事务不可写，或者给定key为空，此时条件不合法，返回相应错误。
2. 获取Cursor，并通过`seek`方法将Cursor移动到B+Tree中给定key的位置。
3. 如果Cursor处已有key存在，说明key重复无法创建，返回相应错误。
4. 如果可以创建，则实例化新`Bucket`结构体，序列化其元数据，并将其插入到相应的node中。