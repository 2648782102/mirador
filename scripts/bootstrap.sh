#!/bin/sh
{ trap '[ "${started:-}" = 1 ] || { echo "bootstrap.sh: this copy of the script is incomplete (the download was cut short), so nothing ran; download it again" >&2; exit 1; }' EXIT; }
# Mirador bootstrap, meant for: curl -fsSL https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh | sh
# Read it before running it. It clones Mirador into ${XDG_DATA_HOME:-~/.local/share}/mirador (or
# fast-forwards that clone when it has no local changes), then runs the clone's install.sh with the
# arguments given (curl ... | sh -s -- --root ~/code), from the folder you ran this in, so the paths
# install.sh prints are full ones. It never runs sudo; install.sh only says how to install what is
# missing. POSIX sh: `sh` may be dash.
#
# A download cut short hands sh only part of this file, so nothing runs before the last line: the trap
# above, set first, says the copy is incomplete whenever sh ends before main has started. Everything else
# is inside main, and the last line calls it in a brace group: a copy cut anywhere in that line ends in a
# syntax error (an unclosed group or quote) or before main is called, never in a call with part of its
# arguments. Both lines are braced so that no part of them runs: only a cut within the shebang or right
# after it ends sh without that message, still running nothing.

main() {
  started=1
  set -eu
  repo="${MIRADOR_REPO_URL:-https://github.com/mata-2p/mirador.git}"
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/mirador"

  if [ "$(id -u)" = 0 ]; then
    echo "bootstrap.sh: do not run this as root (or with sudo); run it as your own user, Mirador installs into your home folder" >&2
    exit 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    # The clone, and with it install.sh's own hints, does not exist yet: name the package manager on PATH.
    hint="see https://git-scm.com/downloads"
    if [ "$(uname -s)" = Darwin ]; then
      hint="install it with: xcode-select --install"
    elif command -v pacman >/dev/null 2>&1; then
      hint="install it with: sudo pacman -S git"
    elif command -v apt-get >/dev/null 2>&1; then
      hint="install it with: sudo apt install git"
    elif command -v dnf >/dev/null 2>&1; then
      hint="install it with: sudo dnf install git"
    elif command -v zypper >/dev/null 2>&1; then
      hint="install it with: sudo zypper install git"
    fi
    echo "bootstrap.sh: missing git (it downloads Mirador); $hint" >&2
    exit 1
  fi

  if [ -d "$dir/.git" ]; then
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      echo "bootstrap.sh: $dir has local changes, so it was not updated; commit or discard them to update" >&2
    else
      echo "bootstrap.sh: updating $dir (git pull --ff-only)"
      git -C "$dir" pull --ff-only
    fi
  elif [ -e "$dir" ]; then
    echo "bootstrap.sh: $dir exists and is not a git clone of Mirador; move it away, then run this again" >&2
    exit 1
  else
    echo "bootstrap.sh: cloning $repo into $dir"
    mkdir -p "$(dirname "$dir")"
    if ! git clone --quiet "$repo" "$dir"; then
      echo "bootstrap.sh: could not download Mirador from $repo (git clone failed, see above); nothing was installed" >&2
      exit 1
    fi
  fi

  exec "$dir/install.sh" "$@"
}

{ main "$@"; }
