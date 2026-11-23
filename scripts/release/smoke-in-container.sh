#!/bin/sh
# Runs inside each clean container of the release workflow's smoke job, which smoke.sh starts with
#   /archive/<file>  the archive to check (read-only);
#   /release         this folder (read-only);
#   /out             where it writes its result, one key=value per line: glibc, unpack_ms, doctor_ms, start_ms;
# as the runner's user, with HOME=/tmp/home and no network. The container must be clean: no Node, npm, pnpm,
# compiler or make on PATH, as on a user's machine that never built anything. It unpacks the archive, runs its
# doctor with the bundled Node, starts the server with bin/mirador (with no display it prints a one-time link
# instead of opening a window), checks that the server answers the page, the link's session and the API, and
# stops it with bin/mirador stop.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: smoke-in-container.sh /archive/<mirador-<version>-linux-<arch>.tar.gz>" >&2
  exit 2
fi
archive="$1"
file="${archive##*/}"
name="${file%.tar.gz}"

fail() {
  echo "smoke: $*" >&2
  exit 1
}
now_ms() { echo $(($(date +%s%N) / 1000000)); }
result() { printf '%s=%s\n' "$1" "$2" >>/out/result; }

for tool in node npm npx pnpm gcc cc g++ c++ clang make; do
  if found="$(command -v "$tool")"; then fail "this container is not clean: $tool is on PATH ($found)"; fi
done

glibc="$(getconf GNU_LIBC_VERSION)"
glibc="${glibc#glibc }"
result glibc "$glibc"
# shellcheck disable=SC1091 # the container's own os-release
distro="$(. /etc/os-release && echo "$PRETTY_NAME")"
echo "smoke: $file on $distro, glibc $glibc, $(uname -m)"

mkdir -p "$HOME" /tmp/smoke
start="$(now_ms)"
tar -xzf "$archive" -C /tmp/smoke
result unpack_ms "$(($(now_ms) - start))"
app="/tmp/smoke/$name"
[ -x "$app/bin/mirador" ] || fail "$file has no executable $name/bin/mirador"
[ -x "$app/node/bin/node" ] || fail "$file has no executable $name/node/bin/node"
cd "$app"

start="$(now_ms)"
./node/bin/node src/doctor.ts || fail "doctor reports a required item missing (see above)"
result doctor_ms "$(($(now_ms) - start))"

unset DISPLAY WAYLAND_DISPLAY
start="$(now_ms)"
launched="$(bin/mirador)" || fail "bin/mirador did not start the server (see above)"
result start_ms "$(($(now_ms) - start))"
echo "$launched"
link="$(printf '%s\n' "$launched" | grep -o 'http://127\.0\.0\.1:[0-9]*/#launch=[A-Za-z0-9_-]*' | head -n 1 || true)"
[ -n "$link" ] || fail "bin/mirador printed no one-time link"
bin/mirador status

# The page, then the session the link opens and the API behind it, as a browser would.
./node/bin/node -e '
  const link = new URL(process.argv[1]);
  const origin = link.origin;
  const check = async (what, response) => {
    if (!response.ok) throw new Error(`${what} answered ${response.status}: ${await response.text()}`);
    return response;
  };
  (async () => {
    const page = await check("GET /", await fetch(`${origin}/`));
    if (!(await page.text()).includes("<html")) throw new Error("GET / answered no HTML page");
    const nonce = link.hash.slice("#launch=".length);
    const session = await check("POST /api/session", await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    }));
    const { token } = await session.json();
    const boot = await check("GET /api/bootstrap", await fetch(`${origin}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } }));
    const body = await boot.json();
    if (!body.config || !body.workspaces) throw new Error(`GET /api/bootstrap answered ${JSON.stringify(body)}`);
    console.log("smoke: the server answers GET /, POST /api/session and GET /api/bootstrap");
  })().catch((error) => {
    console.error(`smoke: ${error.message}`);
    process.exit(1);
  });
' "$link" || {
  tail -n 40 "$HOME/.local/state/mirador/server.log" >&2 || true
  bin/mirador stop || true
  fail "the server does not answer (see above)"
}
bin/mirador stop
