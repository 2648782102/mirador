// Integration: the real server with its night socket, agent terminals that get the night
// variables, a bridge running in-process against that socket, and the night API.
// The decider is the "not installed" one, so every decision defers. No model is involved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';
import { scratchBase } from './helpers/scratch.ts';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let server: ChildProcess;
let base: string;
let launchSecret: string;
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

/** The socket and token lines a stand-in recorded in `name` under the scratch home, once both are there. */
function readNight(name: string): Promise<string[]> {
  return waitFor(async () => {
    const lines = (await readFile(join(scratch, 'home', name), 'utf8')).split('\n');
    return lines.length >= 2 && lines[0] && lines[1] ? lines : undefined;
  });
}

async function login(): Promise<string> {
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  return ((await session.json()) as { token: string }).token;
}

function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as T;
}

async function openTerminal(kind: 'agent' | 'shell'): Promise<string> {
  return (await json<{ id: string }>(await api('POST', '/api/terminals', { ws: 'dev', rel: 'alpha', kind, cols: 80, rows: 24 }), 201)).id;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-night-api-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  // A stand-in for gentle-shell: record the night variables it was given, then idle.
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    // Written to a temporary file and renamed, so a reader never sees half of it.
    'printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/.night-$HERDR_PANE_ID.tmp"',
    'mv "$HOME/.night-$HERDR_PANE_ID.tmp" "$HOME/night-$HERDR_PANE_ID"',
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  // A shell terminal records the same through the user's bashrc (agent terminals source it too: skip them).
  await writeFile(join(scratch, 'home', '.bashrc'), '[ -n "$MIRADOR_AGENT_COMMAND" ] || { printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/.shell-night.tmp" && mv "$HOME/.shell-night.tmp" "$HOME/shell-night"; }\n');
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', launches: { reserveMb: 0 } }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PATH: `${join(scratch, 'bin')}:${process.env.PATH}`,
      HOME: join(scratch, 'home'),
      // No gentle-shell agent home: the real decider defers and never calls a model.
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      XDG_STATE_HOME: join(scratch, 'state'),
      MIRADOR_PORT: String(port),
      MIRADOR_SCOPES: '0',
    },
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  launchSecret = state.launchSecret;
  token = await login();
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('the night API needs the session token, and changes need the app origin', async () => {
  for (const [method, path] of [['GET', '/api/night'], ['PUT', '/api/night'], ['POST', '/api/night/delegate/x'], ['GET', '/api/night/log']]) {
    assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base } })).status, 401, `${method} ${path}`);
    assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base, authorization: 'Bearer wrong' } })).status, 401, `${method} ${path}`);
  }
  for (const [method, path] of [['PUT', '/api/night'], ['POST', '/api/night/delegate/x']]) {
    const response = await fetch(`${base}${path}`, { method, headers: { origin: 'http://evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"active":true}' });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal((await json(await api('GET', '/api/night'), 200)).active, false, 'nothing was turned on');
});

test('the night socket is private to this user', async () => {
  const dir = join(scratch, 'run', 'mirador', 'night');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const socket = await stat(join(dir, 'socket'));
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
});

test('GET and PUT /api/night report and switch the night shift; bad bodies are 400', async () => {
  assert.deepEqual(await json(await api('GET', '/api/night'), 200), { active: false, available: true, since: null, source: null, until: null, connectedTerminals: [], pending: [] });
  for (const body of [{}, { active: 'yes' }, { active: true, extra: 1 }, { on: true }]) {
    const error = await json(await api('PUT', '/api/night', body), 400);
    assert.equal(error.code, 'night_invalid', JSON.stringify(body));
  }
  const on = await json(await api('PUT', '/api/night', { active: true }), 200);
  assert.equal(on.active, true);
  assert.equal(typeof on.since, 'string');
  const off = await json(await api('PUT', '/api/night', { active: false }), 200);
  assert.equal(off.active, false);
});

test('agent terminals get the socket and their own token; shells get neither', async () => {
  const first = await openTerminal('agent');
  const second = await openTerminal('agent');
  const read = (id: string) => readNight(`night-${id}`);
  const [socketA, tokenA] = await read(first);
  const [socketB, tokenB] = await read(second);
  assert.equal(socketA, join(scratch, 'run', 'mirador', 'night', 'socket'));
  assert.equal(socketB, socketA);
  assert.match(tokenA, /^[\w-]{40,}$/);
  assert.notEqual(tokenA, tokenB);
  await openTerminal('shell');
  assert.deepEqual(await waitFor(async () => (await readFile(join(scratch, 'home', 'shell-night'), 'utf8')).split('\n')), ['none', 'none', '']);
  for (const id of [first, second]) await api('DELETE', `/api/terminals/${id}`);
});

test('a bridge connects with its token, its question is answered, deferred and logged; delegation answers 202', async () => {
  const id = await openTerminal('agent');
  const [socketPath, nightToken] = await readNight(`night-${id}`);
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  createAttentionBridge({
    env: { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: id, MIRADOR_NIGHT_SOCKET: socketPath, MIRADOR_NIGHT_TOKEN: nightToken },
    night: { retryMinMs: 50, retryMaxMs: 100 },
  })({ on: (name, handler) => void hooks.set(name, handler as (event: unknown, ctx: unknown) => unknown) });
  await waitFor(async () => ((await json<{ connectedTerminals: string[] }>(await api('GET', '/api/night'), 200)).connectedTerminals.includes(id) ? true : undefined));

  await json(await api('PUT', '/api/night', { active: true }), 200);
  const input = { question: 'Which layout should the report use?', options: [{ label: 'Grid', description: 'cards', value: 'v1' }, { label: 'List', description: 'rows', value: 'v2' }] };
  const result = await hooks.get('tool_call')!({ type: 'tool_call', toolName: 'ask_user_choice', toolCallId: 'call-1', input }, {});
  assert.equal(result, undefined, 'the decider cannot reach pi here and defers, so the dialog opens');

  const status = await json<{ pending: Array<{ terminalId: string; rule: string; summary: string }> }>(await api('GET', '/api/night'), 200);
  assert.deepEqual(status.pending.map((p) => [p.terminalId, p.rule, p.summary]), [[id, 'decider', 'Which layout should the report use?']]);
  const { records } = await json<{ records: Array<Record<string, unknown>> }>(await api('GET', '/api/night/log'), 200);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'question');
  assert.equal(records[0].outcome, 'deferred');
  assert.deepEqual(records[0].decision, { action: 'defer', reason: 'gentle-shell pi or its Claude bridge is not available' });

  assert.equal((await json(await api('POST', '/api/night/delegate/no-such-terminal'), 404)).code, 'night_terminal');
  const delegated = await json<{ id: string }>(await api('POST', `/api/night/delegate/${id}`), 202);
  const record = await waitFor(async () => (await json<{ records: Array<Record<string, unknown>> }>(await api('GET', '/api/night/log'), 200)).records.find((r) => r.id === delegated.id));
  assert.equal(record.kind, 'delegate');
  assert.equal(record.outcome, 'deferred', 'no follow-up is sent while the decider is not installed');
  assert.equal(record.sent, 'none');

  const logDir = join(scratch, 'state', 'mirador', 'night');
  assert.equal((await stat(logDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(logDir, 'decisions.jsonl'))).mode & 0o777, 0o600);
  const logText = await readFile(join(logDir, 'decisions.jsonl'), 'utf8');
  assert.ok(!logText.includes(nightToken), 'the token is never logged');
  assert.ok(!logText.includes('v1') && !logText.includes('v2'), 'option values never leave the agent');

  // Closing the terminal retires its token: the bridge cannot come back.
  await api('DELETE', `/api/terminals/${id}`);
  await waitFor(async () => ((await json<{ connectedTerminals: string[] }>(await api('GET', '/api/night'), 200)).connectedTerminals.includes(id) ? undefined : true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await json<{ connectedTerminals: string[] }>(await api('GET', '/api/night'), 200)).connectedTerminals.includes(id), false);
  await json(await api('PUT', '/api/night', { active: false }), 200);
});

test('GET /api/night/log validates since and limit', async () => {
  assert.equal((await json(await api('GET', '/api/night/log?since=yesterday'), 400)).code, 'night_since');
  assert.equal((await json(await api('GET', '/api/night/log?limit=0'), 400)).code, 'night_limit');
  assert.equal((await json(await api('GET', '/api/night/log?limit=5000'), 400)).code, 'night_limit');
  const future = await json<{ records: unknown[] }>(await api('GET', `/api/night/log?since=${Date.now() + 60_000}`), 200);
  assert.deepEqual(future.records, []);
  const iso = await json<{ records: unknown[] }>(await api('GET', '/api/night/log?since=2000-01-01T00:00:00Z'), 200);
  assert.ok(Array.isArray(iso.records));
});

/* ---------- Schedule, reminder and execution notes ---------- */

test('the schedule, reminder and notes API need the session token, and changes need the app origin', async () => {
  for (const [method, path] of [['GET', '/api/night/schedule'], ['PUT', '/api/night/schedule'], ['GET', '/api/night/reminder'], ['GET', '/api/night/notes'], ['POST', '/api/night/notes'], ['DELETE', '/api/night/notes/x']]) {
    assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base } })).status, 401, `${method} ${path}`);
  }
  for (const [method, path] of [['PUT', '/api/night/schedule'], ['POST', '/api/night/notes'], ['DELETE', '/api/night/notes/x']]) {
    const response = await fetch(`${base}${path}`, { method, headers: { origin: 'http://evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
});

test('GET/PUT /api/night/schedule: default off, strict validation (night_schedule), saved 0600, next window computed', async () => {
  const first = await json<{ schedule: { enabled: boolean }; timeZone: string; current: unknown; next: unknown; reminderDue: boolean }>(await api('GET', '/api/night/schedule'), 200);
  assert.equal(first.schedule.enabled, false);
  assert.equal(typeof first.timeZone, 'string');
  assert.equal(first.next, null);
  for (const body of [{}, { enabled: true }, { enabled: true, days: [8], start: '23:00', end: '07:00' }, { enabled: true, days: [1], start: '23:00', end: '23:00' }, { enabled: true, days: [1], start: '23:00', end: '07:00', remindBeforeMinutes: 999 }, { enabled: true, days: [1], start: '23:00', end: '07:00', extra: true }]) {
    const error = await json(await api('PUT', '/api/night/schedule', body), 400);
    assert.equal(error.code, 'night_schedule', JSON.stringify(body));
  }
  // A window starting in three hours, every day: nothing turns on now.
  const hhmm = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const start = new Date(Date.now() + 3 * 3600_000);
  const end = new Date(Date.now() + 4 * 3600_000);
  const schedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(start), end: hhmm(end), remindBeforeMinutes: 30 };
  const saved = await json<{ schedule: unknown; current: unknown; next: { start: string; end: string; remindAt: string }; reminderDue: boolean }>(await api('PUT', '/api/night/schedule', schedule), 200);
  assert.deepEqual(saved.schedule, schedule);
  assert.equal(saved.current, null);
  assert.equal(saved.reminderDue, false);
  assert.ok(Math.abs(Date.parse(saved.next.start) - start.getTime()) < 61_000, 'the next window starts at the local time given');
  assert.equal(Date.parse(saved.next.start) - Date.parse(saved.next.remindAt), 30 * 60_000);
  assert.equal((await json<{ active: boolean }>(await api('GET', '/api/night'), 200)).active, false);
  const file = join(scratch, 'state', 'mirador', 'night', 'schedule.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), schedule);
  await json(await api('PUT', '/api/night/schedule', { ...schedule, enabled: false }), 200);
});

test('notes: validation codes, a sensitive warning, 0600 file, delete; the reminder lists the agent and the missing mission', async () => {
  const agentId = await openTerminal('agent');
  const shellId = await openTerminal('shell');
  const bad: Array<[unknown, number, string]> = [
    [{ workspaceId: 'dev' }, 400, 'night_note'],
    [{ workspaceId: 'dev', text: 'x'.repeat(2001) }, 400, 'night_note'],
    [{ workspaceId: 'dev', text: 'ok', other: 1 }, 400, 'night_note'],
    [{ workspaceId: 'nope', text: 'ok' }, 404, 'night_note_workspace'],
    [{ workspaceId: 'dev', terminalId: 'no-such-terminal', text: 'ok' }, 400, 'night_note_terminal'],
    [{ workspaceId: 'dev', terminalId: shellId, text: 'ok' }, 400, 'night_note_terminal'],
  ];
  for (const [body, status, code] of bad) assert.equal((await json(await api('POST', '/api/night/notes', body), status)).code, code, JSON.stringify(body).slice(0, 60));

  const plain = await json<{ id: string; delivered: boolean; sensitive: string | null; terminalId?: string }>(await api('POST', '/api/night/notes', { workspaceId: 'dev', terminalId: agentId, text: 'Finish the schedule tests.' }), 201);
  assert.equal(plain.delivered, false);
  assert.equal(plain.sensitive, null);
  assert.equal(plain.terminalId, agentId);
  const risky = await json<{ id: string; sensitive: string | null }>(await api('POST', '/api/night/notes', { workspaceId: 'dev', text: 'Deploy to production when green.' }), 201);
  assert.equal(risky.sensitive, 'production', 'the panel warns; the note is still kept as written');
  const { notes } = await json<{ notes: Array<{ id: string; text: string }> }>(await api('GET', '/api/night/notes'), 200);
  assert.deepEqual(notes.map((note) => note.id), [plain.id, risky.id]);
  assert.equal((await stat(join(scratch, 'state', 'mirador', 'night', 'notes.json'))).mode & 0o777, 0o600);

  const reminder = await json<{ workspaces: Array<{ workspaceId: string; hasMission: boolean; missionNote: string | null; agents: Array<{ terminalId: string; state: string }> }>; due: boolean; pending: unknown[] }>(await api('GET', '/api/night/reminder'), 200);
  const dev = reminder.workspaces.find((w) => w.workspaceId === 'dev')!;
  assert.equal(dev.hasMission, false);
  assert.equal(dev.missionNote, 'This workspace has no mission: Mirador will defer everything there.');
  assert.ok(dev.agents.some((agent) => agent.terminalId === agentId && agent.state === 'working'));
  assert.ok(!dev.agents.some((agent) => agent.terminalId === shellId), 'shells are not agents');
  assert.equal(reminder.due, false);

  assert.equal((await api('DELETE', `/api/night/notes/${plain.id}`)).status, 204);
  assert.equal((await api('DELETE', `/api/night/notes/${risky.id}`)).status, 204);
  assert.equal((await json(await api('DELETE', `/api/night/notes/${plain.id}`), 404)).code, 'night_note_unknown');
  assert.equal((await json(await api('DELETE', '/api/night/notes/..%2F..%2Fetc'), 404)).code, 'night_note_unknown');
  for (const id of [agentId, shellId]) await api('DELETE', `/api/terminals/${id}`);
});

test('turning the night shift on delivers a pending note through the agent’s bridge, once', async () => {
  const id = await openTerminal('agent');
  const [socketPath, nightToken] = await readNight(`night-${id}`);
  const received: string[] = [];
  createAttentionBridge({
    env: { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: id, MIRADOR_NIGHT_SOCKET: socketPath, MIRADOR_NIGHT_TOKEN: nightToken },
    night: { retryMinMs: 50, retryMaxMs: 100 },
  })({ on: () => {}, sendUserMessage: (text: string) => void received.push(text) });
  await waitFor(async () => ((await json<{ connectedTerminals: string[] }>(await api('GET', '/api/night'), 200)).connectedTerminals.includes(id) ? true : undefined));
  const note = await json<{ id: string }>(await api('POST', '/api/night/notes', { workspaceId: 'dev', terminalId: id, text: 'Keep going with N5, then stop.' }), 201);
  assert.deepEqual(received, [], 'nothing goes out while the night shift is off');

  await json(await api('PUT', '/api/night', { active: true }), 200);
  const delivered = await waitFor(async () => (await json<{ notes: Array<{ id: string; delivered: boolean; deliveredTo?: string[] }> }>(await api('GET', '/api/night/notes'), 200)).notes.find((n) => n.id === note.id && n.delivered));
  assert.deepEqual(delivered.deliveredTo, [id]);
  assert.deepEqual(received, ['Execution note from the user, who is away from the keyboard:\n\nKeep going with N5, then stop.']);
  const record = await waitFor(async () => (await json<{ records: Array<Record<string, unknown>> }>(await api('GET', '/api/night/log'), 200)).records.find((r) => r.kind === 'note' && r.terminalId === id));
  assert.equal(record.sent, 'message');

  await json(await api('PUT', '/api/night', { active: false }), 200);
  await json(await api('PUT', '/api/night', { active: true }), 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.length, 1, 'delivered once');
  await json(await api('PUT', '/api/night', { active: false }), 200);
  await api('DELETE', `/api/night/notes/${note.id}`);
  await api('DELETE', `/api/terminals/${id}`);
});

test('N1: an old decisions.jsonl line whose decidedBy is the legacy owner value is listed by GET /api/night/log as user-telegram; the file keeps its bytes', async () => {
  const logDir = join(scratch, 'state', 'mirador', 'night');
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const file = join(logDir, 'decisions.jsonl');
  const old = {
    id: 'n1-old-answer', time: new Date().toISOString(), kind: 'question', terminalId: 'gone', workspaceId: 'dev', rel: 'alpha', tool: 'ask_user_choice',
    question: null, policy: { allowed: false, rule: 'sensitive' }, decision: { action: 'answer', choices: [{ item: 0, index: 1, label: 'List' }], reason: 'answered from Telegram' },
    followUp: null, sent: 'decided', heldId: 'AbCdEfGhIjKlMnOp', decidedBy: LEGACY_USER_VALUES.decidedBy, delivered: null, outcome: 'decided', deferral: null, error: null,
  };
  const line = JSON.stringify(old) + '\n';
  await appendFile(file, line);
  const before = await readFile(file, 'utf8');
  const { records } = await json<{ records: Array<Record<string, unknown>> }>(await api('GET', '/api/night/log'), 200);
  assert.deepEqual(records.find((r) => r.id === old.id), { ...old, decidedBy: 'user-telegram' });
  assert.equal(await readFile(file, 'utf8'), before, 'reading never rewrites the file');
  assert.ok(before.endsWith(line), 'the old line stays on disk as written');
});
