// The independent verifier's probes, kept as regression tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore, type AttentionItem } from '../src/attention/store.ts';
import { createInboxNotifier, episodeKey } from '../public/features/inbox-notify.js';
const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const CLAUDE = 'Claude needs your permission';
function setup() {
  let clock = T0; const store = new AttentionStore({ now: () => clock });
  store.track({ type: 'created', info: { id: 't1', workspaceId: 'dev', rel: 'x', cwd: '/x', title: 'x', kind: 'agent', status: 'running', createdAt: '2026-11-13T09:00:00.000Z' } as any });
  const notified: string[] = [];
  const notifier = createInboxNotifier({ api: { permission: 'granted', requestPermission: () => Promise.resolve('granted') }, read: () => true, write: () => {}, show: (item: AttentionItem) => { notified.push(episodeKey(item)); return { close() {} }; } });
  notifier.receive(store.items()); store.subscribe((items) => notifier.receive(items));
  let seq = 0;
  const hook = (tokens: Record<string, string>, clear: string[] = []) => store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: 't1', source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear }));
  const osc = (state: string, extra: Record<string, unknown> = {}) => store.programStatus('t1', { id: '', state, ...extra } as any);
  const cards = () => store.items().map((i) => [i.kind, i.blockedKind ?? null, i.label]);
  return { store, hook, osc, cards, notified, advance: (ms: number) => { clock += ms; } };
}
test('P1 (S9, L10): a permission denied so the turn ends (blocked -> idle): the late prompt is still suppressed until the next working', () => {
  const s = setup(); s.osc('blocked', { kind: 'permission', msg: 'approve Bash: rm' }); s.advance(1000); s.osc('idle');
  s.advance(5000); s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
  assert.deepEqual(s.cards(), []); assert.notEqual(s.store.agentState('t1'), 'waiting'); assert.equal(s.notified.length, 1);
  s.hook({}, ['blocked', 'prompt', 'finished']); s.osc('working'); s.advance(3000); s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
  assert.deepEqual(s.cards(), [['prompt', null, CLAUDE]]); assert.equal(s.notified.length, 2);
});
test('P2 (S9 + L11): a hook report with prompt and finished together while suppressed: the prompt is dropped, the turn reads finished', () => {
  const s = setup(); s.osc('blocked', { kind: 'permission' }); s.advance(1000); s.osc('working'); s.advance(4000);
  s.hook({ prompt: CLAUDE, finished: 'turn-1' }, ['blocked']);
  assert.equal(s.store.agentState('t1'), 'working', 'OSC working still decides'); assert.deepEqual(s.cards(), []); assert.equal(s.notified.length, 1);
  s.osc('done'); assert.equal(s.store.agentState('t1'), 'finished');
});
test('P3 (S9.5): an OSC clear whose id matches no record still resets the rule (a lone prompt after it shows its card)', () => {
  const s = setup(); s.osc('blocked', { kind: 'permission' }); s.advance(1000); s.osc('working');
  s.store.programStatus('t1', { id: 'nope', state: 'clear' } as any); s.advance(1000);
  s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
  assert.deepEqual(s.cards(), [['prompt', null, CLAUDE]]); assert.equal(s.notified.length, 2);
});
test('P4 (S9 "de tipo permiso"): a blocked of kind question or auth that ends does not arm the rule', () => {
  for (const kind of ['question', 'auth', undefined]) {
    const s = setup(); s.osc('blocked', kind ? { kind } : {}); s.advance(1000); s.osc('working'); s.advance(4000);
    s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
    assert.deepEqual(s.cards(), [['prompt', null, CLAUDE]], `kind=${kind}`); assert.equal(s.notified.length, 2);
  }
});
test('P5 (live case C, L11.2): permission approved, then an OSC blocked of kind question with the hook prompt 6 s later: one card, the question\'s, one notification each', () => {
  const s = setup(); s.osc('blocked', { kind: 'permission', msg: 'approve Bash: ls' }); s.advance(1000); s.osc('working'); s.hook({}, ['blocked', 'prompt', 'finished']);
  s.advance(2600); s.osc('blocked', { kind: 'question', msg: 'answer: count hidden files?' });
  assert.deepEqual(s.cards(), [['blocked', 'question', 'answer: count hidden files?']]); assert.equal(s.notified.length, 2);
  s.advance(6000); s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
  assert.deepEqual(s.cards(), [['blocked', 'question', 'answer: count hidden files?']], 'still one card'); assert.equal(s.notified.length, 2);
  s.advance(1000); s.osc('working'); assert.deepEqual(s.cards(), []); assert.equal(s.store.agentState('t1'), 'working');
  s.advance(500); s.osc('blocked', { kind: 'permission', msg: 'approve Bash: ls -A' }); assert.equal(s.notified.length, 3, 'S9.2: the second permission notifies once');
  s.advance(1000); s.osc('working'); s.hook({}, ['blocked', 'prompt', 'finished']); s.advance(4000); s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
  assert.deepEqual(s.cards(), []); assert.equal(s.notified.length, 3);
});
test('P6 (child id): a permission blocked on a child id ended on that id arms the rule; a working on another id leaves the card', () => {
  const s = setup(); s.store.programStatus('t1', { id: 'a/b', state: 'blocked', kind: 'permission' } as any); s.advance(1000);
  s.osc('working'); assert.deepEqual(s.cards().map(([kind, blockedKind]) => [kind, blockedKind]), [['blocked', 'permission']], 'root working does not end the child blocked');
  s.store.programStatus('t1', { id: 'a/b', state: 'working' } as any); assert.deepEqual(s.cards(), []);
  s.advance(4000); s.hook({ prompt: CLAUDE }, ['blocked', 'finished']); assert.deepEqual(s.cards(), []); assert.equal(s.notified.length, 1);
});
