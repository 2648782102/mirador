// Idle sleep counts an agent whose hooks
// report a wait as waiting for the user, even while its program reports OSC 7501 idle or done, so it
// is never asked to save and sleep. Real registry over fake ptys, real attention store, fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionStore } from '../src/attention/store.ts';
import type { ProgramStatusReport } from '../src/attention/osc7501.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { IdleSleep } from '../src/terminals/hibernate.ts';

const IDLE_MS = 4 * 60 * 60_000;

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function setup() {
  const spawn: SpawnFn = () => new FakePty();
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 1000 });
  const attention = new AttentionStore();
  registry.subscribe((event) => attention.track(event));
  let clock = 0;
  const timers: Array<{ due: number; run: () => void; cancelled: boolean }> = [];
  const notes: string[] = [];
  const idle = new IdleSleep({
    registry,
    attention,
    openAgents: { canSleep: () => true, sleep: () => true },
    sendNote: async (terminalId) => {
      notes.push(terminalId);
      return { sent: true };
    },
    idleMs: IDLE_MS,
    schedule: (run, ms) => {
      const timer = { due: clock + ms, run, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    log: () => {},
  });
  idle.start();
  const pass = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock = next.due;
      next.cancelled = true;
      next.run();
    }
    clock = until;
  };
  const id = registry.create({ cwd: '/w/api', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'api' }).id;
  let seq = Date.now();
  const hook = (tokens: Record<string, string>, clear: string[] = []) =>
    attention.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: id, source: 'mirador:attention', seq: ++seq, ttlMs: null, tokens, clear }));
  const osc = (state: ProgramStatusReport['state']) => attention.programStatus(id, { id: '', state });
  return { attention, id, hook, osc, pass, notes, stop: () => idle.stop() };
}

for (const state of ['idle', 'done'] as const) {
  test(`an OSC ${state} agent whose hooks then report a wait is waiting, and idle sleep never asks it to save`, () => {
    const s = setup();
    try {
      s.hook({}, ['blocked', 'prompt', 'finished']);
      s.osc(state);
      assert.equal(s.attention.agentState(s.id), 'finished');
      s.hook({ prompt: 'Claude needs your permission' }, ['finished']);
      assert.equal(s.attention.agentState(s.id), 'waiting');
      s.pass(IDLE_MS * 2);
      assert.deepEqual(s.notes, [], 'no save note: it waits for the user');
    } finally {
      s.stop();
    }
  });
}

test('preserved: an OSC idle agent with no hook wait still sleeps after the idle time', () => {
  const s = setup();
  try {
    s.hook({}, ['blocked', 'prompt', 'finished']);
    s.osc('idle');
    assert.equal(s.attention.agentState(s.id), 'finished');
    s.pass(IDLE_MS);
    assert.deepEqual(s.notes, [s.id], 'the save note goes out');
  } finally {
    s.stop();
  }
});
