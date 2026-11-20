// "Antes de dormir" freshness: GET /api/proposals tells,
// per folder, the newest note or delegation already sent to that folder's agent after the
// summary its proposal comes from. Through the real server with a fake Engram, an agent terminal
// that only sleeps, a note posted through POST /api/night/notes and a night log seeded on disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const HOUR = 60 * 60_000;

let scratch: string;
let server: ChildProcess;
let fakeEngram: Server;
let base: string;
let token: string;
/** The summaries' instant: an hour ago, so a note posted by the test comes after it. */
const summaryAt = new Date(Math.floor((Date.now() - HOUR) / 1000) * 1000);
const at = (offsetMs: number) => new Date(summaryAt.getTime() + offsetMs).toISOString();
/** "YYYY-MM-DD HH:MM:SS" in UTC, as Engram stores it. */
const engramTime = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

function call(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: base, authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function json<T = any>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as T;
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

/** A night log record as the night service writes it (src/night/log.ts), with only what matters here. */
const record = (id: string, kind: string, rel: string, time: string, sent: string) => ({
  id, time, kind, terminalId: `gone-${id}`, workspaceId: 'dev', rel, tool: null, question: null, policy: { allowed: true },
  decision: null, followUp: null, sent, delivered: sent === 'message', outcome: sent === 'message' ? 'followed-up' : 'deferred', deferral: null, error: null,
});

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-bedtime-notes-')));
  const dev = join(scratch, 'dev');
  for (const dir of ['alpha', 'beta', 'gamma']) await mkdir(join(dev, dir), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  const observations = ['alpha', 'beta', 'gamma'].map((project, i) => ({ id: i + 1, type: 'session_summary', title: 's', content: '## Next Steps\n- go on', project, created_at: engramTime(summaryAt), session_id: 's' }));
  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/project/current') {
      const cwd = url.searchParams.get('cwd') ?? '';
      return void res.end(JSON.stringify({ project: cwd.split('/').pop(), project_source: 'git_remote', project_path: cwd }));
    }
    if (url.pathname === '/observations/recent') return void res.end(JSON.stringify(observations.filter((o) => o.project === url.searchParams.get('project'))));
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => fakeEngram.listen(0, '127.0.0.1', resolve));
  const engramAddress = fakeEngram.address();
  const engramPort = typeof engramAddress === 'object' && engramAddress ? engramAddress.port : 0;

  // The night log: beta got a delegation 10 minutes after its summary, alpha one before its
  // summary (older than the proposal), gamma one that was deferred (nothing reached the agent)
  // and Mirador's own idle-sleep note, which is not something the user sent.
  const night = join(scratch, 'state', 'mirador', 'night');
  await mkdir(night, { recursive: true, mode: 0o700 });
  const sleepNote = { ...record('g2', 'note', 'gamma', at(15 * 60_000), 'message'), note: { id: '', text: 'Save your session summary now.', from: 'mirador' } };
  const lines = [record('a1', 'delegate', 'alpha', at(-10 * 60_000), 'message'), record('b1', 'delegate', 'beta', at(10 * 60_000), 'message'), record('g1', 'delegate', 'gamma', at(5 * 60_000), 'none'), sleepNote];
  await writeFile(join(night, 'decisions.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600 });

  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(
    join(scratch, 'cfg', 'mirador', 'config.json'),
    JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root: dev, folders: [], expanded: [] }], engramUrl: `http://127.0.0.1:${engramPort}`, scopes: false, agentCommand: 'sleep 600 #' }),
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      HOME: join(scratch, 'home'),
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_STATE_HOME: join(scratch, 'state'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      MIRADOR_PORT: String(port),
      MIRADOR_ENGRAM_CACHE_MS: '0',
    },
    stdio: 'ignore',
  });
  const launchSecret = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')).launchSecret as string | undefined);
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  fakeEngram?.closeAllConnections();
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

const lastSent = async (rels: string[]) =>
  Object.fromEntries((await json(await call(`/api/proposals?ws=dev&${rels.map((rel) => `rel=${rel}`).join('&')}`), 200)).proposals.map((p: any) => [p.rel, p.lastSentAt]));

test('a delegation logged after the summary is the folder\'s last sent; one before it, one that reached nobody or Mirador\'s own note is not', async () => {
  assert.deepEqual(await lastSent(['alpha', 'beta', 'gamma']), { alpha: null, beta: at(10 * 60_000), gamma: null });
});

test('a note left for the folder\'s agent counts as sent from when it was posted', async () => {
  const agent = await json<{ id: string }>(await call('/api/terminals', 'POST', { ws: 'dev', rel: 'alpha', kind: 'agent', cols: 80, rows: 24 }), 201);
  try {
    const note = await json<{ createdAt: string }>(await call('/api/night/notes', 'POST', { workspaceId: 'dev', terminalId: agent.id, text: 'Sigue con los tests.' }), 201);
    const sent = await lastSent(['alpha', 'beta']);
    assert.equal(sent.alpha, note.createdAt, 'the pending note of alpha\'s agent');
    assert.equal(sent.beta, at(10 * 60_000), 'another folder keeps its own');
  } finally {
    await call(`/api/terminals/${agent.id}`, 'DELETE');
  }
});
