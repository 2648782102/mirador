// Integration: the real server saves a workspace's
// project set, and POST /api/terminals/batch opens one agent per folder through the same
// registry path as POST /api/terminals. The agent is a stand-in script; every config, state
// and runtime dir is a scratch dir, and terminal scopes are off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let root: string;
let port: number;
let base: string;
let server: ChildProcess | undefined;
let api: (method: string, path: string, body?: unknown) => Promise<Response>;

type Info = { id: string; kind: string; workspaceId: string; rel: string; cwd: string; cols: number; rows: number; status: string };
type Result = { rel: string; status: string; terminal?: Info; terminalId?: string };

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

const configFile = () => join(scratch, 'cfg', 'mirador', 'config.json');

async function start() {
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
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

const terminals = async () => (await (await api('GET', '/api/terminals')).json()) as Info[];
const agentArgs = (id: string) => waitFor(async () => (await readFile(join(scratch, 'home', `args-${id}`), 'utf8')).split('\n').slice(0, -1));

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-multi-open-')));
  root = join(scratch, 'root');
  for (const dir of ['alpha', 'beta', 'gamma']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), ['#!/bin/sh', 'printf \'%s\\n\' "$@" > "$HOME/args-$HERDR_PANE_ID"', 'exec sleep 600', ''].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(configFile(), JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }], engramUrl: 'http://127.0.0.1:9', custom: 'kept', launches: { reserveMb: 0 } }, null, 2));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await start();
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('PATCH of name, folders and expanded behaves as before and leaves no project set', async () => {
  const response = await api('PATCH', '/api/workspaces/dev', { name: ' Desarrollo ', folders: ['beta/', 'alpha'], expanded: ['alpha'] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'dev', name: 'Desarrollo', root, folders: ['alpha', 'beta'], expanded: ['alpha'] });
  const refused = await api('PATCH', '/api/workspaces/dev', { folders: ['../x'] });
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { code: string }).code, 'workspace_folders');
  assert.equal('projects' in JSON.parse(await readFile(configFile(), 'utf8')).workspaces[0], false);
});

test('PATCH { projects } saves the set in config.json; a set with a folder outside the root is refused and changes nothing', async () => {
  const saved = await api('PATCH', '/api/workspaces/dev', { projects: ['gamma', 'beta/', 'gamma'] });
  assert.equal(saved.status, 200);
  assert.deepEqual(((await saved.json()) as { projects: string[] }).projects, ['beta', 'gamma']);
  const before = await readFile(configFile(), 'utf8');
  assert.deepEqual(JSON.parse(before).workspaces[0].projects, ['beta', 'gamma']);
  assert.equal(JSON.parse(before).custom, 'kept');
  for (const projects of [['../x'], ['nope'], 'beta']) {
    const refused = await api('PATCH', '/api/workspaces/dev', { projects });
    assert.equal(refused.status, 400, JSON.stringify(projects));
    assert.equal(((await refused.json()) as { code: string }).code, 'workspace_projects');
  }
  assert.equal(await readFile(configFile(), 'utf8'), before);
  const listed = (await (await api('GET', '/api/workspaces')).json()) as Array<{ projects?: string[] }>;
  assert.deepEqual(listed[0].projects, ['beta', 'gamma']);
});

test('POST /api/terminals still opens one agent in a folder, with the bridge loaded', async () => {
  const response = await api('POST', '/api/terminals', { ws: 'dev', rel: 'alpha', kind: 'agent', cols: 90, rows: 33 });
  assert.equal(response.status, 201);
  const info = (await response.json()) as Info;
  assert.deepEqual([info.kind, info.workspaceId, info.rel, info.cwd, info.cols, info.rows], ['agent', 'dev', 'alpha', join(root, 'alpha'), 90, 33]);
  assert.equal((await agentArgs(info.id))[0], '-e');
});

test('a batch with one folder outside the workspace, or a malformed one, is refused and opens nothing', async () => {
  const count = (await terminals()).length;
  for (const rels of [['beta', '../outside'], ['beta', 'nope']]) {
    const refused = await api('POST', '/api/terminals/batch', { ws: 'dev', rels });
    assert.equal(refused.status, 400, JSON.stringify(rels));
    assert.equal(((await refused.json()) as { code: string }).code, 'folder_invalid');
  }
  for (const body of [{ ws: 'dev' }, { ws: 'dev', rels: [] }, { ws: 'dev', rels: 'beta' }, { ws: 'dev', rels: [3] }, { ws: 'dev', rels: Array(51).fill('beta') }, { ws: 'dev', rels: ['beta'], saved: true }, { ws: 'dev', rels: ['beta'], reopen: 'yes' }]) {
    const refused = await api('POST', '/api/terminals/batch', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(((await refused.json()) as { code: string }).code, 'batch_invalid');
  }
  const unknown = await api('POST', '/api/terminals/batch', { ws: 'nope', rels: ['beta'] });
  assert.equal(unknown.status, 404);
  assert.equal((await terminals()).length, count);
});

test('a batch opens one agent per folder and skips a folder that already has one', async () => {
  const [alpha] = await terminals();
  const response = await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['beta', 'alpha'], cols: 100, rows: 40 });
  assert.equal(response.status, 200);
  const { results } = (await response.json()) as { results: Result[] };
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['beta', 'opened'], ['alpha', 'already_open']]);
  assert.equal(results[1].terminalId, alpha.id);
  const beta = results[0].terminal!;
  assert.deepEqual([beta.kind, beta.workspaceId, beta.rel, beta.cwd, beta.cols, beta.rows], ['agent', 'dev', 'beta', join(root, 'beta'), 100, 40]);
  assert.deepEqual((await terminals()).map((t) => [t.kind, t.rel]), [['agent', 'alpha'], ['agent', 'beta']]);
  assert.equal((await agentArgs(beta.id))[0], '-e', 'the batch agent loads the bridge like a single one');
});

test('the saved set opens with reopen, reports a folder that no longer exists, and refuses a workspace without a set', async () => {
  await rmdir(join(root, 'gamma'));
  const response = await api('POST', '/api/terminals/batch', { ws: 'dev', saved: true, reopen: true });
  assert.equal(response.status, 200);
  const { results } = (await response.json()) as { results: Result[] };
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['beta', 'opened'], ['gamma', 'missing']]);
  assert.deepEqual((await terminals()).map((t) => t.rel), ['alpha', 'beta', 'beta']);

  assert.equal((await api('PATCH', '/api/workspaces/dev', { projects: [] })).status, 200);
  const empty = await api('POST', '/api/terminals/batch', { ws: 'dev', saved: true });
  assert.equal(empty.status, 400);
  assert.equal(((await empty.json()) as { code: string }).code, 'workspace_projects_empty');
});

test('the project set survives a restart', async () => {
  assert.equal((await api('PATCH', '/api/workspaces/dev', { projects: ['alpha'] })).status, 200);
  for (const t of await terminals()) await api('DELETE', `/api/terminals/${t.id}`);
  await stop();
  await start();
  const listed = (await (await api('GET', '/api/workspaces')).json()) as Array<{ projects?: string[] }>;
  assert.deepEqual(listed[0].projects, ['alpha']);
});
