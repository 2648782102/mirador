// Integration: the real server records its open
// agents, keeps a session file a bridge reports through the night socket, keeps the records
// over its own SIGTERM shutdown and reopens them at the next start with `--session <file>`.
// The agent is a stand-in script; every state, runtime and config dir is a scratch dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let port: number;
let base: string;
let server: ChildProcess | undefined;
let output = '';

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

const statePath = () => join(scratch, 'run', 'mirador', 'state.json');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const records = async () => JSON.parse(await readFile(recordsPath(), 'utf8')) as { owner: string; agents: Array<{ id: string; rel: string; cwd: string; cols: number; rows: number; sessionFile: string | null }> };

/** Starts the server and logs in; resolves with an API helper. */
async function start() {
  output = '';
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  const state = await waitFor(async () => JSON.parse(await readFile(statePath(), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const token = ((await session.json()) as { token: string }).token;
  return (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

/** What the stand-in agent of terminal `id` was started with, one argument per line. */
const agentArgs = (id: string) => waitFor(async () => (await readFile(join(scratch, 'home', `args-${id}`), 'utf8')).split('\n').slice(0, -1));

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-open-agents-server-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(root, 'beta'), { recursive: true });
  // An agent in a folder with a .report file reports that attention token, like a bridge would.
  for (const [rel, token] of [['done', 'finished=t-1'], ['busy', 'blocked=guarded'], ['quiet', '']]) {
    await mkdir(join(root, rel), { recursive: true });
    if (token) await writeFile(join(root, rel, '.report'), token);
  }
  await mkdir(join(scratch, 'home'), { recursive: true });
  // A stand-in for gentle-shell: record its arguments and night variables, then idle.
  // The seq is the clock in ms from node: GNU date's %3N is not portable (macOS prints it as text, and a non-number seq is refused).
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$HOME/args-$HERDR_PANE_ID"',
    'printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/night-$HERDR_PANE_ID"',
    'if [ -f .report ]; then "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --source mirador:attention --seq "$(node -e \'process.stdout.write(String(Date.now()))\')" --token "$(cat .report)"; fi',
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', launches: { reserveMb: 0 } }));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('open agents are recorded, survive the server\'s own shutdown and reopen at the next start in the same session', async () => {
  let api = await start();
  const open = async (rel: string, kind: 'agent' | 'shell') => {
    const response = await api('POST', '/api/terminals', { ws: 'dev', rel, kind, cols: 90, rows: 33 });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: string }).id;
  };
  const first = await open('alpha', 'agent');
  const second = await open('beta', 'agent');
  await open('alpha', 'shell');
  const saved = await waitFor(async () => {
    const value = await records();
    return value.agents.length === 2 ? value : undefined;
  });
  assert.equal(saved.owner, join(scratch, 'cfg', 'mirador', 'config.json'));
  assert.deepEqual(saved.agents.map((r) => [r.id, r.rel, r.cwd, r.cols, r.rows, r.sessionFile]), [
    [first, 'alpha', join(scratch, 'root', 'alpha'), 90, 33, null],
    [second, 'beta', join(scratch, 'root', 'beta'), 90, 33, null],
  ]);
  assert.equal((await stat(recordsPath())).mode & 0o777, 0o600);

  // The bridge of the first agent reports its pi session file over the night socket.
  const sessionFile = join(scratch, "it's a session.jsonl");
  await writeFile(sessionFile, '{}\n');
  // The stand-in's `>` creates the file empty before printf fills it: wait until both lines are there.
  const [socketPath, nightToken] = await waitFor(async () => {
    const lines = (await readFile(join(scratch, 'home', `night-${first}`), 'utf8')).split('\n');
    return lines[0] && lines[1] ? lines : undefined;
  });
  const bridge = createConnection(socketPath);
  await new Promise((resolve) => bridge.once('connect', resolve));
  bridge.write(JSON.stringify({ type: 'hello', terminalId: first, token: nightToken }) + '\n');
  bridge.write(JSON.stringify({ type: 'session', file: 'relative.jsonl' }) + '\n');
  bridge.write(JSON.stringify({ type: 'session', file: sessionFile }) + '\n');
  await waitFor(async () => ((await records()).agents[0].sessionFile === sessionFile ? true : undefined));
  bridge.destroy();

  // Closing an agent by hand drops its record.
  assert.equal((await api('DELETE', `/api/terminals/${second}`)).status, 204);
  await waitFor(async () => ((await records()).agents.length === 1 ? true : undefined));

  await stop();
  await assert.rejects(access(statePath()), 'the state file is removed on shutdown, as before');
  assert.deepEqual((await records()).agents.map((r) => [r.id, r.sessionFile]), [[first, sessionFile]], 'the server\'s own shutdown keeps the record');

  api = await start();
  const reopened = await waitFor(async () => {
    const list = (await (await api('GET', '/api/terminals')).json()) as Array<{ id: string; kind: string; workspaceId: string; rel: string; cwd: string; cols: number; rows: number }>;
    return list.length === 1 ? list : undefined;
  });
  assert.deepEqual(reopened.map((t) => [t.kind, t.workspaceId, t.rel, t.cwd, t.cols, t.rows]), [['agent', 'dev', 'alpha', join(scratch, 'root', 'alpha'), 90, 33]]);
  const args = await agentArgs(reopened[0].id);
  assert.deepEqual(args.slice(-2), ['--session', sessionFile], 'the agent continues its session');
  assert.equal(args[0], '-e', 'the attention bridge is loaded as before');
  const now = await waitFor(async () => {
    const value = await records();
    return value.agents[0]?.id === reopened[0].id ? value : undefined;
  });
  assert.deepEqual(now.agents.map((r) => [r.id, r.rel, r.sessionFile]), [[reopened[0].id, 'alpha', sessionFile]], 'the reopened terminal replaces the old record');
  assert.equal((await agentArgs(first)).includes('--session'), false, 'the first run started a fresh session');
  assert.match(output, /reopened 1 agent\(s\), dropped 0/);
});

test('R5a: agents that had finished their turn sleep after a restart; they are listed, woken and forgotten through the API', async () => {
  await stop();
  let api = await start();
  // The previous test's agent reopens in the background after the start: wait until every record
  // is an open or sleeping agent, or it opens after the clean-up below and the restart reopens it too.
  await waitFor(async () => {
    const open = (await (await api('GET', '/api/terminals')).json()) as Array<{ id: string }>;
    const { agents: sleeping } = (await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string }> };
    const known = new Set([...open, ...sleeping].map((agent) => agent.id));
    const { agents } = await records().catch(() => ({ agents: [] }));
    return agents.every((record) => known.has(record.id)) ? true : undefined;
  });
  // Start from no open agent at all.
  for (const info of (await (await api('GET', '/api/terminals')).json()) as Array<{ id: string }>) await api('DELETE', `/api/terminals/${info.id}`);
  const open = async (rel: string) => {
    const response = await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33 });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: string }).id;
  };
  await open('done');
  await open('busy');
  await open('quiet');
  // The states reported through the herdr stand-in reach the records (debounced).
  await waitFor(async () => {
    const states = Object.fromEntries((await records()).agents.map((r) => [r.rel, (r as { lastState?: string }).lastState]));
    return states.done === 'finished' && states.busy === 'waiting' && states.quiet === undefined ? true : undefined;
  });
  await stop();

  api = await start();
  const reopened = await waitFor(async () => {
    const list = (await (await api('GET', '/api/terminals')).json()) as Array<{ rel: string }>;
    return list.length === 2 ? list : undefined;
  });
  assert.deepEqual(reopened.map((t) => t.rel).sort(), ['busy', 'quiet'], 'waiting and unknown reopen');
  const listed = (await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; workspaceId: string; rel: string; resumable: boolean }> };
  assert.deepEqual(listed.agents.map((a) => [a.workspaceId, a.rel, a.resumable]), [['dev', 'done', false]]);
  const [sleeper] = listed.agents;

  assert.equal((await api('POST', '/api/terminals/sleeping/nope/wake')).status, 404);
  assert.equal((await api('POST', `/api/terminals/sleeping/${encodeURIComponent('../x')}/wake`)).status, 400);
  assert.equal((await api('DELETE', '/api/terminals/sleeping/nope')).status, 404);
  assert.equal((await api('POST', '/api/terminals/sleeping/wake', { ws: 7 })).status, 400);

  const woken = await api('POST', `/api/terminals/sleeping/${sleeper.id}/wake`);
  assert.equal(woken.status, 202);
  const { runId, count } = (await woken.json()) as { runId: string; count: number };
  assert.equal(count, 1);
  const wokenId = await waitFor(async () => {
    const list = (await (await api('GET', '/api/terminals')).json()) as Array<{ id: string; rel: string }>;
    return list.find((t) => t.rel === 'done')?.id;
  });
  const launches = (await (await api('GET', '/api/terminals/launches')).json()) as { runs: Array<{ id: string; kind: string }> };
  assert.equal(launches.runs.find((run) => run.id === runId)?.kind, 'wake');
  assert.deepEqual(((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: unknown[] }).agents, []);
  assert.deepEqual((await (await api('POST', '/api/terminals/sleeping/wake', {})).json()), { runId: null, count: 0 }, 'nothing left to wake');

  // The woken agent reports finished again: after one more restart it sleeps, and Olvidar drops it.
  // Its own record, by terminal id: until the wake's write lands, the file still holds the old sleeping record, also finished.
  await waitFor(async () => ((await records()).agents.some((r) => r.id === wokenId && (r as { lastState?: string }).lastState === 'finished') ? true : undefined));
  await stop();
  api = await start();
  const again = await waitFor(async () => {
    const value = ((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; rel: string }> }).agents;
    return value.length === 1 ? value : undefined;
  });
  assert.equal(again[0].rel, 'done');
  assert.equal((await api('DELETE', `/api/terminals/sleeping/${again[0].id}`)).status, 204);
  assert.deepEqual(((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: unknown[] }).agents, []);
  await waitFor(async () => ((await records()).agents.every((r) => r.rel !== 'done') ? true : undefined));
});
