// Integration: the real server puts an idle agent to
// sleep. A stand-in agent reports a finished turn through the herdr stand-in; a fake bridge on the
// night socket gets the save note, confirms it, and the stand-in reports the save turn; the agent is
// closed, listed as sleeping, kept asleep over a restart and woken with its session. The idle time is
// config `idleSleepHours: 0.0005` (1.8 s); every state, runtime and config dir is a scratch dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

/**
 * Polls `check` until it gives a value. The deadline is generous on purpose: a passing run returns as soon as the
 * condition holds, and on a loaded CI runner the server start, the 1.8 s idle clock and each agent report add up.
 */
async function waitFor<T>(check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out; server output:\n${output}`);
}

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const token = ((await session.json()) as { token: string }).token;
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

/** A bridge for terminal `id` on the night socket: it reports `sessionFile` and collects the messages it gets. */
async function bridge(id: string, sessionFile: string) {
  // The stand-in renames a finished file into place; the same wait as the other bridges keeps that from mattering.
  const [socketPath, nightToken] = await waitFor(async () => {
    const lines = (await readFile(join(scratch, 'home', `night-${id}`), 'utf8')).split('\n');
    return lines[0] && lines[1] ? lines : undefined;
  });
  const socket: Socket = createConnection(socketPath);
  await new Promise((resolve) => socket.once('connect', resolve));
  const messages: Array<{ messageId: string; text: string }> = [];
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (line.type === 'message') messages.push(line);
    }
  });
  socket.write(JSON.stringify({ type: 'hello', terminalId: id, token: nightToken }) + '\n');
  socket.write(JSON.stringify({ type: 'session', file: sessionFile }) + '\n');
  return { socket, messages };
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-hibernate-server-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'idle'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  // A stand-in for gentle-shell: records its arguments and night variables, reports a finished turn,
  // then, once the test says the save note arrived (go-<id>), a save turn that starts and, once the test
  // has seen Mirador record it as working (end-<id>), ends.
  // Each file is written aside and renamed into place, so the test never reads half of one.
  // The seq is the clock in ms from node: GNU date's %3N is not portable (macOS prints it as text, and a non-number seq is refused).
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$HOME/args-$HERDR_PANE_ID.tmp"',
    'mv -f "$HOME/args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
    'printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/night-$HERDR_PANE_ID.tmp"',
    'mv -f "$HOME/night-$HERDR_PANE_ID.tmp" "$HOME/night-$HERDR_PANE_ID"',
    'report() { "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --source mirador:attention --seq "$(node -e \'process.stdout.write(String(Date.now()))\')" "$@"; }',
    'report --token finished=t-1',
    'while [ ! -f "$HOME/go-$HERDR_PANE_ID" ]; do sleep 0.1; done',
    'report --clear-token finished',
    'while [ ! -f "$HOME/end-$HERDR_PANE_ID" ]; do sleep 0.1; done',
    'report --token finished=t-2',
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', scopes: false, idleSleepHours: 0.0005, launches: { reserveMb: 0 } }));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

test('an idle agent gets the save note, and once that turn ends it sleeps, stays asleep over a restart and wakes in its session', async () => {
  let api = await start();
  const opened = await api('POST', '/api/terminals', { ws: 'dev', rel: 'idle', kind: 'agent', cols: 90, rows: 33 });
  assert.equal(opened.status, 201);
  const id = opened.body.id as string;
  const sessionFile = join(scratch, 'idle-session.jsonl');
  await writeFile(sessionFile, '{}\n');
  const { socket, messages } = await bridge(id, sessionFile);

  const [note] = await waitFor(async () => (messages.length ? messages : undefined));
  assert.match(note.text, /^Note from Mirador/);
  assert.match(note.text, /mem_session_summary/);
  socket.write(JSON.stringify({ type: 'delivered', messageId: note.messageId }) + '\n');
  assert.equal((await api('GET', '/api/terminals')).body.length, 1, 'open while it saves');
  await writeFile(join(scratch, 'home', `go-${id}`), '');
  // The save turn starts: Mirador records the agent as working, and only then does the stand-in end the turn.
  await waitFor(async () => {
    const records = JSON.parse(await readFile(join(scratch, 'state', 'mirador', 'open-agents.json'), 'utf8')) as { agents: Array<{ id: string; lastState?: string }> };
    return records.agents.find((record) => record.id === id)?.lastState === 'working' ? true : undefined;
  });
  assert.equal((await api('GET', '/api/terminals')).body.length, 1, 'still open while the save turn runs');
  await writeFile(join(scratch, 'home', `end-${id}`), '');

  await waitFor(async () => ((await api('GET', '/api/terminals')).body.length === 0 ? true : undefined));
  const asleep = (await api('GET', '/api/terminals/sleeping')).body.agents as Array<{ id: string; rel: string; resumable: boolean }>;
  assert.deepEqual(asleep.map((a) => [a.id, a.rel, a.resumable]), [[id, 'idle', true]]);
  assert.match(output, /mirador: the open agent of workspace "dev" folder "idle" sleeps/);
  socket.destroy();

  await stop();
  api = await start();
  const still = await waitFor(async () => {
    const agents = (await api('GET', '/api/terminals/sleeping')).body.agents as Array<{ id: string }>;
    return agents.length ? agents : undefined;
  });
  assert.deepEqual(still.map((a) => a.id), [id], 'still asleep after the restart');
  assert.deepEqual((await api('GET', '/api/terminals')).body, [], 'not reopened');
  assert.equal((await api('POST', `/api/terminals/sleeping/${id}/wake`)).status, 202);
  const [woken] = await waitFor(async () => {
    const list = (await api('GET', '/api/terminals')).body as Array<{ id: string; rel: string }>;
    return list.length ? list : undefined;
  });
  assert.equal(woken.rel, 'idle');
  const args = await waitFor(async () => (await readFile(join(scratch, 'home', `args-${woken.id}`), 'utf8')).split('\n').slice(0, -1));
  assert.deepEqual(args.slice(-2), ['--session', sessionFile]);
});
