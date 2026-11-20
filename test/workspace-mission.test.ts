// Each workspace carries an editable mission (Markdown) that guides the night shift.
// The store validates and saves it; the HTTP API returns it on GET and accepts it on PATCH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveSettings, type Workspace } from '../src/config.ts';
import { InvalidWorkspaceError, WorkspaceStore } from '../src/workspaces/store.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const MISSION = '# Objetivo\nShip the night shift.\n\n## Nunca hacer\n- Touch `.env` files\n\tindented line';

let scratch: string;
let root: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-mission-')));
  root = join(scratch, 'root');
  for (const dir of ['web', 'tools']) await mkdir(join(root, dir), { recursive: true });
});

after(async () => {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(scratch, { recursive: true, force: true });
});

function setup() {
  const saved: Workspace[][] = [];
  const store = new WorkspaceStore([{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }], async (list) => { saved.push(structuredClone(list)); });
  return { store, saved };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof InvalidWorkspaceError && error.code === code);
}

/* ---------- Store ---------- */

test('a mission is saved with the workspace and read back through get()', async () => {
  const { store, saved } = setup();
  const updated = await store.update('dev', { mission: MISSION });
  assert.equal(updated.mission, MISSION);
  assert.equal(store.get('dev')?.mission, MISSION);
  assert.equal(saved.at(-1)?.[0].mission, MISSION);
});

test('a mission must be text of at most 8000 characters; a rejected one changes nothing', async () => {
  const { store, saved } = setup();
  for (const bad of [42, null, ['x'], { text: 'x' }, true, 'x'.repeat(8001), 'nul\u0000byte', 'bell\u0007']) {
    await rejectsWith(store.update('dev', { mission: bad }), 'workspace_mission');
  }
  assert.equal(saved.length, 0);
  assert.equal(store.get('dev')?.mission, undefined);
  const longest = 'y'.repeat(8000);
  assert.equal((await store.update('dev', { mission: longest })).mission, longest);
});

test('an empty or blank mission clears it instead of saving whitespace', async () => {
  const { store, saved } = setup();
  await store.update('dev', { mission: MISSION });
  for (const blank of ['', '  \n\t ']) {
    const cleared = await store.update('dev', { mission: blank });
    assert.equal('mission' in cleared, false);
    assert.equal('mission' in (saved.at(-1)?.[0] ?? {}), false);
  }
});

test('a mission survives a save and a reload; old configs without one still load, other keys stay', async () => {
  const dir = join(scratch, 'roundtrip');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'config.json');
  const other = { id: 'work', name: 'Work', root, folders: ['web'], expanded: ['web'] };
  await writeFile(path, JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }, other], port: 4999, custom: { kept: true } }));
  const loaded = await loadConfig(path, { HOME: scratch });
  assert.deepEqual(loaded.workspaceProblems, []);
  assert.equal(loaded.workspaces[0].mission, undefined);
  const store = new WorkspaceStore(loaded.workspaces, (list) => saveSettings({ workspaces: list }, path, ['root']));
  await store.update('dev', { mission: MISSION });
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(file.port, 4999);
  assert.deepEqual(file.custom, { kept: true });
  assert.deepEqual(file.workspaces[1], other);
  assert.equal((await loadConfig(path, { HOME: scratch })).workspaces[0].mission, MISSION);
});

/* ---------- HTTP API ---------- */

let server: ChildProcess;
let base = '';
let token = '';
let configFile = '';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startServer() {
  const cfg = join(scratch, 'cfg');
  await mkdir(join(cfg, 'mirador'), { recursive: true });
  configFile = join(cfg, 'mirador', 'config.json');
  // A config written before missions existed.
  await writeFile(configFile, JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }], engramUrl: 'http://127.0.0.1:9', custom: 'kept' }, null, 2));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: cfg, MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let launchSecret: string | undefined;
  const deadline = Date.now() + 8000;
  while (!launchSecret && Date.now() < deadline) {
    launchSecret = await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8').then((t) => JSON.parse(t).launchSecret, () => undefined);
    if (!launchSecret) await new Promise((r) => setTimeout(r, 50));
  }
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
}

type Listed = Workspace;

test('GET shows a workspace without a mission exactly as before missions existed', async () => {
  await startServer();
  const listed = (await (await call('GET', '/api/workspaces')).json()) as Listed[];
  assert.deepEqual(listed, [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }]);
});

test('PATCH { mission } saves it, returns it, and GET shows it; the rest of the file stays', async () => {
  const response = await call('PATCH', '/api/workspaces/dev', { mission: MISSION });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as Listed).mission, MISSION);
  const listed = (await (await call('GET', '/api/workspaces')).json()) as Listed[];
  assert.deepEqual(listed, [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [], mission: MISSION }]);
  const file = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(file.workspaces[0].mission, MISSION);
  assert.equal(file.custom, 'kept');
});

test('PATCH refuses a mission that is too long or not text with workspace_mission, and keeps the saved one', async () => {
  for (const mission of ['z'.repeat(8001), 7, null]) {
    const response = await call('PATCH', '/api/workspaces/dev', { mission });
    assert.equal(response.status, 400);
    const answer = (await response.json()) as { code: string; error: string };
    assert.equal(answer.code, 'workspace_mission');
    assert.match(answer.error, /8000/);
  }
  const listed = (await (await call('GET', '/api/workspaces')).json()) as Listed[];
  assert.equal(listed[0].mission, MISSION);
});

test('PATCH name, folders and expanded behave as before and keep the mission', async () => {
  const renamed = (await (await call('PATCH', '/api/workspaces/dev', { name: '  Desarrollo ' })).json()) as Listed;
  assert.deepEqual([renamed.id, renamed.name, renamed.mission], ['dev', 'Desarrollo', MISSION]);
  const chosen = (await (await call('PATCH', '/api/workspaces/dev', { folders: ['web/', 'tools'], expanded: ['web', 'web/'] })).json()) as Listed;
  assert.deepEqual([chosen.folders, chosen.expanded, chosen.mission], [['tools', 'web'], ['web'], MISSION]);
  for (const [body, code] of [
    [{ name: ' ' }, 'workspace_name'],
    [{ folders: ['../x'] }, 'workspace_folders'],
    [{ expanded: ['/etc'] }, 'workspace_expanded'],
    [{ root: scratch }, 'unknown_field'],
  ] as const) {
    const response = await call('PATCH', '/api/workspaces/dev', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(((await response.json()) as { code: string }).code, code);
  }
  const cleared = (await (await call('PATCH', '/api/workspaces/dev', { mission: '' })).json()) as Listed;
  assert.equal('mission' in cleared, false);
  assert.equal('mission' in JSON.parse(await readFile(configFile, 'utf8')).workspaces[0], false);
  const missing = await call('PATCH', '/api/workspaces/nope', { mission: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { code: string }).code, 'workspace_not_found');
});
