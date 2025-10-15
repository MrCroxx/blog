---
title: "Foyer: A Hybrid Cache in Rust — Past, Present, and Future"
date: "2025-10-11"
summary: "Foyer: A Hybrid Cache in Rust — Past, Present, and Future"
categories: ["foyer"]
tags: ["caching", "storage", "Rust"]
draft: false
---

## 0. Some Opening Chit-chat

For those who may not know, over the past few months, I've been continuously developing and maintaining a hybrid cache library in Rust, [***Foyer***](https://github.com/foyer-rs/foyer).

However, from the very beginning until now, I haven’t had the chance to properly introduce this project through an article. On one hand, I’m not very skilled at writing in English, so I kept procrastinating. (Thanks to ChatGPT, I can focus more on the content rather than worrying about my limited English writing skill.) On the other hand, ***Foyer*** was evolving rapidly in its early stages, undergoing major refactoring almost every few months. As a result, it felt premature to formally introduce the project.

But now, ***Foyer*** has already gained more start on Github than than the project it was originally inspired by — Facebook’s [***CacheLib***](https://github.com/facebook/cachelib). This excites me and makes me worry even more about the future of ***Foyer***. So, I think it's time to write a proper blog to introduce it.

![Foyer & CacheLib - Star History - 20251011](assets/star-history-20251011.png "Foyer & CacheLib - Star History - 20251011")

Just a heads-up, this blog mainly shares my thoughts and decisions about the ***Foyer*** project and its future. It might be quite verbose. If you only want to learn about ***Foyer***’s features, architecture, and how to use it, please check out the official ***Foyer*** documentation below.

- [Foyer - Github](https://github.com/foyer-rs/foyer)
- [Foyer - Homepage](https://foyer-rs.github.io/foyer/)
- [Foyer - Architecture](https://foyer-rs.github.io/foyer/docs/design/architecture)
- [Foyer - Case Study in RisingWave](https://foyer-rs.github.io/foyer/docs/case-study/risingwave)

## 1. Not Only Yet Another Hybrid Cache

The idea of building a hybrid cache (a combination of in-memory cache and disk cache) first started in 2020. Coincidentally, the project that inspired ***Foyer***, ***CacheLib***, also published its [OSDI paper](https://www.usenix.org/system/files/osdi20-berg.pdf) in the same year.

Back in 2020, I was an intern at ***PingCAP***, working on some development task of [***TiKV***](https://github.com/tikv/tikv), the distributed storage engine for the distributed OLTP database [***TiDB***](https://github.com/pingcap/tidb). At that time, most databases, including TiDB, still used local disk or EBS service as the main storage medium, while S3 was mainly used as a cold backup for snapshot data.

![TiKV Architecture](assets/tikv-architecture.png "TiKV - Architecture(Source: https://tikv.org/docs/3.0/concepts/architecture/)")

As S3 became more widely adopted, its remarkable availability, durability, scalability, and low storage cost became increasingly attractive. ***TiDB*** also wanted to move toward a cloud-native architecture that uses S3 as the main storage medium, just like some new databases at that time. There had already been many design discussions within ***PingCAP***, which later evolved into what is now ***Cloud-native TiDB*** (or maybe it's called ***Serverless TiDB***? I'm not quite sure).

> UPDATE: During my writing this blog, their CEO Dongxu just released a blog and announced the new architecture as TiDB X. Yet another 'X', fine. 🫠

Unfortunately, since I was pursuing my master’s degree at that time, I didn't have the energy to continue my internship at ***PingCAP***. However, this experience had a profound impact on my interests. My master's thesis focused on designing and optimizing an OLTP KV database based on S3. Later, when I had time to take another internship, I joined ***RisingWave Labs***. They were developing a streaming database based on Cloud and S3, [***RisingWave***](https://github.com/risingwavelabs/risingwave), which gave me the chance to apply my research to a real-world project.

![RisingWave - Architecture](assets/risingwave-architecture.png "RisingWave - Architecture (Source: https://risingwave.com/blog/hummock-a-storage-engine-designed-for-stream-processing/)")

As I expected, after experiencing the honeymoon phase with S3’s reliability, durability, scalability, and storage cost on databases or other data infrastructures based on S3, its shortcomings also gradually became apparent:

1. **High and unpredictable latency** makes it hard to meet performance requirements.
2. **Expensive API access fees** can make it even more costly than traditional solutions.

Fortunately, both of these problems can be solved with the same approach, which is **caching**. However, the bad news is, since ***RisingWave*** often needs to join two streams from OLTP database's CDC, its storage access patterns are highly random and the working set can be extremely large. Using an expensive in-memory cache alone is not enough to handle this scenario effectively. Therefore, ***RisingWave*** needs to introduce an additional disk cache, making its caching system a **hybrid cache**.

> For more details, please refer to [Foyer - Case Study - RisingWave - Challenge 1](https://foyer-rs.github.io/foyer/docs/case-study/risingwave#1-the-memory-cache-cannot-cover-the-working-set).
>
> There are also funny diagrams. 🤣

When researching options for hybrid caching, I also looked into the newly open-sourced ***CacheLib***. ***CacheLib***’s C++ code is very solid, especially the in-memory cache component. Moreover, ***CacheLib*** is backed by OSDI'20 papers. However, for several reasons, we ultimately decided not to use ***CacheLib***. Instead, we developed our own hybrid cache library in Rust. Here were our considrations:

1. ***CacheLib*** requires entries to use ***CacheLib***-allocated memory.

This limitation means that entries must be serialized, even if only in-memory cache is used and disk cache is not involved. 

> For more details, please refer to ***CacheLib***'s official document, [CacheLib - Write data to cache](https://cachelib.org/docs/Cache_Library_User_Guides/Write_data_to_cache#allocate-memory-for-data-from-cache). Here is a code snippet from it.
>
> ```cpp
> string data("new data");
>
> // Allocate memory for the data.
> auto handle = cache->allocate(pool_id, "key2", data.size());
> 
> // Write the data to the cache.
> std::memcpy(handle->getMemory(), data.data(), data.size());
> 
> // Insert the item handle into the cache.
> cache->insertOrReplace(handle);
> ```

Since disk bandwidth is much lower than memory bandwidth, not all entries can be written to disk cache under heavy load. This is especially true when using EBS in the cloud. Some entries need to be dropped in advance to avoid OOM issues. Additionally, hot entries may not need to use disk cache when they are updated or deleted. Under this limitation, some entries will be unnecessarily serialized, resulting in extra performance overhead.

Moreover, we were not fully confident in the effectiveness of hybrid cache at that time. Therefore, we needed a way to configure the system so that hybrid cache could seamlessly fall back to pure in-memory cache without any overhead. Clearly, this limitation did not meet our requirements.

2. ***CacheLib***, as a C++ project, cannot be easily integrated with the Rust ecosystem of ***RisingWave***.

This is quite obvious. Maintaining the version, build scripts, and FFI for a C++ project within a Rust project requires extra effort. But what I'm taking about here is more than these.

Debugging performance issues and annoying concurrency problems requires comprehensive observability support, including logging, metrics, and tracing. Without patching the ***CacheLib*** code, it is impossible to achieve full observability. Even if we patch the code and maintain a fork, integrating with Rust’s observability ecosystem would still require significant additional effort. These uncertainties could be even greater than rewriting the component in Rust.

3. (**For me**) Rewriting a production-grade system is always an interesting challenge.

There are many ways to learn from a project’s experience, such as trying it yourself, reading the source code, browsing the issues and pull requests, or discussing it with experts. However, none of these methods are as effective as rewriting the project, or rewriting it in a different way.

Other methods help you understand the current state of a project, but rewriting it in your own way gives you deeper insight into why the project evolved as it did. It is about learning the decisions, the trade-offs, the design philosophy, and also black-box technologies that can be used directly without the need for learning.

In the end, we decided to rewrite a hybrid cache in Rust, which is ***Foyer***. And personally, I did't expect ***Foyer*** to be just yet another "**RIIR (Rewrite it in Rust)**" project, but a production-ready solution with unique and outstanding features.

## 2. Build to be Solid

Nowadays, especially with the help of AI, most startups and developers aim to move as fast as possible. But in my career at a database company, I want do something a bit different — to build **solid** systems, especially for infrastructures.

A complex production environment is the best way to test whether a system is solid. The more widely a project is used, the more opportunities it has to be tested in various real-world scenarios. The best way to make a project widely adopted is to build with **open source**, build in **public**, and build for **general** scenarios. This has always been the core philosophy of the ***Foyer***.

And with the inspiration from many excellent open source project, such as [***CacheLib***](https://github.com/facebook/CacheLib), [***Caffeine***](https://github.com/ben-manes/caffeine), [***Moka***](https://github.com/moka-rs/moka), and [***Quick Cache***](https://github.com/arthurprs/quick-cache), ***Foyer*** aims to achieve the following goals:

1. Suitable for most general scenarios.
2. Meanwhile, performance is not compromised.
3. A user- and developer-friendly experience.

The first and second goals seem to be in conflict with each other. That's true, at least under peak performance conditions. Many of ***Foyer***'s key trade-offs are also about balancing these two goals. Let's talk about them.

### 2.1 Flexible Architecture for Most General Scenarios

> This section is mostly taken from ***Foyer***'s official document [Foyer - Architecture](https://foyer-rs.github.io/foyer/docs/design/architecture). But reorganized to fit the blog.

In production environments, different systems have diverse caching requirements. This is also the one of the philosophies in ***CacheLib***'s paper. Hence, to build a hybrid cache system suitable for most general scenarios, it must offer enough flexibility to handle a wide range of caching requirements. The flexibility includes, but is not limited to, the following aspects:

1. The flexibility to switch between various cache algorithms.
2. The flexibility to switch between cache engines to be optimal for specified workload.
3. Minimizing the effort for develops to switch between different configurations.

To achieve this, ***Foyer*** learned from the excellent architecture of ***CacheLib*** — adopts a **plug-and-play** modular design throughout its architecture. Let's go through it.

#### 2.1.1 Hybrid Cache Architecture

![Foyer Architecture - Hybrid Cache](assets/hybrid-cache.svg "Foyer Architecture - Hybrid Cache")

As a hybrid cache, ***Foyer*** automatically manages the behavior and lifecycle of cache entries between the in-memory cache and the disk cache. It consists of three components to provide hybrid cache functionality.

1. **Memory Cache (provided by crate `foyer-memory`):** Pure in-memory cache library. Similar to other in-memory cache libraries, it provides functionalities such as adding, deleting, updating, and querying cache entries. Besides, to be compatible with the disk cache, it also provides optimizations such as request merging and support for asynchronous interfaces. (This crate can be used separately as a pure in-memory cache with minimal overhead.)
2. **Disk Cache (provided by crate `foyer-storage`):** Includes the disk cache engines, IO engines, and device driver layer. It cannot be used independently and can only be utilized through ***Foyer***.
3. **Cooperator (Integrated in crate `foyer`):** A lightweight wrapper to coordinate in-memory cache and disk cache.

Besides the hybrid cache mode, ***Foyer*** can also operate as a pure in-memory cache in compatibility mode. This mode doesn't require any API modifications based on the hybrid cache and is therefore suitable for systems that need both pure in-memory cache and hybrid cache operation. In this mode, ***Foyer*** provisions a no-op disk cache engine. This introduces only a minimal overhead in exchange for API compatibility.

![Foyer - Hybrid Cache Compatible Mode](assets/hybrid-cache-compatible-mode.svg "Foyer - Hybrid Cache Compatible Mode")

If you only need to use ***Foyer*** as a pure in-memory cache, you can directly use `Cache` instead of `HybridCache`. `Cache` is a re-export from the `foyer-memory` crate. It provides APIs and usage similar to mainstream cache libraries, and also offers all the features of the in-memory cache part within the ***Foyer*** hybrid cache, including: interchangeable cache algorithms, request deduplication optimization, etc.

![Foyer - Pure In-memory Cache Mode](assets/pure-in-memory-cache-mode.svg "Foyer - Pure In-memory Cache Mode")

#### 2.1.2 In-memory Cache Architecture

***Foyer***'s memory cache provides a high-performance, flexible, and composable pure in-memory cache implementation with the following key features:

- **Plug-and-Play Algorithms**: Empowers users with easily replaceable caching algorithms, ensuring adaptability to diverse use cases.
- **Fearless Concurrency**: Built to handle high concurrency with robust thread-safe mechanisms, guaranteeing reliable performance under heavy loads.
- **Zero-Copy In-Memory Cache Abstraction**: Leveraging Rust's robust type system, the in-memory cache in foyer achieves a better performance with zero-copy abstraction.

![Foyer - In-memory Cache Architecture](assets/memory-cache.svg "Foyer - In-memory Cache Architecture")

***Foyer***'s in-memory cache consists of three main components:

1. **Flexible & Composable Framework:** A framework that adopts a flexible and composable design. Supports arbitrary combinations of different indexer implementations and eviction algorithm implementations. Provides basic CRUD operation support, lock/lock-free algorithm supports, automatic cache refill and request dedup supports on cache miss.
2. **Indexer:** Pluggable indexer implementations. Currently, hash table implementation provided by hashbrown is supported to enable point get queries. In future versions, indexer implementations based on trie are planned to support advanced functions like prefix queries.
3. **Eviction Algorithm:** Pluggable cache eviction algorithm implementations. Currently, ***Foyer*** provides algorithms such as FIFO, LRU with high priorities, w-TinyLFU, S3-FIFO, and SIEVE. More production-ready algorithms and a simpler custom algorithm framework will be supported in future versions.

#### 2.1.3 Disk Cache Architecture

***Foyer***'s disk cache is designed to support disk caches ranging from tens of gigabytes to hundreds of terabytes in size with minimal overhead. It consists of the following main components:

1. **Flexible & Composable Framework:** A flexible and composable framework adaptable to various disk cache engines, IO engines, and IO devices.
2. **Disk Cache Engine:** Pluggable disk cache engine. Users can choose a specific engine for their own scenarios to better adapt to their workload. Currently, ***Foyer*** provides or plans to provide the following types of disk cache engines:
    - *Set-Associated Engine (WIP):*: Optimized for ~4KiB cache entries.  
    - *Block Engine:* General-proposed engine that is optimized for 4KiB~1GiB cache entries.
    - *Object Engine (WIP):* Optimized for 1MiB~ cache entries.
    - *Customized Engine*: Users can customize the disk cache engine, or combine the existing disk cache engines provided by ***Foyer*** according to rules.
3. **IO Engine:** Engine for performing disk cache IO operations. Currently, ***Foyer*** provides or plans to provide the following types of io engines:
    - *Psync Engine:* Use a thread pool and blocking `pread(2)/pwrite(2)` syscalls to perform IO operations.
    - *Libaio Engine (WIP):* Use `libaio` asynchronous IO to perform IO operations.
    - *Uring Engine:* Use `io_uring` asynchronous IO toe perform IO operations.
4. **IO Device:** Device abstraction layer. Currently supports single file, raw block device, and filesystem directory.

![Foyer - Disk Cache Architecture](./assets/disk-cache.svg "Foyer - Disk Cache Architecture")

### 2.2 Uncompromised Performance

As mentioned before, it’s challenging to achieve optimal performance with a flexible architecture. It requires careful design and optimizaion. This sections will talk about some techniques that ***Foyer*** applied for it.

#### 2.2.1 Sharding for High Concurrency

The memory cache framework of ***Foyer*** adopts sharding design to improve performance under high concurrency loads. Each shard has its own indexer and eviction algorithm container. This design greatly simplifies the engineering of concurrent data structures. Although usage imbalance between shards may occur when the capacity is extremely small, such severe data skew rarely happens in production environments.

![Foyer - Sharding in In-memory Cache](assets/memory-cache-shards.svg "[Foyer - Sharding in In-memory Cache")

#### 2.2.2 Intrusive Data Structures

For ultimate performance optimization, ***Foyer***'s in-memory cache is implemented using intrusive data structures. This not only increases ***Foyer***'s performance ceiling but also enables ***Foyer*** to model the indexer and eviction algorithm as containers. The in-memory cache data structure is designed as a multi-indexer data structure, providing more flexible and composable support for the indexer and eviction algorithm.

![Foyer - Intrusive Data Structure](assets/intrusive-data-structure.svg "Foyer - Intrusive Data Structure")

It is not easy to implement this kind of intrusive multi-container data structure in Rust. ***Foyer*** uses an implementation that based on [crates.io - intrusive-collections](https://crates.io/crates/intrusive-collections) to provide an efficient and safe API

In addition, ***Foyer*** also has a proposal based on **Arena** Memory Allocator. However, there is no obvious advantage in microbench, so it has not been adopted for the time being.

#### 2.2.3 "All-in-one" API for Concurrent Queries

***Foyer*** provides a powerful `fetch()` API. When using the `fetch()` API to access an entry, the caller can provide an async task that fetches the entry from remote storage. If a cache miss occurs, ***Foyer*** will automatically call this async task to retrieve the entry and backfill it into the cache. Additionally, this interface is optimized for concurrent requests for the same key. If multiple concurrent `fetch()` requests access the same key, only one request will be sent to remote storage; other callers will wait for the task to backfill the entry into the cache and then retrieve the result directly from the cache, thereby reducing the load on remote storage.

![Foyer - fetch() API](assets/fetch.svg "Foyer - fetch() API")

Moreover, hybrid cache also provides a `fetch()` API. Unlike the `fetch()` API of memory cache, the `fetch()` API of the hybrid cache offers additional compatibility and optimization for disk cache: when concurrent requests encounter a memory cache miss, only one request will be sent to the disk cache. If the disk cache also misses, then only one request will be sent to the remote storage. In addition, the `fetch()` API of this hybrid cache will also perform targeted optimizations based on the causes of disk cache misses: for example, if the miss is due to disk cache performance throttling, cache refill will not be triggered, and so on.

With `fetch()` API, an "all-in-one" query can be written as:

```rust
let entry = hybrid
    .fetch(20230512, || async {
        let value = s3.get(&20230512).await?;
        Ok(value)
    })
    .await?;
```

Moreover, ***Foyer*** is also refining the design of the interfaces for querying. It will combine the current complex interfaces like `get()`, `obtain()`, and `fetch()`. (Don't worry if you are not familiar with other APIs. They will soon become things of the past.)

With the new design, you can use `get()` API to query entryes through a `Future` that returns a result of optilnal entry like with any other cache library . And `.fetch_on_miss()` API can be applied before awaiting the `Future` to achieve the same functionality as the current `fetch()` API. For example:

```rust
// Get an result of an optional entry.
let entry_or_nothing = hybrid
    .get(&20230512)
    .await?;

// Get an result of an entry, or fetch it from
// remote storage on cahce miss with optimization.
let entry = hybrid
    .get(&20230512)
    .fetch_on_miss(|| async {
        let value = s3.get(&20230512).await?;
        Ok(value)
    })
    .await?;
```

#### 2.2.4 Encode/Decode on Demand

In [1. Not Only Yet Another Hybrid Cache](#1-not-only-yet-another-hybrid-cache), I mentioned one of the reason that ***RisingWave*** didn't choose ***CacheLib*** as its hybrid cache implementation, which is, it always requires the entry to be copied to the ***cacheLib***'s managed memory, which involves encoding and decoding for complex structs on writting and reading, not matter if an entry actually goes to the disk cache.

In contrast, ***Foyer*** only requires entries to be encoded ordecoded when writing to or reading from the disk cache. If an entry only lives in memory, it is never required to be encoded or decoded. 

And thanks to Rust's powerful type system, ***Foyer***'s APIs are always typed with the key and value's type. ***Foyer*** carefully hides unsafe implementations behind safe interfaces, achieving a balance between performance and usability.

#### 2.2.5 Make the Hidden Overhead Controllable

Before this blog, there were some articles, presentations and discussions about ***Foyer***, such as this [Hacker News Topic](https://news.ycombinator.com/item?id=45349218). (The referenced article was actually written by *Yingjun Wu*, the CEO of ***RisingWave***, based on ***Foyer***'s documentation. Thank you *Yingjun* for promoting ***Foyer***. 🙏) The most common question is: Operating systems already have mechanisms like **swap** and **page cache**. Why do we need to build our own hybrid cache system to achieve similar functionality?

Although the underlying mechanisms can be complex, the answer to this question is actually quite simple: ***Make the hidden overhead controllable***.

To build applications with higher performance and lower overhead, modern programming languages and developers often use coroutine programming for IO-intensive applications. The ***Rust*** ecosystem follows the same approach. ***Rust*** provides built-in `async`/`await` support at the language level.

For readers who are not familiar with coroutine programming, here's a brief explanation. Coroutine programming shifts task scheduling to a user-space runtime and handles slow IO tasks asynchronously. When a slow IO operation begins, the user-level scheduler can switch to other tasks to keep executing, without blocking and waiting for the IO operation to finish. Because switching between coroutines is much lighter than switching between threads, this approach can greatly increase system throughput and reduce the overhead caused by thread switching. **In the coroutine programming model, blocking the current thread is very costly.**

Let's continue the topic about why ***Foyer*** doesn't directly use **swap** or **page cache** to implement a hybrid cache.

When reading, **swap** is triggered by a **page fault**. Unfortunately, due to hardware limitations, a **page fault** can only be handled synchronously, blocking the entire thread. Frequent **page fault**s can cause significant performance degradation in coroutine-based programming. Moreover, it is difficult to predict when **swap** will be triggered. Even when using synchronous programming, **swap** can still seriously impact performance in critical paths. This is why most performance-sensitive systems recommend disabling swap in production environments. THe same goes for ***Foyer***.

In contrast, the **page cache** is not as harmful to performance. In fact, in the latest version, ***Foyer*** also recommends that general users use IO devices that support the page cache (that is, not using direct IO mode). However, since ***Foyer*** itself offers an in-memory cache, and its algorithm can be tuned to better fit the workload. Enabling the **page cache** may lead to redundant data being cached in some cases. Additionally, to support efficient index compression and compatibility with raw block devices, ***Foyer***’s disk cache engine often aligns read and write addresses to 4K boundaries. Therefore, for special scenarios, users can choose Direct IO mode to bypass the **page cache**.

In addition, operating systems need to handle a wide range of complex requirements. A dedicated system can focus on a single use case, eliminate unnecessary overhead, and deliver better performance. 

Here's another example that ***Foyer*** encountered previously. One of ***Foyer***'s disk cache engines may perform concurrent reads and writes on the same block under high concurrency. When using a filesystem directory instead of a raw block device as the IO device, we observed increased read tail latency. Because it is the tail latency of syscall `pread(2)` to be observed, I used **eBPF** probes to trace it.

```text
vfs_read                     |  39.767ms | ========================================
ext4_file_read_iter          |  39.756ms | =======================================
iomap_dio_rw                 |   4.270ms |                                  ======
filemap_write_and_wait_range |   4.146µs |                                  =
```

The result shows that the abnormal latency comes from a **inode** mutex in **ext4** file system.

```c
static ssize_t ext4_dio_read_iter(struct kiocb *iocb, struct iov_iter *to)
{
    ssize_t ret;
    struct inode *inode = file_inode(iocb->ki_filp);

    if (iocb->ki_flags & IOCB_NOWAIT) {
        if (!node_trylock_shared(inode))
            return -EAGAIN;
    } else {
        inode_lock_shared(inode); // <============ here
    }

    // ... ...
}
```

In fact, **inode** locks like this exist in most filesystem implementations. It is hard to avoid with file systems. Therefore, ***Foyer*** supports using the disk cache directly on raw block devices. Since the operating system requires raw block devices to be accessed with Direct IO, the **page cache cannot** be used in this setup. Meanwhile, by eliminating an intermediate layer, it also helps reduce NAND erasures to some extent, which is beneficial for SSD lifespan.

#### 2.2.6 Asynchronous I/O Engine Support — `io_uring`

To further improve disk cache performance, ***Foyer*** also supports the true asynchronous I/O engine, such as `io_uring`. However, ***Foyer*** is not only for **Linux** users, so it still needs to support other I/O engines, such as an engine powered by `pread(2)`/`pwrite(2)` and thread pool.

To achieve this, ***Foyer*** uses a plug-and-play I/O engine design. (You can find the disk cache architecture in [2.1.3 Disk Cache Architecture](#213-disk-cache-architecture).)

Inheriting design concepts from the file system in operating systems, ***Foyer***’s I/O Engine operations directly with the file descriptors (`fd`), or `FileHandle` in Windows. And ***Foyer***'s Device abstraction works as a translator that maps logical addresses to file descriptors (`fd`) or `FileHandle`s and their corresponding offsets. This design hides the implementation details of different I/O engines, and can be easily fallback to other I/O engiens if some is not supported on the specificed platforms.

According to benchmark results, with proper parameter settings, the `io_uring` engine can reduce the p50 latency of ***Foyer*** disk cache by more than 30%.

> `io_uring` is not always better than using `pread(2)`/`pwrite(2)` with a thread pool, but it offers more configurable parameters, making it easier to tune and debug in extreme situations.

### 2.3 Evolving User- and Developer-friendly Experience
 
!!!!!!!!!!

!!!!!!!!!!

!!!!!!!!!!

!!!!!!!!!!

!!!!!!!!!!

!!!!!!!!!!


