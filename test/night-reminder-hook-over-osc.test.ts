// The bedtime reminder counts an agent whose
// hooks report a wait as waiting for the user, even while its program reports OSC 7501 working, done
// or idle. Real attention store and terminal registry over fake ptys; fake bridge link, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightService, type NightLink } from '../src/night/service.ts';
import { AttentionStore } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function setup() {
  const spawn: SpawnFn = () => new FakePty();
  const terminals = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const store = new AttentionStore();
  terminals.subscribe((event) => store.track(event));
  const link: NightLink = { send: () => false, isConnected: () => true, connectedTerminals: () => [] };
  const service = new NightService({
    link,
    decider: { decide: async () => ({ action: 'defer', reason: 'not used' }), followUp: async () => ({ action: 'defer', reason: 'not used' }) },
    log: { append: async () => {} },
    terminals,
    workspaces: { get: (id: string) => (id === 'ops' ? { id: 'ops', name: 'Ops', root: '/ops', folders: [], expanded: [], mission: 'Keep it green.' } : undefined) },
    attention: () => store,
  });
  let seq = Date.now();
  const open = (rel: string) => {
    const id = terminals.create({ cwd: `/ops/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'ops', rel }).id;
    return {
      id,
      hook: (tokens: Record<string, string>, clear: string[] = []) =>
        store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: id, source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear })),
      osc: (state: ProgramStatusReport['state']) => store.programStatus(id, { id: '', state }),
    };
  };
  return { service, store, open, close: () => service.close() };
}

test('an agent waiting by its hooks under an OSC working, done or idle is "needs you" in the bedtime reminder', () => {
  const s = setup();
  try {
    const states = ['working', 'done', 'idle'] as const;
    for (const state of states) {
      const agent = s.open(state);
      agent.osc(state);
      agent.hook({ blocked: 'Questionnaire awaiting input' }, ['finished']);
      assert.equal(s.store.agentState(agent.id), 'waiting', state);
    }
    const reminder = s.service.reminder();
    assert.deepEqual(reminder.workspaces[0].agents.map((agent) => [agent.rel, agent.state, agent.waitingFor]), states.map((state) => [state, 'blocked', 'Questionnaire awaiting input']));
    assert.equal(reminder.waiting, 3);
  } finally {
    s.close();
  }
});

test('preserved: an OSC done agent with no hook wait is a finished one in the bedtime reminder', () => {
  const s = setup();
  try {
    const agent = s.open('docs');
    agent.hook({}, ['blocked', 'prompt', 'finished']);
    agent.osc('done');
    const reminder = s.service.reminder();
    assert.deepEqual(reminder.workspaces[0].agents.map((entry) => [entry.rel, entry.state, entry.waitingFor]), [['docs', 'finished', null]]);
    assert.equal(reminder.waiting, 0);
  } finally {
    s.close();
  }
});
