// Only the root OSC 7501 record (id '')
// ends a hook wait with its `done`, `idle` or `clear`. A child record's `done` or `idle`, or a `clear`
// scoped to an id, leaves the hook wait (`blocked` or `prompt`) open: the agent still reads `waiting`
// and the hook card is still listed. A scoped clear still removes the records it names, and it
// ends the wait when one of them was `blocked`. Each case reads the store's public interface only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const GUARDED = 'Questionnaire awaiting input';
const CLAUDE = 'Claude needs your permission';

function terminal(id: string): TerminalInfo {
  return { id, workspaceId: 'dev', rel: 'vigia/api', cwd: '/home/you/Dev/vigia/api', title: 'api', kind: 'agent', status: 'running', createdAt: '2026-11-16T09:00:00.000Z' };
}

const osc = (id: string, state: ProgramStatusReport['state'], extra: Partial<ProgramStatusReport> = {}): ProgramStatusReport => ({ id, state, ...extra });

/** The two hook waits: gentle's blocker (`blocked`) and Claude's dialog notice (`prompt`). */
const WAITS = [
  { name: 'hook blocked', tokens: { blocked: GUARDED }, kind: 'blocked', label: GUARDED },
  { name: 'hook prompt', tokens: { prompt: CLAUDE }, kind: 'prompt', label: CLAUDE },
] as const;

/** A store with one agent terminal `t1`, a clock and a hook report helper. */
function setup() {
  let clock = T0;
  const store = new AttentionStore({ now: () => clock });
  store.track({ type: 'created', info: terminal('t1') });
  let seq = 0;
  const hook = (tokens: Record<string, string>, clear: string[] = []) =>
    store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: 't1', source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear }));
  const cards = () => store.items().map((item) => ({ terminalId: item.terminalId, kind: item.kind, label: item.label, since: item.since }));
  return { store, hook, cards, advance: (ms: number) => { clock += ms; }, iso: () => new Date(clock).toISOString() };
}

/** Opens the hook wait over a child record `a` that works; returns the hook card it must keep. */
function openWait(s: ReturnType<typeof setup>, wait: (typeof WAITS)[number]) {
  s.store.programStatus('t1', osc('a', 'working'));
  assert.equal(s.store.agentState('t1'), 'working', "child 'a' is there and works");
  s.advance(1000);
  const since = s.iso();
  assert.equal(s.hook({ ...wait.tokens }, ['finished']), true);
  assert.equal(s.store.agentState('t1'), 'waiting');
  const card = { terminalId: 't1', kind: wait.kind, label: wait.label, since };
  assert.deepEqual(s.cards(), [card]);
  s.advance(1000);
  return card;
}

for (const wait of WAITS) {
  for (const state of ['done', 'idle'] as const) {
    const an = state === 'idle' ? 'an' : 'a';
    test(`S1.1: ${an} ${state} from child id 'a' leaves the ${wait.name} wait open`, () => {
      const s = setup();
      const card = openWait(s, wait);
      assert.equal(s.store.programStatus('t1', osc('a', state)), true);
      assert.equal(s.store.agentState('t1'), 'waiting', `a child ${state} does not end the wait`);
      assert.deepEqual(s.cards(), [card], 'the hook card is still listed');
    });

    test(`S1.1: ${an} ${state} from the root record (id '') ends the ${wait.name} wait`, () => {
      const s = setup();
      openWait(s, wait);
      assert.equal(s.store.programStatus('t1', osc('', state)), true);
      assert.equal(s.store.agentState('t1'), 'working', "the wait is gone: the child 'a' that works speaks again");
      assert.deepEqual(s.cards(), [], 'no "needs you" card is left');
      s.store.programStatus('t1', osc('a', state));
      assert.equal(s.store.agentState('t1'), 'finished', 'and the wait does not come back');
    });
  }

  test(`S1.1: a clear scoped to id 'a' removes 'a' and 'a/b' but leaves the ${wait.name} wait open`, () => {
    const s = setup();
    s.store.programStatus('t1', osc('a/b', 'done', { msg: 'Child built' }));
    s.store.programStatus('t1', osc('b', 'working'));
    const card = openWait(s, wait);
    assert.equal(s.store.programStatus('t1', osc('a', 'clear')), true);
    assert.equal(s.store.agentState('t1'), 'waiting', 'a scoped clear does not end the wait');
    assert.deepEqual(s.cards(), [card], 'the hook card is still listed');
    // 'a' and 'a/b' are gone: once the hooks clear their wait, only 'b' (working) speaks.
    s.hook({}, ['blocked', 'prompt']);
    assert.equal(s.store.agentState('t1'), 'working', "only 'b' is left, and it works");
    assert.deepEqual(s.cards(), [], "'a/b' and its finished card went with the scoped clear");
  });

  test(`S1.1: a clear with the root id '' removes every record and ends the ${wait.name} wait`, () => {
    const s = setup();
    s.store.programStatus('t1', osc('a/b', 'done', { msg: 'Child built' }));
    openWait(s, wait);
    assert.equal(s.store.programStatus('t1', osc('', 'clear')), true);
    assert.equal(s.store.agentState('t1'), 'working', 'the hooks decide again, and their wait is gone');
    assert.deepEqual(s.cards(), []);
  });
}

// A clear scoped to an id ends the hook wait only when a record it removes was blocked.
for (const wait of WAITS) {
  test(`L10: a clear scoped to a blocked child 'a' ends the ${wait.name} wait and leaves no card`, () => {
    const s = setup();
    s.store.programStatus('t1', osc('a', 'blocked', { kind: 'permission', msg: 'Bash: ls' }));
    s.advance(5500);
    assert.equal(s.hook({ ...wait.tokens }, ['finished']), true);
    assert.equal(s.store.agentState('t1'), 'waiting');
    assert.equal(s.cards().length, 1, 'one card while the agent waits');
    s.advance(1000);
    assert.equal(s.store.programStatus('t1', osc('a', 'clear')), true);
    assert.notEqual(s.store.agentState('t1'), 'waiting', 'the wait is closed');
    assert.deepEqual(s.cards(), [], 'no card is left');
    s.store.programStatus('t1', osc('b', 'idle'));
    assert.deepEqual(s.cards(), [], 'and the wait does not come back');
  });

  for (const state of ['working', 'done', 'idle'] as const) {
    test(`L10: a clear scoped to a ${state} child 'a' leaves the ${wait.name} wait and its card`, () => {
      const s = setup();
      s.store.programStatus('t1', osc('b', 'done'));
      const card = openWait(s, wait);
      if (state !== 'working') s.store.programStatus('t1', osc('a', state));
      assert.deepEqual(s.cards(), [card]);
      assert.equal(s.store.programStatus('t1', osc('a', 'clear')), true);
      assert.equal(s.store.agentState('t1'), 'waiting', 'the wait stays open');
      assert.deepEqual(s.cards(), [card], 'the hook card is still listed');
      // Once the hooks end their wait, only 'b' (done) speaks: the clear did remove 'a'.
      s.hook({}, ['blocked', 'prompt']);
      assert.equal(s.store.agentState('t1'), 'finished', "'a' is gone and 'b' finished");
    });
  }

  test(`L10: a clear scoped to 'a' ends the ${wait.name} wait when its descendant 'a/b' is blocked`, () => {
    const s = setup();
    s.store.programStatus('t1', osc('a', 'working'));
    s.store.programStatus('t1', osc('a/b', 'blocked', { kind: 'permission', msg: 'Bash: ls' }));
    assert.equal(s.hook({ ...wait.tokens }, ['finished']), true);
    assert.equal(s.store.agentState('t1'), 'waiting');
    assert.equal(s.store.programStatus('t1', osc('a', 'clear')), true);
    assert.notEqual(s.store.agentState('t1'), 'waiting', 'the wait is closed');
    assert.deepEqual(s.cards(), [], 'no card is left');
  });

  test(`L10: a clear scoped to an unrelated id 'c' leaves the ${wait.name} wait of a blocked child 'a'`, () => {
    const s = setup();
    s.store.programStatus('t1', osc('a', 'blocked', { kind: 'permission', msg: 'Bash: ls' }));
    s.store.programStatus('t1', osc('c', 'working'));
    assert.equal(s.hook({ ...wait.tokens }, ['finished']), true);
    const before = s.cards();
    assert.equal(before.length, 1);
    assert.equal(s.store.programStatus('t1', osc('c', 'clear')), true);
    assert.equal(s.store.agentState('t1'), 'waiting', 'the wait stays open');
    assert.deepEqual(s.cards(), before, 'the card is unchanged');
  });

  // The wait ends only when the blocked top goes. With another child still blocked,
  // the agent keeps waiting with that child's card, and the wait ends when that one goes too.
  test(`L14: a clear that removes one of two blocked children leaves the ${wait.name} wait to the other`, () => {
    const s = setup();
    s.store.programStatus('t1', osc('a', 'blocked', { kind: 'permission', msg: 'A' }));
    s.store.programStatus('t1', osc('b', 'blocked', { kind: 'permission', msg: 'B' }));
    assert.equal(s.hook({ ...wait.tokens }, ['finished']), true);
    assert.equal(s.store.programStatus('t1', osc('a', 'clear')), true);
    assert.equal(s.store.agentState('t1'), 'waiting', "'b' is still blocked");
    assert.deepEqual(s.cards().map((c) => [c.kind, c.label]), [['blocked', 'B']]);
    assert.equal(s.store.programStatus('t1', osc('b', 'clear')), true);
    assert.notEqual(s.store.agentState('t1'), 'waiting', 'the last blocked child went, and the wait with it');
    assert.deepEqual(s.cards(), []);
  });
}

test('S1.2 preserved: a blocked child record that ends still ends the hook wait it stood for', () => {
  const s = setup();
  s.store.programStatus('t1', osc('a', 'blocked', { kind: 'permission', msg: 'Bash: ls' }));
  s.advance(5500);
  s.hook({ prompt: CLAUDE }, ['blocked', 'finished']);
  assert.equal(s.store.agentState('t1'), 'waiting');
  s.advance(1000);
  s.store.programStatus('t1', osc('a', 'working'));
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), []);
});
