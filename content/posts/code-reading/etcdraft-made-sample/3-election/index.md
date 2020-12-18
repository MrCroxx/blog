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







# === STALE ===











从本文开始，我们将一步一步地分析etcd/raft中对Raft算法的实现。

## 1. MsgHup与hup

在etcd/raft的Raft实现中，无论是选举超时还是开发者通过主动调用`Node`接口的`Campaign`方法，在追踪其源码实现时，我们都能看到它们都是通过让Raft状态机处理`MsgHup`消息实现的：

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

`MsgHup`消息非常简单，除了`Type`字段外，其它字段都为默认值。接下来，我们来看一下Raft状态机是如何处理`MsgHup`消息的：

```go


// *** raft.go ***

switch m.Type {
	case pb.MsgHup:
		if r.preVote {
			r.hup(campaignPreElection)
		} else {
			r.hup(campaignElection)
    }
    
    // ... ...

}

```

Raft状态机对`MsgHup`消息的处理也非常简单，其会根据配置中是否开启了预投票优化（pre vote），使用不同类型的参数调用`hup`方法。

{{< admonition info 提示 >}}

预投票（pre vote）机制在Diego Ongaro的博士论文《CONSENSUS: BRIDGING THEORY AND PRACTICE》的*9.6 Preventing disruptions when a server rejoins the cluster*的一节中提到，这里简单介绍下其优化的问题。

当产生网络分区时，节点数少于法定数量（quorum）的分区中的任何节点都无法赢得选举。如果没有优化，它们在选举失败后，会不断地增大term并进入下一轮选举。这会导致这些节点的term远大于能够成功选举的分区的节点的term。当这些节点的网络恢复后，它们会重新加入集群。因为它们的term更大，它们可能会使集群当前的leader退位并通过一轮选举选出新的leader。

为了避免这一问题，可以在真正的投票前，先进行一轮“预投票”。当节点选举超时或想主动成为leader时，它需要先向所有的节点发送预投票请求。收到预投票请求的节点会按照与投票请求相同的方式判断是否为其投票，但是自己不会进入**candidate**状态，而是等到真正投票时才可能变为**candidate**。发起预投票的节点只有收到法定数量的节点的投票时，才能进入真正的投票阶段。这样，在达不到法定数量节点的分区中，节点都无法真正进入投票阶段。这样，它们的term也不会增大，避免了重新加入集群时的问题。

{{< /admonition >}}

`hup`方法的源码如下：

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

在`hup`方法中，其首先会检查当前节点是否已经是leader，如果已经是leader会直接返回。接下来，会通过`promotable`方法判断当前节点能否被提拔为leader。

```go

// promotable indicates whether state machine can be promoted to leader,
// which is true when its own id is in progress list.
func (r *raft) promotable() bool {
	pr := r.prs.Progress[r.id]
	return pr != nil && !pr.IsLearner && !r.raftLog.hasPendingSnapshot()
}

```

`promotable`的判定规则有三条：

1. 当前节点是否已被集群移除。（通过`ProgressTracker.ProgressMap`映射中是否有当前节点的id的映射判断。当节点被从集群中移除后，被移除的节点id会被从该映射中移除。我们会在后续讲解集群配置变更的文章中详细分析其实现。）
2. 当前节点是否为learner节点。
3. 当前节点是否还有未被保存到稳定存储中的快照。

这三条规则中，只要有一条为真，那么当前节点就无法成为leader。在`hup`方法中，除了当前节点的`promotable`需要为真，其还需要判断一条规则：

1. 当前的节点已提交的日志中，是否有还未被应用的集群配置变更`ConfChange`消息。

如果当前节点已提交的日志中还有未应用的`ConfChange`消息，那么该节点也无法提拔为leader。

只有当以上条件都满足后，`hup`方法才会调用`campaign`方法，根据配置，开始投票或预投票。

## 2. campaign方法与raft状态转移

