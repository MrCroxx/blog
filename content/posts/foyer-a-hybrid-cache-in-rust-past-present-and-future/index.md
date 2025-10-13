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

Nowadays, especially with the help of AI, most startups aim to move as fast as possible. But in my career at a database company, I want do something a bit different — to build **solid** systems.

A complex production environment is the best way to test whether a system is solid. The more widely a project is used, the more opportunities it has to be tested in various real-world scenarios. The best way to make a project widely adopted is to build with **open source**, build in **public**, and build for **general propose**. This has always been the core philosophy of the ***Foyer***.

And with the inspiration from many excellent open source project, such as [***CacheLib***](https://github.com/facebook/CacheLib), [***Caffeine***](https://github.com/ben-manes/caffeine), [***Moka***](https://github.com/moka-rs/moka), and [***Quick Cache***](https://github.com/arthurprs/quick-cache), ***Foyer*** aims to achieve the following goals:

1. 


