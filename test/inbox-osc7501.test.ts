// Integration: the real server and an agent terminal whose fake agent speaks OSC 7501 (the
// Program Status Protocol) with bash printf, as a program would. No real agent runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const WebSocket = createRequire(import.meta.url)('ws');

let scratch: string;
let server: ChildProcess;
let base: string;
let launchSecret: string;

interface Item { terminalId: string; kind: string; label: string; detail: string | null; blockedKind?: string }

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

async function login(): Promise<string> {
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  return ((await session.json()) as { token: string }).token;
}

const api = (token: string, method: string, path: string) => fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' && path === '/api/terminals' ? JSON.stringify({ ws: 'dev', rel: 'alpha', kind: 'agent', cols: 80, rows: 24 }) : undefined });

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-osc7501-')));
  await mkdir(join(scratch, 'root', 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  // The fake agent: probes (raw tty, no echo), keeps the reply, then reports one state per step
  // the test allows by creating $HOME/go-<terminal>-<n>. It never calls herdr: no hooks.
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/bash',
    'step() { while [ ! -e "$HOME/go-$HERDR_PANE_ID-$1" ]; do sleep 0.02; done; }',
    'stty -echo -icanon min 0 time 30',
    "printf '\\e]7501;?\\a'",
    "IFS= read -r -d $'\\a' reply",
    'printf "%s" "$reply" > "$HOME/probe-$HERDR_PANE_ID"',
    "printf 'visible-1 \\e]7501;state=working:app=fake\\e\\\\visible-2\\n'",
    'step 1',
    "printf '\\e]7501;state=blocked:kind=permission:app=fake:msg=%s\\e\\\\' \"$(printf 'Deploy to prod?' | base64)\"",
    'step 2',
    "printf '\\e]7501;state=error:app=fake:msg=%s\\a' \"$(printf 'Build failed' | base64)\"",
    'step 3',
    "printf '\\e]7501;state=clear\\e\\\\'",
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9' }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, PATH: `${join(scratch, 'bin')}:${process.env.PATH}`, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  launchSecret = (await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')))).launchSecret;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('an agent printing OSC 7501 changes its state without hooks; the probe is answered; xterm.js never sees the sequences', async () => {
  const token = await login();
  const id = ((await (await api(token, 'POST', '/api/terminals')).json()) as { id: string }).id;
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminals/${id}`, ['mirador.v1', `auth.${token}`], { headers: { origin: base } });
  let screen = '';
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString());
    if (message.t === 's' || message.t === 'o') screen += message.d;
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const agentState = async () => ((await (await api(token, 'GET', '/api/terminals')).json()) as Array<{ id: string; agentState?: string }>).find((t) => t.id === id)?.agentState;
  const items = async () => ((await (await api(token, 'GET', '/api/inbox')).json()) as { items: Item[] }).items.filter((i) => i.terminalId === id);
  const go = (n: number) => writeFile(join(scratch, 'home', `go-${id}-${n}`), '');
  try {
    assert.equal(await waitFor(async () => ((await agentState()) === 'working' ? 'working' : undefined)), 'working');
    assert.equal(await readFile(join(scratch, 'home', `probe-${id}`), 'utf8'), '\x1b]7501;?', 'the agent read the reply to its probe');

    await go(1);
    const [blocked] = await waitFor(async () => { const list = await items(); return list[0]?.kind === 'blocked' ? list : undefined; });
    assert.deepEqual([blocked.kind, blocked.label, blocked.blockedKind], ['blocked', 'Deploy to prod?', 'permission']);
    assert.equal(await agentState(), 'waiting');

    await go(2);
    const [error] = await waitFor(async () => { const list = await items(); return list[0]?.kind === 'error' ? list : undefined; });
    assert.deepEqual([error.label, error.detail], ['Error', 'Build failed']);
    assert.equal(await agentState(), 'error');

    await go(3);
    assert.equal(await waitFor(async () => ((await agentState()) === 'unknown' ? 'unknown' : undefined)), 'unknown', 'cleared, and no hook ever reported');
    assert.deepEqual(await items(), []);

    await waitFor(async () => (screen.includes('visible-2') ? true : undefined));
    assert.match(screen, /visible-1 visible-2/);
    assert.equal(screen.includes('7501'), false, JSON.stringify(screen.slice(-200)));
  } finally {
    ws.terminate();
    await api(token, 'DELETE', `/api/terminals/${id}`);
  }
});
