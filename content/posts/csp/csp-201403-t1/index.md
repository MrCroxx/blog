---
title: "CSP 201403 T1 相反数"
date: 2019-07-30T13:36:30+08:00
draft: false
categories: ["CCF CSP"]
tags: ["CCF CSP","Algorithm"]
featuredImage: img/ccf-csp.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

# CCF CSP 201403 T1 相反数

## 题目

### 问题描述

有 N 个非零且各不相同的整数。请你编一个程序求出它们中有多少对相反数(a 和 -a 为一对相反数)。

### 输入格式

第一行包含一个正整数 N。(1 ≤ N ≤ 500)。

第二行为 N 个用单个空格隔开的非零整数,每个数的绝对值不超过1000,保证这些整数各不相同。

### 输出格式

只输出一个整数,即这 N 个数中包含多少对相反数。

### 样例输入

    5
    1 2 3 -1 -2

### 样例输出

	2

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
