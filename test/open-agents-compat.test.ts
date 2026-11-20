// Verifier probes (risk item 1): a restore file written
// by the previous Mirador (no `lastState`) loads with nothing dropped, every record reopens, and the
// rewritten file keeps the same fields, gaining `lastState` only once a state is known; a sleeping
// record survives restarts byte-for-byte. Real OpenAgents and registry, fake pty, real files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-compat-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}
const spawn: SpawnFn = () => new FakePty();
const setup = () => new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000 });

let counter = 0;
async function place() {
  const dir = join(scratch, `case-${++counter}`);
  await mkdir(join(dir, 'state'), { recursive: true });
  const owner = join(dir, 'config.json');
  await writeFile(owner, '{}');
  const logs: string[] = [];
  return { file: join(dir, 'state', 'open-agents.json'), owner, logs, log: (line: string) => void logs.push(line) };
}
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { owner: string; agents: Array<Record<string, unknown>> };
const resolveFolder = async (workspaceId: string, rel: string) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` });
const sessionArgs = (file: string) => ['--session', file];
const roomy = () => new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }), sleep: async () => undefined });
const running = (registry: TerminalRegistry) => registry.list().filter((t) => t.kind === 'agent' && t.status === 'running').map((t) => t.rel).sort();
const PREVIOUS_KEYS = ['id', 'workspaceId', 'rel', 'cwd', 'cols', 'rows', 'sessionFile', 'createdAt'];
const record = (i: number, rel: string, extra: Record<string, unknown> = {}) => ({ id: `old-${i}`, workspaceId: 'dev', rel, cwd: `/w/${rel}`, cols: 100, rows: 30, sessionFile: null, createdAt: `2026-10-29T00:00:0${i}.000Z`, ...extra });

function fakeTimers() {
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void) => {
    const timer = { run, cancelled: false };
    timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  return { schedule, fire: () => timers.filter((t) => !t.cancelled).forEach((t) => { t.cancelled = true; t.run(); }) };
}

test('S6/item 1: a file of the previous version reopens every record, drops none, and gains lastState only where a state is known', async () => {
  const { file, owner, log, logs } = await place();
  // Two records as e6c5e96 wrote them, and one with a value this version does not know (a hand edit): all unknown.
  await writeFile(file, JSON.stringify({ owner, agents: [record(0, 'a', { cols: 90, rows: 33 }), record(1, 'b'), record(2, 'c', { lastState: 'napping' })] }), { mode: 0o600 });
  const registry = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined }), { restored: 3, dropped: 0 });
  assert.deepEqual(running(registry), ['a', 'b', 'c']);
  assert.deepEqual(store.sleeping(), []);
  assert.ok(!logs.some((line) => /sleep|dropped/.test(line)), logs.join('\n'));
  const a = registry.list().find((t) => t.rel === 'a')!;
  assert.deepEqual([a.cols, a.rows], [90, 33], 'sizes kept');
  await store.flush();
  const saved = await read(file);
  assert.deepEqual(saved.agents.map((r) => r.rel), ['a', 'b', 'c']);
  for (const r of saved.agents) assert.deepEqual(Object.keys(r), PREVIOUS_KEYS, 'the same fields as before while the state is unknown');
  // Once one agent's state is known, only its record gains the field.
  assert.equal(store.recordState(a.id, 'finished'), true);
  timers.fire();
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['a', 'finished'], ['b', undefined], ['c', undefined]]);
});

test('S6: a sleeping record is kept byte-for-byte across two restarts that reopen the others', async () => {
  const { file, owner, log } = await place();
  const sleeper = record(0, 's', { cols: 120, rows: 40, lastState: 'finished' });
  await writeFile(file, JSON.stringify({ owner, agents: [sleeper, record(1, 'w', { lastState: 'working' })] }), { mode: 0o600 });
  for (let start = 1; start <= 2; start++) {
    const registry = setup();
    const store = await OpenAgents.load(file, { owner, log });
    store.track(registry);
    assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, gate: roomy(), sleep: async () => undefined }), { restored: 1, dropped: 0 }, `start ${start}`);
    assert.deepEqual(running(registry), ['w']);
    assert.deepEqual(store.sleeping(), [{ id: 'old-0', workspaceId: 'dev', rel: 's', createdAt: sleeper.createdAt, resumable: false }]);
    store.keep();
    await store.flush();
    const saved = await read(file);
    assert.deepEqual(saved.agents.find((r) => r.id === 'old-0'), sleeper, `the sleeping record is written back unchanged (start ${start})`);
    assert.equal(saved.agents.length, 2, 'the reopened agent replaced its record; nothing else was added or lost');
  }
});
