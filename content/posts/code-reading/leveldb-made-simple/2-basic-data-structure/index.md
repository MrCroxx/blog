---
title: "深入浅出LevelDB —— 0x02 Bisic Data Format [施工中]"
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

为了便于后续的分析，本节将介绍LevelDB中常用的基本数据格式。

## 1.切片Slice

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

## 2. 整型与Slice编码方式

相关文件：`coding.h`、`coding.cc`。

LevelDB中另一种常用的数据类型是整型。在LevelDB的源码中，其直接使用了`<cstdint>`的`uint32_t`与`uint64_t`作为整型类型，因此我们只需要关注其编码为字节数组的方式。

LevelDB中为整型提供了两类编码方式，一类是定长编码，一类是变长编码。

另外，LevelDB为了便于从字节数组中划分Slice，其还提供了一种`LengthPrefixedSlice`的编码方式，在编码中将长度确定的Slice的长度作为Slice的前缀。

### 2.1 整型定长编码

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

### 2.2 整型变长编码

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

### 2.3 长度确定的Slice编码

长度确定的Slice的编码方式非常简单，只需要在原Slice之前加上用变长整型表示的Slice长度即可：

```cpp

void PutLengthPrefixedSlice(std::string* dst, const Slice& value) {
  PutVarint32(dst, value.size());
  dst->append(value.data(), value.size());
}

```










# 施工中 ... ...