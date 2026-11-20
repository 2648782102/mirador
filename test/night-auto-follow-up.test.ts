// At night, when an agent's turn ends, the night service follows it up by itself,
// reading the agent's whole final message. Fake decider, fake bridge link that reports
// finished turns, real terminal registry over fake ptys; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightService, type NightLink } from '../src/night/service.ts';
import type { FinishedTurn } from '../src/night/channel.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightContext, NightFollowUp } from '../src/night/protocol.ts';
import type { AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

const DELAY = 40;
const ASK = 'N4 is done.\n¿Avanzamos con A (recomendado) o B?';

function fakeLink() {
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const finals = new Map<string, FinishedTurn>();
  const listeners = new Set<(id: string, turn: FinishedTurn) => void>();
  const link: NightLink & { sent: typeof sent; connected: typeof connected; finish(id: string, turnId: string, text?: string): void } = {
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
    finish(id, turnId, text = ASK) {
      const turn = { turnId, text, time: Date.now() };
      finals.set(id, turn);
      for (const listener of listeners) listener(id, turn);
    },
  };
  return link;
}

interface Setup {
  followUp?: (c: NightContext, signal?: AbortSignal) => Promise<NightFollowUp>;
  maxAuto?: number;
}

function setup(options: Setup = {}) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const link = fakeLink();
  const records: NightRecord[] = [];
  const contexts: NightContext[] = [];
  const decider: Decider = {
    decide: async () => ({ action: 'defer', reason: 'not used' }),
    followUp: (context, signal) => {
      contexts.push(context);
      return (options.followUp ?? (async () => ({ action: 'follow-up', message: 'Proceed with option A, as you recommended.', reason: 'A is recommended and planned.', confidence: 0.9 })))(context, signal);
    },
  };
  let items: AttentionItem[] = [];
  const service = new NightService({
    link,
    decider,
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift.' } : undefined) },
    attention: () => ({ items: () => items }),
    decideBudgetMs: 2000,
    deliveryTimeoutMs: 50,
    autoDelayMs: DELAY,
    maxAutoPerNight: options.maxAuto,
  });
  const agent = () => {
    const info = terminals.create({ cwd: '/dev/alpha', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'alpha' });
    link.connected.add(info.id);
    return info.id;
  };
  const finishedItem = (terminalId: string): AttentionItem => ({
    terminalId, workspaceId: 'dev', rel: 'alpha', title: 'alpha', kind: 'finished', label: 'Finished', detail: null, since: new Date().toISOString(), activity: null,
  });
  /** The agent's turn ends: the inbox shows it finished and the bridge sends its final message. */
  const finish = (id: string, turnId: string, text = ASK) => {
    items = [...items.filter((item) => item.terminalId !== id), finishedItem(id)];
    link.finish(id, turnId, text);
  };
  /** The agent started again: it leaves the inbox. */
  const restart = (id: string) => {
    items = items.filter((item) => item.terminalId !== id);
  };
  return { service, link, records, contexts, terminals, agent, finish, restart };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(5);
  }
}
const messages = (s: ReturnType<typeof setup>) => s.link.sent.filter(([, line]) => line.type === 'message');

test('at night, a finished turn is followed up after the delay, with the whole final message in the context', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  const started = Date.now();
  s.finish(id, '1000-1');
  await sleep(DELAY / 2);
  assert.equal(s.contexts.length, 0, 'it waits for the delay first');
  await until(() => s.records.length === 1);
  assert.ok(Date.now() - started >= DELAY);
  assert.equal(s.contexts[0].lastMessage, ASK);
  const [to, line] = messages(s)[0];
  assert.equal(to, id);
  assert.match(line.type === 'message' ? line.text : '', /Proceed with option A, as you recommended\./);
  const record = s.records[0];
  assert.equal(record.kind, 'auto-follow-up');
  assert.equal(record.outcome, 'followed-up');
  assert.equal(record.sent, 'message');
});

test('while the night shift is off, a finished turn is never followed up and nothing is logged', async () => {
  const s = setup();
  const id = s.agent();
  s.finish(id, '1000-1');
  await sleep(DELAY * 3);
  assert.deepEqual(s.contexts, []);
  assert.deepEqual(s.link.sent, []);
  assert.deepEqual(s.records, []);

  // Turning it off during the delay cancels the follow-up as well.
  s.service.setActive(true);
  s.finish(id, '1000-2');
  s.service.setActive(false);
  await sleep(DELAY * 3);
  assert.deepEqual(s.contexts, []);
});

test('no follow-up when the agent started again or the user typed in that terminal during the delay', async () => {
  const s = setup();
  const restarted = s.agent();
  const typed = s.agent();
  s.service.setActive(true);
  s.finish(restarted, '1-1');
  s.finish(typed, '2-1');
  s.restart(restarted);
  s.terminals.write(typed, 'a');
  await sleep(DELAY * 3);
  assert.deepEqual(s.contexts, []);
  assert.deepEqual(s.link.sent, []);
  assert.deepEqual(s.records, []);
});

test('the automatic terminal replies of the terminal are not the user typing', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  s.finish(id, '1-1');
  s.terminals.write(id, '\x1b[I');
  await until(() => s.records.length === 1);
  assert.equal(s.records[0].outcome, 'followed-up');
});

test('a new turn during the delay replaces the old one: only the latest turn is followed up', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  s.finish(id, '1-1', 'First turn: A or B?');
  await sleep(DELAY / 2);
  s.finish(id, '1-2', 'Second turn: C (recommended) or D?');
  await until(() => s.records.length === 1);
  await sleep(DELAY * 2);
  assert.equal(s.contexts.length, 1);
  assert.equal(s.contexts[0].lastMessage, 'Second turn: C (recommended) or D?');
});

test('a follow-up whose turn is no longer the latest when the decider answers is dropped, not sent', async () => {
  let release!: (value: NightFollowUp) => void;
  const s = setup({ followUp: () => new Promise((resolve) => { release = resolve; }) });
  const id = s.agent();
  s.service.setActive(true);
  s.finish(id, '1-1');
  await until(() => s.contexts.length === 1);
  s.finish(id, '1-2', 'A newer turn.');
  release({ action: 'follow-up', message: 'Proceed with option A.', reason: 'r', confidence: 0.9 });
  await until(() => s.records.length === 1);
  assert.deepEqual(messages(s), []);
  assert.equal(s.records[0].outcome, 'dropped');
  assert.equal(s.records[0].deferral?.rule, 'stale');
  assert.deepEqual(s.service.status().pending, [], 'a stale turn is not left for the user');
});

test('at most maxAutoPerNight automatic follow-ups per terminal per night; hitting the cap is logged once', async () => {
  const s = setup({ maxAuto: 2 });
  const id = s.agent();
  s.service.setActive(true);
  assert.equal(s.service.status().source, 'manual', 'on by hand: no Claude call cap (D2), but this cap holds');
  for (let turn = 1; turn <= 4; turn++) {
    s.finish(id, `1-${turn}`);
    await until(() => s.records.length >= Math.min(turn, 3));
    await sleep(DELAY * 2);
  }
  assert.equal(s.contexts.length, 2);
  assert.equal(messages(s).length, 2);
  const capped = s.records.filter((record) => record.deferral?.rule === 'auto-cap');
  assert.equal(capped.length, 1);
  assert.equal(capped[0].kind, 'auto-follow-up');
  assert.equal(capped[0].outcome, 'deferred');
  assert.match(capped[0].deferral!.reason, /2 automatic follow-ups/);
  assert.equal(s.service.status().pending.length, 1, 'the cap is reported to the user');

  // A new night starts a new count; the schedule's on keeps the same cap.
  s.service.setActive(false);
  s.service.setActive(true, { source: 'schedule' });
  s.finish(id, '1-5');
  await until(() => s.contexts.length === 3);
});

test('after 2 consecutive deferrals the terminal is left alone until the user types in it or the night restarts', async () => {
  const s = setup({ followUp: async () => ({ action: 'defer', reason: 'The mission does not cover B.' }) });
  const id = s.agent();
  s.service.setActive(true);
  for (let turn = 1; turn <= 3; turn++) {
    s.finish(id, `1-${turn}`);
    await sleep(DELAY * 3);
  }
  assert.equal(s.contexts.length, 2, 'the third turn is not asked about');
  assert.deepEqual(s.records.map((r) => r.deferral?.rule), ['decider', 'decider']);

  // The user types in the terminal: the turns after it may be followed up again, and the streak counts anew.
  s.terminals.write(id, 'go on\r');
  for (let turn = 4; turn <= 6; turn++) {
    s.finish(id, `1-${turn}`);
    await sleep(DELAY * 3);
  }
  assert.equal(s.contexts.length, 4);

  // A restarted night (off, then on) clears the streak.
  s.service.setActive(false);
  s.service.setActive(true);
  s.finish(id, '1-7');
  await until(() => s.contexts.length === 5);
});

test('a final message whose closing question is sensitive is left for the user without asking the decider', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  s.finish(id, '1-1', 'Todo listo. ¿Hacemos push a main (recomendado) o esperamos?');
  await until(() => s.records.length === 1);
  assert.deepEqual(s.contexts, []);
  assert.deepEqual(s.link.sent, []);
  assert.equal(s.records[0].outcome, 'deferred');
  assert.equal(s.records[0].deferral?.rule, 'sensitive:production');
  assert.equal(s.service.status().pending.length, 1);
});

test('a disconnected bridge cancels the pending automatic follow-up', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  s.finish(id, '1-1');
  s.link.connected.delete(id);
  s.service.disconnected(id);
  await sleep(DELAY * 3);
  assert.deepEqual(s.contexts, []);
  assert.deepEqual(s.records, []);
});
