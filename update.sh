#!/bin/bash

BASEDIR=$(cd $(dirname "${BASH_SOURCE[0]}") >/dev/null && pwd)
cd ${BASEDIR}
rm -r public/*
hugo
cd public
git add .
git commit -m "update"
git push origin master

