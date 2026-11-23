// Pure shaping of the attention inbox view (public/features/inbox-model.js), fed with the items the
// real AttentionStore orders (src/attention/store.ts sortItems), so the view never re-sorts what
// waits with a shape of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore, type AttentionItem } from '../src/attention/store.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';
import { cardLayout, inboxGroups, waitLabel } from '../public/features/inbox-model.js';

function terminal(id: string, workspaceId: string, rel: string): TerminalInfo {
  return { id, workspaceId, rel, cwd: `/home/you/${workspaceId}/${rel}`, title: rel || workspaceId, kind: 'agent', status: 'running', createdAt: '2026-10-28T10:00:00.000Z' };
}
const hook = (pane: string, seq: number, tokens: Record<string, string>) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq, ttlMs: null, tokens, clear: [] });

/** Four agents in two workspaces, waiting since 10:00, 10:01, 10:02 and 10:03 (folders in reverse order), plus one finished turn. */
function waitingStore() {
  let clock = Date.parse('2026-10-28T10:00:00.000Z');
  const store = new AttentionStore({ now: () => clock });
  const minute = () => { clock += 60_000; };
  for (const [id, ws, rel] of [['a', 'web', 'zeta'], ['b', 'api', 'yak'], ['c', 'web', 'beta'], ['d', 'api', 'alpha'], ['f', 'web', 'aaa']]) store.track({ type: 'created', info: terminal(id, ws, rel) });
  store.receive(hook('a', 1, { blocked: 'Guarded command confirmation' }));
  minute();
  store.programStatus('b', { id: '', state: 'error', msg: 'Build failed' });
  minute();
  store.receive(hook('c', 1, { prompt: 'Review consent' }));
  minute();
  store.programStatus('d', { id: '', state: 'blocked', kind: 'permission', msg: 'Deploy?' });
  minute();
  store.receive(hook('f', 1, { finished: 'turn-1' }));
  return store;
}

test('blocked, waiting and error agents share one group in the store order: the longest wait first, across workspaces and folders', () => {
  const store = waitingStore();
  const [answer, review] = inboxGroups(store.items(), store.nightNotes());
  assert.equal(answer.key, 'answer');
  assert.deepEqual(answer.entries.map(({ item }) => [item.terminalId, item.kind, item.since]), [
    ['a', 'blocked', '2026-10-28T10:00:00.000Z'],
    ['b', 'error', '2026-10-28T10:01:00.000Z'],
    ['c', 'prompt', '2026-10-28T10:02:00.000Z'],
    ['d', 'blocked', '2026-10-28T10:03:00.000Z'],
  ]);
  assert.equal(answer.count, 4);
  assert.equal(answer.entries.every((entry) => entry.note === false), true);
  assert.equal(review.key, 'review');
  assert.deepEqual(review.workspaces.map(([ws, entries]) => [ws, entries.map(({ item }) => item.terminalId)]), [['web', ['f']]]);
});

test('the view lists what it is not hiding, and leaves out an empty group', () => {
  const store = waitingStore();
  const groups = inboxGroups(store.items(), [], (item: AttentionItem) => item.terminalId === 'b' || item.kind === 'finished');
  assert.deepEqual(groups.map((group) => group.key), ['answer']);
  assert.deepEqual(groups[0].entries.map(({ item }) => item.terminalId), ['a', 'c', 'd']);
  assert.deepEqual(inboxGroups([], []), []);
});

test('finished turns and night notes keep their place: by workspace, then folder, then wait; notes sit in their card\'s group and are not counted', () => {
  const item = (terminalId: string, workspaceId: string, rel: string, kind: string, since: string) => ({ terminalId, workspaceId, rel, title: rel, kind, label: kind === 'finished' ? 'Finished' : '', detail: null, since, activity: null });
  const items = [
    item('r1', 'web', 'zeta', 'finished', '2026-10-28T09:00:00.000Z'),
    item('r2', 'api', 'beta', 'finished', '2026-10-28T09:01:00.000Z'),
    item('r3', 'web', 'alpha', 'finished', '2026-10-28T09:02:00.000Z'),
    item('r4', 'web', 'alpha', 'finished', '2026-10-28T08:59:00.000Z'),
    item('w1', 'web', 'mid', 'blocked', '2026-10-28T09:05:00.000Z'),
  ];
  const notes = [
    { ...item('n1', 'api', 'aaa', 'finished', '2026-10-28T08:00:00.000Z'), night: { state: 'resolved', flow: 'follow-up', summary: 'go on', at: '2026-10-28T09:10:00.000Z' } },
    { ...item('n2', 'web', 'aaa', 'prompt', '2026-10-28T08:30:00.000Z'), night: { state: 'deciding', flow: 'question', summary: '', at: '2026-10-28T09:10:00.000Z' } },
  ];
  const [answer, review] = inboxGroups(items, notes);
  assert.deepEqual(answer.entries.map(({ item: shown, note }) => [shown.terminalId, note]), [['w1', false], ['n2', true]], 'cards first, then their notes');
  assert.equal(answer.count, 1);
  assert.deepEqual(review.workspaces.map(([ws, entries]) => [ws, entries.map(({ item: shown, note }) => `${shown.terminalId}${note ? '*' : ''}`)]), [
    ['web', ['r4', 'r3', 'r1']],
    ['api', ['n1*', 'r2']],
  ]);
  assert.equal(review.count, 4);
});

test('S4: on the phone a card reads its reason first, then workspace › folder, then the wait', () => {
  for (const named of [true, false]) {
    const layout = cardLayout(true, named);
    assert.deepEqual(layout.parts, ['reason', 'place', 'meta', 'detail', 'night']);
    assert.equal(layout.named, true, 'every phone card names its workspace, finished ones too');
  }
});

test('wide layout unchanged: the place, the reason, the detail, the night line, then the wait; only "needs you" names the workspace', () => {
  assert.deepEqual(cardLayout(false, true), { parts: ['place', 'reason', 'detail', 'night', 'meta'], named: true });
  assert.deepEqual(cardLayout(false, false), { parts: ['place', 'reason', 'detail', 'night', 'meta'], named: false });
});

test('the time waited reads now, in minutes, then in hours', () => {
  const since = '2026-10-28T10:00:00.000Z';
  const at = (minutes: number) => Date.parse(since) + minutes * 60_000;
  assert.deepEqual(waitLabel(since, at(0.5)), { key: 'inbox.waited.now', vars: undefined });
  assert.deepEqual(waitLabel(since, at(7)), { key: 'inbox.waited.minutes', vars: { count: 7 } });
  assert.deepEqual(waitLabel(since, at(59)), { key: 'inbox.waited.minutes', vars: { count: 59 } });
  assert.deepEqual(waitLabel(since, at(125)), { key: 'inbox.waited.hours', vars: { count: 2 } });
  assert.deepEqual(waitLabel('not a date', at(5)), { key: 'inbox.waited.now', vars: undefined });
});
