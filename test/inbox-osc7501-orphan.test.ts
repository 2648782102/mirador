// Integration:
// an agent that dies while its OSC 7501 record or its hooks say it waits must not leave that card behind,
// and the prompt of one terminal never ends another terminal's wait. The real server, its real agent
// rcfile and bash; the fake agent is a bash script that reports with printf, through the herdr shim as the
// pi bridge does, or through the real Claude Code hook (bin/claude-hook). The inbox stream feeds the
// browser's notification model (inbox-notify.js) with a granted fake Notification API, as
// public/features/inbox.js does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInboxNotifier, episodeKey } from '../public/features/inbox-notify.js';
import { shellQuote } from '../src/terminals/registry.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let server: ChildProcess;
let base: string;
let token: string;

interface Item { terminalId: string; kind: string; label: string; since: string }
interface TerminalRow { id: string; status: string; agentState?: string }

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(check).catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const terminal = async (id: string) => ((await (await call('GET', '/api/terminals')).json()) as TerminalRow[]).find((row) => row.id === id);
const inboxItems = async (id: string) => ((await (await call('GET', '/api/inbox')).json()) as { items: Item[] }).items.filter((item) => item.terminalId === id);

/**
 * Follows GET /api/inbox/stream: every `{ items }` message for terminals `ids`, with when it arrived,
 * handed to a notifier that is on (permission granted), the way the inbox view does. `closed` lists the
 * notifications the notifier closed (a card that leaves closes its notification).
 */
async function follow(...ids: string[]) {
  const messages: Array<{ at: number; items: Item[]; notified: string[] }> = [];
  const shown: string[] = [];
  const closed: string[] = [];
  const notifier = createInboxNotifier({
    api: { permission: 'granted', requestPermission: () => Promise.resolve('granted') }, read: () => true, write: () => {},
    show: (item: Item) => { const key = episodeKey(item); shown.push(key); return { close: () => closed.push(key) }; },
  });
  const abort = new AbortController();
  const res = await fetch(`${base}/api/inbox/stream`, { headers: { origin: base, authorization: `Bearer ${token}` }, signal: abort.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffered += value;
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const message = JSON.parse(buffered.slice(0, nl)) as { items?: Item[] };
        buffered = buffered.slice(nl + 1);
        if (!message.items) continue; // heartbeat
        const items = message.items.filter((item) => ids.includes(item.terminalId));
        messages.push({ at: Date.now(), items, notified: notifier.receive(items).map(episodeKey) });
      }
    }
  })();
  await waitFor(() => (messages.length > 0 ? true : undefined)); // the baseline
  return { messages, shown, closed, stop: () => abort.abort() };
}

/** Opens an agent terminal; its fake agent writes its pid and its bash's, then waits for `go`. */
async function openAgent(): Promise<{ id: string; agent: number; shell: number }> {
  const id = ((await (await call('POST', '/api/terminals', { ws: 'dev', rel: 'alpha', kind: 'agent', cols: 80, rows: 24 })).json()) as { id: string }).id;
  const [agent, shell] = (await waitFor(async () => (await readFile(join(scratch, 'home', `pids-${id}`), 'utf8')).trim() || undefined)).split(' ').map(Number);
  return { id, agent, shell };
}

/**
 * How the fake agent waits: `osc` an OSC 7501 blocked; `hook` a pi bridge blocker through the herdr
 * shim, then an OSC 7501 blocked; `claude` only Claude Code's hook (a permission Notification).
 */
const go = (id: string, mode: 'osc' | 'hook' | 'claude') => writeFile(join(scratch, 'home', `go-${id}`), mode);
const quietly = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-f1-orphan-')));
  await mkdir(join(scratch, 'root', 'alpha'), { recursive: true });
  await mkdir(join(scratch, 'home'), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  // The fake agent. `exec sleep` keeps its pid, so killing that pid kills the agent and only it.
  await writeFile(join(scratch, 'bin', 'gentle-shell'), [
    '#!/bin/bash',
    'echo "$$ $PPID" > "$HOME/pids-$HERDR_PANE_ID"',
    'while [ ! -e "$HOME/go-$HERDR_PANE_ID" ]; do sleep 0.02; done',
    'mode="$(cat "$HOME/go-$HERDR_PANE_ID")"',
    'if [ "$mode" = claude ]; then',
    // Mirador's own node and hook, by absolute path (the PATH node may be a version-manager shim).
    `  printf '%s' '{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Allow Bash?","session_id":"s1"}' | ${shellQuote(process.execPath)} ${shellQuote(join(APP_DIR, 'bin', 'claude-hook'))}`,
    '  exec sleep 600',
    'fi',
    'if [ "$mode" = hook ]; then',
    '  "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --source mirador:attention --agent pi --seq "$(($(date +%s) * 1000))" --token "blocked=Hook blocker"',
    'fi',
    "printf '\\e]7501;state=blocked:kind=permission:app=fake:msg=%s\\e\\\\' \"$(printf 'Deploy to prod?' | base64)\"",
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
  const { launchSecret } = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')) as { launchSecret: string });
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('the agent dies while blocked and its bash stays: the inbox is empty in under 1 s and nothing is left to notify', async (t) => {
  const { id, agent, shell } = await openAgent();
  const stream = await follow(id);
  try {
    await go(id, 'osc');
    const blocked = await waitFor(() => stream.messages.find((m) => m.items[0]?.kind === 'blocked'));
    assert.equal(blocked.items[0].label, 'Deploy to prod?');
    assert.deepEqual(stream.shown, [episodeKey(blocked.items[0])], 'the blocked agent notified once');
    assert.equal((await terminal(id))?.agentState, 'waiting');

    const seen = stream.messages.length;
    const killedAt = Date.now();
    process.kill(agent, 'SIGKILL');
    const empty = await waitFor(() => stream.messages.slice(seen).find((m) => m.items.length === 0), 3000);
    t.diagnostic(`inbox empty ${empty.at - killedAt} ms after the kill`);
    assert.ok(empty.at - killedAt < 1000, `inbox empty after ${empty.at - killedAt} ms`);
    assert.deepEqual(await inboxItems(id), []);
    const row = await terminal(id);
    assert.equal(row?.status, 'running', 'its bash is still there: the agent died, not the terminal');
    assert.equal(row?.agentState, 'unknown', 'no record is left, and no hook ever reported');
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.notified), [], 'nothing notified after the death');
    assert.deepEqual(stream.shown, [episodeKey(blocked.items[0])], 'still the one notification');
    assert.deepEqual(stream.closed, [episodeKey(blocked.items[0])], 'and it was closed when its card left');
  } finally {
    stream.stop();
    quietly(agent);
    quietly(shell);
    await call('DELETE', `/api/terminals/${id}`);
  }
});

test('the pty process ends while its agent is blocked: the inbox is empty in under 1 s and nothing is left to notify', async (t) => {
  const { id, agent, shell } = await openAgent();
  const stream = await follow(id);
  try {
    await go(id, 'osc');
    const blocked = await waitFor(() => stream.messages.find((m) => m.items[0]?.kind === 'blocked'));
    assert.deepEqual(stream.shown, [episodeKey(blocked.items[0])]);

    const seen = stream.messages.length;
    const killedAt = Date.now();
    process.kill(shell, 'SIGKILL');
    const empty = await waitFor(() => stream.messages.slice(seen).find((m) => m.items.length === 0), 3000);
    t.diagnostic(`inbox empty ${empty.at - killedAt} ms after the kill`);
    assert.ok(empty.at - killedAt < 1000, `inbox empty after ${empty.at - killedAt} ms`);
    assert.deepEqual(await inboxItems(id), []);
    assert.equal((await terminal(id))?.status, 'exited');
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.notified), []);
    assert.deepEqual(stream.shown, [episodeKey(blocked.items[0])]);
    assert.deepEqual(stream.closed, [episodeKey(blocked.items[0])], 'closed when its card left');
  } finally {
    stream.stop();
    quietly(agent);
    quietly(shell);
    await call('DELETE', `/api/terminals/${id}`);
  }
});

test('the terminal is closed while its agent is blocked: its card leaves and its notification is closed', async () => {
  const { id, agent, shell } = await openAgent();
  const stream = await follow(id);
  try {
    await go(id, 'osc');
    const blocked = await waitFor(() => stream.messages.find((m) => m.items[0]?.kind === 'blocked'));
    const seen = stream.messages.length;
    assert.deepEqual(stream.closed, [], 'open while the card waits');
    assert.equal((await call('DELETE', `/api/terminals/${id}`)).status, 204);
    await waitFor(() => stream.messages.slice(seen).find((m) => m.items.length === 0), 3000);
    assert.deepEqual([stream.shown, stream.closed], [[episodeKey(blocked.items[0])], [episodeKey(blocked.items[0])]]);
  } finally {
    stream.stop();
    quietly(agent);
    quietly(shell);
  }
});

test('an agent that reports through its hooks and OSC 7501 dies blocked: no hook card is revealed and nothing notifies again', async () => {
  const { id, agent, shell } = await openAgent();
  const stream = await follow(id);
  try {
    await go(id, 'hook');
    const osc = await waitFor(() => stream.messages.find((m) => m.items[0]?.label === 'Deploy to prod?'));
    assert.equal(osc.items[0].kind, 'blocked', 'the OSC record wins over the hook while it lives');
    assert.equal((await terminal(id))?.agentState, 'waiting');

    const seen = stream.messages.length;
    process.kill(agent, 'SIGKILL');
    await waitFor(() => stream.messages.slice(seen).find((m) => m.items.length === 0), 3000);
    assert.deepEqual(await inboxItems(id), [], "the hook's blocker went with the prompt too");
    assert.equal((await terminal(id))?.agentState, 'unknown');
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.items.map((item) => item.label)), [], 'the hook card never showed');
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.notified), [], 'nothing notified after the death');
  } finally {
    stream.stop();
    quietly(agent);
    quietly(shell);
    await call('DELETE', `/api/terminals/${id}`);
  }
});

test('an agent with hooks only (Claude Code) dies blocked: its card leaves in under 1 s and it never notifies again', async (t) => {
  const { id, agent, shell } = await openAgent();
  const stream = await follow(id);
  try {
    await go(id, 'claude');
    const waiting = await waitFor(() => stream.messages.find((m) => m.items[0]?.label === 'Allow Bash?'));
    assert.equal(waiting.items[0].kind, 'prompt');
    assert.deepEqual(stream.shown, [episodeKey(waiting.items[0])], 'the waiting agent notified once');
    assert.equal((await terminal(id))?.agentState, 'waiting');

    const seen = stream.messages.length;
    const killedAt = Date.now();
    process.kill(agent, 'SIGKILL');
    const empty = await waitFor(() => stream.messages.slice(seen).find((m) => m.items.length === 0), 3000);
    t.diagnostic(`inbox empty ${empty.at - killedAt} ms after the kill`);
    assert.ok(empty.at - killedAt < 1000, `inbox empty after ${empty.at - killedAt} ms`);
    assert.deepEqual(await inboxItems(id), []);
    const row = await terminal(id);
    assert.equal(row?.status, 'running', 'its bash is still there');
    assert.equal(row?.agentState, 'unknown', 'neither waiting nor working: nothing runs');
    // The card is gone for good: no later message brings it back.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.items), []);
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.notified), [], 'nothing notified after the death');
    assert.deepEqual(stream.shown, [episodeKey(waiting.items[0])], 'still the one notification');
  } finally {
    stream.stop();
    quietly(agent);
    quietly(shell);
    await call('DELETE', `/api/terminals/${id}`);
  }
});

test("two agents with hooks wait in the same folder: one's prompt never ends the other's wait", async () => {
  const a = await openAgent();
  const b = await openAgent();
  const stream = await follow(a.id, b.id);
  try {
    assert.notEqual(a.id, b.id);
    await go(b.id, 'claude');
    const bWaits = await waitFor(() => stream.messages.find((m) => m.items.some((item) => item.terminalId === b.id)));
    const bCard = bWaits.items.find((item) => item.terminalId === b.id)!;
    await go(a.id, 'claude');
    await waitFor(() => stream.messages.find((m) => m.items.length === 2));
    assert.equal(stream.shown.length, 2, 'each waiting agent notified once');

    const seen = stream.messages.length;
    process.kill(a.agent, 'SIGKILL');
    const aGone = await waitFor(() => stream.messages.slice(seen).find((m) => !m.items.some((item) => item.terminalId === a.id)), 3000);
    assert.deepEqual(aGone.items, [bCard], "b's card is unchanged when a's leaves");
    assert.deepEqual((await (await call('GET', '/api/inbox')).json() as { items: Item[] }).items.filter((item) => item.terminalId === a.id || item.terminalId === b.id), [bCard]);
    assert.equal((await terminal(b.id))?.agentState, 'waiting');
    assert.equal((await terminal(a.id))?.agentState, 'unknown');
    assert.deepEqual(stream.messages.slice(seen).flatMap((m) => m.notified), [], 'nothing notified again');
    assert.equal(stream.shown.length, 2);
  } finally {
    stream.stop();
    for (const { id, agent, shell } of [a, b]) {
      quietly(agent);
      quietly(shell);
      await call('DELETE', `/api/terminals/${id}`);
    }
  }
});
