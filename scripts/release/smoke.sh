#!/bin/sh
# Checks a prebuilt Linux archive in clean containers, as the release workflow's smoke job runs it before publish:
#   sh scripts/release/smoke.sh <mirador-<version>-linux-<x64|arm64>.tar.gz> <image>...
# Each <image> (pinned by digest in release.yml: the oldest glibc the archives support and a current
# distribution) runs smoke-in-container.sh with docker, on a runner of the archive's architecture: no network,
# the runner's user, the archive and this folder mounted read-only. In there it unpacks the archive, runs its
# doctor, starts the server, checks that it answers and stops it. Every image is tried even when one fails.
# It prints the archive's size and each container's timings (unpack, doctor, server start) as a Markdown
# table, also appended to $GITHUB_STEP_SUMMARY when that is set, and exits 1 when any container failed.
set -eu

usage() {
  echo "usage: smoke.sh <mirador-<version>-linux-<x64|arm64>.tar.gz> <image>..." >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
archive="$1"
shift
file="${archive##*/}"
if [ ! -f "$archive" ] || ! printf '%s\n' "$file" | grep -Eqx 'mirador-[0-9][0-9A-Za-z.-]*-linux-(x64|arm64)\.tar\.gz'; then
  echo "smoke.sh: $archive is not a mirador-<version>-linux-<x64|arm64>.tar.gz file" >&2
  exit 2
fi
archive="$(cd "$(dirname "$archive")" && pwd -P)/$file"
release="$(cd "$(dirname "$0")" && pwd -P)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

bytes="$(wc -c <"$archive" | tr -d ' ')"
mib="$(awk -v bytes="$bytes" 'BEGIN { printf "%.1f", bytes / 1048576 }')"
{
  printf '### %s\n\nSize: %s MiB (%s bytes)\n\n' "$file" "$mib" "$bytes"
  echo '| Container | glibc | Unpack | Doctor | Server start | Result |'
  echo '| --- | --- | --- | --- | --- | --- |'
} >"$work/summary.md"

# The value of <key> that the container wrote in <result-file>, or "-".
value() {
  found="$(sed -n "s/^$1=\([0-9][0-9.]*\)\$/\1/p" "$2" 2>/dev/null | head -n 1 || true)"
  if [ -z "$found" ]; then echo -; else echo "$found$3"; fi
}

failed=0
run=0
for image in "$@"; do
  run=$((run + 1))
  out="$work/run-$run"
  mkdir "$out"
  status=0
  docker run --rm --init --network none --user "$(id -u):$(id -g)" -e HOME=/tmp/home \
    -v "$archive:/archive/$file:ro" -v "$release:/release:ro" -v "$out:/out" \
    "$image" sh /release/smoke-in-container.sh "/archive/$file" || status=$?
  if [ "$status" -eq 0 ]; then
    outcome=ok
  else
    outcome="failed (exit $status)"
    failed=1
    echo "smoke.sh: $file failed in ${image%@*} (exit $status); see its output above" >&2
  fi
  printf '| %s | %s | %s | %s | %s | %s |\n' "${image%@*}" "$(value glibc "$out/result" '')" \
    "$(value unpack_ms "$out/result" ' ms')" "$(value doctor_ms "$out/result" ' ms')" "$(value start_ms "$out/result" ' ms')" \
    "$outcome" >>"$work/summary.md"
done

echo
cat "$work/summary.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$work/summary.md" >>"$GITHUB_STEP_SUMMARY"; fi
exit "$failed"
