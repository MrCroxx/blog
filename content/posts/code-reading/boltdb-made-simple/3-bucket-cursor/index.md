---
title: "深入浅出boltdb —— 0x03 Bucket & Cursor"
date: 2021-01-20T23:55:22+08:00
lastmod: 2021-01-20T23:55:26+08:00
draft: false
keywords: []

description: ""
tags: ["boltdb", "B+Tree"]
categories: ["深入浅出bolt"]
author: ""
resources:
- name: featured-image
  src: bbolt.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

在[深入浅出boltdb —— 0x02 B+Tree](/posts/code-reading/boltdb-made-simple/2-b+tree-copy/)中，笔者介绍了boltdb中B+Tree的实现。boltdb将B+Tree进一步封装成了bucket以便用户使用。

与大多数存储系统一样，bucket是一系列key/value的集合；同时，boltdb支持bucket无限嵌套。例如，一个银行的数据可以通过如下的多层嵌套的bucket以及其中的key/value表示：

![bucket嵌套](assets/nested-bucket.svg "bucket嵌套")

在boltdb中，每个桶都是一棵B+Tree，为了便于用户访问桶中B+Tree的节点，boltdb实现了cursor游标。

本文，笔者将分析介绍boltdb中桶与游标的实现。

# 施工中。。。 。。。

## 1. bucket

## 2. cursor