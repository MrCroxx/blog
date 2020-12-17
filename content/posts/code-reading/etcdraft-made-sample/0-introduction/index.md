---
title: "深入浅出etcd/raft —— 0x00 引言"
date: 2020-12-10T22:03:56+08:00
lastmod: 2020-12-14T13:06:28+08:00
draft: false
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

## 1. 引言

Raft算法，Diego Ongaro在《In search of an understandable consensus algorithm》中提出的一种新型故障容错共识算法。正如这篇论文的标题所说，Raft算法比经典的Paxos算法族更容易理解。

然而，即使读过Raft的论文、做过MIT6.824的Lab2，也很难理解成熟的工业级产品中Raft实现的一些细节。本系列文章旨在由浅入深地分析Etcd中Raft算法的实现，从Raft论文中的实现过渡到成熟的工业级产品中的经典Raft实现。

在阅读本系列文章前，读者需要：

1. 阅读《In search of an understandable consensus algorithm (extended version)》，理解其中有关Raft的内容，本系列不会赘述Raft的一些基本概念。
2. 学习go的基本语法，学习go语言并发编程与channel的使用方式。
3. 准备Diego Ongaro的博士论文作为参考资料，在Etcd的实现中，引用了很多其中的优化方式。

本系列文章还在龟速更新中。笔者也是第一次试图将对这种工业级产品的分析写出来分享给读者，因此难免把握不好分析的粒度。在更新后面的文章的同时，我也会对之前的文章进行更正与优化，使其更容易理解。

## 2. 施工路线图

本系列仍在施工中，之后可能反复修改其中内容与顺序等。本节中保存了当前的施工路线图。

1. 引言
2. raftexample分析
3. etcd/raft整体架构与状态机简要分析
4. 选举 —— etcd/raft中选举优化
5. 选举 —— etcd/raft实现分析
5. 日志 —— etcd/raft中日志实现
6. 日志 —— etcd/raft中日志复制
7. 日志 —— etcd/raft中快照
8. 集群变更 —— simple
9. 集群变更 —— joint
10. linearizable —— ReadIndex分析