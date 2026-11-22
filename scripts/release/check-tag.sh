#!/bin/sh
# Checks that a release tag names the version in package.json, and prints that version:
#   sh scripts/release/check-tag.sh <tag> <package.json>
# A tag is v<major>.<minor>.<patch>, optionally with a pre-release suffix (v0.2.0-rc.1). It runs before any
# build, so a mistyped tag, or one pushed before package.json was bumped, builds nothing.
set -eu

tag="${1-}"
pkg="${2:-package.json}"

if ! printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' || [ "$(printf '%s\n' "$tag" | wc -l)" -ne 1 ]; then
  echo "check-tag.sh: \"$tag\" is not a release tag (v<major>.<minor>.<patch>, such as v0.2.0)" >&2
  exit 1
fi
version="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version))' "$pkg")"
if [ "v$version" != "$tag" ]; then
  echo "check-tag.sh: tag $tag does not match package.json's version $version; bump the version in package.json (and CHANGELOG.md) first" >&2
  exit 1
fi
echo "$version"
