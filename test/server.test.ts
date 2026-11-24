// Integration tests: run the real server against a temp root and a fake Engram.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let root: string;
let work: string;
let configFile: string;
let server: ChildProcess;
let fakeEngram: Server;
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

async function exchange(nonce: string): Promise<Response> {
  return fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
}

async function login(): Promise<string> {
  const response = await exchange(await bootstrap());
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function alive(token: string): Promise<boolean> {
  const response = await api(token, 'GET', '/api/terminals').catch(() => null);
  return response?.status === 200;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-server-')));
  root = join(scratch, 'root');
  work = join(scratch, 'work');
  for (const dir of ['ghost', 'alpha', 'beta/sub']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(work, 'client'), { recursive: true });

  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/project/current') {
      res.end(JSON.stringify({ project: 'ghost', project_source: 'dir_basename', project_path: url.searchParams.get('cwd') }));
    } else if (url.pathname === '/projects') {
      res.end(JSON.stringify({ projects: [
        { name: 'ghost', observation_count: 0, directories: [join(root, 'ghost')] },
        { name: 'something', observation_count: 4, directories: [join(root, 'beta', 'sub')] },
        { name: 'alpha', observation_count: 2, directories: null },
      ] }));
    } else {
      res.writeHead(404).end(JSON.stringify({ error: 'project "ghost" not found' }));
    }
  });
  await new Promise<void>((resolve) => fakeEngram.listen(0, '127.0.0.1', resolve));
  const engramAddress = fakeEngram.address();
  const engramPort = typeof engramAddress === 'object' && engramAddress ? engramAddress.port : 0;

  configFile = join(scratch, 'cfg', 'mirador', 'config.json');
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(configFile, JSON.stringify({ root, engramUrl: `http://127.0.0.1:${engramPort}` }));
  // GET /api/config resolves the auto mode from gentle-ai's state: a scratch one, never the real home's.
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
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

test('pages forbid framing and sniffing, and nothing sets a cookie', async () => {
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('set-cookie'), null);

  const denied = await fetch(`${base}/api/config`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('x-frame-options'), 'DENY');
  assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
});

test('bootstrap needs the launch secret from the state file', async () => {
  const response = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  assert.equal(response.status, 403);
});

/** The answer to redeeming a launch nonce that was already used: what an expired one must look like too. */
const REFUSED_LINK = { status: 403, body: { error: 'invalid or used launch link' } };

async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

test('a launch nonce can be exchanged for a session only once', async () => {
  const nonce = await bootstrap();
  const first = await exchange(nonce);
  assert.equal(first.status, 200);
  assert.equal(await alive(((await first.json()) as { token: string }).token), true);
  assert.deepEqual(await refusal(await exchange(nonce)), REFUSED_LINK);
  assert.deepEqual(await refusal(await exchange('made-up')), REFUSED_LINK, 'an unknown nonce answers the same');
});

test('a launch nonce redeemed after its lifetime is refused exactly like a used one', async () => {
  // A second server whose launch links live 1 s (MIRADOR_LAUNCH_NONCE_TTL_MS can only shorten the 60 s).
  const dir = join(scratch, 'short-ttl');
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  await mkdir(join(dir, 'root'), { recursive: true });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(dir, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  const port = await freePort();
  const short = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, GENTLE_AI_HOME: join(scratch, 'gentle-ai'), HOME: join(dir, 'home'), XDG_RUNTIME_DIR: join(dir, 'run'), XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0', MIRADOR_LAUNCH_NONCE_TTL_MS: '1000' },
    stdio: 'ignore',
  });
  try {
    const state = await waitFor(async () => JSON.parse(await readFile(join(dir, 'run', 'mirador', 'state.json'), 'utf8')));
    const issue = async () => {
      const response = await fetch(`${short}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
      assert.equal(response.status, 200);
      return new URL(((await response.json()) as { url: string }).url).hash.replace('#launch=', '');
    };
    const redeem = (nonce: string) =>
      fetch(`${short}/api/session`, { method: 'POST', headers: { origin: short, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });

    assert.equal((await redeem(await issue())).status, 200, 'a link redeemed at once still opens a session');
    const late = await issue();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(await refusal(await redeem(late)), REFUSED_LINK);
    assert.deepEqual(await refusal(await redeem(late)), REFUSED_LINK, 'and stays refused');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});

test('the session exchange refuses foreign origins', async () => {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: await bootstrap() }),
  });
  assert.equal(response.status, 403);
});

test('API calls need the session token', async () => {
  const token = await login();
  const config = await api(token, 'GET', '/api/config');
  assert.equal(config.status, 200);
  assert.equal((await config.json()).mode, 'gentle-deck', 'auto with gentle-ai\'s state');
  assert.equal((await api('made-up', 'GET', '/api/config')).status, 401);
});

test('non-object JSON bodies are rejected with 400', async () => {
  const token = await login();
  assert.equal((await api(token, 'POST', '/api/workspaces', 'null')).status, 400);
  assert.equal((await api(token, 'PATCH', '/api/workspaces/dev', '[]')).status, 400);
  assert.equal((await api(token, 'POST', '/api/terminals', '[]')).status, 400);
});

test('a folder Engram has no data for gets an empty summary', async () => {
  const token = await login();
  const response = await api(token, 'GET', '/api/summary?ws=dev&rel=ghost&date=2026-10-28');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { project: { project: string }; summary: { total: number; sessionCount: number } };
  assert.equal(body.project.project, 'ghost');
  assert.equal(body.summary.total, 0);
  assert.equal(body.summary.sessionCount, 0);
});

test('the legacy root is served as the Dev workspace', async () => {
  const token = await login();
  const response = await api(token, 'GET', '/api/workspaces');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }]);
});

test('adding, renaming and removing a workspace saves only the user settings and never touches its folder', async () => {
  const token = await login();
  const added = await api(token, 'POST', '/api/workspaces', { name: 'Work', root: work });
  assert.equal(added.status, 201);
  assert.deepEqual(await added.json(), { id: 'work', name: 'Work', root: work, folders: [], expanded: [] });
  let saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['engramUrl', 'workspaces']);
  assert.deepEqual(saved.workspaces.map((w: { id: string }) => w.id), ['dev', 'work']);

  const renamed = await api(token, 'PATCH', '/api/workspaces/work', { name: 'Trabajo' });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as { name: string }).name, 'Trabajo');

  assert.equal((await api(token, 'DELETE', '/api/workspaces/work')).status, 204);
  saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.deepEqual(saved.workspaces.map((w: { id: string }) => w.id), ['dev']);
  assert.equal((await api(token, 'GET', '/api/tree?ws=work&rel=')).status, 404);
  assert.ok((await stat(join(work, 'client'))).isDirectory());
});

test('workspace changes are validated and answer a stable error code', async () => {
  const token = await login();
  const cases: Array<[string, string, unknown, number, string]> = [
    ['POST', '/api/workspaces', { name: 'x', root: 'relative' }, 400, 'workspace_root'],
    ['POST', '/api/workspaces', { name: 'x', root: join(scratch, 'missing') }, 400, 'workspace_root'],
    ['PATCH', '/api/workspaces/dev', { name: '' }, 400, 'workspace_name'],
    ['PATCH', '/api/workspaces/dev', { folders: ['../work'] }, 400, 'workspace_folders'],
    ['PATCH', '/api/workspaces/dev', { root: work }, 400, 'unknown_field'],
    ['PATCH', '/api/workspaces/nope', { name: 'x' }, 404, 'workspace_not_found'],
    ['DELETE', '/api/workspaces/nope', undefined, 404, 'workspace_not_found'],
  ];
  for (const [method, path, body, status, code] of cases) {
    const response = await api(token, method, path, body);
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(body)}`);
    assert.equal(((await response.json()) as { code: string }).code, code);
  }
  assert.equal((await api(token, 'PUT', '/api/config', { root: work })).status, 404, 'the root is edited through workspaces now');
});

test('the tree shows the chosen folders of a workspace, all of them on request, and subfolders below', async () => {
  const token = await login();
  const names = async (path: string) => ((await (await api(token, 'GET', path)).json()) as Array<{ rel: string }>).map((n) => n.rel);
  assert.deepEqual(await names('/api/tree?ws=dev&rel='), ['alpha', 'beta', 'ghost']);
  const chosen = await api(token, 'PATCH', '/api/workspaces/dev', { folders: ['beta', 'ghost'], expanded: ['beta'] });
  assert.deepEqual(((await chosen.json()) as { folders: string[] }).folders, ['beta', 'ghost']);
  try {
    assert.deepEqual(await names('/api/tree?ws=dev&rel='), ['beta', 'ghost']);
    assert.deepEqual(await names('/api/tree?ws=dev&rel=&all=1'), ['alpha', 'beta', 'ghost']);
    assert.deepEqual(await names('/api/tree?ws=dev&rel=beta'), ['beta/sub']);
  } finally {
    await api(token, 'PATCH', '/api/workspaces/dev', { folders: [], expanded: [] });
  }
});

test('tree folders say whether Engram holds memory for them', async () => {
  const token = await login();
  const nodes = (await (await api(token, 'GET', '/api/tree?ws=dev&rel=')).json()) as Array<{ rel: string; hasMemory: boolean | null }>;
  assert.deepEqual(nodes.map((n) => [n.rel, n.hasMemory]), [['alpha', true], ['beta', true], ['ghost', false]]);
});

test('a workspace whose folder was deleted answers 400 with a code, not a server error', async () => {
  const token = await login();
  const doomed = join(scratch, 'doomed');
  await mkdir(doomed, { recursive: true });
  const added = (await (await api(token, 'POST', '/api/workspaces', { root: doomed })).json()) as { id: string };
  await rm(doomed, { recursive: true });
  try {
    for (const path of [`/api/tree?ws=${added.id}&rel=`, `/api/summary?ws=${added.id}&rel=`]) {
      const response = await api(token, 'GET', path);
      assert.equal(response.status, 400, path);
      assert.equal(((await response.json()) as { code: string }).code, 'workspace_root_missing');
    }
  } finally {
    assert.equal((await api(token, 'DELETE', `/api/workspaces/${added.id}`)).status, 204);
  }
});

test('tree, terminals and summary stay inside the workspace root', async () => {
  const token = await login();
  for (const path of ['/api/tree?ws=dev&rel=../', '/api/summary?ws=dev&rel=../work']) {
    assert.equal((await api(token, 'GET', path)).status, 400, path);
  }
  assert.equal((await api(token, 'GET', '/api/tree?ws=nope&rel=')).status, 404);
  assert.equal((await api(token, 'GET', '/api/tree?rel=')).status, 404, 'a workspace is required');
  assert.equal((await api(token, 'GET', '/api/summary?ws=nope&rel=')).status, 404);
  assert.equal((await api(token, 'POST', '/api/terminals', { ws: 'dev', rel: '../work', kind: 'shell' })).status, 400);
  assert.equal((await api(token, 'POST', '/api/terminals', { ws: 'nope', rel: '', kind: 'shell' })).status, 404);
});

test('a terminal carries the workspace and folder it was opened from', async () => {
  const token = await login();
  const response = await api(token, 'POST', '/api/terminals', { ws: 'dev', rel: 'beta/sub/', kind: 'shell', cols: 80, rows: 24 });
  assert.equal(response.status, 201);
  const info = (await response.json()) as { id: string; workspaceId: string; rel: string; cwd: string };
  assert.deepEqual([info.workspaceId, info.rel, info.cwd], ['dev', 'beta/sub', join(root, 'beta', 'sub')]);
  const listed = (await (await api(token, 'GET', '/api/terminals')).json()) as Array<{ id: string; workspaceId: string; rel: string }>;
  assert.deepEqual(listed.filter((t) => t.id === info.id).map((t) => [t.workspaceId, t.rel]), [['dev', 'beta/sub']]);
  await api(token, 'DELETE', `/api/terminals/${info.id}`);
});

test('a git terminal opens as its own kind, not as an agent', async () => {
  const token = await login();
  const response = await api(token, 'POST', '/api/terminals', { ws: 'dev', rel: '', kind: 'git', cols: 80, rows: 24 });
  assert.equal(response.status, 201);
  const info = (await response.json()) as { id: string; kind: string };
  assert.equal(info.kind, 'git');
  await api(token, 'DELETE', `/api/terminals/${info.id}`);
});

test('WebSockets need the session token as a subprotocol', async () => {
  const token = await login();
  const info = (await (await api(token, 'POST', '/api/terminals', { ws: 'dev', rel: '', kind: 'shell', cols: 80, rows: 24 })).json()) as { id: string };
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${info.id}`, ['mirador.v1'], { headers: { origin } });
    ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    ws.on('open', () => resolve('open'));
  });
  assert.equal(status, 403);
  await api(token, 'DELETE', `/api/terminals/${info.id}`);
});

test('malformed or oversized WebSocket frames do not take the server down', async () => {
  const token = await login();
  const info = (await (await api(token, 'POST', '/api/terminals', { ws: 'dev', rel: '', kind: 'shell', cols: 80, rows: 24 })).json()) as { id: string };

  const frames: Array<[string, (ws: any) => void]> = [
    ['JSON null', (ws) => ws.send('null')],
    ['JSON number', (ws) => ws.send('42')],
    ['invalid UTF-8', (ws) => ws.send(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { binary: false })],
    ['oversized', (ws) => ws.send('x'.repeat(1024 * 1024 + 10))],
  ];
  for (const [name, sendFrame] of frames) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${info.id}`, ['mirador.v1', `auth.${token}`], { headers: { origin } });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    sendFrame(ws);
    await new Promise((resolve) => setTimeout(resolve, 300));
    ws.terminate();
    assert.equal(await alive(token), true, `server died after ${name}`);
  }
  const list = (await (await api(token, 'GET', '/api/terminals')).json()) as Array<{ id: string; status: string }>;
  assert.deepEqual(list.map((t) => [t.id, t.status]), [[info.id, 'running']]);
  await api(token, 'DELETE', `/api/terminals/${info.id}`);
});

test('closing a terminal tells the sockets attached to it ({t:\'c\'}) and closes them; a socket on another terminal hears nothing', async () => {
  const token = await login();
  const open = async () => ((await (await api(token, 'POST', '/api/terminals', { ws: 'dev', rel: '', kind: 'shell', cols: 80, rows: 24 })).json()) as { id: string }).id;
  const [closed, kept] = [await open(), await open()];
  const attach = async (id: string) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${id}`, ['mirador.v1', `auth.${token}`], { headers: { origin } });
    const heard: string[] = [];
    const closes: unknown[] = [];
    ws.on('message', (raw: Buffer) => {
      const message = JSON.parse(String(raw));
      heard.push(message.t);
      if (message.t === 'c') closes.push(message);
    });
    // Its close code, or 'open' if the server left it open for 3 s.
    const ended = new Promise<number | string>((resolve) => {
      ws.on('close', resolve);
      setTimeout(() => resolve('open'), 3000).unref();
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    await waitFor(async () => (heard.includes('s') ? true : undefined));
    return { ws, ended, closes, others: () => heard.filter((t) => t !== 's' && t !== 'o') };
  };
  const [first, second, other] = [await attach(closed), await attach(closed), await attach(kept)];
  try {
    assert.equal((await api(token, 'DELETE', `/api/terminals/${closed}`)).status, 204);
    assert.deepEqual([await first.ended, await second.ended], [1000, 1000], 'the server closed both sockets of the closed terminal');
    assert.deepEqual([first.others(), second.others()], [['c'], ['c']], 'each heard the close once, and no exit');
    assert.deepEqual(first.closes, [{ t: 'c' }], 'a close by hand gives no reason: no window says anything');
    assert.deepEqual(other.others(), [], 'the other terminal\'s socket heard nothing');
    assert.equal(other.ws.readyState, WebSocket.OPEN);
  } finally {
    for (const { ws } of [first, second, other]) ws.terminate();
    await api(token, 'DELETE', `/api/terminals/${kept}`);
  }
});
