// Verifier probes against the real server: the
// activation log over HTTP, a delegation's on, a shutdown and the starts that resume, keep or drop
// the saved manual on, a hand-edited or broken activations.jsonl, and that rejected requests leave
// autopilot.json byte-identical. Scratch HOME/XDG dirs; the agent command never runs a real shell.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const ZONE = 'America/Santiago';
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
    env: { ...process.env, HOME: join(scratch, 'home'), GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_CONFIG_HOME: join(scratch, 'cfg'), XDG_STATE_HOME: join(scratch, 'state'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
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
  return fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as T;
}
type Status = { active: boolean; available: boolean; since: string | null; source: string | null; until: string | null };
type Change = { time: string; cause: string; reason?: string; from: { active: boolean; source: string | null; until: string | null }; to: { active: boolean; source: string | null; until: string | null }; saved?: unknown };
const nightDir = () => join(scratch, 'state', 'mirador', 'night');
const manualFile = () => join(nightDir(), 'autopilot.json');
const activationsFile = () => join(nightDir(), 'activations.jsonl');
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const activations = (limit?: number) => api('GET', `/api/night/activations${limit === undefined ? '' : `?limit=${limit}`}`).then((r) => json<{ activations: Change[] }>(r, 200)).then((r) => r.activations);
const night = () => api('GET', '/api/night').then((r) => json<Status>(r, 200));
function localTime(minutes: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + minutes * 60_000));
}
async function startWithoutSocket(): Promise<() => Promise<void>> {
  const socketFile = join(scratch, 'run', 'mirador', 'night', 'socket');
  await rm(socketFile, { force: true });
  const holder = createSocketServer((conn) => conn.destroy());
  holder.unref();
  await new Promise<void>((resolve) => holder.listen(socketFile, resolve));
  await start();
  return () => new Promise<void>((resolve) => holder.close(() => resolve()));
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-verifier-api-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }], engramUrl: 'http://127.0.0.1:9', timeZone: ZONE, agentCommand: 'sleep 600 #' }));
  await start();
});
after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('A1: a fresh server has an empty activation log; the default limit answers 200', async () => {
  assert.deepEqual(await activations(), []);
  assert.deepEqual(await night(), { active: false, available: true, since: null, source: null, until: null, connectedTerminals: [], pending: [] });
});

test('A2: an on by hand logs user with the state before and after; rejected PUTs leave autopilot.json and the log byte-identical', async () => {
  const on = await json<Status>(await api('PUT', '/api/night', { active: true }), 200);
  const [first] = await activations();
  assert.deepEqual(first, { time: first.time, from: { active: false, source: null, until: null }, to: { active: true, source: 'manual', until: null }, cause: 'user' });
  assert.ok(Math.abs(Date.parse(first.time) - Date.parse(on.since!)) <= 50, `logged at ${first.time}, since ${on.since}`);
  const manualBytes = await sha(manualFile());
  const logBytes = await sha(activationsFile());
  assert.equal((await stat(activationsFile())).mode & 0o777, 0o600);
  for (const body of [{ active: true, until: '25:00' }, { active: false, until: '10:00' }, { active: true, extra: 1 }, { until: '10:00' }, {}, { active: 'yes' }]) {
    assert.equal((await json(await api('PUT', '/api/night', body), 400)).code, 'night_invalid', JSON.stringify(body));
  }
  assert.equal(await sha(manualFile()), manualBytes, 'autopilot.json untouched by rejected bodies');
  assert.equal(await sha(activationsFile()), logBytes, 'no activation logged for a rejected body');
  const again = await json<Status>(await api('PUT', '/api/night', { active: true }), 200);
  assert.equal(again.since, on.since);
  assert.equal(await sha(activationsFile()), logBytes, 'the same on again is no change: nothing logged');
  await json(await api('PUT', '/api/night', { active: false }), 200);
  assert.deepEqual((await activations()).map((c) => c.cause), ['user', 'user']);
  assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: null });
});

test('A3 S1: a delegation that switches the autopilot on logs cause delegation with source manual and no until', async () => {
  const res = await json<{ autopilot?: string; results: unknown[] }>(await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['alpha'], instruction: 'Run the tests.', autopilot: true }), 200);
  assert.equal(res.autopilot, 'turned_on', JSON.stringify(res));
  const status = await night();
  assert.deepEqual([status.active, status.source, status.until], [true, 'manual', null]);
  const [latest] = await activations(1);
  assert.deepEqual([latest.cause, latest.from.active, latest.to], ['delegation', false, { active: true, source: 'manual', until: null }]);
  assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: { since: status.since, until: null } });
  const second = await json<{ autopilot?: string }>(await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['alpha'], instruction: 'Again.', autopilot: true }), 200);
  assert.equal(second.autopilot, 'already_on');
  assert.equal((await activations(1))[0].cause, 'delegation', 'already on: nothing new logged');
  for (const t of await json<Array<{ id: string }>>(await api('GET', '/api/terminals'), 200)) await api('DELETE', `/api/terminals/${t.id}`);
  await json(await api('PUT', '/api/night', { active: false }), 200);
});

test('A4 S1: SIGTERM logs shutdown and keeps autopilot.json; the next start resumes (restart-resume) with the same since and until', async () => {
  const on = await json<Status>(await api('PUT', '/api/night', { active: true, until: localTime(120) }), 200);
  const manualBytes = await sha(manualFile());
  await stop();
  const lines = (await readFile(activationsFile(), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Change);
  assert.deepEqual([lines.at(-1)!.cause, lines.at(-1)!.from, lines.at(-1)!.to], ['shutdown', { active: true, source: 'manual', until: on.until }, { active: false, source: null, until: null }]);
  assert.equal(await sha(manualFile()), manualBytes, 'shutdown did not touch autopilot.json');
  await start();
  const resumed = await night();
  assert.deepEqual([resumed.active, resumed.source, resumed.since, resumed.until], [true, 'manual', on.since, on.until]);
  const [latest] = await activations(1);
  assert.deepEqual([latest.cause, latest.to], ['restart-resume', { active: true, source: 'manual', until: on.until }]);
  assert.equal(await sha(manualFile()), manualBytes, 'the resume rewrote the same bytes');
});

test('A5 S1: a saved manual on whose until passed while stopped is dropped at the start (restart-dropped) and autopilot.json cleared', async () => {
  await stop();
  const passed = { since: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() - 60_000).toISOString() };
  await writeFile(manualFile(), JSON.stringify({ manual: passed }, null, 2) + '\n');
  await start();
  const status = await night();
  assert.deepEqual([status.active, status.source, status.until], [false, null, null]);
  assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: null });
  const [latest] = await activations(1);
  assert.deepEqual([latest.cause, latest.saved, latest.from, latest.to], ['restart-dropped', passed, { active: false, source: null, until: null }, { active: false, source: null, until: null }]);
});

test('A6 S1: a broken or incomplete line in activations.jsonl is skipped by GET; limit is validated (400 night_limit); latest first', async () => {
  await stop();
  const before = (await readFile(activationsFile(), 'utf8')).trim().split('\n');
  await writeFile(activationsFile(), `${before.join('\n')}\n{broken\n{"cause":"no-time"}\n\n`);
  await start();
  const list = await activations();
  assert.equal(list.length, before.length);
  assert.ok(list.every((c, i) => i === 0 || Date.parse(list[i - 1].time) >= Date.parse(c.time)), 'latest first');
  assert.equal(list[0].cause, 'restart-dropped');
  for (const limit of ['0', '501', 'x', '1.5', '', '-1', 'NaN']) {
    const error = await json(await api('GET', `/api/night/activations?limit=${limit}`), 400);
    assert.deepEqual([error.code, error.error ?? error.message], ['night_limit', 'limit must be 1-500'], limit);
  }
  assert.equal((await activations(1)).length, 1);
  assert.equal((await activations(500)).length, before.length);
  const on = await json<Status>(await api('PUT', '/api/night', { active: true }), 200);
  assert.ok(Math.abs(Date.parse((await activations(1))[0].time) - Date.parse(on.since!)) <= 50, 'an append after the broken lines still works');
  assert.equal((await activations()).length, before.length + 1, 'GET still skips the broken lines after the rewrite');
  await json(await api('PUT', '/api/night', { active: false }), 200);
});

test('A6b F5: an old activations.jsonl line whose cause is the legacy owner value is listed by GET as user; new lines on disk say user', async () => {
  await stop();
  const old = { time: new Date(Date.now() - 60_000).toISOString(), from: { active: false, source: null, until: null }, to: { active: true, source: 'manual', until: null }, cause: LEGACY_USER_VALUES.cause };
  await writeFile(activationsFile(), `${(await readFile(activationsFile(), 'utf8')).trim()}\n${JSON.stringify(old)}\n`);
  await start();
  assert.deepEqual((await activations(1))[0], { ...old, cause: 'user' }, 'the old line loads, shown as the user');
  await json(await api('PUT', '/api/night', { active: true }), 200);
  await json(await api('PUT', '/api/night', { active: false }), 200);
  const lines = (await readFile(activationsFile(), 'utf8')).trim().split('\n').slice(-3).map((line) => JSON.parse(line) as Change); // A6 left broken lines further up
  assert.deepEqual(lines.map((c) => c.cause), [LEGACY_USER_VALUES.cause, 'user', 'user'], 'the old line keeps its bytes; the new on and off are written as user');
  assert.deepEqual((await activations(3)).map((c) => c.cause), ['user', 'user', 'user']);
});

test('A7 S1: a start without the night socket inside a window keeps a saved manual on (restart-deferred) and rejects an on with 503 without touching the file; the next start with the socket resumes it as manual', async () => {
  const schedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: localTime(-60), end: localTime(60), remindBeforeMinutes: 0 };
  await rm(join(nightDir(), 'scheduler.json'), { force: true });
  await json(await api('PUT', '/api/night/schedule', schedule), 200);
  const on = await json<Status>(await api('PUT', '/api/night', { active: true, until: localTime(30) }), 200);
  assert.equal(on.source, 'manual');
  const manualBytes = await sha(manualFile());
  await stop();
  const release = await startWithoutSocket();
  try {
    const status = await night();
    assert.deepEqual([status.active, status.available, status.source], [false, false, null]);
    assert.equal((await json(await api('PUT', '/api/night', { active: true }), 503)).code, 'night_unavailable');
    assert.equal(await sha(manualFile()), manualBytes, 'kept');
    const [latest] = await activations(1);
    assert.deepEqual([latest.cause, latest.saved], ['restart-deferred', { since: on.since, until: on.until }]);
  } finally {
    await stop();
    await release();
  }
  assert.equal(await sha(manualFile()), manualBytes, 'kept through the shutdown without the socket');
  await start();
  const resumed = await night();
  assert.deepEqual([resumed.active, resumed.source, resumed.since, resumed.until], [true, 'manual', on.since, on.until], 'the open window did not take it');
  await json(await api('PUT', '/api/night', { active: false }), 200);
  await json(await api('PUT', '/api/night/schedule', { ...schedule, enabled: false }), 200);
});
