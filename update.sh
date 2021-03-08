#!/bin/bash

# VARS
BASEDIR=$(cd $(dirname "${BASH_SOURCE[0]}") >/dev/null && pwd)

# FUN
UPDATE(){
    cd ${BASEDIR}

    # UPDATE RAW BLOG
    git add .
    git commit -m "update"
    git push origin master

    # UPDATE GENERATED BLOG
    # coding page
    cd ${BASEDIR}
    rm -r build/coding/*
    hugo --baseURL=https://blog.mrcroxx.com --destination=build/coding
    cd build/coding
    git add .
    git commit -m "update"
    git push origin master

    # github page
    cd ${BASEDIR}
    rm -r build/github/*
    hugo --baseURL=https://mrcroxx.github.io --destination=build/github
    cd build/github
    git add .
    git commit -m "update"
    git push origin master
}

REFRESH(){
    cd ${BASEDIR}
    git checkout master
    if git fetch -v --dry-run 2>&1 | grep 'master' | grep -q 'up to date'; then
        echo 'Stale master branch detected, pull from remote...'
        git pull origin master
    fi

    echo 'remove local build dir...'
    rm -rf ${BASEDIR}/build
    mkdir ${BASEDIR}/build
    
    echo 'clone build dir from remote...'
    cd ${BASEDIR}/build
    git clone git@github.com:MrCroxx/mrcroxx.github.io.git github
    git clone git@e.coding.net:croxx-dev/blog.git coding
    
    echo 'done.'
}

# ENTRY POINT
while getopts "r" OPT; do
    case $OPT in
        r) REFRESH; exit 0;;
    esac
done
UPDATE
