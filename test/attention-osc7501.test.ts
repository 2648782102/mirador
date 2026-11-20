// The attention store's OSC 7501 source (Program Status Protocol): while a terminal holds an
// OSC 7501 record it wins over the hook reports, except that a hook wait (blocked, prompt) wins over
// a working, done or idle record; OSC blocked and error still decide. Hooks remain the
// fallback; `error` is a state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore, type AgentAttentionState } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';

function terminal(id: string, kind: 'agent' | 'shell' = 'agent'): TerminalInfo {
  return { id, workspaceId: 'dev', rel: 'vigia/api', cwd: '/home/you/Dev/vigia/api', title: 'api', kind, status: 'running', createdAt: '2026-10-28T10:00:00.000Z' };
}

/** A hook report from the attention bridge, as the herdr shim forwards it. */
const hook = (pane: string, seq: number, tokens: Record<string, string> = {}, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq, ttlMs: null, tokens, clear });

const osc = (state: ProgramStatusReport['state'], extra: Partial<ProgramStatusReport> = {}): ProgramStatusReport => ({ id: '', state, ...extra });

function setup() {
  let clock = Date.parse('2026-10-28T10:05:00.000Z');
  const store = new AttentionStore({ now: () => clock });
  store.track({ type: 'created', info: terminal('t1') });
  const heard: Array<[string, AgentAttentionState]> = [];
  store.onAgentState((id, state) => heard.push([id, state]));
  return { store, heard, advance: (ms: number) => { clock += ms; }, iso: () => new Date(clock).toISOString() };
}

test('an OSC 7501 blocked report makes the agent waiting, with its kind and message on the card', () => {
  const { store, iso } = setup();
  assert.equal(store.programStatus('t1', osc('blocked', { kind: 'permission', app: 'claude-code', msg: 'Run rm -rf build?' })), true);
  assert.equal(store.agentState('t1'), 'waiting');
  assert.deepEqual(store.items(), [{
    terminalId: 't1', workspaceId: 'dev', rel: 'vigia/api', title: 'api',
    kind: 'blocked', label: 'Run rm -rf build?', detail: null, since: iso(), activity: null, blockedKind: 'permission',
  }]);
  store.programStatus('t1', osc('blocked'));
  assert.deepEqual(store.items().map((i) => [i.kind, i.label, i.blockedKind]), [['blocked', 'Awaiting input', undefined]], 'no msg: the generic label');
});

test('while an OSC 7501 record is live it wins over the hooks, except a working record under a hook wait', () => {
  const { store } = setup();
  store.receive(hook('t1', 1, { blocked: 'Guarded command confirmation' }));
  assert.equal(store.agentState('t1'), 'waiting', 'hooks alone');
  store.programStatus('t1', osc('working'));
  assert.equal(store.agentState('t1'), 'waiting', 'F9: the hook wait wins over OSC working');
  assert.deepEqual(store.items().map((i) => [i.kind, i.label]), [['blocked', 'Guarded command confirmation']], 'the hook card stays while OSC says working');
  store.receive(hook('t1', 2, { finished: 'turn-1' }, ['blocked']));
  assert.equal(store.agentState('t1'), 'working', 'a later hook finished does not override OSC working');
  assert.deepEqual(store.items(), [], 'nor shows its finished card');
});

test('state=clear drops the OSC records and the hooks are the fallback again, without the wait an OSC done ended', () => {
  const { store } = setup();
  store.receive(hook('t1', 1, { blocked: 'Choice awaiting input' }));
  store.programStatus('t1', osc('done'));
  assert.equal(store.agentState('t1'), 'finished', 'F9: the done after the hook wait ends it');
  assert.deepEqual(store.items().map((i) => [i.kind, i.label]), [['finished', 'Finished']]);
  assert.equal(store.programStatus('t1', osc('clear')), true);
  assert.equal(store.agentState('t1'), 'working', 'the hooks decide again: their report stands, with no wait');
  assert.deepEqual(store.items(), []);
});

test('error is an agent state of its own; its card leaves once seen, the state stays', () => {
  const { store, heard, iso } = setup();
  store.programStatus('t1', osc('error', { msg: 'rsync failed' }));
  assert.equal(store.agentState('t1'), 'error');
  assert.deepEqual(heard, [['t1', 'error']]);
  assert.deepEqual(store.items(), [{
    terminalId: 't1', workspaceId: 'dev', rel: 'vigia/api', title: 'api',
    kind: 'error', label: 'Error', detail: 'rsync failed', since: iso(), activity: null,
  }]);
  assert.equal(store.dismiss('t1'), true);
  assert.deepEqual(store.items(), []);
  assert.equal(store.agentState('t1'), 'error');
});

test('done is a finished card until seen; idle is finished with no card; working has none', () => {
  const { store, advance } = setup();
  store.programStatus('t1', osc('working', { progress: 40 }));
  assert.equal(store.agentState('t1'), 'working');
  assert.deepEqual(store.items(), []);
  advance(1000);
  store.programStatus('t1', osc('done', { msg: 'Docs built' }));
  assert.deepEqual(store.items().map((i) => [i.kind, i.label, i.detail]), [['finished', 'Finished', 'Docs built']]);
  advance(1000);
  store.programStatus('t1', osc('done', { msg: 'Docs built' }));
  assert.equal(store.items()[0].since, '2026-10-28T10:05:01.000Z', 'the same state again keeps its start');
  store.dismiss('t1');
  assert.deepEqual(store.items(), []);
  assert.equal(store.agentState('t1'), 'finished');
  store.programStatus('t1', osc('idle'));
  assert.equal(store.agentState('t1'), 'finished', 'at rest: nothing runs');
  assert.deepEqual(store.items(), []);
});

test('records are kept per id: a blocked child outranks an idle root; clear removes an id and what is beneath it', () => {
  const { store } = setup();
  store.programStatus('t1', osc('idle'));
  store.programStatus('t1', osc('blocked', { id: 'build', kind: 'question', msg: 'Overwrite config.toml?' }));
  store.programStatus('t1', osc('working', { id: 'build/test' }));
  assert.equal(store.agentState('t1'), 'waiting');
  store.programStatus('t1', osc('clear', { id: 'build' }));
  assert.equal(store.agentState('t1'), 'finished', 'build and build/test are gone, the idle root stays');
  store.programStatus('t1', osc('working', { id: 'builder' }));
  store.programStatus('t1', osc('clear', { id: 'build' }));
  assert.equal(store.agentState('t1'), 'working', '"builder" is not beneath "build"');
});

test('a new shell prompt drops working and blocked records; done, error and idle survive it', () => {
  const { store } = setup();
  store.receive(hook('t1', 1, { finished: 'turn-1' }));
  store.programStatus('t1', osc('working'));
  store.programStatus('t1', osc('blocked', { id: 'child' }));
  assert.equal(store.agentState('t1'), 'waiting');
  assert.equal(store.programPrompt('t1'), true);
  assert.equal(store.agentState('t1'), 'finished', 'no OSC record left: the hooks decide again');
  store.programStatus('t1', osc('error', { msg: 'crashed' }));
  store.programStatus('t1', osc('idle', { id: 'other' }));
  store.programPrompt('t1');
  assert.equal(store.agentState('t1'), 'error');
  assert.equal(store.programPrompt('nobody'), false);
});

test('a new shell prompt ends the hook wait of that terminal only, even with another terminal open in the same folder', () => {
  const { store, heard, iso } = setup();
  store.track({ type: 'created', info: terminal('t2') }); // same workspace, folder and cwd as t1
  const since = iso();
  // t1 waits the way Claude Code's hook reports it (prompt), t2 the way the pi bridge does (blocked + a dialog).
  store.receive(hook('t1', 1, { session: 'abc', prompt: 'Allow Bash?' }, ['blocked', 'finished']));
  store.receive(hook('t2', 1, { blocked: 'Guarded command confirmation', prompt: 'Run it?' }));
  assert.deepEqual(store.items().map((i) => [i.terminalId, i.kind, i.label]), [['t1', 'prompt', 'Allow Bash?'], ['t2', 'blocked', 'Guarded command confirmation']]);

  assert.equal(store.programPrompt('t1'), true);
  assert.deepEqual(store.items(), [{ terminalId: 't2', workspaceId: 'dev', rel: 'vigia/api', title: 'api', kind: 'blocked', label: 'Guarded command confirmation', detail: 'Run it?', since, activity: null }], "t2's card is untouched");
  assert.equal(store.agentState('t1'), 'unknown', 'the dead agent neither waits nor works');
  assert.equal(store.agentState('t2'), 'waiting');
  assert.deepEqual(heard.filter(([id]) => id === 't1').at(-1), ['t1', 'unknown']);

  assert.equal(store.programPrompt('t2'), true);
  assert.deepEqual(store.items(), []);
  assert.equal(store.agentState('t2'), 'unknown');
});

test('after a prompt ended its wait, the next hook report counts again; a finished turn survives the prompt', () => {
  const { store, advance } = setup();
  store.receive(hook('t1', 1, { prompt: 'Allow Bash?' }));
  store.programPrompt('t1');
  assert.equal(store.agentState('t1'), 'unknown');
  store.receive(hook('t1', 2, {}, ['blocked', 'prompt', 'finished'])); // a new agent in the same bash starts a turn
  assert.equal(store.agentState('t1'), 'working');
  advance(1000);
  store.receive(hook('t1', 3, { prompt: 'Allow Edit?' }, ['blocked', 'finished']));
  assert.deepEqual(store.items().map((i) => [i.kind, i.label]), [['prompt', 'Allow Edit?']]);
  assert.equal(store.receive(hook('t1', 2, { prompt: 'replayed' })), false, 'an older report is still refused');

  // The pi bridge can hold a finished turn and a dialog at once: the prompt ends the dialog only.
  store.receive(hook('t1', 4, { finished: 'turn-1', prompt: 'Review?' }));
  store.programPrompt('t1');
  assert.equal(store.agentState('t1'), 'finished');
  assert.deepEqual(store.items().map((i) => [i.kind, i.label]), [['finished', 'Finished']]);
});

test('a terminal keeps at most 64 records: the least recently updated goes first', () => {
  const { store } = setup();
  store.programStatus('t1', osc('blocked', { id: 'first' }));
  for (let i = 0; i < 63; i++) store.programStatus('t1', osc('idle', { id: `r${i}` }));
  assert.equal(store.agentState('t1'), 'waiting', '64 records: all kept');
  store.programStatus('t1', osc('idle', { id: 'one-more' }));
  assert.equal(store.agentState('t1'), 'finished', 'the blocked record was the oldest');
});

test('OSC reports for unknown or shell terminals are refused; message text is shown as plain capped text', () => {
  const { store } = setup();
  store.track({ type: 'created', info: terminal('sh', 'shell') });
  assert.equal(store.programStatus('nobody', osc('blocked')), false);
  assert.equal(store.programStatus('sh', osc('blocked')), false);
  assert.equal(store.programStatus('t1', { id: '', state: 'sleeping' as never }), false, 'an unknown state is refused');
  store.programStatus('t1', osc('blocked', { msg: `a‮b${'x'.repeat(300)}` }));
  const [item] = store.items();
  assert.equal(item.label.startsWith('a b'), true, item.label);
  assert.equal(Array.from(item.label).length, 160);
});

test('without any OSC report the hooks behave exactly as before', () => {
  const { store, heard } = setup();
  assert.equal(store.agentState('t1'), 'unknown');
  store.receive(hook('t1', 1));
  assert.equal(store.agentState('t1'), 'working');
  store.receive(hook('t1', 2, { prompt: 'Review consent' }));
  assert.deepEqual(store.items().map((i) => [i.kind, i.label, 'blockedKind' in i]), [['prompt', 'Review consent', false]]);
  store.receive(hook('t1', 3, { finished: 'turn-1' }, ['prompt']));
  assert.equal(store.agentState('t1'), 'finished');
  assert.deepEqual(heard.map(([, state]) => state), ['working', 'waiting', 'finished']);
});
