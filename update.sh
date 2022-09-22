#!/bin/bash

# VARS
BASEDIR=$(cd $(dirname "${BASH_SOURCE[0]}") >/dev/null && pwd)

# FUN
UPDATE(){
    cd ${BASEDIR}

    # UPDATE RAW BLOG
    git add .
    git commit -m "update"
    git push -u origin main

    # UPDATE GENERATED BLOG
    ## github page
    cd ${BASEDIR}
    rm -r build/github/*
    hugo --baseURL=https://mrcroxx.github.io --destination=build/github
    cp extra/* build/github/
    cd build/github
    git add .
    git commit -m "update"
    git push -u origin main
}

UPDATE
