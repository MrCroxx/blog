---
title: "LeetCode题解——（1）两数之和"
date: 2020-09-15T09:53:30+08:00
lastmod: 2020-09-15T09:53:52+08:00
draft: false
keywords: []
description: ""
categories: ["LeetCode"]
author: ""
resources:
- name: featured-image
  src: leetcode.jpg
---

*原创文章，转载请严格遵守[CC BY-NC-SA协议](https://creativecommons.org/licenses/by-nc-sa/4.0/)。*

<!--more-->

## 1. 题目

[题目链接](https://leetcode-cn.com/problems/two-sum/submissions/)

## 2. 题解

### 2.1 暴力算法

本题暴力算法比较简单，时间复杂度为$O(n^2)$，不再详细讨论。

### 2.2 基于排序的算法

本题假设有且仅有一组解。

那么对输入数组排序。注意，由于本题要求输出满足条件的元素下标，因此基于排序的算法需要记录元素原位置。

设`l`、`r`分别为初始位置为数组`nums`首尾的指针，其中`l`从左向右扫描，`r`从右向左扫描。如果`nums[l]+nums[r]==target`，那么`l`、`r`指向的元素的原下标即为解；如果`nums[l]+nums[r]<target`，说明当前组合和和比`target`小，只有增大`l`才能使等式成立；如果`nums[l]+nums[r]>target`，说明当前组合和和比`target`大，只有减小`r`才能使等式成立。循环这一个过程直到找到符合条件的解。算法时间复杂度为$O( n \log n)$

注意，本题得到的`l`和`r`不是本题的解，其对应的原位下标才是本题的解。

```cpp

#include<algorithm>
#include<vector>

using namespace std;

class node {
public:
    int x,i;
    bool operator<(const node & other){
        if(this->x<other.x) return true;
        else return false;
    }
    node(int x, int i):x(x),i(i){}
};

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        vector<node> nodes = vector<node>();
        int i=0;
        for(auto it=nums.begin();it!=nums.end();it++){
            nodes.push_back(node(*it,i));
            i++;
        }
        sort(nodes.begin(),nodes.end());
        int l=0,r=nodes.size()-1,s;
        while((s=nodes[l].x+nodes[r].x)!=target) {
            if(s<target)l++;
            else r--;
        }            
        return vector<int>{nodes[l].i,nodes[r].i};   
    }
};

```

```rust

use std::cmp::Ordering;

struct Node{
    v:i32,
    i:i32
}

impl Solution {
    pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> {
        
        let mut nodes = Vec::new();

        for (i,x) in nums.iter().enumerate() {
            nodes.push(Node{
                v:*x,
                i:i as i32,
            })
        }

        nodes.sort_by(|a, b| a.v.cmp(&b.v));

        let mut l : i32 = 0;
        let mut r : i32 = ( nodes.len() as i32 ) - 1;

        loop{
            match (nodes[l as usize].v + nodes[r as usize].v).cmp(&target) {
                Ordering::Equal => break,
                Ordering::Less => l = l + 1,
                Ordering::Greater => r = r - 1, 
            }
        }

        vec![nodes[l as usize].i,nodes[r as usize].i]
    }
}

```

### 2.3 基于哈希的算法

通过哈希表记录映射：` (v) -> (v的下标)`。遍历数组`nums`，对于下标为`i`的元素`x`，如果哈希表中有键为`target - x`的映射，那么`i`、映射`target - x`的值（即元素`target - x`的下标）即为本题的解。如果哈希表插入和查询的时间复杂度为$O(1)$，那么该算法的时间复杂度为$O(n)$。

```cpp

#include<algorithm>
#include<vector>
#include<unordered_map>

using namespace std;

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int,int> m ={};
        int i=0;
        for (const auto &x : nums){
            i++;
            if(m[target-x])return vector<int>{m[target-x]-1,i-1};
            m[x] = i;
        }
        return vector<int>{0,0};
    }
};

```

```rust

use std::collections::HashMap;

impl Solution {
    pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> {

        let mut m:HashMap<i32,i32> = HashMap::new();
        let mut ans = vec![0,0];

        for (i,x) in nums.iter().enumerate() {
            match m.get(&(target-x)) {
                Some(pos) => {
                    ans[0] = *pos;
                    ans[1] = i as i32;
                    break;
                },
                None => {
                    m.insert(*x,i as i32);
                },
            }
        }
       ans
    }
}

```