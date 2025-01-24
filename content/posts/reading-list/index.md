---
title: "[Pinned] Reading List"
date: 2024-07-26T19:00:00+08:00
lastmod: 2024-07-26T19:00:00+08:00
draft: false
keywords: []

description: ""
tags: ["Reading List"]
categories: ["Reading List"]
author: ""
featuredImage: index.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

碎碎念：在更了很多论文翻译后，发现翻译论文实在太花费精力了，而且英语水平有限，翻译质量也不高；另外，需要看这些论文的小伙伴英语似乎也不差，就不再献丑了。所以之后遇到的比较好的 paper 或者 blog 我会不定期地分类整理在这里。

本文主要列出较为系统的文献，比较碎片的材料后续我会同步到我的 telegram channel [What does MrCroxx read?](https://t.me/whatdoesmrcroxxread) 中。

## System
- [Memory Models](https://research.swtch.com/mm) Plan 9 与 Go 语言的作者 Russ Cox 关于 memory models 的三篇 blog。从硬件、编程语言、Go 语言的视角自底向上地介绍了 memory models。
- **Linux Kernel Development (Third Edition)** 《Linux 内核设计与实现》的英文原版。建议在阅读 Linux 源码时作为工具书看。最早看的时候还没有深入接触过 Linux 源码，所以感觉书比较流水账。但是工作需要深入查 fs 和 bio 层源码的时候，很多关键的比较难懂的地方可以在这本书里找到。
- [Practical lock-freedom](https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-579.pdf) 一本比较详细介绍无锁编程和无锁数据结构等内容的书，比较硬。

## BigData Infra

- [The Google File System](https://dl.acm.org/doi/pdf/10.1145/945445.945450) Google 老三篇之一，GFS、BigTable、MapReduce 三篇 paper 基本上可以看做从此开创了大数据时代。
- [MapReduce: simplified data processing on large clusters](https://dl.acm.org/doi/abs/10.1145/1327452.1327492) Google 老三篇之一，提出了 MapReduce 模型，也是大数据时代开山之作之一。
- [Spark: Cluster Computing with Working Sets](https://www.usenix.org/legacy/event/hotcloud10/tech/full_papers/Zaharia.pdf) Spark 的 paper，分析了 MapReduce 在迭代计算、编程模型等上的不足，很详细地介绍了 Spark 最初为了解决的问题。


## Consensus

- [The part-time parliament](https://dl.acm.org/doi/pdf/10.1145/3335772.3335939) Paxos 开山之作，祖师爷 Leslie Lamport 一个人的成果差不多养活了一个行业，这篇写的比较晦涩，建议拜读一下。
- [Paxos Made Simple](https://courses.cs.washington.edu/courses/cse550/17au/papers/CSE550.paxos-simple.pdf) 因为 Paxos 最初的 paper 写的太晦涩，Lamport 老爷子亲自下场解释 Paxos 其实很简单，提供了完整、清晰的数学证明（作为工程背景的读起来仍然很难 orz）。
- [Paxos made live: an engineering perspective](https://dl.acm.org/doi/abs/10.1145/1281100.1281103) 从工程的角度介绍了 Paxos 算法在 Chubby 上的的使用，提出了 Multi-Paxos。*注：Multi-Paxos 与 Multi-Raft 的 Multi 一般所指的并非为一个问题。Multi-Paxos 的 Multi 指连续的多次 Paxos 算法对连续的 log 达成 linearizability 共识；Multi-Raft 的 Multi 一般指 sharding 系统中每个 shard 通过单独的 Raft Group 维护副本一致性。*
- [In Search of an Understandable Consensus Algorithm (Extended Version)](https://people.eecs.berkeley.edu/~kubitron/courses/cs262a-F18/handouts/papers/raft-technicalReport.pdf) Raft 算法的小论文，终于有能让工程背景的容易理解的满足 Linearizability Consistency 的 Consensus 算法了。
- [CONSENSUS: BRIDGING THEORY AND PRACTICE](http://files.catwell.info/misc/mirror/2014-ongaro-raft-phd.pdf) Diego Ongaro 的 Ph.D thesis，详细介绍了 Raft 算法，并提出了很多优化点与形式化证明，其中的大部分优化点至今都在工业界使用。


## LSM-Tree

- [The log-structured merge-tree (LSM-tree)](https://link.springer.com/article/10.1007/s002360050048) 最早提出 LSM-Tree 的 paper，其中很多设计与假设已经发生了变化。
- [Bigtable: A Distributed Storage System for Structured Data](https://dl.acm.org/doi/abs/10.1145/1365815.1365816) Google 老三篇之一，重新捡起了 LSM-Tree 存储格式。
- [WiscKey: Separating Keys from Values in SSD-Conscious Storage](https://dl.acm.org/doi/abs/10.1145/3033273) WiscKey 的 paper，基于 KV 分离优化 LSM-Tree 写放大的开篇，BadgerDB、Titan、TerarkDB 都是基于类似思想在工业实现上的变种。
- [PebblesDB: Building Key-Value Stores using Fragmented Log-Structured Merge Trees](https://dl.acm.org/doi/abs/10.1145/3132747.3132765) 引入了 Guard 允许 Guard 划分的区间内 SSTable Keyspace overlap 以减少 Compaction 写放大。
- [https://ieeexplore.ieee.org/abstract/document/9556071](Building A Fast and Efficient LSM-tree Store by Integrating Local Storage with Cloud Storage) 根据 EC2 Instance Store 与 EBS 的性能、计费差异分层存储 LSM-Tree 的工作。

## Scylla Userspace I/O Scheduler

Scylla 使用 Seastar 作为 c++ 的异步编程 runtime，Seastar 是一个 thread-per-core 的 runtime，也是在 thread-per-core 的 disk I/O 方面做的比较领先的框架，同时 Scylla 的 blog 写的也很详细。

- [Different I/O Access Methods for Linux, What We Chose for Scylla, and Why](https://www.scylladb.com/2017/10/05/io-access-methods-scylla/) 总结了各种 disk I/O 访问模式，做了比较详细的分析，很有学习价值（不过当时还没有 io_uring ）。
- [Qualifying Filesystems for Seastar and ScyllaDB](https://www.scylladb.com/2016/02/09/qualifying-filesystems/) 测试了当时不同文件系统对 AIO 的支持。
- [Designing a Userspace Disk I/O Scheduler for Modern Datastores: the Scylla example (Part 1)](https://www.scylladb.com/2016/04/14/io-scheduler-1/) 和 [Designing a Userspace Disk I/O Scheduler for Modern Datastores: the Scylla example (Part 2)](https://www.scylladb.com/2016/04/29/io-scheduler-2/) 16年两篇介绍 Seastar 当时 Userspace I/O Scheduler 的博客，介绍并分析了 Seastar 基于 AIO/DIO 与 thread-per-core 的 Userspace I/O Scheduler 的背景、设计、效果，介绍了基于次线性函数与指数衰减的 quota 分配策略。
- [The Scylla I/O Scheduler](https://www.scylladb.com/2018/04/19/scylla-i-o-scheduler-3/) 18年的 blog 介绍了在16年原有工作上的优化，通过基于 Little's Law 计算的 concurrency 替代了之前基于经验的 concurrency limit 方法。
- [Exploring How the Scylla Data Cache Works](https://www.scylladb.com/2018/07/26/how-scylla-data-cache-works/) 介绍了 Scylla 的 cell-based format 的 Cache 设计，其中包括引入 Seastar 调度 I/O 前后对 cache refill 时对前台 latency jitter 的优化。
- [Scylla’s New IO Scheduler](https://www.scylladb.com/2021/04/06/scyllas-new-io-scheduler/) 21年的优化，解决 thread-per-core 架构在 core 过多超过 disk I/O 能力时的调度问题。

## Deal with fsync() failure

之前在P社实习遇到过写 WAL 时 fsync error 处理的问题，调研了一下相关工作之后发现这坑居然比想的要深，其中做的比较好的是 PostgreSQL 的工作。

- [PostgreSQL talk](https://archive.fosdem.org/2019/schedule/event/postgresql_fsync/) PostgreSQL 在 FOSDEM'19 上做的 talk，很清晰地总结了他们在处理 PostgreSQL WAL fsync error 时遇到的问题和解决方案。
- [Can Applications Recover from fsync Failures?](https://www.usenix.org/system/files/atc20-rebello.pdf) ATC'20 paper，分析了 PostgreSQL、LMDB、LevelDB、SQLite 与 Redis 对 fsync 的处理方式，以及不同文件系统 fsync error 的行为。
- [Linux 4.13](https://kernelnewbies.org/Linux_4.13#Improved_block_layer_and_background_writes_error_handling) Linux 4.13 引入的错误处理机制，解决了 PostgreSQL 提出的问题的其中一个方面。
- [new writeback error reporting](https://lwn.net/Articles/724232/)
- [improved block-layer error handling](https://lwn.net/Articles/724307/)
- [PostgreSQL's fsync() error is unsafe](https://www.postgresql.org/message-id/CAMsr+YHh+5Oq4xziwwoEfhoTZgr07vdGG+hu=1adXx59aTeaoQ@mail.gmail.com) 提出了 PostgreSQL 旧的 WAL fsync error 处理存在的问题。
