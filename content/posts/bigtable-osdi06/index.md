---
title: "《Bigtable: A Distributed Storage System for Structured Data》论文翻译（BigTable-OSDI06）"
date: 2020-08-15T11:29:45+08:00
lastmod: 2020-08-15T11:29:45+08:00
draft: false
keywords: []
description: ""
tags: ["Bigtable", "Translation"]
categories: ["Paper Reading"]
author: ""
resources:
- name: featured-image
  src: paper-reading.jpg
---

*本篇文章是对论文[Bigtable-OSDI06](https://static.googleusercontent.com/media/research.google.com/zh-CN//archive/bigtable-osdi06.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 摘要

Bigtable是一个为管理大规模可伸缩的结构化数据而设计的的分布式存储系统，它可以跨上千台商用服务器管理PB级的数据。Google中很多项目将数据存储在Bigtable中，包括web索引、Google Earth和Google Finance。这些应用程序对Bigtable提出了非常不同的需求，这些不同包括数据大小不同（从URL到web页面再到卫星图像）和延迟要求不同（从后端批处理任务到实时数据服务）。尽管需求是多变的，Bigtable还是成功地为Google的所有这些产品提供了灵活的、高性能的解决方案。在本文中，我们描述了Bigtable提供的允许客户端动态控制数据布局和格式的简单数据模型，以及Bigtable的设计与实现。

## 1. 引言

