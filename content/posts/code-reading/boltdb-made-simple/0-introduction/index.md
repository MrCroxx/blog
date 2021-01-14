---
title: "深入浅出boltdb —— 0x00 引言"
date: 2021-01-05T18:20:36+08:00
lastmod: 2021-01-05T18:20:40+08:00
draft: true
keywords: []
description: ""
tags: ["B+Tree"]
categories: ["深入浅出bbolt"]
author: ""
resources:
- name: featured-image
  src: bbolt.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->



## 1. 引言

boltDB是一个完全由go语言编写的基于B+树的kv数据库，

# 施工中 ... ...

[README](https://github.com/boltdb/bolt/blob/master/README.md)

Bolt uses a single memory-mapped file, implementing a copy-on-write B+tree, which makes reads very fast. Also, Bolt’s load time is better, especially during recovery from crash, since it doesn’t need to read the log (it doesn’t have it) to find the last succeeded transaction: it just reads IDs for two B+tree roots, and uses the one with the greater ID. Bolt is simpler.

- 单文件：Bolt saves data into a single memory-mapped file on disk. It doesn’t have a separate journal, write-ahead log, or a thread for compaction or garbage collection: it deals with just one file, and does it safely.
- ACID事务支持：



## 2. 目录

- [] 存储`page.go`、`freelist.go`

## 3. 施工路线图