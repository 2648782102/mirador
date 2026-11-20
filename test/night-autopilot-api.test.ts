// Integration: the real server's PUT /api/night with an
// optional `until`, GET /api/night reporting who switched it on, and a restart that keeps a
// manual on with its `until`. No model, no network; the server runs in a temp home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';
import { waitFor } from './helpers/wait.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const ZONE = 'America/Santiago';
/**
 * A bound for one server start, not a pace: start() returns as soon as the state file is there.
 * The start takes about 0.35 s idle and grows with CPU contention (about 11 s with ten CPU-bound
 * processes per core); only a server that never starts reaches this.
 */
const START_BOUND_MS = 120_000;

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

/**
 * Starts the server over the scratch folders (the same ones every time) and logs in. Waits for the
 * condition, the state file the server writes once it listens; fails early if the server exits, and
 * a stuck start says what it last saw.
 */
async function start(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const statePath = join(scratch, 'run', 'mirador', 'state.json');
  await rm(statePath, { force: true });
  const child = spawn(process.execPath, ['src/server.ts'], {
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
  server = child;
  let seen = 'nothing read yet';
  const ready = await waitFor<{ exited: string } | { state: { launchSecret: string } }>(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) return { exited: `the server exited before writing ${statePath} (code ${child.exitCode}, signal ${child.signalCode})` };
      try {
        return { state: JSON.parse(await readFile(statePath, 'utf8')) };
      } catch (error) {
        seen = (error as Error).message;
        return undefined;
      }
    },
    `the server to write ${statePath}`,
    START_BOUND_MS,
  ).catch((error: Error) => {
    throw new Error(`${error.message}; last seen: ${seen}`);
  });
  if ('exited' in ready) throw new Error(ready.exited);
  const { state } = ready;
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
}

async function stop(): Promise<void> {
  if (!server) return;
  // A server that already exited (a failed start) emits no further 'exit': waiting for one would hang.
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server!.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
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

type Status = { active: boolean; since: string | null; source: string | null; until: string | null };

/** Local HH:MM in the configured zone, `minutes` from now. */
function localTime(minutes: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + minutes * 60_000));
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-autopilot-api-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', timeZone: ZONE }));
  await start();
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('PUT /api/night rejects a bad until, an until with an off, and unknown keys with 400 night_invalid (D3)', async () => {
  for (const body of [{ active: true, until: '25:00' }, { active: true, until: '7:00' }, { active: true, until: 700 }, { active: true, until: '' }, { active: false, until: '10:00' }, { active: false, until: null }, { active: true, until: '10:00', extra: 1 }, { until: '10:00' }]) {
    const error = await json(await api('PUT', '/api/night', body), 400);
    assert.equal(error.code, 'night_invalid', JSON.stringify(body));
  }
  assert.deepEqual(await json(await api('GET', '/api/night'), 200), { active: false, available: true, since: null, source: null, until: null, connectedTerminals: [], pending: [] }, 'nothing changed');
});

test('on by hand with until: GET reports source manual and the until instant, today or tomorrow (D3)', async () => {
  const later = localTime(90);
  const on = await json<Status>(await api('PUT', '/api/night', { active: true, until: later }), 200);
  assert.equal(on.active, true);
  assert.equal(on.source, 'manual');
  const until = Date.parse(on.until ?? '');
  assert.ok(until > Date.now() + 88 * 60_000 && until <= Date.now() + 91 * 60_000, `until ${on.until} is the next ${later}`);
  assert.deepEqual(await json<Status>(await api('GET', '/api/night'), 200), { ...on, connectedTerminals: [], pending: [] } as unknown as Status);
  const file = join(scratch, 'state', 'mirador', 'night', 'autopilot.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { manual: { since: on.since, until: on.until } });

  // An until already past today means tomorrow.
  const earlier = localTime(-30);
  const tomorrow = await json<Status>(await api('PUT', '/api/night', { active: true, until: earlier }), 200);
  const next = Date.parse(tomorrow.until ?? '');
  assert.ok(next > Date.now() + 23 * 3600_000 && next <= Date.now() + 24 * 3600_000, `until ${tomorrow.until} is tomorrow's ${earlier}`);
  assert.equal(tomorrow.since, on.since, 'changing the until is the same activation');
});

test('a restart keeps the manual on with its since and until (D3)', async () => {
  const before = await json<Status>(await api('GET', '/api/night'), 200);
  assert.equal(before.active, true);
  await stop();
  await start();
  const after = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual({ active: after.active, since: after.since, source: after.source, until: after.until }, { active: true, since: before.since, source: 'manual', until: before.until });
});

test('PUT {active} alone stays valid: on with no limit, off clears the saved manual on (D3, previous behavior)', async () => {
  const on = await json<Status>(await api('PUT', '/api/night', { active: true, until: null }), 200);
  assert.deepEqual([on.active, on.source, on.until], [true, 'manual', null], 'until null: no limit');
  const off = await json<Status>(await api('PUT', '/api/night', { active: false }), 200);
  assert.deepEqual([off.active, off.source, off.until], [false, null, null]);
  assert.deepEqual(JSON.parse(await readFile(join(scratch, 'state', 'mirador', 'night', 'autopilot.json'), 'utf8')), { manual: null });
  const plain = await json<Status>(await api('PUT', '/api/night', { active: true }), 200);
  assert.deepEqual([plain.active, plain.source, plain.until], [true, 'manual', null]);
  await json(await api('PUT', '/api/night', { active: false }), 200);
  await stop();
  await start();
  assert.equal((await json<Status>(await api('GET', '/api/night'), 200)).active, false, 'an off is not resumed');
});

test('a schedule window open now turns it on as source schedule; a manual off inside it still sets offUntil (D3, previous behavior)', async () => {
  const schedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: localTime(-60), end: localTime(60), remindBeforeMinutes: 0 };
  const view = await json<{ current: { end: string } | null; offUntil: string | null }>(await api('PUT', '/api/night/schedule', schedule), 200);
  assert.ok(view.current, 'inside the window');
  const on = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([on.active, on.source, on.until], [true, 'schedule', null]);
  assert.deepEqual(JSON.parse(await readFile(join(scratch, 'state', 'mirador', 'night', 'autopilot.json'), 'utf8')), { manual: null }, 'a scheduled on is not saved as manual');
  await json(await api('PUT', '/api/night', { active: false }), 200);
  const after = await json<{ offUntil: string | null; current: { end: string } }>(await api('GET', '/api/night/schedule'), 200);
  assert.equal(after.offUntil, after.current.end);
  await json(await api('PUT', '/api/night/schedule', { ...schedule, enabled: false }), 200);
});

/* ---------- Restart resume (verifier probes) ---------- */

const manualFile = () => join(scratch, 'state', 'mirador', 'night', 'autopilot.json');

test('a restart with an until already passed is not resumed and clears autopilot.json (D3)', async () => {
  const status = await json<Status>(await api('GET', '/api/night'), 200);
  await stop();
  await writeFile(manualFile(), JSON.stringify({ manual: { since: status.since ?? new Date().toISOString(), until: new Date(Date.now() - 60_000).toISOString() } }));
  await start();
  const after = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([after.active, after.source, after.until], [false, null, null]);
  assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: null });
});

test('inside an open window a resumed manual on stays manual; a passed one is taken by the window as schedule (D3, D3a)', async () => {
  // An earlier test turned a window off by hand: start without that suppression.
  await stop();
  await rm(join(scratch, 'state', 'mirador', 'night', 'scheduler.json'), { force: true });
  await start();
  const schedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: localTime(-60), end: localTime(60), remindBeforeMinutes: 0 };
  await json(await api('PUT', '/api/night/schedule', schedule), 200);
  const bySchedule = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([bySchedule.active, bySchedule.source], [true, 'schedule']);
  const taken = await json<Status>(await api('PUT', '/api/night', { active: true, until: localTime(30) }), 200);
  assert.deepEqual([taken.source, taken.since], ['manual', bySchedule.since], 'taking over keeps the activation');
  await stop();
  await start();
  const resumed = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([resumed.active, resumed.source, resumed.until, resumed.since], [true, 'manual', taken.until, taken.since], 'resumed before the scheduler starts');
  assert.equal((await json<{ offUntil: string | null }>(await api('GET', '/api/night/schedule'), 200)).offUntil, null, 'nothing suppressed');
  await stop();
  await writeFile(manualFile(), JSON.stringify({ manual: { since: taken.since, until: new Date(Date.now() - 60_000).toISOString() } }));
  await start();
  const window = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([window.active, window.source, window.until], [true, 'schedule', null]);
  assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: null });
  await json(await api('PUT', '/api/night', { active: false }), 200);
  await json(await api('PUT', '/api/night/schedule', { ...schedule, enabled: false }), 200);
});

/* ---------- A start without the night socket ---------- */

const socketFile = () => join(scratch, 'run', 'mirador', 'night', 'socket');

/** Starts the server while something else serves the night socket, so the night shift is unavailable; resolves to its release. */
async function startWithoutSocket(): Promise<() => Promise<void>> {
  await rm(socketFile(), { force: true });
  const holder = createSocketServer((conn) => conn.destroy());
  holder.unref();
  await new Promise<void>((resolve) => holder.listen(socketFile(), resolve));
  await start();
  return () => new Promise<void>((resolve) => holder.close(() => resolve()));
}

test('a start without the night socket keeps the saved manual on; the next start resumes it as manual, also inside a window (S1)', async () => {
  await stop();
  await rm(join(scratch, 'state', 'mirador', 'night', 'scheduler.json'), { force: true });
  await start();
  const schedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: localTime(-60), end: localTime(60), remindBeforeMinutes: 0 };
  await json(await api('PUT', '/api/night/schedule', schedule), 200);
  const on = await json<Status>(await api('PUT', '/api/night', { active: true }), 200);
  assert.deepEqual([on.active, on.source, on.until], [true, 'manual', null]);

  await stop();
  const release = await startWithoutSocket();
  try {
    const unavailable = await json<Status & { available: boolean }>(await api('GET', '/api/night'), 200);
    assert.deepEqual([unavailable.active, unavailable.available], [false, false]);
    assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: { since: on.since, until: null } }, 'the saved manual on is kept');
  } finally {
    await stop();
    await release();
  }

  await start();
  const resumed = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([resumed.active, resumed.source, resumed.until, resumed.since], [true, 'manual', null, on.since], 'resumed as manual: the open window does not take it');
  await json(await api('PUT', '/api/night', { active: false }), 200);
  await json(await api('PUT', '/api/night/schedule', { ...schedule, enabled: false }), 200);
});

test('GET /api/night/activations lists every change with the state before and after and its cause, latest first; the start without the socket says restart-deferred (S1)', async () => {
  type Change = { time: string; cause: string; from: { active: boolean; source: string | null }; to: { active: boolean; source: string | null }; saved?: unknown };
  const { activations } = await json<{ activations: Change[] }>(await api('GET', '/api/night/activations?limit=6'), 200);
  assert.deepEqual(
    activations.map((c) => [c.cause, `${c.from.active ? c.from.source : 'off'}>${c.to.active ? c.to.source : 'off'}`]),
    [['user', 'manual>off'], ['restart-resume', 'off>manual'], ['restart-deferred', 'off>off'], ['shutdown', 'manual>off'], ['user', 'schedule>manual'], ['window-start', 'off>schedule']],
  );
  assert.ok(activations[2].saved, 'the kept manual on is in the line');
  assert.ok(activations.every((c, i) => i === 0 || Date.parse(activations[i - 1].time) >= Date.parse(c.time)), 'latest first');
  assert.equal((await stat(join(scratch, 'state', 'mirador', 'night', 'activations.jsonl'))).mode & 0o777, 0o600);
  for (const limit of ['0', '501', 'x', '1.5']) assert.equal((await json(await api('GET', `/api/night/activations?limit=${limit}`), 400)).code, 'night_limit', limit);
});

test('an off by the user while a saved manual on waits for the next start clears it: the next start leaves the autopilot off (S1)', async () => {
  await stop();
  await start();
  const on = await json<Status>(await api('PUT', '/api/night', { active: true }), 200);
  assert.equal(on.source, 'manual');
  await stop();
  const release = await startWithoutSocket();
  try {
    assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: { since: on.since, until: null } }, 'kept while the socket is away');
    await json(await api('PUT', '/api/night', { active: false }), 200);
    assert.deepEqual(JSON.parse(await readFile(manualFile(), 'utf8')), { manual: null }, 'the user\'s off wins over the kept manual on');
    const log = await json<{ activations: Array<{ cause: string; to: { active: boolean } }> }>(await api('GET', '/api/night/activations?limit=1'), 200);
    assert.deepEqual([log.activations[0]?.cause, log.activations[0]?.to.active], ['user', false]);
  } finally {
    await stop();
    await release();
  }
  await start();
  const after = await json<Status>(await api('GET', '/api/night'), 200);
  assert.deepEqual([after.active, after.source], [false, null], 'not resumed');
});
