#!/usr/bin/env bash
# Mirador demo workspace, for the README screenshots and anyone who wants to try Mirador without
# pointing it at their own folders. Everything it creates lives in one target folder: three
# invented git projects, a harmless demo agent, a stand-in Engram with invented memories and a
# Mirador config that points only at them. It prints the commands that start the stand-in Engram
# and the server with HOME and every XDG folder inside the target, so the user's own config,
# Engram, agents and projects are never read or written. With --capture it also starts both,
# takes the README images with headless Chromium (over the DevTools protocol, with Node's
# built-in WebSocket: no dependency) and stops everything it started.
set -euo pipefail
unset CDPATH

usage() {
  cat <<'EOF'
usage: scripts/demo-workspace.sh [--port <n>] [--capture <dir>] [<target-dir>]

Creates an invented demo workspace for Mirador in <target-dir> (a new mktemp -d
folder when omitted; it must be new or empty): three fake git projects (acme-api,
acme-web, field-notes), a harmless demo agent, a stand-in Engram with invented
memories, and a Mirador config that points only at them. It prints the commands
that start the stand-in Engram and the server with HOME and every XDG folder
inside the target, so your own config, Engram and projects are never touched.

  --port <n>       the demo server port (default 4646); the stand-in Engram uses <n>+1
  --capture <dir>  also start both, take the README screenshots and the demo GIF with
                   headless Chromium into <dir> (needs chromium, brave or google-chrome,
                   and magick), then stop everything it started
  -h, --help       show this help
EOF
}

port=4646
capture=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --port)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      port="$2"
      shift 2
      ;;
    --capture)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      capture="$2"
      shift 2
      ;;
    -*)
      echo "demo-workspace.sh: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [ -z "$target" ] || { usage >&2; exit 2; }
      target="$1"
      shift
      ;;
  esac
done

case "$port" in
  '' | *[!0-9]*)
    echo "demo-workspace.sh: --port takes a number" >&2
    exit 2
    ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65534 ]; then
  echo "demo-workspace.sh: --port must be from 1024 to 65534" >&2
  exit 2
fi
engram_port=$((port + 1))

app_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

for tool in git node; do
  command -v "$tool" >/dev/null || { echo "demo-workspace.sh: missing $tool" >&2; exit 1; }
done

if [ -z "$target" ]; then
  target="$(mktemp -d "${TMPDIR:-/tmp}/mirador-demo.XXXXXX")"
elif [ -e "$target" ] && [ -n "$(ls -A "$target")" ]; then
  echo "demo-workspace.sh: $target is not empty; give a new or empty folder" >&2
  exit 1
fi
mkdir -p "$target"
target="$(cd "$target" && pwd -P)"

ws="$target/workspace"
home="$target/home"
run="$target/run"
bin="$target/bin"
mkdir -p "$ws" "$home/.config/mirador" "$home/.local/state" "$home/.local/share" "$home/.cache" "$bin"
mkdir -p -m 700 "$run"

# Git without the user's own config (identity, hooks, signing): only what is set here.
demo_git() {
  HOME="$home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git -c user.name='Demo User' -c user.email=demo@example.invalid -c init.defaultBranch=main -c commit.gpgsign=false "$@"
}

# project <name> <commit message>, with its files already written under $ws/<name>.
commit_project() {
  demo_git -C "$ws/$1" init -q
  demo_git -C "$ws/$1" add -A
  demo_git -C "$ws/$1" commit -q -m "$2"
}

mkdir -p "$ws/acme-api/src" "$ws/acme-web/src" "$ws/field-notes/notes"
cat >"$ws/acme-api/README.md" <<'EOF'
# acme-api

Orders and invoices API for the (invented) Acme store. Demo project for Mirador.
EOF
cat >"$ws/acme-api/src/orders.ts" <<'EOF'
export interface Order {
  id: string;
  total: number;
}

export function totalOf(orders: Order[]): number {
  return orders.reduce((sum, order) => sum + order.total, 0);
}
EOF
cat >"$ws/acme-api/package.json" <<'EOF'
{ "name": "acme-api", "private": true, "version": "0.3.0" }
EOF
commit_project acme-api 'feat: orders endpoint'

cat >"$ws/acme-web/README.md" <<'EOF'
# acme-web

Storefront for the (invented) Acme store. Demo project for Mirador.
EOF
cat >"$ws/acme-web/src/checkout.js" <<'EOF'
export function checkoutLabel(count) {
  return count === 1 ? '1 item' : `${count} items`;
}
EOF
cat >"$ws/acme-web/index.html" <<'EOF'
<!doctype html>
<title>Acme</title>
<script type="module" src="src/checkout.js"></script>
EOF
commit_project acme-web 'feat: checkout page'

cat >"$ws/field-notes/README.md" <<'EOF'
# field-notes

Research notes on bird counts along an (invented) river. Demo project for Mirador.
EOF
cat >"$ws/field-notes/notes/2026-week-45.md" <<'EOF'
# Week 45

- Herons at the north bend: 4
- Kingfishers near the old bridge: 2
EOF
commit_project field-notes 'docs: week 45 counts'

# The demo agent: prints a short, made-up agent session and reports its state the way Mirador's
# attention bridge does (through $HERDR_BIN_PATH, set in every agent terminal), then idles. It
# reads and writes nothing. acme-api ends up asking a question (the inbox), acme-web finishes its
# turn and field-notes keeps working.
cat >"$bin/demo-agent" <<'EOF'
#!/usr/bin/env bash
# Mirador demo agent: a made-up session for screenshots. It never reads or writes files.
project="$(basename "$PWD")"
# The clock in ms, as Mirador's own reports start their seq. Not date's %3N: GNU-only, BSD date
# (macOS) prints it as text. Agents always have node on PATH; whole seconds if it is not there.
seq="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null)" || seq="$(($(date +%s) * 1000))"
report() {
  [ -n "${HERDR_BIN_PATH:-}" ] && [ -n "${HERDR_PANE_ID:-}" ] || return 0
  seq=$((seq + 1))
  "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --seq "$seq" "$@" >/dev/null 2>&1 || true
}
say() { printf '%b\n' "$1"; sleep "${2:-0.4}"; }
case "$project" in
  acme-api) task='Rate-limit POST /v1/orders' ;;
  acme-web) task='Fix the checkout rounding' ;;
  *) task='Summarise week 45 counts' ;;
esac
say "\e[1;35mdemo-agent\e[0m · a made-up session" 0.2
say "\e[2mproject: $project\e[0m" 0.3
say ""
say "\e[1m> $task\e[0m" 0.5
report --source gentle:activity --token "summary=$task"
report --source mirador:attention --ttl-ms 600000 --clear-token finished
say "  \e[36m●\e[0m Reading the project layout"
say "  \e[36m●\e[0m Planning 3 steps"
say "  \e[32m✓\e[0m Step 1 of 3 done" 0.8
case "$project" in
  acme-api)
    say "  \e[32m✓\e[0m Step 2 of 3 done" 0.6
    say ""
    say "\e[33m? Apply the migration to staging? (y/n)\e[0m" 0.2
    report --source gentle:activity --clear-token summary
    report --source mirador:attention --token 'prompt=Apply the migration to staging?'
    ;;
  acme-web)
    say "  \e[32m✓\e[0m Step 2 of 3 done" 0.6
    say "  \e[32m✓\e[0m Step 3 of 3 done" 0.4
    say ""
    say "\e[32mDone.\e[0m Totals use integer cents." 0.2
    say "12 tests pass." 0.2
    report --source gentle:activity --clear-token summary
    report --source mirador:attention --token 'finished=1'
    ;;
  *)
    say "  \e[36m●\e[0m Step 2 of 3: counting per site" 0.2
    ;;
esac
while :; do sleep 3600; done
EOF
chmod 755 "$bin/demo-agent"

# The stand-in Engram: answers the read routes Mirador uses (src/memory/engram.ts) with invented
# memories dated relative to now, and accepts writes without keeping them. 127.0.0.1 only.
cat >"$bin/fake-engram.mjs" <<'EOF'
// Mirador demo: a stand-in for `engram serve` with invented memories. Usage: node fake-engram.mjs <port> <workspace-dir>
import { createServer } from 'node:http';
import { basename, join } from 'node:path';

const [port, workspace] = [Number(process.argv[2]), process.argv[3]];
if (!port || !workspace) {
  console.error('usage: node fake-engram.mjs <port> <workspace-dir>');
  process.exit(2);
}
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);
let id = 100;
const memory = (project, minutesAgo, type, title, content, session) => ({ id: ++id, project, type, title, content, created_at: at(minutesAgo), session_id: session });
const summary = (goal, done, next) => `## Goal\n${goal}\n\n## Accomplished\n${done.map((d) => `- ${d}`).join('\n')}\n\n## Next Steps\n${next.map((n) => `- ${n}`).join('\n')}\n`;
const OBSERVATIONS = [
  memory('acme-api', 12, 'session_summary', 'Session summary: acme-api', summary(
    'Add rate limiting to POST /v1/orders so a burst of retries from the mobile app cannot overload the database.',
    ['Token bucket per API key, 20 requests per 10 s, in src/limits.ts', 'Answers 429 with a Retry-After header', 'Integration tests for the burst and the reset'],
    ['Apply the migration that adds the api_keys.limit column to staging', 'Document the limit in docs/api.md', 'Open the PR once staging is green'],
  ), 's-api-2'),
  memory('acme-api', 40, 'decision', 'Rate limits are per API key, not per IP', 'Mobile clients share carrier IPs, so a per-IP limit would block unrelated users.', 's-api-2'),
  memory('acme-api', 95, 'bugfix', 'Fixed duplicate orders on retried requests', 'Root cause: the idempotency key was read after the insert. It is checked first now.', 's-api-1'),
  memory('acme-web', 25, 'session_summary', 'Session summary: acme-web', summary(
    'Fix the checkout total: 0.1 + 0.2 showed as 0.30000000000000004 in the cart.',
    ['Totals are kept in integer cents end to end', 'Formatting goes through Intl.NumberFormat', '12 checkout tests pass'],
    ['Check the invoice PDF uses the same formatter', 'Ask design whether to show cents for whole amounts'],
  ), 's-web-1'),
  memory('acme-web', 60, 'discovery', 'The cart and the invoice format prices differently', 'The invoice PDF still formats with toFixed(2); the cart uses Intl.NumberFormat.', 's-web-1'),
  memory('field-notes', 180, 'session_summary', 'Session summary: field-notes', summary(
    'Turn the week 45 counts into a short summary for the volunteers.',
    ['Counts merged from the three sites', 'Herons up from 2 to 4 at the north bend'],
    ['Add the map of the sites', 'Send the summary on Friday'],
  ), 's-notes-1'),
  memory('field-notes', 200, 'decision', 'Counts are kept per site, not per walk', 'Volunteers walk different routes; per-site counts compare week to week.', 's-notes-1'),
].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
const PROJECTS = ['acme-api', 'acme-web', 'field-notes'];
const SESSIONS = [...new Set(OBSERVATIONS.map((o) => `${o.project}|${o.session_id}`))].map((key) => {
  const [project, session] = key.split('|');
  const own = OBSERVATIONS.filter((o) => o.session_id === session);
  return { id: session, project, started_at: own[own.length - 1].created_at, ended_at: own[0].created_at, observation_count: own.length };
});

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET') return send(200, { id: ++id, ok: true });
  const project = url.searchParams.get('project');
  const limit = Number(url.searchParams.get('limit')) || 50;
  switch (url.pathname) {
    case '/health':
      return send(200, { status: 'ok' });
    case '/projects':
      return send(200, { projects: PROJECTS.map((name) => ({ name, directories: [join(workspace, name)], observation_count: OBSERVATIONS.filter((o) => o.project === name).length })) });
    case '/project/current': {
      const name = basename(url.searchParams.get('cwd') ?? '');
      return PROJECTS.includes(name) ? send(200, { project: name, project_source: 'git_remote', project_path: join(workspace, name) }) : send(200, { project: '' });
    }
    case '/observations/recent':
      return send(200, OBSERVATIONS.filter((o) => url.searchParams.get('all_projects') === 'true' || o.project === project).slice(0, limit));
    case '/sessions/recent':
      return send(200, SESSIONS.filter((s) => s.project === project).slice(0, limit));
    default:
      return send(404, { error: 'not found' });
  }
}).listen(port, '127.0.0.1', () => console.log(`fake-engram: invented memories on http://127.0.0.1:${port}`));
EOF

# The config Mirador reads (src/config.ts): only the demo workspace, the demo agent, the stand-in
# Engram, no systemd scopes and no notifications. `auto` mode shows the gentle-deck extras only
# while $HOME/.gentle-ai/state.json exists inside the demo HOME.
cat >"$home/.config/mirador/config.json" <<EOF
{
  "workspaces": [
    { "id": "demo", "name": "Demo", "root": "$ws", "folders": [], "expanded": [] }
  ],
  "port": $port,
  "engramUrl": "http://127.0.0.1:$engram_port",
  "agentCommand": "$bin/demo-agent",
  "mode": "auto",
  "timeZone": "UTC",
  "scopes": false,
  "notifications": { "desktop": false, "telegram": false }
}
EOF

# The capture driver, written beside the rest so a capture can be redone with the same workspace.
cat >"$bin/capture.mjs" <<'CAPTURE_MJS'
// Mirador demo capture: starts the stand-in Engram and a Mirador server on the demo workspace
// (HOME and XDG folders inside it; in its own PID namespace when `unshare` allows, so no process
// outside the demo shows), drives headless Chromium over the DevTools protocol with Node's
// built-in WebSocket, writes the README images and stops everything it started.
// Usage: node capture.mjs <demo-dir> <mirador-dir> <out-dir> <port> <engram-port>
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';

const [demo, appDir, outArg, portArg, engramArg] = process.argv.slice(2);
if (!demo || !appDir || !outArg || !portArg || !engramArg) {
  console.error('usage: node capture.mjs <demo-dir> <mirador-dir> <out-dir> <port> <engram-port>');
  process.exit(2);
}
const out = resolve(outArg);
const port = Number(portArg);
const engramPort = Number(engramArg);
const home = join(demo, 'home');
const runDir = join(demo, 'run');
const frames = join(demo, 'frames');
const statePath = join(runDir, 'mirador', 'state.json');
const origin = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => console.log(`capture: ${message}`);

/** The first program of `names` on PATH, or null. */
function onPath(names) {
  for (const name of names) for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

const portFree = (p) => new Promise((done) => {
  const probe = createServer().once('error', () => done(false)).once('listening', () => probe.close(() => done(true)));
  probe.listen(p, '127.0.0.1');
});

const browserBin = onPath(['chromium', 'chromium-browser', 'brave', 'brave-browser', 'google-chrome-stable', 'google-chrome']);
const missing = [!browserBin && 'a Chromium-family browser (chromium, brave or google-chrome)', !onPath(['magick']) && 'magick (ImageMagick 7)'].filter(Boolean);
if (missing.length) {
  console.error(`capture: missing ${missing.join(', ')}`);
  process.exit(1);
}
for (const p of [port, engramPort]) {
  if (!(await portFree(p))) {
    console.error(`capture: port ${p} on 127.0.0.1 is in use; pick another with --port`);
    process.exit(1);
  }
}
mkdirSync(out, { recursive: true });
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const started = [];
let serverPid = null;
let browser = null;

async function stopAll() {
  if (browser) await browser.close().catch(() => {});
  if (serverPid) {
    try {
      process.kill(serverPid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 100 && alive(serverPid); i++) await sleep(100);
  }
  for (const child of started) if (child.exitCode === null) child.kill('SIGTERM');
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Agents, the demo HOME and the server only see a PATH with node and the system folders: no
// agent the user installed shows in the agent picker, and `auto` mode follows the demo HOME.
const env = {
  PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_RUNTIME_DIR: runDir,
  MIRADOR_SCOPES: '0',
  MIRADOR_PORT: String(port),
  MIRADOR_ENGRAM_CACHE_MS: '0',
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  TERM: 'xterm-256color',
};

/** gentle-deck shows the memory views; it follows gentle-ai's state file in the demo HOME (src/mode.ts). */
function gentleDeck(on) {
  const file = join(home, '.gentle-ai', 'state.json');
  if (on) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"installed_agents":[]}\n');
  } else rmSync(file, { force: true });
}

async function startServers() {
  const engramLog = openSync(join(demo, 'engram.log'), 'w');
  started.push(spawn(process.execPath, [join(demo, 'bin', 'fake-engram.mjs'), String(engramPort), join(demo, 'workspace')], { stdio: ['ignore', engramLog, engramLog] }));
  const serverLog = openSync(join(demo, 'server.log'), 'w');
  const ns = ['--map-current-user', '--pid', '--fork', '--mount-proc', '--kill-child=SIGTERM'];
  let isolated = false;
  try {
    execFileSync('unshare', [...ns, 'true'], { stdio: 'ignore' });
    isolated = true;
  } catch {
    log('unshare cannot make a PID namespace here: processes outside the demo may show in the usage pane');
  }
  rmSync(statePath, { force: true });
  const command = isolated ? ['unshare', [...ns, process.execPath, 'src/server.ts']] : [process.execPath, ['src/server.ts']];
  const server = spawn(command[0], command[1], { cwd: appDir, env, stdio: ['ignore', serverLog, serverLog] });
  started.push(server);
  for (let i = 0; i < 150 && !existsSync(statePath); i++) {
    if (server.exitCode !== null) throw new Error(`the server exited; see ${join(demo, 'server.log')}`);
    await sleep(100);
  }
  if (!existsSync(statePath)) throw new Error(`the server did not start; see ${join(demo, 'server.log')}`);
  // In the namespace the server is unshare's child: its own pid gets SIGTERM, so it closes its agents.
  serverPid = isolated ? Number(readFileSync(`/proc/${server.pid}/task/${server.pid}/children`, 'utf8').trim().split(/\s+/)[0]) : server.pid;
  log(`server on ${origin} (pid ${serverPid}${isolated ? ', own PID namespace' : ''}), stand-in Engram on 127.0.0.1:${engramPort}`);
}

/** One-time window URL, as bin/mirador gets it: the launch secret from the 0600 state file for a nonce. */
async function launchUrl() {
  const { launchSecret } = JSON.parse(readFileSync(statePath, 'utf8'));
  const response = await fetch(`${origin}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  if (!response.ok) throw new Error(`bootstrap answered ${response.status}`);
  return (await response.json()).url;
}

async function openBrowser() {
  const child = spawn(browserBin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(demo, 'chrome')}`, '--window-size=1440,900', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--lang=en-US', '--force-color-profile=srgb', 'about:blank'], { env: { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe'] });
  started.push(child);
  const wsUrl = await new Promise((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error(`the browser gave no DevTools address: ${text}`)), 20000);
    child.stderr.on('data', (chunk) => {
      text += chunk;
      const found = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    child.once('exit', (code) => fail(new Error(`the browser exited (${code}): ${text}`)));
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('cannot reach the browser over DevTools'));
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.done(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = ++next;
    pending.set(id, { done, fail, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page('Page.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // The server's config says UTC: the page shows times in the same zone.
  await page('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  const evaluate = async (expression) => {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs = 15000) => {
    const end = Date.now() + timeoutMs;
    while (!(await evaluate(expression).catch(() => false))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${expression}`);
      await sleep(150);
    }
  };
  return {
    evaluate,
    waitFor,
    async goto(url) {
      await page('Page.navigate', { url });
      await sleep(300);
      await waitFor('document.readyState === "complete"');
    },
    async reload() {
      await page('Page.reload');
      await sleep(300);
      await waitFor('document.readyState === "complete"');
    },
    /** A PNG of the viewport, or of `selector`'s box. */
    async shot(file, selector) {
      let clip;
      if (selector) {
        const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
        clip = { ...box, scale: 1 };
      }
      const { data } = await page('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() {
      await send('Browser.close').catch(() => {});
    },
  };
}

const click = (selector) => browser.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); return true; })()`);
const setPrefs = (prefs) => browser.evaluate(`(() => { ${Object.entries(prefs).map(([key, value]) => `localStorage.setItem('mirador.${key}', ${JSON.stringify(JSON.stringify(value))});`).join(' ')} return true; })()`);
const agentButton = (rel) => `.row[data-rel="${rel}"] .gs-btn`;

/** Strips metadata and keeps the PNG small (the README budget is about 400 KB each). */
function finish(source, name) {
  execFileSync('magick', [source, '-strip', '-define', 'png:compression-level=9', join(out, name)]);
  log(`wrote ${join(out, name)}`);
}

/** Opens every fold (<details>) under `scope`: "Where it left off" folds Accomplished by default. */
const unfold = (scope) => browser.evaluate(`(() => { for (const d of document.querySelectorAll(${JSON.stringify(scope + ' details')})) d.open = true; return true; })()`);

async function main() {
  gentleDeck(true);
  await startServers();
  browser = await openBrowser();
  // Preferences live in the page's localStorage: set them on the server's origin before the app loads.
  await browser.goto(`${origin}/icon.svg`);
  await setPrefs({ lang: 'en', theme: 'light', view: 'development', layout: 'grid' });
  await browser.goto(await launchUrl());
  await browser.waitFor(`document.querySelectorAll('.row[data-rel]').length >= 3`);
  await sleep(2000);
  // The demo GIF: open the dashboard, launch agents, see their states, the inbox and the tracking view.
  const gif = [];
  const frame = async (name, seconds) => {
    await browser.shot(join(frames, name));
    gif.push([name, seconds]);
  };
  await frame('01-dashboard.png', 1.6);
  await click(agentButton('acme-api'));
  await sleep(900);
  await frame('02-launch.png', 1.0);
  await sleep(2500);
  await frame('03-working.png', 1.4);
  await click(agentButton('acme-web'));
  await sleep(1200);
  await click(agentButton('field-notes'));
  await sleep(1500);
  await frame('04-three-agents.png', 1.2);
  await sleep(3500);
  await frame('05-states.png', 1.8);
  finish(join(frames, '05-states.png'), 'overview.png');

  await click('[data-slot="panel-views"] [data-view="inbox"]');
  await sleep(1500);
  await frame('06-inbox.png', 1.6);
  finish(join(frames, '06-inbox.png'), 'inbox.png');

  await click('.tracking-switch button[data-view="tracking"]');
  await sleep(3000);
  await frame('07-tracking.png', 2.0);
  finish(join(frames, '07-tracking.png'), 'tracking.png');

  // "Where it left off" for acme-api, both folds open, cropped to the panel.
  await click('.tracking-switch button[data-view="development"]');
  await sleep(800);
  await click('.row[data-rel="acme-api"] > .name');
  await sleep(1000);
  await click('[data-slot="panel-views"] [data-view="leftoff"]');
  await sleep(1500);
  await unfold('#panel');
  await sleep(600);
  await browser.shot(join(frames, 'left-off.png'), '#panel');
  finish(join(frames, 'left-off.png'), 'left-off.png');

  // The same main view in the dark theme (public/theme-boot.js reads it before the first paint).
  await setPrefs({ theme: 'dark' });
  await browser.reload();
  await browser.waitFor(`document.querySelectorAll('.row[data-rel]').length >= 3 && document.querySelectorAll('.xterm').length >= 3`);
  await sleep(1500);
  await click('[data-slot="panel-views"] [data-view="leftoff"]');
  await sleep(2000);
  await browser.shot(join(frames, 'overview-dark.png'));
  finish(join(frames, 'overview-dark.png'), 'overview-dark.png');
  await setPrefs({ theme: 'light' });

  // Delays are in hundredths of a second; 960 px wide and 128 colours keep it small.
  const sequence = gif.flatMap(([name, seconds]) => ['-delay', String(Math.round(seconds * 100)), join(frames, name)]);
  execFileSync('magick', [...sequence, '-loop', '0', '-resize', '960x', '-colors', '128', '-layers', 'Optimize', join(out, 'demo.gif')]);
  log(`wrote ${join(out, 'demo.gif')} (${gif.length} frames)`);
}

try {
  await main();
} finally {
  await stopAll();
}
log('done');
CAPTURE_MJS

q() { printf "'%s'" "$1"; }
# The real node first on PATH: a version manager's shim (mise, asdf) would look for its installs
# under the demo HOME and could download Node there.
node_dir="$(dirname "$(node -p process.execPath)")"
demo_env="env PATH=$(q "$node_dir"):\"\$PATH\" HOME=$(q "$home") XDG_CONFIG_HOME=$(q "$home/.config") XDG_STATE_HOME=$(q "$home/.local/state") XDG_DATA_HOME=$(q "$home/.local/share") XDG_CACHE_HOME=$(q "$home/.cache") XDG_RUNTIME_DIR=$(q "$run") MIRADOR_SCOPES='0' MIRADOR_PORT='$port'"

echo "demo-workspace.sh: demo workspace ready in $target"
echo "Start the stand-in Engram (without it the memory views stay empty):"
echo "  $(q "$node_dir/node") $(q "$bin/fake-engram.mjs") $engram_port $(q "$ws") &"
echo "Start Mirador against the demo workspace only:"
echo "  cd $(q "$app_dir") && $demo_env node src/server.ts"
echo "Open it, from a second terminal:"
echo "  cd $(q "$app_dir") && $demo_env bin/mirador"

[ -z "$capture" ] && exit 0
exec "$node_dir/node" "$bin/capture.mjs" "$target" "$app_dir" "$capture" "$port" "$engram_port"
