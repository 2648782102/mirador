// GET /api/bootstrap answers in one request what the UI
// reads at start (config and workspaces), behind the same session check as every API route, and
// the individual endpoints stay as they were. The real server on a scratch HOME and config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let server: ChildProcess;
let base: string;
let launchSecret: string;

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

/** A session token, the way the launcher and the page get one: launch secret → nonce → token. */
async function login(): Promise<string> {
  const launch = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await launch.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  assert.equal(session.status, 200);
  return ((await session.json()) as { token: string }).token;
}

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bootstrap-api-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:1', timeZone: 'UTC' }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, GENTLE_AI_HOME: join(scratch, 'gentle-ai'), HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), XDG_DATA_HOME: join(scratch, 'data'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  launchSecret = (await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')))).launchSecret;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => (server?.exitCode !== null ? resolve(null) : server.once('exit', resolve)));
  await rm(scratch, { recursive: true, force: true });
});

test('GET /api/bootstrap needs the session token, like every API route', async () => {
  const anonymous = await get('/api/bootstrap');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'open Mirador with its launcher' });
  assert.equal((await get('/api/bootstrap', 'made-up')).status, 401);
  assert.equal(anonymous.headers.get('x-frame-options'), 'DENY');
});

test('GET /api/bootstrap answers config and workspaces exactly as their own endpoints do', async () => {
  const token = await login();
  const response = await get('/api/bootstrap', token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as { config: Record<string, unknown>; workspaces: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(body).sort(), ['config', 'workspaces']);
  // The individual endpoints still answer (unchanged for other callers), and the bootstrap carries the same.
  const config = await get('/api/config', token);
  const workspaces = await get('/api/workspaces', token);
  assert.equal(config.status, 200);
  assert.equal(workspaces.status, 200);
  assert.deepEqual(body.config, await config.json());
  assert.deepEqual(body.workspaces, await workspaces.json());
  assert.deepEqual(Object.keys(body.config).sort(), ['agentCommand', 'mode', 'timeZone', 'today']);
  assert.equal(body.config.timeZone, 'UTC');
  assert.equal(body.workspaces.length, 1, 'the config root as its one workspace');
});

test('GET /api/bootstrap follows workspace changes made through the workspaces API', async () => {
  const token = await login();
  const extra = join(scratch, 'extra');
  await mkdir(extra, { recursive: true });
  const added = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ root: extra, name: 'Extra' }) });
  assert.equal(added.status, 201);
  const body = (await (await get('/api/bootstrap', token)).json()) as { workspaces: Array<{ name: string }> };
  assert.deepEqual(body.workspaces.map((w) => w.name).slice(-1), ['Extra']);
  assert.deepEqual(body.workspaces, await (await get('/api/workspaces', token)).json());
});

test('only GET: other methods on /api/bootstrap are not routes', async () => {
  const token = await login();
  const response = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${token}` } });
  assert.equal(response.status, 404);
});

test('public/app.js reads its start-up state with one GET /api/bootstrap', async () => {
  const source = await readFile(join(APP_DIR, 'public', 'app.js'), 'utf8');
  assert.equal(source.match(/api\('GET', '\/api\/bootstrap'\)/g)?.length, 1);
  assert.doesNotMatch(source, /api\('GET', '\/api\/(?:config|workspaces)'\)/, 'no separate start-up calls left');
});

test('GET /api/bootstrap ignores Accept-Encoding and a query string, and stays no-store', async () => {
  const token = await login();
  for (const path of ['/api/bootstrap', '/api/bootstrap?x=1']) {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'br, gzip' } });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-encoding'), null, path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
  }
});
