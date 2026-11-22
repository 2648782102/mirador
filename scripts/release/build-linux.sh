#!/bin/sh
# Builds the prebuilt Linux archive of the checked-out commit, as the release workflow runs it:
#   BUILD_IMAGE=almalinux:8 sh scripts/release/build-linux.sh <version> <x64|arm64> <node-dir> <out-dir>
# <node-dir> is the official Node tarball that fetch-node.sh checked and unpacked. It writes
# <out-dir>/mirador-<version>-linux-<arch>.tar.gz: one folder of that name holding
#   - Mirador's committed sources as they are (bin, src, public, docs, package.json, the lockfile, ...),
#     with no bundling and no compile step: the server runs its TypeScript with Node's type stripping;
#   - node_modules with the lockfile's production dependencies (pnpm install --prod --frozen-lockfile, no
#     install scripts), then node-pty built from its sources inside BUILD_IMAGE, a glibc 2.28 container,
#     against the bundled Node's headers, with the other platforms' prebuilds removed;
#   - node/bin/node and node/LICENSE from the official tarball, which bin/mirador runs before any other Node.
# It runs on a runner of the archive's architecture (no cross-compiling) and needs git, pnpm, docker, and
# network access for pnpm and the container's packages. Every file in the archive is owned by 0:0 and dated
# at the commit.
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: BUILD_IMAGE=<image> build-linux.sh <version> <x64|arm64> <node-dir> <out-dir>" >&2
  exit 2
fi
version="$1"
arch="$2"
case "$arch" in
  x64 | arm64) ;;
  *)
    echo "build-linux.sh: unknown architecture $arch" >&2
    exit 2
    ;;
esac
node_dir="$(cd "$3" && pwd -P)"
mkdir -p "$4"
out="$(cd "$4" && pwd -P)"
image="${BUILD_IMAGE:?BUILD_IMAGE names the glibc 2.28 build container}"
repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
name="mirador-$version-linux-$arch"

work="$(mktemp -d)"
stage="$work/$name"
mkdir "$stage"

# The sources, exactly as committed at HEAD. Tests, CI files and maintainer scripts stay out.
git -C "$repo" archive --format=tar HEAD -- \
  bin src public docs package.json pnpm-lock.yaml pnpm-workspace.yaml config.example.json \
  LICENSE NOTICE README.md CHANGELOG.md SECURITY.md |
  tar -xf - -C "$stage"

# Production dependencies only, as the lockfile pins them. No package runs an install script here: node-pty
# is built below, in the container, and esbuild's postinstall stays off as in pnpm-workspace.yaml. Files are
# copied rather than linked from pnpm's store, so the container can build inside node-pty's folder.
(cd "$stage" && pnpm install --frozen-lockfile --prod --ignore-scripts --config.package-import-method=copy)

mkdir -p "$stage/node/bin"
cp "$node_dir/bin/node" "$stage/node/bin/node"
cp "$node_dir/LICENSE" "$stage/node/LICENSE"

docker run --rm \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$repo/scripts/release:/release:ro" \
  -v "$node_dir:/node:ro" \
  -v "$stage:/stage" \
  "$image" sh /release/build-in-container.sh

epoch="$(git -C "$repo" log -1 --format=%ct HEAD)"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" -C "$work" -cf - "$name" | gzip -n -9 >"$out/$name.tar.gz"
echo "build-linux.sh: wrote $out/$name.tar.gz"
