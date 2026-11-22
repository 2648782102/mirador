#!/bin/sh
# Downloads the official Node binary for Linux <arch> from nodejs.org and checks it before unpacking it:
#   sh scripts/release/fetch-node.sh <node-version> <x64|arm64> <out-dir>
# It fetches SHASUMS256.txt and node-v<version>-linux-<arch>.tar.xz from https://nodejs.org/dist/v<version>/,
# and unpacks the tarball into <out-dir>/node-v<version>-linux-<arch> only when its sha256 is the one
# SHASUMS256.txt lists for it. The release workflow bundles that node binary and builds node-pty against its
# headers. Over HTTPS only.
set -eu

usage() {
  echo "usage: fetch-node.sh <node-version, such as 24.22.3> <x64|arm64> <out-dir>" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage
version="$1"
arch="$2"
out="$3"
printf '%s\n' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' || usage
case "$arch" in x64 | arm64) ;; *) usage ;; esac

base="https://nodejs.org/dist/v$version"
name="node-v$version-linux-$arch"
mkdir -p "$out"
fetch() {
  curl -fsSL --proto '=https' --tlsv1.2 -o "$out/$1" "$base/$1"
}

fetch SHASUMS256.txt
expected="$(awk -v name="$name.tar.xz" '$2 == name { print $1; exit }' "$out/SHASUMS256.txt")"
if [ -z "$expected" ]; then
  echo "fetch-node.sh: SHASUMS256.txt from $base has no line for $name.tar.xz; nothing was unpacked" >&2
  exit 1
fi
fetch "$name.tar.xz"
actual="$(sha256sum "$out/$name.tar.xz")"
actual="${actual%% *}"
if [ "$actual" != "$expected" ]; then
  rm -f "$out/$name.tar.xz"
  echo "fetch-node.sh: $name.tar.xz does not match its sha256 in SHASUMS256.txt (expected $expected, got $actual); nothing was unpacked" >&2
  exit 1
fi
tar -xJf "$out/$name.tar.xz" -C "$out"
rm -f "$out/$name.tar.xz"
echo "fetch-node.sh: $name.tar.xz matches its sha256 in SHASUMS256.txt; unpacked it into $out/$name"
