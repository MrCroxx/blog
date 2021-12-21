---
title: "Reading List"
date: 2021-10-30T18:00:00+08:00
lastmod: 2021-10-30T18:00:00+08:00
draft: false
keywords: []

description: ""
tags: ["Reading List"]
categories: ["Reading List"]
author: ""
resources:
- name: featured-image
  src: index.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

碎碎念：在更了很多论文翻译后，发现翻译论文实在太花费精力了，而且英语水平有限，翻译质量也不高；另外，需要看这些论文的小伙伴英语似乎也不差，就不再献丑了。所以之后遇到的比较好的 paper 或者 blog 我会不定期地分类整理在这里。

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
