// "Sign out the other windows" (phone inbox, #41 S8 and S11): DELETE /api/session/others clears every
// session but the caller's, behind the same session token and Origin checks as every API call, and
// closes the terminal sockets the cleared sessions held. Runs the real server on a scratch state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let server: ChildProcess;
let base: string;
let origin: string;
let launchSecret: string;

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

async function bootstrap(): Promise<string> {
  const response = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  assert.equal(response.status, 200);
  const { url } = (await response.json()) as { url: string };
  return new URL(url).hash.replace('#launch=', '');
}

function redeem(nonce: string): Promise<Response> {
  return fetch(`${base}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
}

async function login(): Promise<string> {
  const response = await redeem(await bootstrap());
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

function api(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = { origin }): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The status of an API call with `token`: 200 while its session lives, 401 once it is gone. */
async function statusOf(token: string): Promise<number> {
  return (await api(token, 'GET', '/api/terminals')).status;
}

function signOutOthers(token: string | null, headers?: Record<string, string>): Promise<Response> {
  return api(token, 'DELETE', '/api/session/others', undefined, headers);
}

/** Leaves `token` as the only session, so a test counts only the sessions it opens itself. */
async function alone(token: string): Promise<void> {
  assert.equal((await signOutOthers(token)).status, 200);
}

function openSocket(token: string, id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${id}`, ['mirador.v1', `auth.${token}`], { headers: { origin } });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
}

/** The HTTP status an upgrade with `token` is refused with, or 'open'. */
function upgradeStatus(token: string, id: string): Promise<number | 'open'> {
  return openSocket(token, id).then(
    (ws) => {
      ws.terminate();
      return 'open' as const;
    },
    (error) => error.status,
  );
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-sign-out-')));
  await mkdir(join(scratch, 'root'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), '{}');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, GENTLE_AI_HOME: join(scratch, 'gentle-ai'), HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  launchSecret = state.launchSecret;
});

after(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
});

test('S8: signing out the other windows keeps the caller signed in, answers how many it cleared, and every other session gets 401', async () => {
  const caller = await login();
  await alone(caller);
  const phone = await login();
  const other = await login();
  assert.deepEqual([await statusOf(caller), await statusOf(phone), await statusOf(other)], [200, 200, 200]);

  const response = await signOutOthers(caller);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cleared: 2 });

  assert.equal(await statusOf(caller), 200, 'the caller keeps its session');
  assert.equal(await statusOf(phone), 401);
  assert.equal(await statusOf(other), 401);
  assert.equal((await api(phone, 'DELETE', '/api/session/others')).status, 401, 'a cleared session cannot sign out the caller in turn');
  assert.equal(await statusOf(caller), 200);

  const again = await signOutOthers(caller);
  assert.deepEqual([again.status, await again.json()], [200, { cleared: 0 }], 'nothing left to clear');
  assert.equal(await statusOf(caller), 200, 'it never clears the caller');
});

test('S8, S11: without a session, with an unknown one or from another origin the sign-out is refused and clears nothing', async () => {
  const caller = await login();
  await alone(caller);
  const phone = await login();

  const missing = await signOutOthers(null);
  assert.deepEqual([missing.status, await missing.json()], [401, { error: 'open Mirador with its launcher' }]);
  const unknown = await signOutOthers('made-up');
  assert.deepEqual([unknown.status, await unknown.json()], [401, { error: 'open Mirador with its launcher' }]);
  const foreign = await signOutOthers(phone, { origin: 'http://127.0.0.1:1' });
  assert.deepEqual([foreign.status, await foreign.json()], [403, { error: 'cross-origin request' }]);
  const noOrigin = await signOutOthers(phone, {});
  assert.deepEqual([noOrigin.status, await noOrigin.json()], [403, { error: 'cross-origin request' }]);
  const asGet = await api(phone, 'GET', '/api/session/others');
  assert.equal(asGet.status, 404, 'a GET (no Origin check) is no way in');

  assert.deepEqual([await statusOf(caller), await statusOf(phone)], [200, 200], 'both sessions still work');
  const counted = await signOutOthers(caller);
  assert.deepEqual(await counted.json(), { cleared: 1 }, 'the refused calls cleared nothing');
});

test('S8: a terminal socket of a cleared session is closed and cannot reconnect; the caller\'s socket keeps working', async () => {
  const caller = await login();
  await alone(caller);
  const phone = await login();
  const created = await api(caller, 'POST', '/api/terminals', { ws: 'dev', rel: '', kind: 'shell', cols: 80, rows: 24 });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  try {
    const mine = await openSocket(caller, id);
    const theirs = await openSocket(phone, id);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => theirs.on('close', (code: number, reason: Buffer) => resolve({ code, reason: String(reason) })));

    assert.deepEqual(await (await signOutOthers(caller)).json(), { cleared: 1 });
    assert.deepEqual(await closed, { code: 1008, reason: 'signed out' });
    assert.equal(await upgradeStatus(phone, id), 403, 'no new socket for the cleared session');

    // The caller's socket still carries input and output.
    const marker = `still-here-${Date.now()}`;
    const echoed = new Promise<void>((resolve) => {
      let seen = '';
      mine.on('message', (raw: Buffer) => {
        const message = JSON.parse(String(raw));
        if (message.t === 'o') seen += message.d;
        if (seen.includes(marker)) resolve();
      });
    });
    assert.equal(mine.readyState, WebSocket.OPEN);
    mine.send(JSON.stringify({ t: 'i', d: `echo ${marker}\r` }));
    await echoed;
    mine.terminate();
  } finally {
    await api(caller, 'DELETE', `/api/terminals/${id}`);
  }
});

test('preserved: a launch link still redeems once, and past 32 sessions the least recently used is still the one forgotten', async () => {
  const caller = await login();
  await alone(caller);
  const nonce = await bootstrap();
  const first = await redeem(nonce);
  assert.equal(first.status, 200);
  const window = ((await first.json()) as { token: string }).token;
  assert.deepEqual([(await redeem(nonce)).status], [403], 'a used link stays used');

  const idle = await login();
  // 32 more sessions, while the window and the caller stay in use: only idle ones fall out.
  for (let i = 0; i < 32; i += 1) {
    await login();
    assert.equal(await statusOf(window), 200);
    assert.equal(await statusOf(caller), 200);
  }
  assert.equal(await statusOf(idle), 401, 'the least recently used session is forgotten');
  assert.deepEqual([await statusOf(window), await statusOf(caller)], [200, 200]);
});
