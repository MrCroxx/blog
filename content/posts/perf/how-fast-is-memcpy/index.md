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

To determine whether a memory copy needs to be eliminated, it is important to understand how slow (or fast) the memory copy operation actually is. [memcpy(3)](https://man7.org/linux/man-pages/man3/memcpy.3.html) is the most commonly used method to perform a memory copy. It is defined as the following signature in libc.

```c
void *memcpy(void dest[restrict .n], const void src[restrict .n], size_t n);
```

The function simply copy a continuous range of memory for `src` to `dst` with the length of `n`. `memcpy` doesn't check if the `src` area and the `dst` area overlaps with each other, if there is overlapping, the method call will lead to a UB.

Around one or two decades ago, memcpy simply looped through the target memory area and used CPU's general registers to copy. However, with the introduction of SIMD instructions and related registers, the throughput of memcpy has been significantly improved.




# TODO