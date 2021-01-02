---
title: "深入浅出etcd/raft —— 0x06 只读请求优化"
date: 2021-01-01T21:10:17+08:00
lastmod: 2021-01-01T21:10:20+08:00
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

本文介绍了etcd/raft中只读请求算法优化与实现。这里假定读者阅读过Diego Ongaro的《In Search of an Understandable Consensus Algorithm (Extended Version)》（这里有笔者的[翻译](/posts/paper-reading/raft-extended/)，笔者英语水平一般，欢迎指正。），其中提到的部分，本文中不会做详细的解释。对etcd/raft的总体结构不熟悉的读者，可以先阅读[《深入浅出etcd/raft —— 0x02 etcd/raft总体设计》](/posts/code-reading/etcdraft-made-sample/2-overview/)。

## 1. 处理只读请求算法与优化

Raft算法的目标之一是实现**线性一致性（Linearizability）**的语义。一般在介绍“线性一致性”时，会称其为“强一致性”的一种，但笔者认为这种叫法可能会令读者产生误会。本文不会介绍线性一致性的概念，笔者之后可能会专门写一篇介绍各种一致性的文章，或翻译有关一致性的优质文章。有关线性一致性等各种一致性，笔者推荐阅读[Consistency Models. JEPSEN](https://jepsen.io/consistency)与[Strong consistency models. Aphyr](https://aphyr.com/posts/313-strong-consistency-models)，前者对各种一致性进行了全面且正式的介绍，后者通俗地介绍了常用的一致性与其产生的历史等。本文假设读者已经理解线性一致性的含义。

需要注意的，线性一致性的实现不仅与Raft算法本身有关，还与整个系统的实现（即状态机）有关。即使Raft算法本身保证了其日志的故障容错有序共识，但是在通过Raft算法实现系统时，仍会存在有关消息服务质量（Quality of Service，QoS；如至多一次、至少一次、恰好一次等语义问题）、系统整体线性一致性语义等问题。因此《CONSENSUS: BRIDGING THEORY AND PRACTICE》的“Chapter 6 Client interaction”，专门介绍了实现系统时客户端与系统交互的相关问题。需要实现基于Raft算法的读者应详细阅读该章节中介绍的问题与解决方案。

本文仅着眼于只读请求算法优化与实现，因为这一主题与Raft算法本身关系较大，而像“恰好一次”语义等问题的解决方式可能与Raft算法本身关系不大，而是系统实现的常见问题。

### 1.1 Log Read

Raft算法通过Raft算法实现线性一致性读最简单的方法就是让读请求也通过Raft算法的日志机制实现。即将读请求也作为一条普通的Raft日志，在应用该日志时将读取的状态返回给客户端。这种方法被称为**Log Read**。

**Log Read**的实现非常简单，其仅依赖Raft算法已有的机制。但显然，**Log Read**算法的延迟、吞吐量都很低。因为其既有达成一轮共识所需的开销，又有将这条Raft日志落盘的开销。因此，为了优化只读请求的性能，就要想办法绕过Raft算法完整的日志机制。然而，直接绕过日志机制存在一致性问题，因为Raft算法是基于quorum确认的算法，因此即使日志被提交，也无法保证所有节点都能反映该应用了该日志后的结果。

在Raft算法中，所有的日志写入操作都需要通过leader节点进行。只有leader确认一条日志复制到了quorum数量的节点上，才能确认日志被提交。因此，只要仅通过leader读取数据，那么一定是能保证只读操作的线性一致性的。然而，在一些情况下，leader可能无法及时发现其已经不是合法的leader。这一问题在介绍Raft选举算法的**Check Quorum**优化是讨论过这一问题。当网络分区出现时，处于小分区的leader可能无法得知集群中已经选举出了新的leader。如果此时原leader还在为客户端提供只读请求的服务，可能会出现*stale read*的问题。为了解决这一问题，《CONSENSUS: BRIDGING THEORY AND PRACTICE》给出了两个方案：**Read Index**和**Lease Read**。

### 1.2 ReadIndex

显然，只读请求并没有需要写入的数据，因此并不需要将其写入Raft日志，而只需要关注收到请求时leader的*commit index*。只要在该*commit index*被应用到状态机后执行读操作，就能保证其线性一致性。因此使用了**ReadIndex**的leader在收到只读请求时，会按如下方式处理：

1. 记录当前的*commit index*，作为*read index*。
2. 向集群中的所有节点广播一次心跳，如果收到了数量达到quorum的心跳响应，leader可以得知当收到该只读请求时，其一定是集群的合法leader。
3. 继续执行，直到leader本地的*apply index*大于等于之前记录的*read index*。此时可以保证只读操作的线性一致性。
4. 让状态机执行只读操作，并将结果返回给客户端。

可以看出，**ReadIndex**的方法只需要一轮心跳广播，既不需要落盘，且其网络开销也很小。**ReadIndex**方法对吞吐量的提升十分显著，但由于其仍需要一轮心跳广播，其对延迟的优化并不明显。

需要注意的是，实现**ReadIndex**时需要注意一个特殊情况。当新leader刚刚当选时，其*commit index*可能并不是此时集群的*commit index*。因此，需要等到新leader至少提交了一条日志时，才能保证其*commit index*能反映集群此时的*commit index*。幸运的是，新leader当选时为了提交非本term的日志，会提交一条空日志。因此，leader只需要等待该日志提交就能开始提供**ReadIndex**服务，而无需再提交额外的空日志。

通过**ReadIndex**机制，还能实现*follower read*。当follower收到只读请求后，可以给leader发送一条获取*read index*的消息，当leader通过心跳广播确认自己是合法的leader后，将其记录的*read index*返回给follower，follower等到自己的*apply index*大于等于其收到的*read index*后，即可以安全地提供满足线性一致性的只读服务。

### 1.3 Lease Read

**ReadIndex**虽然提升了只读请求的吞吐量，但是由于其还需要一轮心跳广播，因此只读请求延迟的优化并不明显。而**Lease Read**在损失了一定的安全性的前提下，进一步地优化了延迟。

**Lease Read**同样是为了确认当前的leader为合法的leader，但是其实通过心跳与时钟来检查自身合法性的。当leader的*heartbeat timeout*超时时，其需要向所有节点广播心跳消息。设心跳广播前的时间戳为$start$，当leader收到了至少quorum数量的节点的响应时，该leader可以认为其lease的有效期为$[start, start + election \ timeout / clock\ drift\ bound)$。因为如果在$start$时发送的心跳获得了至少quorum数量节点的响应，那么至少要在*election timeout*后，集群才会选举出新的leader。但是，由于不同节点的cpu时钟可能有不同程度的漂移，这会导致在一个很小的时间窗口内，即使leader认为其持有lease，但集群已经选举出了新的leader。这与Raft选举优化*Leader Lease*存在同样的问题。因此，一些系统在实现**Lease Read**时缩小了leader持有lease的时间，选择了一个略小于*election timeout*的时间，以减小时钟漂移带来的影响。

当leader持有lease时，leader认为此时其为合法的leader，因此可以直接将其*commit index*作为*read index*。后续的处理流程与**ReadIndex**相同。

需要注意的是，与**Leader Lease**相同，**Lease Read**机制同样需要在选举时开启**Check Quorum**机制。其原因与**Leader Lease**相同，详见[深入浅出etcd/raft —— 0x03 Raft选举](/posts/code-reading/etcdraft-made-sample/3-election/#13-leader-lease)，这里不再赘述。

{{< admonition info 提示 >}}

有些文章中常常将实现线性一致性只读请求优化**Lease Read**机制和选举优化**Leader Lease**混淆。

**Leader Lease**是保证follower在能收到合法的leader的消息时拒绝其它candidate，以避免不必要的选举的机制。

**Lease Read**时leader为确认自己是合法leader，以保证只通过leader为只读请求提供服务时，满足线性一致性的机制。

{{< /admonition >}}

## 2. etcd/raft中只读请求优化的实现

### 2.1 etcd/raft中ReadIndex方法的使用

在etcd/raft中，使用**ReadIndex**还是**Lease Read**方法由通过`raft`的配置`Config`的`ReadOnlyOption`字段决定的：

```go

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

```

该字段的取值有两种：`ReadOnlySafe`与`ReadOnlyLeaseBased`，分别对应**ReadIndex**方法与**Lease Read**方法：

```go

const (
	// ReadOnlySafe guarantees the linearizability of the read only request by
	// communicating with the quorum. It is the default and suggested option.
	ReadOnlySafe ReadOnlyOption = iota
	// ReadOnlyLeaseBased ensures linearizability of the read only request by
	// relying on the leader lease. It can be affected by clock drift.
	// If the clock drift is unbounded, leader might keep the lease longer than it
	// should (clock can move backward/pause without any bound). ReadIndex is not safe
	// in that case.
	ReadOnlyLeaseBased
)

```

无论是**ReadIndex**方法还是**Lease Read**方法，都需要获取*read index*。`Node`的`ReadIndex`方法就是用来获取*read index*的方法：

```go
	// node.go
	// type Node interface

	// ReadIndex request a read state. The read state will be set in the ready.
	// Read state has a read index. Once the application advances further than the read
	// index, any linearizable read requests issued before the read request can be
	// processed safely. The read state will have the same rctx attached.
	ReadIndex(ctx context.Context, rctx []byte) error

```

当etcd/raft模块的调用者需要获取*read index*时，需要调用`ReadIndex`方法。`ReadIndex`方法不会直接返回*read index*，而是会在后续的`Ready`结构体的`ReadStates`字段中返回多次`ReadIndex`调用对应的`ReadState`。

```go

	// node.go
	// type Ready struct

	// ReadStates can be used for node to serve linearizable read requests locally
	// when its applied index is greater than the index in ReadState.
	// Note that the readState will be returned when raft receives msgReadIndex.
	// The returned is only valid for the request that requested to read.
	ReadStates []ReadState

```

```go

// ReadState provides state for read only query.
// It's caller's responsibility to call ReadIndex first before getting
// this state from ready, it's also caller's duty to differentiate if this
// state is what it requests through RequestCtx, eg. given a unique id as
// RequestCtx
type ReadState struct {
	Index      uint64
	RequestCtx []byte
}

```

为了让调用者能够区分`ReadState`是哪次调用的结果，`ReadIndex`方法需要传入一个唯一的`rctx`字段进行标识，之后相应的的`ReadState`的`RequestCtx`字段会透传`rctx`的值，以便调用者区分多次调用的结果。

当调用者应用的日志的index大于等于`ReadState`的`Index`字段的值时，就可以安全地执行相应的只读请求并返回结果。

### 2.2 etcd/raft中获取read index的实现

#### 2.2.1 readOnly结构体

在分析etcd/raft中获取*read index*的实现使用了`raft`结构体中的两个字段：`readStates`与`readOnly`。`readStates`字段是已经获取的*read index*，etcd/raft返回的下一个`Ready`结构体的`ReadStates`字段会获取`readStates`字段中的全量数据并清空该字段。而`readOnly`字段就是一个`readOnly`结构体的指针。`readOnly`结构体是leader仅使用**ReadIndex**时，用来记录等待心跳确认的*read index*的结构体，其声明如下：

```go

type readOnly struct {
	option           ReadOnlyOption
	pendingReadIndex map[string]*readIndexStatus
	readIndexQueue   []string
}

```

`readOnly`结构体的`option`字段记录了etcd/raft配置中实现*read index*的方法。`readIndexQueue`是多次调用`ReadIndex`方法时产生的`rctx`参数队列，其反映了`ReadIndex`的调用顺序。`pendingReadIndex`是`rctx`到其相应的状态`readIndexStatus`的映射。`readIndexStatus`结构体的`req`字段记录了该`rctx`对应的原消息（在发送该消息的响应时需要用到），`index`字段记录了待确认的*read index*的值，`ack`字段记录了已收到的确认该*read index*的心跳响应。

```go

type readIndexStatus struct {
	req   pb.Message
	index uint64
	// NB: this never records 'false', but it's more convenient to use this
	// instead of a map[uint64]struct{} due to the API of quorum.VoteResult. If
	// this becomes performance sensitive enough (doubtful), quorum.VoteResult
	// can change to an API that is closer to that of CommittedIndex.
	acks map[uint64]bool
}

```


如果`readOnly`的`option`字段的值为`ReadOnlyLeaseBased`，说明*read index*的实现使用了**Lease Read**，不需要在获取*read index*前广播心跳，因此不会用到`pendingReadIndex`与`readIndexQueue`字段。

`readOnly`还封装了如下方法：

| 方法<div style="width: 12em"></div> | 描述 |
| :-: | :- |
| `addRequest(index uint64, m pb.Message)` | 在广播用来确认*read index*的心跳消息前，需要调用该方法将该*read index*加入待确认队列。 |
| `recvAck(id uint64, context []byte) map[uint64]bool` | 当收到确认*read index*的心跳响应时，需要调用该方法更新该*read index*的确认状态，该方法会返回收到的确认心跳响应的发送者的id集合。 |
| `advance(m pb.Message) []*readIndexStatus` | 当有*read index*得到了达到quorum数量节点的ack时，调用该方法返回相应的`ReadState`，并从待确认的队列中移除相应的*read index*及其状态。该方法支持批量与流水线操作，因为如果队列中靠后的*read index*被确认，则其之前的*read index*也可以确认，因此该方法会返回所有已确认的`ReadState`。 |
| `lastPendingRequestCtx() string` | 该方法用来获取待确认的最后一条*read index*对应的`rctx`。在*heartbeat timeout*超时构造心跳消息时，其携带的*read index*标识为最后一条待确认的*read index*的标识，因为如果队列中靠后的*read index*被确认，则其之前的*read index*也可以确认，该方法是为支持批量与流水线操作而设计的。 |

#### 2.2.2 获取read index流程与实现

`Node`接口的`ReadIndex`方法会为Raft状态机应用一条`MsgReadIndex`消息。etcd/raft实现了**Follower Read**（[1.2节](#12-readindex)介绍了**Follower Read**的简单实现），即follower需要将获取*read index*的请求转发给leader，leader确认自己是合法的leader后将*read index*返回给follower，然后follower根据其自己的*apply index*与*read index*确定什么时候可以执行只读请求。因此，如果应用`MsgReadIndex`消息的节点是follower，其会将该请求转发给leader：

```go

	// stepFollower
	// ... ...

	case pb.MsgReadIndex:
		if r.lead == None {
			r.logger.Infof("%x no leader at term %d; dropping index reading msg", r.id, r.Term)
			return nil
		}
		m.To = r.lead
		r.send(m)

```

当leader处理`MsgReadIndex`请求时（可能来自本地节点，也可能来自follower），其会执行如下逻辑：

```go

	case pb.MsgReadIndex:
		// only one voting member (the leader) in the cluster
		if r.prs.IsSingleton() {
			if resp := r.responseToReadIndexReq(m, r.raftLog.committed); resp.To != None {
				r.send(resp)
			}
			return nil
		}

		// Reject read only request when this leader has not committed any log entry at its term.
		if !r.committedEntryInCurrentTerm() {
			return nil
		}

		// thinking: use an interally defined context instead of the user given context.
		// We can express this in terms of the term and index instead of a user-supplied value.
		// This would allow multiple reads to piggyback on the same message.
		switch r.readOnly.option {
		// If more than the local vote is needed, go through a full broadcast.
		case ReadOnlySafe:
			r.readOnly.addRequest(r.raftLog.committed, m)
			// The local node automatically acks the request.
			r.readOnly.recvAck(r.id, m.Entries[0].Data)
			r.bcastHeartbeatWithCtx(m.Entries[0].Data)
		case ReadOnlyLeaseBased:
			if resp := r.responseToReadIndexReq(m, r.raftLog.committed); resp.To != None {
				r.send(resp)
			}
		}
		return nil
	}

```

首先，leader检查当前是否是以单节点模式运行的（即voter集合是否只有一个节点，但可以有任意数量的learner），如果是，那么该leader一定是合法的leader，因此可以直接返回相应的`ReadState`。返回`ReadState`的方法为`responseToReadIndexReq`方法。该方法会判断获取*read index*的请求是来自leader本地还是来自follower，如果来自本地则直接将相应的`ReadState`追加到当前`raft`结构体的`readStates`字段中，并返回空消息；如果请求时来自follower，该方法会返回一条用来发送给相应follower的`MsgReadIndexResp`消息。因此，如果`responseToReadIndexReq`方法返回的请求的`To`字段为0，不需要做额外的处理；如果`To`字段非0，则需要将该消息放入信箱等待发送。

接着，leader需要判断当前的term是否提交过日志，这是为了解决[1.2节](#12-readindex)中提到的新leader当选时*commit index*落后的问题。如果leader在当前term还没提交过消息，则其会忽略该`MsgReadIndex`消息。

然后，leader会根据配置的获取*read index*的方法执行不同的逻辑。当使用**Lease Read**时，leader可以直接返回相应的`ReadState`，因为etcd/raft的**Lease Read**是通过**Check Quorum**实现的。即只要leader没有退位，说明其仍持有lease；而当leader无法为lease续约时，**Check Quorum**机制会让leader退位为follower，其也就不会通过`stepLeader`方法处理`MsgReadIndex`请求。

当仅使用**ReadIndex**时，leader会将当前的*commit index*作为*read index*并通过`readOnly`的`addRequest`方法将其加入到待确认的队列中。然后leader节点自己先确认该*read index*，然后广播心跳等待其它节点确认该*read index*。leader在主动请求确认*read index*时，发送的心跳消息携带的`rctx`就是该*read index*相应的`rctx`；而当leader因*heartbeat timeout*超时而广播心跳消息时，携带的是待确认的最后一条*read index*相应的`rctx`，以批量确认所有待确认的*read index*。

```go

// bcastHeartbeat sends RPC, without entries to all the peers.
func (r *raft) bcastHeartbeat() {
	lastCtx := r.readOnly.lastPendingRequestCtx()
	if len(lastCtx) == 0 {
		r.bcastHeartbeatWithCtx(nil)
	} else {
		r.bcastHeartbeatWithCtx([]byte(lastCtx))
	}
}

func (r *raft) bcastHeartbeatWithCtx(ctx []byte) {
	r.prs.Visit(func(id uint64, _ *tracker.Progress) {
		if id == r.id {
			return
		}
		r.sendHeartbeat(id, ctx)
	})
}

```

follower在响应心跳消息时，会透传记录了`rctx`的`Context`字段，当leader收到心跳响应时，会根据该字段更新待确认的*read index*的状态：

```go

	// stepLeader
	// ... ...

	case pb.MsgHeartbeatResp:
		
		// ... ...

		if r.readOnly.option != ReadOnlySafe || len(m.Context) == 0 {
			return nil
		}

		if r.prs.Voters.VoteResult(r.readOnly.recvAck(m.From, m.Context)) != quorum.VoteWon {
			return nil
		}

		rss := r.readOnly.advance(m)
		for _, rs := range rss {
			if resp := r.responseToReadIndexReq(rs.req, rs.index); resp.To != None {
				r.send(resp)
			}
		}

```

当仅使用**ReadIndex**时，leader在收到心跳响应时会更新待确认的*read index*的状态。如果*read index*收到了达到quorum数量的相应，则可以确认该*read index*及其之前的所有*read index*，返回相应的`ReadState`。

## 3. 总结

本文介绍了etcd/raft中只读请求算法优化与实现。etcd/raft中只读请求优化几乎完全是按照论文实现的。在其它的一些基于Raft算法的系统中，其实现的方式可能稍有不同，如不通过**Check Quorum**实现leader的lease，而是通过日志复制消息为lease续约，且lease的时间也小于*election timeout*，以减小时钟漂移对一致性的影响。

## 参考文献

<div class="reference">

[1] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm[C]//2014 {USENIX} Annual Technical Conference ({USENIX}{ATC} 14). 2014: 305-319.

[2] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm (extended version)[J]. Retrieved July, 2016, 20: 2018.

[3] Ongaro D. Consensus: Bridging theory and practice[D]. Stanford University, 2014.

[4] [Consistency Models. JEPSEN](https://jepsen.io/consistency)

[5] [Strong consistency models. Aphyr](https://aphyr.com/posts/313-strong-consistency-models)

</div>