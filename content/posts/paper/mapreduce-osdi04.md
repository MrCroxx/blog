---
title: "《MapReduce: Simplified Data Processing on Large Clusters》论文翻译（MapReduce-OSDI04）"
date: 2020-08-08T12:21:45+08:00
lastmod: 2020-08-08T12:21:45+08:00
draft: false
keywords: []
description: ""
tags: ["MapReduce", "Translation"]
categories: ["Paper Reading"]
author: ""
---

*本篇文章是对论文[GFS-SOSP2003](https://static.googleusercontent.com/media/research.google.com/zh-CN//archive/mapreduce-osdi04.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 摘要

MapReduce是一个用来处理和生成大型数据集的编程模型和相关实现。用户需要指定*map*函数和*reduce*函数。*map*函数处理键值对并生成一组由键值对组成的中间值，*reduce*函数将所有键相同的中间值合并。就像本文中展示的那样，现实世界中的很多任务都可以通过这个模型表示。

以这种函数式风格编写的程序可以自动地作为并行程序在大型商用机集群上执行，运行时（run-time）系统负责对输入数据分区、在一系列机器间调度程序执行、处理机器故障、管理必要的机器间的通信。这让没有任何并行程序和分布式系统开发经验的编程人员能够轻松利用一个大型分布式系统的资源。

我们的MapReduce实现是高度可伸缩的，其运行在一个由商用机器组成的大型分布式集群上。通常，一个MapReduce计算会处理上千台机器上数TB的数据。每天都有数百个MapReduce程序提交的高达上千个MapReduce任务在Google集群上执行。开发人员认为这个系统非常易用。

## 1. 引言

