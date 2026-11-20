// The startup decision on terminal scopes, with a fake systemd-run: never the real systemd.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { ensureSpawnHelper } from '../src/system/pty-helper.ts';
import { decideScopes, probeScopes, scopeCommand } from '../src/terminals/scopes.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const PROBE_ARGS = '--user --scope --collect --quiet --expand-environment=no -- true';
/** The decision's probe rules are Linux's; macOS turns scopes off before any probe (test/macos-degradation.test.ts). */
const LINUX = 'linux' as const;
/** The server on the host decides with process.platform: on macOS it never probes, so these tests have nothing to see there. */
const SCOPES_NEED_LINUX = process.platform === 'darwin' && 'terminal scopes need systemd: on macOS the server turns them off without probing (covered in test/macos-degradation.test.ts)';

let scratch: string;
const started: ChildProcess[] = [];

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-scopes-')));
});

after(async () => {
  for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
});

/** A fake systemd-run in its own folder that records its arguments, then runs `body`. */
async function fakeSystemdRun(name: string, body: string): Promise<{ dir: string; command: string; calls: () => Promise<string[]> }> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  const command = join(dir, 'systemd-run');
  const log = join(dir, 'calls.log');
  await writeFile(command, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`);
  await chmod(command, 0o755);
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { dir, command, calls };
}

test('the probe creates a throwaway scope running `true` and passes when it exits 0', async () => {
  const fake = await fakeSystemdRun('works', 'exit 0');
  assert.equal(await probeScopes(fake.command), null);
  assert.deepEqual(await fake.calls(), [PROBE_ARGS]);
});

test('the probe fails with the first line systemd-run printed when it exits non-zero', async () => {
  const fake = await fakeSystemdRun('no-bus', "echo 'Failed to connect to user scope bus via local transport: No such file or directory' >&2\necho second >&2\nexit 1");
  assert.equal(await probeScopes(fake.command), 'Failed to connect to user scope bus via local transport: No such file or directory');
  assert.deepEqual(await fake.calls(), [PROBE_ARGS]);
});

test('the probe fails when systemd-run is missing or does not answer in time', async () => {
  assert.match((await probeScopes(join(scratch, 'missing', 'systemd-run'))) ?? '', /ENOENT/);
  const fake = await fakeSystemdRun('hangs', 'exec sleep 5');
  const startedAt = Date.now();
  assert.equal(await probeScopes(fake.command, 200), 'no answer within 200 ms');
  assert.ok(Date.now() - startedAt < 2000, 'the probe does not wait for systemd-run');
});

test('scopes are on only when the probe works', async () => {
  assert.deepEqual(await decideScopes({ config: {}, env: {}, probe: async () => null, platform: LINUX }), {
    enabled: true,
    message: 'mirador: terminal scopes on: each terminal runs in its own systemd user scope (mirador-<kind>-<id>.scope)',
  });
  assert.deepEqual(await decideScopes({ config: { scopes: true }, env: { MIRADOR_SCOPES: '1' }, probe: async () => 'Failed to connect to bus', platform: LINUX }), {
    enabled: false,
    message: 'mirador: terminal scopes off: systemd-run --user --scope failed (Failed to connect to bus)',
  });
});

test('MIRADOR_SCOPES=0 or config scopes: false turn scopes off without probing', async () => {
  let probed = 0;
  const probe = async () => {
    probed++;
    return null;
  };
  assert.deepEqual(await decideScopes({ config: {}, env: { MIRADOR_SCOPES: '0' }, probe, platform: LINUX }), { enabled: false, message: 'mirador: terminal scopes off (MIRADOR_SCOPES=0)' });
  assert.deepEqual(await decideScopes({ config: { scopes: false }, env: {}, probe, platform: LINUX }), { enabled: false, message: 'mirador: terminal scopes off (config scopes: false)' });
  assert.equal(probed, 0);
});

const LISTENING = /^Mirador listening on http:\/\/127\.0\.0\.1:(\d+) /m;

/** Resolves once a TCP connection to 127.0.0.1:`port` opens: something really listens there. */
function accepts(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

/**
 * Starts src/server.ts with the fake systemd-run first in PATH and resolves with its output once it
 * listens, after stopping it. It listens on port 0, so the kernel picks a free port at bind time: no
 * other process can take it between a pick and the listen. The listening line names the bound port.
 */
async function startServer(name: string, fakeDir: string, extraEnv: Record<string, string> = {}, extraConfig: object = {}): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  await mkdir(join(dir, 'root'), { recursive: true });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(dir, 'root'), engramUrl: 'http://127.0.0.1:1', ...extraConfig }));
  // The scope setting comes from each test, never from the shell that runs the suite (MIRADOR_SCOPES=0 there).
  const inherited = { ...process.env };
  delete inherited.MIRADOR_SCOPES;
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...inherited,
      PATH: `${fakeDir}:${process.env.PATH}`,
      HOME: join(dir, 'home'),
      XDG_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'cfg'),
      XDG_STATE_HOME: join(dir, 'state'),
      MIRADOR_PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // After 'close' its output is complete: 'exit' can come before the last of it.
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const deadline = Date.now() + 8000;
  while (!output.includes('Mirador listening') && Date.now() < deadline) {
    if (child.exitCode !== null) {
      await closed;
      throw new Error(`server exited: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const port = Number(LISTENING.exec(output)?.[1]);
  assert.ok(port > 0, `the listening line names the port the server bound, not 0: ${JSON.stringify(output)}`);
  await accepts(port);
  child.kill('SIGTERM');
  // Gone before the next start: no server outlives its test.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([exited, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the server did not exit 8 s after SIGTERM: ${output}`)), 8000)))]).finally(() => clearTimeout(timer));
  return output;
}

const scopeLines = (output: string) => output.split('\n').filter((line) => line.includes('terminal scopes'));

test('the server probes once at startup and logs the result in one line', { skip: SCOPES_NEED_LINUX }, async () => {
  const works = await fakeSystemdRun('server-works', 'exit 0');
  assert.deepEqual(scopeLines(await startServer('server-on', works.dir)), [
    'mirador: terminal scopes on: each terminal runs in its own systemd user scope (mirador-<kind>-<id>.scope)',
  ]);
  assert.deepEqual(await works.calls(), [PROBE_ARGS]);

  const fails = await fakeSystemdRun('server-fails', "echo 'Failed to connect to bus' >&2\nexit 1");
  assert.deepEqual(scopeLines(await startServer('server-off', fails.dir)), ['mirador: terminal scopes off: systemd-run --user --scope failed (Failed to connect to bus)']);
  assert.deepEqual(await fails.calls(), [PROBE_ARGS]);
});

test('the server does not probe with MIRADOR_SCOPES=0 or config scopes: false', async () => {
  const works = await fakeSystemdRun('server-opt-out', 'exit 0');
  assert.deepEqual(scopeLines(await startServer('server-opt-out-env', works.dir, { MIRADOR_SCOPES: '0' })), ['mirador: terminal scopes off (MIRADOR_SCOPES=0)']);
  assert.deepEqual(scopeLines(await startServer('server-opt-out-config', works.dir, {}, { scopes: false })), ['mirador: terminal scopes off (config scopes: false)']);
  assert.deepEqual(await works.calls(), []);
});

/** A port free right now. Another process can take it before the server binds it, so callers retry. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('a configured non-zero port is logged unchanged', async () => {
  // A non-zero port, so the line it pins is the configured one, not a kernel pick. The port is picked before the
  // server binds it, so another process can take it in between: on "already in use", retry with another one.
  const fake = await fakeSystemdRun('fixed-port', 'exit 0');
  const tried: number[] = [];
  let port = 0;
  let out: string | undefined;
  while (out === undefined) {
    port = await freePort();
    tried.push(port);
    try {
      out = await startServer(`fixed-port-${tried.length}`, fake.dir, { MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' });
    } catch (error) {
      if (!/is already in use/.test((error as Error).message)) throw error;
      if (tried.length >= 3) throw new Error(`each port tried was already in use when the server bound it: ${tried.join(', ')}`);
    }
  }
  assert.match(out, new RegExp(`^Mirador listening on http://127\\.0\\.0\\.1:${port} \\(\\d+ workspaces\\); open it with bin/mirador$`, 'm'));
});

test('through a scope wrapper that execs in place, the pty child is the shell itself with its $ arguments, env, cwd and exit untouched', async () => {
  // node-pty 1.1.0's macOS spawn-helper needs the execute bit the server adds at startup; this test spawns directly.
  await ensureSpawnHelper();
  const fake = await fakeSystemdRun('exec', 'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"');
  const cwd = join(scratch, 'exec');
  const c = scopeCommand('mirador-test-x', '/bin/bash', ['-c', 'echo pid=$$ cwd=$PWD a=$1 cmd=$MIRADOR_AGENT_COMMAND; exit 3', 'bash', '$$']);
  const result = await new Promise<{ pid: number; out: string; exit: { exitCode: number; signal?: number } }>((resolve) => {
    const p = pty.spawn(fake.command, c.args, { cwd, cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin', MIRADOR_AGENT_COMMAND: "gentle-shell '$$x'" } });
    let out = '';
    p.onData((d) => (out += d));
    p.onExit((exit) => resolve({ pid: p.pid, out: out.replace(/\r/g, ''), exit }));
  });
  assert.equal(result.out, `pid=${result.pid} cwd=${cwd} a=$$ cmd=gentle-shell '$$x'\n`);
  assert.deepEqual(result.exit, { exitCode: 3, signal: 0 });
  assert.match((await fake.calls())[0], /--expand-environment=no --unit=mirador-test-x -- \/bin\/bash/);
});
