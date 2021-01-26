---
title: "深入浅出boltdb —— 0x04 事务"
date: 2021-01-26T13:30:24+08:00
lastmod: 2021-01-26T13:30:27+08:00
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

boltdb是一个支持完整ACID事务的kv数据。虽然boltdb将“事务”封装成了`tx.go`中的`Tx`结构体，但boltdb中处处实现都与事务息息相关，`Tx`结构体只提供了事务的抽象。

因此本文将从整体的视角介绍事务与boltdb中事务的实现，并介绍`tx.go`与`db.go`中的源码。

## 1. 事务

### 1.1 事务的ACID性质

ACID性质（Atomicity原子性、Consistency一致性、Isolation隔离性、Durability持久性）的解释方式有很多，笔者比较倾向于[英文wiki](https://en.wikipedia.org/wiki/ACID)<sup>[引文1]</sup>和[IBM Knowledge Center - ACID properties of transactions](https://www.ibm.com/support/knowledgecenter/SSGMCP_5.4.0/product-overview/acid.html)<sup>[引文2]</sup>中的描述。

{{< admonition quote 引文1 >}}

**Atomicity :**

Transactions are often composed of multiple statements. Atomicity guarantees that each transaction is treated as a single "unit", which either succeeds completely, or fails completely: if any of the statements constituting a transaction fails to complete, the entire transaction fails and the database is left unchanged. An atomic system must guarantee atomicity in each and every situation, including power failures, errors and crashes. A guarantee of atomicity prevents updates to the database occurring only partially, which can cause greater problems than rejecting the whole series outright. As a consequence, the transaction cannot be observed to be in progress by another database client. At one moment in time, it has not yet happened, and at the next it has already occurred in whole (or nothing happened if the transaction was cancelled in progress).

**Consistency :**

Consistency ensures that a transaction can only bring the database from one valid state to another, maintaining database invariants: any data written to the database must be valid according to all defined rules, including constraints, cascades, triggers, and any combination thereof. This prevents database corruption by an illegal transaction, but does not guarantee that a transaction is correct. Referential integrity guarantees the primary key – foreign key relationship.

**Isolation :**

Transactions are often executed concurrently (e.g., multiple transactions reading and writing to a table at the same time). Isolation ensures that concurrent execution of transactions leaves the database in the same state that would have been obtained if the transactions were executed sequentially. Isolation is the main goal of concurrency control; depending on the method used, the effects of an incomplete transaction might not even be visible to other transactions.

**Durability :**

Durability guarantees that once a transaction has been committed, it will remain committed even in the case of a system failure (e.g., power outage or crash). This usually means that completed transactions (or their effects) are recorded in non-volatile memory.

{{< /admonition >}}


{{< admonition quote 引文2 >}}

**Atomicity :**

All changes to data are performed as if they are a single operation. That is, all the changes are performed, or none of them are.
For example, in an application that transfers funds from one account to another, the atomicity property ensures that, if a debit is made successfully from one account, the corresponding credit is made to the other account.

**Consistency :**

Data is in a consistent state when a transaction starts and when it ends.
For example, in an application that transfers funds from one account to another, the consistency property ensures that the total value of funds in both the accounts is the same at the start and end of each transaction.

**Isolation :**

The intermediate state of a transaction is invisible to other transactions. As a result, transactions that run concurrently appear to be serialized.
For example, in an application that transfers funds from one account to another, the isolation property ensures that another transaction sees the transferred funds in one account or the other, but not in both, nor in neither.

**Durability :**

After a transaction successfully completes, changes to data persist and are not undone, even in the event of a system failure.
For example, in an application that transfers funds from one account to another, the durability property ensures that the changes made to each account will not be reversed.

{{< /admonition >}}

关于ACID中的Isolation隔离性，可以分为多个隔离级别（Isolation levels）。关于隔离级别，笔者建议阅读[英文wiki](https://en.wikipedia.org/wiki/Isolation_(database_systems))提供的描述<sup>[引文3]</sup>。

{{< admonition quote 引文3 >}}

**Serializable**

This is the highest isolation level.

With a lock-based concurrency control DBMS implementation, serializability requires read and write locks (acquired on selected data) to be released at the end of the transaction. Also range-locks must be acquired when a SELECT query uses a ranged WHERE clause, especially to avoid the phantom reads phenomenon.

When using non-lock based concurrency control, no locks are acquired; however, if the system detects a write collision among several concurrent transactions, only one of them is allowed to commit. See snapshot isolation for more details on this topic.

**Repeatable reads**

In this isolation level, a lock-based concurrency control DBMS implementation keeps read and write locks (acquired on selected data) until the end of the transaction. However, range-locks are not managed, so phantom reads can occur.

Write skew is possible at this isolation level, a phenomenon where two writes are allowed to the same column(s) in a table by two different writers (who have previously read the columns they are updating), resulting in the column having data that is a mix of the two transactions.

**Read committed**

In this isolation level, a lock-based concurrency control DBMS implementation keeps write locks (acquired on selected data) until the end of the transaction, but read locks are released as soon as the SELECT operation is performed (so the non-repeatable reads phenomenon can occur in this isolation level). As in the previous level, range-locks are not managed.

Putting it in simpler words, read committed is an isolation level that guarantees that any data read is committed at the moment it is read. It simply restricts the reader from seeing any intermediate, uncommitted, 'dirty' read. It makes no promise whatsoever that if the transaction re-issues the read, it will find the same data; data is free to change after it is read.

**Read uncommitted**
This is the lowest isolation level. In this level, dirty reads are allowed, so one transaction may see not-yet-committed changes made by other transactions.

{{< /admonition >}}

不同隔离级别相应的问题可总结为下表：

| 隔离级别<br>（isolation level）<div style="width:12em"></div> | 脏读<br>（dirty reads）<div style="width:8em"></div>  | 不可重复读<br>（non-repeatable reads）<div style="width:14em"></div>  | 幻读<br>（phantom reads）<div style="width:10em"></div>  |
| :-: | :-: | :-: | :-: |
| 未提交读<br>（read uncommitted） | :warning: | :warning: | :warning: |
| 提交读<br>（read committed） | | :warning: | :warning: |
| 可重复读<br>（repeatable reads） | | | :warning: |
| 序列化读<br>（serializable） | | | |

### 1.2 boltdb中ACID的实现

在笔者看来，ACID性质的实现并不是相互孤立的，而是通过各种技术整体实现的。但是为了理解的清晰，这里简要划分一下boltdb中各种技术与ACID间的关系。

**Atomicity（原子性）：**

boltdb中事务的原子性是通过[Shadow Paging](https://en.wikipedia.org/wiki/Shadow_paging)实现的。当事务中的操作修改boltdb中的数据时，其不会直接修改数据库文件（mmap memory中的page），而是将更新内容写入到page buffer中。在事务提交时，会一并将这些page buffer中的dirty page写入到底层数据库文件，然后更新元数据将其指向新的页。因此，事务没有中间状态：要么全部写入，要么因回滚被丢弃。在元数据更新前，其指向的是事务执行前的旧page。因此，如果数据库在page buffer写入后且在元数据更新前故障，则数据仍保持在事务提交前的状态，而没有中间状态。

**Consistency（一致性）：**

数据库的“Consistency一致性”指事务前后的数据是否符合约束，有些资料也称其为“数据完整性”或“数据有效性”，论文《A relational model of data for large shared data banks》中有对其概念的形式化描述，感兴趣的读者可以看一下。

虽然boltdb不支持用户自定义约束，但笔者认为<sub>不保证正确性</sub>，boltdb中B+Tree结构也作为一种隐式约束。boltdb事务提交时，会通过`rebalance`与`spill`方法调整B+Tree结构，以使其满足B+Tree的性质。

有一种对ACID的解释为：Consistency是最终要实现的目标，而Atomicity、Isolation、Durability是实现Consistency的保证。笔者也比较认同这一观点，这也体现了ACID各个性质的实现不是孤立的，而是整个系统的结果。

**Isolation（隔离性）：**

上一节介绍了Isolation隔离性对应的4种隔离级别，boltdb实现的是最高的隔离界别：serializable序列化读。在serializable的基础上，boltdb支持“读读并发”与“读写并发”，boltdb中同时可以执行若干个只读事务，但同时只能执行一个读写事务，但只读事务与读写事务之间不影响。

Shadow Paging同样为实现事务隔离提供了支持。为了保证serializable的同时实现读写并发，当读写事务提交时，boltdb不会立即回收其不再使用的页（shadow page），这些页仍在freelist中该事务的`pending`列表中，因为此时这些页可能还在被未完成的只读事务读取。取而代之的是，boltdb会在事务开始时为其分配事务id`txid`，只读事务的`txid`为当前数据库的`txid`，读写事务的`txid`为当前数据库的`txid + 1`。boltdb会记录正在执行的事务的事务id；当事务提交时，boltdb会找到进行中的最小的`txid`，显然，该`txid`之前的只读事务或读写事务都已经完成，因此其中读写事务的shadow page不再需要被读取，此时可以安全地释放这些读写事务的shadow page，即可以freelist中该事务的`pending`列表中的页合并到freelist的`ids`中。

Shadow Paging保证了读读并发、读写并发的事务隔离性，boltdb还需要保证最多只有1个读写事务在进行。boltdb的读写事务开始前会申请互斥锁，以避免读写事务并行执行。这里需要注意两点：第一，因为boltdb支持读写并发，所以只读事务不需要申请S锁，否则只有读读事务才能并行执行；第二，在数据库领域，这种锁机制应叫做“latch”而非“lock”，只是其粒度较大。CMU 15-721中较为详细地介绍了Lock与Latch的区别，这里笔者搬运一下其总结表格。

| <div style="width:6em"></div> | Locks<div style="width:10em"></div> | Latches<div style="width:10em"></div> |
| :-: | :-: | :-: |
| Separate ... | User transactions | Threads |
| Proetect ... | Database contents | In-memory data structures |
| During ... | Entire transactions | Critical sections |
| Modes ... | Shared, exclusive, update, intention, escrow, schema, etc. | Read, writes, (perhaps) update |
| Deadlock ... | Detection & resolution | Avoidance |
| ... by ... | Aanlysis of the waits-for graph, timeout, transaction abort, partial rollback, lock de-escalation | Coding discipline, "lock leveling" |
| Kept in ... | Lock manager's hash table | Protected data structure |

**Durability（持久性）：**

boltdb的读写事务提交时，会通过pwrite系统调用写底层文件，并通过fdatasync系统调用确保数据被安全写入到磁盘中。因为boltdb的mmap模式为`MAP_SHARED`，因此绕过mmap直接写入底层文件不会影响mmap中数据对底层文件修改的可见性。

# 施工中 。。。 。。。

## 2. Tx

`tx.go`中的`Tx`结构体，是boltdb事务的封装。本节将分析其实现。

### 2.1 Tx结构体

`Tx`结构体的源码如下：

```go

// txid represents the internal transaction identifier.
type txid uint64

// Tx represents a read-only or read/write transaction on the database.
// Read-only transactions can be used for retrieving values for keys and creating cursors.
// Read/write transactions can create and remove buckets and create and remove keys.
//
// IMPORTANT: You must commit or rollback transactions when you are done with
// them. Pages can not be reclaimed by the writer until no more transactions
// are using them. A long running read transaction can cause the database to
// quickly grow.
type Tx struct {
	writable       bool
	managed        bool
	db             *DB
	meta           *meta
	root           Bucket
	pages          map[pgid]*page
	stats          TxStats
	commitHandlers []func()

	// WriteFlag specifies the flag for write-related methods like WriteTo().
	// Tx opens the database file with the specified flag to copy the data.
	//
	// By default, the flag is unset, which works well for mostly in-memory
	// workloads. For databases that are much larger than available RAM,
	// set the flag to syscall.O_DIRECT to avoid trashing the page cache.
	WriteFlag int
}

```

| 字段<div style="width:12em"></div> | 描述 |
| :-: | :- |
| `writable bool` | true表示当前事务为读写事务，false表示当前事务为只读事务。 |
| `managed bool` | 标识当前事务是否为隐式事务，隐式事务由boltdb自动提交或回滚，用户不能主动提交或回滚。 |
| `db *DB` | 创建该事务的数据库对象。 |
| `meta *meta` | 当前事务创建时的`meta`拷贝。 |
| `root Bucket` | 当前事务所见的root bucket的`Bucket`实例。 |
| `page map[pgid]*page` | 索引当前事务所使用的dirty page（page buffer）。 |
| `stats TxStats` | 统计变量。 |
| `commitHandlers []func()` | 事务成功提交后需调用的回调函数列表。 |
| `WriteFlag int` | `WriteTo`方法reader打开文件时可配置的额外的flag。 |

`Tx`为boltdb的用户提供了一些方法来访问其中部分字段：

| 方法<div style="width:12em"></div> | 描述 |
| :-: | :- |
| `ID() int` | 返回当前事务id（`tx.meta.txid`）。 |
| `DB *DB` | 返回创建当前事务的数据库实例。 |
| `Size() int64` | 返回当前事务所见的数据库大小（非数据大小）。 |
| `Writable() bool` | 返回当前事务事务可写。 |
| `Stats() TxStats` | 返回当前事务的统计量。 |

此外，`Tx`还为boltdb的用户提供了一些访问root bucket的方法：

| 方法<div style="width:12em"></div> | 描述 |
| :-: | :- |
| `Cursor() *Cursor` | `tx.root.Cursor()`。从当前事务获取root bucket的`Cursor`。由于root bucket中只保存子bucket，因此其返回的所有value都是nil。 |
| `Bucket(name []byte) *Bucket` | `tx.root.Bucket(name)`。获取root bucket的子bucket。 |
| `CreateBucket(name []byte) (*Bucket, error)` | `tx.root.CreateBucket(name)` | 创建root bucket的子bucket。 |
| `CreateBucketIfNotExists(name []byte) (*Bucket, error)` | `tx.root.CreateBucketIfNotExists(name)`。如果root bucket的子bucket未创建，则创建子bucket并返回实例；否则直接返回其实例。 |
| `DeleteBucket(name []byte) error` | `tx.root.DeleteBucket(name)`。删除root bucket的子bucket。 |
| `ForEach(fn func(name []byte, b *Bucket) error) error` | 遍历root bucket的所有子bucket并执行给定闭包。 |

### 2.2 Tx的声明周期

本节将以`Tx`结构体的声明周期的顺序介绍其中方法的实现。

#### 2.2.1 事务的创建

boltdb在创建事务时，会先创建`Tx`实例，设置其`writable`字段，并调用其`init`方法。`init`方法的实现如下所示。

```go

// init initializes the transaction.
func (tx *Tx) init(db *DB) {
	tx.db = db
	tx.pages = nil

	// Copy the meta page since it can be changed by the writer.
	tx.meta = &meta{}
	db.meta().copy(tx.meta)

	// Copy over the root bucket.
	tx.root = newBucket(tx)
	tx.root.bucket = &bucket{}
	*tx.root.bucket = tx.meta.root

	// Increment the transaction id and add a page cache for writable transactions.
	if tx.writable {
		tx.pages = make(map[pgid]*page)
		tx.meta.txid += txid(1)
	}
}

```

`init`方法初始化了`Tx`的一些字段。因为boltdb支持事务读写并发，所以其深拷贝了事务创建时的`meta`数据与root bucket的元数据，以避免只读事务读取到后续读写事务更新过的元数据。

`init`方法还为读写事务初始化了`pages`字段，该字段是用来记录事务写入的dirty page（page buffer）的cache。此外，`init`在初始化读写事务时还会将其`meta`中的`txid + 1`。

#### 2.2.2 事务的提交

boltdb的用户可以通过`Tx`的`Commit`方法提交非隐式事务。在提交前，用户还可以通过`OnCommit`方法注册事务的回调方法。`OnCommit`与`Commit`方法的实现如下：

```go

// OnCommit adds a handler function to be executed after the transaction successfully commits.
func (tx *Tx) OnCommit(fn func()) {
	tx.commitHandlers = append(tx.commitHandlers, fn)
}

// Commit writes all changes to disk and updates the meta page.
// Returns an error if a disk write error occurs, or if Commit is
// called on a read-only transaction.
func (tx *Tx) Commit() error {
	_assert(!tx.managed, "managed tx commit not allowed")
	if tx.db == nil {
		return ErrTxClosed
	} else if !tx.writable {
		return ErrTxNotWritable
	}

	// TODO(benbjohnson): Use vectorized I/O to write out dirty pages.

	// Rebalance nodes which have had deletions.
	var startTime = time.Now()
	tx.root.rebalance()
	if tx.stats.Rebalance > 0 {
		tx.stats.RebalanceTime += time.Since(startTime)
	}

	// spill data onto dirty pages.
	startTime = time.Now()
	if err := tx.root.spill(); err != nil {
		tx.rollback()
		return err
	}
	tx.stats.SpillTime += time.Since(startTime)

	// Free the old root bucket.
	tx.meta.root.root = tx.root.root

	opgid := tx.meta.pgid

	// Free the freelist and allocate new pages for it. This will overestimate
	// the size of the freelist but not underestimate the size (which would be bad).
	tx.db.freelist.free(tx.meta.txid, tx.db.page(tx.meta.freelist))
	p, err := tx.allocate((tx.db.freelist.size() / tx.db.pageSize) + 1)
	if err != nil {
		tx.rollback()
		return err
	}
	if err := tx.db.freelist.write(p); err != nil {
		tx.rollback()
		return err
	}
	tx.meta.freelist = p.id

	// If the high water mark has moved up then attempt to grow the database.
	if tx.meta.pgid > opgid {
		if err := tx.db.grow(int(tx.meta.pgid+1) * tx.db.pageSize); err != nil {
			tx.rollback()
			return err
		}
	}

	// Write dirty pages to disk.
	startTime = time.Now()
	if err := tx.write(); err != nil {
		tx.rollback()
		return err
	}

	// If strict mode is enabled then perform a consistency check.
	// Only the first consistency error is reported in the panic.
	if tx.db.StrictMode {
		ch := tx.Check()
		var errs []string
		for {
			err, ok := <-ch
			if !ok {
				break
			}
			errs = append(errs, err.Error())
		}
		if len(errs) > 0 {
			panic("check fail: " + strings.Join(errs, "\n"))
		}
	}

	// Write meta to disk.
	if err := tx.writeMeta(); err != nil {
		tx.rollback()
		return err
	}
	tx.stats.WriteTime += time.Since(startTime)

	// Finalize the transaction.
	tx.close()

	// Execute commit handlers now that the locks have been removed.
	for _, fn := range tx.commitHandlers {
		fn()
	}

	return nil
}

```

#### 2.2.3 事务的回滚

