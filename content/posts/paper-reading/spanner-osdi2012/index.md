---
title: "《Spanner: Google’s Globally-Distributed Database》论文翻译"
date: 2020-10-23T13:00:19+08:00
lastmod: 2020-10-28T20:53:29+08:00
draft: false
keywords: []
description: ""
tags: ["Spanner", "Translation"]
categories: ["Paper Reading"]
author: ""
featuredImage: img/paper-reading.jpg
---

*本篇文章是对论文[Spanner: Google’s Globally-Distributed Database](https://dl.acm.org/doi/pdf/10.1145/2491245)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 作者

James C. Corbett, Jeffrey Dean, Michael Epstein, Andrew Fikes, Christopher Frost, JJ Furman, Sanjay Ghemawat, Andrey Gubarev, Christopher Heiser, Peter Hochschild, Wilson Hsieh,Sebastian Kanthak, Eugene Kogan, Hongyi Li, Alexander Lloyd, Sergey Melnik, David Mwaura, David Nagle, Sean Quinlan, Rajesh Rao, Lindsay Rolig, Yasushi Saito, Michal Szymaniak, Christopher Taylor, Ruth Wang, Dale Woodford

Google, Inc.

## 摘要

Spanner是Google的可伸缩（scalable）、多版本（multi-version）、全球化分布式（globally-distributed）、同步多副本（synchronously-replicated）数据库。它是首个能将数据分布到全球范围内且支持外部一致性（externally-consistent）分布式事务的系统。本文描述了Spanner的结构、特性、多种底层设计决策的原理、和一种暴露时钟不确定度（uncertainty）的新型时间API。该API和它的实现对支持外部一致性和多种强大的特性来说非常重要，这些特性包括：对过去数据的非阻塞读取、无锁只读事务、和原子性模型（schema）修改，所有的这写操作都是跨所有Spanner的。

## 1. 引言

Spanner是一个可伸缩、全球化分布的数据库，其由Google设计、构建、并部署。在抽象的最高层，Spanner是一个将数据分片（shard）到分布在全世界的多个数据中心中的跨多个Paxos<sup>[21]</sup>状态机集合上的数据库。Spanner采用多副本以提供全球化的可用性和地理位置优化；客户端自动地在副本间进行故障转移。在数据总量或服务器的数量变化时，Spanner自动地在机器间重分片数据，并自动地在机器间（甚至在数据中心间）迁移数据来平衡负载和应对故障。按照设计，Spanner扩展到跨数百个数据中心的数百万台机器与数万亿个数据库行。

应用程序可以使用Spanner来实现高可用，即使在面对大范围自然灾害时，Spanner也可以通过在大洲内甚至跨大洲间备份数据。我们最初的使用者是F1<sup>[35]</sup>，F1是对Google的广告后端的重写。F1使用了5份分布在美国各地的副本。大部分的其它的应用程序可能在同一个地理区域但故障模式相对独立的3到5个数据中心中备份数据。也就是说，大多数应用程序选择了低延迟而不是高可用，只要它们能够容忍1或2个数据中心故障即可。

Spanner的主要目标是管理跨数中心的副本数据，但是我们还花了很多时间设计并实现了在我们的分布式系统基础架构之上的重要的数据库特性。尽管Bigtable<sup>[9]</sup>能够很好地满足很多项目的需求，但我们还是不断收到用户的抱怨，他们表示Bigtable对一些类型的应用程序来说难以使用：如那些有复杂、不断演进的模型的程序或那些想要在广域副本中维护强一致性的程序。（其他作者也提出了类似的主张<sup>[37]</sup>。）Google的许多应用程序选择使用Megastore<sup>[5]</sup>，因为它支持半结构化数据模型和副本同步，尽管它的写入吞吐量相对较弱。为此，Spanner从一个类似Bigtable的版本化键值存储（versioned key-value store）演进成了一个多版本时态数据库（temporal multi-version database）。数据被存储在模型化的半关系型表中；数据被版本化，且每个版本自动按照提交时间标记时间戳；旧版本遵循可配置的垃圾回收策略；应用程序可以读取时间戳较老的数据。Spanner支持通用的事务，且提供了基于SQL的查询语言。

作为全球化分布的数据库，Spanner提供了许多有趣的特性。第一，应用程序可以细粒度地动态控制数据的副本配置。应用程序可以通过指定约束来控制那个数据中心包含哪些数据、数据离它的用户多远（以控制读取延迟）、副本间多远（以控制写入延迟）、维护了多少份副本（以控制持久性、可用性、和读取性能）。数据还能被系统动态、透明地在数据中心间迁移以平衡数据中心间的资源使用率。第二，Spanner有两个在分布式数据库中难以实现的两个特性：Spanner提供了外部一致性（externally-consistent）<sup>[16]</sup>读写和对某个时间戳上的跨数据库全局一致性读取。这些特性让Spanner能支持一致性备份（consistent backup）、一致性MapReduce执行<sup>[12]</sup>和原子性模型更新，这些操作都是全局的，甚至可以出现在正在执行的事务中。

这些特性有效的原因在于，Spanner会为事务分配在全局有效的提交时间戳，尽管事务可能是分布式的。该时间戳反映了串行顺序。另外，串行顺序满足外部一致性（或等价的线性一致性<sup>[20]</sup>）：如果事务$T_1$在另一个事务$T_2$开始前提交，那么$T_1$的时间戳比$T_2$的小。Spanner是首个能在全球范围提供这些保证的系统。

实现这些属性的关键是一个新的TrueTime API及其实现。该API直接暴露了时钟不确定度，且对Spanner的时间戳的保证基于该API的实现提供的界限内。如果不确定度较大，Spanner会减速以等待该不确定度。Google的集群管理软件提供了TureTime API的一种实现。该实现通过使用多种现代参考时钟（GPS和原子时钟）来让不确定度保持较小（通常小于10ms）。

[第二章](#2-实现)描述了Spanner实现的结构、它的特定集合、和融入到了设计中的工程决策。[第三章](#3-truetime)描述了我们的新TureTime API并概述了其实现。[第四章](#4-并发控制)描述了Spanner如何使用TrueTime来实现具有外部一致性的分布式事务、无锁只读事务、和原子性模型更新。[第五章](#5-评估)提供了Spanner性能和TrueTime表现的一些benchmark，并讨论了F1的经验。[第六、七、八章](#6-相关工作)，描述了相关工作和展望，并总结了我们的结论。

## 2. 实现

本章描述了Spanner的结构和Spanner底层实现的原理。然后，我们描述了*dircetory（目录）* 抽象，directory用来管理副本和局部性（locality），它还是数据移动的单位。最后，我们描述了我们的数据模型、为什么Spanner看上去像关系型数据库而不是键值存储、怎样能让应用程序控制数据的局部性。

一份Spanner的部署被称为一个*universe*。因为Spanner在全球范围管理数据，所以只有少数的几个运行中的universe。我们目前运行了一个测试/练习场universe、一个开发/生产universe、和一个仅生产的universe。

Spanner被组织为*zone*的集合，每个zone都大致类似于一份Bigtable服务器集群<sup>[9]</sup>的部署。zone是部署管理的单位。zone的集合还是数据副本能够跨位置分布的位置集合。当有新的数据中心加入服务或旧的数据中心被关闭时，zone可以加入运行中的系统或从运行中的系统移除。zone也是物理隔离的单位：例如，如果不同的应用程序的数据必须跨同数据中心的不同的服务器的集合分区时，那么在一个数据中心中可能有一个或多个zone。

![图1 spanner服务器组织结构。](figure-1.png "图1 spanner服务器组织结构。")

**图1**描述了Sppanner universe中的服务器。一个zone有一个*zonemaster*和几百到几千个*spanserver*。前者为spannerserver分配数据，后者向客户端提供数据服务。客户端使用每个zone的*location proxy*来定位给它分配的为其提供数据服务的spanserver。*universe master*和*placement driver*目前是单例。universe master主要是一个控制台，其显示了所有zone的状态信息，以用来交互式调试。placement driver分钟级地处理zone间的自动化迁移。placement driver定期与spanserver交互来查找需要移动的数据，以满足更新后的副本约束或进行负载均衡。出于篇幅的原因，我们仅详细描述spanserver。

### 2.1 spanserver软件栈

本节着眼于spanserver的实现以阐述副本和分布式事务如何被分层到我们的基于Bigtable的实现中。软件栈如**图2**所示。在最底层，每个spanserver负责100到1000个被称为*tablet*的数据结构实例。每个tablet都类似于Bigtable的tablet抽象，其实现了一系列如下的映射：

$$ (key:string, timestamp:int64) \rightarrow string $$

![图2 spanserver软件栈。](figure-2.png "图2 spanserver软件栈。")

不像Bigtable，Spannner为数据分配时间戳，这是Spanner更像多版本数据库而不是键值存储的重要原因之一。tablet的状态被保存在一系列类B树的文件和一个预写日志（write-ahead log，WAL）中，它们都在一个被称为Colossus的分布式文件系统中（Google File System<sup>[15]</sup>的继任者）。

为了支持副本，每个spanserver在每个tablet上实现了一个Paxos状态机。（早期的Spanner原型支持为每个tablet实现多个Paxos状态机，这让副本配置更加灵活。但是其复杂性让我们放弃了它。）每个状态机在它相关的tablet中保存其元数据和日志。我们的Paxos实现通过基于定时的leader租约（lease）来支持长期领导者，租约的默认长度为10秒。目前，在Spanner的实现中，每次Paxos write会被记录两次：一次在tablet的日志中，一次在Paxos的日志中。这种选择是权宜之策，我们最终很可能会改进这一点。我们的Paxos实现是流水线化的，以在有WAN延迟的情况下提高Spanner的吞吐量；但是Paxos会按顺序应用写入（[第四章](#4-并发控制)会依赖这一点）。

在实现一致性的多副本映射的集合时，使用了Paxos状态机。每个副本的键值映射状态被保存在其对应的tablet中。写操作必须在leader处启动Paxos协议；读操作直接从任意足够新的副本处访问其底层tablet的状态。副本的集合是一个Paxos *group*。

在每个spanserver的每个leader副本中，都实现了一个*lock table*来实现并发控制。lock table包括2阶段锁（two-phase lock）状态：它将键的区间映射到锁状态。（值得注意的是，长期Paxos leader对高效管理lock table来说十分重要。）在Bigtable和Spanner中，lock table都是为长期事务设计的（例如报告生成，其可能需要几分钟的时间），它在存在冲突的乐观并发控制协议下表现不佳。需要获取同步的操作（如事务性读取）会在lock table中请求锁；其它的操作会绕过lock table。

在每个spanserver的每个leader副本中，还实现了一个*transaction manager*来提供分布式事务支持。实现*participant leader*时使用了transaction manager；group中的其它副本称为*participant slave*。如果事务仅有一个Paxos group参与（大多数事务都是这种情况），它可以绕过transaction manager，因为lock table和Paxos在一起能够提供事务性。如果事务有超过一个Paxos group参与，那些group的leader会相互配合执行两阶段提交（two-phase commit，2PC）。参与的group之一会被选为*coordinator*：该group的participant leader会作为*coordinator leader*，该group的salve会作为*coordinator slave*。每个transaction manager的状态会被保存在底层Paxos group中（因此它也是多副本的）。

### 2.2 directory与放置

在键值映射集合的上层，Spanner的实现支持一种被称为*directory（目录）*的*bucket（桶）*抽象，它是一系列共享相同的前缀（prefix）的连续的键的集合。（术语*directory*的选择处于历史上的偶然，更好的术语可能是*bucket*。）我们将在[章节2.3](#23-数据模型)中解释前缀的来源。对directory的支持让应用程序能够通过谨慎地选取键以控制它们的数据的局部性。

directory是数据放置（placement）的单位。在同一个directory的所有数据都有相同的副本配置。当数据在Paxos group间移动时，它是以directory为单位移动，如**图3**所示。Spanner可能会为分流Paxos group的负载而移动directory、可能为了把经常被一起访问的directory放在同一个group中而移动directory、或为了使directory靠近其访问者而移动directory。directory可以在客户端操作正在运行时移动。50MB的directory的移动期望在几秒内完成。

![图3 directory是Paxos group间数据移动的单位。](figure-3.png "图3 directory是Paxos group间数据移动的单位。")

一个Paxos group可能包含多个directory，这意味着Spanner的tablet与Bigtable的tablet不同：Spanner的tablet并非必须是行空间上按字典序连续的分区。Spanner的tablet是一个装有多个行空间的分区的容器。因为这样做可以一起定位多个经常被一起访问的directory，所以我们做了这样的决策。

*movedir*是用来在Paxos group间移动directory的后台任务<sup>[14]</sup>。movedir也被用作为Paxos group添加或移除副本<sup>[25]</sup>，因为Spanner目前不支持Paxos内的配置修改。movedir没被实现为单个事务，这样可以避免阻塞大量数据移动时进行的读写。取而代之的是，moveidr会在开始移动数据时注册该事件，并在后台移动数据。当它已经移动完几乎所有数据时，它会启动一个事务来原子性地移动剩余的少量数据，并更新两个Paxos group的元数据。

directory也是应用程序能够指定副本地理属性（geographic-replication property，或者简称”放置“，*placement*）的最小单位。我们的放置专用语言（placement-specification language）分离了管理副本配置的职责。管理员能控制两个维度：副本的数量和类型、和副本的地理上的放置。管理员会在这两个维度上创建由命名选项组成的菜单（例如，北美，5路副本与1个witness）。应用程序通过通过给每个数据库和（或）每个独立的directory打上一个由这些选项组合而成的标签来控制数据副本策略。例如，应用程序可能将每个终端用户的数据保存在各自的directory中，这让用户A的数据能在欧洲有3个副本，并让用户B的数据能在北美有5个副本。

为了让我们的描述简介，我们对其做了简化。事实上，如果directory增长得过大，Spanner会将其分片成多个*fragment（段）*。fragment可能由不同的Paxos group提供服务（即，由不同的服务器提供）。事实上，movedir在group之间移动的是fragment，而不是整个directory。

### 2.3 数据模型

Spanner为应用程序暴露了如下的一系列数据特性：数据模型基于模型化的（schematized）半关系型表、一种查询语言、和通用的事务。在设计时，让Spanner支持这些特性的原因有很多。支持模型化半关系型表和副本同步的需求源于Megastore的流行<sup>[5]</sup>。Google内部至少有300个应用程序使用Megastore（尽管其性能相对较低），因为它的数据模型管理起来比Bigtable的更简单，且它支持跨数据中心的副本同步。（Bigtable仅支持跨数据中心的副本最终一致性。）使用Megastore的比较出名的Google应用程序的例子有Gmail、Picase、Calendar、Android Market、AppEngine。类SQL查询语言的需求也很明确，其源于交互式数据分析工具Dremel<sup>[28]</sup>的流行。最后，Bigtable因缺少跨行事务而经常被抱怨，构建Percolator<sup>[32]</sup>的部分原因就是为了解决这一问题。一些作者声称支持通用的两段提交带来的性能或可用性问题导致的开销太过昂贵<sup>[9, 10, 19]</sup>。我们认为让应用程序开发者解决因过度使用事务而导致的性能瓶颈更好，而不是让开发者总是围绕缺少事务的问题编写代码。

应用程序数据模型在Spanner的实现提供的“directory-bucket”键值映射（directory-bucketed key-value mapping）的上层。应用程序会在universe中创建一个或多个*数据库（database）*。每个数据库可以容纳数量无限的模型化的*表（table）*。表看上去像关系型数据库的表，它有行、列、和版本号。我们不会深入Spanner的查询语言的细节。它看上去像支持以protocol-buffer为值的字段的SQL。

Spanner的数据模型不是纯关系型的，行必须有行名。更精确地说，每个表要求有一个由一个或多个主键列组成的有序集合。这一需求让Spanner看起来仍然像一个键值存储：主键构成了行名，每张表定义的是主键列到非主键列的映射。行仅当其键的某个值（即使是NULL）被定义时才存在。采用这种结构很有用，因为它让应用程序能够通过它们对键的选择来控制数据的局部性。

![图4 照片元数据的Spanner模型示例，其交错结构通过INTERLEAVE IN实现。](figure-4.png "图4 照片元数据的Spanner模型示例，其交错结构通过INTERLEAVE IN实现。")

**图4**中有一个照片元数据的Spanner模型的示例，每个用户的每个相册（album）都有有一条元数据。该模型语言与Megastore的类似，另外它还要求每个Spanner数据库必须通过客户端分区到一个或多个有层次结构的表。客户端程序通过`INTERLEAVE IN`在数据库模型中声明该结构层次。结构层次上层的表是directory table。directory table的每行的键为$K$，它与所有后继（descendant）表中按字典序以$K$开头的行一起构成一个directory。`ON DELETE CASCADE`表示删除directory table中的行时删除所有相关的子行。图中还阐释了样例数据库的交错结构（interleave）：例如，$Albums(2,1)$表示$Albums$表中$user\ id\ 2, album\ id\ 1$的行。这种通过表交错形成directory的方式十分重要，因为这让客户端可以描述多个表间存在的局部性的关系，这是高性能分布式分片数据库必须的。如果没有它，Spanner将无从得知最重要的局部性关系。

## 3. TrueTime

![表1 TrueTime API。参数t是TTstamp的类型。](table-1.png "表1 TrueTime API。参数t是TTstamp的类型。")

本章描述了TrueTime API并概述了其实现。我们将大部分的细节放在了另一篇论文中，本文的目标是证明这一API的能力。**表1**列出了API的方法。TrueTime显式地将时间表示为$TTinterval$，它是一个有时间不确定度界限的时间范围（不像标准的时间接口，标准时间接口不会给客户端不确定度的概念）。$TTinterval$的接入点（endpoint）是$TTstamp$类型。$TT.now()$方法返回一个$TTinterval$，该时间范围保证了包含$TT.now()$被调用的绝对时间。该时间类似于带有闰秒（leap-second）的UNIX时间。（译注：此处原文为“The time epoch is analogous to UNIX time with leap-second smearing.”）定义瞬时误差的界限为$\epsilon$，其为时间范围宽度的一半，定义平均错误界限为$\bar{\epsilon}$。$TT.after()$和$TT.before()$是对$TT.now()$的方便的封装。

函数$t_{abs}(e)$表示事件$e$的绝对时间。用更加正式的术语来说，TrueTime能够保证，对于一次调用$tt = TT.now()$来说，$tt.earliest \le t_{abs}(e_{now}) \le tt.latest$，其中$e_{now}$表示“调用”事件。

TrueTime在底层使用的参考时间为GPS和原子时钟。TrueTime使用了两种形式的参考时间，因为它们有不同的故障模式。GPS参考源的弱点有天线和接收器故障、本地无线电干扰、相关故障（例如，如闰秒处理不正确的设计故障、和欺骗等）、和GPS系统停机。原子时钟可能会以与GPS和彼此不相关的方式发生故障，且在长时间后会由于频繁错误而发生明显的漂移。

TrueTime通过每个数据中心的*time server*机器集合和每个机器的*timeslave daemon*的实现。大多数的master都有带专用天线的GPS接收器；这些master在物理上被划分开，以减少天线故障、无线电干扰、和欺骗的影响。其余的master（我们称其为*Armageddon master*）配备了原子时钟。原子时钟并没有那么贵：Armageddon master的成本与GPS master的成本在同一数量级。所有master的参考时间通常彼此不同。每个master还会通过它自己的本地时钟较差验证其参考时间提前的速率，如果二者有实质性的分期，则自己退出集合。在同步期间，Armageddom master会保守地给出从最坏的情况下的时钟漂移得出的缓慢增长的时间不确定性。GPS master会给出通常接近零的的不确定性。

每个daemon会轮询各种master<sup>[29]</sup>来减少任意一个master的错误的影响。一些是从就近的数据中心选取的GPS master，一些是从更远的数据中心的GPS master，对Armageddon master来说也是一样。daemon使用一种Marzullo算法的变体<sup>[27]</sup>来检测并拒绝说谎者，并与没说谎的机器同步本地的机器时钟。为了防止本地时钟故障，应该淘汰掉发生偏移频率大于从组件规格和操作环境得出的界限的机器。

在同步期间，daemon会给出缓慢增长的时间不确定性。$\epsilon$保守地从最坏的本地市中偏移得出。$\epilson$还依赖time master的不确定性和到time master的通信延迟。在我们的生产环境中，$\epsilon$通常是时间的锯齿波函数（sawtooth functon），每次轮询的间隔大概在1ms到7ms间。因此，大部分时间里$\bar{\epsilon}$为4ms。目前，daemon的轮询间隔为30秒，且当前的漂移速率被设置为200ms/s，二者一起组成了0到6ms的锯齿边界。剩下的1ms来自于到time master的通信延迟。在出现故障时，锯齿波可能会出现偏移。例如，偶尔的time master的不可用可能导致数据中心范围的$\epsilon$增加。同样，机器和网络连接过载可能导致$\epsilon$偶尔出现局部峰值。

## 4. 并发控制

本章描述了如何使用TrueTime确保并发控制相关的正确性属性与如何使用那些属性来实现如外部一致事务、无锁只读事务、和过去数据的非阻塞读取等特性。这些特性能实现例如确保整个数据库在时间戳$t$时刻的读取能够准确的看到截止$t$时刻的每个提交的事务的影响等功能。

此外，将Paxos可见的写入（我们称之为*Paxos write*，除非上下文明确提到）与Spanner客户端写入区分开非常重要。例如，两阶段提交会在就绪阶段（prepare phase）生成一个Paxos write，而没有相关的Spanner客户端写入。

### 4.1 时间戳管理

![表2 Spanner中的读写类型与对比。](table-2.png "表2 Spanner中的读写类型与对比。")

**表2**列出了Spanner支持的操作类型。Spanner的实现支持读写事务（read-write transaction）、只读事务（read-only transaction）（即预先声明了的快照隔离事务，(predeclared snapshot-isolation transactions））、和快照读取（snapshot read）。单独的写入作为读写事务实现；单独的非快照读作为只读事务实现。二者都在内部重试。（客户端不需要自己编写重试循环。）

只读事务是一种有快照隔离<sup>[6]</sup>的优势的事务。只读事务必须预先声明其没有任何写入，它并不只是没有任何写入操作的读写事务。只读事务中的读取会以系统选取的时间戳无锁执行，这样可以让到来写入不会被阻塞。只读事务中的读取操作可以在任何足够新的副本上执行（见[章节4.1.3](#413-在某时间戳处提供读取服务)）。

快照读取是无锁执行的对过去数据的读取操作。客户端可能为每个快照读取制定一个时间戳，也可能提供一个所需的时间戳的过期上限并让Spanner选取一个时间戳。在任一种情况下，快照读取都可以在任何足够新的副本上执行。

对于只读事务和快照读取来说，一旦时间戳被选取后，不可避免地需要提交，除非该时间戳的数据已经被垃圾回收掉了。因此，客户端可以避免在重试循环中缓冲结果。当一个服务器故障时，客户端可以在内部对另一台服务器重复该时间戳和当前读取的位置继续执行查询。

#### 4.1.1 Paxos leader租约

Spanner的Paxos实现使用了基于定时的租约来长期保持领导权（默认为10秒）。潜在的leader会发送请求以获得基于定时的*lease vote（租约投票）*，当leader收到一定数量的lease vote后，leader会得知它持有了租约。副本会在成功的写入操作中隐式地延长其lease vote，且leader会在lease vote快要过期时请求延长lease vote。定义leader的*lease interval（租约时间范围）* 的起始时间为leader发现了它收到了一定数量的lease vote的时间，结束时间为它不再有一定数量的lease vote的时间（因为一些lease vote过期了）。Spanner依赖如下的不相交的定理（invariant）：在每个Paxos group中，每个Paxos的leader的lease interval与所有其它的leader的lease interval不相交。附录A描述了该定理是如何成立的。

Spanner的实现允许Paxos leader通过让slave释放其lease vote的方式来退位（abdicate）。为了保持不相交性不变，Spanner对可以退位的时间进行了约束。定义$s_{max}$为leader使用的最大的时间戳。后面的章节会说明何时可以增大$s_{max}$的值。在退位前，leader必须等到$TT.after(s_{max})$为true。

#### 4.1.2 为读写事务分配时间戳

事务的读写使用两阶段锁。因此，可以在已经获取了所有锁之后与任何锁被释放之前的任意时间里为其分配时间戳。对一个给定的事务，Spanner为其分配的时间戳是Paxos为Paxos write分配的表示事务提交的时间戳。

Spanner依赖如下的单调定理：在每个Paxos group内，Spanner以单调增加的顺序为Paxos write分配时间戳，即使跨leader也是如此。单个leader副本可以单调递增地分配时间戳。通过使用不相交定理，可以在跨leader的情况下保证该定理：leader必须仅在它的leader租约的期限内分配时间戳。注意，每当时间戳$s$被分配时，$s_{max}$会增大到$s$，以保持不相交性。

Spanner还保证了如下的的外部一致性定理：如果事务$T_2$在事务$T_1$提交之后开始，那么$T_2$的提交时间戳一定比$T_1$的提交时间戳大。定义事务$T_i$的开始事件与提交事件分别为$e_i^{start}$和$e_i^{commit}$、事务$T_i$的提交时间戳为$s_i$。该定理可以使用$t_{abs}(e_1^{commit}) < t_{abs}(e_2^{start}) \implies s_1 < s_2$表示。这一用来执行事务与分配时间戳的协议遵循两条规则，二者共同保证了定理，如下所示。定义写入事务$T_i$的提交请求到达coordinator leader的事件为$e_i^{server}$。

**开始（Start）：** 写入事务$T_i$的coordinator leader在$e_i^{server}$会为其计算并分配值不小于$TT.now().latest$的时间戳$s_i$。注意，participant leader于此无关；[章节4.2.1](#421-)描述了participant如何参与下一条规则的实现。

**提交等待（Commit Wait）：** coordinator leader确保了客户端在$TT.after(s_i)$为true之前无法看到任何由$T_i$提交的数据。提交等待确保了$s_i$比$T_i$的提交的绝对时间小，或者说$s_i < t_{abs}(e_i^{commit})$。该提交等待的实现在[章节4.2.1](#421-读写事务)中描述。证明：

$$ s_1 < t_{abs}(e_1^{commit}) \tag{commit wait} $$
$$ t_{abs}(e_1^{commit}) < t_{abs}(e_2^{start}) \tag{assumption} $$
$$ t_{abs}(e_2^{start}) \le t_{abs}(e_2^{server}) \tag{causality} $$
$$ t_{abs}(e_2^{server}) \le s_2 \tag{start} $$
$$ s_1 < s_2 \tag{transitivity} $$

#### 4.1.3 在某时间戳处提供读取服务

[章节4.1.2](#412-为读写事务分配时间戳)中描述的单调性定理让Spanner能够正确地确定副本的状态对一个读取操作来说是否足够新。每个副本会追踪一个被称为*safe time（安全时间）* 的值$t_{safe}$，它是最新的副本中的最大时间戳。如果读操作的时间戳为$t$，那么当$t \le t_{safe}$时，副本可以满足该读操作。

定义$t_{safe} = \min(t_{safe}^{Paxos},t_{safe}^{TM})$，其中每个Paxos状态机有safe time $t_{safe}^{Paxos}$，每个transaction manager有safe time $t_{safe}^{TM}$。$t_{safe}^{Paxos}$简单一些：它是被应用的序号最高的Paxos write的时间戳。因为时间戳单调增加，且写入操作按顺序应用，对于Paxos来说，写入操作不会发生在$t_{safe}^{Paxos}$或更低的时间。

如果没有就绪（prepared）的（还没提交的）事务（即处于两阶段提交的两个阶段中间的事务），那么$t_{safe}^{TM}$为$\infty$。（对于participant slave，$t_{safe}^{TM}$实际上表示副本的leader的transaction manager的safe time，slave可以通过Paxos write中传递的元数据来推断其状态。）如果有任何的这样的事务存在，那么受这些事务影响的状态是不确定的：particaipant副本还不知道这样的事务是否将会提交。如我们在[章节4.2.1](#421-读写事务)中讨论的那样，提交协议确保了每个participant知道就绪事务的时间戳的下界。对group $g$来说，每个事务$T_i$的participant leader会给其就绪记录（prepare record）分配一个就绪时间戳（prepare timestamp）$s_{i,g}^{prepare}$。coordinator leader确保了在整个participant group $g$中，事务的提交时间戳$s_i \ge s_{i,g}^{prepare} $。因此，对于group $g$中的每个副本，对$g$中的所有事务$T_i$，$t_{safe}^{TM} = \min_i(s_{i,g^{prepare}})-1$。

#### 4.1.4 为只读事务分配时间戳

只读事务以两阶段执行：分配时间戳$s_{read}$<sup>[8]</sup>，然后在$s_{read}$处以快照读取的方式执行事务的读取。快照读取能够在任何足够新的副本上执行。

$s_{read}=TT.now()$在事务开始后的任意时间分配，它可以通过像[章节4.1.2](#412-为读写事务分配时间戳)中针对写入操作提供的参数的方式来保证外部一致性。然而，对这样的时间戳来说，如果$t_{safe}$还没有足够大，在$s_{read}$时对块的读取操作可能需要被阻塞。（另外，在选取$s_{read}$的值的时候，可能还需要增大$s_{max}$的值来保证不相交性。）为了减少阻塞的可能性，Spanner应该分配能保证外部一致性的最老的时间戳。[章节4.2.2](#422-只读事务)解释了如何选取这样的时间戳。

### 4.2 细节分析

本节解释了读写事务和只读事务中之前省略的一些使用的细节，以及用来实现原子性模型修改的特殊事务类型的实现。然后还描述了对之前描述的基本方案的一些改进

#### 4.2.1 读写事务

像Bigtable一样，事务中的写入操作在提交前会在客户端缓冲。这样，事务中的读取操作无法看到事务的写入操作的效果。在Spanner中，这也是很好的设计，因为读操作会返回任何读取的数据的时间戳，而未提交的写入操作还没有被分配时间戳。

读写事务中的读操作使用了伤停等待（wound-wait）<sup>[33]</sup>来避免死锁。客户端将读取提交给相应的group中的leader副本，它会获取读取锁并读取最新的数据。当事务保持打开（open）时，它会发送保活消息（keepalive message）以避免participant leader将其事务超时。当客户端完成了所有的读取并缓冲了所有的写入后，它会开始两阶段提交。客户端选取一个coordinator group并向每个participant的leader发送带有该coordinator的标识和和所有缓冲的写入的提交消息。让客户端驱动两阶段提交能够避免跨广域链路发送两次数据。

非coordinator participant的leader会先获取写入锁。然后它会选取一个必须大于任意它已经分配给之前的事务的就绪时间戳（以保证单调性），并通过Paxos将就绪记录写入日志。然后每个participant会通知coordinator其就绪时间戳。

coordinator leader同样会获取写入锁，但是跳过就绪阶段。它在收到其它所有的participant leader的消息后为整个事务选取一个时间戳。该提交时间戳$s$必须大于或等于所有的就绪时间戳（以满足[章节4.1.3](#413-在某时间戳处提供读取服务)中讨论的约束）、大于coordinator收到其提交消息的时间$TT.now().latest$、并大于任何该leader已经分配给之前事务的时间戳（同样为了保证单调性）。然后，coordinator leader会通过Paxos将提交记录写入日志（或者，如果在等待其它participant是超时，那么会打断它）。

在允许任何coordinator副本应用该提交记录之前，coordinator leader会等到$TT.after(s)$，以遵循[章节4.1.2](#412-为读写事务分配时间戳)中描述的提交等待规则。因为coordinator leader基于$TT.now().latest$选取$s$，且等待该时间戳变成过去时，所以期望等待时间至少为$2*\bar{\epsilon}$。这一等待时间通常会与Paxos通信重叠。在提交等待后，coordinator会将提交时间戳发送给客户端和所有其它的participant leader。每个participant leader会将事务的结果通过该Paxos记录。所有的participant会在相同的时间戳处应用事务，然后释放锁。

#### 4.2.2 只读事务

分配时间戳是在所有参与读取的的Paxos group间的协商阶段（negotiation phase）执行的。这样，对每个只读事务，Spanner都需要一个作用域（scope）表达式 ，该表达式总结了将将要被整个事务读取的键。Spanner自动地为单独的查询推导作用域。

如果作用域的值通过单个Paxos group提供服务，那么客户端会向该group的leader提出只读事务。（当前的Spanner只会在Paxos leader为一个只读事务选取一个时间戳。）该leader分配$s_{read}$并执行读取操作。对于单站点（single-site）的读取操作，Spanner通常能提供比$TT.now().latest$更好的支持。定义$LastTS()$为一个Paxos group最后一次已提交的写入的时间戳。如果该没有就绪的事务，则分配$s_{read}=LastTS()$就能满足外部一致性：事务将会看到最后一次写入的结果，也因此它发生在写入之后。

如果作用于的值由多个Paxos group提供服务，那么有很多种选择。最复杂的选择是与所有的group的leader做一轮通信来基于$LastTS()$协商$s_{read}$。目前，Spanner实现了一个更简单的一种选择。客户端避免了一轮通信，仅让它的读操作在$s_{read}=TT.now().latest$时执行（可能需要等到safe time增加）。事务中的所有读取能被发送到足够新的副本。

#### 4.2.3 模型修改事务

TrueTime让Spanner能够支持原子模型修改。使用标准的事务执行模型修改是不可性的，因为participant的数量（数据库中group的数量）可能有上百万个。Bigtable支持在一个数据中心中的原子性模型修改，但是其模型修改会阻塞所有操作。

Spanner的模型修改事务是更加通用的非阻塞标准事务的变体。第一，它会显式地分配一个未来的时间戳，该时间戳是在就绪阶段注册的。因此，跨数千台服务器的模型修改对其它并发活动的干扰最小。第二，读取和写入操作隐式依赖于模型，它们与所有注册时间为$t$的模型修改时间戳是同步的：如果它们在时间戳$t$之前，那么它们能继续执行；但是如果它们的时间戳在$t$之后，那么必须阻塞到模型修改事务之后。如果没有TrueTime，定义在时间$t$发生的模型修改是没有意义的。

#### 4.2.4 改进

之前定义的$t_{safe}^{TM}$有一个弱点，单个就绪的事务会阻止$t_{safe}$增长。这样，即使时间戳在后面的读取操作与事务不冲突，读取操作也不会发生。通过使用从键区间到就绪的事务的时间戳的细粒度的映射来增加$t_{safe}^{TM}$，可以避免这种假冲突。该信息可以保存在lock table中，该表中已经有键区间到锁元数据的映射了。当读取操作到达时，只需要检查与读操作冲突的键区间的细粒度的safe time。

之前定义的$LastTS()$也用类似的弱点：如果有事务刚被提交，无冲突的只读事务仍必须被分配时间戳$s_{read}$并在该事务之后执行。这样，读操作会被推迟。这一弱点可通过相似的手段解决，通过lock table中细粒度的从键区间到提交时间戳的映射来增强$LastTS()$。（目前我们还没有实现这一优化。）当只读事务到达时，可将与该事务冲突的键区间的最大$LastTS()$的值作为时间戳分配给该事务，除非存在与它冲突的就绪事务（可以通过细粒度的safe time确定）。

之前定义的$t_{safe}^{Paxos}$的弱点是，如果没有Paxos write，它将无法增大。也就是说，如果一个Paxos group的最后一次写入操作发生在$t$之前，那么该group中发生在时间$t$的快照读取无法执行。Spanner通过利用leader租约时间范围不相交定理解决了这一问题。每个Paxos leader会通过维持一个比将来会发生的写入的时间戳更大的阈值来增大$t_{safe}^{Paxos}$：Paxos leader维护了一个从Paxos序号$n$到可分配给Paxos序号为$n+1$的最小时间戳的映射$MinNextTS(n)$。当副本应用到$n$时，它可以将$t_{safe}^{Paxos}$增大到$MinNextTS(n)$。

单个leader实现其$MinNextTS()$约定很容易。因为$MinNextTS()$约定的时间戳在一个leader租约内，不相交定理能保证在leader间的$MinNextTS()$约定。如果leader希望将$MinNextTS()$增大到超过其leader租约之外，那么它必须先延长其leader租约。注意，$s_{max}$总是要增大到$MinNextTS()$中最大的值，以保证不相交定理。

leader默认每8秒增大一次$MinNextTS()$的值。因此，如果没有就绪事务，空闲的Paxos group中的健康的slave在最坏情况下会为读操作提供超过8秒后的时间戳。leader也会依照来自slave的需求增大$MinNextTS()$的值。

## 5. 评估

首先，我们测量了Spanner在副本、事务和可用性方面的性能。接着，我们提供了一些有关TrueTime的表现的数据，以及对我们的第一个使用者F1的案例研究。

### 5.1 小批量benchmark

**表3**展示了Spanner的一些小批量benchmark。这些测量是在分时机器上运行的：每个spanserver都在4GB RAM和4核（AMD Barcelona 2200MHz）的调度单元上运行。客户端运行在不同的机器上。每个zone中包含1个spanserver。client和zone被放置在网络距离小于1ms的一系列数据中心中。（这种布局是很常见的：大多数应用程序不需要将它们的数据分布到全球范围内。）测试数据库由50个Paxos group和2500个directory构成。操作有单独的读取操作和4KB写入操作。为所有的读操作提供服务即使在内存规整后也会用尽内存，因此我们仅测量了Spanner调用栈的开销。另外，我们首先进行了一轮没有测量性能的读操作来为本地缓存热身。

![表3 操作的小批量benchmark。10次运行的均值与标准差。1D表示1个副本禁用了提交等待。](table-3.png "表3 操作的小批量benchmark。10次运行的均值与标准差。1D表示1个副本禁用了提交等待。")

对于延迟实验，客户端会发出很少的操作，以避免在服务器上排队。从1路副本实验得出，提交等待打野为5ms，Paxos的延迟大约为9ms。随着副本数的增加，延迟大概恒定，且标准差更小，因为Paxos在一个group的副本汇总并行执行。随着副本数的增加，达到大多数投票（quorum）的延迟不再对单个较慢的slave副本敏感。

对于吞吐量实验，客户端会发出很多的操作，以使服务器的CPU饱和。快照读取可以在任何足够新的副本上执行，因此它们的吞吐量几乎随着副本数量线性增加。只有一次读取的只读事务仅在leader执行，因为时间戳分配必须在leader中发生。只读事务的吞吐量会随着本书增加而增加，因为有效的spanserver的数量增加了：在实验的配置中，spanserver的数量等于副本的数量，leader随机地分布在zone中。写入的吞吐量受益于相同的实验因素（这解释了副本数从3增长到5时的吞吐量增加），但是随着副本数的增加，每次写入执行的工作量线性增加，其开销超过了带来的好处。

![表4 两阶段提交的伸缩性。10次运行的均值与标准差。](table-4.png "表4 两阶段提交的伸缩性。10次运行的均值与标准差。")

**表4**展示了两阶段提交能够扩展到合理的参与者数量：其对跨3个zone运行的一系列实验进行了总结，每个实验有25个spanserver。在扩展到50个participant时，均值和99%比例的延迟都很合理，而扩展到100个participant时延迟开始显著增加。

### 5.2 可用性


**图5**阐释了在多个数据中心运行Spanner在可用性上的好处。其展示了出现数据中心故障时的三个实验的结果，所有的实验都在相同的时间范围内。该测试universe有5个zone $Z_i$组成，每个Zone有25个spanserver。测试数据库被分片到了1250个Paxos group中，100个测试客户端持续地以总速率50K次读取/秒发出非快照读取操作。所有的leader都被显式地放置在$Z_1$中。在每个实验的5秒后，一个zone内的所有服务器都被杀掉，具体情况如下：非leader杀掉$Z_2$；leader强行杀掉$Z_1$（hard kill）；leader杀掉$Z_1$（soft kill），但是它会通知所有的服务器应先移交领导权。

![图5 杀掉服务器对吞吐量的影响。](figure-5.png "图5 杀掉服务器对吞吐量的影响。")

杀掉$Z_2$对读取吞吐量没有影响。在杀掉$Z_1$时给leader时间来将领导权移交给另一个zone的影响最小：其吞吐量的减小在图中看不出，大概在3~4%。而另一方面，不进行警告就杀掉$Z_1$的影响最严重：完成率几乎降到了0.然而，随着leader被重新选举出，系统的吞吐量升高到了约100K读取/秒，其原因在于我们实验中的2个因素：系统还有余量、leader不可用时操作会排队。因此，系统的吞吐量会增加，然后再慢慢回到其稳定状态下的速率。

我们还能看出Paxos的leader租约被设置为10秒带来的影响。当我们杀掉zone的时候，leader租约的过期时间应在接下来的10秒中均匀分布。在每个死去的leader的租约过期不久后，新的leader会被选举出来。大概在杀掉的时间的10秒后，所有的group都有的leader，且吞吐量也恢复了。更短的租约时间会减少服务器死亡对可用性的影响，但是需要个更多的刷新租约使用的网络流量总量。我们正在设计并实现一种机制，让slave能在leader故障时释放Paxos leader租约。

### 5.3 TrueTime

关于TrueTime，必须回答两个问题：$\epsilon$真的是时钟不确定度的界限吗？$\epsilon$最坏是多少？对于前者，虽重要的问题是，本地时钟漂移是否会大约200us/sec：这回打破TrueTime的假设。根据我们对机器的统计，CPU的故障率是时钟故障率的6倍。也就是说，相对于更严重的硬件问题而言，时钟问题极少发生。因此，我们认为TrueTime的实现与Spanner依赖的所有软件一样值得信赖。

![图6 TrueTime的ε值的分布，在timeslave daemon查询time master后立即采样。图中分别绘制了第90%、99%、99.9%个数据的情况。](figure-6.png "图6 TrueTime的ε值的分布，在timeslave daemon查询time master后立即采样。图中分别绘制了第90%、99%、99.9%个数据的情况。")

**图6**给出了在距离高达2200km的数据中心间的几千台spanserver机器上获取的TrueTime数据。图中绘出了第90%、99%和99.9%个的$\epsilon$，其在timeslave daemon查询time master后立即采样。采样中去掉了$\epsilon$因本地时钟的不确定度而产生的锯齿波，因此其测量的是time master的不确定度（通常为0）加上到time master的通信延迟的值。

数据表明，通常来说，决定了$\epsilon$的这两个因素通常不是问题。然而，其中存在明显的尾延迟（tail-latency）问题，这会导致$\epsilon$的值更高。尾延迟在3月30日减少了，这时由于网络得到了改进，其减少了瞬时的网络链路拥堵。$\epsilon$在4月13日变大了约一个小时，这是由于一个数据中心例行维护中关闭了master两次。我们将继续调查并消除TrueTime峰值的原因。

### 5.4 F1

Spanner于2011年初开始在生产负载下进行实验评估，其作为F1（Google重写的广告系统后端系统）的一部分<sup>[35]</sup>。起初，该后端基于MySQL数据库，并手动将其按多种方式分片。其未压缩的数据集有数十TB，虽然这与许多NoSQL的实例相比很小，但是已经足够大以至于需要MySQL中的难用的分片机制。MySQL的分片策略会将每个消费者与所有相关数据分配到一个固定的分片中。这种布局让每个消费者可以使用索引与复杂的查询，但是这需要有对程序的业务逻辑的分片有所了解。随着消费者的数量与其数据量的增长，重新分片的开销对数据库来说十分昂贵。最后一次重分片花费了两年多的时间，涉及到数十个团队的协作与测试以降低其风险。这样的操作太过复杂而不能定期执行：因此，该团队不得不将一些数据存储在额外的Bigtable中以限制MySQL数据库的增长，这对影响了事务表现和跨所有数据的查询能力。

F1团队选择使用Spanner的原因有很多。第一，Spanner消除了手动重分片的需求。第二，Spanner提供了副本同步和自动化故障转移。在MySQL的master-slave的副本策略下，实现故障转移很困难，且有数据丢失的风险与停机时间。第三，F1需要强事务语义，这使得其无法使用其它的NoSQL系统。应用程序的语义需要跨任意数据上的事务和一致性读取。F1团队还需要在他们的数据上使用辅助索引（secondary index）（因为Spanner尚未为辅助索引提供自动支持），而他们可以使用Spanner的事务来实现他们自己的一致全局索引。

目前，所有应用程序的写入操作默认通过F1发送给Spanner，以取代基于MySQL的程序栈。F1在美国的西海岸有2份副本，在东海岸有3份副本。副本站点的选择基于潜在的重大自然灾害造成停电的可能性与它们的前端站点位置。有趣的是，Spanner的自动故障转移对它们来说几乎是不可见的。尽管最近几个月发生了计划外的集群故障，但是F1团队需要做的最大的工作是更新他们的数据库模型，以让Spanner知道在哪里优先放置Paxos leader，从而使其接近其前端移动后的位置。

Spanner的时间戳语义让F1可以高效地维护从数据库状态计算出的内存数据结构。F1维护了所有修改的逻辑历史纪录，其作为每个事务的一部分写入了Spanner本身。F1会获取某一时间戳上完整的数据快照以初始化它的数据结构，然后读取增量的修改并更新数据结构。

![表5 F1中directory-fragment的数量分布。](table-5.png "表5 F1中directory与fragment的数量分布。")

**表5**阐述了F1中每个directory中的fragment的数量的分布。每个directory通常对应于一个F1上的应用程序栈的消费者。绝大多数的directory（即对绝大多数消费者来说）仅包含一个fragment，这意味着对那些消费者数据的读写操作能保证仅发生在单个服务器上。包含100多个fragment的directory都是包含F1辅助索引的表：对于这种不止有几个fragment的表的写入是极为少见的。F1团队仅在他们以事务的方式处理未优化的批数据负载时见到过这种行为。

![表6 在24小时内测量的F1感知到的操作延迟。](table-6.png "表6 在24小时内测量的F1感知到的操作延迟。")

**表6**给出了从F1服务器测出的Spanner操作延迟。在东海岸的数据中心在选取Paxos leader方面有更高的优先级。表中的数据是从这些数据中心内的F1服务器测量的。写入延迟的标准差更大，这是由因锁冲突而导致的一个长尾操作导致的。读取延迟的标准差甚至更大，其部分原因是，Paxos leader分布在两个数据中心中，其中只有一个数据中心有装有SSD的机器。此外，我们还对两个数据中心中的系统的每个读取操作进行了测量：字节读取量的均值与标准差分别约为1.6KB和119KB。

## 6. 相关工作

Megastore<sup>[5]</sup>和DynamoDB<sup>[3]</sup>中提供了跨数据中新的一直副本服务。DynamoDB给出了键值接口，且副本仅在一个区域内。Spanner像Megastore一样提供了半结构化的数据模型和一个与其相似的模型语言。Megastore没有达到很高的性能。因为Megastore位于Bigtable之上，这增加了高昂的通信开销。Megastore还不支持长期leader：可能有多个副本启动写入操作。在Paxos协议中，来自不同副本的所有写入必将发生冲突，即使它们在逻辑上并不冲突，这会导致单个Paxos group上的每秒钟写入吞吐量下降。Spanner提供了更高的性能、通用的事务、和外部一致性。

Pavol等人<sup>[31]</sup>对比了数据库和MapReduce<sup>[12]</sup>的性能。他们指出，在分布式键值存储上探索数据库功能一些其它工作<sup>[1, 4, 7, 41]</sup>是这两个领域正在融合的证据。我们同意这一结论，但是我们证明了在多层上进行集成也有它特有的优势：例如，在多副本上集成并发控制减少了Spanner中提交等待的开销。

在多副本存储上的分层事务的概念至少可以追溯到Gifford的论文<sup>[16]</sup>。Scatter<sup>[17]</sup>是一个最近出现的基于DHT的键值存储，它在一致性副本上实现了分层事务。Spanner着眼于提供比Scatter更高层的接口。Gray和Lamport<sup>[18]</sup>描述了一直基于Paxos的非阻塞提交协议。与两阶段提交相比，他们的协议产生了更多的消息开销，这将增加分布更广的group的提交开销的总量。Walter<sup>[36]</sup>提供了一种快照隔离的变体，其适用于数据中心内，而不适用于跨数据中心的场景。相反，我们的只读事务提供了更自然的语义，因为我们的所有操作都支持外部一致性。

最近有大量关于减少或消除锁开销的工作。Calvin<sup>[40]</sup>去掉了并发控制：它预先分配时间戳并按时间戳的顺序执行事务。HStore<sup>[39]</sup>和Granola<sup>[11]</sup>都支持它们自己的事务类型，其中一些事务可以避免锁。这些系统都没有提供外部一致性。Spanner通过提供快照隔离的方式解决了争用问题。

VoltDB<sup>[42]</sup>是一个内存式分片数据库，其支持广域下的master-slave的多副本策略以支持容灾恢复，但是不支持更通用的副本配置。它是NewSQL的一个例子，支持可伸缩的SQL<sup>[38]</sup>是其亮点。大量的商业数据库（如MarkLogic<sup>[26]</sup>和Oracle的Total Recall<sup>[30]</sup>）都实现了对过去数据的读取。Lomet和Li<sup>[24]</sup>描述了一种用于这种时态数据库的实现策略。

对于可信参考时钟方面，Farsite得出了时钟不确定度的界限（比TrueTime的界限宽松很多）<sup>[13]</sup>：Farsite中的服务器租约与Spanner维护Paxos租约的方式相同。在之前的工作中<sup>[2, 23]</sup>，松散的时钟同步已经被用于并发控制。我们已经给出了使用TrueTime作为Paxos状态机间全局时间的原因之一。

## 7. 后续工作

在去年的大部分时间里，我们都在与F1团队合作，将Google的广告后端从MySQL迁移到Spanner。我们正在积极地提供监控与支持工具，并对其性能调优。另外，我们一直在改进我们的备份/还原系统的功能与性能。目前，我们正在实现Spanner的模型预言、辅助索引的自动化维护、和基于负载的自动化分片。对于更长期来说，我们计划去调研一些功能。乐观地并行读取可能是一个很有价值的策略，但是初步试验表示想要正确地实现它并非易事。此外，我们计划最终支持对Paxos配置的直接修改<sup>[22, 34]</sup>。

因为我们期望许多用应程序会将数据副本分布到彼此较近的数据中心中，TrueTime $\epsilon$可能会明显影响西能。我们认为，将$\epsilon$降低到1ms以内没有不可逾越的障碍。可以减小time master的查询间隔时间，并使用相对便宜的石英钟。可以通过改进网络技术的方式减小time master的查询延迟，或者，甚至可以通过其它分布式时钟技术来避免这一问题。

最后，还有很多明显需要改进的地方。尽管Spanner能扩展到大量节点上，节点内的本地数据结构在在执行复杂的SQL查询时性能相对较低，因为它们是为简单的键值访问设计的。数据库领域的文献中的算法与数据结构可以大幅改进单节点的性能。其次，能够自动化地在数据中心间移动数据以响应客户端中负载的变化长期以来一直是我们的目标之一，但是为了实现这一目标，我们还需要能够自动化、协作地在数据中心间移动客户端程序进程的能力。移动进程会让数据中心间的资源获取与分配的管理更加困难。

## 8. 结论

总而言之，Spanner结合并扩展了两个研究领域的观点：在更接近的数据库领域，需要易用的半结构化接口、事务、和基于SQL的查询语言；在系统领域，需要可伸缩、自动分片、容错、一致性副本、外部一致性、和广域分布。自从Spanner诞生以来，我们花了5年多的时间迭代设计与实现。这漫长的迭代部分原因是，人们很久才意识到Spanner应该做的不仅仅是解决全球化多副本命名空间的问题，还应该着眼于Bigtable锁缺少的数据库特性。

我们的设计中的一方面十分重要：Spanner的特性的关键是TrueTime。我们证明了，通过消除时间API中的始终不确定度，=能够构建时间语义更强的分布式系统。此外，因为底层系统对时钟不确定度做了更严格的限制，所以实现更强的语义的开销减少了。在这一领域中，在设计分布式算法时，我们应该不再依赖宽松的时钟同步和较弱的时间API。

## 致谢

Many people have helped to improve this paper: our shepherd Jon Howell, who went above and beyond his responsibilities; the anonymous referees; and many Googlers: Atul Adya, Fay Chang, Frank Dabek, Sean Dorward, Bob Gruber, David Held, Nick Kline, Alex Thomson, and Joel Wein. Our management has been very supportive of both our work and of publishing this paper: Aristotle Balogh, Bill Coughran, Urs Holzle, Doron Meyer, Cos Nicolaou, Kathy Polizzi, Sridhar Ramaswany, and Shivakumar Venkataraman.

We have built upon the work of the Bigtable and Megastore teams. The F1 team, and Jeff Shute in particular, worked closely with us in developing our data model and helped immensely in tracking down performance and correctness bugs. The Platforms team, and Luiz Barroso and Bob Felderman in particular, helped to make TrueTime happen. Finally, a lot of Googlers used to be on our team: Ken Ashcraft, Paul Cychosz, Krzysztof Ostrowski, Amir Voskoboynik, Matthew Weaver, Theo Vassilakis, and Eric Veach; or have joined our team recently: Nathan Bales, Adam Beberg, Vadim Borisov, Ken Chen, Brian Cooper, Cian Cullinan, Robert-Jan Huijsman, Milind Joshi, Andrey Khorlin, Dawid Kuroczko, Laramie Leavitt, Eric Li, Mike Mammarella, Sunil Mushran, Simon Nielsen, Ovidiu Platon, Ananth Shrinivas, Vadim Suvorov, and Marcel van der Holst.

## 参考文献

<div class="reference">

[1] Azza Abouzeid et al. “HadoopDB: an architectural hybrid of MapReduce and DBMS technologies for analytical workloads”. Proc. of VLDB. 2009, pp. 922–933.

[2] A. Adya et al. “Efficient optimistic concurrency control using loosely synchronized clocks”. Proc. of SIGMOD. 1995, pp. 23–34.

[3] Amazon. Amazon DynamoDB. 2012.

[4] Michael Armbrust et al. “PIQL: Success-Tolerant Query Processing in the Cloud”. Proc. of VLDB. 2011, pp. 181–192.

[5] Jason Baker et al. “Megastore: Providing Scalable, Highly Available Storage for Interactive Services”. Proc. of CIDR. 2011, pp. 223–234.

[6] Hal Berenson et al. “A critique of ANSI SQL isolation levels”. Proc. of SIGMOD. 1995, pp. 1–10.

[7] Matthias Brantner et al. “Building a database on S3”. Proc. of SIGMOD. 2008, pp. 251–264.

[8] A. Chan and R. Gray. “Implementing Distributed Read-Only Transactions”. IEEE TOSE SE-11.2 (Feb. 1985), pp. 205–212.

[9] Fay Chang et al. “Bigtable: A Distributed Storage System for Structured Data”. ACM TOCS 26.2 (June 2008), 4:1–4:26.

[10] Brian F. Cooper et al. “PNUTS: Yahoo!’s hosted data serving platform”. Proc. of VLDB. 2008, pp. 1277–1288.

[11] James Cowling and Barbara Liskov. “Granola: Low-Overhead Distributed Transaction Coordination”. Proc. of USENIX ATC. 2012, pp. 223–236.

[12] Jeffrey Dean and Sanjay Ghemawat. “MapReduce: a flexible data processing tool”. CACM 53.1 (Jan. 2010), pp. 72–77.

[13] John Douceur and Jon Howell. Scalable Byzantine-FaultQuantifying Clock Synchronization. Tech. rep. MSR-TR-2003- 67. MS Research, 2003.

[14] John R. Douceur and Jon Howell. “Distributed directory service in the Farsite file system”. Proc. of OSDI. 2006, pp. 321–334.

[15] Sanjay Ghemawat, Howard Gobioff, and Shun-Tak Leung. “The Google file system”. Proc. of SOSP. Dec. 2003, pp. 29–43.

[16] David K. Gifford. Information Storage in a Decentralized Computer System. Tech. rep. CSL-81-8. PhD dissertation. Xerox PARC, July 1982.

[17] Lisa Glendenning et al. “Scalable consistency in Scatter”. Proc. of SOSP. 2011.

[18] Jim Gray and Leslie Lamport. “Consensus on transaction commit”. ACM TODS 31.1 (Mar. 2006), pp. 133–160.

[19] Pat Helland. “Life beyond Distributed Transactions: an Apostate’s Opinion”. Proc. of CIDR. 2007, pp. 132–141.

[20] Maurice P. Herlihy and Jeannette M. Wing. “Linearizability: a correctness condition for concurrent objects”. ACM TOPLAS 12.3 (July 1990), pp. 463–492.

[21] Leslie Lamport. “The part-time parliament”. ACM TOCS 16.2 (May 1998), pp. 133–169.

[22] Leslie Lamport, Dahlia Malkhi, and Lidong Zhou. “Reconfiguring a state machine”. SIGACT News 41.1 (Mar. 2010), pp. 63–73.

[23] Barbara Liskov. “Practical uses of synchronized clocks in distributed systems”. Distrib. Comput. 6.4 (July 1993), pp. 211–219.

[24] David B. Lomet and Feifei Li. “Improving Transaction-Time DBMS Performance and Functionality”. Proc. of ICDE (2009), pp. 581–591.

[25] Jacob R. Lorch et al. “The SMART way to migrate replicated stateful services”. Proc. of EuroSys. 2006, pp. 103–115.

[26] MarkLogic. MarkLogic 5 Product Documentation. 2012.

[27] Keith Marzullo and Susan Owicki. “Maintaining the time in a distributed system”. Proc. of PODC. 1983, pp. 295–305.

[28] Sergey Melnik et al. “Dremel: Interactive Analysis of WebScale Datasets”. Proc. of VLDB. 2010, pp. 330–339.

[29] D.L. Mills. Time synchronization in DCNET hosts. Internet Project Report IEN–173. COMSAT Laboratories, Feb. 1981.

[30] Oracle. Oracle Total Recall. 2012.

[31] Andrew Pavlo et al. “A comparison of approaches to large-scale data analysis”. Proc. of SIGMOD. 2009, pp. 165–178.

[32] Daniel Peng and Frank Dabek. “Large-scale incremental processing using distributed transactions and notifications”. Proc. of OSDI. 2010, pp. 1–15.

[33] Daniel J. Rosenkrantz, Richard E. Stearns, and Philip M. Lewis II. “System level concurrency control for distributed database systems”. ACM TODS 3.2 (June 1978), pp. 178–198.

[34] Alexander Shraer et al. “Dynamic Reconfiguration of Primary/Backup Clusters”. Proc. of USENIX ATC. 2012, pp. 425–438.

[35] Jeff Shute et al. “F1 — The Fault-Tolerant Distributed RDBMS Supporting Google’s Ad Business”. Proc. of SIGMOD. May 2012, pp. 777–778.

[36] Yair Sovran et al. “Transactional storage for geo-replicated systems”. Proc. of SOSP. 2011, pp. 385–400.

[37] Michael Stonebraker. Why Enterprises Are Uninterested in NoSQL. 2010.

[38] Michael Stonebraker. Six SQL Urban Myths. 2010.

[39] Michael Stonebraker et al. “The end of an architectural era: (it’s time for a complete rewrite)”. Proc. of VLDB. 2007, pp. 1150–1160.

[40] Alexander Thomson et al. “Calvin: Fast Distributed Transactions for Partitioned Database Systems”. Proc. of SIGMOD. 2012, pp. 1–12.

[41] Ashish Thusoo et al. “Hive — A Petabyte Scale Data Warehouse Using Hadoop”. Proc. of ICDE. 2010, pp. 996–1005.

[42] VoltDB. VoltDB Resources. 2012.

</div>

## 附录A Paxos leader租约管理

确保Paxos leader租约时间范围不相交的最简单的方法是，无论何时延长租约，都让leader提交一次同步的Paxos write。之后的leader会读取该时间范围并等到该范围过去。

使用TrueTime可以在不需要额外日志写入的情况下确保不相交性。潜在的第$i$个leader在有$r$个副本的情况下，会在lease vote的开始时设置下界$v_{i,r}^{leader}=TT.now().earliest$，其是在$e_{i,r}^{send}$（leader发出租约请求的时间）之前计算的。每个副本$r$在当前租约的$e_{i,r}^{grant}$时授权新租约，其发生在$e_{i,r}^{receive}$（副本收到租约请求的时间）之后；租约在$t_{i,r}^{end}=TT.now().latest_10$时结束，其是在$e_{i,r}^{receive}$之后计算的。副本$r$遵循**一次投票（single-vote）**规则：在$TT.after(t_{i,r}^{end})$为true之前，它不会再次授权lease vote。为了在不同的$r$之间保证这一规则，在授权租约之前，Spanner会在给出授权的副本中记录lease vote；这次日志写入可通过已有的Paxos协议日志写入一并完成。

当第$i$个leader收到一定数量的lease vote时（$e_i^{quorum}$事件），它会计算它的租约时间范围$lease_i=[TT.now().latest, \min_r(v_{i,r}^{leader})+10]$。当$TT.before(\min_r(v_{i,r}^{leader})+10)$为false，那么该leader会认为该租约过期。为了证明不相交性，我们使用了如下事实：第$i$个和第$(i+1)$个leader必须在它们的“大多数（quorum）”有一个副本的共用的。我们称该副本为$r_0$。证明：

$$ lease_i.end=\min_r(v_{i,r}^{leader}) \tag{by definition} $$
$$ min_r(v_{i,r}^{leader})+10 \le \min_r(v_{i,r}^{leader})+10 \tag{min} $$
$$ v_{i,r_0}^{leader}+10 \le t_{abs}(e_{i,r_0}^{send})+10 \tag{by definition} $$
$$ t_{abs}(e_{i,r_0}^{send})+10 \le t_{abs}(e_{i,r_0}^{receive})+10 \tag{causality} $$
$$ t_{abs}(e_{i,r_0}^{receive})+10 \le t_{i,r_0}^{end} \tag{by definition} $$
$$ t_{i,r_0}^{end} < t_{abs}(e_{i+1,r_0}^{grant}) \tag{single-vote} $$
$$ t_{abs}(e_{i+1,r_0}^{grant}) \le t_{abs}(e_{i+1}^{quorum}) \tag{causality} $$
$$ t_{abs}(e_{i+1}^{quorum}) \le lease_{i+1}.start \tag{by definition} $$