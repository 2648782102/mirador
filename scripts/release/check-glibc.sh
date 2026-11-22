#!/bin/sh
# Checks that a built Linux addon needs no glibc newer than 2.28, the archives' baseline:
#   sh scripts/release/check-glibc.sh <file.node>
# It reads the GLIBC_x.y versions of the addon's dynamic symbols (objdump -T) and stops when the newest is
# above 2.28. An addon that names no glibc version at all cannot be checked, so that stops too.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: check-glibc.sh <file.node>" >&2
  exit 2
fi
file="$1"
base="${file##*/}"

if ! symbols="$(objdump -T "$file")"; then
  echo "check-glibc.sh: objdump -T could not read $base (see above), so its glibc baseline cannot be checked" >&2
  exit 1
fi
newest="$(printf '%s\n' "$symbols" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//; s/\.$//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
if [ -z "$newest" ]; then
  echo "check-glibc.sh: objdump -T lists no GLIBC_ symbol version in $base, so its glibc baseline cannot be checked; is it a Linux addon linked against glibc?" >&2
  exit 1
fi
major="${newest%%.*}"
minor="${newest#*.}"
minor="${minor%%.*}"
if [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -gt 28 ]; }; then
  echo "check-glibc.sh: $base needs glibc $newest, newer than 2.28" >&2
  exit 1
fi
echo "check-glibc.sh: $base needs glibc $newest at most"
