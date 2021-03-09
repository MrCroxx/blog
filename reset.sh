#!/bin/bash

# VARS
BASEDIR=$(cd $(dirname "${BASH_SOURCE[0]}") >/dev/null && pwd)

RESET(){
    cd ${BASEDIR}

    echo 'reset build...'

    echo 'remove local build dir...'
    rm -rf ${BASEDIR}/build
    mkdir ${BASEDIR}/build
    
    echo 'clone build dir from remote...'
    cd ${BASEDIR}/build
    git clone git@github.com:MrCroxx/mrcroxx.github.io.git github
    git clone git@e.coding.net:croxx-dev/blog.git coding
    
    echo 'done.'
}

RESET