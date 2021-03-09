---
title: "深入浅出LevelDB —— 0x03 Log"
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

LevelDB在修改时，首先会将修改写入到保存在文件系统上的Log，以避免掉电时保存在内存中的数据丢失。由于Log是顺序写入的，其写入速度较快。因为Log的写入是在真正执行操作之前的，因此这一技术也叫做**Write-Ahead Log**。

本文主要分析LevelDB中Log的设计与实现。此外，本文的后半部分主要着眼于LevelDB如何保证WAL被安全地写入到稳定存储。

相关命名空间：`leveldb::log`。

相关文件：`include/leveldb/env.h`、`db/log_format.h`、`db/log_writer.h`、`db/log_writer.cc`、`db/log_reader.h`、`db/log_reader.cc`。

## 1. Log的格式与设计

LevelDB的Log是由Record和一些为了对齐而填充的gap组成的文件。

LevelDB在读取Log文件时，为了减少I/O次数，每次读取都会读入一个32KB大小的块。因此，在写入Log文件时，LevelDB也将数据按照32KB对齐。

![文件与块](assets/file-and-block.svg "文件与块")

由于，LevelDB中记录的长度是不确定的，如果想要与32KB块对齐，为了尽可能地利用空间，那么较长的记录可能会被拆分为多个段，以能够将其放入块的剩余空间中。LevelDB定义只有1个段的记录为`FullType`，由多个段组成的记录的首位段分别为`FirstType`与`LastType`，中间段为`MiddleType`。

![记录与段](assets/record-and-fragment.svg "记录与段")

当块中剩余空间不足以放入完整记录时，LevelDB会将其按段拆分，直到该记录被完整保存：

![段与块](assets/fragment-and-block.svg "段与块")

记录的每个段由段头和数据组成，段头长度为固定的7字节，其中头4字节表示该段的CRC校验码、随后2字节表示该段长度、最后1字节标识该段的类型：

![段结构](assets/fragment.svg "段结构")

如果在写入时，与32KB对齐的剩余空间不足以放入7字节的header时，LevelDB会将剩余空间填充为`0x00`，并从下一个与32KB对齐处继续写入：

![空白填充](assets/gap.svg "空白填充")

## 2. Log的实现

### 2.1 WritableFile与SequentialFile

相关文件：`include/leveldb/env.h`、`util/env_*.*`。

在介绍LevelDB中Log的Writer与Reader前，我们首先看一下LevelDB中对Log文件的抽象。LevelDB对Log文件的抽象有`WritableFile`和`SequentialFile`，分别对应顺序写入与顺序读取的文件。

`WritableFile`与`SequentialFile`是抽象类，定义在`include/leveldb/env/h`中。`env.h`中声明了很多与环境无关的抽象，让使用者不需要关心这些类在不同操作系统环境下的具体实现，而这些抽象的实现在`util/env_*.*`中，对应不同环境下的实现。

`WritableFile`与`SequentialFile`的声明如下：

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

### 2.2 Writer与Reader

相关文件：`db/log_writer.h`、`db/log_writer.cc`、`db/log_reader.h`、`db/log_reader.cc`。

`leveldb::log::Writer`是用来写入Log文件的类，其除了构造方法外只对外提供了一个追加记录的方法`AddRecord`，内部通过`EmitPhysicalRecord`方法用来将记录写入存储；`leveldb::log::Reader`是用来读取Log文件的类，其对外提供了`ReadRecord`方法，该方法会读取下一条记录，并将参数`result`与`scratch`指向下一条记录，内部方法`ReadPhysicalRecord`会通过`unistd.h`的`read`方法，读取文件的下一个块（32KB）到内部buffer（`backing_store_`），以减少I/O次数。

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

  // ... ...

};

class Reader {
 public:
  // Interface for reporting errors.
  class Reporter {
   public:
    virtual ~Reporter();

    // Some corruption was detected.  "size" is the approximate number
    // of bytes dropped due to the corruption.
    virtual void Corruption(size_t bytes, const Status& status) = 0;
  };

  // Create a reader that will return log records from "*file".
  // "*file" must remain live while this Reader is in use.
  //
  // If "reporter" is non-null, it is notified whenever some data is
  // dropped due to a detected corruption.  "*reporter" must remain
  // live while this Reader is in use.
  //
  // If "checksum" is true, verify checksums if available.
  //
  // The Reader will start reading at the first record located at physical
  // position >= initial_offset within the file.
  Reader(SequentialFile* file, Reporter* reporter, bool checksum,
         uint64_t initial_offset);

  Reader(const Reader&) = delete;
  Reader& operator=(const Reader&) = delete;

  ~Reader();

  // Read the next record into *record.  Returns true if read
  // successfully, false if we hit end of the input.  May use
  // "*scratch" as temporary storage.  The contents filled in *record
  // will only be valid until the next mutating operation on this
  // reader or the next mutation to *scratch.
  bool ReadRecord(Slice* record, std::string* scratch);

  // Returns the physical offset of the last record returned by ReadRecord.
  //
  // Undefined before the first call to ReadRecord.
  uint64_t LastRecordOffset();

 private:
  // Extend record types with the following special values
  enum {
    kEof = kMaxRecordType + 1,
    // Returned whenever we find an invalid physical record.
    // Currently there are three situations in which this happens:
    // * The record has an invalid CRC (ReadPhysicalRecord reports a drop)
    // * The record is a 0-length record (No drop is reported)
    // * The record is below constructor's initial_offset (No drop is reported)
    kBadRecord = kMaxRecordType + 2
  };

  // Skips all blocks that are completely before "initial_offset_".
  //
  // Returns true on success. Handles reporting.
  bool SkipToInitialBlock();

  // Return type, or one of the preceding special values
  unsigned int ReadPhysicalRecord(Slice* result);

  // Reports dropped bytes to the reporter.
  // buffer_ must be updated to remove the dropped bytes prior to invocation.
  void ReportCorruption(uint64_t bytes, const char* reason);
  void ReportDrop(uint64_t bytes, const Status& reason);

  // ... ...

};

```

`leveldb::log::Writer`与`leveldb::log::Reader`中大部分是处理记录分段分块的代码，本文不再赘述。这里需要关注的是写入Log文件时数据的同步语义。

### 2.3 WAL数据同步

Log（或Write-Ahead Log，WAL）的意义在于保证机器故障时数据不会因为内存掉电而丢失，只有record被执行前，被完全同步到稳定存储后，才能保证掉电后数据的完整性。然而，如果每条记录都要等待同步写入，其开销很高。

LevelDB提供了是否开启同步的选项`WriteOptions`，其定义在`include/leveldb/options.h`中：

```cpp

// Options that control write operations
struct LEVELDB_EXPORT WriteOptions {
  WriteOptions() = default;

  // If true, the write will be flushed from the operating system
  // buffer cache (by calling WritableFile::Sync()) before the write
  // is considered complete.  If this flag is true, writes will be
  // slower.
  //
  // If this flag is false, and the machine crashes, some recent
  // writes may be lost.  Note that if it is just the process that
  // crashes (i.e., the machine does not reboot), no writes will be
  // lost even if sync==false.
  //
  // In other words, a DB write with sync==false has similar
  // crash semantics as the "write()" system call.  A DB write
  // with sync==true has similar crash semantics to a "write()"
  // system call followed by "fsync()".
  bool sync = false;
};

```

如果在配置LevelDB时，将`WriteOptions`的`sync`字段置为`true`，LevelDB在写入WAL时会根据环境架构，通过适当的方式等待数据完全被写入到稳定存储。

接下来我们以支持POSIX的系统为例，分析LevelDB中WAL的同步写入过程。

`leveldb::log::Writer`的`EmitPhysicalRecord`方法是将Record写入到WAL中的方法：

```cpp

Status Writer::EmitPhysicalRecord(RecordType t, const char* ptr,
                                  size_t length) {
  assert(length <= 0xffff);  // Must fit in two bytes
  assert(block_offset_ + kHeaderSize + length <= kBlockSize);

  // Format the header
  char buf[kHeaderSize];
  buf[4] = static_cast<char>(length & 0xff);
  buf[5] = static_cast<char>(length >> 8);
  buf[6] = static_cast<char>(t);

  // Compute the crc of the record type and the payload.
  uint32_t crc = crc32c::Extend(type_crc_[t], ptr, length);
  crc = crc32c::Mask(crc);  // Adjust for storage
  EncodeFixed32(buf, crc);

  // Write the header and the payload
  Status s = dest_->Append(Slice(buf, kHeaderSize));
  if (s.ok()) {
    s = dest_->Append(Slice(ptr, length));
    if (s.ok()) {
      s = dest_->Flush();
    }
  }
  block_offset_ += kHeaderSize + length;
  return s;
}

```

从其源码中可以看出，该方法通过`Flush`方法将用户态buffer中写入的内容刷入内核态buffer后便会返回，后续写入通过操作系统实现。如果掉电时，操作系统还没有将数据写入到稳定存储，数据仍会丢失。为了确保内核缓冲区中的数据会被写入到稳定存储，需要通过系统调用实现，在POSIX系统下常用的系统调用有`fsync`、`fdatasync`、`msync`等。

`leveldb::log::Writer`的`AppendRecord`方法最终是通过`EmitPhysicalRecord`实现的，因此我们追溯到LevelDB调用`AppendRecord`的位置，其位于`db/db_impl.cc`中`DBImpl::Write`方法的实现中：

```cpp

// ... ...

status = log_->AddRecord(WriteBatchInternal::Contents(write_batch));
bool sync_error = false;
if (status.ok() && options.sync) {
  status = logfile_->Sync();
  if (!status.ok()) {
    sync_error = true;
  }
}
if (status.ok()) {
  status = WriteBatchInternal::InsertInto(write_batch, mem_);
}
mutex_.Lock();

// ... ...

```

如果开启了`WriteOptions.sync`选项，LevelDB此处会在调用`AppendRecord`后调用`WritableFile`的`Sync`方法以保证数据被同步到了稳定存储中。在POSIX环境下，`WritableFile`的`Sync`方法实现最终会落到`SyncFd`方法中，该方法位于`util/env_posix.cc`文件中：

```cpp

  // Ensures that all the caches associated with the given file descriptor's
  // data are flushed all the way to durable media, and can withstand power
  // failures.
  //
  // The path argument is only used to populate the description string in the
  // returned Status if an error occurs.
  static Status SyncFd(int fd, const std::string& fd_path) {
#if HAVE_FULLFSYNC
    // On macOS and iOS, fsync() doesn't guarantee durability past power
    // failures. fcntl(F_FULLFSYNC) is required for that purpose. Some
    // filesystems don't support fcntl(F_FULLFSYNC), and require a fallback to
    // fsync().
    if (::fcntl(fd, F_FULLFSYNC) == 0) {
      return Status::OK();
    }
#endif  // HAVE_FULLFSYNC

#if HAVE_FDATASYNC
    bool sync_success = ::fdatasync(fd) == 0;
#else
    bool sync_success = ::fsync(fd) == 0;
#endif  // HAVE_FDATASYNC

    if (sync_success) {
      return Status::OK();
    }
    return PosixError(fd_path, errno);
  }

```

`SyncFd`会根据宏定义来检查编译环境下系统支持的系统调用，并在保证安全的条件下选择开销最小的系统调用实现。