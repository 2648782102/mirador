// Terminal lifecycle over a stop and a start:
// a server shutdown ends the scopes of the terminals it owns, a restore never reopens an agent
// whose previous scope still runs, and `mirador stop` returns once the server is gone.
// Fake systemd-run and systemctl in scratch dirs: no test reaches the real systemd.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAgents, type OpenAgentRecord } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { stopScopes } from '../src/terminals/scopes.ts';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
const children: ChildProcess[] = [];
before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-lifecycle-')));
});
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Polls `check` until it gives a value. The deadline is generous on purpose: a passing run returns as soon as the
 * condition holds, and a loaded CI runner can take several seconds to start a server.
 */
async function waitFor<T>(check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

/**
 * A fake systemctl in `dir` that logs its arguments. `stop` fails like the real one for a unit
 * listed in `not-loaded`; `is-active` prints, per unit, the state in `states/<unit>` (default inactive).
 */
async function fakeSystemctl(dir: string): Promise<{ command: string; calls: () => Promise<string[]>; setState(unit: string, state: string): Promise<void>; notLoaded(unit: string): Promise<void> }> {
  await mkdir(join(dir, 'states'), { recursive: true });
  const command = join(dir, 'systemctl');
  const log = join(dir, 'systemctl.log');
  await writeFile(command, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'what="$2"; shift 3',
    'if [ "$what" = stop ]; then',
    `  if grep -qx "$1" '${join(dir, 'not-loaded')}' 2>/dev/null; then echo "Failed to stop $1: Unit $1 not loaded." >&2; exit 5; fi`,
    '  exit 0',
    'fi',
    'if [ "$what" = is-active ]; then',
    `  for unit in "$@"; do if [ -f '${join(dir, 'states')}'/"$unit" ]; then cat '${join(dir, 'states')}'/"$unit"; else echo inactive; fi; done`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(command, 0o755);
  return {
    command,
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    setState: (unit, state) => writeFile(join(dir, 'states', unit), `${state}\n`),
    notLoaded: (unit) => writeFile(join(dir, 'not-loaded'), `${unit}\n`, { flag: 'a' }),
  };
}

class FakePty implements PtyProcess {
  killed = false;
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  onData() {}
  onExit(listener: (e: { exitCode: number; signal?: number }) => void) { this.exitListeners.push(listener); }
  write() {}
  resize() {}
  kill() { this.killed = true; this.emitExit(0, 1); }
  emitExit(exitCode: number, signal?: number) { this.exitListeners.forEach((l) => l(signal === undefined ? { exitCode } : { exitCode, signal })); }
}

function registryWith(options: { scopes: boolean; stopScopes?: (units: string[]) => Promise<string[]> }) {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = () => {
    const pty = new FakePty();
    spawned.push(pty);
    return pty;
  };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000, ...options });
  return { registry, spawned };
}

const agent = (rel: string) => ({ cwd: `/w/${rel}`, kind: 'agent' as const, cols: 100, rows: 30, workspaceId: 'dev', rel });

test('stopScopes stops each scope with its own systemctl call, so one already gone does not keep the others running, and returns the ones still running', async () => {
  const fake = await fakeSystemctl(join(scratch, 'stop-scopes'));
  await fake.notLoaded('mirador-agent-gone.scope');
  await fake.setState('mirador-agent-stuck.scope', 'deactivating');
  await fake.setState('mirador-agent-alive.scope', 'inactive');

  const running = await stopScopes(['mirador-agent-alive', 'mirador-agent-gone', 'mirador-agent-stuck'], { command: fake.command });

  assert.deepEqual(running, ['mirador-agent-stuck']);
  const calls = await fake.calls();
  assert.deepEqual(calls.slice(0, 3).sort(), [
    '--user stop -- mirador-agent-alive.scope',
    '--user stop -- mirador-agent-gone.scope',
    '--user stop -- mirador-agent-stuck.scope',
  ]);
  assert.deepEqual(calls.slice(3), ['--user is-active -- mirador-agent-alive.scope mirador-agent-gone.scope mirador-agent-stuck.scope'], 'asked once, after every stop');

  const none = await fakeSystemctl(join(scratch, 'stop-none'));
  assert.deepEqual(await stopScopes([], { command: none.command }), []);
  assert.deepEqual(await none.calls(), [], 'nothing to stop, no systemctl');
});

test('with scopes on, closeAll ends every terminal and stops the scope of each one it holds, running or exited, before it resolves', async () => {
  const stops: string[][] = [];
  let release!: () => void;
  const { registry, spawned } = registryWith({
    scopes: true,
    stopScopes: (units) => {
      stops.push(units);
      return new Promise((resolve) => (release = () => resolve([])));
    },
  });
  const running = registry.create(agent('a'));
  const exited = registry.create({ ...agent('b'), kind: 'shell' });
  spawned[1].emitExit(0);

  let done = false;
  const closing = registry.closeAll().then(() => (done = true));
  assert.equal(spawned[0].killed, true, 'the running terminal is killed as before');
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(stops, [[`mirador-agent-${running.id}`, `mirador-shell-${exited.id}`]]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, 'closeAll waits for the scopes to stop');
  release();
  await closing;
  assert.equal(done, true);
});

test('with scopes off, closeAll kills and forgets every terminal as before and stops no scope', async () => {
  const stops: string[][] = [];
  const { registry, spawned } = registryWith({ scopes: false, stopScopes: async (units) => (stops.push(units), []) });
  registry.create(agent('a'));
  registry.create(agent('b'));
  await registry.closeAll();
  assert.deepEqual(spawned.map((p) => p.killed), [true, true]);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(stops, []);
});

test('R1b: with scopes on, closing one terminal also stops its scope, one unit, without waiting for the stop', async () => {
  const stops: string[][] = [];
  const releases: Array<() => void> = [];
  const { registry, spawned } = registryWith({
    scopes: true,
    stopScopes: (units) => {
      stops.push(units);
      return new Promise((resolve) => releases.push(() => resolve([])));
    },
  });
  const running = registry.create(agent('a'));
  const exited = registry.create({ ...agent('b'), kind: 'shell' });
  const other = registry.create(agent('c'));
  spawned[1].emitExit(0);

  registry.close(running.id);
  assert.equal(spawned[0].killed, true, 'the bash still gets its hangup first');
  assert.deepEqual(stops, [[`mirador-agent-${running.id}`]], 'stopped right away; close() returned before the stop finished');
  registry.close(exited.id);
  assert.deepEqual(stops[1], [`mirador-shell-${exited.id}`], 'an exited terminal\'s scope may still hold what it left behind');
  assert.deepEqual(registry.list().map((t) => t.id), [other.id]);

  // A shutdown right after waits for the stops already under way too.
  let done = false;
  const closing = registry.closeAll().then(() => (done = true));
  assert.deepEqual(stops[2], [`mirador-agent-${other.id}`]);
  releases[2]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, 'the two earlier stops are still under way');
  releases[0]();
  releases[1]();
  await closing;
  assert.equal(done, true);
});

test('R1b: with scopes off, closing a terminal only hangs it up, as before', () => {
  const stops: string[][] = [];
  const { registry, spawned } = registryWith({ scopes: false, stopScopes: async (units) => (stops.push(units), []) });
  const info = registry.create(agent('a'));
  registry.close(info.id);
  assert.equal(spawned[0].killed, true);
  assert.deepEqual(stops, []);
  assert.deepEqual(registry.list(), []);
});

test('once closeAll began, no terminal is created any more (a batch or restore waking up during a shutdown leaves no agent behind)', async () => {
  const { registry, spawned } = registryWith({ scopes: true, stopScopes: async () => [] });
  registry.create(agent('a'));
  const closing = registry.closeAll();
  assert.throws(() => registry.create(agent('b')), /shutting down/);
  await closing;
  assert.equal(spawned.length, 1);
  assert.deepEqual(registry.list(), []);
});

test('a restore first ends what still runs of the previous agents, and does not reopen one whose scope is still running', async () => {
  const dir = join(scratch, 'restore');
  await mkdir(dir, { recursive: true });
  const owner = join(dir, 'config.json');
  await writeFile(owner, '{}');
  const file = join(dir, 'open-agents.json');
  const old = (id: string, rel: string): OpenAgentRecord => ({ id, workspaceId: 'dev', rel, cwd: `/w/${rel}`, cols: 100, rows: 30, sessionFile: null, createdAt: '2026-10-29T00:00:00.000Z' });
  await writeFile(file, JSON.stringify({ owner, agents: [old('old-a', 'a'), old('old-b', 'b')] }), { mode: 0o600 });
  const logs: string[] = [];
  const store = await OpenAgents.load(file, { owner, log: (line) => void logs.push(line) });
  const { registry } = registryWith({ scopes: false });
  store.track(registry);

  const asked: Array<{ ids: string[]; openBefore: number }> = [];
  const result = await store.restore({
    registry,
    resolveFolder: async (workspaceId, rel) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` }),
    sessionArgs: (session) => ['--session', session],
    sleep: async () => undefined,
    endPrevious: async (records) => {
      asked.push({ ids: records.map((r) => r.id), openBefore: registry.list().length });
      return ['old-a'];
    },
  });
  await store.flush();

  assert.deepEqual(asked, [{ ids: ['old-a', 'old-b'], openBefore: 0 }], 'asked once, before any agent reopens');
  assert.deepEqual(registry.list().map((t) => t.rel), ['b'], 'the agent still running is not opened a second time');
  assert.deepEqual(result, { restored: 1, dropped: 0 });
  const saved = JSON.parse(await readFile(file, 'utf8')) as { agents: OpenAgentRecord[] };
  assert.deepEqual(saved.agents.map((r) => [r.id, r.rel]), [['old-a', 'a'], [registry.list()[0].id, 'b']], 'its record stays for the next start');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /workspace "dev" folder "a" .*still running.*not reopened/);
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

test('the server\'s shutdown stops its terminals\' scopes, and the next start reopens only the agents whose old scope is gone', { skip: process.platform === 'darwin' && 'needs terminal scopes (systemd-run, systemctl): on macOS the server turns them off without probing' }, async () => {
  const dir = join(scratch, 'server');
  const bin = join(dir, 'bin');
  const root = join(dir, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(root, 'beta'), { recursive: true });
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  const systemctl = await fakeSystemctl(bin);
  // Like `systemd-run --scope`, the fake runs the command after `--` in place.
  await writeFile(join(bin, 'systemd-run'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', agentCommand: 'sleep 600 #', launches: { reserveMb: 0 } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  let server: ChildProcess;

  const start = async () => {
    output = '';
    server = spawn(process.execPath, ['src/server.ts'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GENTLE_SHELL_HOME: join(dir, 'no-gentle-shell'),
        XDG_RUNTIME_DIR: join(dir, 'run'),
        XDG_CONFIG_HOME: join(dir, 'cfg'),
        XDG_STATE_HOME: join(dir, 'state'),
        MIRADOR_PORT: String(port),
        MIRADOR_SCOPES: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(server);
    server.stdout?.on('data', (d) => (output += d));
    server.stderr?.on('data', (d) => (output += d));
    const state = await waitFor(async () => JSON.parse(await readFile(join(dir, 'run', 'mirador', 'state.json'), 'utf8')));
    const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
    const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    const token = ((await session.json()) as { token: string }).token;
    return (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  };

  try {
    let api = await start();
    assert.match(output, /terminal scopes on/);
    const open = async (rel: string) => ((await (await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 80, rows: 24 })).json()) as { id: string }).id;
    const alpha = await open('alpha');
    const beta = await open('beta');
    await waitFor(async () => (JSON.parse(await readFile(join(dir, 'state', 'mirador', 'open-agents.json'), 'utf8')).agents.length === 2 ? true : undefined));

    await stop();
    const atShutdown = await systemctl.calls();
    assert.deepEqual(atShutdown.filter((c) => c.includes(' stop ')).sort(), [`--user stop -- mirador-agent-${alpha}.scope`, `--user stop -- mirador-agent-${beta}.scope`].sort());

    // alpha's old agent outlived the stop (its scope still runs); beta's is gone.
    await systemctl.setState(`mirador-agent-${alpha}.scope`, 'active');
    api = await start();
    const reopened = await waitFor(async () => {
      const list = (await (await api('GET', '/api/terminals')).json()) as Array<{ id: string; rel: string }>;
      return /reopened 1 agent/.test(output) ? list : undefined;
    });
    assert.deepEqual(reopened.map((t) => t.rel), ['beta'], 'alpha is not opened a second time next to its old agent');
    const atStart = (await systemctl.calls()).slice(atShutdown.length);
    assert.deepEqual(atStart.slice(0, 2).sort(), [`--user stop -- mirador-agent-${alpha}.scope`, `--user stop -- mirador-agent-${beta}.scope`].sort());
    assert.equal(atStart[2], `--user is-active -- mirador-agent-${alpha}.scope mirador-agent-${beta}.scope`);
    assert.match(output, /folder "alpha" .*still running.*not reopened/);
    // The records file is written in the background, after the log line: wait for the write that adds beta's new agent.
    const saved = await waitFor(async () => {
      const records = JSON.parse(await readFile(join(dir, 'state', 'mirador', 'open-agents.json'), 'utf8')) as { agents: OpenAgentRecord[] };
      return records.agents.some((r) => r.id === reopened[0].id) ? records : undefined;
    });
    assert.deepEqual(saved.agents.map((r) => [r.id, r.rel]), [[alpha, 'alpha'], [reopened[0].id, 'beta']]);
  } finally {
    await stop();
  }
});

// `mirador stop`: it signals the server and then polls `kill -0` until the
// process is gone, so `mirador stop && mirador` never meets the old server or its port.

/** `kill -0`: whether a process with this pid still exists (a zombie still does). */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** ps's state letters for `pid` ("Z" for a zombie), or '' when there is no such process. */
function psState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Resolves once a new listener can take 127.0.0.1:`port`; rejects (EADDRINUSE) while something still holds it. */
async function listenOn(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}

/**
 * A stand-in for src/server.ts in `dir` (the launcher only stops a process whose command line names src/server.ts).
 * Like the real server it listens on a port it never closes itself, so only its exit frees the port. `onTerm` is its
 * SIGTERM handler's body; it writes `ready` once that handler is in place and it listens.
 */
async function standIn(dir: string, onTerm: string): Promise<{ script: string; ready: () => Promise<true>; port: number }> {
  const port = await freePort();
  const ready = join(dir, 'ready');
  const script = join(dir, 'fake', 'src', 'server.ts');
  await mkdir(join(dir, 'fake', 'src'), { recursive: true });
  await writeFile(script, [
    "const { writeFileSync } = process.getBuiltinModule('node:fs');",
    "const { createServer } = process.getBuiltinModule('node:http');",
    `process.on('SIGTERM', () => { ${onTerm} });`,
    `createServer().listen(${port}, '127.0.0.1', () => writeFileSync(${JSON.stringify(ready)}, ''));`,
    '',
  ].join('\n'));
  // Signalled before its handler is in place, it would die at once and prove nothing.
  return { script, port, ready: () => waitFor(async () => ((await access(ready).then(() => true, () => false)) ? true : undefined)) };
}

/** The launcher's state file in `dir`, naming `pid` as the server. */
async function writeState(dir: string, pid: number, port: number): Promise<void> {
  await mkdir(join(dir, 'run', 'mirador'), { recursive: true });
  await writeFile(join(dir, 'run', 'mirador', 'state.json'), JSON.stringify({ pid, port, launchSecret: 'x' }));
}

/** Runs `bin/mirador stop` against `dir`'s state file; `atClose` looks at the world the moment stop returns. */
function runStop<T>(dir: string, atClose: () => T, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number; atClose: T }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(join(APP_DIR, 'bin', 'mirador'), ['stop'], { env: { ...process.env, XDG_RUNTIME_DIR: join(dir, 'run'), XDG_STATE_HOME: join(dir, 'state'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    // Past its own 30 s limit: a stop that hangs fails the test instead of the run.
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - startedAt, atClose: atClose() });
    });
  });
}

test('mirador stop returns once the server process is gone and its port is free, not when the signal is sent or its command line changes', async () => {
  const dir = join(scratch, 'launcher');
  const shutDown = join(dir, 'shut-down');
  // A stand-in that takes 1.5 s to shut down, like one stopping its terminals' scopes. As its shutdown begins its
  // command line stops naming src/server.ts, as an exiting process's reads empty while the process is still there.
  // It writes shut-down right before it exits.
  const fake = await standIn(dir, `process.title = 'exiting'; setTimeout(() => { writeFileSync(${JSON.stringify(shutDown)}, ''); process.exit(0); }, 1500);`);
  const server = spawn(process.execPath, [fake.script], { stdio: 'ignore' });
  children.push(server);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  server.once('exit', (code, signal) => (exited = { code, signal }));
  await writeState(dir, server.pid!, fake.port);
  await fake.ready();

  const result = await runStop(dir, () => ({ shutDown: existsSync(shutDown), state: psState(server.pid!) }));

  assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: stopped\n', '']);
  assert.equal(result.atClose.shutDown, true, 'the server had ended its 1.5 s shutdown when stop returned');
  // Gone, or an exited zombie this test process (its parent) has not reaped yet: stop counts a zombie as stopped,
  // and Node reaps its child on its own schedule, so kill -0 can still find it for a moment.
  // ps may add flags after the Z (N for a lowered priority, + in a foreground group).
  assert.match(result.atClose.state, /^(Z\S*)?$/, 'the server was still running when stop returned');
  const exit = exited ?? (await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))));
  assert.deepEqual(exit, { code: 0, signal: null }, 'it exited from its SIGTERM handler, not killed by the signal');
  await listenOn(fake.port);
});

test('mirador stop counts a server that has exited but is never reaped (a zombie of a parent that does not wait) as stopped at once', async () => {
  const dir = join(scratch, 'zombie');
  const fake = await standIn(dir, 'process.exit(0);');
  const pidFile = join(dir, 'server.pid');
  // bash starts the stand-in and then becomes `sleep`, which never reaps a child: once the stand-in exits it stays a
  // zombie, which kill -0 still finds (some containers run a pid 1 that is no init and reap nothing either).
  const parent = spawn('bash', ['-c', `'${process.execPath}' '${fake.script}' </dev/null >/dev/null 2>&1 & echo $! >'${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}' && exec sleep 600`], { stdio: 'ignore' });
  children.push(parent);
  try {
    const pid = await waitFor(async () => Number(await readFile(pidFile, 'utf8')) || undefined);
    await fake.ready();
    await writeState(dir, pid, fake.port);

    const result = await runStop(dir, () => psState(pid));

    assert.deepEqual([result.code, result.stdout, result.stderr], [0, 'mirador: stopped\n', '']);
    // A zombie has let go of its port already: stop reports it gone on sight, with no grace period (the old one was 1 s).
    assert.ok(result.ms < 900, `stop took ${result.ms} ms; a zombie counts as stopped as soon as ps shows it`);
    assert.match(result.atClose, /Z/, 'the stand-in was still an unreaped zombie when stop returned');
    await listenOn(fake.port);
  } finally {
    parent.kill('SIGKILL');
  }
});

test('mirador stop still gives up after its 300 polls of 0.1 s when the server ignores SIGTERM, says so, exits 1 and leaves the server running', async () => {
  const dir = join(scratch, 'stuck');
  const fake = await standIn(dir, '');
  const server = spawn(process.execPath, [fake.script], { stdio: 'ignore' });
  children.push(server);
  // A `sleep` that logs its argument and returns at once, so the 30 s of polls run in a moment.
  const bin = join(dir, 'bin');
  const sleeps = join(dir, 'sleeps.log');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'sleep'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sleeps}'\n`, { mode: 0o755 });
  try {
    await writeState(dir, server.pid!, fake.port);
    await fake.ready();

    const result = await runStop(dir, () => exists(server.pid!), { PATH: `${bin}:${process.env.PATH}` });

    assert.deepEqual([result.code, result.stdout, result.stderr], [1, '', `mirador: the server (pid ${server.pid}) is still stopping after 30 s; see ${join(dir, 'state', 'mirador', 'server.log')}\n`]);
    assert.equal(result.atClose, true, 'stop does not kill a server that outlives its limit');
    const polls = (await readFile(sleeps, 'utf8')).split('\n').filter(Boolean);
    assert.deepEqual([polls.length, [...new Set(polls)]], [300, ['0.1']]);
  } finally {
    server.kill('SIGKILL');
  }
});
