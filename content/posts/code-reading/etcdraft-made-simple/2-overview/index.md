---
title: "深入浅出etcd/raft —— 0x02 etcd/raft总体设计"
date: 2020-12-17T17:41:28+08:00
lastmod: 2020-12-17T17:41:33+08:00
draft: false
keywords: []
description: ""
tags: ["etcd", "Raft"]
categories: ["深入浅出etcd/raft"]
author: ""
featuredImage: img/etcd-raft.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

在[《深入浅出etcd/raft —— 0x01 raftexample》](/posts/code-reading/etcdraft-made-simple/1-raftexample/)中，我们通过对一个官方提供的基于etcd/raft实现的简单kvstore简单地介绍了etcd/raft的使用，以对etcd/raft有一个初步认识。想要深入分析etcd/raft中对Raft算法的实现与优化，首先，我们必须先要了解etcd/raft的总体设计。

etcd/raft将Raft算法的实现分为了3个模块：Raft状态机、存储模块、传输模块。

Raft状态机完全由etcd/raft负责，`raft`结构体即为其实现。使用etcd/raft的开发者不能直接操作raft结构体，只能通过etcd/raft提供的`Node`接口对其进行操作。

存储模块可以划分为两部分：对存储的读取与写入。etcd/raft只需要读取存储，etcd/raft依赖的`Storage`接口中只有读取存储的方法。而对存储的写入由用户负责，etcd/raft并不关心开发者如何写入存储，对存储的写入方法可以由开发者自己定义。etcd使用的存储模块是在与`Storage`接口同一文件下的`MemoryStorage`结构体。`MemoryStorage`既实现了`Storage`接口需要的读取存储的方法，也为用户提供了写入存储的方法。

{{< admonition info 说明 >}}

`Storage`接口定义的是稳定存储的读取方法。之所以etcd使用了基于内存的`MemoryStorage`，是因为etcd在写入`MemoryStorage`前，需要先写入预写日志（Write Ahead Log，WAL）或快照。而预写日志和快照是保存在稳定存储中的。这样，在每次重启时，etcd可以基于保存在稳定存储中的快照和预写日志恢复`MemoryStorage`的状态。也就是说，etcd的稳定存储是通过快照、预写日志、`MemoryStorage`三者共同实现的。

{{< /admonition >}}

通信模块是完全由使用etcd/raft的开发者负责的。etcd/raft不关心开发者如何实现通信模块。

下图是一张关于etcd/raft的实现中，开发者与etcd/raft对这3个模块的职责的示意图。

![etcd/raft职责示意图](assets/overview.svg "etcd/raft职责示意图")

因为`Node`接口是开发者仅有的操作etcd/raft的方式，所以我们先来看看`Node`接口与其相关实现。

## 1. Node、node、rawnode

`Node`接口为开发者提供了操作etcd/raft的方法。其接口定义如下：

```go

// Node represents a node in a raft cluster.
type Node interface {
	// Tick increments the internal logical clock for the Node by a single tick. Election
	// timeouts and heartbeat timeouts are in units of ticks.
	Tick()
	// Campaign causes the Node to transition to candidate state and start campaigning to become leader.
	Campaign(ctx context.Context) error
	// Propose proposes that data be appended to the log. Note that proposals can be lost without
	// notice, therefore it is user's job to ensure proposal retries.
	Propose(ctx context.Context, data []byte) error
	// ProposeConfChange proposes a configuration change. Like any proposal, the
	// configuration change may be dropped with or without an error being
	// returned. In particular, configuration changes are dropped unless the
	// leader has certainty that there is no prior unapplied configuration
	// change in its log.
	//
	// The method accepts either a pb.ConfChange (deprecated) or pb.ConfChangeV2
	// message. The latter allows arbitrary configuration changes via joint
	// consensus, notably including replacing a voter. Passing a ConfChangeV2
	// message is only allowed if all Nodes participating in the cluster run a
	// version of this library aware of the V2 API. See pb.ConfChangeV2 for
	// usage details and semantics.
	ProposeConfChange(ctx context.Context, cc pb.ConfChangeI) error

	// Step advances the state machine using the given message. ctx.Err() will be returned, if any.
	Step(ctx context.Context, msg pb.Message) error

	// Ready returns a channel that returns the current point-in-time state.
	// Users of the Node must call Advance after retrieving the state returned by Ready.
	//
	// NOTE: No committed entries from the next Ready may be applied until all committed entries
	// and snapshots from the previous one have finished.
	Ready() <-chan Ready

	// Advance notifies the Node that the application has saved progress up to the last Ready.
	// It prepares the node to return the next available Ready.
	//
	// The application should generally call Advance after it applies the entries in last Ready.
	//
	// However, as an optimization, the application may call Advance while it is applying the
	// commands. For example. when the last Ready contains a snapshot, the application might take
	// a long time to apply the snapshot data. To continue receiving Ready without blocking raft
	// progress, it can call Advance before finishing applying the last ready.
	Advance()
	// ApplyConfChange applies a config change (previously passed to
	// ProposeConfChange) to the node. This must be called whenever a config
	// change is observed in Ready.CommittedEntries, except when the app decides
	// to reject the configuration change (i.e. treats it as a noop instead), in
	// which case it must not be called.
	//
	// Returns an opaque non-nil ConfState protobuf which must be recorded in
	// snapshots.
	ApplyConfChange(cc pb.ConfChangeI) *pb.ConfState

	// TransferLeadership attempts to transfer leadership to the given transferee.
	TransferLeadership(ctx context.Context, lead, transferee uint64)

	// ReadIndex request a read state. The read state will be set in the ready.
	// Read state has a read index. Once the application advances further than the read
	// index, any linearizable read requests issued before the read request can be
	// processed safely. The read state will have the same rctx attached.
	ReadIndex(ctx context.Context, rctx []byte) error

	// Status returns the current status of the raft state machine.
	Status() Status
	// ReportUnreachable reports the given node is not reachable for the last send.
	ReportUnreachable(id uint64)
	// ReportSnapshot reports the status of the sent snapshot. The id is the raft ID of the follower
	// who is meant to receive the snapshot, and the status is SnapshotFinish or SnapshotFailure.
	// Calling ReportSnapshot with SnapshotFinish is a no-op. But, any failure in applying a
	// snapshot (for e.g., while streaming it from leader to follower), should be reported to the
	// leader with SnapshotFailure. When leader sends a snapshot to a follower, it pauses any raft
	// log probes until the follower can apply the snapshot and advance its state. If the follower
	// can't do that, for e.g., due to a crash, it could end up in a limbo, never getting any
	// updates from the leader. Therefore, it is crucial that the application ensures that any
	// failure in snapshot sending is caught and reported back to the leader; so it can resume raft
	// log probing in the follower.
	ReportSnapshot(id uint64, status SnapshotStatus)
	// Stop performs any necessary termination of the Node.
	Stop()
}

```

看过本系列第一篇文章[《深入浅出etcd/raft —— 0x01 raftexample》](/posts/code-reading/etcdraft-made-simple/1-raftexample/)的读者对这一接口一定不会陌生。这里，我们再简单回顾一下与`Node`接口交互的方式。

`Node`结构中的方法按调用时机可以分为三类：

| 方法<div style="width: 8em"></div> | 描述 |
| :-: | :- |
| `Tick` | 由时钟（循环定时器）驱动，每隔一定时间调用一次，驱动`raft`结构体的内部时钟运行。 |
| `Ready`、`Advance` | 这两个方法往往成对出现。准确的说，是`Ready`方法返回的`Ready`结构体信道的信号与`Advance`方法成对出现。每当从`Ready`结构体信道中收到来自`raft`的消息时，用户需要按照一定顺序对`Ready`结构体中的字段进行处理。在完成对`Ready`的处理后，需要调用`Advance`方法，通知`raft`这批数据已经处理完成，可以继续传入下一批。 |
| 其它方法 | 需要时随时调用。 | 

对于`Ready`结构体，有几个重要的字段需要按照如下顺序处理：

1. 将`HardState`、`Entries`、`Snapshot`写入稳定存储（其中，`Snapshot`的写入不需要严格按照此顺序，etcd/raft为快照的传输提供了另一套机制以优化执行效率）。
2. 本条中的操作可以并行执行：
    - 将`Messages`中的消息发送给相应的节点。
	- 将`Snapshot`和`CommittedEntries`应用到本地状态机中。
3. 调用`Advance`方法。

在回顾了`Node`接口的基本使用方式后，我们再看关注一下其实现。

在etcd/raft中，`Node`接口的实现一共有两个，分别是`node`结构体和`rawnode`结构体。二者都是对etcd/raft中Raft状态机`raft`结构体进行操作。不同的是，`node`结构体是线程安全的，其内部封装了`rawnode`，并通过各种信道实现线程安全的操作；而`rawnode`是非线程安全的，其直接将`Node`接口中的方法转为对`raft`结构体的方法的调用。`rawnode`是为需要实现Multi-Raft的开发者提供的更底层的接口。

学习etcd/raft中Raft算法的实现与优化不需要深入`node`或`rawnode`的实现，因此这里不对其进行详细的分析。对go语言并发编程感兴趣的读者可以学习一下`node`的实现，其对信道的使用非常典型。接下来，我们继续深入，概括地分析一下`raft`结构体的实现。

## 2. Raft状态机——raft

etcd/raft的实现的优雅之处之一，在于其很好地剥离了各模块的职责。在etcd/raft的实现中，`raft`结构体是一个Raft状态机，其通过`Step`方法进行状态转移。只要涉及到Raft状态机的状态转移，最终都会通过`Step`方法完成。`Step`方法的参数是Raft消息（在*etcd/raft/raftpb*中，是直接通过`.proto`文件生成的[**Protocol Buffers**](https://developers.google.com/protocol-buffers)的go语言实现）。

这里我们以`Node`接口的`Tick`方法为例。其实`Tick`方法并不是一个很好地例子，但是由于`Tick`方法比较特殊，后续文章中不会对其做额外的分析，因此这里就以该方法为例。

在`rawnode`的`Tick`方法实现中，其调用了`raft`结构体的`tick`“方法”。

```go

// Tick advances the internal logical clock by a single tick.
func (rn *RawNode) Tick() {
	rn.raft.tick()
}

```

这里之所以给“方法”打上了引号，是因为`tick`其实并非一个真正的方法，而是`raft`的一个字段，其类型为一个无参无返回值的函数。

```go

type raft struct {
	// ... ...
	tick func()
	// ... ...
}

```

这样设计的原因，是leader和follower在`tick`被调用时的行为不同。`tick`字段可能的值有两个，分别为`tickElection()`和`tickHeartbeat()`，二者分别对应follower（或candidate、pre candidate）和leader的`tick`行为。我们可以在如下4个方法中找到相应的证据：

```go

func (r *raft) becomeFollower(term uint64, lead uint64) {
	// ... ...
	r.tick = r.tickElection
	// ... ...
}

func (r *raft) becomeCandidate() {
	// ... ...
	r.tick = r.tickElection
	// ... ...
}

func (r *raft) becomePreCandidate() {
	// ... ...
	r.tick = r.tickElection
	// ... ...
}

func (r *raft) becomeLeader() {
	// ... ...
	r.tick = r.tickHeartbeat
	// ... ...
}

```

这里我们先以`tickElection`为例，分析其实如何将这一方法转为对`Step`方法的调用的。

```go

// tickElection is run by followers and candidates after r.electionTimeout.
func (r *raft) tickElection() {
	r.electionElapsed++

	if r.promotable() && r.pastElectionTimeout() {
		r.electionElapsed = 0
		r.Step(pb.Message{From: r.id, Type: pb.MsgHup})
	}
}

```

我们可以看到，`tickElection`方法会增大`electionElapsed`的值。当其超过了选举超时且当前节点可提拔为leader时（具体实现会在后续的文章中分析），重置其值，并创建一条`MsgHup`消息，传给`Step`方法。`Step`方法会对该消息进行处理，并适当地转移Raft状态机的状态。

`raft`结构体中的字段和相应的方法有很多。在后续的文章中，我们会在介绍etcd/raft中Raft算法的各部分实现时，介绍相应的字段与方法。这里仅给出创建`node`或`rawnode`时所需的`Config`结构体的结构，其大部分字段都与`raft`结构体中的有关字段相对应。

```go

// Config contains the parameters to start a raft.
type Config struct {
	// ID is the identity of the local raft. ID cannot be 0.
	ID uint64

	// peers contains the IDs of all nodes (including self) in the raft cluster. It
	// should only be set when starting a new raft cluster. Restarting raft from
	// previous configuration will panic if peers is set. peer is private and only
	// used for testing right now.
	peers []uint64

	// learners contains the IDs of all learner nodes (including self if the
	// local node is a learner) in the raft cluster. learners only receives
	// entries from the leader node. It does not vote or promote itself.
	learners []uint64

	// ElectionTick is the number of Node.Tick invocations that must pass between
	// elections. That is, if a follower does not receive any message from the
	// leader of current term before ElectionTick has elapsed, it will become
	// candidate and start an election. ElectionTick must be greater than
	// HeartbeatTick. We suggest ElectionTick = 10 * HeartbeatTick to avoid
	// unnecessary leader switching.
	ElectionTick int
	// HeartbeatTick is the number of Node.Tick invocations that must pass between
	// heartbeats. That is, a leader sends heartbeat messages to maintain its
	// leadership every HeartbeatTick ticks.
	HeartbeatTick int

	// Storage is the storage for raft. raft generates entries and states to be
	// stored in storage. raft reads the persisted entries and states out of
	// Storage when it needs. raft reads out the previous state and configuration
	// out of storage when restarting.
	Storage Storage
	// Applied is the last applied index. It should only be set when restarting
	// raft. raft will not return entries to the application smaller or equal to
	// Applied. If Applied is unset when restarting, raft might return previous
	// applied entries. This is a very application dependent configuration.
	Applied uint64

	// MaxSizePerMsg limits the max byte size of each append message. Smaller
	// value lowers the raft recovery cost(initial probing and message lost
	// during normal operation). On the other side, it might affect the
	// throughput during normal replication. Note: math.MaxUint64 for unlimited,
	// 0 for at most one entry per message.
	MaxSizePerMsg uint64
	// MaxCommittedSizePerReady limits the size of the committed entries which
	// can be applied.
	MaxCommittedSizePerReady uint64
	// MaxUncommittedEntriesSize limits the aggregate byte size of the
	// uncommitted entries that may be appended to a leader's log. Once this
	// limit is exceeded, proposals will begin to return ErrProposalDropped
	// errors. Note: 0 for no limit.
	MaxUncommittedEntriesSize uint64
	// MaxInflightMsgs limits the max number of in-flight append messages during
	// optimistic replication phase. The application transportation layer usually
	// has its own sending buffer over TCP/UDP. Setting MaxInflightMsgs to avoid
	// overflowing that sending buffer. TODO (xiangli): feedback to application to
	// limit the proposal rate?
	MaxInflightMsgs int

	// CheckQuorum specifies if the leader should check quorum activity. Leader
	// steps down when quorum is not active for an electionTimeout.
	CheckQuorum bool

	// PreVote enables the Pre-Vote algorithm described in raft thesis section
	// 9.6. This prevents disruption when a node that has been partitioned away
	// rejoins the cluster.
	PreVote bool

	// ReadOnlyOption specifies how the read only request is processed.
	//
	// ReadOnlySafe guarantees the linearizability of the read only request by
	// communicating with the quorum. It is the default and suggested option.
	//
	// ReadOnlyLeaseBased ensures linearizability of the read only request by
	// relying on the leader lease. It can be affected by clock drift.
	// If the clock drift is unbounded, leader might keep the lease longer than it
	// should (clock can move backward/pause without any bound). ReadIndex is not safe
	// in that case.
	// CheckQuorum MUST be enabled if ReadOnlyOption is ReadOnlyLeaseBased.
	ReadOnlyOption ReadOnlyOption

	// Logger is the logger used for raft log. For multinode which can host
	// multiple raft group, each raft group can have its own logger
	Logger Logger

	// DisableProposalForwarding set to true means that followers will drop
	// proposals, rather than forwarding them to the leader. One use case for
	// this feature would be in a situation where the Raft leader is used to
	// compute the data of a proposal, for example, adding a timestamp from a
	// hybrid logical clock to data in a monotonically increasing way. Forwarding
	// should be disabled to prevent a follower with an inaccurate hybrid
	// logical clock from assigning the timestamp and then forwarding the data
	// to the leader.
	DisableProposalForwarding bool
}

```

## 3. 总结

本文主要从顶层的视角，简单地分析了etcd/raft的总体设计。本文主要目的是给读者对etcd/raft的结构的整体认识，便于读者接下来学习etcd/raft中Raft算法的实现与优化。