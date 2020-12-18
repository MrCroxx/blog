---
title: "深入浅出etcd/raft —— 0x03 Raft选举"
date: 2020-12-17T21:13:37+08:00
lastmod: 2020-12-17T21:13:44+08:00
draft: true
keywords: []
description: ""
tags: ["etcd", "Raft"]
categories: ["Code Reading"]
author: ""
resources:
- name: featured-image
  src: etcd-raft.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

## 0. 引言

本文会对etcd/raft中Raft选举算法的实现与优化进行分析。这里假定读者阅读过Diego Ongaro的《In Search of an Understandable Consensus Algorithm (Extended Version)》（这里有笔者的[翻译](/posts/paper-reading/raft-extended/)，笔者英语水平一般，欢迎指正。），其中提到的部分，本文中不会做详细的解释。对etcd/raft的总体结构不熟悉的读者，可以先阅读[《深入浅出etcd/raft —— 0x02 etcd/raft总体设计》](/posts/code-reading/etcdraft-made-sample/2-overview/)。

本文首先会简单介绍etcd/raft对Raft选举部分的算法优化，然后通过源码分析etcd/raft的选举实现。

## 1. Raft选举算法优化

在leader选举方面，etcd/raft对《In Search of an Understandable Consensus Algorithm (Extended Version)》中介绍的基本Raft算法做了三种优化。这三种优化都在Diego Ongaro的博士论文《CONSENSUS: BRIDGING THEORY AND PRACTICE》的*6.4 Processing read-only queries more efficiently*和*9.6 Preventing disruptions when a server rejoins the cluster*中有提到，这里简单介绍一下这三种优化的背景与算法。

etcd/raft实现的与选举有关的优化有**Pre-Vote**、**Check Quorum**、和**Leader Lease**。在这三种优化中，只有**Pre-Vote**和**Leader Lease**最初是对选举过程的优化，**Check Quorum**期初是为了更高效地实现线性一致性读（Linearizable Read）而做出的优化，但是由于**Leader Lease**需要依赖**Check Quorum**，因此我们也将其放在这里一起讲解。本系列将etcd/raft对实现线性一致性读的优化留在了后续的文章中，本文仅介绍为了实现更高效的线性一致性读需要在选举部分做出的优化。

### 1.1 Pre-Vote

如下图所示，当Raft集群的网络发生分区时，会出现节点数达不到quorum（达成共识至少需要的节点数）的分区，如图中的*Partition 1*。

![网络分区示意图](assets/partition.svg "网络分区示意图")

在节点数能够达到quorum的分区中，选举流程会正常进行，该分区中的所有节点的term最终会稳定为新选举出的leader节点的term。不幸的是，在节点数无法达到quorum的分区中，如果该分区中没有leader节点，因为节点总是无法收到数量达到quorum的投票而不会选举出新的leader，所以该分区中的节点在*election timeout*超时后，会增大term并发起下一轮选举，这导致该分区中的节点的term会不断增大。

如果网络一直没有恢复，这是没有问题的。但是，如果网络分区恢复，此时，达不到quorum的分区中的节点的term值会远大于能够达到quorum的分区中的节点的term，这会导致能够达到quorum的分区的leader退位并term，使集群产生一轮不必要的选举。

**Pre-Vote**机制就是为了解决这一问题而设计的，其解决的思路在于不允许达不到quorum的分区正常进入投票流程，也就避免了其term号的增大。为此，**Pre-Vote**引入了“预投票”，也就是说，当节点*election timeout*超时时，它们不会立即增大自身的term并请求投票，而是先发起一轮预投票。收到预投票请求的节点不会退位。只有当节点收到了达到quorum的预投票响应时，节点才能增大自身term号并发起投票请求。这样，达不到quorum的分区中的节点永远无法增大term，也就不会在分区恢复后引起不必要的一轮投票。

### 1.2 Check Quorum

在Raft算法中，保证线性一致性读取的最简单的方式，就是讲读请求同样当做一条Raft提议，通过与其它日志相同的方式执行，因此这种方式也叫作*Log Read*。显然，*Log Read*的性能很差。而在很多系统中，读多写少的负载是很常见的场景。因此，为了提高读取的性能，就要试图绕过日志机制。

但是，直接绕过日志机制从leader读取，可能会读到陈旧的数据，也就是说存在*stale read*的问题。在下图的场景中，假设网络分区前，*Node 5*是整个集群的leader。在网络发生分区后，*Partition 0*分区中选举出了新leader，也就是图中的*Node 1*。

![stale read示意图](assets/stale-read.svg "stale read示意图")

但是，由于网络分区，*Node 5*无法收到*Partition 0*中节点的消息，*Node 5*不会意识到集群中出现了新的leader。此时，虽然它不能成功地完成日志提交，但是如果读取时绕过了日志，它还是能够提供读取服务的。这会导致连接到*Node 5*的client读取到陈旧的数据。

**Check Quorum**可以减轻这一问题带来的影响，其机制也非常简单：让leader每隔一段时间主动地检查follower是否活跃。如果活跃的follower数量达不到quorum，那么说明该leader可能是分区前的旧leader，所以此时该leader会主动退位转为follower。

需要注意的是，**Check Quorum**并不能完全避免*stale read*的发生，只能减小其发生时间，降低影响。如果需要严格的线性一致性，需要通过其它机制实现。

### 1.3 Leader Lease

分布式系统中的网络环境十分复杂，有时可能出现网络不完全分区的情况，即整个整个网络拓补图是一个连通图，但是可能并非任意的两个节点都能互相访问。

![不完全分区示意图](assets/partial-partition.svg "不完全分区示意图")


这种现象不止会出现在网络故障中，还会出现在成员变更中。在通过`ConfChange`移除节点时，不同节点应用该`ConfChange`的时间可能不同，这也可能导致这一现象发生。

在上图的场景下，*Node 1*与*Node 2*之间无法通信。如果它们之间的通信中断前，*Node 1*是集群的leader，在通信中断后，*Node 2*无法再收到来自*Node 1*的心跳。因此，*Node 2*会开始选举。如果在*Node 2*发起选举前，*Node 1*和*Node 3*中都没有新的日志，那么*Node 2*仍可以收到能达到quorum的投票（来自*Node 2*本身的投票和来自*Node 3*的投票），并成为leader。

**Leader Lease**机制对投票引入了一条新的约束以解决这一问题：当节点在*election timeout*超时前，如果收到了leader的消息，那么它不会为其它发起投票或预投票请求的节点投票。也就是说，**Leader Lease**机制会阻止了正常工作的集群中的节点给其它节点投票。

**Leader Lease**需要依赖**Check Quorum**机制才能正常工作。接下来我们通过一个例子说明其原因。

假如在一个5个节点组成的Raft集群中，出现了下图中的分区情况：*Node 1*与*Node 2*互通，*Node 3*、*Node 4*、*Node 5*之间两两互通、*Node 5*与任一节点不通。在网络分区前，*Node 1*是集群的leader。

![一种可能的网络分区示意图](assets/leader-lease-without-check-quorum.svg "一种可能的网络分区示意图")

在既没有**Leader Lease**也没有**Check Quorum**的情况下，*Node 3*、*Node 4*会因收不到leader的心跳而发起投票，因为*Node 2*、*Node 3*、*Node 4*互通，该分区节点数能达到quorum，因此它们可以选举出新的leader。

而在使用了**Leader Lease**而不使用**Check Quorum**的情况下，由于*Node 2*仍能够收到原leader *Node 1*的心跳，受**Leader Lease**机制的约束，它不会为其它节点投票。这会导致即使整个集群中存在可用节点数达到quorum的分区，但是集群仍无法正常工作。

而如果同时使用了**Leader Lease**和**Check Quorum**，那么在上图的情况下，*Node 1*会在*election timeout*超时后因检测不到数量达到quorum的活跃节点而退位为follower。这样，*Node 2*、*Node 3*、*Node 4*之间的选举可以正常进行。

## 2. etcd/raft中Raft选举的实现

本节中，我们将分析etcd/raft中选举部分的实现。
### 2.1 MsgHup与hup

在etcd/raft的实现中，选举的触发是通过`MsgHup`消息实现的，无论是主动触发选举还是因*election timeout*超时都是如此：

```go

// *** node.go ***

func (n *node) Campaign(ctx context.Context) error { return n.step(ctx, pb.Message{Type: pb.MsgHup}) }

// *** rawnode.go ***

func (rn *RawNode) Campaign() error {
	return rn.raft.Step(pb.Message{
		Type: pb.MsgHup,
	})
}

// *** raft.go ***

// tickElection is run by followers and candidates after r.electionTimeout.
func (r *raft) tickElection() {
	r.electionElapsed++

	if r.promotable() && r.pastElectionTimeout() {
		r.electionElapsed = 0
		r.Step(pb.Message{From: r.id, Type: pb.MsgHup})
	}
}

```

因此，我们可以跟着`MsgHup`的处理流程，分析etcd/raft中选举的实现。正如我们在[《深入浅出etcd/raft —— 0x02 etcd/raft总体设计》](/posts/code-reading/etcdraft-made-sample/2-overview/)中所说，etcd/raft通过`raft`结构体的`Step`方法实现Raft状态机的状态转移。

```go

func (r *raft) Step(m pb.Message) error {
	// ... ...
	switch m.Type {
	case pb.MsgHup:
		if r.preVote {
			r.hup(campaignPreElection)
		} else {
			r.hup(campaignElection)
		}
	// ... ...
	}
	// ... ...
}

```

`Step`方法在处理`MsgHup`消息时，会根据当前配置中是否开启了`Pre-Vote`机制，以不同的参数调用`hup`方法。

```go

func (r *raft) hup(t CampaignType) {
	if r.state == StateLeader {
		r.logger.Debugf("%x ignoring MsgHup because already leader", r.id)
		return
	}

	if !r.promotable() {
		r.logger.Warningf("%x is unpromotable and can not campaign", r.id)
		return
	}
	ents, err := r.raftLog.slice(r.raftLog.applied+1, r.raftLog.committed+1, noLimit)
	if err != nil {
		r.logger.Panicf("unexpected error getting unapplied entries (%v)", err)
	}
	if n := numOfPendingConf(ents); n != 0 && r.raftLog.committed > r.raftLog.applied {
		r.logger.Warningf("%x cannot campaign at term %d since there are still %d pending configuration changes to apply", r.id, r.Term, n)
		return
	}

	r.logger.Infof("%x is starting a new election at term %d", r.id, r.Term)
	r.campaign(t)
}

```

`hup`方法会对节点当前状态进行一些检查，如果检查通过才会试图让当前节点发起投票或预投票。首先，`hup`会检查当前节点是否已经是leader，如果已经是leader那么直接返回。接下来，`hup`通过`promotable()`方法判断当前节点能否提升为leader。

```go

// promotable indicates whether state machine can be promoted to leader,
// which is true when its own id is in progress list.
func (r *raft) promotable() bool {
	pr := r.prs.Progress[r.id]
	return pr != nil && !pr.IsLearner && !r.raftLog.hasPendingSnapshot()
}

```

`promotable()`的判定规则有三条：

1. 当前节点是否已被集群移除。（通过`ProgressTracker.ProgressMap`映射中是否有当前节点的id的映射判断。当节点被从集群中移除后，被移除的节点id会被从该映射中移除。我们会在后续讲解集群配置变更的文章中详细分析其实现。）
2. 当前节点是否为learner节点。
3. 当前节点是否还有未被保存到稳定存储中的快照。

这三条规则中，只要有一条为真，那么当前节点就无法成为leader。在`hup`方法中，除了需要`promotable()`为真，还需要判断一条规则：

1. 当前的节点已提交的日志中，是否有还未被应用的集群配置变更`ConfChange`消息。

如果当前节点已提交的日志中还有未应用的`ConfChange`消息，那么该节点也无法提升为leader。

只有当以上条件都满足后，`hup`方法才会调用`campaign`方法，根据配置，开始投票或预投票。

### 2.2 campaign

`campaign`是用来发起投票或预投票的重要方法。

```go

// campaign transitions the raft instance to candidate state. This must only be
// called after verifying that this is a legitimate transition.
func (r *raft) campaign(t CampaignType) {
	if !r.promotable() {
		// This path should not be hit (callers are supposed to check), but
		// better safe than sorry.
		r.logger.Warningf("%x is unpromotable; campaign() should have been called", r.id)
	}
	var term uint64
	var voteMsg pb.MessageType
	if t == campaignPreElection {
		r.becomePreCandidate()
		voteMsg = pb.MsgPreVote
		// PreVote RPCs are sent for the next term before we've incremented r.Term.
		term = r.Term + 1
	} else {
		r.becomeCandidate()
		voteMsg = pb.MsgVote
		term = r.Term
	}
	if _, _, res := r.poll(r.id, voteRespMsgType(voteMsg), true); res == quorum.VoteWon {
		// We won the election after voting for ourselves (which must mean that
		// this is a single-node cluster). Advance to the next state.
		if t == campaignPreElection {
			r.campaign(campaignElection)
		} else {
			r.becomeLeader()
		}
		return
	}
	var ids []uint64
	{
		idMap := r.prs.Voters.IDs()
		ids = make([]uint64, 0, len(idMap))
		for id := range idMap {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	}
	for _, id := range ids {
		if id == r.id {
			continue
		}
		r.logger.Infof("%x [logterm: %d, index: %d] sent %s request to %x at term %d",
			r.id, r.raftLog.lastTerm(), r.raftLog.lastIndex(), voteMsg, id, r.Term)

		var ctx []byte
		if t == campaignTransfer {
			ctx = []byte(t)
		}
		r.send(pb.Message{Term: term, To: id, Type: voteMsg, Index: r.raftLog.lastIndex(), LogTerm: r.raftLog.lastTerm(), Context: ctx})
	}
}

```

因为调用`campaign`的方法不止有`hup`，`campaign`方法首先还是会检查`promotable()`是否为真。

```go

	if t == campaignPreElection {
		r.becomePreCandidate()
		voteMsg = pb.MsgPreVote
		// PreVote RPCs are sent for the next term before we've incremented r.Term.
		term = r.Term + 1
	} else {
		r.becomeCandidate()
		voteMsg = pb.MsgVote
		term = r.Term
	}

```

在开启**Pre-Vote**后，首次调用`campaign`时，参数为`campaignPreElection`。此时会调用`becomePreCandidate`方法，该方法不会修改当前节点的`Term`值，因此发送的`MsgPreVote`消息的`Term`应为当前的`Term + 1 `。而如果没有开启**Pre-Vote**或已经完成预投票进入正式投票的流程时，会调用`becomeCandidate`方法。该方法会增大当前节点的`Term`，因此发送`MsgVote`消息的`Term`就是此时的`Term`。`becomeXXX`用来将当前状态机的状态与相关行为修改为相应的角色，我们会在后文详细分析其实现与修改后的行为。

接下来，`campaign`方法开始发送投票请求。在向其它节点发送请求之前，该节点会先投票给自己：

```go

		if _, _, res := r.poll(r.id, voteRespMsgType(voteMsg), true); res == quorum.VoteWon {
		// We won the election after voting for ourselves (which must mean that
		// this is a single-node cluster). Advance to the next state.
		if t == campaignPreElection {
			r.campaign(campaignElection)
		} else {
			r.becomeLeader()
		}
		return
	}

```

`poll`方法会在更新本地的投票状态并获取当前投票结果。如果节点投票给自己后就赢得了选举，这说明集群是以单节点的模式启动的，那么如果当前是预投票阶段当前节点就能立刻开启投票流程、如果已经在投票流程中就直接当选leader即可。如果集群不是以单节点的模式运行的，那么就需要向其它有资格投票的节点发送投票请求：

```go

	var ids []uint64
	{
		idMap := r.prs.Voters.IDs()
		ids = make([]uint64, 0, len(idMap))
		for id := range idMap {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	}
	for _, id := range ids {
		if id == r.id {
			continue
		}
		r.logger.Infof("%x [logterm: %d, index: %d] sent %s request to %x at term %d",
			r.id, r.raftLog.lastTerm(), r.raftLog.lastIndex(), voteMsg, id, r.Term)

		var ctx []byte
		if t == campaignTransfer {
			ctx = []byte(t)
		}
		r.send(pb.Message{Term: term, To: id, Type: voteMsg, Index: r.raftLog.lastIndex(), LogTerm: r.raftLog.lastTerm(), Context: ctx})
	}

```

请求的`Term`字段就是我们之前记录的`term`，即预投票阶段为当前`Term + 1`、投票阶段为当前的`Term`。

### 2.3 Step方法与step



# === STALE ===

```go

func (r *raft) becomePreCandidate() {

	// ... ...

	// Becoming a pre-candidate changes our step functions and state,
	// but doesn't change anything else. In particular it does not increase
	// r.Term or change r.Vote.
	r.step = stepCandidate
	r.prs.ResetVotes()
	r.tick = r.tickElection
	r.lead = None
	r.state = StatePreCandidate
	r.logger.Infof("%x became pre-candidate at term %d", r.id, r.Term)
}

```

在`becomePreCandidate`中，仅修改的`raft`结构体的`step`行为（`step`字段对应着不同角色的节点处理一些类型消息时的不同行为，可能的行为有`stepLeader`、`stepFollower`、和`stepCandidate`）和`state`状态，并重置记录的投票、当前的leader字段`lead`、和`tickElection`。