---
title: "《Bloom Filters: Design Innovations and Novel Applications》论文翻译 [持续更新中]"
date: 2020-09-13T13:49:45+08:00
lastmod: 2020-09-13T13:49:45+08:00
draft: true
keywords: []
description: ""
tags: ["Bloom Filter", "Translation"]
categories: ["Paper Reading"]
author: ""
resources:
- name: featured-image
  src: paper-reading.jpg
---

*本篇文章是对论文[Bloom Filters: Design Innovations and Novel Applications](https://pdfs.semanticscholar.org/e918/3d3e92cecf0296260a2c65d27535d4b8254d.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 摘要

布隆过滤器（Bloom Filters）在网络中非常有趣，因为它们可以使各种硬件算法变得高性能且低开销。本文介绍了一种可变长签名的想法，其与目前实际使用的固定长度签名有所不同。