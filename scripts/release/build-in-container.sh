#!/bin/sh
# Runs inside the glibc 2.28 build container (BUILD_IMAGE, AlmaLinux 8), which build-linux.sh starts with
#   /stage    the archive's folder, its node_modules installed without install scripts (read-write);
#   /node     the official Node tarball that fetch-node.sh checked (read-only);
#   /release  this folder (read-only).
# It builds node-pty from its sources against /node's headers, with the node-gyp of /node's own npm, keeps
# only its Linux addon (build/Release/pty.node), then checks that the addon needs no glibc newer than 2.28 and
# that, on this old glibc, the bundled Node loads it, spawns a terminal with it and runs esbuild.
# Node 24's headers need C++20, newer than AlmaLinux 8's gcc 8 supports: gcc-toolset-12 builds against the
# system's own glibc and libstdc++ all the same. node-gyp needs Python 3.8 or newer: python3.11.
set -eu

# The files belong to the runner's user again once the container is done, whatever happened.
trap 'chown -R "$HOST_UID:$HOST_GID" /stage' EXIT

dnf -y -q install python3.11 make gcc-toolset-12-gcc-c++ binutils
toolset=/opt/rh/gcc-toolset-12/root/usr/bin
export CC="$toolset/gcc" CXX="$toolset/g++" PYTHON=python3.11 PATH="/node/bin:$PATH"

pty="$(readlink -f /stage/node_modules/node-pty)"
cd "$pty"
node /node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/node --jobs=max

# Only the Linux addon stays: no other platform's prebuilds, no Windows sources, no intermediate build files.
mv build/Release/pty.node /tmp/pty.node
for leftover in build prebuilds third_party deps; do
  if [ -e "$leftover" ]; then rm -r "$leftover"; fi
done
mkdir -p build/Release
mv /tmp/pty.node build/Release/pty.node

# Stops when the addon needs a glibc newer than 2.28, or names no glibc version at all.
sh /release/check-glibc.sh build/Release/pty.node

cd /stage
./node/bin/node -e '
  const pty = require("./node_modules/node-pty");
  const term = pty.spawn("/bin/echo", ["pty-ok"], {});
  let out = "";
  term.onData((d) => (out += d));
  term.onExit(({ exitCode }) => {
    if (exitCode !== 0 || !out.includes("pty-ok")) {
      console.error(`build-in-container.sh: node-pty spawned /bin/echo but got exit ${exitCode} and ${JSON.stringify(out)}`);
      process.exit(1);
    }
    console.log("build-in-container.sh: the bundled node loads node-pty and spawns a terminal");
  });
'
./node/bin/node -e '
  require("esbuild").transformSync("const a: number = 1", { loader: "ts" });
  console.log("build-in-container.sh: the bundled node runs esbuild");
'
