// Verifier probes (risk item 4): a wake asked once the
// server began to stop opens nothing and the agent sleeps on; Pausar during a wake leaves the rest
// asleep, hidden from the list only while the run lives. Real OpenAgents, registry and gate, fake pty.
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
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-wake-')));
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
async function place(agents: Array<{ rel: string; lastState: string }>) {
  const dir = join(scratch, `case-${++counter}`);
  await mkdir(join(dir, 'state'), { recursive: true });
  const owner = join(dir, 'config.json');
  await writeFile(owner, '{}');
  const file = join(dir, 'state', 'open-agents.json');
  const full = agents.map((a, i) => ({ id: `old-${i}`, workspaceId: 'dev', rel: a.rel, cwd: `/w/${a.rel}`, cols: 100, rows: 30, sessionFile: null, createdAt: '2026-10-29T00:00:00.000Z', lastState: a.lastState }));
  await writeFile(file, JSON.stringify({ owner, agents: full }), { mode: 0o600 });
  return { file, owner, log: () => undefined };
}
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { agents: Array<{ rel: string; lastState?: string }> };
const resolveFolder = async (workspaceId: string, rel: string) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` });
const sessionArgs = (file: string) => ['--session', file];
const memory = async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 });
const running = (registry: TerminalRegistry) => registry.list().filter((t) => t.kind === 'agent' && t.status === 'running').map((t) => t.rel).sort();
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), 'condition not reached');
};

test('item 4: a wake once the server began to stop opens nothing; the agent sleeps on and is listed again at the next start', async () => {
  const { file, owner, log } = await place([{ rel: 's', lastState: 'finished' }, { rel: 'w', lastState: 'working' }]);
  const registry = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  await store.restore({ registry, resolveFolder, sessionArgs, gate: new LaunchGate({ readMemory: memory, sleep: async () => undefined }), sleep: async () => undefined });
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['s']);
  store.keep();
  assert.equal(store.wake({ id: 'old-0' }), null, 'one agent');
  assert.equal(store.wake(), null, 'all');
  assert.deepEqual(running(registry), ['w'], 'nothing opened');
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['s'], 'still listed');
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['s', 'finished'], ['w', undefined]], 'the reopened agent has no state until its bridge reports');
  const next = await OpenAgents.load(file, { owner, log });
  const second = setup();
  next.track(second);
  await next.restore({ registry: second, resolveFolder, sessionArgs, gate: new LaunchGate({ readMemory: memory, sleep: async () => undefined }), sleep: async () => undefined });
  assert.deepEqual(next.sleeping().map((s) => s.rel), ['s']);
  await next.flush();
});

test('item 4: Pausar during a wake leaves the rest asleep, hidden only while the run lives; an agent being woken is not woken twice', async () => {
  const { file, owner, log } = await place([{ rel: 's1', lastState: 'finished' }, { rel: 's2', lastState: 'finished' }, { rel: 's3', lastState: 'finished' }]);
  const registry = setup();
  // Batches of one with a long settle: the second agent waits in the gate until Pausar.
  let settle: (() => void) | null = null;
  const gate = new LaunchGate({
    readMemory: memory,
    limits: { batchSize: 1, settleMs: 60_000 },
    sleep: (_ms, signal) => new Promise((resolve) => {
      settle = () => resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  });
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  await store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined });
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['s1', 's2', 's3']);
  const woken = store.wake();
  assert.ok(woken && woken.runId, 'a wake run');
  assert.equal(woken.count, 3);
  await until(() => running(registry).length === 1 && gate.status().runs[0]?.wait?.reason === 'settle');
  assert.deepEqual(store.sleeping(), [], 'agents being woken are not listed meanwhile');
  assert.equal(store.wake({ id: 'old-1' }), null, 'not woken twice');
  assert.equal(gate.cancel(woken.runId!), true);
  assert.deepEqual(await woken.done, { restored: 1, dropped: 0 });
  assert.deepEqual(running(registry), ['s1']);
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['s2', 's3'], 'the rest sleep on and are listed again');
  const run = gate.status().runs.find((r) => r.id === woken.runId)!;
  assert.deepEqual([run.kind, run.state, run.opened, run.cancelled, run.notOpened?.map((f) => f.rel)], ['wake', 'done', 1, 2, ['s2', 's3']]);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r) => [r.rel, r.lastState]), [['s2', 'finished'], ['s3', 'finished'], ['s1', undefined]]);
  // Waking what is left works again.
  const again = store.wake({ id: 'old-1' });
  assert.equal(again?.count, 1);
  // It waits for the settle after s1, as the gate asks; letting the settle end opens it.
  while (running(registry).length < 2) {
    settle?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await again!.done, { restored: 1, dropped: 0 });
  assert.deepEqual(store.sleeping().map((s) => s.rel), ['s3']);
  await store.flush();
});
