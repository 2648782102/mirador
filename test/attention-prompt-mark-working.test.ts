// The prompt mark (OSC 133 A, the
// agent's bash drawing its prompt) also ends the hooks' last `working` report of that pty, not only
// its wait. Same attribution: a hook report names the one pane it came from, so the prompt
// of one terminal never touches another terminal, even in the same folder. A finished turn stays.
// Each case reads the store's public interface only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore, type AgentAttentionState } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const SESSION = '3f0c9a1e-claude-session';

function terminal(id: string): TerminalInfo {
  return { id, workspaceId: 'dev', rel: 'vigia/api', cwd: '/home/you/Dev/vigia/api', title: 'api', kind: 'agent', status: 'running', createdAt: '2026-11-16T09:00:00.000Z' };
}

const osc = (state: ProgramStatusReport['state']): ProgramStatusReport => ({ id: '', state });

/** Agent terminals (same workspace and folder), a clock, every state change told, and hook reports. */
function setup(ids: string[] = ['t1']) {
  let clock = T0;
  const store = new AttentionStore({ now: () => clock });
  for (const id of ids) store.track({ type: 'created', info: terminal(id) });
  const heard: Array<[string, AgentAttentionState]> = [];
  store.onAgentState((id, state) => heard.push([id, state]));
  const seqs = new Map<string, number>();
  const hook = (pane: string, tokens: Record<string, string>, clear: string[]) => {
    const seq = (seqs.get(pane) ?? 0) + 1;
    seqs.set(pane, seq);
    return store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq, ttlMs: null, tokens, clear }));
  };
  /** The claude hook's working report (UserPromptSubmit, PostToolUse): no expiry. */
  const working = (pane: string) => hook(pane, { session: SESSION }, ['blocked', 'prompt', 'finished']);
  const cards = () => store.items().map((item) => ({ terminalId: item.terminalId, kind: item.kind, label: item.label }));
  return { store, heard, hook, working, cards, advance: (ms: number) => { clock += ms; } };
}

test('S6: "Turno cortado sin Stop, el agente sale y bash dibuja su prompt: el estado deja de ser working."', () => {
  const s = setup();
  assert.equal(s.working('t1'), true); // UserPromptSubmit
  s.advance(2000);
  assert.equal(s.working('t1'), true); // PostToolUse; then the turn is cut: no Stop
  assert.equal(s.store.agentState('t1'), 'working');
  s.advance(1000);
  assert.equal(s.store.programPrompt('t1'), true); // the agent exits, bash draws its prompt
  assert.equal(s.store.agentState('t1'), 'unknown');
  assert.deepEqual(s.cards(), []);
  assert.deepEqual(s.heard, [['t1', 'working'], ['t1', 'unknown']]);
  s.advance(60_000);
  assert.equal(s.store.agentState('t1'), 'unknown', 'it does not come back as working');
});

test('S6: "Lo mismo con OSC y hooks juntos: OSC working, PostToolUse, corte, OSC idle, salida con OSC clear y marca de prompt. No queda en working."', () => {
  const s = setup();
  s.store.programStatus('t1', osc('working'));
  s.advance(1000);
  s.working('t1'); // PostToolUse
  s.advance(1000);
  s.store.programStatus('t1', osc('idle')); // the cut
  assert.equal(s.store.agentState('t1'), 'finished');
  s.advance(1000);
  s.store.programStatus('t1', osc('clear')); // the agent exits: it clears its reports
  s.store.programPrompt('t1'); // and bash draws its prompt
  assert.equal(s.store.agentState('t1'), 'unknown');
  assert.deepEqual(s.cards(), []);
  assert.notEqual(s.heard.at(-1)?.[1], 'working');
});

test('S6: "Dos terminales en la misma carpeta: el prompt de una no borra el working de la otra."', () => {
  const s = setup(['t1', 't2']); // same workspace, folder and cwd
  s.working('t1');
  s.working('t2');
  assert.equal(s.store.agentState('t1'), 'working');
  assert.equal(s.store.agentState('t2'), 'working');
  assert.equal(s.store.programPrompt('t1'), true);
  assert.equal(s.store.agentState('t1'), 'unknown', "t1's prompt ends t1's working");
  assert.equal(s.store.agentState('t2'), 'working', "t2's working is untouched");
  assert.deepEqual(s.heard, [['t1', 'working'], ['t2', 'working'], ['t1', 'unknown']]);
});

test('preserved: a finished turn stays after the prompt mark (Stop, then the agent exits)', () => {
  const s = setup();
  s.working('t1');
  s.advance(1000);
  s.hook('t1', { session: SESSION, finished: 'turn-1' }, ['blocked', 'prompt']); // Stop
  assert.equal(s.store.agentState('t1'), 'finished');
  s.store.programPrompt('t1');
  assert.equal(s.store.agentState('t1'), 'finished');
  assert.deepEqual(s.cards(), [{ terminalId: 't1', kind: 'finished', label: 'Finished' }]);
});

test('preserved (F1b): a hook wait then the prompt mark reads unknown and its card is gone', () => {
  const s = setup();
  s.hook('t1', { prompt: 'Claude needs your permission' }, ['blocked', 'finished']);
  assert.equal(s.store.agentState('t1'), 'waiting');
  assert.equal(s.cards().length, 1);
  s.store.programPrompt('t1');
  assert.equal(s.store.agentState('t1'), 'unknown');
  assert.deepEqual(s.cards(), []);
});

test('the next hook report after the prompt mark counts again (a new agent in that terminal)', () => {
  const s = setup();
  s.working('t1');
  s.store.programPrompt('t1');
  assert.equal(s.store.agentState('t1'), 'unknown');
  s.advance(1000);
  s.working('t1');
  assert.equal(s.store.agentState('t1'), 'working');
});
