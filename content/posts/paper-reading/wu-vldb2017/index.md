---
title: "《An Empirical Evaluation of In-Memory Multi-Version Concurrency Control》论文翻译[持续更新中]"
date: 2020-10-08T16:02:56+08:00
lastmod: 2020-10-08T16:02:56+08:00
draft: false
keywords: []
description: ""
tags: ["MVCC", "Translation"]
categories: ["Paper Reading"]
author: ""
resources:
- name: featured-image
  src: paper-reading.jpg
---

*本篇文章是对论文[An Empirical Evaluation of In-Memory Multi-Version Concurrency Control](https://15721.courses.cs.cmu.edu/spring2019/papers/03-mvcc1/wu-vldb2017.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

## 作者

Yingjun Wu National University of Singapore yingjun@comp.nus.edu.sg

Joy Arulraj Carnegie Mellon University jarulraj@cs.cmu.edu

Jiexi Lin Carnegie Mellon University jiexil@cs.cmu.edu

Ran Xian Carnegie Mellon University rxian@cs.cmu.edu

Andrew Pavlo Carnegie Mellon University pavlo@cs.cmu.edu

## 摘要

多版本并发控制（Multi-version concurrency control，MVCC）目前是现代数据库管理系统（DBMS）中最热门的事务管理策略。尽管MVCC在1970年代晚期就已经被发明出来了，但是在过去的十年中，在几乎所有主要的关系型DBMS中都使用了它。在处理事务时，维护数据的多个版本可以在不牺牲串行性的同时提高并行性。但是在多核和内存的配置中扩展MVCC并非易事：当有大量线程并行运行时，同步带来的开销可能超过多版本带来的好处。

为了理解在现代的硬件配置下处理事务时MVCC如何执行，我们对MVCC的4个关键设计决策进行了大量研究：并发控制协议、版本存储、垃圾回收、和索引管理。我们在内存式DBMS中以最高水平实现了这些所有内容的变体，并通过OLTP负载对它们进行了评估。我们的分析确定了每种设计选择的基本瓶颈。

## 1. 引言

计算机体系结构的进步导致了多核内存式DBMS的兴起，它们使用了高效的事务管理机制以在不牺牲串行性的同时提高并行性。在最近十年的里，在DBMS开发中使用的最流行的策略是*多版本并发控制（multi-version concurrency control，MVCC）*。MVCC的基本想法是，DBMS为数据库中的每个逻辑对象维护多个物理版本，让对同一个对象的操作能够并行执行。这些对象可以是任何粒度上的，但是几乎所有的MVCC DBMS都使用了元组（tuple），因为它在并行性和版本追踪（version tracking）的开销间提供了很好的平衡。多版本化可以让只读的事务访问元组的旧版本，而不会阻止读写事务在同事生成新的版本。这与单版本的系统不同，在单版本系统中，事务总是会在更新一个元组时时用新数据覆写它。

最近DBMS使用MVCC的这一趋势的有趣之处在于，MVCC策略并不是新技术。第一次提到MVCC似乎是在1979年的一篇论文中<sup>[38]</sup>，它的第一个实现始于1981年的InterBase DBMS<sup>[22]</sup>（现在作为Firebird开源）。如今，MVCC还用于一些部署最广泛的面向磁盘的DBMS中，包括Oracle（自1984年起<sup>[4]</sup>），Postgres（自1985年起<sup>[41]</sup>）和MySQL的InnoDB引擎（自2001年起）。但是，尽管有很多与这些较早的系统同时代的系统使用了单版本策略（例如，IBM DB2、Sybase），但是几乎所有新的支持事务的DBMS都避开了单版本策略转而使用MVCC<sup>[37]</sup>。无论商业系统（例如，Microsoft Hekaton<sup>[16]</sup>、SAP HANA<sup>[40]</sup>、MemSQL<sup>[1]</sup>、NuoDB<sup>[3]</sup>）还是学术系统（例如，HYRISE<sup>[21]</sup>、HyPer<sup>[36]</sup>）都是如此。

尽管所有的这些新系统都使用了MVCC，但是MVCC并没有一个“标准”实现。在一些设计中选择了不同的权衡点（trade-off）和性能表现。直到现在，都没有在现代DBMS操作环境中的对MVCC的全面的评估。最近的大量的研究在1980年代<sup>[13]</sup>，但是它在单核CPU上运行的面向磁盘的DBMS中使用了模拟的负载。古老的面向磁盘的DBMS的设计上的选择并不适用于运行在有更多CPU核数的机器上的内存式DBMS。因此，这项过去的研究并不能反映出最近的无锁（latch-free）<sup>[27]</sup>和串行<sup>[20]</sup>的并发控制与内存式存储<sup>[36]</sup>和混合负载<sup>[40]</sup>的趋势。

在本文中，我们对MVCC DBMS中关键的事务管理设计决策进行了研究：（1）并发控制协议（concurrency control protocol）（2）版本存储（version storage）（3）垃圾回收（garbage collection）（4）索引管理（index management）。对于每一个主题，我们都描述了内存式DBMS中的最先进的实现，并讨论了它们的做出的权衡。我们还重点介绍了阻止它们扩展以支持更多线程数和更复杂的负载的问题。作为调研的一部分，我们在内存式MVCC DBMS **Peloton**<sup>[5]</sup>中实现了所有的这些方法。这为我们提供了可以比较这些实现的统一的平台，且不受没实现的架构设计所影响。我们在40核的机器上部署了Peloton，并通过两个OLTP benchmark对其进行评估。我们的分析确定了对我们的实现造成压力的场景，并讨论了缓解它们的方式（如果可能的话）。

## 2. 背景

我们首先提供了MVCC的上层概念的总览。然后讨论了DBMS追踪事务与维护版本信息用的元数据。

### 2.1 MVCC总览

事务管理策略让终端用户能够通过多个程序访问数据库且让每个用户以为自己在一个单独的专用系统上执行<sup>[9]</sup>。它确保了DBMS的原子性和隔离性的保证。

