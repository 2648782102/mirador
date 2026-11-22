// Runs bin/mirador with isolated XDG dirs, a stub chromium that records its arguments and a
// stub systemd-run that records its arguments and execs the command in place (or fails), so
// no test reaches the real systemd.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { access, chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSERS, MAC_APPS } from '../src/doctor.ts';
import { scratchBase } from './helpers/scratch.ts';
import { logLines as lines, waitForLogLines } from './helpers/log-lines.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = join(APP_DIR, 'bin', 'mirador');

let scratch: string;
const serverPids = new Set<number>();

interface Sandbox {
  env: NodeJS.ProcessEnv;
  port: number;
  statePath: string;
  browserLog: string;
  systemdRunLog: string;
  serverLog: string;
}

const SCOPE_FLAGS = '--user --scope --collect --quiet --expand-environment=no';
const PROBE = `${SCOPE_FLAGS} -- true`;
const NODE = join(dirname(process.execPath), 'node');

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

/** `works`: the stub runs the command after `--` in place, as `systemd-run --scope` does; `fails`: it exits 1. */
async function sandbox(name: string, systemdRun: 'works' | 'fails' = 'works'): Promise<Sandbox> {
  const dir = join(scratch, name);
  const stubs = join(dir, 'stubs');
  const browserLog = join(dir, 'browser.log');
  const systemdRunLog = join(dir, 'systemd-run.log');
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  await mkdir(join(dir, 'root'), { recursive: true });
  await mkdir(join(dir, 'run'), { recursive: true });
  await mkdir(stubs, { recursive: true });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(dir, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  await writeFile(join(stubs, 'chromium'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${browserLog}'\n`);
  await chmod(join(stubs, 'chromium'), 0o755);
  const run = systemdRun === 'works' ? 'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"' : 'exit 1';
  await writeFile(join(stubs, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${systemdRunLog}'\n${run}\n`);
  await chmod(join(stubs, 'systemd-run'), 0o755);
  const port = await freePort();
  return {
    port,
    browserLog,
    systemdRunLog,
    serverLog: join(dir, 'state', 'mirador', 'server.log'),
    statePath: join(dir, 'run', 'mirador', 'state.json'),
    env: {
      HOME: dir,
      PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`,
      XDG_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'cfg'),
      XDG_STATE_HOME: join(dir, 'state'),
      MIRADOR_PORT: String(port),
      // A graphical session: without DISPLAY or WAYLAND_DISPLAY the Linux launcher prints the link instead.
      DISPLAY: ':0',
    },
  };
}

function run(box: Sandbox, command: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHER, [command], { env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bin/mirador ${command} did not finish`));
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - startedAt });
    });
  });
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-launcher-')));
});

after(async () => {
  // Stop any server a failing test left behind.
  for (const pid of serverPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await rm(scratch, { recursive: true, force: true });
});

test('open fails fast and shows the log when the server exits during startup', async () => {
  const box = await sandbox('port-taken');
  const blocker: Server = createServer();
  await new Promise<void>((resolve) => blocker.listen(box.port, '127.0.0.1', resolve));
  try {
    const result = await run(box, 'open');
    assert.equal(result.code, 1);
    assert.ok(result.ms < 4000, `took ${result.ms} ms`);
    assert.match(result.stderr, /mirador: the server exited during startup/);
    assert.match(result.stderr, new RegExp(`port ${box.port} on 127\\.0\\.0\\.1 is already in use`));
    await assert.rejects(access(box.browserLog));
  } finally {
    blocker.close();
  }
});

/**
 * These tests run the launcher with the host's own uname, so on macOS it takes the macOS path
 * (open -na, no setsid, ps instead of /proc) and, with no stub for open, would open a real browser
 * on the runner. They assert the Linux path; the stubbed "on macOS …" tests below cover macOS.
 */
const LINUX_HOST = process.platform === 'darwin' && 'asserts the Linux launcher path (chromium --app --class, setsid, systemd-run, /proc/<pid>/cmdline) with the real uname; macOS is covered by the stubbed "on macOS" tests';
/** Linux and WSL2 are emulated with a uname stub, but the launcher's Linux path reads /proc/<pid>/cmdline and runs setsid, which macOS lacks. */
const EMULATES_LINUX_SERVER = process.platform === 'darwin' && 'emulates Linux or WSL2 with a running server: the launcher then checks the server in /proc/<pid>/cmdline and starts browsers with /usr/bin/setsid, neither of which exists on macOS';

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Arguments of each stub chromium call, one line per call. */
function browserCalls(box: Sandbox, count: number): Promise<string[]> {
  return waitForLogLines(box.browserLog, count, 8000);
}

async function statePid(box: Sandbox): Promise<number> {
  return JSON.parse(await readFile(box.statePath, 'utf8')).pid;
}

let box: Sandbox;
let firstPid: number;

test('open starts the server and opens the window with a one-time launch link', { skip: LINUX_HOST }, async () => {
  box = await sandbox('handshake');
  const result = await run(box, 'open');
  assert.equal(result.code, 0, result.stderr);
  firstPid = await statePid(box);
  serverPids.add(firstPid);
  assert.equal(isAlive(firstPid), true);

  const [call] = await browserCalls(box, 1);
  const match = call.match(new RegExp(`^--app=http://127\\.0\\.0\\.1:${box.port}/#launch=([\\w-]+) --class=mirador$`));
  assert.ok(match, call);

  // The nonce in the window URL signs the window in.
  const base = `http://127.0.0.1:${box.port}`;
  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: match[1] }),
  });
  assert.equal(session.status, 200);
});

test('a second open reuses the running server with a fresh launch link', { skip: LINUX_HOST }, async () => {
  const result = await run(box, 'open');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await statePid(box), firstPid);
  const [first, second] = await browserCalls(box, 2);
  assert.match(second, new RegExp(`^--app=http://127\\.0\\.0\\.1:${box.port}/#launch=[\\w-]+ --class=mirador$`));
  assert.notEqual(second, first);
});

test('status reports the running server', { skip: LINUX_HOST }, async () => {
  const result = await run(box, 'status');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `mirador: running (pid ${firstPid}, port ${box.port})\n`);
});

test('stop stops the server', { skip: LINUX_HOST }, async () => {
  const result = await run(box, 'stop');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'mirador: stopped\n');
  await waitFor(async () => (isAlive(firstPid) ? undefined : true));
  await assert.rejects(access(box.statePath));
  const status = await run(box, 'status');
  assert.equal(status.code, 1);
  assert.equal(status.stdout, 'mirador: not running\n');
});

async function stopServer(box: Sandbox, pid: number): Promise<void> {
  assert.equal((await run(box, 'stop')).stdout, 'mirador: stopped\n');
  await waitFor(async () => (isAlive(pid) ? undefined : true));
}

test('open starts the server in its own systemd user scope when systemd-run works', { skip: LINUX_HOST }, async () => {
  const scoped = await sandbox('scoped');
  const result = await run(scoped, 'open');
  assert.equal(result.code, 0, result.stderr);
  const pid = await statePid(scoped);
  serverPids.add(pid);
  assert.equal(isAlive(pid), true);
  assert.match(await readFile(`/proc/${pid}/cmdline`, 'utf8'), /\0src\/server\.ts\0$/);
  // The launcher's probe, the scoped start (the scope is named after the server's pid), then the server's own probe.
  assert.deepEqual(await lines(scoped.systemdRunLog), [PROBE, `${SCOPE_FLAGS} --unit=mirador-server-${pid} -- ${NODE} src/server.ts`, PROBE]);
  assert.match(await readFile(scoped.serverLog, 'utf8'), /mirador: terminal scopes on/);
  assert.equal((await browserCalls(scoped, 1)).length, 1);
  await stopServer(scoped, pid);
});

test('open starts the server with plain setsid when systemd-run fails', { skip: LINUX_HOST }, async () => {
  const plain = await sandbox('plain', 'fails');
  const result = await run(plain, 'open');
  assert.equal(result.code, 0, result.stderr);
  const pid = await statePid(plain);
  serverPids.add(pid);
  assert.equal(isAlive(pid), true);
  assert.equal(await readFile(`/proc/${pid}/cmdline`, 'utf8'), `${NODE}\0src/server.ts\0`);
  // Only the probes: the launcher's and the server's, both failed.
  assert.deepEqual(await lines(plain.systemdRunLog), [PROBE, PROBE]);
  assert.match(await readFile(plain.serverLog, 'utf8'), /mirador: terminal scopes off: systemd-run --user --scope failed/);
  assert.equal((await run(plain, 'status')).stdout, `mirador: running (pid ${pid}, port ${plain.port})\n`);
  await stopServer(plain, pid);
});

test('MIRADOR_SCOPES=0 starts the server with plain setsid without calling systemd-run', { skip: LINUX_HOST }, async () => {
  const optOut = await sandbox('opt-out');
  optOut.env.MIRADOR_SCOPES = '0';
  const result = await run(optOut, 'open');
  assert.equal(result.code, 0, result.stderr);
  const pid = await statePid(optOut);
  serverPids.add(pid);
  assert.equal(await readFile(`/proc/${pid}/cmdline`, 'utf8'), `${NODE}\0src/server.ts\0`);
  assert.deepEqual(await lines(optOut.systemdRunLog), []);
  assert.match(await readFile(optOut.serverLog, 'utf8'), /mirador: terminal scopes off \(MIRADOR_SCOPES=0\)/);
  await stopServer(optOut, pid);
});

test('mirador stop && mirador, the documented way to switch modes, stops the server and starts a new one on the same port back to back', { skip: LINUX_HOST }, async () => {
  const swap = await sandbox('stop-and-start');
  swap.env.MIRADOR_SCOPES = '0';
  assert.equal((await run(swap, 'open')).code, 0);
  const oldPid = await statePid(swap);
  serverPids.add(oldPid);

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; oldGone: boolean }>((resolve) => {
    const child = spawn('bash', ['-c', `'${LAUNCHER}' stop && '${LAUNCHER}'`], { env: swap.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, oldGone: !isAlive(oldPid) }));
  });

  // The start found the port free: a start that meets the old server exits with "already in use".
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: stopped\n', '']);
  assert.equal(result.oldGone, true);
  const newPid = await statePid(swap);
  serverPids.add(newPid);
  assert.notEqual(newPid, oldPid);
  assert.equal((await run(swap, 'status')).stdout, `mirador: running (pid ${newPid}, port ${swap.port})\n`);
  assert.equal((await browserCalls(swap, 2)).length, 2);
  await stopServer(swap, newPid);
});

test('a stale state file with a dead pid reads as not running', async () => {
  const stale = await sandbox('stale');
  const gone = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => gone.once('exit', resolve));
  await mkdir(dirname(stale.statePath), { recursive: true });
  await writeFile(stale.statePath, JSON.stringify({ pid: gone.pid, port: stale.port, launchSecret: 'stale' }));

  const result = await run(stale, 'status');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'mirador: not running\n');
});

test('a state file naming a live process that is not the server reads as not running, and stop leaves that process alone', async () => {
  const recycled = await sandbox('recycled');
  const other = spawn('sleep', ['60']);
  try {
    await mkdir(dirname(recycled.statePath), { recursive: true });
    await writeFile(recycled.statePath, JSON.stringify({ pid: other.pid, port: recycled.port, launchSecret: 'recycled' }));

    const status = await run(recycled, 'status');
    assert.deepEqual([status.code, status.stdout, status.stderr], [1, 'mirador: not running\n', '']);
    const stop = await run(recycled, 'stop');
    assert.deepEqual([stop.code, stop.stdout, stop.stderr], [0, 'mirador: not running\n', '']);
    assert.equal(isAlive(other.pid!), true, 'stop killed a process that is not the server');
  } finally {
    if (other.pid) process.kill(other.pid, 'SIGKILL');
  }
});

test('a hanging systemd-run does not block the start: the launcher falls back to plain setsid within its window', { skip: LINUX_HOST }, async () => {
  const hang = await sandbox('hang');
  // Hangs for 30 s unless its caller ends it; it notes when it began and when it was ended,
  // with bash's own clock, so the figures do not include the time processes take to start.
  const times = join(scratch, 'hang', 'systemd-run.times');
  await writeFile(join(scratch, 'hang', 'stubs', 'systemd-run'), [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> '${hang.systemdRunLog}'`,
    `printf 'start %s\\n' "$EPOCHREALTIME" >> '${times}'`,
    `trap 'printf "end %s\\n" "$EPOCHREALTIME" >> '"'${times}'"'; kill "$child" 2>/dev/null; exit 143' TERM`,
    'sleep 30 & child=$!',
    'wait "$child"',
    '',
  ].join('\n'));
  const result = await run(hang, 'open');
  // Exit 0: the server wrote its state inside the launcher's 5 s start window (else "did not start within 5 s").
  assert.equal(result.code, 0, result.stderr);
  const pid = await statePid(hang);
  serverPids.add(pid);
  // The launcher's probe and the server's probe, and no scoped start.
  assert.deepEqual(await lines(hang.systemdRunLog), [PROBE, PROBE]);
  // Each probe was ended by its caller at its 2 s timeout, not after the 30 s hang.
  const marks = (await lines(times)).map((line) => line.split(' '));
  assert.deepEqual(marks.map(([mark]) => mark), ['start', 'end', 'start', 'end']);
  for (const at of [0, 2]) {
    const waitedMs = (Number(marks[at + 1][1]) - Number(marks[at][1])) * 1000;
    assert.ok(waitedMs >= 1900 && waitedMs < 3000, `a probe waited ${Math.round(waitedMs)} ms; its timeout is 2000 ms`);
  }
  assert.equal(await readFile(`/proc/${pid}/cmdline`, 'utf8'), `${NODE}\0src/server.ts\0`);
  assert.match(await readFile(hang.serverLog, 'utf8'), /terminal scopes off: systemd-run --user --scope failed \(no answer within 2000 ms\)/);
  await stopServer(hang, pid);
});

// The portable launcher tests run with a PATH of their own: the stubs
// each one needs and only the system tools the launcher uses, so no node, setsid, ps, uname, open
// or wslview leaks in from the machine. Node comes in as one private `node` link to the running
// binary, never as its folder: that folder may be /usr/bin (a distro's node), and then every real
// browser, xdg-open and wslview there would come before the stubs.
const SYSTEM_TOOLS = ['bash', 'cat', 'dirname', 'grep', 'ln', 'mkdir', 'readlink', 'rm', 'seq', 'sleep', 'tail', 'timeout', 'tr'];
let systemTools: string | undefined;
let privateNode: string | undefined;

/**
 * Where the system keeps `tool`: /usr/bin, else /bin (macOS keeps bash, cat, ln, mkdir, rm, sleep
 * and ps there), else null (macOS has no timeout: the launcher's systemd-run probe then just fails).
 */
function systemTool(tool: string): string | null {
  return ['/usr/bin', '/bin'].map((dir) => join(dir, tool)).find((path) => existsSync(path)) ?? null;
}

async function systemToolsDir(): Promise<string> {
  if (!systemTools) {
    systemTools = join(scratch, 'system-tools');
    await mkdir(systemTools);
    for (const tool of SYSTEM_TOOLS) {
      const path = systemTool(tool);
      if (path) await symlink(path, join(systemTools, tool));
    }
  }
  return systemTools;
}

/** The server's command line: /proc's NUL-separated one on Linux; on macOS (no /proc) ps's, space-separated. */
async function serverCommandLine(pid: number): Promise<string> {
  if (process.platform !== 'darwin') return readFile(`/proc/${pid}/cmdline`, 'utf8');
  return new Promise((resolve, reject) => execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
}

/** A folder holding only `node`, a link to the running Node; the launcher runs the server as `<folder>/node`. */
async function nodeDir(): Promise<string> {
  if (!privateNode) {
    privateNode = join(scratch, 'node');
    await mkdir(privateNode);
    await symlink(process.execPath, join(privateNode, 'node'));
  }
  return privateNode;
}

/** The portable tools PATH: the system tools and the private Node. */
const portableTools = async () => `${await systemToolsDir()}:${await nodeDir()}`;

/** Writes each `name: body` as an executable `#!/bin/sh` stub in `dir`. */
async function stubDir(dir: string, stubs: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), 0o755);
  }
  return dir;
}

/** A `uname` stub answering `-r` with the kernel release and anything else with the system name. */
const uname = (system: string, release: string) => `case "$1" in -r) echo '${release}' ;; *) echo '${system}' ;; esac`;
const LINUX = uname('Linux', '6.12.0-arch1-1');
const MACOS = uname('Darwin', '24.6.0');
const WSL2 = uname('Linux', '5.15.167.4-microsoft-standard-WSL2');

/** A state file for a process that has already exited, so reading it needs node and finds no server. */
async function staleState(box: Sandbox): Promise<void> {
  const gone = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => gone.once('exit', resolve));
  await mkdir(dirname(box.statePath), { recursive: true });
  await writeFile(box.statePath, JSON.stringify({ pid: gone.pid, port: box.port, launchSecret: 'stale' }));
}

test('the launcher finds Node on PATH, then with mise which node, then at the mise shims path', async () => {
  const lookup = await sandbox('node-lookup');
  const dir = join(scratch, 'node-lookup');
  const nodeLog = join(dir, 'node.log');
  const miseLog = join(dir, 'mise.log');
  const node = (name: string) => `printf '%s\\n' ${name} >> '${nodeLog}'\nexec '${process.execPath}' "$@"`;
  const onPath = await stubDir(join(dir, 'path-node'), { node: node('path') });
  const miseNode = join(await stubDir(join(dir, 'mise-node'), { node: node('mise') }), 'node');
  const mise = await stubDir(join(dir, 'mise'), { mise: `printf '%s\\n' "$*" >> '${miseLog}'\n[ "$*" = 'which node' ] && echo '${miseNode}'` });
  await stubDir(join(dir, '.local', 'share', 'mise', 'shims'), { node: node('shim') });
  await staleState(lookup);
  const tools = `${await stubDir(join(dir, 'linux'), { uname: LINUX })}:${await systemToolsDir()}`;

  for (const [path, used] of [[`${mise}:${onPath}:${tools}`, 'path'], [`${mise}:${tools}`, 'mise'], [tools, 'shim']]) {
    lookup.env.PATH = path;
    await rm(nodeLog, { force: true });
    const result = await run(lookup, 'status');
    assert.deepEqual([result.code, result.stdout, result.stderr], [1, 'mirador: not running\n', '']);
    assert.deepEqual(await lines(nodeLog), [used], `PATH=${path}`);
  }
  // mise is asked only when there is no node on PATH.
  assert.deepEqual(await lines(miseLog), ['which node']);
});

// The prebuilt release bundles its Node at node/bin/node beside bin/: a copy of the launcher in such a folder runs
// that one, before any node on PATH or from mise.
test('in a prebuilt release the launcher runs the bundled node/bin/node before PATH and mise', async () => {
  const lookup = await sandbox('bundled-node');
  const dir = join(scratch, 'bundled-node');
  const nodeLog = join(dir, 'node.log');
  const miseLog = join(dir, 'mise.log');
  const node = (name: string) => `printf '%s\\n' ${name} >> '${nodeLog}'\nexec '${process.execPath}' "$@"`;
  const app = join(dir, 'mirador-0.9.0-linux-x64');
  await mkdir(join(app, 'bin'), { recursive: true });
  await writeFile(join(app, 'bin', 'mirador'), await readFile(LAUNCHER));
  await chmod(join(app, 'bin', 'mirador'), 0o755);
  await stubDir(join(app, 'node', 'bin'), { node: node('bundled') });
  const onPath = await stubDir(join(dir, 'path-node'), { node: node('path') });
  const mise = await stubDir(join(dir, 'mise'), { mise: `printf '%s\\n' "$*" >> '${miseLog}'` });
  await staleState(lookup);
  lookup.env.PATH = `${mise}:${onPath}:${await stubDir(join(dir, 'linux'), { uname: LINUX })}:${await systemToolsDir()}`;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(join(app, 'bin', 'mirador'), ['status'], { env: lookup.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual([result.code, result.stdout, result.stderr], [1, 'mirador: not running\n', '']);
  assert.deepEqual(await lines(nodeLog), ['bundled']);
  assert.deepEqual(await lines(miseLog), []);
});

test('without Node the launcher says how to get it and exits 1', async () => {
  const bare = await sandbox('no-node');
  bare.env.PATH = `${await stubDir(join(scratch, 'no-node', 'linux'), { uname: LINUX })}:${await systemToolsDir()}`;
  const result = await run(bare, 'status');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'mirador: Node 24 or newer not found; install it (https://nodejs.org) and run ./install.sh\n');
});

test('on macOS the launcher checks the server pid with ps, not /proc', async () => {
  const mac = await sandbox('macos-ps');
  const dir = join(scratch, 'macos-ps');
  const psLog = join(dir, 'ps.log');
  const psAnswer = join(dir, 'ps.answer');
  const bin = await stubDir(join(dir, 'bin'), { uname: MACOS, ps: `printf '%s\\n' "$*" >> '${psLog}'\ncat '${psAnswer}'` });
  mac.env.PATH = `${bin}:${await portableTools()}`;
  // A live process that /proc shows is not the server: only ps decides what the launcher reports.
  const other = spawn('sleep', ['30']);
  try {
    await mkdir(dirname(mac.statePath), { recursive: true });
    await writeFile(mac.statePath, JSON.stringify({ pid: other.pid, port: mac.port, launchSecret: 'x' }));

    await writeFile(psAnswer, 'sleep 30\n');
    const recycled = await run(mac, 'status');
    assert.deepEqual([recycled.code, recycled.stdout], [1, 'mirador: not running\n']);

    await writeFile(psAnswer, `${join(await nodeDir(), 'node')} src/server.ts\n`);
    const ours = await run(mac, 'status');
    assert.deepEqual([ours.code, ours.stdout, ours.stderr], [0, `mirador: running (pid ${other.pid}, port ${mac.port})\n`, '']);
    assert.deepEqual(await lines(psLog), [`-p ${other.pid} -o command=`, `-p ${other.pid} -o command=`]);
  } finally {
    other.kill();
  }
});

let mac: Sandbox;
let macPid: number;
let openLog: string;
let macApps: string;

test('on macOS open starts the server without setsid', async () => {
  mac = await sandbox('macos');
  const dir = join(scratch, 'macos');
  openLog = join(dir, 'open.log');
  macApps = join(dir, 'apps');
  // `open -a` fails for an app that is not installed, as macOS's does.
  const bin = await stubDir(join(dir, 'bin'), {
    uname: MACOS,
    ps: `exec ${systemTool('ps')} "$@"`,
    open: `printf '%s\\n' "$*" >> '${openLog}'\n[ "$1" = -na ] || exit 0\ngrep -qx "$2" '${macApps}' || { echo "Unable to find application named '$2'" >&2; exit 1; }`,
  });
  await writeFile(macApps, 'Brave Browser\nChromium\n');
  mac.env.PATH = `${bin}:${await portableTools()}`;
  const result = await run(mac, 'open');
  macPid = await statePid(mac);
  serverPids.add(macPid);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  const node = join(await nodeDir(), 'node');
  assert.equal(await serverCommandLine(macPid), process.platform === 'darwin' ? `${node} src/server.ts` : `${node}\0src/server.ts\0`);
  assert.equal((await run(mac, 'status')).stdout, `mirador: running (pid ${macPid}, port ${mac.port})\n`);
});

test("on macOS open opens the window with open -na in the first app of doctor's list, else a tab with open", async () => {
  const url = new RegExp(`^--args --app=http://127\\.0\\.0\\.1:${mac.port}/#launch=[\\w-]+$`);
  const calls = (await lines(openLog)).map((line) => line.split(' --args'));
  assert.deepEqual(calls.map(([call]) => call), ['-na Google Chrome', '-na Brave Browser']);
  assert.match(`--args${calls[1][1]}`, url);

  await writeFile(macApps, 'Chromium\n');
  await rm(openLog);
  assert.equal((await run(mac, 'open')).code, 0);
  assert.deepEqual((await lines(openLog)).map((line) => line.split(' --args')[0]), MAC_APPS.map((app) => `-na ${app}`));

  // No app of the family: a tab in the default browser, and a line saying what the app window needs.
  await writeFile(macApps, '');
  await rm(openLog);
  const tab = await run(mac, 'open');
  assert.equal(tab.code, 0, tab.stderr);
  assert.equal(tab.stdout, '');
  assert.equal(tab.stderr, `mirador: opened as a tab in the default browser (open); the app window (no browser UI) needs a Chromium-family browser: ${MAC_APPS.join(', ')}\n`);
  const opened = await lines(openLog);
  assert.deepEqual(opened.slice(0, -1), MAC_APPS.map((app) => `-na ${app} --args ${opened.at(-1)!.replace(/^/, '--app=')}`));
  assert.match(opened.at(-1)!, new RegExp(`^http://127\\.0\\.0\\.1:${mac.port}/#launch=[\\w-]+$`));
  await stopServer(mac, macPid);
});

test('on macOS install creates only the ~/.local/bin/mirador link and says so', async () => {
  const mac = await sandbox('macos-install');
  const dir = join(scratch, 'macos-install');
  mac.env.PATH = `${await stubDir(join(dir, 'bin'), { uname: MACOS })}:${await portableTools()}`;
  const result = await run(mac, 'install');
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: installed ~/.local/bin/mirador (macOS has no app menu entry)\n', '']);
  assert.equal(await readlink(join(dir, '.local', 'bin', 'mirador')), LAUNCHER);
  await assert.rejects(access(join(dir, '.local', 'share', 'applications')));
});

test('on WSL2 without a Linux Chromium browser open uses wslview, else prints the link to open', { skip: EMULATES_LINUX_SERVER }, async () => {
  const wsl = await sandbox('wsl');
  const dir = join(scratch, 'wsl');
  const wslviewLog = join(dir, 'wslview.log');
  const bin = await stubDir(join(dir, 'bin'), { uname: WSL2 });
  await symlink('/usr/bin/setsid', join(bin, 'setsid'));
  const wslview = await stubDir(join(dir, 'wslview'), { wslview: `printf '%s\\n' "$*" >> '${wslviewLog}'` });
  const path = `${bin}:${await portableTools()}`;
  const link = new RegExp(`^http://127\\.0\\.0\\.1:${wsl.port}/#launch=[\\w-]+$`);

  wsl.env.PATH = `${wslview}:${path}`;
  const viewed = await run(wsl, 'open');
  const pid = await statePid(wsl);
  serverPids.add(pid);
  assert.deepEqual([viewed.code, viewed.stdout, viewed.stderr], [0, '', '']);
  const [url] = await lines(wslviewLog);
  assert.match(url, link);

  wsl.env.PATH = path;
  const printed = await run(wsl, 'open');
  assert.equal(printed.code, 0, printed.stderr);
  const shown = printed.stdout.match(/^mirador: open this link in a browser: (\S+)\n$/)?.[1] ?? printed.stdout;
  assert.match(shown, link);
  assert.notEqual(shown, url);

  // A Linux Chromium browser still comes first, as on any Linux.
  wsl.env.PATH = `${join(dir, 'stubs')}:${wslview}:${path}`;
  assert.equal((await run(wsl, 'open')).code, 0);
  assert.match((await browserCalls(wsl, 1))[0], /^--app=http:\/\/127\.0\.0\.1:\d+\/#launch=[\w-]+ --class=mirador$/);
  assert.equal((await lines(wslviewLog)).length, 1);
  await stopServer(wsl, pid);
});

test('on WSL2 without wslview open opens an Edge app window through powershell.exe, and prints the link when that fails', { skip: EMULATES_LINUX_SERVER }, async () => {
  const wsl = await sandbox('wsl-edge');
  const dir = join(scratch, 'wsl-edge');
  const psLog = join(dir, 'powershell.log');
  const psExit = join(dir, 'powershell.exit');
  const bin = await stubDir(join(dir, 'bin'), {
    uname: WSL2,
    'powershell.exe': `for arg in "$@"; do printf '%s\\n' "$arg" >> '${psLog}'; done\nexit "$(cat '${psExit}')"`,
  });
  await symlink('/usr/bin/setsid', join(bin, 'setsid'));
  wsl.env.PATH = `${bin}:${await portableTools()}`;
  const link = `http://127\\.0\\.0\\.1:${wsl.port}/#launch=[\\w-]+`;

  await writeFile(psExit, '0');
  const opened = await run(wsl, 'open');
  const pid = await statePid(wsl);
  serverPids.add(pid);
  assert.deepEqual([opened.code, opened.stdout, opened.stderr], [0, '', '']);
  const [noProfile, nonInteractive, command, script, ...rest] = await lines(psLog);
  assert.deepEqual([noProfile, nonInteractive, command, rest], ['-NoProfile', '-NonInteractive', '-Command', []]);
  assert.match(script, new RegExp(`^Start-Process msedge -ArgumentList '--app=${link}'$`));

  await writeFile(psExit, '1');
  const printed = await run(wsl, 'open');
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(printed.stdout, new RegExp(`^mirador: open this link in a browser: ${link}\\n$`));
  await stopServer(wsl, pid);
});

test('on macOS uninstall removes the link and does not mention an app menu entry', async () => {
  const mac = await sandbox('macos-uninstall');
  const dir = join(scratch, 'macos-uninstall');
  mac.env.PATH = `${await stubDir(join(dir, 'bin'), { uname: MACOS })}:${await portableTools()}`;
  assert.equal((await run(mac, 'install')).code, 0);
  const result = await run(mac, 'uninstall');
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: removed the launcher (the app folder is untouched)\n', '']);
  await assert.rejects(access(join(dir, '.local', 'bin', 'mirador')));
});

test('on Linux uninstall still removes the link and the app menu entry', async () => {
  const linux = await sandbox('linux-uninstall');
  const dir = join(scratch, 'linux-uninstall');
  linux.env.PATH = `${await stubDir(join(dir, 'bin'), { uname: LINUX })}:${await portableTools()}`;
  assert.equal((await run(linux, 'install')).code, 0);
  const result = await run(linux, 'uninstall');
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: removed the launcher and the app menu entry (the app folder is untouched)\n', '']);
  await assert.rejects(access(join(dir, '.local', 'bin', 'mirador')));
  await assert.rejects(access(join(dir, '.local', 'share', 'applications', 'mirador.desktop')));
});

test('on Linux install still adds the link and the app menu entry', async () => {
  const linux = await sandbox('linux-install');
  const dir = join(scratch, 'linux-install');
  linux.env.PATH = `${await stubDir(join(dir, 'bin'), { uname: LINUX })}:${await portableTools()}`;
  const result = await run(linux, 'install');
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: installed ~/.local/bin/mirador and the Mirador app menu entry\n', '']);
  assert.equal(await readlink(join(dir, '.local', 'bin', 'mirador')), LAUNCHER);
  const entry = await readFile(join(dir, '.local', 'share', 'applications', 'mirador.desktop'), 'utf8');
  assert.match(entry, new RegExp(`^Exec=${dir}/\\.local/bin/mirador$`, 'm'));
  assert.match(entry, /^StartupWMClass=mirador$/m);
});

// bin/mirador opens what doctor checks, in doctor's order; the
// config's `browser` wins; without a Chromium-family browser it opens a tab with xdg-open.

/** A Linux sandbox with a running server and a PATH of its own: uname, setsid, the system tools, Node and `extra`. */
async function linuxBox(name: string): Promise<{ box: Sandbox; dir: string; pid: number; base: string; log: string }> {
  const box = await sandbox(name);
  const dir = join(scratch, name);
  const bin = await stubDir(join(dir, 'bin'), { uname: LINUX });
  await symlink('/usr/bin/setsid', join(bin, 'setsid'));
  const base = `${bin}:${await portableTools()}`;
  box.env.PATH = base;
  box.env.MIRADOR_SCOPES = '0';
  // Start the server once with no browser at all (that open fails); later opens reuse it.
  await run(box, 'open');
  const pid = await statePid(box);
  serverPids.add(pid);
  return { box, dir, pid, base, log: join(dir, 'opened.log') };
}

/** Stubs named `names` that record `<name> <args>`, in a new folder. */
async function recorders(dir: string, names: readonly string[], log: string): Promise<string> {
  return stubDir(dir, Object.fromEntries(names.map((name) => [name, `printf '%s %s\\n' '${name}' "$*" >> '${log}'`])));
}

const launch = (port: number) => `http://127\\.0\\.0\\.1:${port}/#launch=[\\w-]+`;

test("on Linux open uses the first Chromium-family browser of doctor's list on PATH", { skip: EMULATES_LINUX_SERVER }, async () => {
  const { box, dir, pid, base, log } = await linuxBox('shared-list');
  for (const [index, name] of BROWSERS.entries()) {
    // Only this browser and the ones after it are on PATH: it must be the one that opens.
    box.env.PATH = `${await recorders(join(dir, `from-${index}`), BROWSERS.slice(index), log)}:${base}`;
    await rm(log, { force: true });
    const result = await run(box, 'open');
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], name);
    const [call] = await waitFor(async () => ((await lines(log)).length ? lines(log) : undefined));
    assert.match(call, new RegExp(`^${name} --app=${launch(box.port)} --class=mirador$`));
  }
  await stopServer(box, pid);
});

test("on Linux the config's browser wins over the list, and one that is not found falls back to the list with a warning", { skip: EMULATES_LINUX_SERVER }, async () => {
  const { box, dir, pid, base, log } = await linuxBox('config-browser');
  box.env.PATH = `${await recorders(join(dir, 'browsers'), ['chromium', 'my-browser'], log)}:${base}`;
  const config = join(dir, 'cfg', 'mirador', 'config.json');
  const saved = JSON.parse(await readFile(config, 'utf8'));

  await writeFile(config, JSON.stringify({ ...saved, browser: 'my-browser' }));
  const chosen = await run(box, 'open');
  assert.deepEqual([chosen.code, chosen.stdout, chosen.stderr], [0, '', '']);
  assert.match((await waitFor(async () => ((await lines(log)).length ? lines(log) : undefined)))[0], new RegExp(`^my-browser --app=${launch(box.port)} --class=mirador$`));

  await writeFile(config, JSON.stringify({ ...saved, browser: 'not-installed' }));
  await rm(log);
  const unknown = await run(box, 'open');
  assert.equal(unknown.code, 0);
  assert.equal(unknown.stderr, `mirador: the config's browser "not-installed" was not found; trying the Chromium-family browsers\n`);
  assert.match((await waitFor(async () => ((await lines(log)).length ? lines(log) : undefined)))[0], /^chromium --app=/);
  await stopServer(box, pid);
});

test('on Linux without a Chromium-family browser open opens a tab with xdg-open and says the app window needs one; with nothing it fails', { skip: EMULATES_LINUX_SERVER }, async () => {
  const { box, dir, pid, base, log } = await linuxBox('xdg-open');
  box.env.PATH = `${await recorders(join(dir, 'xdg'), ['xdg-open'], log)}:${base}`;
  const tab = await run(box, 'open');
  assert.equal(tab.code, 0, tab.stderr);
  assert.equal(tab.stdout, '');
  assert.equal(tab.stderr, `mirador: opened as a tab in the default browser (xdg-open); the app window (no browser UI) needs a Chromium-family browser: ${BROWSERS.join(', ')}\n`);
  assert.match((await waitFor(async () => ((await lines(log)).length ? lines(log) : undefined)))[0], new RegExp(`^xdg-open ${launch(box.port)}$`));

  box.env.PATH = base;
  const none = await run(box, 'open');
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.equal(none.stderr, `mirador: no browser found: the app window needs a Chromium-family browser (${BROWSERS.join(', ')}), and xdg-open is not on PATH for a tab\n`);
  await stopServer(box, pid);
});

test('on WSL2 wslview still comes before the xdg-open tab, and with neither the link is still printed', { skip: EMULATES_LINUX_SERVER }, async () => {
  const wsl = await sandbox('wsl-order');
  const dir = join(scratch, 'wsl-order');
  const log = join(dir, 'opened.log');
  const bin = await stubDir(join(dir, 'bin'), { uname: WSL2 });
  await symlink('/usr/bin/setsid', join(bin, 'setsid'));
  const base = `${bin}:${await portableTools()}`;
  wsl.env.PATH = `${await recorders(join(dir, 'openers'), ['wslview', 'xdg-open'], log)}:${base}`;
  const viewed = await run(wsl, 'open');
  const pid = await statePid(wsl);
  serverPids.add(pid);
  assert.deepEqual([viewed.code, viewed.stdout, viewed.stderr], [0, '', '']);
  assert.deepEqual((await lines(log)).map((line) => line.split(' ')[0]), ['wslview']);

  wsl.env.PATH = base;
  const printed = await run(wsl, 'open');
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(printed.stdout, new RegExp(`^mirador: open this link in a browser: ${launch(wsl.port)}\\n$`));
  await stopServer(wsl, pid);
});

// Without a display (an SSH session, a container) no browser can open a window: the launcher still starts
// the server and prints the one-time link to open by hand.
test('on Linux without a display open starts the server, opens no browser and prints the link to open by hand', { skip: EMULATES_LINUX_SERVER }, async () => {
  const box = await sandbox('no-display');
  const dir = join(scratch, 'no-display');
  const log = join(dir, 'opened.log');
  const bin = await stubDir(join(dir, 'bin'), { uname: LINUX });
  await symlink('/usr/bin/setsid', join(bin, 'setsid'));
  box.env.PATH = `${await recorders(join(dir, 'openers'), ['chromium', 'xdg-open'], log)}:${bin}:${await portableTools()}`;
  box.env.MIRADOR_SCOPES = '0';
  delete box.env.DISPLAY;
  const result = await run(box, 'open');
  const pid = await statePid(box);
  serverPids.add(pid);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const link = result.stdout.match(new RegExp(`^mirador: no display \\(DISPLAY and WAYLAND_DISPLAY are unset\\), so no window opens; open this one-time link in a browser within 60 s: (${launch(box.port)})\\n$`))?.[1];
  assert.ok(link, result.stdout);
  assert.equal((await run(box, 'status')).stdout, `mirador: running (pid ${pid}, port ${box.port})\n`);
  // The printed link signs a browser in, as the window's would.
  const base = `http://127.0.0.1:${box.port}`;
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce: new URL(link).hash.replace('#launch=', '') }) });
  assert.equal(session.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await lines(log), [], 'a browser or xdg-open was started');

  // A Wayland session alone is a display: the window opens as usual.
  box.env.WAYLAND_DISPLAY = 'wayland-0';
  const shown = await run(box, 'open');
  assert.deepEqual([shown.code, shown.stdout, shown.stderr], [0, '', '']);
  assert.match((await waitFor(async () => ((await lines(log)).length ? lines(log) : undefined)))[0], new RegExp(`^chromium --app=${launch(box.port)} --class=mirador$`));
  await stopServer(box, pid);
});
