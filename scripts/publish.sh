#!/usr/bin/env bash
# Publish the dashboard and its data to the gh-pages branch.
#
# That branch is both the website and the datastore: the next run reads its
# state back out of it. It is rebuilt as a single fresh commit and force-pushed
# every time, so the repository does not grow by a megabyte of JSON every five
# minutes.
#
# Expects GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.
set -euo pipefail

rm -rf _site
mkdir _site
cp -r site/. _site/
cp -r data _site/data
# Keep Pages' Jekyll step from swallowing anything.
touch _site/.nojekyll

cd _site
git init -q -b gh-pages
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "data $(date -u +%FT%TZ)"
git push -q --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" gh-pages
cd ..

echo "published $(date -u +%H:%M:%SZ)"
