#!/bin/sh
# Prints the pin lines of scripts/bootstrap.sh for a release, from that release's SHA256SUMS:
#   sh scripts/release/pins.sh <version> <SHA256SUMS>
# The release workflow puts them in the draft release's notes; the promotion PR to main pastes them in place
# of the three pin lines at the top of bootstrap.sh's main. An archive missing from SHA256SUMS gets an empty
# pin, so its platform keeps installing from source.
set -eu

if [ "$#" -ne 2 ] || [ ! -f "$2" ]; then
  echo "usage: pins.sh <version> <SHA256SUMS>" >&2
  exit 2
fi
version="$1"
sums="$2"

# The sha256 that SHA256SUMS lists for <archive>, or nothing.
sum_of() {
  awk -v name="$1" '$2 == name || $2 == "*" name { print $1; exit }' "$sums"
}

printf '  MIRADOR_VERSION="%s"\n' "$version"
printf '  MIRADOR_SHA256_LINUX_X64="%s"\n' "$(sum_of "mirador-$version-linux-x64.tar.gz")"
printf '  MIRADOR_SHA256_LINUX_ARM64="%s"\n' "$(sum_of "mirador-$version-linux-arm64.tar.gz")"
