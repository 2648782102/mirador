// Mirador's opencode plugin (bin/opencode-plugin.js) turns opencode 2's
// server events into the same mirador:attention lines bin/claude-hook sends: a root session's execution
// started is working, a permission or a question form waiting, its execution ended finished, each with
// session=<sessionID>. The plugin runs here with a stand-in for opencode's plugin context whose event
// stream yields events shaped as opencode's generated client types; no opencode ever runs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../bin/opencode-plugin.js';

const ROOT = 'ses_7f3e2d1c0b9aXyZwVuTsRqPoNm';
const CHILD = 'ses_7f3e2d1c0b98AbCdEfGhIjKlMn';
type Line = { v: number; cmd: string; pane: string; source: string; seq: number; ttlMs: null; tokens: Record<string, string>; clear: string[] };
type Event = { id?: string; created?: number; type: string; data?: Record<string, unknown> };

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** A herdr socket: `lines` collects what arrives, in seq order. */
async function socket() {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-opencode-plugin-'));
  const path = join(dir, 'socket');
  const received: Line[] = [];
  const listener = createServer((conn) => {
    let buffered = '';
    conn.on('data', (chunk) => (buffered += chunk));
    conn.on('end', () => received.push(...buffered.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  });
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  cleanups.push(async () => {
    listener.close();
    await rm(dir, { recursive: true, force: true });
  });
  /** Waits until `count` lines have arrived, and a little more for strays. */
  const lines = async (count: number) => {
    const deadline = Date.now() + 3000;
    while (received.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 60));
    return [...received].sort((a, b) => a.seq - b.seq);
  };
  return { path, lines };
}

/** Sets the plugin up in pane `pane` (none when ''), reporting to `socketPath`, with an opencode context stand-in. */
async function setup(socketPath: string | undefined, pane = 'pane-1') {
  const queue: Event[] = [];
  let wake: (() => void) | null = null;
  const subscriptions: Array<{ types?: string[]; signal?: AbortSignal }> = [];
  const ctx = {
    event: {
      subscribe(options: { types?: string[]; signal?: AbortSignal }) {
        subscriptions.push(options);
        return (async function* () {
          while (!options.signal?.aborted) {
            if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; options.signal?.addEventListener('abort', () => resolve(), { once: true }); });
            while (queue.length) yield queue.shift()!;
          }
        })();
      },
    },
  };
  const saved = { HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  const set = (key: keyof typeof saved, value: string | undefined) => (value === undefined || value === '' ? delete process.env[key] : (process.env[key] = value));
  set('HERDR_PANE_ID', pane);
  set('HERDR_SOCKET_PATH', socketPath);
  const cleanup = await plugin.setup(ctx as never);
  set('HERDR_PANE_ID', saved.HERDR_PANE_ID);
  set('HERDR_SOCKET_PATH', saved.HERDR_SOCKET_PATH);
  if (cleanup) cleanups.push(cleanup);
  return { cleanup, subscriptions, push: (...events: Event[]) => { queue.push(...events); wake?.(); } };
}

let events = 0;
/** An event as opencode's client types shape it, with its own id. */
const event = (type: string, data: Record<string, unknown>): Event => ({ id: `evt_${++events}`, created: 1762732800000, type, data });
const started = (sessionID: string) => event('session.execution.started', { sessionID });
const ended = (outcome: 'succeeded' | 'failed', sessionID: string) => event(`session.execution.${outcome}`, { sessionID, ...(outcome === 'failed' ? { error: { type: 'unknown', message: 'boom' } } : {}) });
const interrupted = (reason: string) => event('session.execution.interrupted', { sessionID: ROOT, reason });
const asked = (sessionID: string, message?: string) => event('permission.asked', { id: 'per_01', sessionID, action: 'bash', resources: ['git push'], ...(message ? { message } : {}) });
const created = (sessionID: string, parentID?: string) => event('session.created', { sessionID, projectID: 'prj_1', location: {}, slug: 'x', version: '2.2.5', ...(parentID ? { parentID } : {}) });

test('the plugin subscribes to opencode 2 session, permission and form events, and stops when opencode cleans it up', async () => {
  const herdr = await socket();
  const opencode = await setup(herdr.path);
  assert.equal(typeof opencode.cleanup, 'function');
  assert.equal(opencode.subscriptions.length, 1);
  assert.deepEqual([...(opencode.subscriptions[0].types ?? [])].sort(), [
    'form.cancelled', 'form.created', 'form.replied', 'permission.asked', 'permission.replied', 'session.created',
    'session.execution.failed', 'session.execution.interrupted', 'session.execution.started', 'session.execution.succeeded',
  ]);
  await opencode.cleanup!();
  assert.equal(opencode.subscriptions[0].signal?.aborted, true);
});

test('working, waiting and finished go out as mirador:attention lines with the root session id and a rising seq', async () => {
  const herdr = await socket();
  const opencode = await setup(herdr.path);
  opencode.push(
    started(ROOT),
    asked(ROOT, 'Allow bash: git push?'),
    event('permission.replied', { sessionID: ROOT, requestID: 'per_01', reply: 'once' }),
    event('form.created', { form: { id: 'frm_1', sessionID: ROOT, title: 'Which database?', fields: [] } }),
    event('form.replied', { id: 'frm_1', sessionID: ROOT, answer: {} }),
    ended('succeeded', ROOT),
  );
  const lines = await herdr.lines(6);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.deepEqual([line.v, line.cmd, line.pane, line.source, line.ttlMs], [1, 'report-metadata', 'pane-1', 'mirador:attention', null]);
  assert.equal(new Set(lines.map((line) => line.seq)).size, 6, 'every seq is new');
  assert.ok(Math.abs(lines[0].seq - Date.now()) < 10_000, 'seq is the clock');
  assert.deepEqual(lines.map((line) => [line.tokens, line.clear]), [
    [{ session: ROOT }, ['blocked', 'prompt', 'finished']],
    [{ session: ROOT, prompt: 'Allow bash: git push?' }, ['blocked', 'finished']],
    [{ session: ROOT }, ['blocked', 'prompt']],
    [{ session: ROOT, prompt: 'Which database?' }, ['blocked', 'finished']],
    [{ session: ROOT }, ['blocked', 'prompt']],
    [{ session: ROOT, finished: String(lines[5].seq) }, ['blocked', 'prompt']],
  ]);
});

test('a subagent session never finishes the turn nor names the session, but its permission still waits', async () => {
  const herdr = await socket();
  const opencode = await setup(herdr.path);
  opencode.push(started(ROOT), created(CHILD, ROOT), started(CHILD), asked(CHILD), ended('succeeded', CHILD), ended('failed', ROOT));
  const lines = await herdr.lines(3);
  assert.deepEqual(lines.map((line) => line.tokens), [{ session: ROOT }, { prompt: 'opencode asks permission: bash' }, { session: ROOT, finished: String(lines[2].seq) }]);
});

test('an interrupt by the user or for inactivity finishes the turn; a superseded or shutdown one, or a status, changes nothing', async () => {
  const herdr = await socket();
  const opencode = await setup(herdr.path);
  opencode.push(interrupted('superseded'), interrupted('shutdown'), interrupted('user'), interrupted('inactivity'), event('session.status', { sessionID: ROOT, status: { type: 'idle' } }));
  const lines = await herdr.lines(2);
  assert.deepEqual(lines.map((line) => line.tokens), lines.map((line) => ({ session: ROOT, finished: String(line.seq) })));
  assert.equal(lines.length, 2);
});

test('an invalid session id is left out, malformed events are skipped, and outside a Mirador terminal nothing subscribes', async () => {
  const herdr = await socket();
  const opencode = await setup(herdr.path);
  const untitled = event('form.created', { form: { id: 'frm_2', sessionID: ROOT, fields: [] } });
  opencode.push(started('--help'), started('ses x'), { type: 'session.execution.started' }, null as unknown as Event, event('form.created', {}), untitled, started(ROOT));
  const lines = await herdr.lines(4);
  assert.deepEqual(lines.map((line) => line.tokens), [{}, {}, { session: ROOT, prompt: 'opencode needs your input' }, { session: ROOT }]);

  for (const [socketPath, pane] of [[herdr.path, ''], [undefined, 'pane-2'], [herdr.path, '../x']] as const) {
    const outside = await setup(socketPath, pane);
    assert.deepEqual([outside.cleanup, outside.subscriptions.length], [undefined, 0], JSON.stringify([socketPath, pane]));
  }
});

test('two plugin instances in one opencode server (one per location) report each event once', async () => {
  const herdr = await socket();
  const first = await setup(herdr.path);
  const second = await setup(herdr.path);
  const shared = started(ROOT);
  first.push(shared);
  second.push(shared, ended('succeeded', ROOT));
  const lines = await herdr.lines(2);
  assert.deepEqual(lines.map((line) => Object.keys(line.tokens).sort()), [['session'], ['finished', 'session']]);
});
