---
title: "《Resilient Distributed Datasets: A Fault-Tolerant Abstraction for In-Memory Cluster Computing》论文翻译（RDD-NSDI12-FINAL138）[持续更新中]"
date: 2020-09-07T11:14:45+08:00
lastmod: 22020-09-07T11:14:45+08:00
draft: false
keywords: []
description: ""
tags: ["RDD", "Translation"]
categories: ["Paper Reading"]
author: ""
resources:
- name: featured-image
  src: paper-reading.jpg
---

*本篇文章是对论文[RDD-NSDI12-FINAL138](https://www.usenix.org/system/files/conference/nsdi12/nsdi12-final138.pdf)的原创翻译，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*


<sup>[]</sup>

<!--more-->

## 摘要

我们提出了一个能够使开发者在大型集群上执行内存式计算且带有容错的分布式内存的抽象——Resilient Distributed Datasets（RDD，弹性分布式数据集）。RDD的想法由在当前计算框架中处理效率不高的两类应用程序驱动：迭代算法和交互式数据挖掘工具。在这两种情况下，将数据保存在内存中能够将性能提高一个数量级。为了实现有效地容错，RDD提供了共享内存的一个受限的形式，其基于粗粒度的变换而不是细粒度的共享状态更新。然而，我们发现RDD足以表示很广泛的计算类型，包括最近像Pregel一样的专门针对迭代任务的程序模型，以及在新应用程序中这些模型表达不出的模型。我们在被称为Spark的系统中实现了RDD，并通过各种用户程序和benchmark来评估这个系统。

## 1. 引言

像MapReduce<sup>[10]</sup>和Dryad<sup>[19]</sup>之类的集群计算框架已广泛引用于大规模数据分析。这些系统让用户可以通过一系列高层操作来编写并行计算，不需要担心工作的分布与容错。

尽管当前的框架提供了大量访问集群资源的抽象，它们仍缺少对利用分布式内存的抽象。这使它们对一类新兴的重要应用程序来说效率很低。这类新兴的应用程序会复用（reuse）多个计算的中间结果。数据复用在很多迭代（iterative）式机器学习和图算法（包括PageRank、K-means聚类、逻辑回归等）中很常见。另一个备受关注的使用场景是交互式数据挖掘，该场景下用户会在同一个数据的子集上运行多个临时查询。不幸的是，在大部分当前的框架中，在计算间（如两个MapReduce的job间）复用数据的唯一方式是将其写入外部稳定存储系统，如分布式文件系统。由于这样做需要数据副本、磁盘I/O和序列化等占用大部分程序执行时间的操作，这会导致非常可观的额外开销。

由于意识到了这一问题，研究者们已经开发了为一些需要复用数据的应用程序专门设计的框架。例如，Pregel<sup>[22]</sup>是一个为迭代式图计算设计的系统，其能将中间数据保存在内存中；HaLoop<sup>[7]</sup>提供了迭代式MapReduce接口。然而，这些框架仅支持特殊的编程模式（例如，循环一系列MapReduce的step），并在这些模式中进行隐式数据共享。它们不支持更普遍的数据复用抽象，如允许用户将几个数据集加载到内存中并运行跨这些数据集的临时查询。

在本文中，我们提出了一种新的抽象——resilient distributed datasets（RDD），其能在广泛的应用程序中进行高效数据复用。RDD是能容错的并行数据结构，其使用户能够显式地将中间结果在内存中持久化，并控制它们的分区以优化数据位置，且能够对其使用丰富的操作。

设计RDD的主要挑战是定义能够高效地提供容错的编程接口。已有的为集群中内存式存储（分布式共享内存<sup>[24]</sup>、键值存储<sup>[25]</sup>数据库和Piccolo<sup>[27]</sup>等）设计的抽象，提供了基于细粒度更新（fine-grained update）变更状态（如表中的单元格）的接口。在这种接口中，提供容错的唯一几种方式是将数据跨机器做副本或跨机器记录更新日志。这两种方法对于数据敏感性工作负载来说开销过于高昂，因为它们需要通过集群的网络复制大量的数据，而集群的网络带宽远低于RAM，且它们造成了大量的存储额外开销。

与这些系统不同，RDD提供了基于粗粒度（coarse-grained）的变换（如map、filter和join）接口，其对许多数据项应用相同的操作。这使它们能够通过记录构建数据集（它的普系统）使用的变换而不是对实际数据使用的变换的方式，来高效地提供容错<sup>注1</sup>。如果RDD的一个分区丢失，RDD有足够的关于它如何被从其它RDD导出的信息，来重新计算仅这一分区。因此，丢失的数据可被恢复，数据恢复速度通常非常快，且不需要开销高昂的副本。

> 注1：在一些RDD中，当数据的延伸链增长得很大时，对数据建立检查点非常有用。我们将在[章节5.4](#54-)中讨论如何操作。

尽管基于粗粒度变换的接口最初似乎非常有限，但RDD仍非常适用于许多并行程序，因为这些程序本身就对许多数据项应用相同的操作。事实上，我们发现RDD可以高效地表示很多集群编程模型，目前这些模型被不同的系统分别提出，其包括MapReduce、DryadLINQ、SQL、Pregel和HaLoop，以及新式应用程序中无法表示的模型，如交互式数据挖掘。RDD的这种仅通过引入新的框架就能适配过去已经满足了的计算需求的能力，在我们看来是RDD抽象能力最令人信服的证据。

我们在被称为Spark的系统中实现了RDD，该系统被在UC Berkeley和许多公司的研究和生产应用程序中使用。Spark在Scala编程语言<sup>[2]</sup>中提供了一个类似DryadLINQ<sup>[31]</sup>的很方便的语言集成的编程接口（language-integrated programming interface）。另外，Spark可被在Scala解释器中交互式查询大数据集时使用。我们认为Spark是第一个能够以交互所需的速度使用通用编程语言在集群中进行内存数据挖掘的系统。

我们通过小批量benchmark和在我们的应用程序中测量的方式来评估RDD和Spark的性能。我们发现Spark在迭代式应用程序中比Hadoop快了20倍，在真实的数据分析报告中快了40倍，且可在交互时以5~7秒的延时来扫描1TB的数据集。更重要的是，为了说明RDD通用性，我们在Spark之上实现了Pregel和HaLoop编程模型作为相对小的库（每个200行代码），包括他们使用的位置优化。

本文从RDD（[第二章](#2-)）和Spark（[第三章](#3-)）的概览开始。接着我们讨论了RDD的内部表示法（[第四章](#4-)）、我们的实现（[第五章](#5-)）和实验结果（[第六章](#6-)）。最后，我们讨论了RDD如何实现现有的几个集群编程模型（[第七章](#7-)），调查了相关工作（[第八章](#8-)）并进行总结。

## 2. Resilient Distributed Datasets（RDD）

本章提供了RDD的概览。首先，我们定义了RDD（[章节2.1](#21-)），然后介绍了它们在Spark中的编程接口（[章节2.2](#22-)）。接着，我们将RDD与细粒度的共享内存抽象进行了对比（[章节2.3](#23-)）。最后，我们讨论了RDD模型的限制（[章节2.4](#24-)）。

### 2.1 RDD抽象

从形式上看，RDD是一个只读的分区的记录的集合。RDD仅能通过确定性（deterministic）操作，从（1）稳定存储中的数据或（2）其他RDD上创建。我们将这些操作成为“变换”，以与RDD上的其他操作进行区分。变换的例子包括*map*、*filter*和*join*。<sup>注2</sup>

> 注2：尽管单独一个RDD是不可变的，但是还是可以通过使用多个RDD来实现可变状态，以表示数据集的多个版本。我们使RDD不可变是为了使其能够更容易描述谱系图，但这等价于将我们的抽象变为多版本数据集并在谱系图中跟踪版本号。

RDD不需要在所有时间都被实体化（materialized）。RDD有足够关于它是如何从其他数据集（它的谱系图）导出的信息，以能够从稳定存储中的数据计算它的分区。这是一个很强大的属性：本质上讲，如果RDD不能再故障后重构，那么应用程序就无法引用它。

最后，用户还能控制RDD的另两个方面：持久化（persistence）和分区（partitioning）。用户可以指出他们需要复用哪个RDD并为其选自一个存储策略（如内存存储）。用户还可以要求RDD的元素基于每个记录中的key跨机器分区。这对位置优化很有帮助，如保证两个将要被*join*到一起的数据集会按照相同的哈希分区。

### 2.2 Spark编程接口

Spark通过类似DryadLINQ<sup>[31]</sup>和FlumeJava<sup>[8]</sup>的语言集成的API来暴露RDD，每个数据集被表示为一个对象，变换通过调用这些对象中的方法来实现。

编程人员从通过对稳定存储中的数据进行变换（如*map*和*filter*）来定义一个或更多的RDD开始。接下来，编程人员可以在action中使用这些RDD，actions是给应用程序返回值或将数据导出到存储系统的操作。action的例子包括*count*（返回数据集中元素数）、*collect*（返回元素本身）、*save*（将数据集输出至存储系统）。像DryadLINQ一样，Spark在RDD第一次被在action使用时懒式计算它，因此Spark可以将变换流水线化。

另外，编程人员可以调用*persist*方法来指定他们在未来的操作中需要复用的RDD。Spark默认会会将RDD在内存中持久保存，但Spark会在没有足够RAM的时候将其写入磁盘。用户可以可用*persisi*的标识请求其他的存储策略，如仅在磁盘中存储RDD或跨机器对RDD做副本。最后，用户可以对每个RDD设置持久化优先级，以指定内存中的那个数据会最先被写入到磁盘。

#### 2.2.1 样例：终端日志挖掘

假设一个Web服务发生了错误，且有一个想要通过搜索Hadoop文件系统（HDFS）中TB级的日志来找到原因的操作。通过使用Spark，该操作可以仅将跨一系列节点的错误信息从日志装入RAM，并交互式地查询它们。该编程人员首先需要编写如下Scala代码：

```scala

lines = spark.textFile("hdfs://...")
errors = lines.filter(_.startsWith("ERROR"))
errors.persist()

```

第一行定义了一个以HDFS文件（该文件由多行纯文本组成）作为后端的RDD，第二行获取了一个从该RDD过滤得到的新RDD。第三行要求`errors`在内存中持久化，这样它就可以被其他的查询共享。注意*filter*的参数是一个Scala闭包的表达式。

此时，集群中没有任何任务执行。然而，用户现在可以在action中使用这个RDD。例如，想要统计消息数量：

```scala

errors.count()

```

用户也可以使用该RDD和其变换结果进行更多变换，就像下面代码中的那样：

```scala

// Count errors mentioning MySQL:
errors.filter(_.contains("MySQL")).count()

// Return the time fields of errors mentioning
// HDFS as an array (assuming time is field
// number 3 in a tab-separated format):
errors.filter(_.contains("HDFS"))
      .map(_.split('\t')(3))
      .collect()

```

在第一个涉及`errors`的action执行后，Spark会将`errors`的分区保存在内存中，这样大大提高了随后对其的计算速度。需要注意的是，基RDD `lines`没有被载入到RAM中。因为错误信息可能仅占数据的一小部分（小到足够放入内存中），所以这样是合理的。

最后，为了阐明我们的模型如何实现容错，我们在**图1**中展示了第三个查询的谱系图。在该查询中，我们从基于`lines`上过滤器的结果`errors`开始，在运行*collect*前对其应用更多的*filter*和*map*。Spark的调度器会后续的两个变换流水线化，并向持有`errors`分区缓存的结点发送一系列任务来对计算它们。另外，如果`errors`的一个分区丢失，Spark会通过仅对其响应的`lines`的分区应用`filter`来重建这一分区。

![图1 我们的例子中第三个查询的谱系图。方框表示RDD，箭头表示变换](figure-1.png "图1 我们的例子中第三个查询的谱系图。方框表示RDD，箭头表示变换")

### 2.3 RDD模型的优势

为了理解作为分布式内存抽象（distributed memory abstraction）的RDD模型的好处，我们在**表1**中将其与分布式共享内存（distributed shared memory，DSM）进行了对比。在DSM系统中，应用程序可以读写全局地址空间的任意位置。主要注意的是，在该定义下，不寂寞包括了传统的共享内存系统<sup>[24]</sup>，还包括应用程序对共享状态进行细粒度写入的系统，这类系统包括Piccolo<sup>[27]</sup>，其提供了共享的DHT（Distributed Hash Table）和分布式数据库。DSM是一种非常通用的抽象，但是它的通用性使其很难以在商用集群上实现高性能和容错能力。

<table style="text-align:center;">
  <tr>
    <th colspan=3>表1 RDD与DSM的对比</th>
  </tr>
  <tr>
    <th>方面</th>
    <th>RDD</th>
    <th>DSM</th>
  </tr>
  <tr>
    <td>读</td>
    <td>粗粒度或细粒度</td>
    <td>细粒度</td>
  </tr>
  <tr>
    <td>写</td>
    <td>粗粒度</td>
    <td>细粒度</td>
  </tr>
  <tr>
    <td>一致性</td>
    <td>不重要（不可变）</td>
    <td>取决于app或runtime</td>
  </tr>
  <tr>
    <td>故障恢复</td>
    <td>细粒度且使用谱系图额外开销较小</td>
    <td>需要检查点和程序回滚</td>
  </tr>
  <tr>
    <td>掉队者缓解</td>
    <td>可通过任务备份实现</td>
    <td>难</td>
  </tr>
  <tr>
    <td>任务位置选择</td>
    <td>基于数据位置自动化</td>
    <td>取决于app（runtime目标为透明性）</td>
  </tr>
  <tr>
    <td>没有足够RAM的行为</td>
    <td>类似现有的数据流系统</td>
    <td>性能低（使用swap？）</td>
  </tr>
</table>

RDD和DSM的主要区别是，RDD只能通过粗粒度的变换创建（“写入”），而DSM允许对每个内存位置进行读写。<sup>注3</sup>这将RDD的使用限制在执行批量写入的应用程序中，但也使其能够进行更高效的容错。在实际情况下，RDD不需要承担检查点的开销，因为其可通过谱系图恢复。<sup>注4</sup>除此之外，在故障发生时，RDD中仅丢失的分区需要被重新计算且它们可以在不同节点上并行地重新计算，不需要回滚整个程序。

> 注3：需要注意的是，RDD的读操作仍可以使细粒度的。例如，应用程序将RDD当做大型只读查找表来对待。

> 注4：在一些应用程序中，其仍可以对谱系图链较长的RDD创建检查点，我们将在[章节5.4](#54-)中讨论。然而，因为RDD是不可变的，这一操作可造后台执行，并且不需要像DSM一样对整个应用程序进行快照。

RDD的第二个好处是它们本身不可变的性质让系统能够通过备份较慢的任务的方式缓解较慢的结点（掉队者），就像MapReduce中的那样<sup>[10]</sup>。备份任务在DSM中很难实现，因为一个任务的两份副本会访问内存中相同的位置，并干扰彼此的更新。

最后，RDD还比DSM多提供了两个好处。第一，对于RDD中的批量操作，运行时可以基于数据位置来调度任务以提高性能。第二，当没有足够内存来保存RDD时，只要它仅会被基于扫描的操作使用，那么它就可以优雅地降级（degrade）。RAM放不下的分区可被保存在磁盘中，并将提供与当前的并行数据系统相似的性能表现。

### 2.4 不适用于RDD的应用程序

正如引言中讨论的那样，RDD最适合对数据集中所有元素应用相同操作的的批处理程序。在这些情况下，RDD可以将每一次变换作为谱系图中的一步来高效地记住它们，并在不需要记录当量数据的情况下恢复丢失的分区。RDD不太适用于对共享状态进行细粒度的一不更新，例如为Web应用程序或增量Web爬虫设计的存储系统。对于这些应用程序，使用执行传统的更新日志和数据检查点的系统会更高效，如数据库、RAMCloud<sup>[25]</sup>、Percolator<sup>[26]</sup>和Piccolo<sup>[27]</sup>。我们的目标是为批量分析提供高效的编程模型，将异步应用程序的问题留给专用的系统解决。

## 3. Spark编程接口

Spark在Scala<sup>[2]</sup>（一种运行在Java VM上的静态类型函数式编程语言）中提供了类似DryadLINQ<sup>[31]</sup>的RDD抽象的语言继承的API。我们选择Scala的原因是其集简介（便于交互式使用）和高效（因为其采用静态类型）于一身。然而， RDD的抽象并不一定需要函数式语言。

为了使用Spark，开发者需要编写一个连接集群中worker的驱动程序，如**图2**中所示。该驱动程序定义了一个或多个RDD和在RDD智商的变换。驱动程序中的Spark代码还会追踪RDD的谱系图。worker是长久存在的进程，它们可以将操涉及的RDD分区存储在RAM中。

![图2 Spark Runtime。用户的驱动程序启动了多个worker，worker从分布式文件系统中读取数据块并将计算出的RDD分区在内存中持久保存。](figure-2.png "图2 Spark Runtime。用户的驱动程序启动了多个worker，worker从分布式文件系统中读取数据块并将计算出的RDD分区在内存中持久保存。")

正如我们在[章节2.2.1](#221-)中的日志挖掘样例一样，用户提供通过传递闭包（字面函数，function literals）的方式为像*map*之类的RDD操作提供参数。Scala将每个闭包表示为一个Java对象，这些对象可被序列化，以通过网络床底该闭包并在另一个节点上载入。Scala还会将任何绑定在闭包中的变量作为Java对象的字段保存。例如，用户可以编写如`var x=5; rdd.map(_ + x)`的代码来将RDD中的每个元素加5.<sup>注5</sup>

> 我们在每个闭包被创建时保存，因此在这个*map*的例子中，尽管$x$改变了，也会被加5。

RDD本身是由元素类型确定的静态类型对象。例如，`RDD[Int]`是整型的RDD。然而，我们大部分的例子都省略的类型，因为Scala支持类型推断。

尽管我们在Scala中暴露RDD的方法从概念上讲很简单，我们还是=不得不使用反射<sup>[33]</sup>来处理Scala闭包对象的相关问题。我们还需要更多的工作来使Spark在Scala解释器中可用，这将在[章节5.2](#52-)中讨论。尽管如此，我们仍不必修改Scala编译器。

### 3.1 Spark中的RDD操作

**表2**列出了Spark中可用的主要的RDD变换和aciton。我们给出了每个操作的签名，在方括号中给出了参数类型。变换是定义一个新的RDD的懒式操作，而action会启动计算以向程序返回值或将数据写入外部存储。

需要注意的是，有些操作（如*join*）仅在RDD的键值对上可用。另外，我们的选择的函数名与其他Scala中的API和其他函数式语言相匹配。例如，*map*是一个一对一的映射，而*flatMap*会将每个输入值映射为一个或多个输出（类似于MapReduce中的*map*）。

除了这些操作外，用户来可以请求持久化RDD。另外，用户可以获取RDD分区顺序，它通过Partitioner类表示，用户可以根据它对另一个数据集进行分区。如*groupByKey*、*reduceByKey*、*sort*等操作会自动地产生按哈希或范围分区的RDD。

![表2 Spark中可用的RDD变换和aciton。Seq[T]表示一个类型的T的元素序列。](table-2.png "表2 Spark中可用的RDD变换和aciton。Seq[T]表示一个类型的T的元素序列。")

### 3.2 应用程序样例

我们用两个迭代式应用程序补充了[章节2.2.1](#221-)中的数据挖掘样例：逻辑回归和PageRank。后者还展示了如何控制RDD的分区来提高性能。

#### 3.2.1 逻辑回归

许多机器学习算法本身就是迭代式的，因为它们运行如梯度下降法等迭代优化生成器以获得最大化的函数。因此。如果将数据保存在内存中，它们可以运行的快得多。

作为一个样例，如下的程序实现了逻辑回归<sup>[14]</sup>，逻辑回归是一种通用的分类算法，其寻找一个能够最佳划分两个点集（如垃圾邮件与非垃圾邮件）的超平面$w$。该算法使用梯度下降法：$w$从一个随机值开始，在每一轮迭代中，会对$w$的函数求和，以使$w$向更优的方向移动。

```scala

val points = spark.textFile(...)
                  .map(parsePoint).persist()
var w = // random initial vector
for (i <- 1 to ITERATIONS) {
  val gradient = points.map{ p =>
    p.x * (1/(1+exp(-p.y*(w dot p.x)))-1)*p.y
  }.reduce((a,b) => a+b)
  w -= gradient
}

```

我们从定义一个持久化的RDD `points`开始，它是在文本文件上使用*map*变换的结果，*map*变换将文本的每一行解析为一个`Point`对象。接下来，我们对`points`循环执行*map*和*reduce*来对当前$w$的函数求和，进而计算每一步的梯度。在多次迭代间，将`points`保存在内存中可以得到20倍的速度提升，正如我们在[章节6.1](#61-)中展示的那样。

#### 3.2.2 PageRank

在PageRank<sup>[6]</sup>中有更复杂的数据共享模式。PageRank算法对每个文档，迭代地累加其他链接到它的文档的贡献值，来更新该文档的rank值。在每一轮迭代中，每个文档向与它相邻的文档发送$\frac{r}{n}$的贡献值，其中$r$是它的rank，$n$是与它相邻的文档数。接下来，更新其rank值到$ \alpha / N + ( 1 - \alpha ) \sum c_i$，其中$ \sum c_i $是其收到的贡献值的和，$N$是其收到来自其他文档贡献值的文档数。我们可以在Spark中按如下方式编写PageRank：

```scala

// Load graph as an RDD of (URL, outlinks) pairs
val links = spark.textFile(...).map(...).persist()
var ranks = // RDD of (URL, rank) pairs
for (i <- 1 to ITERATIONS) {
  // Build an RDD of (targetURL, float) pairs
  // with the contributions sent bu each page
  val contribs = links.join(ranks).flatMap {
    (url, (links, rank)) => 
      links.map(dest => (dest, rank/links.size))
  }
  // Sum contributions by URL and get new ranks
  ranks = contribs.reduceByKey((x,y) => x+y)
                  .mapValues(sum => a/N + (1-a)*sum)
}

```

这个程序的RDD谱系图如**图3**所示。在每轮迭代中，我们基于上一轮迭代的`contribs`和`ranks`和静态的`lnks`数据集创建了一个新的`ranks`数据集。<sup>注6</sup>该图的一个有趣的特征是，随着迭代次数的增加，该图会越来越长。因此，在有许多次迭代地任务中，有必要可靠地备份`ranks`的某些版本，以减少故障恢复次数<sup>[20]</sup>。用户通过一个`RELIABLE`标识符调用*persist*来实现这一点。然而，需要注意的是，`links`数据集不需要被备份，因为它的分区可通过在输入文件的块上重跑*map*来高效地重建。通常情况下，这个数据集要比`ranks`大得多，因为每个文档中有许多连接，但每个文档仅有它自己的一个rank值，所以采用谱系图的方式对其进行恢复比对程序在内存中的整个状态设置检查点会节省更多系统时间。

> 注6：需要注意的是，尽管RDD是不可变的，程序中的`ranks`和`contribs`变量在每轮迭代中都指向不同的RDD。

![图3 PageRank中数据集的谱系图](figure-3.png "图3 PageRank中数据集的谱系图")

最后，我们可以通过控制RDD的分区方式来优化PageRank中的通信。如果我们为`links`指定一个分区方式（例如，将link的列表基于哈希算法在节点间分区），我们可以将`ranks`采用同样的方式分区，以保证对`links`和`ranks`的*join*操作不需要进行通信（因为每个URL的rank将于其link的列表在相同的机器上）。我们还可以编写一个自定义的Partitioner类对互相链接的页面进行分组（例如按照域名分区）这两种优化都可以在我们定义`links`时通过调用*partitionBy*来表达：

```scala

links = spark.textFile(...).map(...)
             .partitionsBy(myPartFunc).persist()

```

在这次最初的调用后，`links`和`ranks`间的*join*操作会自动地将给每个URL的贡献聚合到该link所在的机器上，计算其新的rank值，并将改值加入到它的link中。这种迭代间的一致分区方式是类似Pregel的专用框架的主要优化方式之一。RDD让用户能够直接地表达这一目标。

## 4. RDD的表示

将RDD作为一种抽象提供的挑战之一是为其选择一种可以在大量的变换中追踪谱系图的表示法。在理想情况下，实现RDD的系统需要提供尽可能多的变换操作（如**表2**中的操作），且允许用户以任意方式组合这些操作。我们提出了一个简单的基于图的RDD表示法，其实现了这些目标。我们在Spark中使用了这种表示法，以在不为每一个调度器添加特殊逻辑的情况下支持大量变换，这大大简化了系统设计。

简而言之，我们提出了一种能够通过通用的结构来表示每个RDD的方式，其暴露了5种信息：分区的集合，分区是数据集的原子单位；对父RDD的依赖的集合；一个基于其父数据集计算该数据集的函数；分区策略和数据放置位置的元数据。例如，有一个表示HDFS文件的RDD，其对该文件的每个块都有一个分区，且知道每个块在哪台机器上。同时，该RDD上的*map*操作结果的分区与该RDD相同，在计算该RDD的元素时，会对其父级数据应用*map*函数。我们在**表3**中总结了这些接口。

<table style="text-align:center;">
  <tr>
    <th colspan=2>表3 Spark中用来表示RDD的接口</th>
  </tr>
  <tr>
    <th>操作</th>
    <th>含义</th>
  </tr>
  <tr>
    <td>partitions()</td>
    <td>返回Partition对象的列表</td>
  </tr>
  <tr>
    <td>preferredLocations(<i>p</i>)</td>
    <td>列出<i>p</i>因数据位置而可被快速访问的结点</td>
  </tr>
  <tr>
    <td>dependencies()</td>
    <td>返回依赖的列表</td>
  </tr>
  <tr>
    <td>iterator(<i>p</i>,<i>parentIters</i>)</td>
    <td>给定对其父分区上的迭代器，计算分区<i>p</i>的元素</td>
  </tr>
  <tr>
    <td>partitioner()</td>
    <td>返回用来指定RDD是通过哈希还是范围分区的元数据</td>
  </tr>
</table>