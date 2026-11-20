#!/usr/bin/env bash
# The official export check: rebuilds the public repository from
# `git archive HEAD` and proves it works for a stranger. Run it from the repository root:
#   pnpm run export:check            (bash scripts/export-check.sh [--online])
# Steps, in a fresh `mktemp -d` folder:
#   1. extract `git archive HEAD`, then `git init -b main` and one commit with a neutral identity;
#   2. `pnpm install --frozen-lockfile`, offline by default: the caller's pnpm store (`pnpm store path`)
#      and a scratch cache that holds only the lockfile packages' metadata, copied read-only from the
#      caller's pnpm cache. --online lets pnpm reach the registry instead;
#   3. `pnpm test`, `pnpm run typecheck:src`, `pnpm run doctor`, the private-data scan
#      (scripts/export-scan.ts on the extracted repository) and the task-name check
#      (scripts/export-task-names.ts: the file names under this repository's task folder at HEAD, each
#      looked for in the extracted repository with or without a path; each hit is listed as file:line;
#      where HEAD has no task folder, as in the public repository, it lists none and says so).
# Every step after the archive runs under `env -i`, with a scratch HOME and XDG folders, the caller's
# PATH, LANG=C.UTF-8, DISABLE_AUTOUPDATER=1 and MIRADOR_SCOPES=0, so the real HOME is never touched.
# Time limits per step (timeout or gtimeout, when present): install 900 s, test 1800 s,
# typecheck:src 600 s, doctor 120 s, scan 300 s, task names 300 s; a step that reaches it reports "timed out".
# It checks the committed HEAD, not uncommitted changes. Exit 0 only when every step passes; the
# scratch folder is removed then, and kept (with each step's log) when anything fails.
set -uo pipefail

online=0
for arg in "$@"; do
  case $arg in
    --online) online=1 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "usage: bash scripts/export-check.sh [--online]" >&2
      exit 2
      ;;
  esac
done

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2

scratch=$(mktemp -d "${TMPDIR:-/tmp}/mirador-export-check-XXXXXX") || exit 2
repo="$scratch/repo"
logs="$scratch/logs"
mkdir -p "$repo" "$logs" "$scratch/home" "$scratch/config" "$scratch/state" "$scratch/data" "$scratch/cache"

clean_env=(env -i
  "HOME=$scratch/home"
  "XDG_CONFIG_HOME=$scratch/config"
  "XDG_STATE_HOME=$scratch/state"
  "XDG_DATA_HOME=$scratch/data"
  "XDG_CACHE_HOME=$scratch/cache"
  "PATH=$PATH"
  LANG=C.UTF-8
  DISABLE_AUTOUPDATER=1
  MIRADOR_SCOPES=0)
git_env=(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  GIT_AUTHOR_NAME='Export Check' GIT_AUTHOR_EMAIL=export-check@example.invalid
  GIT_COMMITTER_NAME='Export Check' GIT_COMMITTER_EMAIL=export-check@example.invalid)

head=$(git rev-parse --short HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)
failed=0
declare -A code=()

fail_early() {
  echo "export check: $1; kept $scratch" >&2
  exit 1
}

# 1. The simulated public repository.
git archive --format=tar HEAD | tar -x -C "$repo" || fail_early "git archive HEAD | tar -x failed"
(cd "$repo" && "${clean_env[@]}" "${git_env[@]}" git init -q -b main &&
  "${clean_env[@]}" "${git_env[@]}" git add -A &&
  "${clean_env[@]}" "${git_env[@]}" git commit -q -m 'Initial commit') >"$logs/git.log" 2>&1 ||
  fail_early "git init and commit failed (see $logs/git.log)"
tracked=$(git -C "$repo" ls-files | wc -l | tr -d ' ')
commits=$(git -C "$repo" rev-list --count HEAD)

# 2. Install. Offline, pnpm needs the registry metadata of every locked package in its cache.
install_args=(install --frozen-lockfile)
if [ "$online" -eq 0 ]; then
  store=$(pnpm store path 2>/dev/null) || fail_early "pnpm store path failed"
  cache=$(pnpm config get cache-dir 2>/dev/null)
  if [ -z "$cache" ] || [ "$cache" = undefined ]; then
    if [ "$(uname -s)" = Darwin ]; then cache="$HOME/Library/Caches/pnpm"; else cache="${XDG_CACHE_HOME:-$HOME/.cache}/pnpm"; fi
  fi
  names=$(sed -n '/^packages:/,/^snapshots:/p' pnpm-lock.yaml | grep -E '^  [^ ]' |
    sed -E "s/^  '?//; s/'?:[[:space:]]*\$//; s/^(@?[^@]+)@.*/\1/" | sort -u)
  copied=0
  for meta in "$cache"/v*/metadata*/*/; do
    [ -d "$meta" ] || continue
    rel=${meta#"$cache/"}
    for name in $names; do
      for file in "$meta$name.jsonl" "$meta$name.json"; do
        [ -f "$file" ] || continue
        mkdir -p "$(dirname "$scratch/cache/pnpm/$rel$name")"
        cp "$file" "$scratch/cache/pnpm/$rel${file#"$meta"}" && copied=$((copied + 1))
      done
    done
  done
  install_args+=(--offline --store-dir "$store")
  install_note="offline, store $store, $copied metadata files from $cache"
else
  install_note=online
fi

# A hung step cannot run forever: each one has a time limit. coreutils `timeout` signals the step's
# whole process group, so the test runner's children stop too; 124 means the limit was reached.
limiter=$(command -v timeout || command -v gtimeout || true)
declare -A shown=()
step() {
  local name=$1 seconds=$2
  shift 2
  if [ -n "$limiter" ]; then
    (cd "$repo" && "$limiter" --kill-after=30 "$seconds" "${clean_env[@]}" "$@") >"$logs/$name.log" 2>&1
  else
    (cd "$repo" && "${clean_env[@]}" "$@") >"$logs/$name.log" 2>&1
  fi
  code[$name]=$?
  case ${code[$name]} in
    0) shown[$name]='exit 0' ;;
    124 | 137) shown[$name]="timed out after ${seconds}s (exit ${code[$name]})" ;;
    *) shown[$name]="exit ${code[$name]}" ;;
  esac
  [ "${code[$name]}" -eq 0 ] || failed=1
}

step install 900 pnpm "${install_args[@]}"
if [ "${code[install]}" -eq 0 ]; then
  step test 1800 pnpm test
  step typecheck-src 600 pnpm run typecheck:src
  step doctor 120 pnpm run doctor
else
  for name in test typecheck-src doctor; do shown[$name]='not run'; done
fi
step scan 300 node scripts/export-scan.ts "$repo"
step task-names 300 node scripts/export-task-names.ts "$repo" "$root"

# Summary.
total() { sed -n -E "s/^ℹ $1 ([0-9]+)\$/\1/p" "$logs/test.log" 2>/dev/null | tail -n 1; }
doctor_line=$(grep -E '^(All required items are present|Missing required: )' "$logs/doctor.log" 2>/dev/null | tail -n 1)
scan_line=$(grep -E '^export scan: ' "$logs/scan.log" | tail -n 1)
names_line=$(grep -E '^task names: ' "$logs/task-names.log" | tail -n 1)
names_hits=$(grep -E '^[^[:space:]]+:[0-9]+: ' "$logs/task-names.log")

echo "export check: HEAD $head ($branch); the archive, not the working tree"
echo "  repository:    $tracked tracked files, $commits commit(s)"
echo "  install:       ${shown[install]} ($install_note)"
if [ -f "$logs/test.log" ]; then
  echo "  test:          ${shown[test]}; $(total tests) tests, $(total pass) pass, $(total fail) fail, $(total skipped) skipped, $(total todo) todo"
else
  echo "  test:          ${shown[test]}"
fi
echo "  typecheck:src: ${shown[typecheck-src]}"
echo "  doctor:        ${shown[doctor]}${doctor_line:+; $doctor_line}"
echo "  scan:          ${shown[scan]}; ${scan_line:-no summary line}"
echo "  task names:    ${shown[task-names]}; ${names_line:-no summary line}"
if [ -n "$names_hits" ]; then printf '%s\n' "$names_hits" | sed 's/^/    /'; fi
[ -n "$limiter" ] || echo "  note:          no timeout command found, so the steps ran without a time limit"
if [ -f "$logs/test.log" ]; then
  skips=$(sed -n -E 's/^[[:space:]]*﹣ .* \([0-9.]+m?s\) # (.*)$/\1/p' "$logs/test.log" | sort | uniq -c | sort -rn |
    awk '{ count = $1; sub(/^[[:space:]]*[0-9]+ /, ""); printf "    %4d  %s\n", count, $0 }')
  echo "  skipped, by reason:"
  if [ -n "$skips" ]; then printf '%s\n' "$skips"; else echo "    none"; fi
  failing=$(awk '
    /^✖ failing tests:/ { on = 1; next }
    on && /^test at / { file = $3; sub(/:[0-9]+:[0-9]+$/, "", file); next }
    on && /^[[:space:]]*✖ / { name = $0; sub(/^[[:space:]]*✖ /, "", name); sub(/ \([0-9.]+m?s\)$/, "", name); print file ": " name }
  ' "$logs/test.log")
  echo "  failing tests:"
  if [ -n "$failing" ]; then printf '%s\n' "$failing" | sed 's/^/    /'; else echo "    none"; fi
fi

if [ "$failed" -eq 0 ]; then
  rm -r -f -- "$scratch"
  echo "export check: passed; scratch folder removed"
  exit 0
fi
echo "export check: FAILED; kept $scratch (each step's log in $logs)"
exit 1
