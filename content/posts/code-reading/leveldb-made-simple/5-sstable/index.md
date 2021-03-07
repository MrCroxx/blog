---
title: "深入浅出LevelDB —— 0x05 SSTable [施工中]"
date: 2021-03-06T16:54:17+08:00
lastmod: 2021-03-06T16:54:20+08:00
draft: false
keywords: []
description: ""
tags: ["LevelDB", "LSMTree"]
categories: ["深入浅出LevelDB"]
author: ""
resources:
- name: featured-image
  src: leveldb.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 0. 引言

SSTable（Sorted-String Table）是LevelDB中数据在稳定存储中的格式。当memtable中的数据超过一定阈值时，LevelDB会将memtable转为immutable memtable，LevelDB的后台线程会将immutable memtable通过compaction操作将其以SSTable的格式写入到稳定存储。

本文主要介绍SSTable的格式，有关compaction操作会在本系列后续的文章中介绍。

## 1. SSTable格式

### 1.1 SSTable文件格式概览

SSTable的文件格式可表示为下图：

![sstable文件格式](assets/sstable.svg "sstable文件格式")

SSTable中的数据按照功能可以分为如下几块区：
1. Data Block区：存放key/value数据。
2. Meta Block区：存放过滤器或当前SSTable相关的统计数据。
3. MetaIndex Block：仅有1个Block，该Block中存放了所有Meta Block的索引。
4. Index Block区：所有Data Block的索引。
5. Footer：大小固定的一个区域（48B），该区域中有两个Handle，分别标识了MetaIndex Block区和Index Block区的偏移量与大小；文件末尾的MagicNum用来标识该文件是LevelDB的SSTable文件；剩余空间被填充为Padding。

{{< admonition info 提示>}}

Footer大小48B原因：Footer中有2个Handle和1个64bit的MagicNumber，每个Handle中有2个varint64编码的字段。varint64编码最大长度为10B，因最多需要 (10B + 10B) * 2 + 8 = 48B。

{{</ admonition >}}

在SSTable中，无论是Footer中的Handler，还是各种索引中的Handler，都由两个varint64编码的字段组成：`offset`、`size`。这两个字段分别标识了指向的Block的*偏移量*与*内容大小*。每个Block除了其包含的内容的数据外，还有压缩类型标识符（1B）与校验和（4B）。Handle的`size`字段是不包含块尾元数据（1B+4B=5B）的大小。

![Handle与Block格式](assets/block.svg "Handle与Block格式")

其中，合法的压缩类型标识符共两种：

| 压缩类型 | 值 | 描述 |
| :-: | :-: | :- |
| kNoCompression | 0x0 | 不压缩。 |
| kSnappyCompression | 0x1 | 采用Snappy算法压缩。 |

### 1.2 Block格式

SSTable中所有的Block（content）都以下图格式组织：

![Block格式](assets/block.svg "Block格式")

从功能上，Block中可分为三个区域：
1. Entry区：保存每条数据条目（通过Restart方式压缩）。
2. Restart区：保存每条Restart索引（详见下文）。
3. Restart Num：Restart区索引数（Fixed32编码），读取时通过该值来找到Restart区的起点。

由于SSTable中Entry常有公共前缀（特别是在不清理无效版本的level-0中），因此LevelDB对Block中的Entry进行了简单的压缩：每隔一定数量的Entry设定一个Restart Point，Restart Point后的第一条Entry完整保存（下文称其为Restart Entry）。而对于该Restart Entry到下一个Restart Point中间的Entry，只保存其与Restart Entry公共前缀后的部分，与一些用来计算长度的元数据。

这里以Data Block为例，如下图所示：

![Restart压缩](assets/sharing.svg "Restart压缩")

如图所示，每个Entry可分为5段，分别为：该Entry的Key与其相应的Restart Entry的公共前缀长度（Varint32编码）、该Entry的Key剩余的长度（Varint32编码）、该Entry的Value长度（Varint32）编码、该Entry的Key的非公共前缀数据（bytes）、该Entry的Value数据（bytes）。Restart区的Restart索引（Fixed32编码）分别指向每个Restart Entry的偏移量。当然，这种压缩方式适用于所有的Block，无论数据只有key还是拥有key/value，并非只有Data Block使用了这种方式。

通过这种方式，可以对频繁出现的公共前缀进行压缩。Restart Entry的间隔`leveldb::Options.block_restart_interval`默认为16，以平衡缓存局部性。

接下来关注SSTable中各类Block保存的数据（以下屏蔽Restart细节，仅关注Entry中的key/value）。

| Block Type <div style="width:8em"></div> | key<div style="width:12em"></div> | value<div style="width:12em"></div> | 描述<div style="width:40em"></div> |
| :-: | :-: | :-: | :- |
| Data Block | InternalKey Size + InternalKey | Value Size + Value | 完整数据与SkipList中Key的格式相同。 |
| Meta Block | - | - | Meta Block有多种类型，目前可分 Filter Meta Block与Stats Meta Block，分别保存当前SSTable的过滤器与统计数据。 |
| Filter Meta Block | filter.{{ Filter Name}} | BlockHandle | 该SSTable使用的过滤器名称及其索引。过滤器的实现详见下文。 |
| Stats Meta Block | 统计量名 | 统计量值 | 保存该SSTable的统计量。 |
| MetaIndex Block | Meta Block Name | BlockHandle | 用来索引所有的MetaBlock。 |
| Index Block | 相应Data Block的“最大”Key值（详见下文） | BlockHandle | 用来快速索引key在SSTable的哪个Data Block中。 |



# 施工中 ... ...

如果启用过滤器，其中一个Meta Block作为Filter Block。其它Meta Block以key/value的形式保存统计数据（详见`doc/table_format.md`）。

```cpp

  // If *start < limit, changes *start to a short string in [start,limit).
  // Simple comparator implementations may return with *start unchanged,
  // i.e., an implementation of this method that does nothing is correct.
  virtual void FindShortestSeparator(std::string* start,
                                     const Slice& limit) const = 0;

  // Changes *key to a short string >= *key.
  // Simple comparator implementations may return with *key unchanged,
  // i.e., an implementation of this method that does nothing is correct.
  virtual void FindShortSuccessor(std::string* key) const = 0;


```


