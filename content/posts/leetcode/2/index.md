---
title: "LeetCode题解——（2）两数相加"
date: 2020-09-15T11:33:50+08:00
lastmod: 2020-09-15T11:33:54+08:00
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

简单链表题，注意进位、较长链表、最后一次进位的处理。

```cpp

/**
 * Definition for singly-linked list.
 * struct ListNode {
 *     int val;
 *     ListNode *next;
 *     ListNode(int x) : val(x), next(NULL) {}
 * };
 */
class Solution {
public:
    ListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {
        
        ListNode* l3 = new ListNode(0,NULL);
        ListNode* h = new ListNode(0,NULL);
        ListNode* t = h;

        int ten=0;

        while(l1||l2){
            int s = ten;
            if(l1) s+=l1->val;
            if(l2) s+=l2->val;
            ten = s/10;
            s = s%10;
            t->next = new ListNode(s,NULL);
            t=t->next;
            if(l1)l1 = l1->next;
            if(l2)l2 = l2->next;
        }

        if(ten>0){
            t->next = new ListNode(1,NULL);
            t=t->next;
        }
        
        return h->next;
    }
};

```