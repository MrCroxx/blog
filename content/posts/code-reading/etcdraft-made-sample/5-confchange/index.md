---
title: "深入浅出etcd/raft —— 0x05 成员变更"
date: 2020-12-29T16:36:16+08:00
lastmod: 2020-12-29T16:36:19+08:00
draft: false
keywords: []
description: ""
tags: ["etcd", "Raft"]
categories: ["深入浅出etcd/raft"]
author: ""
resources:
- name: featured-image
  src: etcd-raft.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

## 0. 引言

本文会对etcd/raft中Raft成员变更算法的实现与优化进行分析。这里假定读者阅读过Diego Ongaro的《In Search of an Understandable Consensus Algorithm (Extended Version)》（这里有笔者的[翻译](/posts/paper-reading/raft-extended/)，笔者英语水平一般，欢迎指正。），其中提到的部分，本文中不会做详细的解释。对etcd/raft的总体结构不熟悉的读者，可以先阅读[《深入浅出etcd/raft —— 0x02 etcd/raft总体设计》](/posts/code-reading/etcdraft-made-sample/2-overview/)。

{{< admonition info 提示 >}}

本文不严格区分成员变更（membership changes）与配置变更(configuration chagnes)。

{{< /admonition >}}

## 1. 成员变更算法

《CONSENSUS: BRIDGING THEORY AND PRACTICE》的*Chapter 4 Cluster membership changes*介绍了两种成员变更算法，一种是一次操作一个节点的简单算法，另一种是联合共识（joint consensus）算法。两种算法都是为了避免由于节点切换配置时间不同导致的同一term出现不只一个leader的问题，如下图所示。

![由于不同节点切换配置时间不同而导致的多主问题](assets/disjoint.png "由于不同节点切换配置时间不同而导致的多主问题")

为了本文的连贯性，这里简单地介绍一下这两种算法，详细内容请读者自行阅读《CONSENSUS: BRIDGING THEORY AND PRACTICE》的*Chapter 4 Cluster membership changes*。

简单成员变更算法限制每次只能增加或移除一个节点。这样可以保证新配置与旧配置的quorum至少有一个相同的节点，因为一个节点在同一term仅能给一个节点投票，所以这能避免多主问题。

![简单成员变更算法](assets/simple-membership-changes.png "简单成员变更算法")

联合共识算法可以一次变更多个成员，但是需要在进入新配置前先进入一个“联合配置（joint configuration）”，在联合配置的quorum分别需要新配置和旧配置的majority（大多数）节点，以避免多主问题。当联合配置成功提交后，集群可以开始进入新配置。

![联合共识算法](assets/joint-consensus.png "联合共识算法")

etcd/raft的`ConfChangeV2`既支持简单的“one at a time”的成员变更算法，也支持完整的联合共识算法。需要注意的是，etcd/raft中的配置的应用时间与论文中的不同。在论文<sup>引文1</sup>中，节点会在追加配置变更日志时应用相应的配置，而在etcd/raft的实现中<sup>引文2</sup>，当节点应用（apply）配置变更日志条目时才会应用相应的配置。

{{< admonition danger 注意 >}}

这种"apply-time"的方式仍存在一些“liveness”的问题，在编写本文时，etcd社区正在修复这一问题（详见[issue#12359 raft: liveness problems during apply-time configuration change](https://github.com/etcd-io/etcd/issues/12359)）。

本文中的源码基于master分支的[commit#a3174d0](https://github.com/etcd-io/etcd/tree/a3174d0f8ec6ec58827d7d86448bb4df08ae69e4)版本，目前还没有修复这一issue。本文会在issue修复后，基于新版算法进行修改。

{{< /admonition >}}


另外，需要注意的是，同一时间只能有一个正在进行的配置变更操作，在提议配置变更请求时，如果已经在进行配置变更，那么该提议会被丢弃（被改写成一条无任何意义的日志条目）。

{{< admonition quota 引文1 >}}

The new configuration takes effect on each server as soon as it is added to that server’s log: the $C_{new}$ entry is replicated to the $C_{new}$ servers, and a majority of the new configuration is used to determine the $C_{new}$ entry’s commitment. This means that servers do not wait for configuration entries to be committed, and each server always uses the latest configuration found in its log.

... ...

As with the single-server configuration change algorithm, each server starts using a new configuration as soon as it stores the configuration in its log.

{{< /admonition >}}


{{< admonition quota 引文2 >}}

Note that contrary to Joint Consensus as outlined in the Raft paper, configuration changes become active when they are *applied* to the state machine (not when they are appended to the log).

{{< /admonition >}}

## 2. etcd/raft配置的实现

etcd/raft实现的配置是按照*joint configuration*组织的，本节笔者将以自底向上的方法介绍etcd/raft中配置的实现。

### 2.1 MajorityConfig

在*joint consensus*中，中间状态$C_{old},C_{new}$的quorum同时需要$C_{old}$和$C_{new}$各自的majority。$C_{old}$或$C_{new}$配置中voter的集合（voter即有投票权的角色，包括candidate、follower、leader，而不包括learner），是通过`MajorityConfig`表示的，`MajorityConfig`还包括了一些统计majority信息的方法。

```go

// MajorityConfig is a set of IDs that uses majority quorums to make decisions.
type MajorityConfig map[uint64]struct{}

```

`MajorityConfig`的实现非常简单，其只是voter节点id的集合，但`MajorityConfig`提供了一些很实用的与majority有关方法，如下表所示（仅给出主要方法）：

| 方法<div style="width: 14em"></div> | 描述 |
| :-: | :- |
| `CommittedIndex(l AckedIndexer) Index` | 根据给定的`AckedIndexer`计算被大多数节点接受了的*commit index* 。 |
| `VoteResult(votes map[uint64]bool) VoteResult` | 根据给定的投票统计计算投票结果。 |

`CommittedIndex`是根据该`MajorityConfig`计算被大多数接受的*commit index*，其参数`AckedIndexer`是一个接口：

```go

// quorum.go

// AckedIndexer allows looking up a commit index for a given ID of a voter
// from a corresponding MajorityConfig.
type AckedIndexer interface {
	AckedIndex(voterID uint64) (idx Index, found bool)
}

// tracker.go

type matchAckIndexer map[uint64]*Progress

// AckedIndex implements IndexLookuper.
func (l matchAckIndexer) AckedIndex(id uint64) (quorum.Index, bool) {
	pr, ok := l[id]
	if !ok {
		return 0, false
	}
	return quorum.Index(pr.Match), true
}

```

`AckedIndexer`接口中只定义了一个方法`AckedIndex`，该方法用来返回给定id的voter的一种索引的值。通过实现该接口与方法，在调用`CommittedIndex`时，可以根据不同的index来计算被大多数接受的*commit index*。上面的源码中给出了*tracker.go*中的一种`AckedIndexer`实现——`matchAckIndexer`，其实现的`AckedIndex`方法返回了voter的*match index*。etcd/raft在计算*commit index*时，就是根据节点的*match index*来计算的。

`CommittedIndex`的实现也很简单，其通过排序来计算第$n/2+1$小的索引，即为被大多数节点接受的最小索引。该方法中还有针对小切片的分配优化，感兴趣的读者可以自行阅读源码，这里不再赘述。

`VoteResult`方法的实现也很简单，其根据参数中的投票情况与该`MajorityConfig`中的voter，计算投票结果。投票结果有三种：`VoteWon`表示赢得投票、`VoteLost`表示输掉投票、`VotePending`表示投票还未完成（既没被大多数接受，也没被大多数拒绝），需要继续等待投票。

## 3. etcd/raft配置变更的实现

## 施工中

## 参考文献

<div class="reference">

[1] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm[C]//2014 {USENIX} Annual Technical Conference ({USENIX}{ATC} 14). 2014: 305-319.

[2] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm (extended version)[J]. Retrieved July, 2016, 20: 2018.

[3] Ongaro D. Consensus: Bridging theory and practice[D]. Stanford University, 2014.

</div>