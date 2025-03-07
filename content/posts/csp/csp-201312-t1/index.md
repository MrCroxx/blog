---
title: "CSP 201312 T1 出现次数最多的数"
date: 2019-07-10T15:10:30+08:00
draft: false
categories: ["CCF CSP"]
tags: ["CCF CSP","Algorithm"]
featuredImage: img/ccf-csp.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

# CCF CSP 201312 T1 出现次数最多的数

## 题目

### 问题描述

给定n个正整数，找出它们中出现次数最多的数。如果这样的数有多个，请输出其中最小的一个。

### 输入格式

输入的第一行只有一个正整数n(1 ≤ n ≤ 1000)，表示数字的个数。

输入的第二行有n个整数s1, s2, …, sn (1 ≤ si ≤ 10000, 1 ≤ i ≤ n)。相邻的数用空格分隔。

### 输出格式

输出这n个次数中出现次数最多的数。如果这样的数有多个，输出其中最小的一个。

### 样例输入

	6
	10 1 10 20 30 20

### 样例输出

	10

### 时间限制

	1.0s

### 内存限制

	256.0MB

## 题解

使用map统计数字出现次数。遍历map找到出现次数最多的最小的数即可。

## 代码

```c++
#include <iostream>
#include <map>

using namespace std;

map<int, int> cnt;

int main()
{
    int n;
    int maxcnt = 0, ans = 0;
    cnt.clear();
    cin >> n;
    while (n--)
    {
        int x;
        cin >> x;
        cnt[x]++;
        for (map<int, int>::iterator it = cnt.begin(); it != cnt.end(); it++)
        {
            if (it->second > maxcnt)
            {
                maxcnt = it->second;
                ans = it->first;
            }
            else if (it->second == maxcnt && it->first < ans)
            {
                ans = it->first;
            }
        }
    }
    cout << ans;
    return 0;
}
```

