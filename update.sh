#!/bin/bash

BASEDIR=$(cd $(dirname "${BASH_SOURCE[0]}") >/dev/null && pwd)

cd ${BASEDIR}

# UPDATE RAW BLOG

git add .
git commit -m "update"
git push origin master


# UPDATE GENERATED BLOG
# coding
rm -r build/coding/*
hugo --baseURL=https://blog.mrcroxx.com --destination=build/coding
cd build/coding
git add .
git commit -m "update"
git push origin master