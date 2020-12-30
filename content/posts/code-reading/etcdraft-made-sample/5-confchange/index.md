---
title: "深入浅出etcd/raft —— 0x05 成员变更"
date: 2020-12-29T16:36:16+08:00
lastmod: 2020-12-29T16:36:19+08:00
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

## 0. 引言

本文会对etcd/raft中Raft成员变更算法的实现与优化进行分析。这里假定读者阅读过Diego Ongaro的《In Search of an Understandable Consensus Algorithm (Extended Version)》（这里有笔者的[翻译](/posts/paper-reading/raft-extended/)，笔者英语水平一般，欢迎指正。），其中提到的部分，本文中不会做详细的解释。对etcd/raft的总体结构不熟悉的读者，可以先阅读[《深入浅出etcd/raft —— 0x02 etcd/raft总体设计》](/posts/code-reading/etcdraft-made-sample/2-overview/)。

## 施工中

## 参考文献

<div class="reference">

[1] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm[C]//2014 {USENIX} Annual Technical Conference ({USENIX}{ATC} 14). 2014: 305-319.

[2] Ongaro D, Ousterhout J. In search of an understandable consensus algorithm (extended version)[J]. Retrieved July, 2016, 20: 2018.

[3] Ongaro D. Consensus: Bridging theory and practice[D]. Stanford University, 2014.

</div>