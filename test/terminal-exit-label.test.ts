// How an ended terminal is labelled: one stopped
// by a signal says so instead of "exited 0", and one the system stopped for lack of memory (its
// scope's unit result 'oom-kill' in the user journal) says that. Fake systemd-run and journalctl
// in scratch dirs: no test reaches the real systemd.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '../public/i18n.js';
import { exitLabels } from '../public/terminal-groups.js';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalInfo } from '../src/terminals/registry.ts';
import { scopeOomKilled } from '../src/terminals/scopes.ts';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const WebSocket = createRequire(import.meta.url)('ws');

let scratch: string;
const children: ChildProcess[] = [];
const strays: number[] = [];
before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-exit-label-')));
});
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await rm(scratch, { recursive: true, force: true });
});

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

const labels = (language: string, info: Partial<TerminalInfo>) => exitLabels(info, (key: string, vars?: Record<string, unknown>) => translate(language, key, vars));

test('a terminal stopped by a signal says so in its tab and pane, and one the system stopped for lack of memory says that; Spanish and English', () => {
  assert.deepEqual(labels('es', { status: 'exited', exitCode: 0, exitSignal: 9 }), {
    tab: 'detenido (señal 9)',
    line: '[el proceso se detuvo por la señal 9; cierra esta terminal con ×]',
  });
  assert.deepEqual(labels('es', { status: 'exited', exitCode: 0, exitSignal: 9, oomKilled: true }), {
    tab: 'detenido: sin memoria',
    line: '[el sistema detuvo el proceso por falta de memoria; cierra esta terminal con ×]',
  });
  assert.deepEqual(labels('en', { status: 'exited', exitCode: 0, exitSignal: 9 }), {
    tab: 'stopped (signal 9)',
    line: '[process stopped by signal 9; close this terminal with ×]',
  });
  assert.deepEqual(labels('en', { status: 'exited', exitCode: 0, exitSignal: 9, oomKilled: true }), {
    tab: 'stopped: out of memory',
    line: '[the system stopped the process for lack of memory; close this terminal with ×]',
  });
});

test('a terminal that exits with a code keeps its label as before', () => {
  assert.deepEqual(labels('es', { status: 'exited', exitCode: 0 }), { tab: 'terminó 0', line: '[el proceso terminó con código 0; cierra esta terminal con ×]' });
  assert.deepEqual(labels('es', { status: 'exited', exitCode: 3 }), { tab: 'terminó 3', line: '[el proceso terminó con código 3; cierra esta terminal con ×]' });
  assert.deepEqual(labels('en', { status: 'exited', exitCode: 3 }), { tab: 'exited 3', line: '[process exited with code 3; close this terminal with ×]' });
});

/** A fake journalctl in `dir` that logs its arguments and, for a unit listed in `oom-units`, prints its oom-kill line from call `fromCall` on. */
async function fakeJournalctl(dir: string, oomUnits: string[], fromCall = 1) {
  await mkdir(dir, { recursive: true });
  const command = join(dir, 'journalctl');
  const log = join(dir, 'journalctl.log');
  await writeFile(join(dir, 'oom-units'), oomUnits.map((unit) => `USER_UNIT=${unit}.scope\n`).join(''));
  await writeFile(command, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    `[ "$(wc -l < '${log}')" -ge ${fromCall} ] || exit 0`,
    `if grep -qx "$2" '${join(dir, 'oom-units')}'; then echo "\${2#USER_UNIT=}: Failed with result 'oom-kill'."; fi`,
    '',
  ].join('\n'));
  await chmod(command, 0o755);
  return { command, calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

test('scopeOomKilled reads the scope\'s oom-kill result from the user journal, asking again while the line is not there yet', async () => {
  const late = await fakeJournalctl(join(scratch, 'journal-late'), ['mirador-agent-a'], 3);
  assert.equal(await scopeOomKilled('mirador-agent-a', { command: late.command, attempts: 4, delayMs: 10 }), true);
  assert.deepEqual(await late.calls(), Array(3).fill('--user USER_UNIT=mirador-agent-a.scope UNIT_RESULT=oom-kill -o cat -n 1 -q --no-pager'));

  const never = await fakeJournalctl(join(scratch, 'journal-never'), ['mirador-agent-other']);
  assert.equal(await scopeOomKilled('mirador-agent-a', { command: never.command, attempts: 4, delayMs: 10 }), false, 'no line, no guess');
  assert.equal((await never.calls()).length, 4);

  assert.equal(await scopeOomKilled('mirador-agent-a', { command: join(scratch, 'missing-journalctl'), attempts: 2, delayMs: 10 }), false, 'no journalctl, no guess');
});

class FakePty implements PtyProcess {
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  onData() {}
  onExit(listener: (e: { exitCode: number; signal?: number }) => void) { this.exitListeners.push(listener); }
  write() {}
  resize() {}
  kill() {}
  emitExit(exitCode: number, signal?: number) { this.exitListeners.forEach((l) => l(signal === undefined ? { exitCode } : { exitCode, signal })); }
}

function registryWith(scopes: boolean, oomKilled: (unit: string) => Promise<boolean>) {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = () => {
    const pty = new FakePty();
    spawned.push(pty);
    return pty;
  };
  return { registry: new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 1000, scopes, oomKilled }), spawned };
}

test('a scoped terminal killed by a signal tells its windows once Mirador knows whether it was out of memory; other exits tell them at once', async () => {
  const asked: string[] = [];
  let answer!: (oom: boolean) => void;
  const { registry, spawned } = registryWith(true, (unit) => {
    asked.push(unit);
    return new Promise((resolve) => (answer = resolve));
  });
  const killed = registry.create({ cwd: '/w', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const clean = registry.create({ cwd: '/w', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const told: Array<[string, number, TerminalInfo | undefined]> = [];
  const events: string[] = [];
  registry.subscribe(({ type, info }) => events.push(`${type} ${info.id}`));
  registry.attach(killed.id, { onData() {}, onExit: (code, info) => told.push([killed.id, code, info]) });
  registry.attach(clean.id, { onData() {}, onExit: (code, info) => told.push([clean.id, code, info]) });

  spawned[1].emitExit(0);
  spawned[0].emitExit(0, 9);
  assert.deepEqual(told.map(([id, code]) => [id, code]), [[clean.id, 0]], 'a clean exit is told at once');
  assert.deepEqual(events, [`exited ${clean.id}`, `exited ${killed.id}`], 'subscribers hear both exits at once, as before');
  assert.deepEqual([registry.get(killed.id)?.status, registry.get(killed.id)?.exitSignal], ['exited', 9]);
  assert.deepEqual(asked, [`mirador-agent-${killed.id}`], 'only the signal exit is looked up');

  answer(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get(killed.id)?.oomKilled, true);
  assert.deepEqual(told.map(([id, code, info]) => [id, code, info?.exitSignal, info?.oomKilled]), [[clean.id, 0, undefined, undefined], [killed.id, 0, 9, true]]);
});

test('with scopes off a signal exit is told at once and never looked up', () => {
  const asked: string[] = [];
  const { registry, spawned } = registryWith(false, async (unit) => (asked.push(unit), true));
  const killed = registry.create({ cwd: '/w', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const told: Array<number | undefined> = [];
  registry.attach(killed.id, { onData() {}, onExit: (_code, info) => told.push(info?.exitSignal) });
  spawned[0].emitExit(0, 9);
  assert.deepEqual(told, [9]);
  assert.deepEqual(asked, []);
  assert.equal(registry.get(killed.id)?.oomKilled, undefined);
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

test('the server tells a window that its terminal was stopped by the system for lack of memory, and lists it so', { skip: process.platform === 'darwin' && 'needs terminal scopes (systemd-run, journalctl): on macOS the server turns them off without probing, so no OOM kill is looked up' }, async () => {
  const dir = join(scratch, 'server');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  await mkdir(join(dir, 'root'), { recursive: true });
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'systemd-run'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  // Every unit was oom-killed, as far as this journal knows.
  await writeFile(join(bin, 'journalctl'), '#!/bin/sh\necho "${2#USER_UNIT=}: Failed with result \'oom-kill\'."\n', { mode: 0o755 });
  // The stand-in agent writes the pid of its terminal's shell and its own, then idles.
  await writeFile(join(bin, 'agent'), '#!/bin/sh\necho "$PPID $$" > "$HOME/pids-$HERDR_PANE_ID"\nexec sleep 600\n', { mode: 0o755 });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(dir, 'root'), engramUrl: 'http://127.0.0.1:9', agentCommand: `${join(bin, 'agent')} #` }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      GENTLE_SHELL_HOME: join(dir, 'no-gentle-shell'),
      XDG_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'cfg'),
      XDG_STATE_HOME: join(dir, 'state'),
      MIRADOR_PORT: String(port),
      MIRADOR_SCOPES: '',
    },
    stdio: 'ignore',
  });
  children.push(server);
  try {
    const state = await waitFor(async () => JSON.parse(await readFile(join(dir, 'run', 'mirador', 'state.json'), 'utf8')));
    const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
    const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
    const token = ((await (await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) })).json()) as { token: string }).token;
    const api = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    const { id } = (await (await api('POST', '/api/terminals', { ws: 'dev', rel: '', kind: 'agent', cols: 80, rows: 24 })).json()) as { id: string };
    const [shellPid, agentPid] = (await waitFor(async () => readFile(join(home, `pids-${id}`), 'utf8'))).trim().split(' ').map(Number);
    strays.push(agentPid);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${id}`, ['mirador.v1', `auth.${token}`], { headers: { origin: base } });
    const exit = new Promise<{ t: string; code: number; info?: TerminalInfo }>((resolve) => ws.on('message', (raw: Buffer) => {
      const message = JSON.parse(String(raw));
      if (message.t === 'x') resolve(message);
    }));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    process.kill(shellPid, 'SIGKILL');
    const message = await exit;
    ws.terminate();
    assert.equal(message.code, 0);
    assert.deepEqual([message.info?.status, message.info?.exitSignal, message.info?.oomKilled], ['exited', 9, true]);
    const listed = (await (await api('GET', '/api/terminals')).json()) as TerminalInfo[];
    assert.deepEqual(listed.map((t) => [t.id, t.exitCode, t.exitSignal, t.oomKilled]), [[id, 0, 9, true]]);
  } finally {
    server.kill('SIGTERM');
  }
});
