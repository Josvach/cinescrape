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

# Stamp the script with a hash of its contents.
#
# `live.json` is fetched with a cache buster, so the numbers always arrive —
# but `app.js` was a plain <script src>, and Pages serves it with a max-age.
# A phone that had opened the page kept running the old code indefinitely: the
# dashboard showed Alpha 0.07 and a filmmaker-share tile hours after both had
# been removed, and no amount of re-running the ingest could fix it, because
# nothing about the data was wrong. Changing the URL whenever the file changes
# is what makes a deploy actually reach the reader.
APP_HASH=$(sha1sum _site/app.js | cut -c1-10)
sed -i "s|src=\"app.js\"|src=\"app.js?v=${APP_HASH}\"|" _site/index.html

cd _site
git init -q -b gh-pages
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "data $(date -u +%FT%TZ)"
git push -q --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" gh-pages
cd ..

echo "published $(date -u +%H:%M:%SZ)"
