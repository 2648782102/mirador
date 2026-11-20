// What the autopilot leaves for the user shows one
// automatic follow-up card per agent, the latest, and typing in that agent's terminal
// clears them; pending questions and the night log stay as they were. Fake decider, fake
// bridge link that reports finished turns, real terminal registry over fake ptys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightService, type NightLink } from '../src/night/service.ts';
import type { FinishedTurn } from '../src/night/channel.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightContext, NightFollowUp, NightQuestion } from '../src/night/protocol.ts';
import type { AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

const DELAY = 30;
const ASK = 'N4 is done.\n¿Avanzamos con A (recomendado) o B?';
const DEFER = async (): Promise<NightFollowUp> => ({ action: 'defer', reason: 'The mission does not cover B.' });

function fakeLink() {
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const finals = new Map<string, FinishedTurn>();
  const listeners = new Set<(id: string, turn: FinishedTurn) => void>();
  const link: NightLink & { connected: typeof connected; finish(id: string, turnId: string, text?: string): void } = {
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

function setup(followUp: (c: NightContext, signal?: AbortSignal) => Promise<NightFollowUp> = DEFER) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const link = fakeLink();
  const records: NightRecord[] = [];
  const contexts: NightContext[] = [];
  const decider: Decider = {
    decide: async () => ({ action: 'defer', reason: 'not used' }),
    followUp: (context, signal) => {
      contexts.push(context);
      return followUp(context, signal);
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
  });
  const agent = (rel: string) => {
    const info = terminals.create({ cwd: `/dev/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel });
    link.connected.add(info.id);
    return info.id;
  };
  /** The agent's turn ends: the inbox shows it finished and the bridge sends its final message. */
  const finish = (id: string, turnId: string, text = ASK) => {
    items = [
      ...items.filter((item) => item.terminalId !== id),
      { terminalId: id, workspaceId: 'dev', rel: 'alpha', title: 'alpha', kind: 'finished', label: 'Finished', detail: null, since: new Date().toISOString(), activity: null },
    ];
    link.finish(id, turnId, text);
  };
  const ask = (id: string, text: string) => {
    const question: NightQuestion = {
      terminalId: id, toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: false,
      items: [{ question: text, header: '', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }],
    };
    return service.question(id, 'r1', question);
  };
  const pending = () => service.status().pending;
  return { service, link, records, contexts, terminals, agent, finish, ask, pending };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(5);
  }
}

test("a new automatic follow-up card of an agent replaces its previous one; another agent keeps its own", async () => {
  const s = setup();
  const alpha = s.agent('alpha');
  const beta = s.agent('beta');
  s.service.setActive(true);
  s.finish(alpha, '1-1');
  await until(() => s.records.length === 1);
  s.finish(alpha, '1-2');
  await until(() => s.records.length === 2);
  s.finish(beta, '2-1');
  await until(() => s.records.length === 3);

  const cards = s.pending();
  assert.deepEqual(
    cards.map((item) => [item.terminalId, item.id]),
    [[alpha, s.records[1].id], [beta, s.records[2].id]],
    'one card per agent: the latest of alpha, and beta',
  );
  assert.equal(s.service.reminder().pending.length, 2, 'the bedtime reminder lists the same cards');
});

test("typing in an agent's terminal clears its automatic follow-up cards, not its pending questions nor other agents' cards", async () => {
  const s = setup();
  const alpha = s.agent('alpha');
  const beta = s.agent('beta');
  s.service.setActive(true);
  s.finish(alpha, '1-1');
  s.finish(beta, '2-1');
  await until(() => s.records.length === 2);
  await s.ask(alpha, 'Deploy to production now?');
  assert.equal(s.pending().length, 3);
  const question = s.pending().find((item) => item.kind === 'question')!;
  assert.equal(question.terminalId, alpha);

  s.terminals.write(alpha, 'go on\r');
  assert.deepEqual(
    s.pending().map((item) => [item.terminalId, item.kind]),
    [[beta, 'auto-follow-up'], [alpha, 'question']],
  );
  assert.equal(s.pending().find((item) => item.kind === 'question')!.id, question.id);

  // A terminal reply (focus report) is not the user typing: beta keeps its card.
  s.terminals.write(beta, '\x1b[I');
  assert.equal(s.pending().filter((item) => item.terminalId === beta).length, 1);
});

test('a deferral that ends after the user typed into its turn is not listed, whichever way the flow ends', async () => {
  // The decider defers after the typing.
  {
    let release!: (value: NightFollowUp) => void;
    const s = setup(() => new Promise((resolve) => { release = resolve; }));
    const id = s.agent('alpha');
    s.service.setActive(true);
    s.finish(id, '1-1');
    await until(() => s.contexts.length === 1);
    s.terminals.write(id, 'wait, I am here\r');
    release({ action: 'defer', reason: 'The mission does not cover B.' });
    await until(() => s.records.length === 1);
    assert.deepEqual(s.pending(), []);
  }
  // The bridge drops while the decider runs, after the typing.
  {
    const s = setup((_context, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const id = s.agent('alpha');
    s.service.setActive(true);
    s.finish(id, '1-1');
    await until(() => s.contexts.length === 1);
    s.terminals.write(id, 'wait, I am here\r');
    s.service.disconnected(id);
    await until(() => s.records.length === 1);
    assert.equal(s.records[0].outcome, 'dropped');
    assert.deepEqual(s.pending(), []);
  }
});

test('the night log keeps every record while the pending list shows one card per agent', async () => {
  const s = setup();
  const id = s.agent('alpha');
  s.service.setActive(true);
  s.finish(id, '1-1');
  await until(() => s.records.length === 1);
  s.finish(id, '1-2');
  await until(() => s.records.length === 2);
  s.terminals.write(id, 'go on\r');
  await sleep(DELAY * 2);

  assert.deepEqual(s.pending(), []);
  assert.deepEqual(
    s.records.map((record) => [record.kind, record.outcome, record.deferral?.rule]),
    [['auto-follow-up', 'deferred', 'decider'], ['auto-follow-up', 'deferred', 'decider']],
  );
  assert.notEqual(s.records[0].id, s.records[1].id);
});
