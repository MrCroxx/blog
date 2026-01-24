---
title: "(Chinese) 深入浅出 LevelDB —— 00 Intro"
date: "2021-03-02"
summary: "深入浅出 LevelDB —— 00 Intro"
categories: ["深入浅出 LevelDB"]
tags: ["LevelDB", "LSM-tree"]
draft: false
---

![featured image](index.jpg)

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

# 0. 引言

在完成[深入浅出 etcd/raft](/categories/深入浅出 etcd/raft/)和[深入浅出 boltdb](/categories/深入浅出 boltdb)两个系列后，笔者又来开新坑[深入浅出 LevelDB](/categories/深入浅出leveldb)了。

LevelDB是LSM-Tree的开源实现。LSM-Tree最早可以追溯到O'Neil在1996年发表的论文《The Log-Structured Merge-Tree (LSM-Tree)》，但因为受限于当时的应用场景和硬件限制，LSM-Tree期初并没有在工业界大规模应用。真正让LSM-Tree重新回到工业界视野的，应该是Google大数据论文老三样中的《Bigtable: A distributed storage system for structured data》（这里不得不吹一手Google，几篇重量级Paper差不多养活了整个行业）。

而LevelDB是Google的两位大佬Sanjay Ghemawat与Jeff Dean根据BigTable论文完成的LST-Tree的开源实现。LevelDB是通过C++实现的，其代码水平非常高。之前在知乎某个相关问题下看到这样一句评价：“跟LevelDB学习LSM-Tree和C++98实践，跟RocksDB学习存储引擎实现”，笔者对此也深以为然。

> 引文：
> 
> Wikipedia "LevelDB - History" :
> 
> LevelDB is based on concepts from Google's Bigtable database system. The table implementation for the Bigtable system was developed starting in about 2004, and is based on a different Google internal code base than the LevelDB code. That code base relies on a number of Google code libraries that are not themselves open sourced, so directly open sourcing that code would have been difficult. Jeff Dean and Sanjay Ghemawat wanted to create a system resembling the Bigtable tablet stack that had minimal dependencies and would be suitable for open sourcing, and also would be suitable for use in Chrome for the IndexedDB implementation. They wrote LevelDB starting in early 2011, with the same general design as the Bigtable tablet stack, but not sharing any of the code.

虽然作为一个新坑，但笔者这次仍采用了自底向上的方法解读LevelDB的源码。由于笔者之前并没有大型C++项目经验，在编写本系列文章的同时也是在学习C++最佳实践，因此难免有些地方理解有偏差，欢迎各位读者批评指正。另外，LevelDB的代码量比之前的两个坑（etcd/raft、boltdb）大很多，而且涉及处理格式的部分也很多，因此本系列笔者对源码的分析较之前两个系列会更少，更多分析的是其设计和实现的关键点。

另外，本系列重点着眼于LevelDB的实现，不会过多介绍LSM-Tree及相关原理，这一部分网上博客与论文很多，笔者也不是很擅长原理的介绍，就不在此班门弄斧了。

# 1. 目录

- [深入浅出 LevelDB —— 00 Intro](/posts/code-reading/leveldb-made-simple/0-introduction/)
- [深入浅出 LevelDB —— 01 Architecture](/posts/code-reading/leveldb-made-simple/1-architecture/)
- [深入浅出 LevelDB —— 02 Slice](/posts/code-reading/leveldb-made-simple/2-slice/)
- [深入浅出 LevelDB —— 03 Log](/posts/code-reading/leveldb-made-simple/3-log/)
- [深入浅出 LevelDB —— 04 MemTable](/posts/code-reading/leveldb-made-simple/4-memtable/)
- [深入浅出 LevelDB —— 05 SSTable](/posts/code-reading/leveldb-made-simple/5-sstable/)
- [深入浅出 LevelDB —— 06 Version](/posts/code-reading/leveldb-made-simple/6-version/)
- [深入浅出 LevelDB —— 07 Cache](/posts/code-reading/leveldb-made-simple/7-cache/)
- [深入浅出 LevelDB —— 08 Iterator](/posts/code-reading/leveldb-made-simple/8-iterator/)
- [深入浅出 LevelDB —— 09 Compaction](/posts/code-reading/leveldb-made-simple/9-compaction/)
- [深入浅出 LevelDB —— 10 Read & Write](/posts/code-reading/leveldb-made-simple/10-read-write/)