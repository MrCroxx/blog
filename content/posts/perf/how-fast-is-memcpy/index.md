---
title: "How Fast is memcpy(2)"
date: 2024-07-21T00:00:00+08:00
lastmod: 2024-07-21T00:00:00+08:00
draft: true
keywords: []

description: ""
tags: ["memcpy"]
categories: ["Performance Optimization"]
author: ""
resources:
- name: featured-image
  src: index.png
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

When writing programs, especially performance-sensitive ones, we often try to avoid memory copies to improve performance. Sometimes, it is easy to eliminate memory copies by using pointers or references. However, there are also times when it is challenging to eliminate memory copies, requiring careful memory lifecycle management and the introduction of additional synchronization mechanisms to avoid concurrent read and write operations. The latter often introduces additional overhead, which can sometimes make our program slower with our "optimization".

Determining whether a memory copy needs to be eliminated, it is important to understand how slow (or fast) the memory copy operation actually is. 

# TODO