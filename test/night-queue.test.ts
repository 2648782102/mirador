// The night queue: while the autopilot is on, at most N
// agents work at once; the rest wait in a first-in-first-out queue with their note or automatic
// follow-up, and start when one finishes its turn or waits for the user, while free memory stays at or
// above the launch gate's reserve. Fake bridge link, fake attention states, fake meminfo, real note
// store in a temp dir and a real terminal registry over fake ptys; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightService, taskText, type NightLink } from '../src/night/service.ts';
import { FALLBACK_SLOTS, MAX_SLOTS, QueueError, parseQueueSettings, suggestedSlots } from '../src/night/night-queue.ts';
import { NoteStore } from '../src/night/notes.ts';
import { reserveFor } from '../src/system/memory-gate.ts';
import type { FinishedTurn } from '../src/night/channel.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightContext } from '../src/night/protocol.ts';
import type { AgentAttentionState, AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

const GIB = 1024 ** 3;
const DELAY = 30;
const ASK = 'N4 is done.\n¿Avanzamos con A (recomendado) o B?';

function fakeLink() {
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const finals = new Map<string, FinishedTurn>();
  const listeners = new Set<(id: string, turn: FinishedTurn) => void>();
  const link: NightLink & { sent: typeof sent; connected: typeof connected; finish(id: string, turnId: string): void } = {
    sent,
    connected,
    send: (id, line) => (connected.has(id) ? (sent.push([id, line]), true) : false),
    isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected],
    lastFinished: (id) => finals.get(id) ?? null,
    onFinished: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finish(id, turnId) {
      const turn = { turnId, text: ASK, time: Date.now() };
      finals.set(id, turn);
      for (const listener of listeners) listener(id, turn);
    },
  };
  return link;
}

/** The attention store as the night service reads it: items for the inbox, and each agent's state with its changes. */
function fakeAttention() {
  const states = new Map<string, AgentAttentionState>();
  const listeners = new Set<(id: string, state: AgentAttentionState) => void>();
  const item = (terminalId: string, kind: AttentionItem['kind']): AttentionItem => ({
    terminalId, workspaceId: 'dev', rel: terminalId, title: terminalId, kind, label: kind === 'finished' ? 'Finished' : 'Choose', detail: null, since: new Date().toISOString(), activity: null,
  });
  return {
    view: {
      items: () => [...states].flatMap(([id, state]) => (state === 'finished' ? [item(id, 'finished')] : state === 'waiting' ? [item(id, 'blocked')] : [])),
      agentState: (id: string) => states.get(id) ?? 'unknown',
      onAgentState: (listener: (id: string, state: AgentAttentionState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    /** Like the bridge's reports: the change reaches the listeners at once. */
    set(id: string, state: AgentAttentionState) {
      states.set(id, state);
      for (const listener of listeners) listener(id, state);
    },
  };
}

interface Setup {
  slots?: number;
  claimMs?: number;
  /** The service's timers (NightServiceOptions.setTimer); real ones when absent. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

async function setup(options: Setup = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mirador-night-queue-'));
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const link = fakeLink();
  const attention = fakeAttention();
  const store = new NoteStore(join(base, 'night'));
  const records: NightRecord[] = [];
  const followUps: NightContext[] = [];
  const decisions: NightContext[] = [];
  const decider: Decider = {
    decide: async (_question, context) => {
      decisions.push(context);
      return { action: 'defer', reason: 'not used' };
    },
    followUp: async (context) => {
      followUps.push(context);
      return { action: 'follow-up', message: 'Proceed with option A, as you recommended.', reason: 'A is recommended.', confidence: 0.9 };
    },
  };
  const limits = { slots: options.slots ?? 2 };
  const memory = { memTotal: 24 * GIB as number | null, memAvailable: 12 * GIB as number | null };
  const service = new NightService({
    link,
    decider,
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift.' } : undefined) },
    attention: () => attention.view,
    notes: store,
    decideBudgetMs: 2000,
    deliveryTimeoutMs: 30,
    autoDelayMs: DELAY,
    sweepIntervalMs: 5,
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    queue: {
      limit: () => ({ slots: limits.slots, suggested: 5, custom: true, memTotal: memory.memTotal }),
      readMemory: async () => ({ ...memory }),
      reserve: (memTotal) => reserveFor({ reserveBytes: null }, memTotal),
      pollMs: 20,
      claimMs: options.claimMs ?? 5000,
    },
  });
  /** A connected agent in folder `rel`, in `state`. */
  const agent = (rel: string, state: AgentAttentionState) => {
    const info = terminals.create({ cwd: `/dev/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel });
    link.connected.add(info.id);
    attention.set(info.id, state);
    return info.id;
  };
  const note = (terminalId: string | undefined, text: string) => store.add({ workspaceId: 'dev', ...(terminalId ? { terminalId } : {}), text });
  /** The texts each terminal received as bridge messages, in order. */
  const received = (id: string) => link.sent.filter(([to, line]) => to === id && line.type === 'message').map(([, line]) => (line.type === 'message' ? line.text : ''));
  const queue = () => service.status().queue;
  const cleanup = async () => {
    service.close();
    // Deliveries still on their way end with close(); their store writes finish before the folder goes.
    await service.noteDelivery;
    await sleep(20);
    await service.noteDelivery;
    await rm(base, { recursive: true, force: true });
  };
  return { service, link, attention, store, records, followUps, decisions, terminals, limits, memory, agent, note, received, queue, cleanup };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(5);
  }
}
const items = (s: Awaited<ReturnType<typeof setup>>) => s.queue()?.items.map((item) => [item.terminalId, item.kind]);

/**
 * The service's timers, where each one of `held` ms (the claim time) waits for `run()` before its time starts
 * to count; every other timer is a real one at once. A held claim cannot end while the test still looks at
 * the queue, so no wait depends on catching the short moment before it ends (issue #30).
 */
function holdTimers(held: number) {
  const waiting = new Set<{ fn: () => void; cancelled: boolean; timer?: ReturnType<typeof setTimeout> }>();
  const real = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  };
  return {
    setTimer(fn: () => void, ms: number): () => void {
      if (ms !== held) {
        const timer = real(fn, ms);
        return () => clearTimeout(timer);
      }
      const entry: { fn: () => void; cancelled: boolean; timer?: ReturnType<typeof setTimeout> } = { fn, cancelled: false };
      waiting.add(entry);
      return () => {
        entry.cancelled = true;
        waiting.delete(entry);
        if (entry.timer) clearTimeout(entry.timer);
      };
    },
    /** Held timers not run yet and not cancelled. */
    held: () => [...waiting].filter((entry) => !entry.timer).length,
    /** Starts every held timer: each one fires `held` ms from now, unless it is cancelled first. */
    run(onFire: () => void = () => {}): void {
      for (const entry of waiting) {
        entry.timer ??= real(() => {
          waiting.delete(entry);
          if (entry.cancelled) return;
          onFire();
          entry.fn();
        }, held);
      }
    },
  };
}

test('N default: max(1, floor(MemTotal GiB / 4.5)), 5 on a 24 GB machine; capped at 50; unknown memory falls back', () => {
  assert.equal(suggestedSlots(23_935 * 1024 ** 2), 5, "the user's 24 GB machine (MemTotal 23935 MiB)");
  assert.equal(suggestedSlots(24 * GIB), 5);
  assert.equal(suggestedSlots(15.5 * GIB), 3, '16 GB');
  assert.equal(suggestedSlots(7.6 * GIB), 1, '8 GB');
  assert.equal(suggestedSlots(2 * GIB), 1, 'never below one');
  assert.equal(suggestedSlots(62.7 * GIB), 13, '64 GB');
  assert.equal(suggestedSlots(1024 * GIB), MAX_SLOTS);
  assert.equal(suggestedSlots(null), FALLBACK_SLOTS);
  assert.equal(FALLBACK_SLOTS, 3);
});

test('N override: { slots } is a whole number 1-50, or null for the suggested one; anything else is refused with night_queue', () => {
  assert.equal(parseQueueSettings({ slots: 1 }), 1);
  assert.equal(parseQueueSettings({ slots: 50 }), 50);
  assert.equal(parseQueueSettings({ slots: null }), null);
  for (const body of [{ slots: 0 }, { slots: 51 }, { slots: 2.5 }, { slots: '3' }, { slots: true }, {}, { slots: 3, extra: 1 }, [], null, 'x']) {
    assert.throws(() => parseQueueSettings(body), (error: unknown) => error instanceof QueueError && error.code === 'night_queue' && /1-50|1 to 50/.test(error.message), JSON.stringify(body));
  }
});

test('the cap holds: with N agents working, a note for a finished agent waits in the queue and nothing reaches it', async () => {
  const s = await setup({ slots: 2 });
  try {
    s.agent('a', 'working');
    s.agent('b', 'working');
    const c = s.agent('c', 'finished');
    const d = s.agent('d', 'finished');
    await s.note(c, 'Go on with C.');
    await s.note(d, 'Go on with D.');
    s.service.setActive(true);
    await s.service.noteDelivery;
    await sleep(40);
    assert.deepEqual(s.received(c), []);
    assert.deepEqual(s.received(d), []);
    const queue = s.queue()!;
    assert.deepEqual({ slots: queue.slots, working: queue.working, queued: queue.queued, memoryWait: queue.memoryWait }, { slots: 2, working: 2, queued: 2, memoryWait: false });
    assert.deepEqual(items(s), [[c, 'note'], [d, 'note']], 'first in, first out');
    assert.ok(queue.items.every((item) => Number.isFinite(Date.parse(item.since))));
    assert.equal((await s.store.pending()).length, 2, 'both notes still wait in the store');
  } finally {
    await s.cleanup();
  }
});

test('an agent that waits for the user or finishes its turn frees its slot, and the next one in the queue gets its note', async () => {
  const s = await setup({ slots: 2 });
  try {
    const a = s.agent('a', 'working');
    const b = s.agent('b', 'working');
    const c = s.agent('c', 'finished');
    const d = s.agent('d', 'finished');
    await s.note(c, 'Go on with C.');
    await s.note(d, 'Go on with D.');
    s.service.setActive(true);
    await s.service.noteDelivery;
    await until(() => s.queue()?.queued === 2);

    s.attention.set(a, 'waiting');
    await until(() => s.received(c).length === 1);
    assert.match(s.received(c)[0], /Go on with C\./);
    assert.deepEqual(s.received(d), [], 'one freed slot, one start');
    assert.deepEqual(items(s), [[d, 'note']]);
    assert.equal(s.queue()!.working, 2, 'C holds the freed slot until it reports');
    // The bridge reports C's turn starting: its own state holds the slot now.
    s.attention.set(c, 'working');
    await sleep(20);
    assert.deepEqual(s.received(d), []);

    s.attention.set(b, 'finished');
    await until(() => s.received(d).length === 1);
    assert.deepEqual(items(s), []);
    await until(async () => (await s.store.pending()).length === 0);
    const delivered = await s.store.list();
    assert.ok(delivered.every((note) => note.deliveredAt), 'both notes are delivered');
    assert.deepEqual(delivered.map((note) => note.deliveredTo), [[c], [d]]);
    assert.deepEqual(s.records.filter((record) => (record.kind as string) === 'note').map((record) => record.terminalId), [c, d], 'each note leaves its record, as before');
  } finally {
    await s.cleanup();
  }
});

test('below the reserve of free memory the next start waits, and starts once memory is back', async () => {
  const s = await setup({ slots: 5 });
  try {
    const c = s.agent('c', 'finished');
    await s.note(c, 'Go on with C.');
    s.memory.memAvailable = 1 * GIB;
    s.service.setActive(true);
    await s.service.noteDelivery;
    await until(() => s.queue()?.memoryWait === true);
    await sleep(50);
    assert.deepEqual(s.received(c), []);
    assert.deepEqual({ working: s.queue()!.working, queued: s.queue()!.queued }, { working: 0, queued: 1 });
    // Exactly the reserve (max(2 GiB, 15 % of 24 GiB)) is enough.
    s.memory.memAvailable = reserveFor({ reserveBytes: null }, 24 * GIB);
    await until(() => s.received(c).length === 1);
    assert.equal(s.queue()!.memoryWait, false);
    // An unreadable meminfo never blocks.
    const d = s.agent('d', 'finished');
    s.memory.memAvailable = null;
    await s.note(d, 'Go on with D.');
    await s.service.deliverNotesNow();
    await until(() => s.received(d).length === 1);
  } finally {
    await s.cleanup();
  }
});

test('turning the autopilot off keeps queued notes pending and drops queued follow-ups; nothing is sent while off', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working');
    const b = s.agent('b', 'finished');
    const c = s.agent('c', 'working');
    await s.note(b, 'Go on with B.');
    s.service.setActive(true);
    await s.service.noteDelivery;
    // C's turn ends: its automatic follow-up is due after the delay and joins the queue behind B.
    s.attention.set(c, 'finished');
    s.link.finish(c, '1000-1');
    await until(() => s.queue()?.queued === 2);
    assert.deepEqual(items(s), [[b, 'note'], [c, 'follow-up']]);
    assert.equal(s.followUps.length, 0, 'a queued follow-up asks the decider nothing');

    s.service.setActive(false);
    assert.equal(s.queue(), undefined, 'GET /api/night has no queue while off');
    assert.deepEqual(s.service.queueSummary()?.items, []);
    s.attention.set(a, 'finished');
    await sleep(DELAY * 3);
    assert.deepEqual(s.received(b), []);
    assert.equal(s.followUps.length, 0);
    const pending = await s.store.pending();
    assert.deepEqual(pending.map((note) => [note.terminalId, note.text, note.deliveredAt]), [[b, 'Go on with B.', undefined]], 'the note is not lost');

    // The next on gives B its note first (A finished: a slot is free).
    s.service.setActive(true);
    await until(() => s.received(b).length === 1);
  } finally {
    await s.cleanup();
  }
});

test('what the user does themselves is never queued: a delegated task, Delegar, a question, and typing drops a queued follow-up', async () => {
  const s = await setup({ slots: 1 });
  try {
    s.agent('a', 'working');
    const b = s.agent('b', 'working');
    const c = s.agent('c', 'working');
    s.service.setActive(true);
    // B finishes after the activation (no sweep), with no turn reported to the night link (no follow-up timer).
    s.attention.set(b, 'finished');
    assert.equal(s.queue()!.working, 2, 'full');

    // "Delegar a Mirador" to an open agent goes out at once.
    const sent = await s.service.sendNote(b, 'Ship N3.', '', taskText);
    assert.deepEqual([sent.sent, s.received(b).length], [true, 1]);
    // "Delegar" on a finished agent asks the decider at once.
    const delegated = s.service.delegate(b)!;
    await delegated.done;
    assert.equal(s.followUps.length, 1);
    // A question is decided at once.
    await s.service.question(b, 'q-1', { terminalId: b, toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: false, items: [{ question: 'Which runner?', header: 'Runner', options: [{ label: 'node:test', description: '' }, { label: 'vitest', description: '' }], multiSelect: false }] });
    assert.equal(s.decisions.length, 1);
    assert.deepEqual(items(s), []);

    // C's follow-up waits in the queue; the user typing in C removes it.
    s.attention.set(c, 'finished');
    s.link.finish(c, '1000-1');
    await until(() => s.queue()?.queued === 1);
    s.terminals.write(c, 'ok\r');
    assert.deepEqual(items(s), []);
  } finally {
    await s.cleanup();
  }
});

test('with free slots nothing changes: a note goes out at activation and a finished turn is followed up after its delay', async () => {
  const s = await setup({ slots: 3 });
  try {
    const a = s.agent('a', 'finished');
    const b = s.agent('b', 'working');
    await s.note(a, 'Go on with A.');
    s.service.setActive(true);
    await s.service.noteDelivery;
    assert.equal(s.received(a).length, 1);
    s.attention.set(a, 'working');
    s.attention.set(b, 'finished');
    s.link.finish(b, '1000-1');
    await until(() => s.records.some((record) => (record.kind as string) === 'auto-follow-up'));
    const record = s.records.find((entry) => (entry.kind as string) === 'auto-follow-up')!;
    assert.deepEqual([record.terminalId, record.outcome, record.sent], [b, 'followed-up', 'message']);
    assert.match(s.received(b)[0], /Proceed with option A/);
  } finally {
    await s.cleanup();
  }
});

test('orderings: two agents finishing at once start two, never the same one twice', async () => {
  const s = await setup({ slots: 2 });
  try {
    const a = s.agent('a', 'working');
    const b = s.agent('b', 'working');
    const queued = [s.agent('c', 'finished'), s.agent('d', 'finished'), s.agent('e', 'finished')];
    for (const id of queued) await s.note(id, `Go on with ${id}.`);
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 3);
    s.attention.set(a, 'finished');
    s.attention.set(b, 'finished');
    await until(() => s.received(queued[1]).length === 1);
    await sleep(40);
    assert.deepEqual(queued.map((id) => s.received(id).length), [1, 1, 0]);
    assert.deepEqual(items(s), [[queued[2], 'note']]);
  } finally {
    await s.cleanup();
  }
});

test('orderings: a note added while full joins the end; one terminal holds one entry with all its notes, in order', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working');
    const b = s.agent('b', 'finished');
    const c = s.agent('c', 'finished');
    await s.note(b, 'First for B.');
    s.service.setActive(true);
    // C waits in "finished" with no note: the activation sweep queues its follow-up.
    await until(() => s.queue()?.queued === 2);
    assert.deepEqual(items(s), [[b, 'note'], [c, 'follow-up']]);
    await s.note(c, 'For C.');
    await s.service.deliverNotesNow();
    assert.deepEqual(items(s), [[b, 'note'], [c, 'note']], "a note takes the place of the terminal's follow-up");
    await s.note(b, 'Second for B.');
    await s.service.deliverNotesNow();
    assert.deepEqual(items(s), [[b, 'note'], [c, 'note']]);
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 2);
    assert.match(s.received(b)[0], /First for B\./);
    assert.match(s.received(b)[1], /Second for B\./);
    assert.deepEqual(s.received(c), []);
  } finally {
    await s.cleanup();
  }
});

test('orderings: a workspace note reaches a working agent at once and the others through the queue, delivered once all got it', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working');
    const b = s.agent('b', 'finished');
    const c = s.agent('c', 'finished');
    const note = await s.note(undefined, 'Everyone: run the tests.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    assert.equal(s.received(a).length, 1, 'A holds a slot already: it gets the note now');
    assert.equal((await s.store.pending()).length, 1, 'still waiting for B and C');
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    s.attention.set(b, 'working');
    s.attention.set(b, 'finished');
    await until(() => s.received(c).length === 1);
    await until(async () => (await s.store.pending()).length === 0);
    const stored = (await s.store.list()).find((entry) => entry.id === note.id)!;
    assert.deepEqual(stored.deliveredTo, [a, b, c]);
    assert.equal(s.received(a).length, 1, 'never twice');
  } finally {
    await s.cleanup();
  }
});

test('orderings: an agent closed while queued leaves the queue, its note stays pending with the reason, the next one starts', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working');
    const b = s.agent('b', 'finished');
    const c = s.agent('c', 'finished');
    await s.note(b, 'For B.');
    await s.note(c, 'For C.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    s.terminals.close(b);
    s.service.disconnected(b);
    assert.deepEqual(items(s), [[c, 'note']]);
    await until(async () => (await s.store.pending()).find((note) => note.terminalId === b)?.pendingReason === 'the terminal is closed');
    s.attention.set(a, 'finished');
    await until(() => s.received(c).length === 1);
  } finally {
    await s.cleanup();
  }
});

test('orderings: N lowered while full starts nothing until fewer than N work', async () => {
  const s = await setup({ slots: 3 });
  try {
    const working = [s.agent('a', 'working'), s.agent('b', 'working'), s.agent('c', 'working')];
    const d = s.agent('d', 'finished');
    await s.note(d, 'For D.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 1);
    s.limits.slots = 1;
    s.service.queueChanged();
    s.attention.set(working[0], 'finished');
    s.attention.set(working[1], 'waiting');
    await sleep(40);
    assert.deepEqual(s.received(d), [], 'one agent still works and N is 1');
    assert.equal(s.queue()!.slots, 1);
    s.attention.set(working[2], 'finished');
    await until(() => s.received(d).length === 1);
  } finally {
    await s.cleanup();
  }
});

test('a start the agent never picks up frees its slot after the claim time', async () => {
  const claimMs = 60;
  const timers = holdTimers(claimMs);
  const s = await setup({ slots: 1, claimMs, setTimer: timers.setTimer });
  try {
    const b = s.agent('b', 'finished');
    const c = s.agent('c', 'finished');
    await s.note(b, 'For B.');
    await s.note(c, 'For C.');
    s.service.setActive(true);
    // Each of these stays true while B's claim is held: B got its note, its claim time is set, C waits.
    await until(() => s.received(b).length === 1);
    await until(() => timers.held() === 1);
    await until(() => s.queue()?.queued === 1);
    assert.deepEqual(items(s), [[c, 'note']]);
    assert.deepEqual(s.received(c), [], 'B holds the only slot');
    // B never reports a new turn: after the claim time its slot is free again, and C gets its note.
    let beforeClaimEnded: number | undefined;
    timers.run(() => (beforeClaimEnded = s.received(c).length));
    await until(() => s.received(c).length === 1);
    assert.equal(beforeClaimEnded, 0, 'C waited for the end of the claim time');
    assert.deepEqual(items(s), []);
  } finally {
    await s.cleanup();
  }
});
