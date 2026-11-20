// The inbox notifier (public/features/inbox-notify.js) keys one wait on terminalId + since:
// a label or blocked-kind change inside the same wait must keep `since`, a new wait gets a new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore } from '../src/attention/store.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';

const info = (id: string): TerminalInfo => ({ id, workspaceId: 'dev', rel: 'alpha', cwd: '/x/alpha', title: 'alpha', kind: 'agent', status: 'running', createdAt: '2026-10-28T09:00:00.000Z' });
const hook = (pane: string, seq: number, tokens: Record<string, string>, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq, ttlMs: null, tokens, clear });

test('since stays fixed while one wait changes its label or kind, and moves when a new wait starts', () => {
  let clock = Date.parse('2026-10-28T10:00:00.000Z');
  const store = new AttentionStore({ now: () => clock });
  store.track({ type: 'created', info: info('h') });
  store.track({ type: 'created', info: info('o') });
  const since = (id: string) => store.items().find((i) => i.terminalId === id)?.since;

  store.receive(hook('h', 1, { blocked: 'Guarded command confirmation' }));
  const first = since('h');
  clock += 60_000; store.receive(hook('h', 2, { blocked: 'Guarded command confirmation', prompt: 'Review consent' }));
  assert.equal(since('h'), first, 'a prompt token added to the same wait');
  clock += 60_000; store.receive(hook('h', 3, { blocked: 'Another command' }));
  assert.equal(since('h'), first, 'the blocker label changed');
  clock += 60_000; store.receive(hook('h', 4, { finished: 'turn-1' }, ['blocked', 'prompt']));
  clock += 60_000; store.receive(hook('h', 5, { blocked: 'Again' }, ['finished']));
  assert.notEqual(since('h'), first, 'a new wait after the turn finished');

  store.programStatus('o', { id: '', state: 'blocked', kind: 'permission', msg: 'Deploy?' });
  const osc = since('o');
  clock += 60_000; store.programStatus('o', { id: '', state: 'blocked', kind: 'question', msg: 'Which env?' });
  assert.equal(since('o'), osc, 'blocked permission to blocked question is the same wait');
  store.programStatus('o', { id: '', state: 'blocked', kind: 'question', msg: 'Which env?', progress: 50 });
  assert.equal(since('o'), osc, 'a progress-only repeat');
  clock += 60_000; store.programStatus('o', { id: '', state: 'working' });
  clock += 60_000; store.programStatus('o', { id: '', state: 'blocked', kind: 'permission', msg: 'Deploy again?' });
  assert.notEqual(since('o'), osc, 'cleared and blocked again');
});
