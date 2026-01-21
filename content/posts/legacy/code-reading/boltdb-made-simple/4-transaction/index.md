---
title: "(Chinese) 深入浅出 boltdb —— 0x04 事务"
date: "2021-01-26"
summary: "深入浅出 boltdb —— 0x04 事务"
categories: ["深入浅出 boltdb"]
tags: ["boltdb", "B+tree"]
draft: false
---

![featured image](index.jpg)

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

## 0. 引言

boltdb是一个支持完整ACID事务的kv数据。虽然boltdb将“事务”封装成了`tx.go`中的`Tx`结构体，但boltdb中处处实现都与事务息息相关，`Tx`结构体只提供了事务的抽象。

因此本文将从整体的视角介绍事务与boltdb中事务的实现，并介绍`tx.go`与`db.go`中的源码。

## 1. 事务

### 1.1 事务的ACID性质

ACID性质（Atomicity原子性、Consistency一致性、Isolation隔离性、Durability持久性）的解释方式有很多，笔者比较倾向于[英文wiki](https://en.wikipedia.org/wiki/ACID)<sup>[引文1]</sup>和[IBM Knowledge Center - ACID properties of transactions](https://www.ibm.com/support/knowledgecenter/SSGMCP_5.4.0/product-overview/acid.html)<sup>[引文2]</sup>中的描述。

> 引文 1：
>
> **Atomicity :**
>
> Transactions are often composed of multiple statements. Atomicity guarantees that each transaction is treated as a single "unit", which either succeeds completely, or fails completely: if any of the statements constituting a transaction fails to complete, the entire transaction fails and the database is left unchanged. An atomic system must guarantee atomicity in each and every situation, including power failures, errors and crashes. A guarantee of atomicity prevents updates to the database occurring only partially, which can cause greater problems than rejecting the whole series outright. As a consequence, the transaction cannot be observed to be in progress by another database client. At one moment in time, it has not yet happened, and at the next it has already occurred in whole (or nothing happened if the transaction was cancelled in progress).
> 
> **Consistency :**
> 
> Consistency ensures that a transaction can only bring the database from one valid state to another, maintaining database invariants: any data written to the database must be valid according to all defined rules, including constraints, cascades, triggers, and any combination thereof. This prevents database corruption by an illegal transaction, but does not guarantee that a transaction is correct. Referential integrity guarantees the primary key – foreign key relationship.
> 
> **Isolation :**
>
> Transactions are often executed concurrently (e.g., multiple transactions reading and writing to a table at the same time). Isolation ensures that concurrent execution of transactions leaves the database in the same state that would have been obtained if the transactions were executed sequentially. Isolation is the main goal of concurrency control; depending on the method used, the effects of an incomplete transaction might not even be visible to other transactions.
>
> **Durability :**
>
> Durability guarantees that once a transaction has been committed, it will remain committed even in the case of a system failure (e.g., power outage or crash). This usually means that completed transactions (or their effects) are recorded in non-volatile memory.


> 引文 2：
>
>**Atomicity :**
> 
> All changes to data are performed as if they are a single operation. That is, all the changes are performed, or none of them are.
> For example, in an application that transfers funds from one account to another, the atomicity property ensures that, if a debit is made successfully from one account, the corresponding credit is made to the other account.
> 
> **Consistency :**
> 
> Data is in a consistent state when a transaction starts and when it ends.
> For example, in an application that transfers funds from one account to another, the consistency property ensures that the total value of funds in both the accounts is the same at the start and end of each transaction.
> 
> **Isolation :**
> 
> The intermediate state of a transaction is invisible to other transactions. As a result, transactions that run concurrently appear to be serialized.
> For example, in an application that transfers funds from one account to another, the isolation property ensures that another transaction sees the transferred funds in one account or the other, but not in both, nor in neither.
> 
> **Durability :**
> 
> After a transaction successfully completes, changes to data persist and are not undone, even in the event of a system failure.
> For example, in an application that transfers funds from one account to another, the durability property ensures that the changes made to each account will not be reversed.

关于ACID中的Isolation隔离性，可以分为多个隔离级别（Isolation levels）。关于隔离级别，笔者建议阅读[英文wiki](https://en.wikipedia.org/wiki/Isolation_(database_systems))提供的描述<sup>[引文3]</sup>。

> 引文 3：
> 
> **Serializable**
> 
> This is the highest isolation level.
> 
> With a lock-based concurrency control DBMS implementation, serializability requires read and write locks (acquired on selected data) to be released at the end of the transaction. Also range-locks must be acquired when a SELECT query uses a ranged WHERE clause, especially to avoid the phantom reads phenomenon.
> 
> When using non-lock based concurrency control, no locks are acquired; however, if the system detects a write collision among several concurrent transactions, only one of them is allowed to commit. See snapshot isolation for more details on this topic.
> 
> **Repeatable reads**
> 
> In this isolation level, a lock-based concurrency control DBMS implementation keeps read and write locks (acquired on selected data) until the end of the transaction. However, range-locks are not managed, so phantom reads can occur.
> 
> Write skew is possible at this isolation level, a phenomenon where two writes are allowed to the same column(s) in a table by two different writers (who have previously read the columns they are updating), resulting in the column having data that is a mix of the two transactions.
> 
> **Read committed**
> 
> In this isolation level, a lock-based concurrency control DBMS implementation keeps write locks (acquired on selected data) until the end of the transaction, but read locks are released as soon as the SELECT operation is performed (so the non-repeatable reads phenomenon can occur in this isolation level). As in the previous level, range-locks are not managed.
> 
> Putting it in simpler words, read committed is an isolation level that guarantees that any data read is committed at the moment it is read. It simply restricts the reader from seeing any intermediate, uncommitted, 'dirty' read. It makes no promise whatsoever that if the transaction re-issues the read, it will find the same data; data is free to change after it is read.
> 
> **Read uncommitted**
> This is the lowest isolation level. In this level, dirty reads are allowed, so one transaction may see not-yet-committed changes made by other transactions.

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

Shadow Paging同样为实现事务隔离提供了支持。为了保证serializable的同时实现读写并发，当读写事务提交时，boltdb不会立即回收其不再使用的页（shadow page），这些页仍在freelist中该事务的`pending`列表中，因为此时这些页可能还在被未完成的只读事务读取。取而代之的是，boltdb会在事务开始时为其分配事务id`txid`，只读事务的`txid`为当前数据库的`txid`，读写事务的`txid`为当前数据库的`txid + 1`。boltdb会记录正在执行的事务的事务id；当创建读写事务时，boltdb会从只读事务中找到进行中的最小的`txid`，显然，该`txid`之前的读写事务的shadow page不再需要被读取，此时可以安全地释放这些读写事务的shadow page，即可以freelist中该事务的`pending`列表中的页合并到freelist的`ids`中。

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

## 2. boltdb中事务的封装与实现

boltdb将事务封装成了`tx.go`中的`Tx`结构体。但只从`Tx`结构体分析boltdb中事务的封装与实现是不够的。因此，本节将先介绍`Tx`结构体的基本实现，然后按照事务的生命周期的顺序，介绍boltdb中`tx.go`与`db.go`中对事务的封装与实现。

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

### 2.2 事务的生命周期

本节将按照事务的生命周期，介绍并分析boltdb中事务的封装与实现。

在介绍事务的生命周期前，先简单介绍一下boltdb的`DB`中三把重要的锁：

| 字段<div style="width:10em"></div> | 描述 |
| :-: | :- |
| `rwlock sync.Mutex` | 用来隔离可写事务的互斥锁（注意，不是读写锁）。 |
| `metalock sync.Mutex` | 用来保护元数据访问的互斥锁。 |
| `mmaplock sync.RWMutex` | 用来保护mmap操作的读写锁。 |

boltdb支持“读读并发”与“读写并发”，用来隔离事务的锁`rwlock`是互斥锁，只有可写事务需要获取该锁，只读事务不受影响。由于事务开始时，需要复制当时的元数据，因此这里使用了互斥锁`metalock`来保护事务开始时的元数据访问，当事务初始化完成后就会释放`metalock`；另外，只读事务关闭时也需要获取`metalock`，但其目的是保护对`DB`对象的访问，而不时保护`meta`。而`mmaplock`是用来保护mmap操作的读写锁，只读事务会获取`mmaplock`的S锁，而mmap操作会获取`mmaplock`的X锁。这样，当可写事务需要更大的mmap空间时，其需要等待之前的只读事务都执行完毕，以避免只读事务引用的mmap地址失效；对于可写事务本身，其在mmap前会从根`Bucket`实例开始`dereference`操作，以避免可写事务本身引用了旧的mmap地址空间。

这三种锁的获取顺序是：（`rwlock`） $\rightarrow$ `metalock` $\rightarrow$ （`mmaplock`）。

此外，boltdb中还有两把锁。其一是读写锁`statlock sync.RWMutex`，其作用是保护统计量的访问，这里不作重点介绍；其二是互斥锁`batchMu`，该锁用来保护数据库实例的`batch`字段，作用较为单一，本文在[2.3.2节](#232-批处理隐式读写事务)介绍。

#### 2.2.1 事务开始

boltdb的用户可以通过`DB`的`Begin`方法启动一个事务，通过`Begin`方法启动的事务需要用户自己控制其提交或回滚（用户还可以通过`Update`或`View`方法启动隐式事务，但二者都是对`Begin`的封装，因此放在最后介绍）。

`Begin`方法的实现如下：

```go

// Begin starts a new transaction.
// Multiple read-only transactions can be used concurrently but only one
// write transaction can be used at a time. Starting multiple write transactions
// will cause the calls to block and be serialized until the current write
// transaction finishes.
//
// Transactions should not be dependent on one another. Opening a read
// transaction and a write transaction in the same goroutine can cause the
// writer to deadlock because the database periodically needs to re-mmap itself
// as it grows and it cannot do that while a read transaction is open.
//
// If a long running read transaction (for example, a snapshot transaction) is
// needed, you might want to set DB.InitialMmapSize to a large enough value
// to avoid potential blocking of write transaction.
//
// IMPORTANT: You must close read-only transactions after you are finished or
// else the database will not reclaim old pages.
func (db *DB) Begin(writable bool) (*Tx, error) {
	if writable {
		return db.beginRWTx()
	}
	return db.beginTx()
}

```

`Begin`方法会根据事务是否可写，调用`beginRWTx`方法或`beginTx`方法。

接下来首先分析启动只读事务`beginTx`方法的实现：

```go

func (db *DB) beginTx() (*Tx, error) {
	// Lock the meta pages while we initialize the transaction. We obtain
	// the meta lock before the mmap lock because that's the order that the
	// write transaction will obtain them.
	db.metalock.Lock()

	// Obtain a read-only lock on the mmap. When the mmap is remapped it will
	// obtain a write lock so all transactions must finish before it can be
	// remapped.
	db.mmaplock.RLock()

	// Exit if the database is not open yet.
	if !db.opened {
		db.mmaplock.RUnlock()
		db.metalock.Unlock()
		return nil, ErrDatabaseNotOpen
	}

	// Create a transaction associated with the database.
	t := &Tx{}
	t.init(db)

	// Keep track of transaction until it closes.
	db.txs = append(db.txs, t)
	n := len(db.txs)

	// Unlock the meta pages.
	db.metalock.Unlock()

	// Update the transaction stats.
	db.statlock.Lock()
	db.stats.TxN++
	db.stats.OpenTxN = n
	db.statlock.Unlock()

	return t, nil
}

```

`beginTx`方法执行了如下操作：
1. 获取`metalock`锁与`mmaplock`的S锁。
2. 检测数据库是否打开，如果没打开则释放锁并返回错误。
3. 创建`writable`为false的`Tx`对象，调用`init`方法初始化`Tx`对象（`Tx`对象初始化时会复制当前的`meta`）。
4. 将事务保存到`DB`的`txs`字段中。
5. 释放`metalock`。
6. 更新统计量，返回事务对象`Tx`。

`beginRWTx`方法实现与之相似：

```go

func (db *DB) beginRWTx() (*Tx, error) {
	// If the database was opened with Options.ReadOnly, return an error.
	if db.readOnly {
		return nil, ErrDatabaseReadOnly
	}

	// Obtain writer lock. This is released by the transaction when it closes.
	// This enforces only one writer transaction at a time.
	db.rwlock.Lock()

	// Once we have the writer lock then we can lock the meta pages so that
	// we can set up the transaction.
	db.metalock.Lock()
	defer db.metalock.Unlock()

	// Exit if the database is not open yet.
	if !db.opened {
		db.rwlock.Unlock()
		return nil, ErrDatabaseNotOpen
	}

	// Create a transaction associated with the database.
	t := &Tx{writable: true}
	t.init(db)
	db.rwtx = t

	// Free any pages associated with closed read-only transactions.
	var minid txid = 0xFFFFFFFFFFFFFFFF
	for _, t := range db.txs {
		if t.meta.txid < minid {
			minid = t.meta.txid
		}
	}
	if minid > 0 {
		db.freelist.release(minid - 1)
	}

	return t, nil
}

```

`beginRWTx`方法执行了如下操作：
1. 若事务为只读事务，返回错误。
2. 获取`rwlock`锁与`metalock`锁，并通过`defer`关键字确保`metalock`会在函数返回前被安全释放。
3. 检测数据库是否打开，如果没打开则释放锁并返回错误。
4. 创建`writable`为true的`Tx`对象，调用`init`方法初始化`Tx`对象（`Tx`对象初始化时会复制当前的`meta`），并更新`DB`的`rwtx`字段为当前`Tx`对象。
5. 释放不再使用的shadow page。

boltdb释放不再使用的shadow page的方法是：找到当前还在执行的读写事务中最小的`txid`，记为`minid`。显然，在该`minid`之前的读写事务产生的shadow page不再会被读取，此时，通过`freelist`的`release`方法释放`txid`不超过`minid-1`的事务产生的shadow page。

接下来分析初始化`Tx`对象时调用的`init`方法：

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

#### 2.2.2 事务提交

boltdb的用户可以通过`Tx`的`Commit`方法提交非隐式事务；而隐式事务的提交则由boltdb调用该方法实现（在调用前会将其`managed`字段置为false以避免返回错误）。在提交前，用户还可以通过`OnCommit`方法注册事务的回调方法。

本节将介绍事务提交的实现。

##### 2.2.2.1 Commit方法

事务提交方法`Commit`与注册成功提交回调的方法`OnCommit`的实现如下：

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

`Commit`方法可分为如下几个步骤：
1. 检查当前事务是否为隐式事务、是否已关闭、是为非读写事务，如果不是，则返回错误（隐式事务提交会引起panic）。
2. 从root bucket开始执行`rebalance`操作与`spill`操作以调整B+Tree结构，并统计各自所用时间。
3. 将当前事务`meta`中root bucket的pgid指向copy-on-write后新的root bucket。
4. 释放旧freelist所在page，并为其分配新page，将其写入相应的page buffer中。
5. 检查当前已使用的空间大小是否超过了底层数据库文件大小，如果超过了该大小需要通过`grow`方法增大数据库文件大小（详见下文说明）。
6. 调用`Tx`的`write`方法，通过pwrite+fdatasync系统调用将dirty page写入的层文件，同时统计其耗时。
7. 如果数据库处于严格模式`StructMode`，调用`Tx`的`Check`方法对数据库进行完整性检查。
8. 调用`Tx`的`writeMeta`方法，通过pwrite+fdatasync系统调用将meta page写入的层文件。写入时根据事务`txid`交替写入meta page 0 或 1,。
9. 调用`close`方法关闭事务。
10. 一次调用之前通过`OnCommit`方法注册的回调函数。
11. 如果步骤4~8出错，则通过`rollback`方法回滚事务。

在`Commit`方法中，有一些地方需要注意，接下来笔者将依次对其进行介绍与分析（事务关闭方法在[2.2.4节](#224-事务关闭)中介绍）。

##### 2.2.2.2 grow方法

第5步中的`grow`方法，是用来增长底层数据库文件大小的方法。在本系列的前文[深入浅出 boltdb —— 0x01 存储与缓存](/posts/code-reading/boltdb-made-simple/1-storage-cache/)中，笔者描述boltdb的mmap增长逻辑时埋下了一个伏笔：boltdb的mmap的增长策略是从32KB开始，每次倍增，在达到1GB后每次增长1GB；但是boltdb并不会在mmap的同时修改底层数据库文件大小。这样的问题是：当访问超出了文件大小的mmap空间时，会引起`SIGBUS`异常。为了避免访问越界，同时减少不必要的底层数据库文件增长，boltdb采用了在事务提交时按需增长的策略。

boltdb的实现方式是：在为事务分配完所需的页之后、在写入脏页前，先计算其使用了的空间大小（包括freelist中的页），即`int(tx.meta.pgid+1) * tx.db.pageSize`。之后调用`DB`的`grow`方法来按需增大底层数据库文件大小。其实现如下：

```go

// grow grows the size of the database to the given sz.
func (db *DB) grow(sz int) error {
	// Ignore if the new size is less than available file size.
	if sz <= db.filesz {
		return nil
	}

	// If the data is smaller than the alloc size then only allocate what's needed.
	// Once it goes over the allocation size then allocate in chunks.
	if db.datasz < db.AllocSize {
		sz = db.datasz
	} else {
		sz += db.AllocSize
	}

	// Truncate and fsync to ensure file size metadata is flushed.
	// https://github.com/boltdb/bolt/issues/284
	if !db.NoGrowSync && !db.readOnly {
		if runtime.GOOS != "windows" {
			if err := db.file.Truncate(int64(sz)); err != nil {
				return fmt.Errorf("file resize error: %s", err)
			}
		}
		if err := db.file.Sync(); err != nil {
			return fmt.Errorf("file sync error: %s", err)
		}
	}

	db.filesz = sz
	return nil
}

```

`grow`方法会判断传入的所需文件大小，如果不需要增长底层文件大小则直接返回。同时，`grow`方法会检查当前mmap大小是否超过了门限`AllocSize`，在mmap大小达到该门限之前`grow`方法会按需增长数据库文件大小，在达到该门限后每次让数据库文件增大`AllocSize`。随后，`grow`方法会根据配置与系统来增长底层文件大小。其中需要注意两点：Windows支持mmap时自动扩展文件大小，而Linux不支持；ext3/ext4文件系统需要通过`fsync`方法强制同步元数据。这里笔者给出与`grow`相关的几个主要记录，以便读者参考：[issue#284](https://github.com/boltdb/bolt/issues/284)、[pull#286](https://github.com/boltdb/bolt/pull/286)、[pull#453](https://github.com/boltdb/bolt/pull/453)。

##### 2.2.2.3 write、writeMeta

`Tx`的`write`方法是将脏页写入到底层数据库文件的方法，其通过pwrite与fdatasync系统调用保证数据安全地写入磁盘。

```go

// write writes any dirty pages to disk.
func (tx *Tx) write() error {
	// Sort pages by id.
	pages := make(pages, 0, len(tx.pages))
	for _, p := range tx.pages {
		pages = append(pages, p)
	}
	// Clear out page cache early.
	tx.pages = make(map[pgid]*page)
	sort.Sort(pages)

	// Write pages to disk in order.
	for _, p := range pages {
		size := (int(p.overflow) + 1) * tx.db.pageSize
		offset := int64(p.id) * int64(tx.db.pageSize)

		// Write out page in "max allocation" sized chunks.
		ptr := (*[maxAllocSize]byte)(unsafe.Pointer(p))
		for {
			// Limit our write to our max allocation size.
			sz := size
			if sz > maxAllocSize-1 {
				sz = maxAllocSize - 1
			}

			// Write chunk to disk.
			buf := ptr[:sz]
			if _, err := tx.db.ops.writeAt(buf, offset); err != nil {
				return err
			}

			// Update statistics.
			tx.stats.Write++

			// Exit inner for loop if we've written all the chunks.
			size -= sz
			if size == 0 {
				break
			}

			// Otherwise move offset forward and move pointer to next chunk.
			offset += int64(sz)
			ptr = (*[maxAllocSize]byte)(unsafe.Pointer(&ptr[sz]))
		}
	}

	// Ignore file sync if flag is set on DB.
	if !tx.db.NoSync || IgnoreNoSync {
		if err := fdatasync(tx.db); err != nil {
			return err
		}
	}

	// Put small pages back to page pool.
	for _, p := range pages {
		// Ignore page sizes over 1 page.
		// These are allocated using make() instead of the page pool.
		if int(p.overflow) != 0 {
			continue
		}

		buf := (*[maxAllocSize]byte)(unsafe.Pointer(p))[:tx.db.pageSize]

		// See https://go.googlesource.com/go/+/f03c9202c43e0abb130669852082117ca50aa9b1
		for i := range buf {
			buf[i] = 0
		}
		tx.db.pagePool.Put(buf)
	}

	return nil
}

```

从源码可知，`write`方法会将`tx.pages`中记录的脏页，有序地写入到底层文件。其默认的写入方法为go的`os.File.WriteAt`方法，其内部通过pwrite系统调用实现，同时，每次写入大小不超过`maxAllocSize`。在写入后，如果数据库没有启用`NoSync`参数或`IgnoreNoSync`为真（该参数在OpenBSD系统上为真，原因详见该参数注释）时，会通过fdatasync系统调用确保数据安全地写入到磁盘。最后，该方法会把分配的单页大小的page buffer放回pagePool中（详见[《深入浅出 boltdb —— 0x01 存储与缓存》3.2.1 page buffer（memory->memory）](/posts/code-reading/boltdb-made-simple/1-storage-cache/#321-page-buffermemory-memory)）。

而对于用来更新元数据的`writeMeta`方法也是如此：

```go

// writeMeta writes the meta to the disk.
func (tx *Tx) writeMeta() error {
	// Create a temporary buffer for the meta page.
	buf := make([]byte, tx.db.pageSize)
	p := tx.db.pageInBuffer(buf, 0)
	tx.meta.write(p)

	// Write the meta page to file.
	if _, err := tx.db.ops.writeAt(buf, int64(p.id)*int64(tx.db.pageSize)); err != nil {
		return err
	}
	if !tx.db.NoSync || IgnoreNoSync {
		if err := fdatasync(tx.db); err != nil {
			return err
		}
	}

	// Update statistics.
	tx.stats.Write++

	return nil
}

// write writes the meta onto a page.
func (m *meta) write(p *page) {
	if m.root.root >= m.pgid {
		panic(fmt.Sprintf("root bucket pgid (%d) above high water mark (%d)", m.root.root, m.pgid))
	} else if m.freelist >= m.pgid {
		panic(fmt.Sprintf("freelist pgid (%d) above high water mark (%d)", m.freelist, m.pgid))
	}

	// Page id is either going to be 0 or 1 which we can determine by the transaction ID.
	p.id = pgid(m.txid % 2)
	p.flags |= metaPageFlag

	// Calculate the checksum.
	m.checksum = m.sum64()

	m.copy(p.meta())
}

// copy copies one meta object to another.
func (m *meta) copy(dest *meta) {
	*dest = *m
}

```

`writeMeta`方法同样通过pwrite+fdatasync的方式确保元数据被安全地写入到磁盘。同时，该方法会根据当前事务的`txid`来交替写入meta page 0 或 1。这样，即使在数据库写入meta页时挂掉，其重启时可以根据meta页的校验和切换到另一个数据完整的meta页。这样做也不会引起提交的事务数据丢失，因为如果还没写完meta页，那么该事务不会被认为是已提交的；另外，由于boltdb写入page时是copy-on-write的，旧meta页中指向的相应的页也都是有效的。

##### 2.2.2.4 Check

如果数据库处于严格模式`StrictMode`，则在事务提交的第7步中将调用`Check`方法对数据库进行完整性检查。

```go

// Check performs several consistency checks on the database for this transaction.
// An error is returned if any inconsistency is found.
//
// It can be safely run concurrently on a writable transaction. However, this
// incurs a high cost for large databases and databases with a lot of subbuckets
// because of caching. This overhead can be removed if running on a read-only
// transaction, however, it is not safe to execute other writer transactions at
// the same time.
func (tx *Tx) Check() <-chan error {
	ch := make(chan error)
	go tx.check(ch)
	return ch
}

func (tx *Tx) check(ch chan error) {
	// Check if any pages are double freed.
	freed := make(map[pgid]bool)
	all := make([]pgid, tx.db.freelist.count())
	tx.db.freelist.copyall(all)
	for _, id := range all {
		if freed[id] {
			ch <- fmt.Errorf("page %d: already freed", id)
		}
		freed[id] = true
	}

	// Track every reachable page.
	reachable := make(map[pgid]*page)
	reachable[0] = tx.page(0) // meta0
	reachable[1] = tx.page(1) // meta1
	for i := uint32(0); i <= tx.page(tx.meta.freelist).overflow; i++ {
		reachable[tx.meta.freelist+pgid(i)] = tx.page(tx.meta.freelist)
	}

	// Recursively check buckets.
	tx.checkBucket(&tx.root, reachable, freed, ch)

	// Ensure all pages below high water mark are either reachable or freed.
	for i := pgid(0); i < tx.meta.pgid; i++ {
		_, isReachable := reachable[i]
		if !isReachable && !freed[i] {
			ch <- fmt.Errorf("page %d: unreachable unfreed", int(i))
		}
	}

	// Close the channel to signal completion.
	close(ch)
}

func (tx *Tx) checkBucket(b *Bucket, reachable map[pgid]*page, freed map[pgid]bool, ch chan error) {
	// Ignore inline buckets.
	if b.root == 0 {
		return
	}

	// Check every page used by this bucket.
	b.tx.forEachPage(b.root, 0, func(p *page, _ int) {
		if p.id > tx.meta.pgid {
			ch <- fmt.Errorf("page %d: out of bounds: %d", int(p.id), int(b.tx.meta.pgid))
		}

		// Ensure each page is only referenced once.
		for i := pgid(0); i <= pgid(p.overflow); i++ {
			var id = p.id + i
			if _, ok := reachable[id]; ok {
				ch <- fmt.Errorf("page %d: multiple references", int(id))
			}
			reachable[id] = p
		}

		// We should only encounter un-freed leaf and branch pages.
		if freed[p.id] {
			ch <- fmt.Errorf("page %d: reachable freed", int(p.id))
		} else if (p.flags&branchPageFlag) == 0 && (p.flags&leafPageFlag) == 0 {
			ch <- fmt.Errorf("page %d: invalid type: %s", int(p.id), p.typ())
		}
	})

	// Check each bucket within this bucket.
	_ = b.ForEach(func(k, v []byte) error {
		if child := b.Bucket(k); child != nil {
			tx.checkBucket(child, reachable, freed, ch)
		}
		return nil
	})
}

```

`Check`方法的完整性检查是对数据库的页完整性的检查，其检查了两方面问题：
1. 是否存在页被二次释放的问题。
2. 是否所有页都能索引到，即是否存在既无法直接访问，又无法通过B+Tree索引到，也不在freelist中。

#### 2.2.3 事务回滚

boltdb的用户可以通过`Rollback`手动回滚事务，该方法会检测事务是否为隐式事务，如果是隐式事务则会返回错误（boltdb在回滚隐式事务前会将其`managed`字段置为false以避免返回错误）。`Rollback`方法会调用`rollback`方法进入回滚逻辑。另外，在事务提交时，发生部分错误时会直接调用`rollback`方法回滚事务。

`Rollback`方法与`rollback`方法的实现如下：

```go

// Rollback closes the transaction and ignores all previous updates. Read-only
// transactions must be rolled back and not committed.
func (tx *Tx) Rollback() error {
	_assert(!tx.managed, "managed tx rollback not allowed")
	if tx.db == nil {
		return ErrTxClosed
	}
	tx.rollback()
	return nil
}

func (tx *Tx) rollback() {
	if tx.db == nil {
		return
	}
	if tx.writable {
		tx.db.freelist.rollback(tx.meta.txid)
		tx.db.freelist.reload(tx.db.page(tx.db.meta().freelist))
	}
	tx.close()
}

```

`rollback`中的逻辑非常简单，对于只读事务只需要调用`close`方法关闭事务即可；而对于读写事务，首先要通过`freelist`的`rollback`方法，删除当前事务的`penging`列表中记录的页，因为这些页会被复用而不需要释放。另外，其还需要调用`freelist`的`reload`方法，其目的是将当前事务分配的页重新加入到`freelist`中；否则，这些页会无法引用，导致完整性检查失败。

#### 2.2.4 事务关闭

无论是事务提交还是事务关闭，最后都需要调用`close`方法关闭事务。`close`方法的实现如下：

```go

func (tx *Tx) close() {
	if tx.db == nil {
		return
	}
	if tx.writable {
		// Grab freelist stats.
		// ... ...

		// Remove transaction ref & writer lock.
		tx.db.rwtx = nil
		tx.db.rwlock.Unlock()

		// Merge statistics.
		// ... ...

	} else {
		tx.db.removeTx(tx)
	}

	// Clear all references.
	tx.db = nil
	tx.meta = nil
	tx.root = Bucket{tx: tx}
	tx.pages = nil
}

// removeTx removes a transaction from the database.
func (db *DB) removeTx(tx *Tx) {
	// Release the read lock on the mmap.
	db.mmaplock.RUnlock()

	// Use the meta lock to restrict access to the DB object.
	db.metalock.Lock()

	// Remove the transaction.
	for i, t := range db.txs {
		if t == tx {
			last := len(db.txs) - 1
			db.txs[i] = db.txs[last]
			db.txs[last] = nil
			db.txs = db.txs[:last]
			break
		}
	}
	n := len(db.txs)

	// Unlock the meta pages.
	db.metalock.Unlock()

	// Merge statistics.
	// ... ...
}

```

`close`主要做事务的清理工作并更新统计量（这里将其省略）。对于读写事务，其解除的`DB`对象中`rwtx`字段对其的引用，同时释放了`rwlock`；对于只读事务，其调用了`removeTx`方法。`removeTx`方法首先释放了`mmaplock`的S锁，然后获取`metalock`保护对`DB`对象的访问（而不是保护`meta`对象），然后从`DB`的`txs`字段中删除对当前事务的引用，之后释放`metalock`并更新统计量。

### 2.3 内置隐式事务

boltdb除了为用户提供了`Begin`方法来显式地启动读写事务或只读事务，其还提供一些内置的封装好的隐式事务方法，如`Update`、`View`与`Batch`。当用户只需要操作数据库而不需要关心何时提交或回滚时，可以使用这些方法。

#### 2.3.1 隐式读写事务与隐式只读事务

`Update`与`View`分别是通过读写隐式事务与只读隐式事务操作数据库的方法。二者实现如下：

```go

// Update executes a function within the context of a read-write managed transaction.
// If no error is returned from the function then the transaction is committed.
// If an error is returned then the entire transaction is rolled back.
// Any error that is returned from the function or returned from the commit is
// returned from the Update() method.
//
// Attempting to manually commit or rollback within the function will cause a panic.
func (db *DB) Update(fn func(*Tx) error) error {
	t, err := db.Begin(true)
	if err != nil {
		return err
	}

	// Make sure the transaction rolls back in the event of a panic.
	defer func() {
		if t.db != nil {
			t.rollback()
		}
	}()

	// Mark as a managed tx so that the inner function cannot manually commit.
	t.managed = true

	// If an error is returned from the function then rollback and return error.
	err = fn(t)
	t.managed = false
	if err != nil {
		_ = t.Rollback()
		return err
	}

	return t.Commit()
}

// View executes a function within the context of a managed read-only transaction.
// Any error that is returned from the function is returned from the View() method.
//
// Attempting to manually rollback within the function will cause a panic.
func (db *DB) View(fn func(*Tx) error) error {
	t, err := db.Begin(false)
	if err != nil {
		return err
	}

	// Make sure the transaction rolls back in the event of a panic.
	defer func() {
		if t.db != nil {
			t.rollback()
		}
	}()

	// Mark as a managed tx so that the inner function cannot manually rollback.
	t.managed = true

	// If an error is returned from the function then pass it through.
	err = fn(t)
	t.managed = false
	if err != nil {
		_ = t.Rollback()
		return err
	}

	if err := t.Rollback(); err != nil {
		return err
	}

	return nil
}

```

`Update`与`View`的参数是一个用来操作事务的方法闭包。这两个方法首先创建一个读写事务或只读事务，在执行方法闭包前先将`managed`字段置为true，以阻止用户在传入的方法闭包中手动提交或回滚事务，在执行后在将`managed`字段置为false，以便boltdb提交或回滚事务。

#### 2.3.2 批处理隐式读写事务

每个`Update`操作都要等待磁盘I/O完成才能执行下一个`Update`操作，虽然这保证了事务特性，但是性能较差。boltdb还为用户提供了一个能够将并发的多个读写事务合并为一次事务的方法——`Batch`。虽然通过`Batch`能够减少并发读写事务等待磁盘I/O的开销，但是其对事务中的操作有一定要求：`Batch`中的事务可能被重试若干次（即使某个事务正常，也可能被重试，笔者会在后文分析其原因），因此这要求通过`Batch`执行的操作必须是幂等（idempotent）的，且只有调用者调用的`Batch`方法成功返回后，其变更才保证被永久写入到存储。boltdb中的`Batch`分批操作对用户使透明的，用户只需要像调用`Update`一样调用`Batch`，boltdb就会自动将其分批。

`Batch`方法使用到了`batch`结构体：

```go

type batch struct {
	db    *DB
	timer *time.Timer
	start sync.Once
	calls []call
}

type call struct {
	fn  func(*Tx) error
	err chan<- error
}

```

`batch`结构体的`calls`字段记录了每批读写事务的方法闭包与错误返回信道。记录错误返回信道的作用是为了将每个事务的错误返回给相应地调用者。

数据库结构体`db`的实例的`batch`字段是指向当前正在等待积累的`batch`指针，当一批`batch`执行时，其会将该字段置为nil，下一次调用`Batch`时会创建新实例。

`Batch`方法的实现如下：

```go

// Batch calls fn as part of a batch. It behaves similar to Update,
// except:
//
// 1. concurrent Batch calls can be combined into a single Bolt
// transaction.
//
// 2. the function passed to Batch may be called multiple times,
// regardless of whether it returns error or not.
//
// This means that Batch function side effects must be idempotent and
// take permanent effect only after a successful return is seen in
// caller.
//
// The maximum batch size and delay can be adjusted with DB.MaxBatchSize
// and DB.MaxBatchDelay, respectively.
//
// Batch is only useful when there are multiple goroutines calling it.
func (db *DB) Batch(fn func(*Tx) error) error {
	errCh := make(chan error, 1)

	db.batchMu.Lock()
	if (db.batch == nil) || (db.batch != nil && len(db.batch.calls) >= db.MaxBatchSize) {
		// There is no existing batch, or the existing batch is full; start a new one.
		db.batch = &batch{
			db: db,
		}
		db.batch.timer = time.AfterFunc(db.MaxBatchDelay, db.batch.trigger)
	}
	db.batch.calls = append(db.batch.calls, call{fn: fn, err: errCh})
	if len(db.batch.calls) >= db.MaxBatchSize {
		// wake up batch, it's ready to run
		go db.batch.trigger()
	}
	db.batchMu.Unlock()

	err := <-errCh
	if err == trySolo {
		err = db.Update(fn)
	}
	return err
}

```

在`Batch`方法中，其通过互斥锁`batchMu`保护了对`db`实例的`batch`字段的访问。如果`batch`为空或者已满时，创建新的`batch`实例，并为其注册定时器；如果该存在`batch`，则将当前方法与为其创建的错误信道加入到`batch`对象的`calls`字段中；如果此时`batch`已满，则立即触发其运行。在将当前事务加入到`batch`的列表中后，`Batch`方法会等待当前事务的错误信道的信号；如果从该信道收到的是`trySolo`错误，则通过`Update`方法重试该事务，返回结果。

没有满的`batch`会在定时器超时时触发，其`start sync.Once`字段确保每个`batch`只会被触发一次。`batch`触发时运行的相关代码如下：

```go

// trigger runs the batch if it hasn't already been run.
func (b *batch) trigger() {
	b.start.Do(b.run)
}

// run performs the transactions in the batch and communicates results
// back to DB.Batch.
func (b *batch) run() {
	b.db.batchMu.Lock()
	b.timer.Stop()
	// Make sure no new work is added to this batch, but don't break
	// other batches.
	if b.db.batch == b {
		b.db.batch = nil
	}
	b.db.batchMu.Unlock()

retry:
	for len(b.calls) > 0 {
		var failIdx = -1
		err := b.db.Update(func(tx *Tx) error {
			for i, c := range b.calls {
				if err := safelyCall(c.fn, tx); err != nil {
					failIdx = i
					return err
				}
			}
			return nil
		})

		if failIdx >= 0 {
			// take the failing transaction out of the batch. it's
			// safe to shorten b.calls here because db.batch no longer
			// points to us, and we hold the mutex anyway.
			c := b.calls[failIdx]
			b.calls[failIdx], b.calls = b.calls[len(b.calls)-1], b.calls[:len(b.calls)-1]
			// tell the submitter re-run it solo, continue with the rest of the batch
			c.err <- trySolo
			continue retry
		}

		// pass success, or bolt internal errors, to all callers
		for _, c := range b.calls {
			c.err <- err
		}
		break retry
	}
}

func safelyCall(fn func(*Tx) error, tx *Tx) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = panicked{p}
		}
	}()
	return fn(tx)
}

// trySolo is a special sentinel error value used for signaling that a
// transaction function should be re-run. It should never be seen by
// callers.
var trySolo = errors.New("batch function returned an error and should be re-run solo")

```

`run`方法的逻辑如下：

1. 首先将当前`db`实例的`batch`字段置为nil，以避免之后调用的`Batch`将事务加入到当前队列，同时不影响其它`batch`的操作。
2. 随后，循环重试。每次循环进行如下操作：
	1. 在一次`Update`方法中，循环执行`calls`列表中的每个事务的方法闭包，直到有一个事务返回错误时停止
	2. 如果发生了错误，则将发生错误的事务从`batch`中剔除，并向其错误信道中发送`trySolo`错误，告知调用者自行重试一次该事务，然后从头开始重试列表中的事务（这也是`Batch`要求其操作幂等的原因）。
	3. 循环通过或`Update`方法执行时boltdb内部产生错误（如果事务返回错误其会被从`calls`列表中剔除并重试，这里的`err`如果非空则为boltdb本身的错误），将错误（或nil）返回给`calls`中所有调用者的错误信道，通知调用者其事务执行完成或错误，退出循环。

## 3. 总结

本文介绍了事务的基本概念与boltdb中事务的相关实现。在boltdb的实现中，事务在各方各面都有体现，其ACID的实现也相辅相成。

关于boltdb的源码分析在这里也告一段落了，`db.go`中的重要代码已经在本系列各篇文章中分散地介绍过，这里也不再赘述。