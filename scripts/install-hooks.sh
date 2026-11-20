#!/bin/sh
# Installs scripts/hooks/pre-push into the hooks folder of the clone it runs in
# (`git rev-parse --git-path hooks`, which honours core.hooksPath). A maintainer step for the public
# clone, where odd/tasks/ and design/ stay private:
#   pnpm run hooks:install            (sh scripts/install-hooks.sh [--force])
# It refuses, unless --force, when a different pre-push hook is already there, and when HEAD still
# tracks a path under odd/tasks/ or design/: the hook would then reject every push. Running it again
# with the same hook installed changes nothing.
set -eu

force=0
for arg in "$@"; do
  case $arg in
    --force) force=1 ;;
    *)
      echo "usage: sh scripts/install-hooks.sh [--force]" >&2
      exit 2
      ;;
  esac
done

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
source_hook="$here/hooks/pre-push"
if [ ! -f "$source_hook" ]; then
  echo "install-hooks: $source_hook is missing" >&2
  exit 1
fi

top=$(git rev-parse --show-toplevel)
cd "$top"
hooks=$(git rev-parse --git-path hooks)
case $hooks in
  /*) ;;
  *) hooks="$top/$hooks" ;;
esac
target="$hooks/pre-push"

if [ "$force" -eq 0 ] && git rev-parse --verify -q HEAD >/dev/null; then
  if [ -n "$(git ls-tree -r --name-only HEAD -- odd/tasks design)" ]; then
    echo "install-hooks: this clone still tracks the private folders; install it in the public clone (--force installs it anyway)" >&2
    exit 1
  fi
fi

if [ -e "$target" ] && cmp -s "$source_hook" "$target"; then
  chmod +x "$target"
  echo "install-hooks: the pre-push hook is already installed at $target"
  exit 0
fi
if [ -e "$target" ] && [ "$force" -eq 0 ]; then
  echo "install-hooks: a different pre-push hook is already installed at $target; pass --force to replace it" >&2
  exit 1
fi

mkdir -p "$hooks"
cp "$source_hook" "$target"
chmod +x "$target"
echo "install-hooks: installed the pre-push hook at $target"
