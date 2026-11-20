// The opencode plugin never gets in opencode's way and matches bin/claude-hook's line.
// Probes from the verification, kept as regression tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin from '../bin/opencode-plugin.js';

const HOOK = fileURLToPath(new URL('../bin/claude-hook', import.meta.url));
const ROOT = 'ses_0123456789abcdefghijklmnop';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function herdr() {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-opencode-robust-'));
  const path = join(dir, 'socket');
  const lines: Array<Record<string, unknown>> = [];
  const server = createServer((c) => {
    let b = '';
    c.on('data', (d) => (b += d));
    c.on('end', () => lines.push(...b.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, lines, close: async () => { server.close(); await rm(dir, { recursive: true, force: true }); } };
}

/** A fake opencode event bus: events pushed after the abort are never yielded. */
function ctxOf() {
  const q: unknown[] = [];
  let wake: (() => void) | null = null;
  let aborted = false;
  const ctx = {
    event: {
      subscribe(o: { signal: AbortSignal }) {
        return (async function* () {
          while (!o.signal.aborted) {
            if (!q.length) await new Promise<void>((r) => { wake = r; o.signal.addEventListener('abort', () => r(), { once: true }); });
            if (o.signal.aborted) { aborted = true; return; }
            while (q.length) yield q.shift();
          }
        })();
      },
    },
  };
  return { ctx, push: (...e: unknown[]) => { q.push(...e); wake?.(); }, honoured: () => aborted };
}

test('setup returns synchronously, swallows malformed events and bad contexts, and goes quiet after cleanup', async () => {
  const h = await herdr();
  let unhandled = 0;
  const count = () => unhandled++;
  process.on('unhandledRejection', count);
  process.env.HERDR_PANE_ID = 'pane-r';
  process.env.HERDR_SOCKET_PATH = h.path;
  try {
    const a = ctxOf();
    const stop = plugin.setup(a.ctx as never);
    assert.equal(typeof stop, 'function');
    assert.ok(!(stop instanceof Promise), 'setup does not await the loop');
    a.push(
      { type: 'session.execution.started' }, { type: 'x', data: null }, { type: 'permission.asked', data: { sessionID: 5 } },
      { type: 'form.created', data: { form: null } }, { type: 'form.created', data: { form: 'str' } }, [], 'str', 1, undefined, null,
      { id: 7, type: 'session.execution.started', data: { sessionID: ROOT } },
      { id: 'm', type: 'permission.asked', data: { sessionID: ROOT, message: 'x'.repeat(5000) } },
    );
    await sleep(300);
    assert.deepEqual(h.lines.map((l) => Object.keys(l.tokens as object)), [['session'], ['session', 'prompt']]);
    assert.equal((h.lines[1].tokens as { prompt: string }).prompt.length, 500);
    assert.ok(h.lines.every((l) => Buffer.byteLength(JSON.stringify(l)) <= 4096));
    stop!();
    await sleep(20);
    a.push({ id: 'late', type: 'session.execution.started', data: { sessionID: ROOT } });
    await sleep(200);
    assert.ok(a.honoured());
    assert.equal(h.lines.length, 2, 'nothing after cleanup');
    for (const bad of [undefined, null, {}, { event: {} }, { event: { subscribe() { throw new Error('boom'); } } }]) {
      const r = plugin.setup(bad as never);
      if (typeof r === 'function') r();
    }
    await sleep(100);
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', count);
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    await h.close();
  }
});

test('a permission.asked line equals bin/claude-hook\'s Notification line except seq', async () => {
  const h = await herdr();
  const env = { ...process.env, HERDR_PANE_ID: 'pane-r', HERDR_SOCKET_PATH: h.path };
  try {
    const hook = spawn(process.execPath, [HOOK], { env });
    hook.stdin.end(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow bash: git push?', session_id: ROOT }));
    await new Promise((r) => hook.on('exit', r));
    process.env.HERDR_PANE_ID = 'pane-r';
    process.env.HERDR_SOCKET_PATH = h.path;
    const a = ctxOf();
    const stop = plugin.setup(a.ctx as never);
    a.push({ id: 'p', type: 'permission.asked', data: { sessionID: ROOT, message: 'Allow bash: git push?' } });
    await sleep(300);
    stop!();
    const strip = (l: Record<string, unknown>) => JSON.stringify({ ...l, seq: 0 });
    assert.equal(h.lines.length, 2);
    assert.equal(strip(h.lines[0]), strip(h.lines[1]));
    assert.equal(Object.keys(h.lines[1]).join(), 'v,cmd,pane,source,seq,ttlMs,tokens,clear');
  } finally {
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    await h.close();
  }
});
