---
title: "Task Failed Successfully: Saturating NIC and Disk Bandwidth"
date: "2026-06-18"
summary: "A journey from 'wonder how' to 'wonder why'."
categories: ["foyer"]
tags: ["System", "TLB", "RDMA", "io_uring"]
draft: true
---

## 0. "Task Failed Successfully"

The AI era has arrived faster than most of us expected. Agentic coding has completely changed the way I work day to day. To be honest, I haven’t written a single line of code at work in quite a while. Yes, it is true. ***NOT A SINGLE LINE!!*** And yet, that hasn't stopped the code from running across clusters with hundreds of HPC servers at the peak performce.

Of course, not writing code (or even not fully reviewing it) does not mean we are just randomly poking around, like *monkey typing*. We still need to analyze requirements, refine the design with the agent, build demos, run mock experiments, study the results from small-scale tests, iterate on the problems we find, and maintain a complete, solid testing process, blah blah blah.

![Monkey Typing](assets/monkey-typing.gif#max-width-360px "Monkey Typing")

However, with AI and agentic coding, everything has become faster. Sometimes, code is churned out faster than we can fully understand it. And sometims, it is even faster than AI can understand it. You, you read that right. And this post comes from one such example.

After I gave my agent the prompt to optimize the performance of my system, the AI quickly took the it from roughly half throughput to full saturation. But its explanation of why it worked was completely wrong. It was a classic case of ***task failed successfully***.

![Task Failed Successfully](assets/task-failed-successfully.jpg#max-width-360px "Task Failed Successfully")

This post doesn't talk about why the AI "failed successfully". It is a walkthrough of the analysis and debugging process behind this system performance optimization.

## 1. Optimize a demo with one NIC and 8 disks

Let's turn the system into a simple abstraction to foucus on the performance optimization rather than the complex business:

A single thread issues 1 MiB random reads across 8 NVMe drives, then sends the data to a remote host via RDMA WRITE.

In more detail, each drive can deliver up to 7 GiB/s of read throughput, and the NIC provides 400 Gb/s of network bandwidth. All devices are attached to the same NUMA node. The worker thread is pinned to a non-CPU0 core. The host runs with the IOMMU in passthrough mode, and none of the I/O devices involved are translated through the IOMMU.

































***TBC ... ...***

## X. "A Planet Upside Down"

In fact, my work should have been done as soon as the AI finished the initial performance optimization. Ironically, figuring out why the optimization worked ended up taking far more of my own time than the original task itself. As AI models become more capable, they can build surprisingly good systems even without a real understanding of the underlying principles.

But digging into those principles has always been one of my small obsessions as a programmer. In the flood of AI, it may also be one of the ways I keep myself from slipping into a sense of meaninglessness.

To close, I want to share a few lines from a song I’ve been listening to lately. A toast to everyone still trying to stay grounded in this era.

> You used to wonder why, 
> 
> but now you wonder how.
>
> ...
> 
> But you're still trying hard to understand,
> 
> to comprehend,
> 
> to wrap your head around
> 
> all the things that don't make sense,
> 
>  that don't mix in
> 
> a planet upside down.
>
> --- A Planet Upside Down (Pearl & The Oysters)


![A Planet Upside Down](assets/a-planet-upside-down.png#rounded-30px#p80 "A Planet Upside Down - Pearl & The Oysters")