// Acceptance: "un agente
// en error aparece en la bandeja y idle sleep no lo trata como inactivo". The real server with idle
// sleep at config `idleSleepHours: 0.0005` (1.8 s), two stand-in agents that report with OSC 7501
// (bash printf): one stops with an error and leaves (its bash draws the prompt it marks with OSC 133
// A), one finishes its turn. Both report a pi session file over the night socket, so both could
// sleep. The finished one gets the save note; the one in error stays open, awake and in the inbox.
// No real agent runs; every state, runtime and config dir is a scratch dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inboxGroups } from '../public/features/inbox-model.js';
import { buildTracking, trackingLanes } from '../public/features/tracking-model.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const IDLE_MS = 0.0005 * 3_600_000;

let scratch: string;
let base: string;
let server: ChildProcess | undefined;
let output = '';

interface Item { terminalId: string; workspaceId: string; rel: string; kind: string; label: string; detail: string | null; since: string }

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
  throw new Error(`timed out; server output:\n${output}`);
}

async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
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

/** A bridge for terminal `id` on the night socket: it reports `sessionFile` and collects the messages it gets. */
async function bridge(id: string, sessionFile: string) {
  // The stand-in's `>` creates the file empty before printf fills it: wait until both lines are there.
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
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-error-state-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'broken'), { recursive: true });
  await mkdir(join(root, 'done'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  // The stand-in agent: in folder `broken` it reports an error and exits 1 (back to the agent bash,
  // which marks its prompt); in folder `done` it reports a finished turn and stays.
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/bash',
    'printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/night-$HERDR_PANE_ID"',
    'msg() { printf %s "$1" | base64 | tr -d "\\n"; }',
    'if [ "$(basename "$PWD")" = broken ]; then',
    '  printf \'\\e]7501;state=working\\e\\\\\'',
    '  printf \'\\e]7501;state=error:msg=%s\\e\\\\\' "$(msg "Build failed: 3 tests")"',
    '  exit 1',
    'fi',
    'printf \'\\e]7501;state=done\\e\\\\\'',
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', scopes: false, idleSleepHours: 0.0005, launches: { reserveMb: 0 } }));
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
});

test('an agent stopped with an error is in the inbox and idle sleep never puts it to sleep, while a finished agent gets the save note', async () => {
  const api = await start();
  const sockets: Socket[] = [];
  try {
    const broken = (await api('POST', '/api/terminals', { ws: 'dev', rel: 'broken', kind: 'agent', cols: 90, rows: 30 })).body.id as string;
    const brokenSession = join(scratch, 'broken.jsonl');
    await writeFile(brokenSession, '{}\n');
    const brokenBridge = await bridge(broken, brokenSession);
    sockets.push(brokenBridge.socket);

    // 1. It is in the inbox (GET /api/inbox) as an error card, after its bash drew the marked prompt.
    const inbox = async () => (await api('GET', '/api/inbox')).body as { items: Item[]; nightNotes: Item[] };
    const [card] = await waitFor(async () => {
      const items = (await inbox()).items.filter((item) => item.terminalId === broken);
      return items[0]?.kind === 'error' ? items : undefined;
    });
    assert.deepEqual([card.kind, card.label, card.detail, card.rel], ['error', 'Error', 'Build failed: 3 tests', 'broken']);
    const agentState = async (id: string) => ((await api('GET', '/api/terminals')).body as Array<{ id: string; status: string; agentState?: string }>).find((t) => t.id === id);
    await waitFor(async () => ((await readFile(join(scratch, 'home', `night-${broken}`), 'utf8')) ? true : undefined));
    assert.deepEqual(await agentState(broken).then((t) => [t?.status, t?.agentState]), ['running', 'error'], 'the agent left; its bash runs and the error stays');

    // ...and in the browser's inbox model it is in "Needs you", and the tracking view lists it there.
    const { items, nightNotes } = await inbox();
    const groups = inboxGroups(items, nightNotes);
    assert.deepEqual(groups.map((group: any) => [group.key, group.entries?.map((entry: any) => entry.item.terminalId)]), [['answer', [broken]]]);
    const terminals = (await api('GET', '/api/terminals')).body;
    const lanes = trackingLanes({ model: buildTracking({ terminals, items, activity: [] }), items, nightNotes });
    assert.deepEqual(lanes.needs.groups.map((group: any) => [group.key, group.cards.map((c: any) => [c.id, c.state])]), [['waiting', [[broken, 'error']]]]);

    // 2. A finished agent opened after it gets the save note one idle time later; the one in error,
    // whose clock would have run out first, gets none and stays open, awake and in the inbox.
    const done = (await api('POST', '/api/terminals', { ws: 'dev', rel: 'done', kind: 'agent', cols: 90, rows: 30 })).body.id as string;
    const doneSession = join(scratch, 'done.jsonl');
    await writeFile(doneSession, '{}\n');
    const doneBridge = await bridge(done, doneSession);
    sockets.push(doneBridge.socket);
    const opened = Date.now();
    const [note] = await waitFor(async () => (doneBridge.messages.length ? doneBridge.messages : undefined));
    assert.match(note.text, /^Note from Mirador/);
    assert.ok(Date.now() - opened >= IDLE_MS - 200, 'idle sleep runs, after the idle time');
    assert.deepEqual(brokenBridge.messages, [], 'no save note for the agent in error');
    assert.deepEqual(await agentState(broken).then((t) => [t?.status, t?.agentState]), ['running', 'error']);
    assert.deepEqual((await api('GET', '/api/terminals/sleeping')).body.agents, [], 'nothing sleeps');
    assert.deepEqual((await inbox()).items.filter((item) => item.terminalId === broken).map((item) => [item.kind, item.since]), [['error', card.since]], 'the same error card, still waiting');
  } finally {
    for (const socket of sockets) socket.destroy();
  }
});
