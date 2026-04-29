#!/bin/bash

BASE_BRANCH=arc/generation

git checkout $BASE_BRANCH
git pull

sed -i '41a\
".txt", ".log", ".log.gz", ".log.bz2", ".log.xz", ".log.tar", ".log.tar.gz", ".log.tar.bz2", ".log.tar.xz",\
	".sql", ".sql.gz", ".sql.bz2", ".sql.xz", ".sql.tar", ".sql.tar.gz", ".sql.tar.bz2", ".sql.tar.xz",\
' agent/packages/coding-agent/src/core/system-prompt.ts
git add .
git commit -m "Updated important file"

git push -u origin $BASE_BRANCH
