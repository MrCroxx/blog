---
title: "深入浅出LevelDB —— 0x03 log [施工中]"
date: 2021-03-05T12:43:16+08:00
lastmod: 2021-03-05T12:43:19+08:00
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

LevelDB在修改时，首先会将修改写入到保存在文件系统上的log，以避免宕机时保存在内存中的数据丢失。由于log是顺序写入的，其写入速度较快。因为log的写入是在真正执行操作之前的，因此这一技术也叫做**Write-Ahead Log**。

本文将介绍并分析LevelDB中log的实现。

相关命名空间：`leveldb::log`。

相关文件：`include/leveldb/env.h`、`db/log_format.h`、`db/log_writer.h`、`db/log_writer.cc`、`db/log_reader.h`、`db/log_reader.cc`。

## 1. log的格式与设计

LevelDB的log是由Record和一些为了对齐而填充的gap组成的文件。

LevelDB在读取log文件时，为了减少I/O次数，每次读取都会读入一个32KB大小的块。因此，在写入log文件时，LevelDB也将数据按照32KB对齐。

![文件与块](assets/file-and-block.svg "文件与块")

由于，LevelDB中记录的长度是不确定的，如果想要与32KB块对齐，为了尽可能地利用空间，那么较长的记录可能会被拆分为多个段，以能够将其放入块的剩余空间中。LevelDB定义只有1个段的记录为`FullType`，由多个段组成的记录的首位段分别为`FirstType`与`LastType`，中间段为`MiddleType`。

![记录与段](assets/record-and-fragment.svg "记录与段")

当块中剩余空间不足以放入完整记录时，LevelDB会将其按段拆分，直到该记录被完整保存：

![段与块](assets/fragment-and-block.svg "段与块")

记录的每个段由段头和数据组成，段头长度为固定的7字节，其中头4字节表示该段的CRC校验码、随后2字节表示该段长度、最后1字节标识该段的类型：

![段结构](assets/fragment.svg "段结构")

如果在写入时，与32KB对齐的剩余空间不足以放入7字节的header时，LevelDB会将剩余空间填充为`0x00`，并从下一个与32KB对齐处继续写入：

![空白填充](assets/gap.svg "空白填充")









## 2. log的实现

### 2.1 WritableFile与SequentialFile

相关文件：`include/leveldb/env.h`、`util/env_*.*`。

在介绍LevelDB中log的Writer前，首先先看一下Writer的写入目标的抽象——`WritableFile`。

`WritableFile`是一个抽象类，其定义在`include/leveldb/env/h`中。`env.h`中声明了很多与环境无关的抽象，让使用者不需要关心这些类在不同操作系统环境下的具体实现，而这些抽象的实现在`util/env_*.*`中，对应不同环境下的实现。

`WritableFile`定义了一个顺序写入文件抽象：

```cpp

// A file abstraction for sequential writing.  The implementation
// must provide buffering since callers may append small fragments
// at a time to the file.
class LEVELDB_EXPORT WritableFile {
 public:
  WritableFile() = default;

  WritableFile(const WritableFile&) = delete;
  WritableFile& operator=(const WritableFile&) = delete;

  virtual ~WritableFile();

  virtual Status Append(const Slice& data) = 0;
  virtual Status Close() = 0;
  virtual Status Flush() = 0;
  virtual Status Sync() = 0;
};

```

```cpp

// A file abstraction for reading sequentially through a file
class LEVELDB_EXPORT SequentialFile {
 public:
  SequentialFile() = default;

  SequentialFile(const SequentialFile&) = delete;
  SequentialFile& operator=(const SequentialFile&) = delete;

  virtual ~SequentialFile();

  // Read up to "n" bytes from the file.  "scratch[0..n-1]" may be
  // written by this routine.  Sets "*result" to the data that was
  // read (including if fewer than "n" bytes were successfully read).
  // May set "*result" to point at data in "scratch[0..n-1]", so
  // "scratch[0..n-1]" must be live when "*result" is used.
  // If an error was encountered, returns a non-OK status.
  //
  // REQUIRES: External synchronization
  virtual Status Read(size_t n, Slice* result, char* scratch) = 0;

  // Skip "n" bytes from the file. This is guaranteed to be no
  // slower that reading the same data, but may be faster.
  //
  // If end of file is reached, skipping will stop at the end of the
  // file, and Skip will return OK.
  //
  // REQUIRES: External synchronization
  virtual Status Skip(uint64_t n) = 0;
};

```

### 2.2 Writer

相关文件：`db/log_writer.h`、`db/log_writer.cc`。

`leveldb::log::Writer`是用来写入log文件的类，其除了构造方法外只对外提供了一个追加记录的方法`AddRecord`，内部也仅有一个用来将Record同步到稳定存储的方法`EmitPhysicalRecord`：

```cpp

class Writer {
 public:
  // Create a writer that will append data to "*dest".
  // "*dest" must be initially empty.
  // "*dest" must remain live while this Writer is in use.
  explicit Writer(WritableFile* dest);

  // Create a writer that will append data to "*dest".
  // "*dest" must have initial length "dest_length".
  // "*dest" must remain live while this Writer is in use.
  Writer(WritableFile* dest, uint64_t dest_length);

  Writer(const Writer&) = delete;
  Writer& operator=(const Writer&) = delete;

  ~Writer();

  Status AddRecord(const Slice& slice);

 private:
  Status EmitPhysicalRecord(RecordType type, const char* ptr, size_t length);

  WritableFile* dest_;
  int block_offset_;  // Current offset in block

  // crc32c values for all supported record types.  These are
  // pre-computed to reduce the overhead of computing the crc of the
  // record type stored in the header.
  uint32_t type_crc_[kMaxRecordType + 1];
};

```











# 施工中 ... ...