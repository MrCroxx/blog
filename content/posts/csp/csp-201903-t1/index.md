---
title: "CSP 201903 T1 小中大"
date: 2019-08-12T13:36:30+08:00
draft: true
categories: ["CCF CSP"]
tags: ["CCF CSP","Algorithm"]
featuredImage: img/ccf-csp.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

# CSP 201903 T1 小中大

## 题目

### 题目背景

在数据分析中，最小值、最大值以及中位数是常用的统计信息。

### 题目描述

老师给了你n个整数组成的测量数据，保证有序（可能为升序或降序），可能存在重复的数据。请统计出这组测量数据中的最大值、中位数以及最小值，并按照从大到小的顺序输出这三个数。

### 输入格式

从标准输入读入数据。

第一行输入一个整数n，在第二行中存在n个有序的整数，表示测量数据，可能为升序或降序排列，可能存在连续多个整数相等，整数与整数之间使用空格隔开。

### 输出格式

输出到标准输出。

包含一行，包括最大值、中位数以及最小值共三个数，并按照从大到小的顺序输出。数据与数据之间使用空格隔开。对于整数请直接输出整数，对于可能出现的分数，请输出四舍五入保留1位小数的结果。

### 样例1输入

    3
    -1 2 4

### 样例1输出

	4 2 -1

### 样例2输入

    4
    -2 -1 3 4

### 样例2输出

	4 1 -2

### 子任务

<table>
    <tr>
        <th>测试点</th>
        <th>n</th>
        <th>测量数据的绝对值</th>
        <th>测量数据是否均相同</th>
    </tr>
    <tr>
        <td>1,2</td>
        <td rowspan="2">$\leq 10^3$</td>
        <td rowspan="4">$\leq 10^7$</td>
        <td>是</td>
    </tr>
    <tr>
        <td>3,4,5,6</td>
        <td>否</td>
    </tr>
</table>

### 时间限制

	1.0s

### 内存限制

	256.0MB

## 题解

用set存出现过的数，如果找到相反数答案+1。

## 代码

```c++
#include <iostream>
#include <set>

using namespace std;

set<int> all;

int main()
{
    int n, x, ans = 0;
    all.clear();
    cin >> n;
    while (n--)
    {
        cin >> x;
        all.insert(x);
        if (all.find(-x) != end(all))
            ans++;
    }
    cout << ans;
    return 0;
}
```

