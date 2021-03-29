---
title: "深入浅出boltdb —— 0x00 引言"
date: 2021-01-05T18:20:36+08:00
lastmod: 2021-03-04T20:10:58+08:00
draft: false
keywords: []

description: ""
tags: ["boltdb", "B+Tree"]
categories: ["深入浅出boltdb"]
author: ""
resources:
- name: featured-image
  src: boltdb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

## 0. 引言

boltDB是一个完全由go语言编写的基于B+树的kv数据库，其完全支持事务的ACID特性，整个数据库只有一个文件，且有较高的读性能与加载时间。etcd的后端存储使用的便是基于boltdb优化的kv存储[etcd-io/bbolt](https://github.com/etcd-io/bbolt)。

boltdb的源码非常适合用来学习B+Tree的实现。boltdb支持完整的事务ACID特性且实现方式较为简单，也适合存储与数据库初学者学习事务与简单的MVCC实现。另外，boltdb完全由go语言编写，因此其对于go语言或其它需要通过unsafe方式管理堆外内存的开发者，也是一个很好的示例。

本系列文章将自底向上地介绍并分析boltdb的实现，较为详细地分析了其源码功能。本文源码基于已归档的[boltdb/bolt](https://github.com/boltdb/bolt)项目（commit#fd01fc）。

本系列文章主要着眼于boltdb的设计、源码实现与相关知识，在阅读签，读者需要：

1. 学习go语言的基本语法，及unsafe的使用方式。
2. 详细阅读boltdb的[README](https://github.com/boltdb/bolt/blob/master/README.md)，对boltdb有初步认识。

与前一个《深入浅出etcd/raft》系列相比，boltdb更多偏向工程实现而非算法，因此本系列不会逐行地分析每一行源码。


## 1. 目录

- [深入浅出boltdb —— 0x00 引言](/posts/code-reading/boltdb-made-simple/0-introduction/)
- [深入浅出boltdb —— 0x01 存储与缓存](/posts/code-reading/boltdb-made-simple/1-storage-cache/)
- [深入浅出boltdb —— 0x02 B+Tree](/posts/code-reading/boltdb-made-simple/2-b+tree/)
- [深入浅出boltdb —— 0x03 bucket & cursor](/posts/code-reading/boltdb-made-simple/3-bucket-cursor/)
- [深入浅出boltdb —— 0x04 事务](/posts/code-reading/boltdb-made-simple/4-transaction/)

## 2. 施工路线图

- [x] 引言
- [x] 存储
- [x] 缓存
- [x] B+Tree
- [x] bucket
- [x] cursor
- [x] 事务
- [x] db