---
title: "《Spanner: Google’s Globally-Distributed Database》论文翻译[持续更新中]"
date: 2020-10-23T13:00:19+08:00
lastmod: 2020-10-23T13:00:22+08:00
draft: false
keywords: []
description: ""
tags: ["Spanner", "Translation"]
categories: ["Paper Reading"]
author: ""
resources:
- name: featured-image
  src: paper-reading.jpg
---

*本篇文章是对论文[In Search of an Understandable Consensus Algorithm (Extended Version)](http://pages.cs.wisc.edu/~remzi/Classes/739/Spring2004/Papers/raft.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 作者

James C. Corbett, Jeffrey Dean, Michael Epstein, Andrew Fikes, Christopher Frost, JJ Furman, Sanjay Ghemawat, Andrey Gubarev, Christopher Heiser, Peter Hochschild, Wilson Hsieh,Sebastian Kanthak, Eugene Kogan, Hongyi Li, Alexander Lloyd, Sergey Melnik, David Mwaura, David Nagle, Sean Quinlan, Rajesh Rao, Lindsay Rolig, Yasushi Saito, Michal Szymaniak, Christopher Taylor, Ruth Wang, Dale Woodford

Google, Inc.

## 摘要

Spanner是Google的可伸缩（scalable）、多版本（multi-version）、全球化分布式（globally-distributed）、同步多副本（synchronously-replicated）数据库。它是在全球范围分布数据的系统，支持外一致性（externally-consistent）分布式事务。本文描述了Spanner的结构、特性、多种底层设计决策的原理、和一种暴露时钟不确定度（uncertainty）的新型时间API。该API和它的实现对支持外一致性和多种强大的特性来说非常重要，这些特性包括：跨所有Spanner的过去数据的非阻塞读取、无锁只读事务、和原子性模型（schema）修改。

## 1. 引言

Spanner是一个可伸缩、全球化分布的数据库，其由Google设计、构建、并部署。在抽象的最高层，Spanner是一个分布在全世界的多个数据中心中的跨多个Paxos<sup>[21]</sup>状态机集合分片（shard）数据的数据库。副本被用作全球的可用性和地理位置优化；client自动地在副本间进行故障转移。在数据总量或服务器的数量变化时，Spanner自动地跨机器重分片数据，并自动地在机器间（甚至在数据中心间）迁移数据来平衡负载和应对故障。Spanner被设计为能扩展到跨数百个数据中心的数百万台机器与数万亿个数据库行。

应用程序可以使用Spanner来实现高可用，即使在面对大范围自然灾害时，Spanner也可以通过在大洲内甚至跨大洲间备份数据。我们最初的使用者是F1<sup>[35]</sup>,F1是对Google的广告后端的重写。F1使用了5份分布在美国的副本。大部分的其它的应用程序可能在同一个地理区域但故障模式相对独立的3到5个数据中心中备份数据。因此，大多数应用程序选择了低延迟而不是高可用，只要它们能够容忍1或2个数据中心故障即可。

Spanner的主要目标是管理跨数中心的副本数据，但是我们还花了很多时间设计并实现了在我们的分布式系统基础架构之上的重要的数据库特性。尽管Bigtable<sup>[9]</sup>能够很好地满足很多项目的需求，但我们还是不断收到用户的抱怨，生成Bigtable对一些类型的应用程序来说难以使用：如那些有复杂、不断演进的模型的程序或那些想要在广域副本中维护强一致性的程序。（其他作者也提出了类似的主张<sup>[37]</sup>。）Google的许多应用程序选择使用Megastore<sup>[5]</sup>，因为它支持半结构化数据模型和副本同步，尽管它的写入吞吐量相对较弱。为此，Spanner从一个类似Bigtable的版本化键值存储（versioned key-value store）演进成了一个多版本时态数据库（temporal multi-version database）。数据被存储在模型化的半关系型表中；数据被版本化，且每个版本自动按照提交时间标记时间戳；旧版本遵循可配置的垃圾回收策略；应用程序可以读取旧实践出ode数据。Spanner支持通用的事务，且提供了基于SQL的查询语言。

作为全球化分布的数据库，Spanner提供了许多有趣的特性。第一，应用程序可以细粒度地动态控制数据的副本配置。应用程序可以执行约束来控制那个数据中心包含哪些数据、数据离它的用户多远（以控制读取延迟）、副本间多远（以控制写入延迟）、维护了多少份副本（以控制持久性、可用性、和读取性能）。数据还能被系统动态、透明地在数据中心间迁移以平衡数据中心间的资源使用率。第二，Spanner有两个在分布式数据库中难以实现的两个特性：Spanner提供了外一致性（externally-consistent）<sup>[16]</sup>读写和对一个时间戳的跨数据库全球一致性读取。这些特性让Spanner能支持一致性备份（consistent backups）、一致性MapReduce执行<sup>[12]</sup>和原子性模型更新，这些操作全在全球范围，甚至在正在进行的事务中。

这些特性有效的原因在于，Spanner会为事务分配在全局都有意义的提交时间戳，尽管事务可能是分布式的。该时间戳反映了串行顺序。另外，串行顺序满足外一致性（或等价的线性一致性<sup>[20]</sup>）：如果事务$T_1$在另一个事务$T_2$开始前提交，那么$T_1$的时间戳比$T_2$的小。Spanner是首个能在全球范围提供这些保证的系统。

实现这些属性的关键是一个新的TrueTime API及其实现。该API直接暴露了时钟不确定度，并保证了Spanner的时间戳基于其实现提供的边界内。如果不确定度较大，Spanner会减速以等待该不确定度。Google的集群管理软件提供了TureTime API的一种实现。该实现通过使用多种现代时钟参考（GPS和原子时钟）来让不确定度保持较小（通常小于10ms）。

[第二章](#2-)描述了Spanner实现的结构、它的特定集合、和渗透进设计中的工程决策。[第三章](#3-)描述了我们的新TureTime API并概述了其实现。[第四章](#4-)描述了Spanner如何使用TrueTime来实现具有外一致性的分布式事务、无锁只读事务、和原子性模型更新。[第五章](#5-)提供了Spanner性能和TrueTime表现的一些benchmark，并讨论了F1的经验。[第六、七、八章](#6-)，描述了相关工作和展望，并总结了我们的结论。

## 2. 实现

本章描述了Spanner的结构和Spanner底层实现的原理。然后，我们描述了*directory*抽象，其被用作管理副本和局部性（locality），它还是数据移动的单元。最后，我们描述了我们的数据模型、为什么Spanner看上去像关系型数据库而不是键值存储、怎样能让应用程序控制数据的局部性。

一份Spanner的部署被称为一个*universe*。因为Spanner在全球范围管理数据，所以只有少数的几个运行中的universe。我们目前运行了一个测试/练习场universe、一个开发/生产universe、和一个仅生产的universe。

Spanner被组织为*zone*的集合，每个zone都大致类似于一份Bigtable服务器集群<sup>[9]</sup>的部署。zone是管理部署的单位。zone的集合还是数据能够跨位置分布的位置集合。当有新的数据中心加入服务或旧的数据中心被关闭时，zone可以加入运行中的系统或从运行中的系统移除。zone也是物理隔离的单元：在一个数据中心中可能有一个或多个zone，例如，如果不同的应用程序的数据必须跨同数据中心的不同的服务器的集合分区时会出现这种情况。

![图1 spanner服务器组织结构。](figure-1.png "图1 spanner服务器组织结构。")

**图1**描述了Sppanner universe中的服务器。一个zone有一个*zonemaster*和几百到几千个*spanserver*。前者为spannerserver分配数据，后者向client提供数据服务。客户端使用每个zone的*location proxy*来定位其分配到的为其提供数据服务的spanserver。*universe master*和*placement driver*目前是单例。universe master主要是一个控制台，其显示了所有zone的状态信息，以用来交互式调试。placement driver分钟级地处理zone间的自动化迁移。placement driver定期与spanserver交互来查找需要移动的数据，以满足更新后的副本约束或平衡负载。出于空间的原因，我们仅详细描述spanserver。

### 2.1 spanserver软件栈

本节着眼于spanserver的实现以阐述副本和分布式事务如何被分层到我们的基于Bigtable的实现中。软件栈如**图2**所示。在最底层，每个spanserver负责100到1000个被称为*tablet*的数据结构实例。每个tablet都类似于Bigtable的tablet抽象，其实现了一系列如下的映射：

$$ (key:string, timestamp:int64) \rightarrow string $$

![图2 spanserver软件栈。](figure-2.png "图2 spanserver软件栈。")

不像Bigtable，Spannner为数据分配时间戳，这是一种让Spanner更像多版本数据库而不是键值存储的重要的方式。tablet的状态被保存在一系列类B树的文件和一个预写日志（write-ahead log，WAL）中，它们都在一个被称为Colossus的分布式文件系统中（Google File System<sup>[15]</sup>的继任者）。

为了支持副本，每个spanserver在每个tablet上实现了一个Paxos状态机。（早期的Spanner原型支持为每个tablet实现多个Paxos状态机，这让副本配置更加灵活。但是其复杂性让我们放弃了它。）每个状态机在它相关的tablet中保存其元数据和日志。我们的Paxos实现通过基于事件的leader租约来支持长期领导者，租约的默认长度为10秒。目前Spanner的实现记录每次Paxos写入两次：一次在tablet的日志中，一次在Paxos的日志中。这种选择是权宜之策，我们最终很可能会改进这一点。我们的Paxos实现是流水线化的，以在有WAN延迟的情况下提高Spanner的吞吐量；但是Paxos会按顺序应用写入（[第四章](#4-)会依赖这一点）。

