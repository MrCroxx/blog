---
title: "深入浅出etcd/raft —— 0x04 Raft选举"
date: 2020-12-16T19:47:49+08:00
lastmod: 2020-12-16T19:47:52+08:00
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

