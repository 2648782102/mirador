// Memory gate for agent launches ("ir por lotes"):
// agents start in batches, each batch settles before the next, and no agent starts while the
// machine's available memory is under the reserve. Fake meminfo and a fake clock for the gate;
// a real server with a reserve no machine meets for the HTTP contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH_SIZE, LaunchGate, MAX_WAIT_MS, SETTLE_MS, reserveFor } from '../src/system/memory-gate.ts';
import { readMachineMemory } from '../src/system/resources.ts';
import { scratchBase } from './helpers/scratch.ts';

const GB = 1024 ** 3;
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A gate on a fake clock: every sleep advances it and is logged; memory readings come from `available`. */
function fakeGate(available: () => number, limits: ConstructorParameters<typeof LaunchGate>[0]['limits'] = {}, memTotal = 24 * GB) {
  let clock = 1_000_000;
  const timeline: string[] = [];
  const gate = new LaunchGate({
    limits,
    now: () => clock,
    readMemory: async () => ({ memTotal, memAvailable: available() }),
    sleep: async (ms, signal) => {
      timeline.push(`sleep ${ms}`);
      if (signal.aborted) return;
      clock += ms;
    },
  });
  return { gate, timeline, advance: (ms: number) => void (clock += ms) };
}

test('the defaults: batches of 3, 45 s to settle, 10 min of waiting for memory at most, a reserve of max(2 GiB, 15 % of RAM)', () => {
  assert.equal(BATCH_SIZE, 3);
  assert.equal(SETTLE_MS, 45_000);
  assert.equal(MAX_WAIT_MS, 600_000);
  assert.equal(reserveFor({ reserveBytes: null }, 24 * GB), Math.round(0.15 * 24 * GB));
  assert.equal(reserveFor({ reserveBytes: null }, 8 * GB), 2 * GB);
  assert.equal(reserveFor({ reserveBytes: null }, null), 2 * GB);
  assert.equal(reserveFor({ reserveBytes: 5 * GB }, 24 * GB), 5 * GB);
  // Test configs set reserveMb: 0 so launches never wait on the host's memory.
  assert.equal(reserveFor({ reserveBytes: 0 }, 24 * GB), 0);
});

test('a launch waits while available memory is under the reserve, then goes', async () => {
  const readings = [1 * GB, 3 * GB, 4 * GB];
  const { gate, timeline } = fakeGate(() => readings.shift() ?? 4 * GB);
  const waits: string[] = [];
  const run = gate.run({ onWait: (reason) => waits.push(reason) });
  assert.equal(await run.next(), 'go');
  // 1 GiB and 3 GiB are under 15 % of 24 GiB (3.6 GiB); 4 GiB is not.
  assert.deepEqual(timeline, ['sleep 2000', 'sleep 2000']);
  assert.deepEqual(waits, ['memory', 'memory']);
});

test('enough memory: no wait; an unreadable meminfo never blocks a launch', async () => {
  const { gate, timeline } = fakeGate(() => 10 * GB);
  assert.equal(await gate.run().next(), 'go');
  const blind = new LaunchGate({ readMemory: async () => ({ memTotal: null, memAvailable: null }), sleep: async () => assert.fail('no wait') });
  assert.equal(await blind.run().next(), 'go');
  assert.deepEqual(timeline, []);
});

test('agents go in batches of BATCH_SIZE, and each batch settles SETTLE_MS after its last launch before the next one starts', async () => {
  const { gate, timeline, advance } = fakeGate(() => 10 * GB);
  const run = gate.run();
  for (let i = 0; i < 7; i++) {
    assert.equal(await run.next(), 'go');
    timeline.push(`launch ${i + 1}`);
    advance(2000); // the stagger between two launches
  }
  assert.deepEqual(timeline, [
    'launch 1', 'launch 2', 'launch 3', `sleep ${SETTLE_MS - 2000}`,
    'launch 4', 'launch 5', 'launch 6', `sleep ${SETTLE_MS - 2000}`,
    'launch 7',
  ]);
});

test('a batch started after the previous one settled does not wait, and the batch size and settle come from the limits', async () => {
  const { gate, timeline, advance } = fakeGate(() => 10 * GB, { batchSize: 2, settleMs: 10_000 });
  const first = gate.run();
  await first.next();
  await first.next();
  advance(10_000);
  const second = gate.run();
  await second.next();
  await second.next();
  await second.next();
  assert.deepEqual(timeline, ['sleep 10000']);
});

test('runs share the gate: two batches at once still start BATCH_SIZE agents per settle, in the order they asked', async () => {
  const { gate, timeline } = fakeGate(() => 10 * GB, { batchSize: 2, settleMs: 10_000 });
  const a = gate.run();
  const b = gate.run();
  const order: string[] = [];
  await Promise.all([a.next().then(() => order.push('a1')), b.next().then(() => order.push('b1')), a.next().then(() => order.push('a2'))]);
  assert.deepEqual(order, ['a1', 'b1', 'a2']);
  assert.deepEqual(timeline, ['sleep 10000'], 'the third launch waits for the first two to settle, whichever run asked');
});

test('after MAX_WAIT_MS of waiting for memory in one run, it answers low_memory and never waits again', async () => {
  const { gate, timeline } = fakeGate(() => 1 * GB, { maxWaitMs: 7000 });
  const run = gate.run();
  assert.equal(await run.next(), 'low_memory');
  assert.deepEqual(timeline, ['sleep 2000', 'sleep 2000', 'sleep 2000', 'sleep 1000']);
  assert.equal(await run.next(), 'low_memory');
  assert.equal(timeline.length, 4, 'the budget is spent: no further wait');
  // A new run gets its own budget.
  assert.equal(await gate.run().next(), 'low_memory');
  assert.equal(timeline.length, 8);
});

test('close() cancels a run waiting for memory at once, and every later launch', async () => {
  let pending = 0;
  const gate = new LaunchGate({
    readMemory: async () => ({ memTotal: 24 * GB, memAvailable: 1 * GB }),
    // A wait that only ends when cancelled.
    sleep: (_ms, signal) => new Promise((resolve) => { pending++; signal.addEventListener('abort', () => resolve(), { once: true }); }),
  });
  const waiting = gate.run().next();
  const queued = gate.run().next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pending, 1, 'the second run waits for its turn, not for memory');
  gate.close();
  assert.equal(await waiting, 'cancelled');
  assert.equal(await queued, 'cancelled');
  assert.equal(await gate.run().next(), 'cancelled');
});

test('aborting one run\'s signal cancels that run only', async () => {
  const readings = [1 * GB];
  const gate = new LaunchGate({
    readMemory: async () => ({ memTotal: 24 * GB, memAvailable: readings.shift() ?? 10 * GB }),
    sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  const controller = new AbortController();
  const waiting = gate.run({ signal: controller.signal }).next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  assert.equal(await waiting, 'cancelled');
  assert.equal(await gate.run().next(), 'go');
});

test('readMachineMemory reads MemTotal, MemAvailable and swap from meminfo in bytes, null when unreadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-meminfo-'));
  try {
    await writeFile(join(dir, 'meminfo'), 'MemTotal:       24509744 kB\nMemFree: 1 kB\nMemAvailable:    9799928 kB\nSwapTotal: 4 kB\nSwapFree: 2 kB\n');
    assert.deepEqual(await readMachineMemory(dir), { memTotal: 24509744 * 1024, memAvailable: 9799928 * 1024, swapTotal: 4096, swapFree: 2048 });
    assert.deepEqual(await readMachineMemory(join(dir, 'none')), { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- The server: a reserve no machine meets ---------- */

let scratch: string;
let server: ChildProcess | undefined;
/** A fake Engram that knows no project, so "Mejorar con IA" reaches its pi run; anything else is down. */
let engram: ReturnType<typeof createServer> | undefined;
let api: (method: string, path: string, body?: unknown) => Promise<Response>;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-memory-gate-')));
  const root = join(scratch, 'root');
  for (const dir of ['alpha', 'beta']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  engram = createServer((req, res) => {
    res.writeHead(req.url?.startsWith('/project/current') ? 200 : 503, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => engram!.listen(0, '127.0.0.1', resolve));
  const engramPort = (engram.address() as { port: number }).port;
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({
    workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }],
    engramUrl: `http://127.0.0.1:${engramPort}`,
    launches: { reserveMb: 1048576 },
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PATH: `${join(scratch, 'bin')}:${process.env.PATH}`,
      HOME: join(scratch, 'home'),
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      XDG_STATE_HOME: join(scratch, 'state'),
      MIRADOR_PORT: String(port),
      MIRADOR_SCOPES: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const token = ((await session.json()) as { token: string }).token;
  api = (method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await new Promise((resolve) => (engram ? engram.close(resolve) : resolve(undefined)));
  await rm(scratch, { recursive: true, force: true });
});

type Result = { rel: string; status: string };

test('a batch that must wait for memory answers at once with its folders queued and a batch id; shells and single agents are not gated; a shutdown cancels the wait', async () => {
  const startedAt = Date.now();
  const response = await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['alpha', 'beta'] });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { results: Result[]; batchId: string };
  assert.ok(Date.now() - startedAt < 3000, 'the request is not held while the batch waits');
  assert.deepEqual(body.results.map((r) => [r.rel, r.status]), [['alpha', 'queued'], ['beta', 'queued']]);
  assert.equal(typeof body.batchId, 'string');

  // The launch runs, for the loading bar: the batch is a run of the server's gate, its id the batchId.
  const launches = (await (await api('GET', '/api/terminals/launches')).json()) as { active: boolean; runs: Array<{ id: string; kind: string; queued: number; wait: { reason: string } | null }> };
  assert.equal(launches.active, true);
  assert.deepEqual(launches.runs.map((r) => [r.id, r.kind, r.queued, r.wait?.reason]), [[body.batchId, 'batch', 2, 'memory']]);

  const progress = await api('GET', `/api/terminals/batch/${body.batchId}`);
  assert.equal(progress.status, 200);
  assert.deepEqual(await progress.json(), { results: [{ rel: 'alpha', status: 'queued' }, { rel: 'beta', status: 'queued' }], done: false });
  assert.equal((await api('GET', '/api/terminals/batch/nope')).status, 404);

  const shell = await api('POST', '/api/terminals', { ws: 'dev', rel: 'alpha', kind: 'shell' });
  assert.equal(shell.status, 201, 'a bash terminal opens while agents wait for memory');
  // One agent opened by hand while a run is active is refused, not queued behind it.
  const single = await api('POST', '/api/terminals', { ws: 'dev', rel: 'beta', kind: 'agent' });
  assert.equal(single.status, 409);
  assert.equal(((await single.json()) as { code: string }).code, 'launches_running');
  // No Claude run starts while agents open (each would be one more pi): "Mejorar con IA" is refused at once.
  const held = await api('POST', '/api/proposals/improve', { ws: 'dev', rel: 'alpha', draft: 'hello' });
  assert.equal(held.status, 503);
  assert.deepEqual(await held.json(), { error: 'Mirador is opening agents', code: 'proposal_launching' });

  // Pausar: an unknown run is 404; cancelling the batch ends it and lists its folders as not opened.
  assert.equal((await api('POST', '/api/terminals/launches/nope/cancel')).status, 404);
  const cancel = await api('POST', `/api/terminals/launches/${body.batchId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { id: body.batchId, cancelled: true });
  const ended = await waitFor(async () => {
    const now = (await (await api('GET', '/api/terminals/launches')).json()) as { active: boolean; runs: Array<{ state: string; cancelled: number; notOpened?: unknown }> };
    return now.active ? undefined : now.runs[0];
  });
  assert.deepEqual([ended.state, ended.cancelled, ended.notOpened], ['done', 2, [{ workspaceId: 'dev', rel: 'alpha' }, { workspaceId: 'dev', rel: 'beta' }]]);
  assert.equal((await api('POST', `/api/terminals/launches/${body.batchId}/cancel`)).status, 404, 'an ended run cannot be cancelled again');

  // With no run active, the agent opens by hand again and "Mejorar con IA" reaches pi (missing here).
  const single2 = await api('POST', '/api/terminals', { ws: 'dev', rel: 'beta', kind: 'agent' });
  assert.equal(single2.status, 201, 'one agent opened by hand is not gated when no run is active');
  const free = await api('POST', '/api/proposals/improve', { ws: 'dev', rel: 'alpha', draft: 'hello' });
  assert.deepEqual(await free.json(), { error: 'gentle-shell pi or its Claude bridge is not installed', code: 'proposal_unavailable' });
  const listed = (await (await api('GET', '/api/terminals')).json()) as Array<{ kind: string; rel: string }>;
  assert.deepEqual(listed.map((t) => [t.kind, t.rel]), [['shell', 'alpha'], ['agent', 'beta']]);

  const exited = new Promise((resolve) => server!.once('exit', resolve));
  const stoppingAt = Date.now();
  server!.kill('SIGTERM');
  await exited;
  assert.ok(Date.now() - stoppingAt < 5000, 'the waiting batch does not hold the shutdown');
});

/* ---------- The window's rules for a batch that goes on (public/features/multi-open-model.js) ---------- */

test('the window reads a queued batch: queued folders are not skipped, and its progress gives the new terminals once and the folders that will not open', async () => {
  const { batchProgress, queuedFolders, summarizeBatch } = await import('../public/features/multi-open-model.js');
  const answer = [
    { rel: 'web', status: 'opened', terminal: { id: 't1' } },
    { rel: 'old', status: 'missing' },
    { rel: 'api', status: 'queued' },
    { rel: 'docs', status: 'queued' },
    { rel: 'cli', status: 'queued' },
  ];
  assert.deepEqual(queuedFolders(answer), ['api', 'docs', 'cli']);
  assert.deepEqual(summarizeBatch(answer), { opened: [{ id: 't1' }], skipped: [{ rel: 'old', reason: 'missing', error: null }] });

  const later = [answer[0], answer[1], { rel: 'api', status: 'opened', terminal: { id: 't2' } }, { rel: 'docs', status: 'low_memory' }, { rel: 'cli', status: 'queued' }];
  const shown = new Set<string>();
  assert.deepEqual(batchProgress(later, ['api', 'docs', 'cli'], shown), { fresh: [{ id: 't2' }], opened: 1, notOpened: [{ rel: 'docs', status: 'low_memory', error: null }] });
  shown.add('t2');
  assert.deepEqual(batchProgress(later, ['api', 'docs', 'cli'], shown).fresh, [], 'a terminal already shown is not shown again');
});

/* ---------- Run progress for other modules (loading bar, Pausar) ---------- */

test('status() lists each run with its progress and current wait, and cancel(id) stops the rest of that run only', async () => {
  let available = 1 * GB;
  let clock = 1_000_000;
  const gate = new LaunchGate({
    limits: { batchSize: 1, settleMs: 30_000 },
    now: () => clock,
    readMemory: async () => ({ memTotal: 24 * GB, memAvailable: available }),
    sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  assert.deepEqual(gate.status(), { active: false, runs: [] });

  const run = gate.run({ id: 'b1', kind: 'batch', workspaceId: 'dev', total: 3 });
  assert.equal(run.id, 'b1');
  const first = run.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reserve = Math.round(0.15 * 24 * GB);
  let status = gate.status();
  assert.equal(status.active, true);
  assert.deepEqual(status.runs.map(({ startedAt: _s, ...rest }) => rest), [
    { id: 'b1', kind: 'batch', workspaceId: 'dev', state: 'running', total: 3, opened: 0, failed: 0, skipped: 0, queued: 3, lowMemory: 0, cancelled: 0, endedAt: null,
      wait: { reason: 'memory', until: null, memAvailable: 1 * GB, reserveBytes: reserve, missingBytes: reserve - 1 * GB } },
  ]);

  // A second run waits behind the first one's turn.
  const other = gate.run({ id: 'r1', kind: 'restore', total: 1 });
  const behind = other.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(gate.status().runs.find((r) => r.id === 'r1')!.wait, { reason: 'turn', until: null, memAvailable: null, reserveBytes: null, missingBytes: null });

  // Pausar: cancelling b1 ends its wait; its folders left are counted cancelled once it ends.
  available = 10 * GB;
  assert.equal(gate.cancel('b1'), true);
  assert.equal(gate.cancel('nope'), false);
  assert.equal(await first, 'cancelled');
  run.end();
  status = gate.status();
  const b1 = status.runs.find((r) => r.id === 'b1')!;
  assert.deepEqual([b1.state, b1.queued, b1.cancelled, b1.wait], ['done', 0, 3, null]);
  assert.equal(typeof b1.endedAt, 'string');

  // r1 gets its turn; with memory back it goes, then waits for the settle with the next batch time.
  assert.equal(await behind, 'go');
  const settling = other.next();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(gate.status().runs.find((r) => r.id === 'r1')!.wait, { reason: 'settle', until: new Date(clock + 30_000).toISOString(), memAvailable: null, reserveBytes: null, missingBytes: null });
  gate.close();
  await settling;
  other.end();
  const r1 = gate.status().runs.find((r) => r.id === 'r1')!;
  assert.deepEqual([r1.state, r1.opened, r1.cancelled], ['done', 1, 0], 'total 1, one opened: nothing left to cancel');
  assert.equal(gate.status().active, false);
});

test('a run that ran out of memory counts its folders left as low_memory; skip() and fail() take folders out of the queue', async () => {
  const readings = [10 * GB];
  const gate = new LaunchGate({ limits: { maxWaitMs: 0 }, readMemory: async () => ({ memTotal: 24 * GB, memAvailable: readings.shift() ?? 1 * GB }), sleep: async () => undefined });
  const run = gate.run({ kind: 'batch', total: 4 });
  assert.match(run.id, /^[\w-]+$/, 'an id is made when none is given');
  run.skip();
  assert.equal(await run.next(), 'go');
  assert.equal(gate.status().runs[0].opened, 1);
  run.fail();
  assert.deepEqual([gate.status().runs[0].opened, gate.status().runs[0].queued], [0, 2], 'the granted agent that did not start is failed, not opened');
  assert.equal(await run.next(), 'low_memory');
  run.end();
  const [done] = gate.status().runs;
  assert.deepEqual([done.skipped, done.failed, done.lowMemory, done.queued, done.cancelled], [1, 1, 2, 0, 0]);
});

test('R4b: cancel between two launches: the next one is cancelled at once, and end(left) lists the folders the run did not open', async () => {
  const { gate, timeline } = fakeGate(() => 10 * GB);
  const run = gate.run({ id: 'r', kind: 'restore', total: 3 });
  assert.equal(await run.next(), 'go');
  assert.equal(gate.cancel('r'), true);
  assert.equal(await run.next(), 'cancelled');
  run.end([{ workspaceId: 'dev', rel: 'b' }, { workspaceId: 'dev', rel: 'c' }]);
  const [ended] = gate.status().runs;
  assert.deepEqual([ended.opened, ended.cancelled, ended.notOpened], [1, 2, [{ workspaceId: 'dev', rel: 'b' }, { workspaceId: 'dev', rel: 'c' }]]);
  assert.deepEqual(timeline, [], 'nothing waited');
  assert.equal(gate.status().active, false);
});
