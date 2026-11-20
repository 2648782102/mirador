// kimi (Kimi Code CLI) is offered and opened launch-only. Kimi reads `[[hooks]]`
// only from `$KIMI_CODE_HOME/config.toml` and installed plugins, so Mirador cannot add its hooks for one launch without
// writing the user's kimi config; it starts `kimi` with nothing added, writes no kimi file anywhere, and a restore or
// wake starts a fresh session even when a record carries a session id. The real server runs with a scratch HOME,
// runtime, state and config dir and a PATH of stand-ins that record their argv and environment. No real agent runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// A session id as kimi's docs show one (https://moonshotai.github.io/kimi-code/en/reference/kimi-command): a SESSION_ID.
const ID = '01HZQ3V7K8M2N4P6R8T0W2Y4A6';

let scratch: string;
let base: string;
let server: ChildProcess | undefined;
let output = '';
let api: (method: string, path: string, body?: unknown) => Promise<Response>;

type Info = { id: string; rel: string; agent?: string };
type Record = { id: string; rel: string; sessionFile: string | null; session?: string; agent?: string; lastState?: string };

/**
 * Polls `check` until it gives a value. The deadline is generous on purpose: a passing run returns as soon as the
 * condition holds, and a loaded CI runner can take several seconds to start the server or an agent.
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

const home = () => join(scratch, 'home');
const herdrDir = () => join(scratch, 'run', 'mirador', 'herdr');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const records = async () => (JSON.parse(await readFile(recordsPath(), 'utf8')) as { agents: Record[] }).agents;
const recordOf = (id: string) => waitFor(async () => (await records()).find((r) => r.id === id));
/** The program name and arguments the stand-in agent of terminal `id` was started with. */
const started = (id: string) => waitFor(async () => (await readFile(join(home(), `args-${id}`), 'utf8')).split('\n').slice(0, -1));
/** The names of the variables the stand-in agent of terminal `id` saw. */
const variables = (id: string) => waitFor(async () => (await readFile(join(home(), `env-${id}`), 'utf8')).split('\n').filter(Boolean).map((entry) => entry.split('=')[0]));
const exists = (path: string) => access(path).then(() => true, () => false);
const listed = async () => (await (await api('GET', '/api/terminals')).json()) as Info[];
/** What must never appear: kimi's config or data folders, or a kimi file in the projects or the runtime folder. */
async function untouched(): Promise<void> {
  for (const name of ['.kimi-code', '.kimi', join('.config', 'kimi'), join('.config', 'kimi-code')]) assert.equal(await exists(join(home(), name)), false, `no ~/${name} written`);
  for (const rel of ['', 'alpha', 'beta']) {
    for (const name of ['.kimi-code', '.kimi', 'AGENTS.md']) assert.equal(await exists(join(scratch, 'root', rel, name)), false, `no ${rel}/${name} written`);
  }
  assert.deepEqual((await readdir(herdrDir())).filter((name) => name.includes('kimi')), []);
}

async function start(): Promise<void> {
  output = '';
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      PATH: join(scratch, 'bin'),
      HOME: home(),
      GENTLE_AI_HOME: join(scratch, 'gentle-ai'),
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      MIRADOR_SCOPES: '0',
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
  api = (method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-kimi-server-')));
  for (const rel of ['alpha', 'beta', 'pi']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(home(), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  // Stand-ins: each records its own name, its arguments and its variable names, then idles. Each file is written
  // aside and renamed into place, the variables before the arguments, so a test that sees the arguments file never
  // reads half of it, nor misses the variables file.
  for (const program of ['kimi', 'gentle-shell']) {
    await writeFile(join(scratch, 'bin', program), [
      '#!/bin/sh',
      '/usr/bin/env > "$HOME/env-$HERDR_PANE_ID.tmp"',
      '/bin/mv -f "$HOME/env-$HERDR_PANE_ID.tmp" "$HOME/env-$HERDR_PANE_ID"',
      '{ printf \'%s\\n\' "${0##*/}"; for word in "$@"; do printf \'%s\\n\' "$word"; done; } > "$HOME/args-$HERDR_PANE_ID.tmp"',
      '/bin/mv -f "$HOME/args-$HERDR_PANE_ID.tmp" "$HOME/args-$HERDR_PANE_ID"',
      'exec sleep 600',
      '',
    ].join('\n'), { mode: 0o755 });
  }
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi', 'kimi'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 } }));
});

after(async () => {
  await stop();
  await rm(scratch, { recursive: true, force: true });
});

const open = async (rel: string, agent?: string) => {
  const response = await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33, ...(agent === undefined ? {} : { agent }) });
  assert.equal(response.status, 201);
  return (await response.json()) as Info;
};

test('choosing kimi starts plain `kimi`, offered without attention or resume, and writes no kimi config', async () => {
  await start();
  const offered = ((await (await api('GET', '/api/agents')).json()) as { agents: Array<{ id: string }> }).agents;
  assert.deepEqual(offered.find((agent) => agent.id === 'kimi'), { id: 'kimi', label: 'Kimi', command: 'kimi', configured: false, attention: 'none', resume: false });
  const alpha = await open('alpha', 'kimi');
  assert.deepEqual(await started(alpha.id), ['kimi']);
  assert.equal((await variables(alpha.id)).some((name) => name.startsWith('KIMI')), false, 'no KIMI_CODE_HOME or other kimi variable');
  const beta = await open('beta', 'kimi');
  assert.deepEqual(await started(beta.id), ['kimi']);
  const record = await recordOf(alpha.id);
  assert.deepEqual([record.agent, record.session, record.sessionFile], ['kimi', undefined, null]);
  // The pi agent beside it is untouched: the configured gentle-shell with its own bridge.
  const pi = await open('pi');
  const piArgs = await started(pi.id);
  assert.deepEqual([piArgs[0], piArgs[1], piArgs.length], ['gentle-shell', '-e', 3]);
  assert.match(piArgs[2], /gentle-shell-bridge\.ts$/);
  assert.equal((await api('DELETE', `/api/terminals/${pi.id}`)).status, 204);
  await untouched();
});

test('a restart and a wake start kimi fresh: a session id in its record is never passed', async () => {
  await stop();
  // Hand-edited records that carry a valid session id: alpha reopens, beta (finished) sleeps.
  const saved = JSON.parse(await readFile(recordsPath(), 'utf8')) as { owner: string; agents: Array<{ rel: string; session?: string; lastState?: string }> };
  for (const record of saved.agents) record.session = ID;
  saved.agents.find((record) => record.rel === 'beta')!.lastState = 'finished';
  await writeFile(recordsPath(), JSON.stringify(saved), { mode: 0o600 });

  await start();
  const reopened = await waitFor(async () => ((await listed()).length === 1 ? listed() : undefined));
  assert.deepEqual(reopened.map((info) => [info.rel, info.agent]), [['alpha', 'kimi']]);
  assert.deepEqual(await started(reopened[0].id), ['kimi'], 'no --session, -S or -c');

  const sleeping = ((await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; rel: string; agent: string | null; resumable: boolean }> }).agents;
  assert.deepEqual(sleeping.map((a) => [a.rel, a.agent, a.resumable]), [['beta', 'kimi', false]]);
  assert.equal((await api('POST', `/api/terminals/sleeping/${sleeping[0].id}/wake`)).status, 202);
  const woken = await waitFor(async () => (await listed()).find((info) => info.rel === 'beta'));
  assert.deepEqual(await started(woken.id), ['kimi']);
  await untouched();
});
