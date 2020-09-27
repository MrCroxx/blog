---
title: "《In Search of an Understandable Consensus Algorithm (Extended Version)》论文翻译 [持续更新中]"
date: 2020-09-27T19:26:30+08:00
lastmod: 2020-09-27T19:26:34+08:00
draft: false
keywords: []
description: ""
tags: ["Raft", "Translation"]
categories: ["Paper Reading"]
author: ""
resources:
- name: featured-image
  src: paper-reading.jpg
---

*本篇文章是对论文[In Search of an Understandable Consensus Algorithm (Extended Version)](http://pages.cs.wisc.edu/~remzi/Classes/739/Spring2004/Papers/raft.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 摘要

Raft是一个用来管理多副本日志的共识算法。其作用与（multi-）Paxos相同、效率与Paxos想用，但结构与Paxos不同；这让Raft比Paxos更容易理解，且Raft为构建实用的系统提供了更扎实的基础。为了提高可理解性，Raft将共识的关键元素分离为：领导选举、日志复制、和安全性；且其增强了连贯性（coherency）<sup>译注1</sup>，以减少必须考虑的状态数。用户学习结果表明，对于学生来说，Raft比Paxos更容易学习。Raft还包括一个用于变更集群成员的新机制，其使用重叠的大多数来保证安全性。

> 译注1：本文的连贯性指*coherency*，在很多翻译中将其翻译成了一致性，这样容易与*consistency*混淆，二者间存在一定差异。

## 1. 引言

共识算法让一组机器能像能容忍一些成员故障的一个连贯组一样工作。因为这一点，它们在构建可靠的大规模软件系统中扮演者关键角色。Paxos<sup>[15, 16]</sup>在过去的十年中主导了共识算法的讨论：大多数共识的实现都基于Paxos或受其影响，且Paxos成为了用来教授学生有关共识知识的主要工具。

不幸的是，Paxos相当难以理解，尽管有很多使其更易接受的尝试。另外，其架构需要复杂的修改以支持实用的系统。其结果是，系统构建者和学生都很受Paxos困扰。

在我们自己饱受Paxos困扰后，我们