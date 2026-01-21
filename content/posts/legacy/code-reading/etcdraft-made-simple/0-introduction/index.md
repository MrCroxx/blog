---
title: "(Chinese) 深入浅出 etcd/raft —— 0x00 引言"
date: "2020-12-10"
summary: "深入浅出 etcd/raft —— 0x00 引言"
categories: ["深入浅出 etcd/raft"]
tags: ["etcd", "Raft"]
draft: false
---

![featured image](index.jpg)

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

## 1. 引言

Raft算法，Diego Ongaro在《In search of an understandable consensus algorithm》中提出的一种新型故障容错共识算法。正如这篇论文的标题所说，Raft算法比经典的Paxos算法族更容易理解。

然而，即使读过Raft的论文、做过MIT6.824的Lab2，也很难理解成熟的工业级产品中Raft实现的一些细节。本系列文章旨在由浅入深地分析Etcd中Raft算法的实现，从Raft论文中的实现过渡到成熟的工业级产品中的经典Raft实现。

在阅读本系列文章前，读者需要：

1. 阅读《In search of an understandable consensus algorithm (extended version)》，理解其中有关Raft的内容，本系列不会赘述Raft的一些基本概念。
2. 学习go的基本语法，学习go语言并发编程与channel的使用方式。
3. 准备Diego Ongaro的博士论文作为参考资料，在Etcd的实现中，引用了很多其中的优化方式。

本系列文章龟速更新。笔者也是第一次试图将对这种工业级产品的分析写出来分享给读者，因此难免把握不好分析的粒度。在更新后面的文章的同时，我也会对之前的文章进行更正与优化，使其更容易理解。

另外，本系列不会对引用的代码中的注释进行翻译，其原因有二：一来，etcd/raft模块中的注释描述的十分详细，建议读者要详细地阅读一遍etcd/raft模块中所有的注释；二来，笔者的水平有限，翻译的过程中难免会有词不达意的情况，而etcd/raft模块中的注释往往会提及很多细节，为了避免误导读者，就不做翻译了。不过相信能看到这里的读者都有丰富的英文论文阅读经验了，不需要笔者多此一举的翻译。

## 2. 目录

- [深入浅出 etcd/raft —— 0x00 引言](/posts/code-reading/etcdraft-made-simple/0-introduction/)
- [深入浅出 etcd/raft —— 0x01 raftexample](/posts/code-reading/etcdraft-made-simple/1-raftexample/)
- [深入浅出 etcd/raft —— 0x02 etcd/raft总体设计](/posts/code-reading/etcdraft-made-simple/2-overview/)
- [深入浅出 etcd/raft —— 0x03 Raft选举](/posts/code-reading/etcdraft-made-simple/3-election/)
- [深入浅出 etcd/raft —— 0x04 Raft日志](/posts/code-reading/etcdraft-made-simple/4-log/)
- [深入浅出 etcd/raft —— 0x05 Raft成员变更](/posts/code-reading/etcdraft-made-simple/5-confchange/)
- [深入浅出 etcd/raft —— 0x06 只读请求优化](/posts/code-reading/etcdraft-made-simple/6-readonly/)

## 3. 施工路线图

本系列仍在施工中，之后可能反复修改其中内容与顺序等。本节中保存了当前的施工路线图。

- [x] 引言
- [x] raftexample分析
- [x] etcd/raft整体架构与状态机简要分析
- [x] 选举 —— etcd/raft中选举优化
- [x] 选举 —— etcd/raft实现分析
- [x] 日志 —— etcd/raft中日志实现
- [x] 日志 —— etcd/raft中日志复制
- [x] 日志 —— etcd/raft中快照
- [x] 集群变更 —— simple
- [x] 集群变更 —— joint
- [x] Linearizable Read —— Log Read、ReadIndex、Lease Read
- [ ] 集群变更 —— joint（apply-time confchange修复[issue#12359](https://github.com/etcd-io/etcd/issues/12359)）
- [ ] 附录 —— etcd/raft中所有消息使用的字段描述（80%鸽了）