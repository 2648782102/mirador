// A hook wait (`blocked` or `prompt`) beats an
// OSC 7501 record that ranks below blocked (working, done, idle); an OSC `blocked` keeps deciding,
// with one card and one notification; an OSC `done`, `idle` or `clear` after the hook's wait, or the
// OSC `blocked` it shadowed ending, ends that wait; the prompt mark still ends it. Each case reads
// the store's public interface and counts notifications through the browser notifier
// (public/features/inbox-notify.js) fed with every inbox snapshot the store pushes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore, type AgentAttentionState, type AttentionItem } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';
import { createInboxNotifier, episodeKey } from '../public/features/inbox-notify.js';

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const GUARDED = 'Questionnaire awaiting input';
const CLAUDE = 'Claude needs your permission';

function terminal(id: string): TerminalInfo {
  return { id, workspaceId: 'dev', rel: 'vigia/api', cwd: '/home/you/Dev/vigia/api', title: 'api', kind: 'agent', status: 'running', createdAt: '2026-11-13T09:00:00.000Z' };
}

const osc = (state: ProgramStatusReport['state'], extra: Partial<ProgramStatusReport> = {}): ProgramStatusReport => ({ id: '', state, ...extra });

/** A store with agent terminals, a clock, every state change it tells and every notification the browser would show. */
function setup(ids: string[] = ['t1']) {
  let clock = T0;
  const store = new AttentionStore({ now: () => clock });
  for (const id of ids) store.track({ type: 'created', info: terminal(id) });
  const heard: Array<[string, AgentAttentionState]> = [];
  store.onAgentState((id, state) => heard.push([id, state]));
  const notified: string[] = [];
  const notifier = createInboxNotifier({
    api: { permission: 'granted', requestPermission: () => Promise.resolve('granted') },
    read: () => true,
    write: () => {},
    show: (item: AttentionItem) => { notified.push(episodeKey(item)); return { close() {} }; },
  });
  notifier.receive(store.items()); // the page opens with nothing waiting: the baseline
  store.subscribe((items) => notifier.receive(items));
  const seqs = new Map<string, number>();
  /** A report from the attention bridge or an agent hook, as the herdr shim forwards it. */
  const hook = (pane: string, tokens: Record<string, string>, clear: string[] = []) => {
    const seq = (seqs.get(pane) ?? 0) + 1;
    seqs.set(pane, seq);
    return store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq, ttlMs: null, tokens, clear }));
  };
  const cards = () => store.items().map((item) => ({ terminalId: item.terminalId, kind: item.kind, label: item.label, blockedKind: item.blockedKind, since: item.since }));
  return { store, heard, notified, hook, cards, advance: (ms: number) => { clock += ms; }, iso: () => new Date(clock).toISOString() };
}

test('S5.1: a hook blocked over an OSC working is one "needs you" card, notified once', () => {
  const s = setup();
  // The gentle questionnaire: pi keeps reporting working while its dialog waits.
  s.store.programStatus('t1', osc('working'));
  s.advance(1000);
  const since = s.iso();
  assert.equal(s.hook('t1', { blocked: GUARDED }, ['finished']), true);
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'blocked', label: GUARDED, blockedKind: undefined, since }]);
  s.advance(1000);
  s.store.programStatus('t1', osc('working', { progress: 50 }));
  assert.equal(s.store.agentState('t1'), 'waiting', 'a repeated working does not end the wait');
  assert.equal(s.cards().length, 1);
  assert.deepEqual(s.notified, [`t1\u0000${since}`], 'one notification');
  assert.deepEqual(s.heard, [['t1', 'working'], ['t1', 'waiting']]);

  // The other order: the hook first, then OSC working.
  const r = setup();
  const first = r.iso();
  r.hook('t1', { blocked: GUARDED }, ['finished']);
  r.advance(1000);
  r.store.programStatus('t1', osc('working'));
  assert.equal(r.store.agentState('t1'), 'waiting');
  assert.deepEqual(r.cards(), [{ terminalId: 't1', kind: 'blocked', label: GUARDED, blockedKind: undefined, since: first }]);
  assert.deepEqual(r.notified, [`t1\u0000${first}`]);
  assert.deepEqual(r.heard, [['t1', 'waiting']]);
});

test('S5.2: an OSC blocked and then the hook prompt (the Claude case) stay one card and one notification', () => {
  const s = setup();
  s.store.programStatus('t1', osc('working'));
  s.advance(1000);
  const since = s.iso();
  s.store.programStatus('t1', osc('blocked', { kind: 'permission', msg: 'Bash: rm -rf build' }));
  s.advance(5500);
  assert.equal(s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']), true);
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'blocked', label: 'Bash: rm -rf build', blockedKind: 'permission', since }], "OSC's card, with its start");
  assert.deepEqual(s.notified, [`t1\u0000${since}`]);
  assert.deepEqual(s.heard, [['t1', 'working'], ['t1', 'waiting']]);
});

test('S5.3: once answered the card leaves and the agent is working again, whichever source saw the answer', () => {
  // Claude: the program reports working again; its hook clears the prompt only later (PostToolUse).
  const s = setup();
  s.store.programStatus('t1', osc('blocked', { kind: 'permission', msg: 'Bash: rm -rf build' }));
  s.advance(5500);
  s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']);
  s.advance(2000);
  s.store.programStatus('t1', osc('working'));
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), [], 'the hook prompt the OSC card stood for went with it');
  s.advance(30_000);
  s.hook('t1', {}, ['blocked', 'prompt', 'finished']);
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), []);
  assert.equal(s.notified.length, 1, 'still the one notification');
  assert.deepEqual(s.heard, [['t1', 'waiting'], ['t1', 'working']]);

  // gentle: its bridge clears the blocked token while pi keeps reporting working.
  const g = setup();
  g.store.programStatus('t1', osc('working'));
  g.hook('t1', { blocked: GUARDED }, ['finished']);
  g.advance(3000);
  g.hook('t1', {}, ['blocked', 'prompt']);
  assert.equal(g.store.agentState('t1'), 'working');
  assert.deepEqual(g.cards(), []);
  assert.equal(g.notified.length, 1);
  assert.deepEqual(g.heard, [['t1', 'working'], ['t1', 'waiting'], ['t1', 'working']]);
});

test('S5.4: a hook blocked and then an OSC done leaves no "needs you"; idle and clear end the wait too', () => {
  const s = setup();
  s.hook('t1', { blocked: GUARDED }, ['finished']);
  s.advance(1000);
  const done = s.iso();
  s.store.programStatus('t1', osc('done', { msg: 'Docs built' }));
  assert.equal(s.store.agentState('t1'), 'finished');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'finished', label: 'Finished', blockedKind: undefined, since: done }]);
  s.store.programStatus('t1', osc('clear'));
  assert.equal(s.store.agentState('t1'), 'working', 'the hooks decide again, and their wait is gone');
  assert.deepEqual(s.cards(), []);
  assert.equal(s.notified.length, 1, 'only the blocked card notified; a finished card never does');

  const idle = setup();
  idle.hook('t1', { prompt: CLAUDE }, ['finished']);
  idle.store.programStatus('t1', osc('idle'));
  assert.equal(idle.store.agentState('t1'), 'finished');
  assert.deepEqual(idle.cards(), []);
  idle.store.programStatus('t1', osc('clear'));
  assert.equal(idle.store.agentState('t1'), 'working');
  assert.deepEqual(idle.cards(), []);

  const clear = setup();
  clear.store.programStatus('t1', osc('working'));
  clear.hook('t1', { blocked: GUARDED }, ['finished']);
  assert.equal(clear.store.agentState('t1'), 'waiting');
  clear.store.programStatus('t1', osc('clear'));
  assert.equal(clear.store.agentState('t1'), 'working');
  assert.deepEqual(clear.cards(), []);
  assert.deepEqual(clear.heard, [['t1', 'working'], ['t1', 'waiting'], ['t1', 'working']]);
});

test('S5.5: the F1b prompt mark still ends the hook blocked of that pty only', () => {
  const s = setup(['t1', 't2']); // same workspace, folder and cwd
  s.store.programStatus('t1', osc('working'));
  s.hook('t1', { blocked: GUARDED }, ['finished']);
  const since = s.iso();
  s.hook('t2', { blocked: GUARDED }, ['finished']);
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.equal(s.cards().length, 2);
  assert.equal(s.store.programPrompt('t1'), true);
  assert.equal(s.store.agentState('t1'), 'unknown', 'working and the hook wait are gone, as is the hooks report');
  assert.deepEqual(s.cards(), [{ terminalId: 't2', kind: 'blocked', label: GUARDED, blockedKind: undefined, since }], "t2's card is untouched");
  assert.equal(s.store.agentState('t2'), 'waiting');
  assert.equal(s.notified.length, 2);

  // An idle record survives the prompt; the hook wait does not.
  const idle = setup();
  idle.store.programStatus('t1', osc('idle'));
  idle.hook('t1', { blocked: GUARDED }, ['finished']);
  assert.equal(idle.store.agentState('t1'), 'waiting');
  assert.equal(idle.store.programPrompt('t1'), true);
  assert.equal(idle.store.agentState('t1'), 'finished');
  assert.deepEqual(idle.cards(), []);
});

test('preserved: an OSC blocked alone is one card and one notification, and leaves when OSC says working', () => {
  const s = setup();
  const since = s.iso();
  s.store.programStatus('t1', osc('blocked', { kind: 'question', msg: 'Overwrite config.toml?' }));
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'blocked', label: 'Overwrite config.toml?', blockedKind: 'question', since }]);
  s.store.programStatus('t1', osc('working'));
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), []);
  assert.deepEqual(s.notified, [`t1\u0000${since}`]);
});

test('preserved: a hook blocked with no OSC record is one card and one notification, and leaves when cleared', () => {
  const s = setup();
  const since = s.iso();
  s.hook('t1', { blocked: GUARDED, prompt: 'Pick one' }, ['finished']);
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.deepEqual(plainItems(s.store), [{ kind: 'blocked', label: GUARDED, detail: 'Pick one', since }]);
  s.hook('t1', {}, ['blocked', 'prompt']);
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), []);
  assert.deepEqual(s.notified, [`t1\u0000${since}`]);
});

test('preserved (decision): an OSC error still decides over a hook wait, whichever came first', () => {
  for (const errorFirst of [true, false]) {
    const s = setup();
    if (errorFirst) s.store.programStatus('t1', osc('error', { msg: 'Build failed' }));
    s.hook('t1', { blocked: GUARDED }, ['finished']);
    if (!errorFirst) s.store.programStatus('t1', osc('error', { msg: 'Build failed' }));
    assert.equal(s.store.agentState('t1'), 'error');
    assert.deepEqual(s.store.items().map((item) => [item.kind, item.label, item.detail]), [['error', 'Error', 'Build failed']]);
    assert.equal(s.notified.length, 1);
  }
});

// The per-turn rule. The hook `prompt` (Claude's permission Notification) is
// suppressed once, in this turn, an OSC `blocked` of kind permission has ended; a hook `blocked`
// (gentle's question) never is. The turn ends at OSC done or idle, or the hook's `finished` (Stop),
// but the rule holds until the next turn starts: the first OSC `working` after one of those. The
// agent leaving (the prompt mark) and OSC `clear` reset it at once.

/** An OSC permission blocked that the user approves after 1 s: the program reports working again. */
function approvedPermission(s: ReturnType<typeof setup>, msg = 'approve Bash: ls') {
  const since = s.iso();
  s.store.programStatus('t1', osc('blocked', { kind: 'permission', msg }));
  s.advance(1000);
  s.store.programStatus('t1', osc('working'));
  return since;
}

test("S9.1: the verifier's case: OSC blocked, approved, OSC working, PostToolUse, and the hook prompt 4 s later: no card, no notification", () => {
  const s = setup();
  const since = approvedPermission(s);
  s.hook('t1', {}, ['blocked', 'prompt', 'finished']); // PostToolUse
  s.advance(4000);
  assert.equal(s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']), true, 'the late Notification is a valid report'); // late Notification
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), []);
  assert.deepEqual(s.notified, [`t1\u0000${since}`], 'only the earlier OSC card notified');
  assert.deepEqual(s.heard, [['t1', 'waiting'], ['t1', 'working']]);
});

test('S9.2: a second permission in the same turn: OSC reports blocked again, its card shows and notifies once', () => {
  const s = setup();
  const first = approvedPermission(s);
  s.hook('t1', {}, ['blocked', 'prompt', 'finished']); // PostToolUse
  s.advance(2000);
  const second = s.iso();
  s.store.programStatus('t1', osc('blocked', { kind: 'permission', msg: 'approve Bash: rm -rf build' }));
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'blocked', label: 'approve Bash: rm -rf build', blockedKind: 'permission', since: second }], "OSC's card");
  s.advance(5500);
  s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']); // its Notification, while the dialog is open
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'blocked', label: 'approve Bash: rm -rf build', blockedKind: 'permission', since: second }], 'still one card');
  assert.deepEqual(s.notified, [`t1\u0000${first}`, `t1\u0000${second}`], 'one notification for the second permission');
  s.advance(1000);
  s.store.programStatus('t1', osc('working'));
  s.advance(1000);
  s.store.programStatus('t1', osc('working', { progress: 50 })); // still this turn: no done, idle or Stop before it
  s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']); // a late one after its answer
  assert.equal(s.store.agentState('t1'), 'working');
  assert.deepEqual(s.cards(), []);
  assert.equal(s.notified.length, 2);
});

test('S9.3: same turn: an OSC permission ends and then the hook reports blocked (a gentle question): its card shows', () => {
  const s = setup();
  const first = approvedPermission(s);
  s.advance(2000);
  const since = s.iso();
  s.hook('t1', { blocked: GUARDED }, ['finished']);
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'blocked', label: GUARDED, blockedKind: undefined, since }]);
  assert.deepEqual(s.notified, [`t1\u0000${first}`, `t1\u0000${since}`]);

  // A blocked and a prompt in one report (the bridge reports its whole state): only a prompt that
  // arrives alone is suppressed, so the card keeps the prompt's text.
  const both = setup();
  approvedPermission(both);
  const at = both.iso();
  both.hook('t1', { blocked: GUARDED, prompt: 'Pick one' }, ['finished']);
  assert.equal(both.store.agentState('t1'), 'waiting');
  assert.deepEqual(plainItems(both.store), [{ kind: 'blocked', label: GUARDED, detail: 'Pick one', since: at }], 'the blocked card keeps the prompt text');
  assert.equal(both.notified.length, 2);
});

for (const [name, close] of [
  ['OSC done', (s: ReturnType<typeof setup>) => s.store.programStatus('t1', osc('done'))],
  ['OSC idle', (s: ReturnType<typeof setup>) => s.store.programStatus('t1', osc('idle'))],
  ['the hook finished (Stop)', (s: ReturnType<typeof setup>) => s.hook('t1', { finished: 'turn-1' }, ['blocked', 'prompt'])],
] as const) {
  test(`S9.4: next turn (after ${name}, then OSC working): a hook prompt with no OSC blocked before it shows its card`, () => {
    const s = setup();
    const first = approvedPermission(s);
    s.advance(2000);
    close(s);
    s.advance(1000);
    s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']);
    assert.notEqual(s.store.agentState('t1'), 'waiting', `${name} alone does not start the next turn`);
    s.advance(10_000);
    s.hook('t1', {}, ['blocked', 'prompt', 'finished']); // UserPromptSubmit
    s.store.programStatus('t1', osc('working')); // the next turn starts
    s.advance(3000);
    const since = s.iso();
    s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']);
    assert.equal(s.store.agentState('t1'), 'waiting');
    assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'prompt', label: CLAUDE, blockedKind: undefined, since }]);
    assert.deepEqual(s.notified, [`t1\u0000${first}`, `t1\u0000${since}`]);
  });
}

test('S9.5: the agent leaving (the F1b prompt mark) or an OSC clear resets the rule', () => {
  const exit = setup();
  const first = approvedPermission(exit);
  exit.advance(1000);
  assert.equal(exit.store.programPrompt('t1'), true); // the agent left: bash draws its prompt
  exit.advance(1000);
  const since = exit.iso();
  exit.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']); // a new agent in that terminal
  assert.equal(exit.store.agentState('t1'), 'waiting');
  assert.deepEqual(exit.cards(), [{ terminalId: 't1', kind: 'prompt', label: CLAUDE, blockedKind: undefined, since }]);
  assert.deepEqual(exit.notified, [`t1\u0000${first}`, `t1\u0000${since}`]);

  const clear = setup();
  const before = approvedPermission(clear);
  clear.advance(1000);
  clear.store.programStatus('t1', osc('clear'));
  clear.advance(1000);
  const at = clear.iso();
  clear.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']);
  assert.equal(clear.store.agentState('t1'), 'waiting');
  assert.deepEqual(clear.cards(), [{ terminalId: 't1', kind: 'prompt', label: CLAUDE, blockedKind: undefined, since: at }]);
  assert.deepEqual(clear.notified, [`t1\u0000${before}`, `t1\u0000${at}`]);
});

test('S9.6: a short turn: OSC blocked, approved, working, done at 3 s, and the hook prompt at 5 s: no card from it and no notification', () => {
  const s = setup();
  const since = approvedPermission(s); // blocked at 0 s, working at 1 s
  s.advance(2000);
  const done = s.iso();
  s.store.programStatus('t1', osc('done')); // 3 s
  s.advance(2000);
  s.hook('t1', { prompt: CLAUDE }, ['blocked', 'finished']); // 5 s: the late Notification
  assert.equal(s.store.agentState('t1'), 'finished');
  // Only the program's own Finished card (a finished turn never notifies): no "needs you" card.
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'finished', label: 'Finished', blockedKind: undefined, since: done }]);
  assert.deepEqual(s.notified, [`t1\u0000${since}`], 'only the earlier OSC card notified');
  assert.deepEqual(s.heard, [['t1', 'waiting'], ['t1', 'working'], ['t1', 'finished']]);
});

function plainItems(store: AttentionStore) {
  return store.items().map((item) => ({ kind: item.kind, label: item.label, detail: item.detail, since: item.since }));
}
