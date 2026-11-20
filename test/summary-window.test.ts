// Engram's recent endpoints have no date filter: the API says when a day may be cut off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// Every entry the fake Engram holds was created at noon on 2026-10-28 in Santiago.
const CREATED_AT = '2026-10-28 15:00:00';

let scratch: string;
let root: string;
let server: ChildProcess;
let fakeEngram: Server;
let base: string;
let token: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function get(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-window-')));
  root = join(scratch, 'root');
  await mkdir(join(root, 'busy'), { recursive: true });
  await mkdir(join(root, 'group', 'busy'), { recursive: true });

  // Like engram serve: always more history than any window, newest `limit` entries returned.
  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const limit = Number(url.searchParams.get('limit')) || 20;
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/project/current') {
      const cwd = url.searchParams.get('cwd') ?? '';
      res.end(JSON.stringify(cwd.endsWith('/group') ? {} : { project: 'busy', project_source: 'git_remote', project_path: cwd }));
    } else if (url.pathname === '/projects') {
      res.end(JSON.stringify({ projects: [{ name: 'busy', directories: [join(root, 'group', 'busy')] }] }));
    } else if (url.pathname === '/observations/recent') {
      const entries = Array.from({ length: limit }, (_, i) => ({ id: i, type: 'decision', title: `t${i}`, content: '', project: 'busy', created_at: CREATED_AT }));
      res.end(JSON.stringify(entries));
    } else if (url.pathname === '/sessions/recent') {
      res.end(JSON.stringify(Array.from({ length: limit }, (_, i) => ({ id: `s${i}`, project: 'busy', started_at: CREATED_AT, observation_count: 1 }))));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise<void>((resolve) => fakeEngram.listen(0, '127.0.0.1', resolve));
  const engramAddress = fakeEngram.address();
  const engramPort = typeof engramAddress === 'object' && engramAddress ? engramAddress.port : 0;

  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(
    join(scratch, 'cfg', 'mirador', 'config.json'),
    JSON.stringify({ root, engramUrl: `http://127.0.0.1:${engramPort}`, timeZone: 'America/Santiago' }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  let launchSecret: string | undefined;
  const deadline = Date.now() + 8000;
  while (!launchSecret && Date.now() < deadline) {
    launchSecret = await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8').then((t) => JSON.parse(t).launchSecret, () => undefined);
    if (!launchSecret) await new Promise((r) => setTimeout(r, 50));
  }
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  fakeEngram?.closeAllConnections();
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

test('a project summary says truncated when the Engram window may cut the day off', async () => {
  assert.equal((await get('/api/summary?ws=dev&rel=busy&date=2026-10-28')).truncated, true);
  assert.equal((await get('/api/summary?ws=dev&rel=busy&date=2026-10-27')).truncated, true);
  // The window reaches back before the 29th, so that day is complete.
  assert.equal((await get('/api/summary?ws=dev&rel=busy&date=2026-10-29')).truncated, false);
});

test('a container folder summary says truncated too', async () => {
  const body = await get('/api/summary?ws=dev&rel=group&date=2026-10-28');
  assert.deepEqual((body.group as { projects: string[] }).projects, ['busy']);
  assert.equal(body.truncated, true);
});

test('the activity overview says truncated too', async () => {
  assert.equal((await get('/api/activity?date=2026-10-28')).truncated, true);
  assert.equal((await get('/api/activity?date=2026-10-29')).truncated, false);
});
