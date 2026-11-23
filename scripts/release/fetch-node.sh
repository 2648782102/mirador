#!/bin/sh
# Downloads the official Node binary for Linux <arch> from nodejs.org and checks it before unpacking it:
#   sh scripts/release/fetch-node.sh <node-version> <x64|arm64> <pinned-sha256> <out-dir>
# It fetches node-v<version>-linux-<arch>.tar.xz from https://nodejs.org/dist/v<version>/ and unpacks it into
# <out-dir>/node-v<version>-linux-<arch> only when its sha256 is <pinned-sha256>, the one committed beside
# NODE_VERSION in .github/workflows/release.yml (NODE_SHA256_LINUX_X64, NODE_SHA256_LINUX_ARM64). The
# SHASUMS256.txt that nodejs.org serves beside the tarball is not read: whoever could swap the tarball could
# swap it too, so it would only prove the download is whole. The pinned sum was read from the signed
# SHASUMS256.txt when NODE_VERSION was last changed (docs/releasing.md). The release workflow bundles that
# node binary and builds node-pty against its headers. Over HTTPS only.
set -eu

usage() {
  echo "usage: fetch-node.sh <node-version, such as 24.22.3> <x64|arm64> <pinned sha256 of its tarball> <out-dir>" >&2
  exit 2
}

[ "$#" -eq 4 ] || usage
version="$1"
arch="$2"
pinned="$3"
out="$4"
printf '%s\n' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' || usage
case "$arch" in x64 | arm64) ;; *) usage ;; esac

base="https://nodejs.org/dist/v$version"
name="node-v$version-linux-$arch"
if ! printf '%s\n' "$pinned" | grep -Eqx '[0-9a-f]{64}' || [ "$(printf '%s\n' "$pinned" | wc -l)" -ne 1 ]; then
  echo "fetch-node.sh: no pinned sha256 for $name.tar.xz (\"$pinned\" is not 64 lowercase hex digits); nothing was downloaded" >&2
  exit 1
fi

mkdir -p "$out"
curl -fsSL --proto '=https' --tlsv1.2 -o "$out/$name.tar.xz" "$base/$name.tar.xz"
actual="$(sha256sum "$out/$name.tar.xz")"
actual="${actual%% *}"
if [ "$actual" != "$pinned" ]; then
  rm -f "$out/$name.tar.xz"
  echo "fetch-node.sh: $name.tar.xz does not match its pinned sha256 (expected $pinned, got $actual); nothing was unpacked" >&2
  exit 1
fi
tar -xJf "$out/$name.tar.xz" -C "$out"
rm -f "$out/$name.tar.xz"
echo "fetch-node.sh: $name.tar.xz matches its pinned sha256 $pinned; unpacked it into $out/$name"
