---
title: "《MapReduce: Simplified Data Processing on Large Clusters》论文翻译（MapReduce-OSDI04）"
date: 2020-08-08T12:21:45+08:00
lastmod: 2020-08-14T17:08:45+08:00
draft: false
keywords: []
description: ""
tags: ["MapReduce", "Translation"]
categories: ["Paper Reading"]
author: ""
featuredImage: img/paper-reading.jpg
---

*本篇文章是对论文[MapReduce-OSDI04](https://static.googleusercontent.com/media/research.google.com/zh-CN//archive/mapreduce-osdi04.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<!--more-->

## 作者

Jeffrey Dean and Sanjay Ghemawat

jeff@google.com, sanjay@google.com

Google, Inc

## 摘要

MapReduce是一个用来处理和生成大型数据集的编程模型和相关实现。用户需要指定*map*函数和*reduce*函数。*map*函数处理键值对并生成一组由键值对组成的中间值，*reduce*函数将所有键相同的中间值合并。就像本文中展示的那样，现实世界中的很多任务都可以通过这个模型表示。

以这种函数式风格编写的程序可以自动地作为并行程序在大型商用机集群上执行，运行时（run-time）系统负责对输入数据分区、在一系列机器间调度程序执行、处理机器故障、管理必要的机器间的通信。这让没有任何并行程序和分布式系统开发经验的编程人员能够轻松利用一个大型分布式系统的资源。

我们的MapReduce实现是高度可伸缩的，其运行在一个由商用机器组成的大型分布式集群上。通常，一个MapReduce计算会处理上千台机器上数TB的数据。每天都有数百个MapReduce程序提交的高达上千个MapReduce任务在Google集群上执行。开发人员认为这个系统非常易用。

## 1. 引言

在过去的五年中，本文作者和其他在Google的开发者实现了数以百计的计算程序，以计算处理不同来源的大规模原始数据（如爬取到的文档、web请求日志等）。这些程序可能用来计算倒排索引（inverted index）、web文档在图论中的各种表示、每个主机爬取到的页面数量之和、给定的某天中查询最频繁的集合等等。虽然大部分的计算程序逻辑非常简单，但是由于其输入数据的规模通常很大，所以这些程序必须在成百上千台机器上分布式执行以在可可接受的时间内完成。解决并行计算、数据分布、故障处理等问题需要大量复杂的代码，让原本简单的问题不再简单。

为了应对这种复杂性，我们设计了一个新的程序抽象。其允许我们通过简单的描述表达我们要执行的计算，同时将并行化、容错、数据分布、负载均衡等细节隐藏在库中。我们的抽象收到了Lisp和许多其他函数式语言中的*map*和*reduce*原语的启发。我们意识到，我们大部分的计算都设计*map*操作和*reduce*操作。首先对输入数据中每条逻辑记录应用*map*操作以计算出一系列的中间键值对，然后对所有键相同的值应用*reduce*操作以合理地整合这些派生数据。用户可以自定义*map*和*reduce*操作，这让大型计算的并行化更为简单，且可以使用“重跑（re-execution）”的方法作为主要容错机制。

本工作的主要贡献为一个简单且功能强大的能实现自动并行化、高伸缩性分布式计算的的接口，和该接口在大型商用PC集群上的高性能的实现。

[第二章](#编程模型)描述了基本编程模型，并给出了几个例子。[第三章](#3-实现)描述了为我们基于集群的计算环境定制的MapReduce接口实现。[第四章](#4-改进)描述了该编程模型中我们认为有帮助的细节。[第五章](#5-性能)我们的实现在各种任务重的性能测试。[第六章](#6-研发经历)探究了MapReduce在Google中的使用，其中包括了我们以MapReduce为基础重写我们产品索引系统的经历。[第七章](#7-相关工作)探讨了相关工作与未来的工作。

## 2. 编程模型

计算任务以一系列*输入键值对*作为输入，并产出一系列*输出键值对*作为输出。MapReduce库的用户将计算表示为两个函数：*map*和*reduce*。

用户编写的*map*函数将*输入键值对*处理为一系列*中间键值对*。MapReduce库将键相同的所有*中间键值对*的值与其对应的键$I$传递给*reduce*函数。

用户编写的*reduce*函数接收*中间键值对*的键$I$和该键对应的一系列值。它将这些值合并，并生产一个可能更小的一系列值。每个*reduce*函数调用通常产出0个或1个输出值。*中间键值对*中的值通过一个迭代器（iterator）供用户编写的*reduce*函数使用。这让我们能够处理因过大而无法放入内存中的值列表。

### 2.1 示例

考虑如下一个问题：统计一个大量文档集合中每个单词出现的次数。用户会编写如下的伪代码。

```
map(String key, String value):
  // key: document name
  // value: document contents
  for each word w in value:
    EmitIntermediate(w, "1");

reduce(String key, Iterator values):
  // key: a word
  // values: a list of counts
  int result = 0;
  for each v in values:
    result += ParseInt(v);
  Emit(AsString(result));
```

*map*计算出每个单词与其（译注：在每个文档中的）出现的次数（在本例中为“1”）。*reduce*函数会求出每个单词出现次数的和。

另外，用户编写代码来一个*mapreduce specification（规格/规范）*对象，填写输入输出文件名和可选的调节参数。随后，用户调用MapReduce函数，将*mapreduce specification*对象作为参数传入。用户代码会被与MapReduce库（C++实现）链接到一起。[附录A](#附录a-词频统计)包含本示例的完整程序。

### 2.2 类型

尽管前面的伪代码中使用了字符串作为输入输出类型，但理论上用户提供的*map*和*reduce*函数可以使用相关联的类型：

```
map     (k1,v1)        ->  list(k2,v2)
reduce  (k2,list(v2))  ->  list(v2)
```

即输入的键和值与输出的键和值的类型域不同，而中间键与值和输出键域值的类型与相同。

在我们的C++实现中，我们通过字符串将接受或传入用户定义的函数的参数，将字符串与适当类型的转换留给用户代码去实现。

### 2.3 更多示例

本节中，我们给出了一些简单的示例。这些示例是可以简单地通过MapReduce计算表示的有趣的程序。

- 分布式“grep”：如果一行文本匹配给定的模板，那么*map*函数会输出该行。*reduce*作为一个恒等函数，它仅将提供的中间数据复制到输出。

- URL访问频率计数：*map*函数处理web网页请求日志，并按照$<URL,1>$输出。*reduce*函数对$URL$相同的值求和，并输出$<URL,总数>$键值对。

- 反转web链接拓扑图：*map*函数对名为$source$的页面中每个名为$target$的URL链接输出一个$<target,source>$键值对。*reduce*函数按照所有$target$相同的$source$合并为一个列表，并与其相应的URL关联，输出$<target,list(source)>$键值对。

- 每个主机的词向量统计：词向量是对是对一个或一系列文档中最重要的词的总结，其形式为$<词,词频>$键值对列表。*map*函数为每篇输入文档输出一个$<主机名,词向量>$键值对（其中$主机名$由文档到的URL解析而来）。*reduce*函数会受到对于给定的主机上每篇文章的所有的词向量。其将这些词向量加在一起，丢弃掉低频词，并最终输出$<主机名,词向量>$键值对。

- 倒排索引：*map*函数对每篇文档进行提取，输出一个$<词,文档ID>$的序列。*reduce*函数接受给定词的所有键值对，并按照$文档ID$排序。输出一个$<词,list(文档ID)>$键值对。所有输出的键值对的集合组成了一个简单的倒排索引。如果需要持续跟踪词的位置，仅需简单的增量计算。

- 分布式排序：*map*提取每条记录中的键，输出一个$<键,记录>$的键值对。*reduce*函数不对中间变量作修改直接输出所有的键值对。排序计算依赖[章节4.1](#分区函数)中介绍的分区机制和[章节4.2](#42-有序性保证)介绍的排序属性。

## 3. 实现

MapReduce接口可能有很多不同的实现。如何作出正确的选择取决于环境。例如，一种实现可能适合小型的共享内存的机器，一种实现可能适合大型NUMA多处理器主机，或者一种实现可能适合更大型的通过网络连接的机器集群。

本节中，我们将介绍一个中面向Google中常用的计算环境的实现。Google的常用计算环境为彼此通过交换机以太网<sup>\[4\]</sup>连接的大型商用PC集群。在我们的环境中：

1. 机器通常使用双核x86处理器，2-4GB内存，运行Linux系统。

2. 使用商用网络硬件：每台机器带宽通常为100Mbps或1Gbps，但平均分到的带宽要小得多。（译注：可能受交换机间带宽限制，每台机器平均分到的带宽远小于其单机带宽。）

3. 一个集群由成百上千的机器组成，因此机器故障是常态。

4. 存储由直接连接到独立的机器上IDE（译注：本文IDE指集成设备电路Intergated Drive Electronics）磁盘提供。我们为了管理这些磁盘上的数据，开发了一个内部的分布式文件系统<sup>\[8\]</sup>。该文件系统使用副本的方式在不可靠的硬件上提供了可用性和可靠性。

5. 用户将工作（job）提交到一个调度系统中。每个工作由一系列的任务（task）组成，这些任务被*scheduler（调度器）*映射到集群中一系列可用的机器上。

### 3.1 执行概览

输入数据会自动被分割为$M$个分片（split），这样，*map*函数调用可以在多个机器上分布式执行，每个输入的分片可以在不同机器上并行处理。*中间键值对*的键空间会通过被分区函数(例如，$hash(key) mod R$)分割为$R$个分区，这样，*reduce*函数也可以分布式执行。其中分区的数量（$R$）和分区函数由用户指定。

![图1 执行概览](figure-1.png "图1 执行概览")

**图1**展示了在我们的实现中，MapReduce操作的完整工作流。当用户程序调用MapReduce函数时会发生如下的操作（下列序号与图1中序号对应）：

1. 用户程序中的MapReduce库首先将输入文件划分为$M$个分片，通常每个分片为16MB到64MB（用户可通过可选参数控制）。随后，库会在集群中的机器上启动程序的一些副本。

2. 这些程序的副本中，有一份很特殊，它是master副本。其他的副本是被master分配了任务的worker副本。总计要分配$M$个*map*任务和$R$个*reduce*任务。master选取闲置的worker并为每个选取的worker分配*map*或*reduce*任务。

3. 被分配*map*任务的worker从输入数据分片中读取内容。其解析输入数据中的键值对，并将每个键值对传给用户定义的*map*函数。*map*函数输出的*中间键值对*在内存中缓存。

4. 内存中缓存的键值对会定期地写入本地磁盘，写入的数据会被分区函数划分为$R$个区域。这些在磁盘中缓存的键值对的位置会被发送给master，master会将这些位置信息进一步传递给*reduce* worker。

5. 当master通知*reduce* worker*中间键值对*的位置信息后，*reduce* worker会通过远程过程调用（译注：即RPC。）的方式从*map* worker的本地磁盘中读取缓存的数据。当*reduce* worker读取完所有中间数据后，它会对中间数据按照键进行排序，以便将所有键相同的键值对分为一组。因为通常来说，需对键不同的数据会被映射到同一个*reduce*任务中，所以需要对数据排序。如果中间数据总量过大以至于无法放入内存中，则会使用外排序算法（external sort）。

6. *reduce* worker遍历每一个遇到的*中间键值对*的，它会将键和该键对应的一系列值传递给用户定义的*reduce*函数。*reduce*函数的输出会被追加（append）到该*reduce*分区的最终输出文件中。

7. 当所有的*map*和*reduce*任务都执行完毕后，master会唤醒用户程序。此时，调用MapReduce的调应用序会返回到用户代码中。

在成功执行完毕后，MapReduce的输出可在通过$R$个输出文件访问（每个*reduce*任务一个文件，文件名由用户指定）。通常情况下，用户不需要将这$R$个输出文件合并到一个文件中，用户经常将这些文件作为另一次MapReduce调用的输入，或者在另一个能够从多个分区的文件输入的分布式程序中使用这些文件。

### 3.2 master数据结构

master中保存着多种数据类型。对每个*map*和*reduce*任务，master会存储其状态（状态包括等待中（idle）、执行中（in-progress）和完成（conpleted））和非等待中的任务对应的worker的标识符。

master是将中间文件区域的位置从*map*任务传递到*reduce*任务的管道。因此，对于每个已完成的*map*任务，master会存储其输出的$R$个中间文件区域的位置。当*map*任务完成后，master会收到其对中间文件区域位置和大小信息的更新。这些信息会被增量地推送到有执行中的*reduce*任务的worker中。

### 3.3 容错

因为MapReduce库是为使用成百上千台机器处理大规模数据提供帮助而设计的，所以必须能够优雅地对机器故障进行容错。

#### 3.3.1 worker故障

master会定期ping每个worker。如果在一定时间内没有收到worker的响应，master会将该worker标记为故障。被故障的worker处理的已完成的*map*任务会被重设为其初始的“等待中”的状态，因此其符合被调度到其他worker的条件。同样，在故障的worker上任何执行中的*map*或*reduce*任务也会被重设为“等待中”的状态，符合重新调度的条件。

当worker故障发生时，该worker完成的*map*任务也需要被重新执行，因为*map*任务的输出被存储在故障的机器的本地磁盘上，无法被访问。故障worker完成的*reduce*任务则不需要被重新执行，因为他们的输出被存储在全局的文件系统中

当一个起初被worker A执行的*map*任务因A发生故障而随后被worker B执行时，所有正在执行*reduce*任务的worker会被告知这个*map*任务被重新执行。任何没从worker A中读取完数据的*reduce*任务将会从worker B中读取数据。

MapReduce可以弹性处理大规模worker故障。例如，在MapReduce操作中，由于在正在运行的集群中的网络维护工作导致了80台机器在几分钟内同时变得不可访问。MapReduce的master会简单地重新执行不可访问的worker的机器上已完成的工作，并继续执行后续任务，最终完成整个MapReduce操作。

#### 3.3.2 master故障

我们让master简单地周期性地为之前提到的master中的数据结构设置检查点。如果master *任务*挂掉，一份新的master的拷贝会从最后一次检查点的状态重启。尽管只有一个master，发生故障的可能性也很小。因此，目前我们的实现方式为：如果master故障，则终止MapReduce计算。client可以检测到该状态，如果有需要可以重试MapReduce操作。

#### 3.3.3 故障出现时的语义

对于相同的输入数据，当用户提供的*map*和*reduce*操作是确定性函数时（译注：确定性函数指在任何时候，当函数输入相同时，总会得到相同的输出。），分布式的MapReduce输出的数据和一个没发生故障的顺序执行的程序输出的数据是一样的。

我们通过原子性地提交*map*任务和*reduce*任务输出的方式来实现这一性质。每个执行中的*任务*将其输出写入到私有的临时文件中。每个*reduce*任务会创建一个这样的临时文件，每个*map*任务会创建$R$个这样的临时文件（每有一个*reduce*任务就创建一个）。当有一个*map*任务完成时，该worker会向master发送一条带有$R$个临时文件名的消息。如果master收到了一个已经完成过的*map*任务的完成消息，master会忽略该消息。否则，master会在其数据结构中记录这$R$个文件的文件名。

当有一个*reduce*任务完成时，该worker会自动地将其临时输出文件重命名为一个永久的文件名。如果同一个*reduce*任务被在多台机器中执行，会出现多个重命名调用将文件重命名同一个永久文件名的情况。我们依赖下层文件系统提供了原子性重命名操作，来保证最终的文件系统中仅包含来自一次*reduce*任务输出的数据。

我们绝大多数*map*和*reduce*操作是确定性的。因此，分布式的MapReduce语义等同于顺序执行的语义。这使得编程人员可以很容易地理解程序行为。当*map*和（或）*reduce*为非确定性函数时，我们提供了较弱但仍合理的语义。当非确定性的操作出现时，一次特定的*reduce*任务的输出$R_{1}$等同于这个非确定性操作顺序执行的输出$R_{1}$。但是，不同次*reduce*任务的输出$R_{2}$可能对应这个非确定性操作顺序不同次执行的输出$R_{2}$。

考虑这样一种情况，有*map*任务$M$和*reduce*任务$R_{1}$和$R_{2}$。$e(R_{i})$表示被提交的任务$R_{i}$的执行过程（有且仅有一个该执行过程）。因为$e(R_{1})$与$e(R_{2})$可能读取了任务$M$的不同次执行后的输出文件，因此会出现较弱的语义。（译注：即如果$M$因故障等原因被多次执行，因为$M$多次执行的输出不一致，所以$R_{1}$和$R_{2}$读取的输入可能不一致。）

### 3.4 位置分配

在我们的计算环境中，网络带宽是相对稀缺的资源。为了节约网络带宽，我们将输入数据（由GFS管理<sup>\[8\]</sup>）存储在集群中机器的本地磁盘中。GFS将每个文件分割为若干个64MB的块，并为每个块存储在不同机器上若干个副本（通常为3个）。MapReduce的master会考虑输入文件的位置信息，并试图在持有输入文件的副本的机器上分配相应的*map*任务。如果分配失败，master会试图将*map*任务分配在离其输入文件的副本较近的机器上（例如，在与持有输入数据副本的机器在相同交换机下的机器上分配）。在集群中较大比例的机器上运行大型MapReduce操作时，大部分输入数据都是从本地读取，不消耗网络带宽。

### 3.5 任务粒度

如前文所述，我们将*map*阶段进一步划分为$M$份，将*reduce*阶段进一步划分为$R$份。在理想状态下，$M$和$R$应远大于worker的机器数。让每个worker执行多个不同的*任务*可以提高动态负载均衡能力，也可以在一个worker故障时提高恢复速度：该worker完成的多个*map*任务可以被分散到所有其他的worker机器上执行（译注：否则，考虑$M$小于worker机器数的情况，每个worker上只有一个任务，如果一个worker故障，那么该worker中完成的任务只能在另一台worker机器上重跑，无法充分利用并行的性能）。

在我们的MapReduce实现的实际情况中，对$M$和$R$的上限进行了限制。如前文所述，master必须做出$O(M+R)$个调度决策，并在内存中保存$O(M \times R)$个状态。（内存占用的常数因子比较小：$O(M \times R)$条状态由大约每个*map*/*reduce*任务仅一字节的数据组成。）

此外，$R$还经常受用户限制，因为每个*reduce*任务会生成一个单独的输出文件。在实际情况下，我们更倾向于自定义参数$M$，这样可以使每个单独的*任务*的输入数据大概在16MB到64MB（这样可以使前面提到的局部性优化最有效），同时，我们使$R$是期望使用的worker机器的较小的倍数。我们经常在$2,000$台机器上选择$M=200,000$、$R=5,000$的参数执行MapReduce计算。

### 3.6 任务副本

延长MapReduce操作总时间的常见原因之一为“离群问题”：一个机器花费了不寻常的长时间完成计算中最后的几个*map*任务或*reduce*任务。吃线离群问题的原因有很多。例如，一台磁盘情况不良的机器可能频繁修正磁盘错误，导致其读取速度从$30MB/s$降低到$1MB/s$。集群的调度系统可能已经将其他任务调度到了该机器上，导致其因CPU、内存、本地磁盘或网络带宽等因素执行MapReduce代码更慢。我们最近遇到的问题是在机器初始化代码中的一个bug，其导致了处理器缓存被禁用，受影响的机器上的计算慢了超过100倍。

我们有一个通用的机制来避免离群问题。当MapReduce操作将要完成时，master会通过调度对仍在执行中的任务创建副本并执行。当原*任务*和其副本之一执行完成时，该任务会被标记为已完成。我们对这个机制进行了一些调优，使它通常情况下对计算资源的占用仅提高几个百分点。我们发现这个机制显著地减少了完成大型MapReduce操作的时间。例如，[章节5.3](#53-)中的排序程序在禁用任务副本机制时，完成时间延长了44%。

## 4. 改进

尽管编写*map*和*reduce*函数提供的基本功能已经能够满足大多数场景下的需求，有一些扩展功能还是会提供很大帮助。我们将在本节中讨论这些扩展。

### 4.1 分区函数

MapReduce的用户可以自定义其需要的*reduce*的*任务*或输出文件数（$R$）。分区函数（partitioning function）通过*中间键值对*的键将数据为每个任务分区。我们提供了使用哈希函数（例如，$hash(key) mod R$）的默认分区函数。使用该函数往往会得到比较平衡的分区。然而，在有些情况下，通过某些其他的函数按照键分区很有用。例如，有时输出的键为URL，我们希望所有来自同一个主机的条目最终会被输出到相同的文件中。为了支持类似情况，MapReduce库的用户可以提供一个自定义的分区函数。例如，使用”$hash(hostname(urlkey)) mod R$“作为分区函数可以使来自同一个主机的所有URL最终输出到同一个文件中。

### 4.2 有序性保证

我们保证在一个给定的分区中，*中间键值对*是按照键的升序进行处理的。这种有序性保证使每个分区生成有序的输出变得非常简单。这对于输出文件格式需要支持按照键进行高效的随机访问等情况时十分有用。

### 4.3 合并函数

在一些情况下，*map*任务会产出很多键相同的*中间键值对*，且用户定义的*reduce*函数服从交换律和结合律。[章节2.1](#21-示例)中的单词计数就是一个很好的例子。因为词频往往服从*Zipf*分布（齐夫定律），每个*map*任务会产出成百上千条$<the,1>$的记录。所有的这些计数记录会被通过网络发送到同一个*reduce*任务，并随后被*reduce*函数加在一起得到一个总数。我们允许用户自定义一个可选的合并函数（combiner function），在数据通过网络发送前对这部分数据进行合并。

合并函数会在每个执行*map*任务的机器上执行。通常，实现合并函数和*reduce*函数的代码是相同的。合并函数和*reduce*函数唯一的区别是MapReduce库处理函数输出的方式。*reduce*函数的输出会被写入最终输出文件。合并函数的输出会被写入中间文件，随后中间文件会被发送给*reduce*任务。

部分数据的合并显著地提高了某些类型的MapReduce操作的速度。[附录A](#附录a-词频统计)包含了一个使用了合并函数的例子。

### 4.4 输入输出类型

MapReduce库提供了以多种格式读取输入数据的支持。例如，“text”模式将每一行作为一个键值对输入：其中键为行号，值为行的内容。另一种支持的常见的格式被存储为按键排序的键值对序列。每个输入类型的实现都知道如何将输入划分为有意义的区间，以便分开交给*map*任务处理（例如，“text”模式的区间划分保证仅在行分隔符处划分区间）。用户可以通过提供类似*reader*接口的实现的方式来增加对新的输入类型的支持，虽然大部分用户仅使用了预支持输入类型中的一小部分。

*reader*并非必须从文件读取数据。例如，我们可以很容易地实现一个从数据库或从内存中映射的数据结构中读取记录的*reader*。

类似地，我们也提供了一系列可以将数据输出位不同格式的输出类型，且也可以很容易地通过哦用户代码添加新的输出类型支持。

### 4.5 附属输出

在一些情况下，MapReduce的用户可以很方便地通过*map*和（或）*reduce*操作生成附属输出文件作为额外的输出。我们依赖应用程序的*writer*来使这种操作具有原子性（atomic）与幂等性（idempotent）。通常，应用程序将数据写入到一个临时文件，并在该文件完全生成完成后原子性地将该文件重命名。

我们没有对一个*任务*生产多个输出文件提供原子性的两段提交协议（two-phase commits，2PC）支持。因此，产生多个输出文件且有跨文件一致性需求的*任务*应该具有“确定性（译注，如[章节3.3.3](#333-故障出现时的语义)）”。但在实际环境中，这一限制并不是什么问题。

### 4.6 跳过损坏的记录

有时，用户代码中的bug会导致*map*或*reduce*函数在处理某些记录时会发成确定性地崩溃。这种bug导致MapReduce操作无法完成。这种情况下，通常的处理方式是修复这个bug，但有时这样并不可行，因为bug可能在无法访问源码的第三方库中。同时，有些时候忽略一些记录时可以接受的，例如在大规模数据集中进行统计分析时。为此，我们提供了一种可选的执行模式，该模式下MapReduce库可以检测会导致确定性崩溃的记录并跳过这些记录，以让处理进程能够继续执行。

每个worker进程会安装一个捕捉段违规（segmentation violation）和总线错误（bus error）的处理器。再调用用户的*map*或*reduce*操作之前，MapReduce库会在全局变量中存储参数的编号。如果用户代码产生了一个信号，信号处理器会向master发送一个含有该编号的“last gasp（奄奄一息）”UDP包。当master在同一条记录上收到超过一个故障时，master会在下一次重新执行相关*map*任务或*reduce*任务时指示跳过该记录。

### 4.7 本地执行

调试*map*或*reduce*函数中的bug是非常棘手的，因为它们实际运行在分布式系统中，且其经常运行在几千台机器上并由master动态地决定任务的分配。为了帮助开发者debug、分析和小规模测试，我们开发了一个MapReduce库的替代实现，其可以在一台本地机器上顺序的执行所有MapReduce操作。用户可以仅执行计算任务中的几个特定的*map*任务。用户仅需使用一个特殊的标识符调用程序，就可以轻松地使用任何调试工具或测试工具（如gdb）。

### 4.8 状态信息

master会运行一个内部的HTTP服务器，并将一系列的状态信息页面暴露给用户。这些页面会展示计算的进度，如多少个*任务*已经完成、多少个*任务*正在执行、输入的字节数、中间数据的字节数、输出的字节数、处理速度等。这些页面中还包含展示每个*任务*输出的标准错误和标准输出文件的页面链接。用户可通过这些数据预测计算需要消耗多长时间、需不需要为计算任务增加额外的资源。这些页面也可以用来发现计算是否比预期慢很多。

另外，顶级的状态页面展示了哪些worker执行失败了与它们失败时运行的*map*任务和*reduce*任务。这些信息对诊断用户代码中的bug十分有帮助。

### 4.9 计数器

MapReduce库提供了用来计数不同事件发生次数的计数器。例如，用户代码可能希望对处理的词数或者索引的德语文档计数等。

若使用计数器，用户代码需要创建一个命名的计数器对象并在*map*和（或）*reduce*函数中适当地增加计数器计数。例如：

```

Counter* uppercase;
uppercase = GetCounter("uppercase");

map(String name, String contents):
  for each word w in contents:
    if (IsCapitalized(w)):
      uppercase->Increment();
    EmitIntermediate(w, "1");

```

每个worker机器会周期性地将计数器的值传给master（通过ping的响应报文携带）。master将成功执行的*map*和*reduce*任务中的计数器的值加在一起，并在MapReduce操作完成时将其返回给用户代码。计数器当前的值同样在master的分析页面中显示，这样用户就可以查看实时的计算进度。master在对计数器求和时，会对多次执行的相同的*map*或*reduce*任务中的计数器值去重，以避免重复计数。（*任务*副本和因故障被重新执行的*任务*都会导致重复执行。）

有些计数器的值被MapReduce库自动维护，如处理过的*输入键值对*的数量或生成的*输出键值对*的数量。

对用户而言，计数器对检查MapReduce操作是否完成非常有帮助。例如，在有些MapReduce操作中，用户代码可能希望保证*输出键值对*的数量和*输入键值对*的数量正好相等，或者想保证处理过的德语文档在总数中占的比例是否在允许的范围内。

## 5. 性能

在本章中，我们将测量大规模集群中的两个MapReduce计算的性能。其中一个计算任务是在大约1TB的数据中按照一个模板（pattern）搜索。另一个计算任务时排序大约1TB的数据。

这两个程序都代表了用户编写的真实程序中占比很大的两类子集。其中一类程序是将数据从一种表示变换到另一种表示，另一类程序是从大规模数据集中提取少量感兴趣的数据。

### 5.1 集群配置

所有的程序都在一个由大约1800台机器的集群中执行。每台机器有两个开启了超线程的$GHz的Intel至强Xeon处理器、4GB内存、2个160GB的IDE硬盘和1Gbps的以太网连接。这些机器组成了双层树状的交换机网络，根节点总带宽约100~200Gbps。所有机器都在同一个中心托管，因此任何两个机器间往返时延（RTT）小于1ms。

在4GB内存中，有大约1~1.5GB内存被集群为了运行其他任务保留。这些程序是在一个周末的下午执行的，那时CPU、磁盘和网络几乎都处于空闲状态。

### 5.2 grep

*grep*程序会扫描$10^{10}$条100B的记录，以搜索匹配一个相对较少的三个字母的模板（92,337条记录命中）。输入数据被分割为约64MB的分片（$M=15000$），所有的输出被放置在一个文件中（$R=1$）。

**图2**展示了计算进度随时间的变化。Y轴展示了输入数据被扫描的速率。随着分配给MapReduce计算的机器越来越多，其速度也逐渐提高。当有1764个worker被分配到该任务时，速率峰值超过了30GB/s。当*map*任务完成时，速率开始逐渐下降并在整个计算时间的大概第80s时下降到0。整个计算从开始到结束大概消耗了150s。这包括了大概一分钟的启动时间开销。这一开销的原因是程序需要传播到所有worker机器与打开1000个输入文件并获取局部优化所需的信息时与GFS交互的时延。

![图2 数据传输速率随时间变化图](figure-2.png "图2 数据传输速率随时间变化图")

### 5.3 sort

*sort*程序会对$10^{10}$条100B的记录进行排序（大约1TB的数据）。这个程序是模仿*TeraSort*的*benchmark*程序<sup>\[10\]</sup>构建的。

排序程序的用户代码少于50行。三行的*map*函数从一行文本中提取一个10字节的排序用的键，并将这个键与原始文本作为*中间键值对*输出。我们使用了一个内建的恒等函数作为*reduce*操作。这个函数不对*中间键值对*就行修改，直接作为*输出键值对*传递。最终排序的输出被写入一系列2副本的GFS文件中（即，程序输出总计写入了2TB）。

与前者相同，输入数据被分割为64MB的分片（$M=15000$）。我们将排序的输出分区到4000个文件中（$R=4000$）。分区函数根据键的首字节将其划分到$R$个分区之一中。

该benchmark的分区函数内建了键的分布情况。在通常的排序程序中，我们会增加一个提前执行的MapReduce操作，该操作会采集一些键的样本，并通过这些样本来计算最终排序时的分割点。

**图3(a)**展示了以普通方式执行时程序的进度。左上角的图表展示了输入数据读取的速率。速率的峰值达到大概13GB/s，随后快速下降，因为所有哦*map*任务都在大概第200秒前完成。需要注意的是该程序数据输入速率比*grep*低。这是因为*sort*的*map*任务消耗了大概一半的时间和I/O带宽用于将中间数据写入到本地磁盘，而*grep*的中间数据大小几乎可以忽略不计。

左侧中间的图表展示了数据通过网络从*map*任务发送到*reduce*任务的速率。该数据转移（shuffle）在第一个*map*任务完成时便开始。图表中第一个峰中的数据转移是为了第一批约1700个*reduce*任务（整个MapReduce被分配到1700台机器上，每台机器同时最多执行1个*reduce*任务）。在整个计算任务的大概第300秒时，部分第一批*reduce*任务完成了，并开始为剩余的*reduce*任务转移数据。所有的数据转移在整个计算的大概第600秒是完成。

左下角的图表展示了排好序的数据被*reduce*任务写入最终输出文件的速率。在第一个数据转移阶段和数据开始被*reduce*任务写入到最终文件间有一段延时，这是因为这期间机器都在忙于排序中间数据。写入操作以2~4GB/s的速率持续了一段时间，在整个计算过程的大概第850秒时完成了数据写入。算上启动的开销，整个计算过程消耗了891秒。这与目前在TeraSort benchmark中报道的最佳结果1057秒非常接近<sup>\[18\]</sup>。

这有一些需要注意的点：由于我们的局部性优化，大部分数据直接从本地磁盘读取，绕过了带宽相对受限的玩过，所以数据输入速率比数据转移速率高。由于数据输出阶段写入了两份排好序的数据的副本，所以数据转移的速率比输出的速率高（为了可靠性和可用性，我们为输出数据设置了两份副本）。我们的下层文件系统为了可靠性和可用性的考虑而写入了两份副本。如果我们使用擦除编码（erasure code）<sup>\[14\]</sup>的方式而不是副本的方式，写入数据时网络带宽的需求会减少。

![图3 排序程序不同种执行方式中数据传输速率随时间的变化图](figure-3.png "图3 排序程序不同种执行方式中数据传输速率随时间的变化图")

### 5.4 任务副本的影响

**图3(b)**展示了禁用了任务副本后的*sort*程序执行情况。其执行流程与**图3(a)**中的类似，除了最后有撑场一段时间几乎没有写入发生。在960秒后，除了5个*reduce*任务外其他所有任务都已经完成了。然而，最后这些离群的任务在300秒后才执行完毕。整个计算过程消耗了1283秒，增加了44%的运行时间。

### 5.5 机器故障

**图3(c)**中，我们展示了在执行**sort**程序时，我们故意在计算开始的几分钟后里杀死了1746个worker中的200个时，程序的执行进度情况。下层的集群调度器立刻在这些机器上重启了新的worker进程（因为仅杀死了进程，机器还在正常运行）。

因为当worker被杀死后，一些之前已经完成了的*map*任务消失且需要被重新执行，所以对输入速率有负面影响。重新执行的*map*任务相对比较快。算上启动的开销，整个计算过程在993秒内完成（仅比正常执行时增加了5%）。

## 6. 研发经历

我们在2003年2月编写了第一个版本的MapReduce库，并在2003年8月对其进行了大幅增强，包括局部性优化、跨worker机器的动态负载均衡等。从那时起，我们便惊喜的发现在处理各种问题时MapReduce库的应用之广。MapReduce库在Google内部被广泛应用于各种领域，包括：

- 大规模机器学习问题；

- Google News和Froogle产品的聚类问题；

- 提取数据用于生成热门查询报告（例如，Google Zeitgeist）；

- 为了新的实验和产品提取网页属性（例如，从大量的网页语料库中提取地理位置信息，用于本地化搜索）；

- 大规模图运算。

![图4 MapReduce实例数随时间变化图](figure-4.png "图4 MapReduce实例数随时间变化图")

**图4**中可见，在我们的主源代码管理系统中，独立的MapReduce程序随时间大幅增长。其数量从2003年初的0个增长到2004年9月末的几乎800个独立实例。MapReduce取得了很大的成功，它可以让用户仅编写简单的代码即可在半小时内在上千台机器上高效运行，这大大的提高了开发和设计周期。此外，MapReduce让没有任何分布式和（或）并行系统编程经验的开发者能够轻松利用大量资源。

在每个工作的最后，MapReduce库会记录该工作使用的计算资源的统计数据。**表1**展示了Google在2004年8月运行的MapReduce工作的子集的统计数据。

<table style="text-align:center;">
    <tr>
      <th colspan="2">
        表1 2004年8月运行的MapReduce工作情况
      </th>
    </tr>
    <tr>
      <td>工作数<br>平均工作完成时间<br>使用的机器工作量</td>
      <td>29,423<br>634 secs<br>79,186 days</td>
    </tr>
    <tr>
      <td>读取的输入数据量<br>生成的中间数据量<br>写入的输出数据量</td>
      <td>3,288 TB<br>758 TB<br>193 TB</td>
    </tr>
    <tr>
      <td>平均每个工作使用的worker机器数<br>平均每个工作故障机器数<br>平均每个工作map任务数<br>平均每个工作reduce任务数</td>
      <td>157<br>1.2<br>3,351<br>55</td>
    </tr>
    <tr>
      <td>不同的map实现数量<br>不同reduce实现数量<br>不同map/reduce组合数量</td>
      <td>395<br>269<br>426</td>
    </tr>
</table>

### 6.1 大规模索引

目前，我们使用MapReduce做的最重要的工作之一是完全重写了一个索引系统，该系统被用作生成用于Google web搜索服务的数据结构。该索引系统将大量被我们爬虫系统检索到的文档（作为GFS文件存储）作为输入。这些文档的原始内容的数据大小超过20TB。索引进程会运行一系列5~10个MapReduce操作。使用MapReduce（而不是旧版索引系统中ad-hoc分布式传递方案）提供了很多好处：

- 索引代码更简单、短、便于理解，因为处理容错、分布式和并行的代码被隐藏在了MapReduce库中。例如，计算中的有一个阶段的代码量从3800行C++代码所见到了700行使用MapReduce的代码。

- MapReduce库的性能足够好，这让我们可以将概念上不相关的计算分离开，而不是将它们混合在一起，这样可以避免传递过多额外的数据。这使改变索引程序变得非常简单。例如，在我们旧的索引系统中，一处修改会花费几个月的时间，而新的系统仅需要几天就能实现。

- 索引系统变得更容易操作。大部分因机器故障、缓慢的机器、网络不稳定等引起的问题都被MapReduce库自动处理了，不需要引入额外的操作。此外，向索引集群添加新机器以获得更好的性能变得更加简单。

## 7. 相关工作

许多系统提供了受限制的编程模型，并通过这些限制来进行自动化并行计算。例如，使用并行前缀和计算（parallel prefix computation）<sup>\[6, 9, 13\]</sup>，可以使用$N$个处理器上在$O(logN)$的时间内计算有$N$个元素的数组中所有前缀和。MapReduce可被看做是对一些这类模型基于我们在现实世界中对大型计算的经验做出的简化和升华。更重要的是，我们提供了适用于大规模的数千个处理器的带有容错机制的实现。相反，大部分并行处理系统仅被小规模使用，且将处理机器故障的细节留给了开发者。

BSP模型（Bulk Synchronous Programming）<sup>\[17\]</sup>和一些MPI（Message Passing Interface，消息传递接口）<sup>\[11\]</sup>原语提供了让开发者编写并行程序更简单的高层抽象。这些系统和MapReduce的关键区别在于MapReduce提供了一个受限的编程模型，以自动地并行化用户程序，并提供了透明的容错机制。

我们的局部性优化的灵感来自于如活动磁盘（active disk）<sup>\[12, 15\]</sup>技术，即计算程序被推送到靠近本地磁盘的处理设备中，这减少了I/O子系统或者网络的总数据发送量。我们在直连少量磁盘的商用处理器上运行程序，而不是直接在磁盘控制处理器上运行，但最终目的都是一样的。

我们的任务副本机制类似Charlotte System<sup>\[3\]</sup>中使用的Eager调度机制。简单的Eager调度的一个缺点是，当一个任务反复故障时，整个计算都无法完成。我们通过跳过损坏记录的方式来解决导致该问题的一些情况。

MapReduce的实现依赖了一个内部的集群管理系统，该系统负责在大量共享的机器上分配并运行用户任务。该系统比较神似如Condor<sup>\[16\]</sup>的其他系统，但这并不是本文的重点。

MapReduce中的排序机制在操作上类似NOW-Sort<sup>\[1\]</sup>。源机器（*map* worker）将待排序的数据分区，并将其发送到$R$个*reduce* worker之一。每个*reduce* worker将其数据在本地排序（如果可以，会在内存中执行）。当然，NOW-Sort不支持用户自定义*map*和*reduce*函数，这让我们的库适用范围更广。

River<sup>\[2\]</sup>提供了一个通过分布式队列发送数据来处理程序间交互的编程模型。就像MapReduce，River系统试图在存在由异构硬件或系统干扰导致的性能不均匀的情况下提供良好的平均性能。River通过小心地调度磁盘和网络传输以使计算时间平衡的方式实现这一点。而MapReduce框架通过对编程模型进行限制，将问题划分为大量更细致的任务。这些任务在可用的worker间动态调度，以让更快的worker处理更多任务。这种受限的编程模型还允许在工作末期调度冗余执行的任务，这样可以大大缩减离群机器（如慢速或者卡死的worker）中的计算时间。

BAD-FS<sup>\[5\]</sup>采用了和MapReduce区别非常大的编程模型。与MapReduce不同，BAD-FS的目标是在广域网中执行工作。然而，有两个基本点很相似。（1）二者都使用了冗余执行的方式恢复因故障丢失的数据。（2）二者都使用了有位置感知（locality-aware）调度方式来减少拥堵的网络连接中数据发送的总量。

TACC<sup>\[7\]</sup>是一个为简化高可用网络服务设计的系统。像MapReduce一样，TACC依赖重新执行的方式作为容错机制。

## 8. 结论

MapReduce编程模型被成功应用于Google中的很多目标。我们将这种成功归结于几个原因。第一，因为该模型隐藏了并行化、容错、本地优化和复杂均衡的细节，所以甚至没有相关经验的程序员都可以轻松使用。第二，很多不同的问题都可以被表示为MapReduce计算。例如，MapReduce在Google的生产系统的web搜索服务、排序、数据挖掘、机器学习和很多其他系统中被作为数据生成工具使用。第三，我们开发了一个适用于由上千台机器组成的大型集群的MapReduce实现。该实现可以高效利用这些机器的资源，因此其非常适用于Google中的大型计算问题。

我们从这项工作中学习到了很多事。第一，对编程模型进行限制可以让并行化、分布式计算、容错等更加简单。第二，网络带宽是非常稀缺的资源。我们系统中的大量优化都是为了减少网络发送的数据量：局部性优化允许我们从本地磁盘读取数据，在本地磁盘中写单个中间数据的副本同样节约了网络带宽。第三，冗余执行可以用来减少缓慢的机器带俩的影响，并可以用来处理机器故障和数据丢失。

## 致谢

Josh Levenberg在修订和扩展用户级MapReduce API方面提供了很大帮助，他根据自己对MapReduce的使用经验和其他人对功能增强的建议，提供了很多新特性。MapReduce从GFS<sup>\[8\]</sup>读取输入并写入输出。感谢Mohit Aron, Howard Gobioff, Markus Gutschke, David Kramer, Shun-Tak Leung和Josh Redstone在开发GFS中做出做出的工作。同样感谢Percy Liang和Olcan Sercinoglu在MapReduce使用的集群管理系统中做出的工作。Mike Burrows, Wilson Hsieh, Josh Levenberg, Sharon Perl, Rob Pike和Debby Wallach为本文的早期草稿提供了有帮助的评论。OSDI的匿名审稿者和我们的领导者Eric Brewer对本文的改进提供了帮助。最后，我们希望感谢来自Google工程师的MapReduce使用者，他们给出了很多有帮助的反馈、建议和bug报告。

## 参考文献

<div class="reference">

[1] Andrea C. Arpaci-Dusseau, Remzi H. Arpaci-Dusseau, David E. Culler, Joseph M. Hellerstein, and David A. Patterson. High-performance sorting on networks of workstations. In Proceedings of the 1997 ACM SIGMOD International Conference on Management of Data, Tucson, Arizona, May 1997.

[2] Remzi H. Arpaci-Dusseau, Eric Anderson, Noah Treuhaft, David E. Culler, Joseph M. Hellerstein, David Patterson, and Kathy Yelick. Cluster I/O with River: Making the fast case common. In Proceedings of the Sixth Workshop on Input/Output in Parallel and Distributed Systems (IOPADS ’99), pages 10–22, Atlanta, Georgia, May 1999.

[3] Arash Baratloo, Mehmet Karaul, Zvi Kedem, and Peter Wyckoff. Charlotte: Metacomputing on the web. In Proceedings of the 9th International Conference on Parallel and Distributed Computing Systems, 1996.

[4] Luiz A. Barroso, Jeffrey Dean, and Urs Holzle. ¨ Web search for a planet: The Google cluster architecture. IEEE Micro, 23(2):22–28, April 2003.

[5] John Bent, Douglas Thain, Andrea C.Arpaci-Dusseau, Remzi H. Arpaci-Dusseau, and Miron Livny. Explicit control in a batch-aware distributed file system. In Proceedings of the 1st USENIX Symposium on Networked Systems Design and Implementation NSDI, March 2004.

[6] Guy E. Blelloch. Scans as primitive parallel operations. IEEE Transactions on Computers, C-38(11), November 1989.

[7] Armando Fox, Steven D. Gribble, Yatin Chawathe, Eric A. Brewer, and Paul Gauthier. Cluster-based scalable network services. In Proceedings of the 16th ACM Symposium on Operating System Principles, pages 78–91, Saint-Malo, France, 1997.

[8] Sanjay Ghemawat, Howard Gobioff, and Shun-Tak Leung. The Google file system. In 19th Symposium on Operating Systems Principles, pages 29–43, Lake George, New York, 2003.

[9] S. Gorlatch. Systematic efficient parallelization of scan and other list homomorphisms. In L. Bouge, P. Fraigniaud, A. Mignotte, and Y. Robert, editors, Euro-Par’96. Parallel Processing, Lecture Notes in Computer Science 1124, pages 401–408. Springer-Verlag, 1996.

[10] Jim Gray. Sort benchmark home page. http://research.microsoft.com/barc/SortBenchmark/. [11] William Gropp, Ewing Lusk, and Anthony Skjellum. Using MPI: Portable Parallel Programming with the Message-Passing Interface. MIT Press, Cambridge, MA, 1999.

[12] L. Huston, R. Sukthankar, R. Wickremesinghe, M. Satyanarayanan, G. R. Ganger, E. Riedel, and A. Ailamaki. Diamond: A storage architecture for early discard in interactive search. In Proceedings of the 2004 USENIX File and Storage Technologies FAST Conference, April 2004.

[13] Richard E. Ladner and Michael J. Fischer. Parallel prefix computation. Journal of the ACM, 27(4):831–838, 1980.

[14] Michael O. Rabin. Efficient dispersal of information for security, load balancing and fault tolerance. Journal of the ACM, 36(2):335–348, 1989.

[15] Erik Riedel, Christos Faloutsos, Garth A. Gibson, and David Nagle. Active disks for large-scale data processing. IEEE Computer, pages 68–74, June 2001.

[16] Douglas Thain, Todd Tannenbaum, and Miron Livny. Distributed computing in practice: The Condor experience. Concurrency and Computation: Practice and Experience, 2004.

[17] L. G. Valiant. A bridging model for parallel computation. Communications of the ACM, 33(8):103–111, 1997.

[18] Jim Wyllie. Spsort: How to sort a terabyte quickly. http://alme1.almaden.ibm.com/cs/spsort.pdf.

</div>

## 附录A 词频统计

本节包含了一个对通过命令行指定的一系列输入文件中每个单词出现次数技术的程序。

```cpp

#include "mapreduce/mapreduce.h"

// User’s map function
class WordCounter : public Mapper {
  public:
    virtual void Map(const MapInput& input) {
      const string& text = input.value();
      const int n = text.size();
      for (int i = 0; i < n; ) {
        // Skip past leading whitespace
        while ((i < n) && isspace(text[i]))
          i++;

        // Find word end
        int start = i;
        while ((i < n) && !isspace(text[i]))
          i++;
        
        if (start < i)
          Emit(text.substr(start,i-start),"1");
      }
  }
};
REGISTER_MAPPER(WordCounter);

// User’s reduce function
class Adder : public Reducer {
  virtual void Reduce(ReduceInput* input) {
    // Iterate over all entries with the
    // same key and add the values
    int64 value = 0;
    while (!input->done()) {
      value += StringToInt(input->value());
      input->NextValue();
    }

    // Emit sum for input->key()
    Emit(IntToString(value));
  }
};
REGISTER_REDUCER(Adder);

int main(int argc, char** argv) {
  ParseCommandLineFlags(argc, argv);

  MapReduceSpecification spec;

  // Store list of input files into "spec"
  for (int i = 1; i < argc; i++) {
    MapReduceInput* input = spec.add_input();
    input->set_format("text");
    input->set_filepattern(argv[i]);
    input->set_mapper_class("WordCounter");
  }

  // Specify the output files:
  // /gfs/test/freq-00000-of-00100
  // /gfs/test/freq-00001-of-00100
  // ...
  MapReduceOutput* out = spec.output();
  out->set_filebase("/gfs/test/freq");
  out->set_num_tasks(100);
  out->set_format("text");
  out->set_reducer_class("Adder");

  // Optional: do partial sums within map
  // tasks to save network bandwidth
  out->set_combiner_class("Adder");

  // Tuning parameters: use at most 2000
  // machines and 100 MB of memory per task
  spec.set_machines(2000);
  spec.set_map_megabytes(100);
  spec.set_reduce_megabytes(100);

  // Now run it
  MapReduceResult result;
  if (!MapReduce(spec, &result)) abort();

  // Done: ’result’ structure contains info
  // about counters, time taken, number of
  // machines used, etc.

  return 0;
}

```