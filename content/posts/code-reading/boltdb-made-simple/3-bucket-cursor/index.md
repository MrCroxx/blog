---
title: "深入浅出boltdb —— 0x03 bucket & cursor"
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

## 1. bucket

与B+Tree的节点类似，bucket也是按需打开的。因此，分析boltdb中bucket也可以从存储与内存两方面入手。

本节笔者将先介绍boltdb中bucket的存储结构，然后再介绍当bucket被事务打开时，其内存结构与相关方法。

### 1.1 bucket的存储结构

#### 1.1.1 bucket与B+Tree

在boltdb中，每个bucket中的数据都是一棵独立的B+Tree。boltdb中B+Tree的节点是通过page存储的，分支节点branchNodePage保存了每个孩子的key和pgid，叶子节点leafNodePage保存了其中每个元素的key/value与元素类型（表示普通kv还是表示bucket）。因此，boltdb的一棵B+Tree的存储结构可表示为下图中的样子。

![boltdb中B+Tree存储结构示意图](assets/b+tree.svg "boltdb中B+Tree存储结构示意图")

boltdb除了需要根据bucket的名称（`name`）找到其相应的B+Tree的根节点的pgid（`root`）外，还需要为每个bucket保存一个64为整型值，以便实现生成单调递增的序列号的功能（便于并行程序存储中间结果或实现锁）。这样，bucket的元数据也可以表示为一个key/value对，即$name -> (root,sequence)$，而boltdb也确实是这样实现的。

在boltdb中，bucekt是支持嵌套的，boltdb的数据库元数据meta中只保存了根bucket（即`meta`结构体中的`root`字段），所有嵌套的bucket组成了一个多叉树型结构，如下图所示。

![bucket多叉树型结构示意图](assets/bucket.svg "bucket多叉树型结构示意图")

{{< admonition info 提示 >}}

boltdb的root bucket只保存子bucket，而不保存键值对。

{{< /admonition >}}

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

如果反序列化的bucket是inline bucket，该方法还会将其虚拟页（value中元数据后的剩余部分）保存到`Bucket`实例的`page`字段中。

另外，该方法还会检测当前平台架构是否需要4字节对齐，如果需要对齐即使是只读事务，也需要将mmap memory中的数据拷贝到heap memory中以对齐（详见[pull#578](https://github.com/boltdb/bolt/pull/578)）。

### 1.2 bucket的内存结构

当bucket被事务打开时，boltdb还需要记录bucket打开过的node、打开过的子bucket等信息，以避免同一事务重复打开bucket或node，同时在事务提交时便于找到所有相关数据一并写入到存储。

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
| `tx *Tx` | 保存打开该bucket的事务实例。 |
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

### 1.3 Bucket的操作与实现

boltdb为用户提供了创建、打开、删除bucket，与对bucket中数据进行增删改查的方法。

本节笔者将介绍这些方法与其实现。

#### 1.3.1 Coursor

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

#### 1.3.2 B+Tree节点的访问

由于Bucket操作涉及到B+Tree的更新，因此这里先介绍`Bucket`与`Cursor`访问或打开B+Tree节点的操作。这一部分与`Cursor`的实现关系更大，但由于`bucket.go`中包含了相关代码，因此笔者在这里先介绍B+Tree节点的访问方式。

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
3. 选择需要读取的page，如果当前bucket不是inline bucket，则通过事务实例获取传入的pgid相应的page的指针（如果page被修改，该方法会返回page buffer，否则返回mmap中的page）；否则，直接使用bucket的虚拟页。
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

#### 1.3.3 bucket中B+Tree的rebalance与spill

当事务提交时，其需要从根bucket开始递归进行`rebalance`与`spill`操作，以调整所有修改过的bucket的B+Tree的结构。因此，bucket需要提供`rebalance`与`spill`方法，以封装其递归过程。

`Bucket`的`rebalance`方法实现如下：

```go

// rebalance attempts to balance all nodes.
func (b *Bucket) rebalance() {
	for _, n := range b.nodes {
		n.rebalance()
	}
	for _, child := range b.buckets {
		child.rebalance()
	}
}

```

该方法实现非常简单，首先其遍历了当前`Bucket`对象的`nodes`中缓存的node，调用`rebalance`方法，然后递归遍历`buckets`中缓存的子bucket的`Bucket`实例，调用`rebalance`方法。

相比`rebalance`方法，`Bucket`的`spill`方法实现稍微复杂一些：

```go

// spill writes all the nodes for this bucket to dirty pages.
func (b *Bucket) spill() error {
	// Spill all child buckets first.
	for name, child := range b.buckets {
		// If the child bucket is small enough and it has no child buckets then
		// write it inline into the parent bucket's page. Otherwise spill it
		// like a normal bucket and make the parent value a pointer to the page.
		var value []byte
		if child.inlineable() {
			child.free()
			value = child.write()
		} else {
			if err := child.spill(); err != nil {
				return err
			}

			// Update the child bucket header in this bucket.
			value = make([]byte, unsafe.Sizeof(bucket{}))
			var bucket = (*bucket)(unsafe.Pointer(&value[0]))
			*bucket = *child.bucket
		}

		// Skip writing the bucket if there are no materialized nodes.
		if child.rootNode == nil {
			continue
		}

		// Update parent node.
		var c = b.Cursor()
		k, _, flags := c.seek([]byte(name))
		if !bytes.Equal([]byte(name), k) {
			panic(fmt.Sprintf("misplaced bucket header: %x -> %x", []byte(name), k))
		}
		if flags&bucketLeafFlag == 0 {
			panic(fmt.Sprintf("unexpected bucket header flag: %x", flags))
		}
		c.node().put([]byte(name), []byte(name), value, 0, bucketLeafFlag)
	}

	// Ignore if there's not a materialized root node.
	if b.rootNode == nil {
		return nil
	}

	// Spill nodes.
	if err := b.rootNode.spill(); err != nil {
		return err
	}
	b.rootNode = b.rootNode.root()

	// Update the root node for this bucket.
	if b.rootNode.pgid >= b.tx.meta.pgid {
		panic(fmt.Sprintf("pgid (%d) above high water mark (%d)", b.rootNode.pgid, b.tx.meta.pgid))
	}
	b.root = b.rootNode.pgid

	return nil
}

// free recursively frees all pages in the bucket.
func (b *Bucket) free() {
	if b.root == 0 {
		return
	}

	var tx = b.tx
	b.forEachPageNode(func(p *page, n *node, _ int) {
		if p != nil {
			tx.db.freelist.free(tx.meta.txid, p)
		} else {
			n.free()
		}
	})
	b.root = 0
}

// forEachPageNode iterates over every page (or node) in a bucket.
// This also includes inline pages.
func (b *Bucket) forEachPageNode(fn func(*page, *node, int)) {
	// If we have an inline page or root node then just use that.
	if b.page != nil {
		fn(b.page, nil, 0)
		return
	}
	b._forEachPageNode(b.root, 0, fn)
}

func (b *Bucket) _forEachPageNode(pgid pgid, depth int, fn func(*page, *node, int)) {
	var p, n = b.pageNode(pgid)

	// Execute function.
	fn(p, n, depth)

	// Recursively loop over children.
	if p != nil {
		if (p.flags & branchPageFlag) != 0 {
			for i := 0; i < int(p.count); i++ {
				elem := p.branchPageElement(uint16(i))
				b._forEachPageNode(elem.pgid, depth+1, fn)
			}
		}
	} else {
		if !n.isLeaf {
			for _, inode := range n.inodes {
				b._forEachPageNode(inode.pgid, depth+1, fn)
			}
		}
	}
}

```

`spill`方法会将当前bucket与子bucekt的更新全部写入到page buffer中。其执行了如下操作：

1. 由于子bucket的元数据作为当前bucket的B+Tree的key/value存储，因此首先遍历`buckets`中缓存的已打开的子`Bucket`实例，对其执行以下操作：
  1. 如果子bucket可存储为inline bucket，则调用`free`方法，释放子bucket所有的页，并将其元数据与数据写入到`value`中。
  2. 如果子bucket为regular bucket，则递归调用其`spill`方法，将其中更新写入到page buffer中，然后将其元数据写入到`value`中。
  3. 如果子bucket没有实例化其B+Tree的根node，说明其没有更新，因此跳过该子bucket，继续处理后续子bucket。
  4. 获取游标并将其移动到该子bucekt的key的位置，然后更新其value为`value`。
2. 如果当前bucekt没有实例化其B+Tree的根node，说明其没有更新，因此直接返回。
3. 如果当前bucekt中有更新，则调用根节点的`spill`方法，该方法会递归调用整棵B+Tree中已实例化的node的`spill`方法（详见[深入浅出boltdb —— 0x02 B+Tree](/posts/code-reading/boltdb-made-simple/2-b+tree/)中介绍的node的`spill`方法的实现）。
4. 更新`Bucket`的`root`字段，使其指向新的B+Tree根节点所在页。

其中，`Bucket`的`free`方法会递归遍历并释放bucket的B+Tree中所有的page，其特殊处理了inline bucket的虚拟页、因重新mmap而没有引用page的node等特殊情况，这里不再赘述。

#### 1.3.4 Bucket的创建、打开与删除

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

当通过`Bucket`方法打开已创建的bucket时，首先会检查当前`Bucket`的`buckets`字段中是否保存了需要打开的bucket，该字段记录了当前事务已打开的当前bucket的子bucket。如果需要打开的bucket已被打开，则直接返回已实例化的`Bucket`。如果还没有打开，则先通过Cursor，根据bucket名找到其在B+Tree中的key/value。如果key不存在，或当前key的位置记录的不是bucekt，则返回空结果。如果找到了当前bucket相应的key/value，则在该value处调用`openBucket`方法反序列化bucket元数据并实例化`Bucket`实例，然后将其记录在当前`Bucket`结构体的`buckets`字段中，然后返回子`Bucket`实例。

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
4. 如果可以创建，则则实例化新`Bucket`结构体。由于新创建的bucket足够小，因此直接将其作为inline bucekt序列化并插入到当前Cursor所在node中。注意，`Cursor`的`node`方法会从B+Tree树的根节点开始实例化到Cursor当前所在的node。
5. 如果当前bucket为inline bucket，则在创建子bucket后其不再为inline bucket，因此将其`page`字段置为nil，以便当前事务后续操作中将其作为普通bucket处理（由于上一步中已实例化根node，所以此时当前bucket的`page`可以安全地释放）。
6. 通过`Bucket`方法返回新创建好的bucket的`Bucket`实例。

`CreateBucketIfNotExists`则会调用`CreateBucket`方法尝试创建新bucket，如果bucket已存在则直接通过`Bucket`方法返回已创建的bucket，否则返回错误。

```go

// DeleteBucket deletes a bucket at the given key.
// Returns an error if the bucket does not exists, or if the key represents a non-bucket value.
func (b *Bucket) DeleteBucket(key []byte) error {
	if b.tx.db == nil {
		return ErrTxClosed
	} else if !b.Writable() {
		return ErrTxNotWritable
	}

	// Move cursor to correct position.
	c := b.Cursor()
	k, _, flags := c.seek(key)

	// Return an error if bucket doesn't exist or is not a bucket.
	if !bytes.Equal(key, k) {
		return ErrBucketNotFound
	} else if (flags & bucketLeafFlag) == 0 {
		return ErrIncompatibleValue
	}

	// Recursively delete all child buckets.
	child := b.Bucket(key)
	err := child.ForEach(func(k, v []byte) error {
		if v == nil {
			if err := child.DeleteBucket(k); err != nil {
				return fmt.Errorf("delete bucket: %s", err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Remove cached copy.
	delete(b.buckets, string(key))

	// Release all bucket pages to freelist.
	child.nodes = nil
	child.rootNode = nil
	child.free()

	// Delete the node if we have a matching key.
	c.node().del(key)

	return nil
}

```

`DeleteBucket`方法是用来删除bucket的方法，该方法执行了如下操作：
1. 检查事务是否已被关闭，或事务不可写，此时条件不合法，返回相应错误。
2. 获取Cursor，并将其移动到给定key的位置。
3. 判断Cursor当前所在位置的key与给定key是否相同，以判断要删除的bucket是否存在，如果不存在则返回错误；如果key存在，根据当前位置的key/value的`flag`判断其是否为bucket，如果不是bucket，也返回错误。
4. 实例化要删除的bucket，并递归删除其中子bucket。
5. 从当前`Bucket`的`buckets`字段中删除待删除的bucket的缓存。
6. 释放待删除bucket中的缓存与page。
7. 从Cursor所在node中删除待删除的key。

#### 1.3.5 key/value的增删改查

bucket中key/value的增删改查的实现同样依赖Cursor，其实现方式较子bucket的增删改查更简单，这里不再赘述，只给出其源码。

```go

// Get retrieves the value for a key in the bucket.
// Returns a nil value if the key does not exist or if the key is a nested bucket.
// The returned value is only valid for the life of the transaction.
func (b *Bucket) Get(key []byte) []byte {
	k, v, flags := b.Cursor().seek(key)

	// Return nil if this is a bucket.
	if (flags & bucketLeafFlag) != 0 {
		return nil
	}

	// If our target node isn't the same key as what's passed in then return nil.
	if !bytes.Equal(key, k) {
		return nil
	}
	return v
}

```

```go

// Put sets the value for a key in the bucket.
// If the key exist then its previous value will be overwritten.
// Supplied value must remain valid for the life of the transaction.
// Returns an error if the bucket was created from a read-only transaction, if the key is blank, if the key is too large, or if the value is too large.
func (b *Bucket) Put(key []byte, value []byte) error {
	if b.tx.db == nil {
		return ErrTxClosed
	} else if !b.Writable() {
		return ErrTxNotWritable
	} else if len(key) == 0 {
		return ErrKeyRequired
	} else if len(key) > MaxKeySize {
		return ErrKeyTooLarge
	} else if int64(len(value)) > MaxValueSize {
		return ErrValueTooLarge
	}

	// Move cursor to correct position.
	c := b.Cursor()
	k, _, flags := c.seek(key)

	// Return an error if there is an existing key with a bucket value.
	if bytes.Equal(key, k) && (flags&bucketLeafFlag) != 0 {
		return ErrIncompatibleValue
	}

	// Insert into node.
	key = cloneBytes(key)
	c.node().put(key, key, value, 0, 0)

	return nil
}

```

```go

// Delete removes a key from the bucket.
// If the key does not exist then nothing is done and a nil error is returned.
// Returns an error if the bucket was created from a read-only transaction.
func (b *Bucket) Delete(key []byte) error {
	if b.tx.db == nil {
		return ErrTxClosed
	} else if !b.Writable() {
		return ErrTxNotWritable
	}

	// Move cursor to correct position.
	c := b.Cursor()
	_, _, flags := c.seek(key)

	// Return an error if there is already existing bucket value.
	if (flags & bucketLeafFlag) != 0 {
		return ErrIncompatibleValue
	}

	// Delete the node if we have a matching key.
	c.node().del(key)

	return nil
}

```

#### 1.3.6 自增序列号生成

boltdb的bucket能够提供自增序列号生成功能。用户可以通过`Bucket`的`Sqeuence`方法获取当前bucket的序列号、通过`SetSequence`将当前bucekt的序列号置为一个给定值、或通过`NextSequence`增大并获取下一个序列号。

前文中介绍过bucket的序列号保存在其元数据的`sequence`字段中，因此`Sqeuence`方法获取序列号时，只需要返回相应字段即可：

```go

// Sequence returns the current integer for the bucket without incrementing it.
func (b *Bucket) Sequence() uint64 { return b.bucket.sequence }

```

而`SetSequence`设置序列号和`NextSequence`增大序列号则不能只更新该字段的值。其原因如下：由于只有可写事务才能调用这两个方法，而可写事务中bucket的元数据被复制到了heap memory中，如果只修改了heap memory中相应的值，但没有修改当前bucket的B+Tree的结构，则事务提交调用`spill`方法时，会跳过该`Bucket`实例（详见[1.3.3节](#133-bucket中btree的rebalance与spill)中`spill`方法的实现）。因此，在修改`sequence`的值时，`SetSequence`和`NextSequence`方法还实例化了bucket中B+Tree的根node。这样，在调用`spill`时就不会跳过当前`Bucket`实例，更新才得以写入到存储中。

```go

// SetSequence updates the sequence number for the bucket.
func (b *Bucket) SetSequence(v uint64) error {
	if b.tx.db == nil {
		return ErrTxClosed
	} else if !b.Writable() {
		return ErrTxNotWritable
	}

	// Materialize the root node if it hasn't been already so that the
	// bucket will be saved during commit.
	if b.rootNode == nil {
		_ = b.node(b.root, nil)
	}

	// Increment and return the sequence.
	b.bucket.sequence = v
	return nil
}

// NextSequence returns an autoincrementing integer for the bucket.
func (b *Bucket) NextSequence() (uint64, error) {
	if b.tx.db == nil {
		return 0, ErrTxClosed
	} else if !b.Writable() {
		return 0, ErrTxNotWritable
	}

	// Materialize the root node if it hasn't been already so that the
	// bucket will be saved during commit.
	if b.rootNode == nil {
		_ = b.node(b.root, nil)
	}

	// Increment and return the sequence.
	b.bucket.sequence++
	return b.bucket.sequence, nil
}

```

#### 1.3.7 bucket的遍历

`Bucket`的遍历非常简单：

```go

// ForEach executes a function for each key/value pair in a bucket.
// If the provided function returns an error then the iteration is stopped and
// the error is returned to the caller. The provided function must not modify
// the bucket; this will result in undefined behavior.
func (b *Bucket) ForEach(fn func(k, v []byte) error) error {
	if b.tx.db == nil {
		return ErrTxClosed
	}
	c := b.Cursor()
	for k, v := c.First(); k != nil; k, v = c.Next() {
		if err := fn(k, v); err != nil {
			return err
		}
	}
	return nil
}

```

该方法首先获取了Cursor，并将其移动到B+Tree的第一个key/value处，然后在前进的同时对每个key/value执行传入的闭包，没有不再有后继key/value后停止。

## 2. cursor

游标cursor是boltdb中用来遍历B+Tree访问其中key/value的工具。由于boltdb的B+Tree叶子节点没有实现链指针，因此其cursor实现中通过栈记录了根节点到当前节点的路径，以便于访问前驱或后继key/value。

boltdb的cursor实现主要在`cursor.go`中，由`Cursor`结构体实现，本节将介绍其实现方式。

### 2.1 Cursor结构体

`Cursor`结构体中只有两个字段，其分别记录了`Cursor`所属的`Bucket`实例，与从根节点到当前key/value的路径。用于可以通过其`Bucket`方法获取其所属`Bucket`实例。

```go

// Cursor represents an iterator that can traverse over all key/value pairs in a bucket in sorted order.
// Cursors see nested buckets with value == nil.
// Cursors can be obtained from a transaction and are valid as long as the transaction is open.
//
// Keys and values returned from the cursor are only valid for the life of the transaction.
//
// Changing data while traversing with a cursor may cause it to be invalidated
// and return unexpected keys and/or values. You must reposition your cursor
// after mutating data.
type Cursor struct {
	bucket *Bucket
	stack  []elemRef
}

// Bucket returns the bucket that this cursor was created from.
func (c *Cursor) Bucket() *Bucket {
	return c.bucket
}

```

由于在不需要更新时，Cursor直接通过B+Tree节点的pgid访问mmap memory中的页，只有在需要更新时才会将其实例化为node。因此，在Cursor遍历节点的过程中，不同路径可能既有通过page表示的节点，也可能有通过node表示的节点。因此，`stack`字段记录的节点结构`elemRef`中有page指针`page`、node指针`node`、还有表示位于节点的第几个元素（element或inode）的索引`index`，在访问时，如果`node`为空，则通过`page`访问。

```go

// elemRef represents a reference to an element on a given page/node.
type elemRef struct {
	page  *page
	node  *node
	index int
}

// isLeaf returns whether the ref is pointing at a leaf page/node.
func (r *elemRef) isLeaf() bool {
	if r.node != nil {
		return r.node.isLeaf
	}
	return (r.page.flags & leafPageFlag) != 0
}

// count returns the number of inodes or page elements.
func (r *elemRef) count() int {
	if r.node != nil {
		return len(r.node.inodes)
	}
	return int(r.page.count)
}

```

`Cursor`的栈顶元素即为当前Cursor所在位置，`keyValue`方法是`Cursor`用来获取当前键值对的方法，其会根据当前节点是page还是node，通过不同方式获取键值对：

```go

// keyValue returns the key and value of the current leaf element.
func (c *Cursor) keyValue() ([]byte, []byte, uint32) {
	ref := &c.stack[len(c.stack)-1]
	if ref.count() == 0 || ref.index >= ref.count() {
		return nil, nil, 0
	}

	// Retrieve value from node.
	if ref.node != nil {
		inode := &ref.node.inodes[ref.index]
		return inode.key, inode.value, inode.flags
	}

	// Or retrieve value from page.
	elem := ref.page.leafPageElement(uint16(ref.index))
	return elem.key(), elem.value(), elem.flags
}

```

### 2.2 Cursor的方法与实现

`Cursor`结构体提供了移动到第一个或最后一个键值对、移动到前一个或后一个键值对、通过二分查找的方式移动到给定键位置、及删除当前位置的键值对的方法（用户不能指定插入位置，避免破坏B+Tree结构），本节，笔者将依次介绍这些方法的实现。

{{< admonition warning 注意 >}}

当事务删除了key但还未提交时，B+Tree中部分叶子节点可能没有内部元素。此时，应该跳过空节点。这一问题在[pull#452](https://github.com/boltdb/bolt/commit/852d3024fa8d89dcc9a715bab6f4dcd7d59577dd)中修复，其修复方式为在部分方法的实现最外成加入for循环，如果访问到空节点则进入下一次循环继续寻找，相关位置一般还有相应的注释“// If we land on an empty page then move to the next value. https://github.com/boltdb/bolt/issues/450”。后文分析源码中不再赘述。

{{< /admonition >}}

#### 2.2.1 First、Last、first、last

`First`方法与`Last`方法是将Cursor移动到第一个或最后一个键值对处的方法，二者实现方式相似，这里一同介绍。

```go

// First moves the cursor to the first item in the bucket and returns its key and value.
// If the bucket is empty then a nil key and value are returned.
// The returned key and value are only valid for the life of the transaction.
func (c *Cursor) First() (key []byte, value []byte) {
	_assert(c.bucket.tx.db != nil, "tx closed")
	c.stack = c.stack[:0]
	p, n := c.bucket.pageNode(c.bucket.root)
	c.stack = append(c.stack, elemRef{page: p, node: n, index: 0})
	c.first()

	// If we land on an empty page then move to the next value.
	// https://github.com/boltdb/bolt/issues/450
	if c.stack[len(c.stack)-1].count() == 0 {
		c.next()
	}

	k, v, flags := c.keyValue()
	if (flags & uint32(bucketLeafFlag)) != 0 {
		return k, nil
	}
	return k, v

}

// Last moves the cursor to the last item in the bucket and returns its key and value.
// If the bucket is empty then a nil key and value are returned.
// The returned key and value are only valid for the life of the transaction.
func (c *Cursor) Last() (key []byte, value []byte) {
	_assert(c.bucket.tx.db != nil, "tx closed")
	c.stack = c.stack[:0]
	p, n := c.bucket.pageNode(c.bucket.root)
	ref := elemRef{page: p, node: n}
	ref.index = ref.count() - 1
	c.stack = append(c.stack, ref)
	c.last()
	k, v, flags := c.keyValue()
	if (flags & uint32(bucketLeafFlag)) != 0 {
		return k, nil
	}
	return k, v
}

```

`First`与`Last`方法本身并没有移动Cursor的实现，其只获取了bucket中B+Tree的根节点（page或node），并将其加入到`stack`中。真正实现移动Cursor的是`first`与`last`方法（分开实现以便其它方法复用），`first`与`last`方法会以`stack`中栈顶节点作为根节点，将Cursor移动到其下第一个键值对位置。`First`方法与`Last`方法除了设置查找起点外，还会检查`first`方法与`last`方法返回的键值对是否表示bucket，如果是bucket，则将value置为nil返回。`first`与`last`的实现如下：

```go

// first moves the cursor to the first leaf element under the last page in the stack.
func (c *Cursor) first() {
	for {
		// Exit when we hit a leaf page.
		var ref = &c.stack[len(c.stack)-1]
		if ref.isLeaf() {
			break
		}

		// Keep adding pages pointing to the first element to the stack.
		var pgid pgid
		if ref.node != nil {
			pgid = ref.node.inodes[ref.index].pgid
		} else {
			pgid = ref.page.branchPageElement(uint16(ref.index)).pgid
		}
		p, n := c.bucket.pageNode(pgid)
		c.stack = append(c.stack, elemRef{page: p, node: n, index: 0})
	}
}

// last moves the cursor to the last leaf element under the last page in the stack.
func (c *Cursor) last() {
	for {
		// Exit when we hit a leaf page.
		ref := &c.stack[len(c.stack)-1]
		if ref.isLeaf() {
			break
		}

		// Keep adding pages pointing to the last element in the stack.
		var pgid pgid
		if ref.node != nil {
			pgid = ref.node.inodes[ref.index].pgid
		} else {
			pgid = ref.page.branchPageElement(uint16(ref.index)).pgid
		}
		p, n := c.bucket.pageNode(pgid)

		var nextRef = elemRef{page: p, node: n}
		nextRef.index = nextRef.count() - 1
		c.stack = append(c.stack, nextRef)
	}
}

```

`first`与`last`循环查找栈顶节点的第一个或最后一个孩子并将其压入栈中，直到栈顶节点为叶子节点。其实现方式也较为简单这里不再赘述。

#### 2.2.2 Next、Prev、next

`Next`方法与`Prev`方法是将Cursor移动到当前键值对的前驱或后继键值对的方法。由于遍历`Bucket`的`ForEach`方法依赖`Next`，而原`Next`方法可能存在[issue#450](https://github.com/boltdb/bolt/issues/450)中的问题，因此其又封装了`next`函数，并通过循环跳过空叶子节点。而`Prev`则不存在这一问题，因此没有封装`prev`方法。

```go

// Next moves the cursor to the next item in the bucket and returns its key and value.
// If the cursor is at the end of the bucket then a nil key and value are returned.
// The returned key and value are only valid for the life of the transaction.
func (c *Cursor) Next() (key []byte, value []byte) {
	_assert(c.bucket.tx.db != nil, "tx closed")
	k, v, flags := c.next()
	if (flags & uint32(bucketLeafFlag)) != 0 {
		return k, nil
	}
	return k, v
}

// next moves to the next leaf element and returns the key and value.
// If the cursor is at the last leaf element then it stays there and returns nil.
func (c *Cursor) next() (key []byte, value []byte, flags uint32) {
	for {
		// Attempt to move over one element until we're successful.
		// Move up the stack as we hit the end of each page in our stack.
		var i int
		for i = len(c.stack) - 1; i >= 0; i-- {
			elem := &c.stack[i]
			if elem.index < elem.count()-1 {
				elem.index++
				break
			}
		}

		// If we've hit the root page then stop and return. This will leave the
		// cursor on the last element of the last page.
		if i == -1 {
			return nil, nil, 0
		}

		// Otherwise start from where we left off in the stack and find the
		// first element of the first leaf page.
		c.stack = c.stack[:i+1]
		c.first()

		// If this is an empty page then restart and move back up the stack.
		// https://github.com/boltdb/bolt/issues/450
		if c.stack[len(c.stack)-1].count() == 0 {
			continue
		}

		return c.keyValue()
	}
}

// Prev moves the cursor to the previous item in the bucket and returns its key and value.
// If the cursor is at the beginning of the bucket then a nil key and value are returned.
// The returned key and value are only valid for the life of the transaction.
func (c *Cursor) Prev() (key []byte, value []byte) {
	_assert(c.bucket.tx.db != nil, "tx closed")

	// Attempt to move back one element until we're successful.
	// Move up the stack as we hit the beginning of each page in our stack.
	for i := len(c.stack) - 1; i >= 0; i-- {
		elem := &c.stack[i]
		if elem.index > 0 {
			elem.index--
			break
		}
		c.stack = c.stack[:i]
	}

	// If we've hit the end then return nil.
	if len(c.stack) == 0 {
		return nil, nil
	}

	// Move down the stack to find the last element of the last leaf under this branch.
	c.last()
	k, v, flags := c.keyValue()
	if (flags & uint32(bucketLeafFlag)) != 0 {
		return k, nil
	}
	return k, v
}

```

`Next`与`Prev`的实现思路类似，这里以`Prev`举例：
1. 循环遍历栈顶节点，如果在该节点中当前位置之前还有内部元素，则将栈顶元素修改为上一个元素；否则将栈顶元素出栈并继续判断，直到栈为空或找到上一个元素。
2. 如果栈为空，说明在B+Tree中不存在前驱键值对，直接返回空。
3. 如果栈非空，说明找到了前驱键值对所在位置，或前驱键值对所在的父级元素的位置。此时，直接调用`last`方法将Cursor移动到以当前栈顶为根的最后一个键值对，该键值对即为前驱键值对。
4. 检查该键值对是否表示bucket，如果表示bucket则将value置空。返回结果。

#### 2.2.3 Seek、seek、search

`Seek`方法是通过二分查找将Cursor移动到给定key的位置的方法，其实现如下：

```go

// Seek moves the cursor to a given key and returns it.
// If the key does not exist then the next key is used. If no keys
// follow, a nil key is returned.
// The returned key and value are only valid for the life of the transaction.
func (c *Cursor) Seek(seek []byte) (key []byte, value []byte) {
	k, v, flags := c.seek(seek)

	// If we ended up after the last element of a page then move to the next one.
	if ref := &c.stack[len(c.stack)-1]; ref.index >= ref.count() {
		k, v, flags = c.next()
	}

	if k == nil {
		return nil, nil
	} else if (flags & uint32(bucketLeafFlag)) != 0 {
		return k, nil
	}
	return k, v
}

```

`Seek`方法内部通过`seek`移动Cursor，`seek`方法会把Cursor移动到大于等于给定key的位置，即key不存在时会移动到下一个key的位置。如果`seek`将Cursor移动到了某节点的所有内部元素之后，`Seek`方法会使其正确移动到后继键值对处。同样`Seek`也会将表示bucket的value置空返回。接下分析`seek`方法的实现。

```go

// seek moves the cursor to a given key and returns it.
// If the key does not exist then the next key is used.
func (c *Cursor) seek(seek []byte) (key []byte, value []byte, flags uint32) {
	_assert(c.bucket.tx.db != nil, "tx closed")

	// Start from root page/node and traverse to correct page.
	c.stack = c.stack[:0]
	c.search(seek, c.bucket.root)
	ref := &c.stack[len(c.stack)-1]

	// If the cursor is pointing to the end of page/node then return nil.
	if ref.index >= ref.count() {
		return nil, nil, 0
	}

	// If this is a bucket then return a nil value.
	return c.keyValue()
}

```

`seek`方法首先将`stack`置空，然后从调用`search`方法，从根节点开始二分查找并移动Cursor，最后判断是否找到并返回结果。`search`方法是递归查找key并移动Cursor的方法，其实现如下：

```go

// search recursively performs a binary search against a given page/node until it finds a given key.
func (c *Cursor) search(key []byte, pgid pgid) {
	p, n := c.bucket.pageNode(pgid)
	if p != nil && (p.flags&(branchPageFlag|leafPageFlag)) == 0 {
		panic(fmt.Sprintf("invalid page type: %d: %x", p.id, p.flags))
	}
	e := elemRef{page: p, node: n}
	c.stack = append(c.stack, e)

	// If we're on a leaf page/node then find the specific node.
	if e.isLeaf() {
		c.nsearch(key)
		return
	}

	if n != nil {
		c.searchNode(key, n)
		return
	}
	c.searchPage(key, p)
}

func (c *Cursor) searchNode(key []byte, n *node) {
	var exact bool
	index := sort.Search(len(n.inodes), func(i int) bool {
		// TODO(benbjohnson): Optimize this range search. It's a bit hacky right now.
		// sort.Search() finds the lowest index where f() != -1 but we need the highest index.
		ret := bytes.Compare(n.inodes[i].key, key)
		if ret == 0 {
			exact = true
		}
		return ret != -1
	})
	if !exact && index > 0 {
		index--
	}
	c.stack[len(c.stack)-1].index = index

	// Recursively search to the next page.
	c.search(key, n.inodes[index].pgid)
}

func (c *Cursor) searchPage(key []byte, p *page) {
	// Binary search for the correct range.
	inodes := p.branchPageElements()

	var exact bool
	index := sort.Search(int(p.count), func(i int) bool {
		// TODO(benbjohnson): Optimize this range search. It's a bit hacky right now.
		// sort.Search() finds the lowest index where f() != -1 but we need the highest index.
		ret := bytes.Compare(inodes[i].key(), key)
		if ret == 0 {
			exact = true
		}
		return ret != -1
	})
	if !exact && index > 0 {
		index--
	}
	c.stack[len(c.stack)-1].index = index

	// Recursively search to the next page.
	c.search(key, inodes[index].pgid)
}

// nsearch searches the leaf node on the top of the stack for a key.
func (c *Cursor) nsearch(key []byte) {
	e := &c.stack[len(c.stack)-1]
	p, n := e.page, e.node

	// If we have a node then search its inodes.
	if n != nil {
		index := sort.Search(len(n.inodes), func(i int) bool {
			return bytes.Compare(n.inodes[i].key, key) != -1
		})
		e.index = index
		return
	}

	// If we have a page then search its leaf elements.
	inodes := p.leafPageElements()
	index := sort.Search(int(p.count), func(i int) bool {
		return bytes.Compare(inodes[i].key(), key) != -1
	})
	e.index = index
}

```

`search`方法首先将当前page或node记录在`stack`中，此时`index`取值还未确定，需要进一步搜索：
1. 如果当前节点是叶子节点，则调用`nsearch`方法，二分查找其内部元素，确定index值并返回。
2. 如果当前节点不是叶子节点，则递归调用`searchNode`或`searchPage`方法（取决于当前节点是否已被实例化为node），二分查找内部key，确定index值（下一个要查找的孩子）。

## 3. 总结

本文介绍了boltdb中bucket与cursor的概念与实现。

bucket与cursor是基于B+Tree的封装，且部分面向用户，虽然其实现并不复杂，但对于刚接触的读者可能较难理解。