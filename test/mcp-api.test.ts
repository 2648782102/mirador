// Integration tests for the per-project MCP API: the real
// server with HOME, the config and gentle-shell's agent dir in a temp folder, never the real ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let root: string;
let agentDir: string;
let server: ChildProcess;
let base: string;
let origin: string;
let token: string;

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

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const get = (rel: string, ws = 'dev') => call('GET', `/api/mcp?${new URLSearchParams({ ws, rel })}`);
const put = (body: unknown) => call('PUT', '/api/mcp', body);

async function expectError(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(((await response.json()) as { code?: string }).code, code);
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-mcp-api-')));
  root = join(scratch, 'root');
  agentDir = join(scratch, 'gentle-agent');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'broken', '.pi'), { recursive: true });
  await writeFile(join(root, 'broken', '.pi', 'mcp.json'), '{ not json');
  await mkdir(join(scratch, 'outside'), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { context7: { command: 'npx' }, azure: { command: 'npx' }, markitdown: { command: 'uvx' } } }),
  );
  await writeFile(join(agentDir, 'trust.json'), JSON.stringify({ [root]: true }));

  const configDir = join(scratch, 'cfg', 'mirador');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', scopes: false, agentCommand: 'sleep 600 #', gentleShellAgentDir: agentDir }),
  );

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      HOME: join(scratch, 'home'),
      GENTLE_SHELL_HOME: join(scratch, 'not-this-one'),
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_STATE_HOME: join(scratch, 'state'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      MIRADOR_PORT: String(port),
    },
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('GET /api/mcp lists the servers of the configured agent dir for a folder, with its git and trust state', async () => {
  const response = await get('app');
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    file: '.pi/mcp.json',
    exists: false,
    git: 'none',
    trust: 'trusted',
    userConfig: 'ok',
    servers: [
      { name: 'context7', source: 'user', enabled: true, locked: false, description: null, estimatedMb: 110 },
      { name: 'azure', source: 'user', enabled: true, locked: false, description: null, estimatedMb: 230 },
      { name: 'markitdown', source: 'user', enabled: true, locked: false, description: null, estimatedMb: 180 },
    ],
  });
});

test('PUT /api/mcp turns servers off for that folder only, and on again', async () => {
  const response = await put({ ws: 'dev', rel: 'app', disabled: ['context7', 'markitdown'] });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { servers: Array<{ name: string; enabled: boolean }>; saved: { written: boolean; excluded: boolean }; exists: boolean };
  assert.deepEqual(body.saved, { written: true, excluded: false });
  assert.equal(body.exists, true);
  assert.deepEqual(body.servers.map((s) => [s.name, s.enabled]), [['context7', false], ['azure', true], ['markitdown', false]]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'app', '.pi', 'mcp.json'), 'utf8')), { mcpServers: { context7: { enabled: false }, markitdown: { enabled: false } } });
  const again = await put({ ws: 'dev', rel: 'app', disabled: [] });
  assert.equal(again.status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'app', '.pi', 'mcp.json'), 'utf8')), { mcpServers: {} });
});

test('PUT /api/mcp refuses unknown server names and malformed bodies with 400 mcp_invalid, writing nothing', async () => {
  await mkdir(join(root, 'fresh'), { recursive: true });
  for (const body of [
    { ws: 'dev', rel: 'fresh', disabled: ['nope'] },
    { ws: 'dev', rel: 'fresh', disabled: 'context7' },
    { ws: 'dev', rel: 'fresh', disabled: [1] },
    { ws: 'dev', rel: 'fresh' },
  ]) {
    await expectError(await put(body), 400, 'mcp_invalid');
  }
  await assert.rejects(lstat(join(root, 'fresh', '.pi')), { code: 'ENOENT' });
});

test('folders outside the workspace root and unknown workspaces are refused', async () => {
  await expectError(await get('../outside'), 400, 'folder_invalid');
  await expectError(await put({ ws: 'dev', rel: '../outside', disabled: ['azure'] }), 400, 'folder_invalid');
  await expectError(await put({ ws: 'dev', rel: join(scratch, 'outside'), disabled: ['azure'] }), 400, 'folder_invalid');
  await expectError(await get('app', 'nope'), 404, 'workspace_not_found');
  await assert.rejects(lstat(join(scratch, 'outside', '.pi')), { code: 'ENOENT' });
});

test('an existing .pi/mcp.json that is not valid JSON is 409 mcp_unreadable and stays as it was', async () => {
  await expectError(await get('broken'), 409, 'mcp_unreadable');
  await expectError(await put({ ws: 'dev', rel: 'broken', disabled: ['azure'] }), 409, 'mcp_unreadable');
  assert.equal(await readFile(join(root, 'broken', '.pi', 'mcp.json'), 'utf8'), '{ not json');
});

test('the folder tree still answers on the same server', async () => {
  const response = await call('GET', `/api/tree?${new URLSearchParams({ ws: 'dev', rel: '' })}`);
  assert.equal(response.status, 200);
  const names = ((await response.json()) as Array<{ name: string }>).map((node) => node.name);
  assert.deepEqual(names, ['app', 'broken', 'fresh']);
});
