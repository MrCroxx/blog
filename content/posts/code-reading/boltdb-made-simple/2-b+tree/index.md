---
title: "深入浅出boltdb —— 0x02 B+Tree"
date: 2021-01-05T18:26:19+08:00
lastmod: 2021-01-05T18:26:22+08:00
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

boltdb是需要通过磁盘来持久化数据的kv数据库。为了平衡内存与磁盘的读写性能，boltdb使用了B+Tree来保存并索引数据。