---
title: "深入浅出LevelDB —— 0x02 Bisic Utils [施工中]"
date: 2021-03-04T20:20:15+08:00
lastmod: 2021-03-04T20:20:19+08:00
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

为了便于后续的分析，本节将介绍LevelDB中较为通用的基本数据结构与工具及其实现。

## 1. 内存分配器Arena

相关文件：`util/arena.h`、`util/arena.cc`。

`Arena`是LevelDB的内存分配器。LevelDB统一由Arena向操作系统申请内存，需要分配在堆上的数据结构再通过Arena申请一段连续的空间。

与大多数存储系统一样，Arena在其生命周期中也不会主动将已经获得的内存归还给操作系统。此外，像Arena申请内存的数据结构也不会在Arena的生命周期中归还其占用的内存，这与数据结构的使用场景及使用相关。

Arena对外提供了以下方法：

```cpp

class Arena {
 public:
  Arena();

  Arena(const Arena&) = delete;
  Arena& operator=(const Arena&) = delete;

  ~Arena();

  // Return a pointer to a newly allocated memory block of "bytes" bytes.
  char* Allocate(size_t bytes);

  // Allocate memory with the normal alignment guarantees provided by malloc.
  char* AllocateAligned(size_t bytes);

  // Returns an estimate of the total memory usage of data allocated
  // by the arena.
  size_t MemoryUsage() const {
    return memory_usage_.load(std::memory_order_relaxed);
  }

  // ... ...

}

```

Arena对外的分配方法有两种，区别在于是否按照机器位数对齐。Arena内部主要通过4个字段实现：

```cpp

class Arena {

  // ... ...

 private:
  char* AllocateFallback(size_t bytes);
  char* AllocateNewBlock(size_t block_bytes);

  // Allocation state
  char* alloc_ptr_;
  size_t alloc_bytes_remaining_;

  // Array of new[] allocated memory blocks
  std::vector<char*> blocks_;

  // Total memory usage of the arena.
  //
  // TODO(costan): This member is accessed via atomics, but the others are
  //               accessed without any locking. Is this OK?
  std::atomic<size_t> memory_usage_;
};

```

`std::vector<char*> blocks_`字段按block来保存已申请的内存空间，`char* alloc_ptr_`指向当前块中还未分配的内存地址，`size_t alloc_bytes_remaining_`记录了当前块中剩余的未分配空间大小，`std::atomic<size_t> memory_usage_`记录了Arena获取的总内存大小（包括了每个block的header大小）。注意，这里“当前块”并非向操作系统申请获得的最后一个块，因为Arena为了避免浪费，会为较大的请求分配单独的块（详见下文），这里的“当前块”是指除了这些单独分配的块外获得的最后一个块。

当LevelDB通过`Allocate`方法向Arena请求内存时，Arena首先会检查当前块的剩余空间，如果当前块剩余空间能够满足分配需求，则直接将剩余空间分配给调用者，并调整`alloc_ptr`与`alloc_bytes_remaining`：

```cpp

inline char* Arena::Allocate(size_t bytes) {
  // The semantics of what to return are a bit messy if we allow
  // 0-byte allocations, so we disallow them here (we don't need
  // them for our internal use).
  assert(bytes > 0);
  if (bytes <= alloc_bytes_remaining_) {
    char* result = alloc_ptr_;
    alloc_ptr_ += bytes;
    alloc_bytes_remaining_ -= bytes;
    return result;
  }
  return AllocateFallback(bytes);
}

```

如果当前块剩余空间不足，Arena会调用内部的`AllocateFallback方法`：

```cpp

char* Arena::AllocateFallback(size_t bytes) {
  if (bytes > kBlockSize / 4) {
    // Object is more than a quarter of our block size.  Allocate it separately
    // to avoid wasting too much space in leftover bytes.
    char* result = AllocateNewBlock(bytes);
    return result;
  }

  // We waste the remaining space in the current block.
  alloc_ptr_ = AllocateNewBlock(kBlockSize);
  alloc_bytes_remaining_ = kBlockSize;

  char* result = alloc_ptr_;
  alloc_ptr_ += bytes;
  alloc_bytes_remaining_ -= bytes;
  return result;
}

```

`AllocateFallback`会判断需要分配的大小，如果需要分配的大小超过了默认块大小的$\frac{1}{4}$，为了避免浪费当前块的剩余空间，Arena会为其单独分配一个大小等于需求的块，此时不需要调整`alloc_ptr`与`alloc_bytes_remaining`字段，这样做的另一个好处是这一逻辑也可以用于分配需求大于默认块大小的空间；如果需要分配的大小没有超过默认块大小的$\frac{1}{4}$，此时不再使用当前块的剩余空间浪费也很小，因此直接申请一个默认大小的块，并从新块分配空间，同时调整`alloc_ptr`与`alloc_bytes_remaining`字段。

`AllocateNewBlock`会通过`new`关键字向操作系统申请内存空间，并将获得的内存块保存到`blocks_`中，同时更新`memory_usage_`字段：

```cpp

char* Arena::AllocateNewBlock(size_t block_bytes) {
  char* result = new char[block_bytes];
  blocks_.push_back(result);
  memory_usage_.fetch_add(block_bytes + sizeof(char*),
                          std::memory_order_relaxed);
  return result;
}

```

在计算`memory_usage_`时，使用的空间除了需求的空间大小`block_bytes`外，还要加上`new`关键字为数组分配空间时为数组加上的header大小（这样`delete[]`关键字才能知道需要释放的数组大小）。

## 2.切片Slice

相关文件：`include/leveldb/slice.h`。

`Slice`是LevelDB中广泛使用的切片类。Slice的结构非常简单，其只有两个字段，分别保存切片指针与切片大小：

```cpp

class LEVELDB_EXPORT Slice {

  // ... ...
 private:
  const char* data_;
  size_t size_;
};

```

Slice只关心切片的位置与大小，而不关心切片内容。因此。我们可以将Slice看做字节数组切片。

Slice有4种构造方法，其显式使用了默认的拷贝构造方法与拷贝构造运算符：

```cpp

class LEVELDB_EXPORT Slice {
 public:
  // Create an empty slice.
  Slice() : data_(""), size_(0) {}

  // Create a slice that refers to d[0,n-1].
  Slice(const char* d, size_t n) : data_(d), size_(n) {}

  // Create a slice that refers to the contents of "s"
  Slice(const std::string& s) : data_(s.data()), size_(s.size()) {}

  // Create a slice that refers to s[0,strlen(s)-1]
  Slice(const char* s) : data_(s), size_(strlen(s)) {}

  // Intentionally copyable.
  Slice(const Slice&) = default;
  Slice& operator=(const Slice&) = default;

  // ... ...

}

```

从Slice的构造方法可以看出，在Slice实例构造时，LevelDB不会为其分配新的内存空间，而是直接将其指向需要表示的切片头位置。**因此，Slice的使用者需要确保在Slice实例还在使用时，其指向的内存不会销毁。**

Slice的默认比较方式比较主要通过`memcmp`实现：

```cpp

inline int Slice::compare(const Slice& b) const {
  const size_t min_len = (size_ < b.size_) ? size_ : b.size_;
  int r = memcmp(data_, b.data_, min_len);
  if (r == 0) {
    if (size_ < b.size_)
      r = -1;
    else if (size_ > b.size_)
      r = +1;
  }
  return r;
}

```

## 3. 整型与Slice编码方式

相关文件：`coding.h`、`coding.cc`。

LevelDB中另一种常用的数据类型是整型。在LevelDB的源码中，其直接使用了`<cstdint>`的`uint32_t`与`uint64_t`作为整型类型，因此我们只需要关注其编码为字节数组的方式。

LevelDB中为整型提供了两类编码方式，一类是定长编码，一类是变长编码。

另外，LevelDB为了便于从字节数组中划分Slice，其还提供了一种`LengthPrefixedSlice`的编码方式，在编码中将长度确定的Slice的长度作为Slice的前缀。

### 3.1 整型定长编码

LevelDB中整型的定长编码（*32bits*或*64bits*）方式非常简单，只需要将整型按照小端的顺序编码即可：

```cpp

inline void EncodeFixed32(char* dst, uint32_t value) {
  uint8_t* const buffer = reinterpret_cast<uint8_t*>(dst);

  // Recent clang and gcc optimize this to a single mov / str instruction.
  buffer[0] = static_cast<uint8_t>(value);
  buffer[1] = static_cast<uint8_t>(value >> 8);
  buffer[2] = static_cast<uint8_t>(value >> 16);
  buffer[3] = static_cast<uint8_t>(value >> 24);
}

inline void EncodeFixed64(char* dst, uint64_t value) {
  uint8_t* const buffer = reinterpret_cast<uint8_t*>(dst);

  // Recent clang and gcc optimize this to a single mov / str instruction.
  buffer[0] = static_cast<uint8_t>(value);
  buffer[1] = static_cast<uint8_t>(value >> 8);
  buffer[2] = static_cast<uint8_t>(value >> 16);
  buffer[3] = static_cast<uint8_t>(value >> 24);
  buffer[4] = static_cast<uint8_t>(value >> 32);
  buffer[5] = static_cast<uint8_t>(value >> 40);
  buffer[6] = static_cast<uint8_t>(value >> 48);
  buffer[7] = static_cast<uint8_t>(value >> 56);
}

```

定长整型的解码方式同理，这里不再赘述。

### 3.2 整型变长编码

当整型值较小时，LevelDB支持将其编码为变长整型，以减少其空间占用（对于值与类型最大值接近时，变长整型占用空间反而增加）。

对于变长整型编码，LevelDB需要知道该整型编码的终点在哪儿。因此，LevelDB将每个字节的最高位作为标识符，当字节最高位为1时表示编码未结束，当字节最高位为0时表示编码结束。因此，LevelDB的整型变长编码每8位用来表示整型值的7位。因此，当整型值接近其类型最大值时，变长编码需要额外一字节来容纳原整型值。

同样，变长整型编码也采用了小端顺序：

```cpp

// 笔者注：Encode

char* EncodeVarint32(char* dst, uint32_t v) {
  // Operate on characters as unsigneds
  uint8_t* ptr = reinterpret_cast<uint8_t*>(dst);
  static const int B = 128;
  if (v < (1 << 7)) {
    *(ptr++) = v;
  } else if (v < (1 << 14)) {
    *(ptr++) = v | B;
    *(ptr++) = v >> 7;
  } else if (v < (1 << 21)) {
    *(ptr++) = v | B;
    *(ptr++) = (v >> 7) | B;
    *(ptr++) = v >> 14;
  } else if (v < (1 << 28)) {
    *(ptr++) = v | B;
    *(ptr++) = (v >> 7) | B;
    *(ptr++) = (v >> 14) | B;
    *(ptr++) = v >> 21;
  } else {
    *(ptr++) = v | B;
    *(ptr++) = (v >> 7) | B;
    *(ptr++) = (v >> 14) | B;
    *(ptr++) = (v >> 21) | B;
    *(ptr++) = v >> 28;
  }
  return reinterpret_cast<char*>(ptr);
}

char* EncodeVarint64(char* dst, uint64_t v) {
  static const int B = 128;
  uint8_t* ptr = reinterpret_cast<uint8_t*>(dst);
  while (v >= B) {
    *(ptr++) = v | B;
    v >>= 7;
  }
  *(ptr++) = static_cast<uint8_t>(v);
  return reinterpret_cast<char*>(ptr);
}

```

在解码时，LevelDB只需要根据字节的最高位判断变长编码是否结束即可，这里不再赘述。另外，LevelDB提供了解码同时返回一些信息的方法，以方便在不通场景下的使用。

### 3.3 长度确定的Slice编码

长度确定的Slice的编码方式非常简单，只需要在原Slice之前加上用变长整型表示的Slice长度即可：

```cpp

void PutLengthPrefixedSlice(std::string* dst, const Slice& value) {
  PutVarint32(dst, value.size());
  dst->append(value.data(), value.size());
}

```










# 施工中 ... ...