// Integration: POST /api/terminals/batch with an
// instruction opens gentle-shell with it as the first message, gives it to agents already open
// through their bridge instead of opening a second one, stores it as each agent's task and can
// switch the autopilot on by hand. The agent is a stand-in script that records its args and its
// night variables; the bridge runs in-process. No model: the decider is the real one without a
// gentle-shell home, so it never runs. Every config, state and runtime dir is a scratch dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const INSTRUCTION = 'Run the focused tests of the delegate dialog and report.';
const FRAMED = `Task from the user, delegated through Mirador:\n\n${INSTRUCTION}`;

let scratch: string;
let server: ChildProcess;
let base: string;
let token: string;

type Info = { id: string; rel: string };
type Result = { rel: string; status: string; terminal?: Info; terminalId?: string; error?: string };

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

/** The args the stand-in agent of terminal `id` was started with, one per line as printf wrote them. */
const agentArgs = (id: string) => waitFor(async () => (await readFile(join(scratch, 'home', `args-${id}`), 'utf8')).slice(0, -1));
const night = () => api('GET', '/api/night').then((r) => json<{ active: boolean; source: string | null; until: string | null; connectedTerminals: string[] }>(r, 200));
const terminals = () => api('GET', '/api/terminals').then((r) => json<Info[]>(r, 200));
const open = async (rel: string) => (await json<Info>(await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 80, rows: 24 }), 201)).id;
const closeAll = async () => { for (const info of await terminals()) await api('DELETE', `/api/terminals/${info.id}`); };

/** Connects an in-process bridge for terminal `id`; returns what it handed to pi. */
async function connect(id: string): Promise<string[]> {
  const [socket, nightToken] = await waitFor(async () => {
    const lines = (await readFile(join(scratch, 'home', `night-${id}`), 'utf8')).split('\n');
    return lines[0] && lines[1] ? lines : undefined;
  });
  const received: string[] = [];
  createAttentionBridge({
    env: { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: id, MIRADOR_NIGHT_SOCKET: socket, MIRADOR_NIGHT_TOKEN: nightToken },
    night: { retryMinMs: 50, retryMaxMs: 100 },
  })({ on: () => {}, sendUserMessage: (text: string) => void received.push(text) });
  await waitFor(async () => ((await night()).connectedTerminals.includes(id) ? true : undefined));
  return received;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-delegate-')));
  const root = join(scratch, 'root');
  for (const dir of ['alpha', 'beta', 'gamma']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  // A stand-in for gentle-shell: record its args, night variables and pid (each file renamed into place), then
  // idle. `exec` keeps the pid, so after() can check that the idling sleep ended with the server.
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$HOME/.args-$HERDR_PANE_ID.tmp" && mv "$HOME/.args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
    'printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/.night-$HERDR_PANE_ID.tmp" && mv "$HOME/.night-$HERDR_PANE_ID.tmp" "$HOME/night-$HERDR_PANE_ID"',
    'printf \'%s\\n\' "$$" > "$HOME/.pid-$HERDR_PANE_ID.tmp" && mv "$HOME/.pid-$HERDR_PANE_ID.tmp" "$HOME/pid-$HERDR_PANE_ID"',
    'exec sleep 600',
    '',
  ].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }], engramUrl: 'http://127.0.0.1:9', launches: { reserveMb: 0 } }));
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
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
});

/** Resolves true once `child` has exited, or false after `ms`. A child that already exited resolves true at once. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Whether `pid` is still the stand-in of terminal `id` (and not a process that reused its pid): on Linux by its
 * HERDR_PANE_ID, elsewhere by its command line. An exited process, or one only its parent has yet to reap, is not.
 */
function isStandIn(pid: number, id: string): boolean {
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HERDR_PANE_ID=${id}`);
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() === 'sleep 600';
  } catch {
    return false;
  }
}

/** The stand-ins that still run, from the pid each one recorded. */
async function liveStandIns(): Promise<Array<{ pid: number; id: string }>> {
  const names = await readdir(join(scratch, 'home')).catch(() => [] as string[]);
  const recorded = await Promise.all(names.filter((name) => name.startsWith('pid-')).map(async (name) => ({ pid: Number(await readFile(join(scratch, 'home', name), 'utf8')), id: name.slice(4) })));
  return recorded.filter(({ pid, id }) => pid > 0 && isStandIn(pid, id));
}

/**
 * Stops the server and waits, with bounds, until it and every stand-in agent it started are gone.
 * - A server still running 10 s after SIGTERM is SIGKILLed so it never outlives the run, and the run fails: a
 *   server that does not stop is this test's failure. The stand-ins are still swept first.
 * - The server hangs up its terminals on SIGTERM, which ends the stand-ins; one still running 5 s after the
 *   server exited is SIGKILLed so it never outlives the run, and is printed as a warning without failing:
 *   without scopes the server only sends SIGHUP to each terminal's shell and does not wait, so an agent that
 *   outlives it is a known product bug (#1), not this test's.
 */
after(async () => {
  const problems: string[] = [];
  const failures: string[] = [];
  try {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      if (!(await exited(server, 10_000))) {
        server.kill('SIGKILL');
        failures.push(`the server (pid ${server.pid}) still ran 10 s after SIGTERM and was SIGKILLed`);
        if (!(await exited(server, 5000))) failures.push(`the server (pid ${server.pid}) still ran 5 s after SIGKILL`);
      }
    }
  } finally {
    if (scratch) {
      const deadline = Date.now() + 5000;
      let left = await liveStandIns();
      while (left.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        left = await liveStandIns();
      }
      for (const { pid, id } of left) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone meanwhile (ESRCH).
        }
        problems.push(`the stand-in agent of terminal ${id} (pid ${pid}) still ran 5 s after the server exited, and was SIGKILLed`);
      }
      await rm(scratch, { recursive: true, force: true });
    }
  }
  for (const problem of problems) console.warn(`warning: Mirador left a process behind at shutdown: ${problem}`);
  if (failures.length > 0) throw new Error(`Mirador did not stop at shutdown: ${failures.join('; ')}`);
});

test('a malformed delegation is 400 delegate_invalid and opens or switches nothing', async () => {
  const bodies = [
    { instruction: '' },
    { instruction: '   \n ' },
    { instruction: 'x'.repeat(2001) },
    { instruction: 42 },
    { instruction: 'Run the tests.\u0007' },
    { instruction: 'Run the tests.', autopilot: 'yes' },
    { instruction: 'Run the tests.', reopen: true },
    { autopilot: true },
  ];
  for (const body of bodies) {
    const refused = await json<{ code: string }>(await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['alpha'], ...body }), 400);
    assert.equal(refused.code, 'delegate_invalid', JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual(await terminals(), []);
  assert.equal((await night()).active, false);
});

test('each folder is reported: a new agent opens with the instruction as its first message, an open agent gets it as a message, one whose bridge is away fails', async () => {
  const alpha = await open('alpha');
  const received = await connect(alpha);
  const gamma = await open('gamma');
  const { results, autopilot } = await json<{ results: Result[]; autopilot?: string }>(
    await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['alpha', 'beta', 'gamma'], instruction: `  ${INSTRUCTION}\n`, autopilot: false, cols: 90, rows: 30 }),
    200,
  );
  assert.deepEqual(results.map((r) => [r.rel, r.status, r.terminalId ?? null, r.error ?? null]), [
    ['alpha', 'sent', alpha, null],
    ['beta', 'opened', null, null],
    ['gamma', 'failed', null, "the agent's bridge is not connected"],
  ]);
  assert.equal(autopilot, undefined, 'unchecked: the autopilot is left alone');
  assert.equal((await night()).active, false);
  assert.deepEqual(received, [FRAMED]);
  const beta = results[1].terminal!.id;
  assert.equal(await agentArgs(beta), `-e\n${join(APP_DIR, 'src', 'attention', 'gentle-shell-bridge.ts')}\n${FRAMED}`);
  assert.equal(await agentArgs(alpha), `-e\n${join(APP_DIR, 'src', 'attention', 'gentle-shell-bridge.ts')}`, 'a single open has no first message (as before)');

  const reminder = await json<{ workspaces: Array<{ agents: Array<{ terminalId: string; task: string | null }> }> }>(await api('GET', '/api/night/reminder'), 200);
  assert.deepEqual(new Map(reminder.workspaces.flatMap((w) => w.agents.map((a) => [a.terminalId, a.task]))), new Map([[alpha, INSTRUCTION], [beta, INSTRUCTION], [gamma, null]]));
  const records = await waitFor(async () => (await readFile(join(scratch, 'state', 'mirador', 'open-agents.json'), 'utf8')));
  assert.ok(records.includes(beta) && !records.includes('focused tests'), 'the open-agents record keeps no instruction, so a restore never sends it again');
  await closeAll();
});

test('"Prender el piloto automático" switches it on by hand with no until when it is off, and leaves an on alone', async () => {
  const first = await json<{ results: Result[]; autopilot: string }>(await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['beta'], instruction: INSTRUCTION, autopilot: true }), 200);
  assert.equal(first.autopilot, 'turned_on');
  assert.deepEqual(first.results.map((r) => r.status), ['opened']);
  const on = await night();
  assert.deepEqual([on.active, on.source, on.until], [true, 'manual', null]);
  const saved = JSON.parse(await readFile(join(scratch, 'state', 'mirador', 'night', 'autopilot.json'), 'utf8'));
  assert.equal(saved.manual.until, null, 'saved before the answer, so a restart keeps it');
  const log = await json<{ activations: Array<{ cause: string }> }>(await api('GET', '/api/night/activations?limit=1'), 200);
  assert.equal(log.activations[0]?.cause, 'delegation', 'the activation log tells a delegation from a switch by hand');
  await closeAll();

  await json(await api('PUT', '/api/night', { active: true, until: '23:59' }), 200);
  const limited = await night();
  const second = await json<{ autopilot: string }>(await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['beta'], instruction: INSTRUCTION, autopilot: true }), 200);
  assert.equal(second.autopilot, 'already_on');
  assert.equal((await night()).until, limited.until, 'its until is kept');
  await json(await api('PUT', '/api/night', { active: false }), 200);
  await closeAll();
});

test('a batch without an instruction still skips open folders and answers only the results', async () => {
  const alpha = await open('alpha');
  const body = await json<Record<string, unknown>>(await api('POST', '/api/terminals/batch', { ws: 'dev', rels: ['alpha'] }), 200);
  assert.deepEqual(body, { results: [{ rel: 'alpha', status: 'already_open', terminalId: alpha }] });
  await closeAll();
});

test('POST /api/night/sensitive names the sensitive topic an instruction mentions, for the dialog warning', async () => {
  assert.deepEqual(await json(await api('POST', '/api/night/sensitive', { text: 'Push to main when the tests pass.' }), 200), { topic: 'production' });
  assert.deepEqual(await json(await api('POST', '/api/night/sensitive', { text: 'Use the token in .env' }), 200), { topic: 'env-file' });
  assert.deepEqual(await json(await api('POST', '/api/night/sensitive', { text: INSTRUCTION }), 200), { topic: null });
  for (const body of [{}, { text: 3 }, { text: 'x'.repeat(8001) }]) assert.equal((await json<{ code: string }>(await api('POST', '/api/night/sensitive', body), 400)).code, 'night_text');
});
