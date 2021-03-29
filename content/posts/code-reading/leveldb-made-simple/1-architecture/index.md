---
title: "深入浅出LevelDB —— 01 Architecture"
date: 2021-03-04T19:37:23+08:00
lastmod: 2021-03-04T19:37:27+08:00
draft: false
keywords: []
description: ""
tags: ["LevelDB", "LSM-Tree"]
categories: ["深入浅出LevelDB"]
author: ""
resources:
- name: featured-image
  src: leveldb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

本文主要介绍LevelDB的架构设计，以便读者对LevelDB有一个整体认识，便于后续文章自底向上地逐模块介绍LevelDB的设计与实现。

## 1. 架构设计

这里首先给出一张经典的LevelDB的架构图（[出处](https://microsoft.github.io/MLOS/notebooks/LevelDbTuning/)）：

![LevelDB Architecture](assets/leveldb-architecture.png "LevelDB Architecture")

为了条理更清晰地介绍LevelDB中的各个部分，这里以写入流程为例，依次介绍每一部分的功能：

1. Log（`*.log`）：即Write Ahead Log，是用来记录LevelDB变更的append-only的文件，在LevelDB重启时用来恢复内存中的数据。
2. MemTable、Immutable MemTable：用来Buffer最近写入的内存结构，其通过SkipList实现。当MemTable达到一定大小时会转为只读的Immutable MemTable，并等待后台线程通过Minor Compaction将其转为level-0的SSTable。MemTable是LSM-Tree将随机写入转为顺序写入的关键。
3. SSTable（新：`*.ldb`、旧：`*.sst`）：通过Compaction生成的SSTable。level-0的SSTable由Immutable MemTable直接转储得到，因此level-0的SSTable的key间存在overlap；其它level的SSTable每层间没有overlap。另外，除了level-0外，每层SSTable的总大小比上一层大10倍。
4. Manifest（`MANIFEST-*`）：记录SSTable文件等的版本变更，其中Record的格式与Log相同，LevelDB每次重启都会从一个新的Manifest文件写入。
5. Current（`CURRENT`）：用来指向最新的Manifest文件。

除了图中的模块外，LevelDB中还有一些重要的模块或文件：

1. Cache：分为Table Cache与Block Cache，核心为ShardedLRUCache，用来缓存数据块、索引块或过滤器。
2. Iterator：提供遍历LevelDB中各种数据结构的功能，LevelDB中Iterator可以作为一个体系，本系列单独用一个篇幅对其进行了介绍。
3. `LOCK`文件：LevelDB仅支持单个LevelDB进程操作一个数据库，因此其通过`LOCK`文件防止其它LevelDB进程访问该数据库。
4. `LOG`文件：LevelDB的日志文件。