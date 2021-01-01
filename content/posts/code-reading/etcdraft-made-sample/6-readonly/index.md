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

本文会对etcd/raft中只读请求算法优化与实现。这里假定读者阅读过Diego Ongaro的《In Search of an Understandable Consensus Algorithm (Extended Version)》（这里有笔者的[翻译](/posts/paper-reading/raft-extended/)，笔者英语水平一般，欢迎指正。），其中提到的部分，本文中不会做详细的解释。对etcd/raft的总体结构不熟悉的读者，可以先阅读[《深入浅出etcd/raft —— 0x02 etcd/raft总体设计》](/posts/code-reading/etcdraft-made-sample/2-overview/)。

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

## 施工中 ... ...



## 参考文献

<div class="reference">

[1] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm[C]//2014 {USENIX} Annual Technical Conference ({USENIX}{ATC} 14). 2014: 305-319.

[2] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm (extended version)[J]. Retrieved July, 2016, 20: 2018.

[3] Ongaro D. Consensus: Bridging theory and practice[D]. Stanford University, 2014.

[4] [Consistency Models. JEPSEN](https://jepsen.io/consistency)

[5] [Strong consistency models. Aphyr](https://aphyr.com/posts/313-strong-consistency-models)

</div>