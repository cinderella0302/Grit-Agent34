#!/bin/bash

BASE_BRANCH=arc/generation
COUNT=2

for i in $(seq 1 $COUNT); do
  BRANCH="arc/generation-$i"

  git checkout $BASE_BRANCH
  git pull

  git checkout -b $BRANCH

  # 🔧 Make your modification (example)
  echo "task branch $i" >> README.md

  git add .
  git commit -m "Update prompt for filelist check $i"

  git push -u origin $BRANCH

  # Clean up (optional)
  # git checkout $BASE_BRANCH
  # git branch -D $BRANCH
done