// Integration: the real server's night queue settings,
// GET/PUT /api/night/queue, the `queue` summary GET /api/night carries while the autopilot is on, and
// a restart that keeps the user's N. No model, no network; the server runs in a temp home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suggestedSlots } from '../src/night/night-queue.ts';
import { readMachineMemory } from '../src/system/resources.ts';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let server: ChildProcess | null = null;
let base: string;
let token: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

async function start(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await rm(join(scratch, 'run', 'mirador', 'state.json'), { force: true });
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      HOME: join(scratch, 'home'),
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      XDG_STATE_HOME: join(scratch, 'state'),
      MIRADOR_PORT: String(port),
      MIRADOR_SCOPES: '0',
    },
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
}

async function stop(): Promise<void> {
  if (!server) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
  server = null;
}

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as T;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-night-queue-api-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', timeZone: 'America/Santiago' }));
  await start();
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('GET /api/night/queue: N suggested from the machine memory, nothing working or queued', async () => {
  const { memTotal } = await readMachineMemory();
  const queue = await json(await api('GET', '/api/night/queue'), 200);
  assert.deepEqual(queue, { slots: suggestedSlots(memTotal), suggested: suggestedSlots(memTotal), custom: false, memTotal, working: 0, queued: 0, memoryWait: false, items: [] });
});

test('GET /api/night carries the queue summary only while the autopilot is on, without changing its other fields', async () => {
  const off = await json(await api('GET', '/api/night'), 200);
  assert.deepEqual(Object.keys(off), ['active', 'available', 'since', 'source', 'until', 'connectedTerminals', 'pending']);
  const on = await json(await api('PUT', '/api/night', { active: true }), 200);
  const status = await json<{ queue: Record<string, unknown> }>(await api('GET', '/api/night'), 200);
  assert.deepEqual(status, { ...on, connectedTerminals: [], pending: [], queue: status.queue });
  assert.deepEqual(status.queue, await json(await api('GET', '/api/night/queue'), 200));
  assert.deepEqual([status.queue.working, status.queue.queued, status.queue.items], [0, 0, []]);
  await json(await api('PUT', '/api/night', { active: false }), 200);
  assert.equal('queue' in (await json(await api('GET', '/api/night'), 200)), false);
});

test('PUT /api/night/queue sets N (1-50), refuses anything else with 400 night_queue, keeps it across a restart and null goes back to the suggestion', async () => {
  const { memTotal } = await readMachineMemory();
  for (const body of [{ slots: 0 }, { slots: 51 }, { slots: 2.5 }, { slots: '3' }, {}, { slots: 2, extra: true }]) {
    const error = await json(await api('PUT', '/api/night/queue', body), 400);
    assert.equal(error.code, 'night_queue', JSON.stringify(body));
  }
  assert.equal((await json(await api('GET', '/api/night/queue'), 200)).custom, false, 'nothing changed');

  const set = await json(await api('PUT', '/api/night/queue', { slots: 2 }), 200);
  assert.deepEqual([set.slots, set.custom, set.suggested], [2, true, suggestedSlots(memTotal)]);
  const file = join(scratch, 'state', 'mirador', 'night', 'queue.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { slots: 2 });

  await stop();
  await start();
  assert.deepEqual(await json(await api('GET', '/api/night/queue'), 200), { slots: 2, suggested: suggestedSlots(memTotal), custom: true, memTotal, working: 0, queued: 0, memoryWait: false, items: [] });

  const back = await json(await api('PUT', '/api/night/queue', { slots: null }), 200);
  assert.deepEqual([back.slots, back.custom], [suggestedSlots(memTotal), false]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { slots: null });
});
