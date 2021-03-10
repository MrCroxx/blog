---
title: "深入浅出LevelDB —— 0x08 Compaction [施工中]"
date: 2021-03-10T19:35:40+08:00
lastmod: 2021-03-10T19:35:46+08:00
draft: false
keywords: []
description: ""
tags: ["LevelDB", "LSMTree"]
categories: ["深入浅出LevelDB"]
author: ""
resources:
- name: featured-image
  src: leveldb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

正如Rebalance与Spill之于B+Tree，Compaction操作是LSMTree的核心。

本节将介绍并分析LevelDB中LSMTree的Compaction操作的实现。

## 1. Compcation分类

LevelDB中LSMTree的Compaction操作分为两类，分别是Minor Compaction与Major Compaction。

- Minor Compaction（Immutable MemTable -> SSTable）：将Immutable MemTable直接转为SSTable写入。Minor Compaction不会对Immutable MemTable中
- Major Compaction（Low-level SSTable -> High-level SSTable）：

# 施工中 ... ...

DBImpl::BackgroundCompaction

DBImplCompactMemTable

Minor Compaction > Manual Compaction > Size Compaction > Seek Compaction

btw. Tier Compaction ( Tiering vs. Leveling )