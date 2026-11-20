// GET /api/agents lists the agents the UI may offer. The real
// server runs with a scratch HOME, GENTLE_AI_HOME and PATH of stubs that are never run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

async function login(): Promise<string> {
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  return ((await session.json()) as { token: string }).token;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-agents-api-')));
  const bin = join(scratch, 'bin');
  await mkdir(bin, { recursive: true });
  for (const program of ['claude', 'opencode', 'agy', 'cursor']) {
    await writeFile(join(bin, program), '#!/bin/sh\nexit 99\n');
    await chmod(join(bin, program), 0o755);
  }
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['claude-code', 'opencode', 'pi', 'openclaw', 'vscode-copilot', 'antigravity', 'hermes', 'cursor'] }));
  await mkdir(join(scratch, 'root'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', scopes: false }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      HOME: join(scratch, 'home'),
      PATH: bin,
      GENTLE_AI_HOME: join(scratch, 'gentle-ai'),
      MIRADOR_SCOPES: '0',
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_STATE_HOME: join(scratch, 'state'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      MIRADOR_PORT: String(port),
    },
    stdio: 'ignore',
  });
  launchSecret = (await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')))).launchSecret;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => (server?.exitCode !== null ? resolve(null) : server.once('exit', resolve)));
  await rm(scratch, { recursive: true, force: true });
});

test('GET /api/agents needs the session token', async () => {
  assert.equal((await fetch(`${base}/api/agents`)).status, 401);
});

test('GET /api/agents offers the configured agentCommand, then installed catalog agents found on PATH', async () => {
  const token = await login();
  const response = await fetch(`${base}/api/agents`, { headers: { origin: base, authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  // gentle-shell is the default agentCommand: offered although this PATH lacks it.
  assert.deepEqual(await response.json(), {
    agents: [
      { id: 'pi', label: 'Pi (gentle-shell)', command: 'gentle-shell', configured: true, attention: 'hooks', resume: true },
      { id: 'claude-code', label: 'Claude Code', command: 'claude', configured: false, attention: 'hooks', resume: true },
      { id: 'opencode', label: 'opencode', command: 'opencode', configured: false, attention: 'hooks', resume: true },
      { id: 'antigravity', label: 'Antigravity', command: 'agy', configured: false, attention: 'hooks', resume: true },
    ],
  });
});
