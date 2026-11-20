// Interleavings of the two attention sources: hook reports (herdr socket) and OSC 7501 reports (pty
// output, plus the OSC 133 A prompt mark). While any OSC 7501 record is live it decides, except that
// a hook wait (blocked, prompt) wins over a working, done or idle record; an OSC blocked or error
// still decides over it. An OSC done, idle or clear after the hook wait, or the end of an
// OSC blocked, ends that wait. Hooks decide again after `state=clear`, or after a prompt drops the last
// working/blocked record. A prompt also ends the hooks' wait (blocked, prompt) of that same terminal.
// Each case is played twice on fresh stores to prove the outcome depends only on
// the sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore, type AgentAttentionState } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';

type Step =
  | 'hook:blocked'
  | 'hook:finished'
  | 'osc:working'
  | 'osc:blocked'
  | 'osc:idle'
  | 'osc:error'
  | 'osc:clear'
  | 'prompt';

const info: TerminalInfo = { id: 't1', workspaceId: 'dev', rel: 'alpha', cwd: '/home/you/Dev/alpha', title: 'alpha', kind: 'agent', status: 'running', createdAt: '2026-10-28T10:00:00.000Z' };
const GUARDED = 'Guarded command confirmation';

const OSC: Record<string, ProgramStatusReport> = {
  'osc:working': { id: '', state: 'working' },
  'osc:blocked': { id: '', state: 'blocked', kind: 'permission', msg: 'Deploy?' },
  'osc:idle': { id: '', state: 'idle' },
  'osc:error': { id: '', state: 'error', msg: 'Build failed' },
  'osc:clear': { id: '', state: 'clear' },
};

/** Plays `steps` on a fresh store; returns the agent state and the inbox cards as [kind, label]. */
function play(steps: Step[]): { state: AgentAttentionState; items: Array<[string, string]> } {
  let clock = Date.parse('2026-10-28T10:05:00.000Z');
  const store = new AttentionStore({ now: () => clock });
  store.track({ type: 'created', info });
  let seq = 0;
  const hook = (tokens: Record<string, string>, clear: string[]) =>
    assert.equal(store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: 't1', source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear })), true);
  for (const step of steps) {
    clock += 1000;
    if (step === 'hook:blocked') hook({ blocked: GUARDED }, ['finished']);
    else if (step === 'hook:finished') hook({ finished: `turn-${seq}` }, ['blocked']);
    else if (step === 'prompt') assert.equal(store.programPrompt('t1'), true);
    else assert.equal(store.programStatus('t1', OSC[step]), true);
  }
  return { state: store.agentState('t1'), items: store.items().map((item) => [item.kind, item.label]) };
}

const CASES: Array<{ steps: Step[]; state: AgentAttentionState; items: Array<[string, string]> }> = [
  // Hooks alone, as before.
  { steps: ['hook:blocked'], state: 'waiting', items: [['blocked', GUARDED]] },
  { steps: ['hook:finished'], state: 'finished', items: [['finished', 'Finished']] },
  // A hook wait wins over OSC working, whichever arrives first; OSC blocked and error still decide.
  { steps: ['hook:blocked', 'osc:working'], state: 'waiting', items: [['blocked', GUARDED]] },
  { steps: ['osc:working', 'hook:blocked'], state: 'waiting', items: [['blocked', GUARDED]] },
  { steps: ['hook:finished', 'osc:blocked'], state: 'waiting', items: [['blocked', 'Deploy?']] },
  { steps: ['osc:blocked', 'hook:finished'], state: 'waiting', items: [['blocked', 'Deploy?']] },
  { steps: ['hook:blocked', 'osc:error'], state: 'error', items: [['error', 'Error']] },
  { steps: ['osc:error', 'hook:blocked'], state: 'error', items: [['error', 'Error']] },
  // An idle record after the hook wait ends it; a hook wait after an idle record wins over it.
  { steps: ['hook:blocked', 'osc:idle'], state: 'finished', items: [] },
  { steps: ['osc:idle', 'hook:blocked'], state: 'waiting', items: [['blocked', GUARDED]] },
  { steps: ['hook:blocked', 'osc:idle', 'prompt'], state: 'finished', items: [] },
  { steps: ['hook:blocked', 'osc:idle', 'osc:clear'], state: 'working', items: [] },
  // Clear and prompt hand back to the hooks; clear also ends the hook wait.
  { steps: ['hook:blocked', 'osc:working', 'osc:clear'], state: 'working', items: [] },
  // The prompt also ends the hook's wait in that terminal, so nothing is handed back.
  { steps: ['hook:blocked', 'osc:working', 'prompt'], state: 'unknown', items: [] },
  { steps: ['hook:blocked', 'prompt'], state: 'unknown', items: [] },
  { steps: ['hook:blocked', 'prompt', 'hook:blocked'], state: 'waiting', items: [['blocked', GUARDED]] },
  { steps: ['hook:finished', 'osc:blocked', 'prompt'], state: 'finished', items: [['finished', 'Finished']] },
  { steps: ['osc:working', 'osc:clear', 'hook:finished'], state: 'finished', items: [['finished', 'Finished']] },
  // error survives a prompt; clear ends it.
  { steps: ['osc:error', 'prompt', 'hook:blocked'], state: 'error', items: [['error', 'Error']] },
  { steps: ['osc:error', 'osc:clear', 'hook:blocked'], state: 'waiting', items: [['blocked', GUARDED]] },
  // OSC alone, nothing from the hooks.
  { steps: ['osc:blocked', 'prompt'], state: 'unknown', items: [] },
  { steps: ['osc:working', 'osc:blocked', 'osc:working'], state: 'working', items: [] },
  { steps: ['prompt'], state: 'unknown', items: [] },
];

for (const { steps, state, items } of CASES) {
  test(`${steps.join(' → ')} ⇒ ${state}`, () => {
    const first = play(steps);
    const second = play(steps);
    assert.deepEqual(first, { state, items });
    assert.deepEqual(second, first, 'the same sequence gives the same outcome');
  });
}
