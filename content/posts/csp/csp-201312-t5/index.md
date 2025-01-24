---
title: "CSP 201312 T5 I'm stuck!"
date: 2019-07-10T15:10:30+08:00
draft: false
categories: ["CCF CSP"]
tags: ["CCF CSP","Algorithm"]
math: true
featuredImage: img/ccf-csp.jpg
---

*本文为原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

# CCF CSP 201312 T5 I'm stuck!

## 题目

### **问题描述**

给定一个R行C列的地图，地图的每一个方格可能是'#', '+', '-', '|', '.', 'S', 'T'七个字符中的一个，分别表示如下意思：

- '#': 任何时候玩家都不能移动到此方格；
- '+': 当玩家到达这一方格后，下一步可以向上下左右四个方向相邻的任意一个非'#'方格移动一格；
- '-': 当玩家到达这一方格后，下一步可以向左右两个方向相邻的一个非'#'方格移动一格；
- '|': 当玩家到达这一方格后，下一步可以向上下两个方向相邻的一个非'#'方格移动一格；
- '.': 当玩家到达这一方格后，下一步只能向下移动一格。如果下面相邻的方格为'#'，则玩家不能再移动；
- 'S': 玩家的初始位置，地图中只会有一个初始位置。玩家到达这一方格后，下一步可以向上下左右四个方向相邻的任意一个非'#'方格移动一格；
- 'T': 玩家的目标位置，地图中只会有一个目标位置。玩家到达这一方格后，可以选择完成任务，也可以选择不完成任务继续移动。如果继续移动下一步可以向上下左右四个方向相邻的任意一个非'#'方格移动一格。

此外，玩家不能移动出地图。

请找出满足下面两个性质的方格个数：

1. 玩家可以从初始位置移动到此方格；
2. 玩家**不**可以从此方格移动到目标位置。

1. 它的数字只包含0, 1, 2, 3，且这四个数字都出现过至少一次。
2. 所有的0都出现在所有的1之前，而所有的2都出现在所有的3之前。
3. 最高位数字不为0。

因此，符合我们定义的最小的有趣的数是2013。除此以外，4位的有趣的数还有两个：2031和2301。

请计算恰好有n位的有趣的数的个数。由于答案可能非常大，只需要输出答案除以1000000007的余数。

### 输入格式

输入的第一行包括两个整数R 和C，分别表示地图的行和列数。(1 ≤ R, C ≤ 50)。

接下来的R行每行都包含C个字符。它们表示地图的格子。地图上恰好有一个'S'和一个'T'。

### 输出格式

如果玩家在初始位置就已经不能到达终点了，就输出“I'm stuck!”（不含双引号）。否则的话，输出满足性质的方格的个数。

### 样例输入

```
5 5
--+-+
..|#.
..|##
S-+-T
####.
```

### 样例输出

```
2
```

### 样例说明

如果把满足性质的方格在地图上用'X'标记出来的话，地图如下所示：

```
--+-+
..|#X
..|##
S-+-T
####X
```

### 时间限制

```
1.0s
```

### 内存限制

```
256.0MB
```

## 题解

小模拟题。

按照规则正向遍历再反向遍历即可。

$$ \lbrace \text{满足性质的点集} \rbrace = \lbrace \text{正向遍历可达的点集} \rbrace - \lbrace \text{反向遍历可达的点集} \rbrace $$

需要注意的是，反向遍历时检查的是相邻点的类型而不是当前点。这样代码可能稍微有点复杂<del>( 比如下面我的 )</del>，可能直接写成图能更好复用代码一点。

## 代码

```c++
#include <iostream>
#include <queue>
#include <vector>
#include <cstring>
#include <set>

#define N 55

using namespace std;
struct pos
{
    int r, c;
    bool operator<(const pos &x) const
    {
        return (this->r == x.r) ? (
                                      this->c < x.c)
                                : (
                                      this->r < x.r);
    }
};
struct forwR
{
    bool stuck;
};

char m[N][N];

set<pos> *forw(int r, int c, pos s, pos t)
{
    bool b[N][N];
    queue<pos> q;
    memset(b, 0, sizeof(b));
    while (!q.empty())
        q.pop();
    q.push(s);
    b[s.r][s.c] = true;
    while (!q.empty())
    {
        pos cur = q.front();
        q.pop();

        vector<pos> rp;
        rp.clear();

        switch (m[cur.r][cur.c])
        {
        case '+':
        case 'S':
        case 'T':
            rp = {
                {0, -1},
                {0, 1},
                {-1, 0},
                {1, 0}};
            break;
        case '-':
            rp = {
                {0, -1}, {0, 1}};
            break;
        case '|':
            rp = {
                {1, 0}, {-1, 0}};
            break;
        case '.':
            rp = {
                {1, 0}};
            break;
        }
        for (pos dp : rp)
            if (m[cur.r + dp.r][cur.c + dp.c] != '#' && !b[cur.r + dp.r][cur.c + dp.c])
            {
                q.push(pos{cur.r + dp.r, cur.c + dp.c});
                b[cur.r + dp.r][cur.c + dp.c] = true;
            }
    }

    if (!b[t.r][t.c])
        return NULL;

    set<pos> *result = new set<pos>();
    result->clear();
    for (int ir = 1; ir <= r; ir++)
    {
        for (int ic = 1; ic <= c; ic++)
        {
            if (b[ir][ic])
                result->insert(pos{ir, ic});
        }
    }
    return result;
}

set<pos> rev(int r, int c, pos s)
{
    bool b[N][N];
    queue<pos> q;
    memset(b, 0, sizeof(b));
    while (!q.empty())
        q.pop();
    q.push(s);
    b[s.r][s.c] = true;
    while (!q.empty())
    {
        pos cur = q.front();
        q.pop();
        if (!b[cur.r - 1][cur.c] && (m[cur.r - 1][cur.c] == '.' || m[cur.r - 1][cur.c] == '|' || m[cur.r - 1][cur.c] == '+' || m[cur.r - 1][cur.c] == 'S' || m[cur.r - 1][cur.c] == 'T'))
        {
            q.push({cur.r - 1, cur.c});
            b[cur.r - 1][cur.c] = true;
        }
        if (!b[cur.r + 1][cur.c] && (m[cur.r + 1][cur.c] == '|' || m[cur.r + 1][cur.c] == '+' || m[cur.r + 1][cur.c] == 'S' || m[cur.r + 1][cur.c] == 'T'))
        {
            q.push({cur.r + 1, cur.c});
            b[cur.r + 1][cur.c] = true;
        }
        if (!b[cur.r][cur.c - 1] && (m[cur.r][cur.c - 1] == '-' || m[cur.r][cur.c - 1] == '+' || m[cur.r][cur.c - 1] == 'S' || m[cur.r][cur.c - 1] == 'T'))
        {
            q.push({cur.r, cur.c - 1});
            b[cur.r][cur.c - 1] = true;
        }
        if (!b[cur.r][cur.c + 1] && (m[cur.r][cur.c + 1] == '-' || m[cur.r][cur.c + 1] == '+' || m[cur.r][cur.c + 1] == 'S' || m[cur.r][cur.c + 1] == 'T'))
        {
            q.push({cur.r, cur.c + 1});
            b[cur.r][cur.c + 1] = true;
        }
    }
    set<pos> result;
    result.clear();
    for (int i = 1; i <= r; i++)
        for (int j = 1; j <= c; j++)
        {
            if (b[i][j])
                result.insert({i, j});
        }
    return result;
}

int main()
{
    int r, c;
    cin >> r >> c;
    pos s, t;
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++)
        {
            m[i][j] = '#';
        }

    for (int i = 1; i <= r; i++)
        for (int j = 1; j <= c; j++)
        {
            cin >> m[i][j];
            if (m[i][j] == 'S')
                s = pos{i, j};
            else if (m[i][j] == 'T')
                t = pos{i, j};
        }

    set<pos> *pre = forw(r, c, s, t);
    if (pre == NULL)
    {
        cout << "I'm stuck!";
        return 0;
    }

    set<pos> post = rev(r, c, t);
    int ans = 0;
    for (pos p : *pre)
    {

        if (post.find(p) == end(post))
            ans++;
    }
    cout << ans;
    return 0;
}
```
