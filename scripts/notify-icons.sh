#!/usr/bin/env bash
# Regenerates the browser notification images from public/icon.svg (the Mirador mark), for
# public/features/inbox-notify.js. Mirador's own server serves them; the notification never
# fetches anything from another host.
# - public/notify-icon.png: the mark at 192 px, the notification's `icon`;
# - public/notify-badge.png: the mark's lines in white on transparent at 96 px, the `badge` Android
#   shows in its status bar (it reads only the alpha channel).
# Needs rsvg-convert (librsvg). Run it from anywhere after changing public/icon.svg, then commit
# both images.
set -euo pipefail
unset CDPATH

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
svg="$root/public/icon.svg"

rsvg-convert --width 192 --height 192 --output "$root/public/notify-icon.png" "$svg"
# The badge: no fills, every stroke white, so only the mark's lines are opaque.
sed -e 's/fill="#[0-9a-fA-F]\{3,6\}"/fill="none"/g' -e 's/stroke="#[0-9a-fA-F]\{3,6\}"/stroke="#ffffff"/g' "$svg" |
  rsvg-convert --width 96 --height 96 --output "$root/public/notify-badge.png"
