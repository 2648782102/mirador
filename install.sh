#!/usr/bin/env bash
# Mirador installer, run from the clone: checks what Mirador needs and says how to
# install what is missing (it never runs sudo or installs system packages or Node),
# then installs the dependencies, creates the config when there is none, runs
# pnpm run doctor (Mirador's, not pnpm's builtin doctor) and, on Linux, adds the launcher.
set -euo pipefail
unset CDPATH

usage() {
  cat <<'EOF'
usage: ./install.sh [--root <dir>]

Checks what Mirador needs, installs its dependencies with pnpm, creates
~/.config/mirador/config.json when there is none yet, runs pnpm run doctor and,
on Linux, adds the mirador launcher. It never runs sudo and never installs
system packages or Node.

  --root <dir>  the workspace folder written in a new config
  -h, --help    show this help
EOF
}

root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --root)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "install.sh: --root needs a folder" >&2
        usage >&2
        exit 2
      fi
      root="$2"
      shift 2
      ;;
    *)
      echo "install.sh: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -n "$root" ]; then
  if [ ! -d "$root" ]; then
    echo "install.sh: --root $root is not a folder" >&2
    exit 2
  fi
  root="$(cd -- "$root" && pwd -P)"
fi
start_dir="$(pwd -P)"

os="$(uname -s)"
case "$os" in
  Linux | Darwin) ;;
  *)
    echo "install.sh: $os is not supported; Mirador runs on Linux, macOS (experimental) and WSL2" >&2
    exit 1
    ;;
esac

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# How to run this installer again: ./install.sh from the clone, else its full path (the bootstrap runs it
# from your folder, not the clone's).
if [ "$start_dir" = "$app_dir" ]; then
  again="./install.sh"
else
  again="$app_dir/install.sh"
fi
# Under WSL a clone on a Windows drive (/mnt/<letter>) is reached through a slow bridge.
wsl=0
if [ "$os" = Linux ]; then
  case "$(uname -r)" in
    *[Mm]icrosoft*)
      wsl=1
      case "$app_dir/" in
        "${MIRADOR_WSL_DRIVES:-/mnt}"/[a-z]/*)
          echo "install.sh: warning: this clone is on a Windows drive ($app_dir); under WSL its files go through a slow bridge, so installing, building node-pty and loading Mirador are much slower. Clone it in your Linux home instead: git clone https://github.com/mata-2p/mirador.git ~/mirador" >&2
          ;;
      esac
      ;;
  esac
fi
# Linux without a display: not WSL, DISPLAY and WAYLAND_DISPLAY unset or empty. bin/mirador then prints a
# one-time link instead of opening a window (open_window there), so a missing browser is only a warning,
# as it is only informative in doctor (noDisplay in src/doctor.ts); keep the three tests in step.
no_display=0
if [ "$os" = Linux ] && [ "$wsl" = 0 ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  no_display=1
fi

# The os-release ID, then ID_LIKE, on one line; empty without an os-release.
os_release_words() {
  local os_release="${MIRADOR_OS_RELEASE:-/etc/os-release}" key value id="" like=""
  if [ -r "$os_release" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
      value="${value#[\"\']}"
      value="${value%[\"\']}"
      case "$key" in
        ID) id="$value" ;;
        ID_LIKE) like="$value" ;;
      esac
    done <"$os_release"
  fi
  echo "$id $like"
}

# The package manager whose commands the hints show: brew on macOS, on Linux the
# os-release family (ID, then ID_LIKE) or else the first one on PATH; none prints links.
package_manager() {
  if [ "$os" = Darwin ]; then
    if command -v brew >/dev/null; then echo brew; fi
    return 0
  fi
  local word words
  read -ra words <<<"$(os_release_words)"
  for word in "${words[@]}"; do
    case "$word" in
      arch) echo pacman && return 0 ;;
      debian | ubuntu) echo apt && return 0 ;;
      fedora | rhel) echo dnf && return 0 ;;
      opensuse* | suse) echo zypper && return 0 ;;
    esac
  done
  for word in pacman apt-get dnf zypper; do
    if command -v "$word" >/dev/null; then
      [ "$word" = apt-get ] && word=apt
      echo "$word"
      return 0
    fi
  done
}

# The command that installs <item> with the package manager, or nothing when none is known.
# apt, dnf and zypper get pnpm 12 (the major CI installs the lockfile with) through corepack (shipped
# with Node 24) when it is there, else mise. Ubuntu's chromium is a snap; Debian's is a package.
install_command() {
  case "$pm:$1" in
    pacman:node) echo "sudo pacman -S nodejs" ;;
    pacman:pnpm) echo "sudo pacman -S pnpm" ;;
    pacman:python3) echo "sudo pacman -S python" ;;
    pacman:make) echo "sudo pacman -S make" ;;
    pacman:cxx) echo "sudo pacman -S gcc" ;;
    apt:python3 | apt:make) echo "sudo apt install $1" ;;
    apt:cxx) echo "sudo apt install g++" ;;
    dnf:python3 | dnf:make) echo "sudo dnf install $1" ;;
    dnf:cxx) echo "sudo dnf install gcc-c++" ;;
    zypper:python3 | zypper:make) echo "sudo zypper install $1" ;;
    zypper:cxx) echo "sudo zypper install gcc-c++" ;;
    apt:pnpm | dnf:pnpm | zypper:pnpm)
      if command -v corepack >/dev/null; then echo "corepack enable pnpm && corepack install -g pnpm@12"; else echo "mise use -g pnpm@12"; fi
      ;;
    pacman:browser) echo "sudo pacman -S chromium" ;;
    apt:browser)
      case "$(os_release_words)" in
        "ubuntu "*) echo "sudo snap install chromium" ;;
        *) echo "sudo apt install chromium" ;;
      esac
      ;;
    dnf:browser) echo "sudo dnf install chromium" ;;
    zypper:browser) echo "sudo zypper install chromium" ;;
    brew:node) echo "brew install node" ;;
    brew:pnpm) echo "brew install pnpm" ;;
  esac
}

missing=0
apt_packages=""
apt_count=0
# missing <item> <what> <why> <link>: one line naming it, why Mirador needs it and how to install it.
# Node on Linux without a pacman command goes through mise; apt packages are collected for one command.
missing() {
  local command steps
  command="$(install_command "$1")"
  if [ -n "$command" ]; then
    echo "install.sh: missing $2 ($3); install it with: $command" >&2
    case "$command" in
      "sudo apt install "*)
        apt_packages="$apt_packages ${command#sudo apt install }"
        apt_count=$((apt_count + 1))
        ;;
    esac
  elif [ "$1" = node ] && [ "$os" = Linux ]; then
    if command -v mise >/dev/null; then
      steps="mise use -g node@24"
    else
      steps="curl https://mise.run | sh; echo 'eval \"\$(~/.local/bin/mise activate bash)\"' >> ~/.bashrc; then, in a new terminal: mise use -g node@24"
    fi
    echo "install.sh: missing $2 ($3); install it with mise: $steps (or see $4)" >&2
  else
    echo "install.sh: missing $2 ($3); see $4" >&2
  fi
  missing=1
}

# The Chromium-family browsers of doctor's BROWSERS list (src/doctor.ts), in its order; keep them in step.
browsers="chromium chromium-browser brave brave-browser google-chrome-stable google-chrome microsoft-edge-stable microsoft-edge vivaldi-stable vivaldi"

# doctor's browser check on Linux, in shell, for when no Node 24 can run doctor yet: the list above,
# under WSL wslview and powershell.exe, then xdg-open. It prints doctor's detail when none is found.
# It cannot read the config's browser (JSON needs Node), and a config only exists once Node has run.
shell_browser_check() {
  local name openers="$browsers"
  [ "$wsl" = 1 ] && openers="$openers wslview powershell.exe"
  for name in $openers xdg-open; do
    command -v "$name" >/dev/null && return 0
  done
  if [ "$wsl" = 1 ]; then
    echo "no Chromium-family browser (${browsers// /, }), wslview, powershell.exe or xdg-open on PATH"
  else
    echo "no Chromium-family browser (${browsers// /, }) and no xdg-open on PATH"
  fi
  return 1
}

pm="$(package_manager)"
node_why="Mirador runs its TypeScript sources with it"
node_link="https://nodejs.org/en/download"
node_ok=0
if ! command -v node >/dev/null; then
  missing node "Node 24 or newer" "$node_why" "$node_link"
else
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [ "$node_major" -ge 24 ] 2>/dev/null; then
    node_ok=1
  else
    missing node "Node 24 or newer, found $node_version" "$node_why" "$node_link"
  fi
fi
command -v pnpm >/dev/null || missing pnpm pnpm "it installs Mirador's dependencies" "https://pnpm.io/installation"
build_why="node-pty compiles with it"
build_link="https://github.com/nodejs/node-gyp#on-unix"
if [ "$os" = Linux ]; then
  command -v python3 >/dev/null || missing python3 python3 "$build_why" "$build_link"
  command -v make >/dev/null || missing make make "$build_why" "$build_link"
  command -v g++ >/dev/null || command -v c++ >/dev/null || missing cxx "a C++ compiler, g++ or c++" "$build_why" "$build_link"
  # doctor's own browser check (src/doctor.ts), before anything is installed; it needs Node 24 to run,
  # so without it the shell check above stands in, and the first round lists a missing browser too.
  # Either way, without a display a missing browser is a warning and the install goes on.
  # macOS always has open for a tab.
  if [ "$node_ok" = 1 ]; then
    browser_check=(node "$app_dir/src/doctor.ts" --browser)
  else
    browser_check=(shell_browser_check)
  fi
  browser_link="https://www.chromium.org/getting-involved/download-chromium/"
  if ! browser_found="$("${browser_check[@]}")"; then
    if [ "$no_display" = 1 ]; then
      browser_add="$(install_command browser)"
      if [ -n "$browser_add" ]; then browser_add="install it with: $browser_add"; else browser_add="see $browser_link"; fi
      echo "install.sh: warning: no browser found ($browser_found); this machine has no display (DISPLAY and WAYLAND_DISPLAY are unset), so mirador prints a one-time link to open in a browser elsewhere instead of a window; to add a browser anyway, $browser_add" >&2
    else
      missing browser "a browser" "Mirador opens in it; $browser_found" "$browser_link"
    fi
  fi
elif ! xcode-select -p >/dev/null 2>&1; then
  echo "install.sh: missing the Xcode Command Line Tools (node-pty compiles with them); install them with: xcode-select --install" >&2
  missing=1
fi
if [ "$missing" = 1 ]; then
  if [ "$apt_count" -ge 2 ]; then
    echo "install.sh: or install them all at once with: sudo apt install${apt_packages}" >&2
  fi
  echo "install.sh: nothing was changed; install what is missing, then run $again again" >&2
  exit 1
fi

cd "$app_dir"

echo "install.sh: installing the dependencies (pnpm install --frozen-lockfile)"
if ! pnpm install --frozen-lockfile; then
  echo "install.sh: pnpm install failed; see the output above" >&2
  exit 1
fi

config="${XDG_CONFIG_HOME:-$HOME/.config}/mirador/config.json"
if [ -e "$config" ] || [ -L "$config" ]; then
  if [ -n "$root" ]; then
    echo "install.sh: kept the existing config $config; --root was not applied to it"
  else
    echo "install.sh: kept the existing config $config"
  fi
else
  # Copies the example as is, but for the first workspace root when --root is given,
  # and prints the line holding that root and its value.
  read -r root_line root_value < <(node -e '
    const fs = require("fs");
    const path = require("path");
    const [example, target, root] = process.argv.slice(1);
    let text = fs.readFileSync(example, "utf8");
    const value = JSON.stringify(JSON.parse(text).workspaces[0].root);
    if (root) text = text.replace(value, () => JSON.stringify(root));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, { flag: "wx" });
    console.log(text.slice(0, text.indexOf(value)).split("\n").length, value);
  ' "$app_dir/config.example.json" "$config" "$root")
  if [ -n "$root" ]; then
    echo "install.sh: created $config with root $root"
  else
    echo "install.sh: created $config"
    echo "install.sh: set \"root\" on line $root_line of it to the full path of an existing folder of yours (~ is not expanded there); it is $root_value now"
  fi
fi

# `pnpm doctor` would run pnpm's own builtin command: Mirador's doctor is the package script.
echo "install.sh: checking the machine (pnpm run doctor)"
if ! pnpm run doctor; then
  echo "install.sh: pnpm run doctor found a problem; fix it, then run $again again" >&2
  exit 1
fi

if [ "$os" = Linux ]; then
  echo "install.sh: adding the launcher (bin/mirador install)"
  "$app_dir/bin/mirador" install
  # The link is only found as `mirador` when ~/.local/bin is on PATH; rc files are the user's to edit.
  case ":$PATH:" in
    *":$HOME/.local/bin:"* | *":$HOME/.local/bin/:"*) ;;
    *) echo 'install.sh: warning: ~/.local/bin is not on your PATH, so the mirador command is not found yet; add export PATH="$HOME/.local/bin:$PATH" to your shell rc (~/.bashrc or ~/.zshrc) and open a new terminal' >&2 ;;
  esac
fi

# Optional: Mirador runs without gentle-shell, pi and engram, with less; doctor's output above
# already says so, and these notes repeat it last. They never fail the install.
gentle_shell_link="https://github.com/Gentleman-Programming/gentle-shell"
if ! command -v gentle-shell >/dev/null; then
  echo "install.sh: note: gentle-shell is not on PATH, so Mirador runs in plain mode (one bash per folder, no memory views or night shift) unless gentle-ai is set up; install it from $gentle_shell_link" >&2
  if ! command -v pi >/dev/null; then
    echo "install.sh: note: neither pi nor gentle-shell, which starts it, is on PATH, so there is no pi agent; install gentle-shell from $gentle_shell_link" >&2
  fi
fi
# Engram gets doctor's own check (src/doctor.ts checkEngram), so the two never disagree: whether it
# answers at the config's engramUrl (127.0.0.1 by default), not whether engram is on PATH.
if ! engram_url="$(node "$app_dir/src/doctor.ts" --engram)"; then
  echo "install.sh: note: Engram does not answer at $engram_url, so memory views such as \"where it left off\" stay empty; start it with: engram serve (pnpm run doctor above says more)" >&2
fi

if [ "$start_dir" = "$app_dir" ]; then
  echo "install.sh: done; start Mirador with: bin/mirador"
else
  echo "install.sh: done; start Mirador with: $app_dir/bin/mirador"
fi
