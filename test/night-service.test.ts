// The night service: policy, context, decider and answer for each question, and
// follow-ups for finished agents. Fake decider, fake bridge link, real terminal registry
// over fake ptys; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightService, nightAttention, provideNightAttention, type NightLink } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightContext, NightDecision, NightFollowUp, NightQuestion } from '../src/night/protocol.ts';
import type { AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  data: Array<(d: string) => void> = [];
  onData(listener: (d: string) => void) { this.data.push(listener); }
  onExit() {}
  write() {}
  resize() {}
  kill() {}
  emit(d: string) { this.data.forEach((l) => l(d)); }
}

function registry() {
  const ptys: FakePty[] = [];
  const spawn: SpawnFn = () => { const p = new FakePty(); ptys.push(p); return p; };
  const terminals = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  return { terminals, ptys };
}

function fakeLink(): NightLink & { sent: Array<[string, MiradorLine]>; connected: Set<string> } {
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  return {
    sent,
    connected,
    send: (id, line) => (connected.has(id) ? (sent.push([id, line]), true) : false),
    isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected],
  };
}

const question = (labels = ['Grid', 'List'], text = 'Which layout should the report use?'): NightQuestion => ({
  terminalId: '', toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: false,
  items: [{ question: text, header: '', multiSelect: false, options: labels.map((label) => ({ label, description: `${label} view` })) }],
});

interface Setup {
  decide?: (q: NightQuestion, c: NightContext, signal?: AbortSignal) => Promise<NightDecision>;
  followUp?: (c: NightContext, signal?: AbortSignal) => Promise<NightFollowUp>;
  items?: AttentionItem[] | null;
  budgetMs?: number;
  deliveryMs?: number;
}

function setup(options: Setup = {}) {
  const { terminals, ptys } = registry();
  const link = fakeLink();
  const records: NightRecord[] = [];
  const calls: Array<{ kind: string; context: NightContext; signal?: AbortSignal }> = [];
  const decider: Decider = {
    decide: (q, context, signal) => {
      calls.push({ kind: 'decide', context, signal });
      return (options.decide ?? (async () => ({ action: 'answer', choices: [1], reason: 'The mission prefers lists.', confidence: 0.9 })))(q, context, signal);
    },
    followUp: (context, signal) => {
      calls.push({ kind: 'followUp', context, signal });
      return (options.followUp ?? (async () => ({ action: 'follow-up', message: 'Run the tests and fix what fails.', reason: 'Tests were not run.', confidence: 0.8 })))(context, signal);
    },
  };
  const workspaces = { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift. Prefer lists.' } : undefined) };
  let items = options.items === undefined ? [] : options.items;
  const service = new NightService({
    link,
    decider,
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces,
    attention: () => (items === null ? null : { items: () => items! }),
    decideBudgetMs: options.budgetMs ?? 2000,
    deliveryTimeoutMs: options.deliveryMs ?? 2000,
  });
  const agent = (rel = 'alpha') => {
    const info = terminals.create({ cwd: `/dev/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel });
    link.connected.add(info.id);
    return info.id;
  };
  const ask = async (id: string, q = question(), requestId = 'r1') => service.question(id, requestId, { ...q, terminalId: id });
  return { service, link, records, calls, terminals, ptys, agent, ask, setItems: (next: AttentionItem[] | null) => { items = next; } };
}

const finished = (terminalId: string, kind: AttentionItem['kind'] = 'finished'): AttentionItem => ({
  terminalId, workspaceId: 'dev', rel: 'alpha', title: 'alpha', kind, label: 'Finished', detail: null, since: new Date().toISOString(), activity: '◐ Write the night service',
});

test('registry.tail gives the newest output as plain text: no escape sequences, capped in bytes', () => {
  const { terminals, ptys } = registry();
  const id = terminals.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' }).id;
  ptys[0].emit('\x1b[1;32mgreen\x1b[0m line\r\n\x1b]0;title\x07next\x1b[?25l line\r\n\u0007bell\ttab ñ\r\n');
  assert.equal(terminals.tail(id, 8192), 'green line\nnext line\nbell\ttab ñ\n');
  assert.equal(terminals.tail(id, 6), 'tab ñ\n'.slice(-5), 'the newest bytes, never half a character');
  assert.equal(terminals.tail('nope', 100), undefined);
});

test('while the night shift is off, every question is passed at once and nothing is logged', async () => {
  const s = setup();
  const id = s.agent();
  await s.ask(id);
  assert.deepEqual(s.link.sent, [[id, { type: 'pass', requestId: 'r1' }]]);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.records, []);
  assert.equal(s.service.status().active, false);
});

test('an allowed question is decided: the reason says the user is away, names the autopilot, the mission, the labels and why (D4)', async () => {
  const s = setup({ items: [] });
  const id = s.agent();
  s.setItems([{ ...finished(id), kind: 'blocked' }]);
  s.ptys[0].emit('\x1b[2mcompiling\x1b[0m done\r\n');
  s.service.setActive(true);
  await s.ask(id);

  const [call] = s.calls;
  assert.equal(call.kind, 'decide');
  assert.deepEqual(call.context, {
    workspaceId: 'dev', workspaceName: 'Dev', rel: 'alpha', cwd: '/dev/alpha', mission: 'Ship the night shift. Prefer lists.',
    activity: '◐ Write the night service', recentOutput: 'compiling done\n',
  });
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(s.link.sent.length, 1);
  const [to, line] = s.link.sent[0];
  assert.equal(to, id);
  assert.equal(line.type, 'decided');
  const reason = line.type === 'decided' ? line.reason : '';
  assert.equal(line.type === 'decided' && line.requestId, 'r1');
  assert.ok(!/asleep|tonight/i.test(reason), `no sleep wording: ${reason}`);
  for (const part of ['The user is away from the keyboard', "Mirador's autopilot", 'mission', 'Dev', '"List"', 'The mission prefers lists.', 'Continue with this choice', 'sensitive', 'pending for the user']) {
    assert.ok(reason.includes(part), `reason has ${part}: ${reason}`);
  }
  assert.ok(!reason.includes('"Grid"'), 'only the chosen label');

  assert.equal(s.records.length, 1);
  const record = s.records[0];
  assert.equal(record.outcome, 'decided');
  assert.equal(record.sent, 'decided');
  assert.deepEqual(record.policy, { allowed: true });
  assert.deepEqual(record.decision?.choices, [{ item: 0, index: 1, label: 'List' }]);
  assert.equal(record.decision?.confidence, 0.9);
  assert.deepEqual(record.question?.items[0].options, ['Grid', 'List']);
  assert.deepEqual(s.service.status().pending, [], 'a decided question is not pending');
});

test('a questionnaire answer names each chosen label', async () => {
  const s = setup({ decide: async () => ({ action: 'answer', choices: [0, 1], reason: 'Both follow the mission.', confidence: 0.75 }) });
  const id = s.agent();
  s.service.setActive(true);
  const q: NightQuestion = {
    terminalId: id, toolCallId: 'c', tool: 'ask_user_question', allowCustomResponse: false,
    items: [
      { question: 'Name the helper?', header: 'Naming', multiSelect: false, options: [{ label: 'parseLine', description: '' }, { label: 'readLine', description: '' }] },
      { question: 'Add tests now?', header: 'Tests', multiSelect: false, options: [{ label: 'Later', description: '' }, { label: 'Now', description: '' }] },
    ],
  };
  await s.ask(id, q);
  const line = s.link.sent[0][1];
  assert.equal(line.type, 'decided');
  const reason = line.type === 'decided' ? line.reason : '';
  assert.match(reason, /Naming: "parseLine"/);
  assert.match(reason, /Tests: "Now"/);
});

test('a question the policy defers never reaches the decider: pass, logged with its rule, pending', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  await s.ask(id, question(['Yes', 'No'], 'Deploy to production now?'));
  assert.deepEqual(s.link.sent, [[id, { type: 'pass', requestId: 'r1' }]]);
  assert.deepEqual(s.calls, []);
  assert.equal(s.records[0].outcome, 'deferred');
  assert.deepEqual(s.records[0].policy, { allowed: false, rule: 'sensitive:production', reason: s.records[0].policy.reason });
  const [pending] = s.service.status().pending;
  assert.equal(pending.id, s.records[0].id);
  assert.equal(pending.rule, 'sensitive:production');
  assert.equal(pending.summary, 'Deploy to production now?');
});

test('low confidence, an invalid answer, a decider deferral or failure all pass and are logged as deferrals', async () => {
  const outcomes: Array<[string, Setup['decide'], string]> = [
    ['low confidence', async () => ({ action: 'answer', choices: [0], reason: 'Unsure.', confidence: 0.5 }), 'low-confidence'],
    ['out of range', async () => ({ action: 'answer', choices: [2], reason: 'x', confidence: 0.9 }), 'invalid-decision'],
    ['wrong count', async () => ({ action: 'answer', choices: [0, 1], reason: 'x', confidence: 0.9 }), 'invalid-decision'],
    ['NaN confidence', async () => ({ action: 'answer', choices: [0], reason: 'x', confidence: Number.NaN }), 'invalid-decision'],
    ['defer', async () => ({ action: 'defer', reason: 'The mission says nothing about layouts.' }), 'decider'],
    ['throws', async () => { throw new Error('model down'); }, 'error'],
    ['garbage', async () => 'yes' as unknown as NightDecision, 'invalid-decision'],
  ];
  for (const [name, decide, rule] of outcomes) {
    const s = setup({ decide });
    const id = s.agent();
    s.service.setActive(true);
    await s.ask(id);
    assert.deepEqual(s.link.sent, [[id, { type: 'pass', requestId: 'r1' }]], name);
    assert.equal(s.records[0].outcome, 'deferred', name);
    assert.equal(s.records[0].deferral?.rule, rule, name);
    assert.equal(s.service.status().pending.length, 1, name);
  }
});

test('a decider that runs past its budget is aborted and the question passes', async () => {
  let seen: AbortSignal | undefined;
  const s = setup({ budgetMs: 50, decide: (_q, _c, signal) => { seen = signal; return new Promise(() => {}); } });
  const id = s.agent();
  s.service.setActive(true);
  const started = Date.now();
  await s.ask(id);
  assert.ok(Date.now() - started < 1000);
  assert.equal(seen?.aborted, true);
  assert.deepEqual(s.link.sent, [[id, { type: 'pass', requestId: 'r1' }]]);
  assert.equal(s.records[0].deferral?.rule, 'timeout');
});

test('a question whose bridge disconnects while deciding is dropped: nothing is sent', async () => {
  let release!: (d: NightDecision) => void;
  let seen: AbortSignal | undefined;
  const s = setup({ decide: (_q, _c, signal) => { seen = signal; return new Promise((resolve) => { release = resolve; }); } });
  const id = s.agent();
  s.service.setActive(true);
  const asked = s.ask(id);
  await new Promise((resolve) => setImmediate(resolve));
  s.link.connected.delete(id);
  s.service.disconnected(id);
  release({ action: 'answer', choices: [0], reason: 'late', confidence: 0.9 });
  await asked;
  assert.equal(seen?.aborted, true);
  assert.deepEqual(s.link.sent, []);
  assert.equal(s.records[0].outcome, 'dropped');
  assert.equal(s.records[0].sent, 'none');
});

test('one question at a time per terminal; turning the night shift off passes the one in flight', async () => {
  const s = setup({ decide: (_q, _c, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) });
  const id = s.agent();
  s.service.setActive(true);
  const first = s.ask(id, question(), 'r1');
  await new Promise((resolve) => setImmediate(resolve));
  await s.ask(id, question(), 'r2');
  assert.deepEqual(s.link.sent, [[id, { type: 'pass', requestId: 'r2' }]], 'the second passes at once');
  s.service.setActive(false);
  await first;
  assert.deepEqual(s.link.sent.at(-1), [id, { type: 'pass', requestId: 'r1' }]);
  assert.deepEqual(s.records.map((r) => r.deferral?.rule).sort(), ['busy', 'stopped']);
});

test('turning the night shift on starts a new pending list', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  await s.ask(id, question(['Yes', 'No'], 'Delete the cache?'));
  assert.equal(s.service.status().pending.length, 1);
  s.service.setActive(false);
  s.service.setActive(true);
  const status = s.service.status();
  assert.deepEqual(status.pending, []);
  assert.equal(status.active, true);
  assert.deepEqual(status.connectedTerminals, [id]);
  assert.equal(typeof status.since, 'string');
});

test('delegating a finished agent sends the decider\'s follow-up and records its delivery', async () => {
  const s = setup();
  const id = s.agent();
  s.setItems([finished(id)]);
  const started = s.service.delegate(id);
  assert.ok(started);
  await new Promise((resolve) => setImmediate(resolve));
  const [to, line] = s.link.sent[0];
  assert.equal(to, id);
  assert.equal(line.type, 'message');
  assert.equal(line.type === 'message' && line.messageId, started.id);
  const text = line.type === 'message' ? line.text : '';
  assert.match(text, /^Follow-up from Mirador on the user's behalf, following the mission of workspace "Dev":\n\nRun the tests and fix what fails\.\n\n/);
  assert.match(text, /pending for the user/);
  s.service.delivered(id, started.id);
  const record = await started.done;
  assert.equal(record.id, started.id);
  assert.equal(record.kind, 'delegate');
  assert.equal(record.outcome, 'followed-up');
  assert.equal(record.sent, 'message');
  assert.equal(record.delivered, true);
  assert.equal(record.followUp?.message, 'Run the tests and fix what fails.');
  assert.equal(s.calls[0].kind, 'followUp');
  assert.equal(s.calls[0].context.activity, '◐ Write the night service');
});

test('a delegation sends nothing unless the agent finished, is connected and the follow-up is confident and not sensitive', async () => {
  const cases: Array<[string, (s: ReturnType<typeof setup>, id: string) => void, Setup, string]> = [
    ['waiting for an answer', (s, id) => s.setItems([finished(id, 'blocked')]), {}, 'not-finished'],
    ['not in the inbox', (s) => s.setItems([]), {}, 'not-finished'],
    ['attention unreachable', (s) => s.setItems(null), {}, 'no-attention'],
    ['bridge not connected', (s, id) => { s.setItems([finished(id)]); s.link.connected.delete(id); }, {}, 'not-connected'],
    ['low confidence', (s, id) => s.setItems([finished(id)]), { followUp: async () => ({ action: 'follow-up', message: 'Go on.', reason: 'x', confidence: 0.3 }) }, 'low-confidence'],
    ['sensitive', (s, id) => s.setItems([finished(id)]), { followUp: async () => ({ action: 'follow-up', message: 'Now push the release tag.', reason: 'x', confidence: 0.9 }) }, 'sensitive:production'],
    ['decider defers', (s, id) => s.setItems([finished(id)]), { followUp: async () => ({ action: 'defer', reason: 'Needs the user.' }) }, 'decider'],
    ['empty message', (s, id) => s.setItems([finished(id)]), { followUp: async () => ({ action: 'follow-up', message: '  ', reason: 'x', confidence: 0.9 }) }, 'invalid-decision'],
  ];
  for (const [name, arrange, options, rule] of cases) {
    const s = setup(options);
    const id = s.agent();
    arrange(s, id);
    const started = s.service.delegate(id);
    const record = await started!.done;
    assert.deepEqual(s.link.sent, [], name);
    assert.equal(record.outcome, 'deferred', name);
    assert.equal(record.deferral?.rule, rule, name);
  }

  const s = setup();
  const shell = s.terminals.create({ cwd: '/dev', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' }).id;
  s.setItems([finished(shell)]);
  const record = await s.service.delegate(shell)!.done;
  assert.equal(record.deferral?.rule, 'terminal');
  assert.deepEqual(s.calls, [], 'a shell never reaches the decider');
  assert.equal(s.service.delegate('no-such-terminal'), null);
});

test('a follow-up the bridge never confirms is recorded as undelivered', async () => {
  const s = setup({ deliveryMs: 50 });
  const id = s.agent();
  s.setItems([finished(id)]);
  const record = await s.service.delegate(id)!.done;
  assert.equal(record.sent, 'message');
  assert.equal(record.delivered, false);
});

test('the attention store is provided per app, so tests and apps never share one', () => {
  const appA = {};
  const appB = {};
  const view = { items: () => [] };
  assert.equal(nightAttention(appA), null);
  provideNightAttention(appA, view);
  assert.equal(nightAttention(appA), view);
  assert.equal(nightAttention(appB), null);
});

test('a manual delegation passes the agent\'s last final message to the decider when the bridge sent one', async () => {
  const s = setup();
  const id = s.agent();
  s.setItems([finished(id)]);
  const link = s.link as typeof s.link & { lastFinished?: (id: string) => { turnId: string; text: string; time: number } | null };
  await s.service.delegate(id)!.done;
  assert.equal('lastMessage' in s.calls[0].context, false, 'unknown: no lastMessage');
  link.lastFinished = (terminalId) => (terminalId === id ? { turnId: '1-1', text: 'Done. A (recommended) or B?', time: Date.now() } : null);
  await s.service.delegate(id)!.done;
  assert.equal(s.calls[1].context.lastMessage, 'Done. A (recommended) or B?');
  // A question mid-turn is not about the previous turn's final message.
  s.service.setActive(true);
  await s.ask(id);
  assert.equal('lastMessage' in s.calls[2].context, false);
});

test('a manual delegation whose agent started again before the decider answered is dropped, not sent', async () => {
  let release!: (value: NightFollowUp) => void;
  const s = setup({ followUp: () => new Promise((resolve) => { release = resolve; }) });
  const id = s.agent();
  s.setItems([finished(id)]);
  const started = s.service.delegate(id)!;
  await new Promise((resolve) => setImmediate(resolve));
  s.setItems([]);
  release({ action: 'follow-up', message: 'Run the tests.', reason: 'r', confidence: 0.9 });
  const record = await started.done;
  assert.deepEqual(s.link.sent, []);
  assert.equal(record.outcome, 'dropped');
  assert.equal(record.deferral?.rule, 'stale');
});

test('onActiveChange hears every effective change of active, never no-op sets, and survives a throwing listener', () => {
  const s = setup();
  const heard: Array<[boolean, string | null]> = [];
  s.service.onActiveChange(() => { throw new Error('a broken listener'); });
  const stop = s.service.onActiveChange((active, since) => heard.push([active, since]));
  s.service.setActive(false);
  assert.deepEqual(heard, [], 'off → off is a no-op');
  const status = s.service.setActive(true);
  assert.equal(status.active, true);
  s.service.setActive(true);
  s.service.setActive(false);
  assert.equal(heard.length, 2);
  assert.deepEqual(heard[0], [true, status.since]);
  assert.equal(heard[1][0], false);
  assert.equal(heard[1][1], s.service.status().since);
  stop();
  s.service.setActive(true);
  assert.equal(heard.length, 2, 'an unsubscribed listener hears nothing');
  s.service.close();
  assert.equal(s.service.active, false);
});

/* ---------- Execution notes, the sweep at activation, the bedtime reminder ---------- */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore } from '../src/night/notes.ts';
import { closingQuestion, nightService, provideNightService } from '../src/night/service.ts';
import type { FinishedTurn } from '../src/night/channel.ts';

const ASK = 'Panel done.\n\nNext I can wire the schedule. ¿Avanzamos con el horario (recomendado) o con las notas?';

/** A link that also reports finished turns, a note store in a temp folder, and two workspaces. */
async function nightSetup(options: { followUp?: (c: NightContext) => Promise<NightFollowUp>; sweepMs?: number } = {}) {
  const { terminals, ptys } = registry();
  const link = fakeLink() as ReturnType<typeof fakeLink> & Required<Pick<NightLink, 'lastFinished' | 'onFinished'>>;
  const finals = new Map<string, FinishedTurn>();
  const finishedListeners = new Set<(id: string, turn: FinishedTurn) => void>();
  link.lastFinished = (id) => finals.get(id) ?? null;
  link.onFinished = (listener) => {
    finishedListeners.add(listener);
    return () => finishedListeners.delete(listener);
  };
  const base = await mkdtemp(join(tmpdir(), 'mirador-night-n5-'));
  const notes = new NoteStore(join(base, 'night'));
  const records: NightRecord[] = [];
  const contexts: NightContext[] = [];
  let items: AttentionItem[] = [];
  const decider: Decider = {
    decide: async () => ({ action: 'defer', reason: 'not used' }),
    followUp: async (context) => {
      contexts.push(context);
      return (options.followUp ?? (async () => ({ action: 'follow-up', message: 'Proceed with the schedule, as you recommended.', reason: 'Recommended and in the mission.', confidence: 0.9 })))(context);
    },
  };
  const workspaces: Record<string, { id: string; name: string; root: string; folders: string[]; expanded: string[]; mission?: string }> = {
    dev: { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift.' },
    ops: { id: 'ops', name: 'Ops', root: '/ops', folders: [], expanded: [] },
  };
  const service = new NightService({
    link,
    decider,
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: (id: string) => workspaces[id] },
    attention: () => ({ items: () => items }),
    notes,
    decideBudgetMs: 2000,
    deliveryTimeoutMs: 50,
    autoDelayMs: 10_000,
    sweepIntervalMs: options.sweepMs ?? 5,
  });
  const open = (workspaceId: string, rel: string, kind: 'agent' | 'shell' = 'agent', connected = true) => {
    const info = terminals.create({ cwd: `/${workspaceId}/${rel}`, kind, cols: 80, rows: 24, workspaceId, rel });
    if (connected) link.connected.add(info.id);
    return info.id;
  };
  const item = (terminalId: string, kind: AttentionItem['kind'], activity: string | null = null): AttentionItem => {
    const info = terminals.get(terminalId)!;
    return { terminalId, workspaceId: info.workspaceId, rel: info.rel, title: info.rel, kind, label: kind === 'finished' ? 'Finished' : 'Needs you', detail: null, since: new Date().toISOString(), activity };
  };
  /** The turn ended: the inbox shows it finished and the bridge sent its final message. */
  const finish = (id: string, turnId: string, text: string | null = ASK) => {
    items = [...items.filter((entry) => entry.terminalId !== id), item(id, 'finished')];
    if (text === null) return;
    const turn = { turnId, text, time: Date.now() };
    finals.set(id, turn);
    for (const listener of finishedListeners) listener(id, turn);
  };
  return {
    service, link, notes, records, contexts, terminals, ptys, open, finish, item,
    setItems: (next: AttentionItem[]) => { items = next; },
    cleanup: () => { service.close(); return rm(base, { recursive: true, force: true }); },
  };
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleepMs(5);
  }
}
const noteLines = (s: { link: { sent: Array<[string, MiradorLine]> } }) => s.link.sent.filter(([, line]) => line.type === 'message' && line.text.startsWith('Execution note from the user'));

test('sendNote delivers the user’s note verbatim through the bridge message line and logs it as a note', async () => {
  const s = await nightSetup();
  try {
    const id = s.open('dev', 'alpha');
    const text = 'Tonight finish the tests.\nDo NOT push or deploy anything; leave it for me.';
    const sending = s.service.sendNote(id, text, 'note-1');
    const [[to, line]] = s.link.sent;
    assert.equal(to, id);
    assert.equal(line.type, 'message');
    assert.equal(line.type === 'message' && line.text, `Execution note from the user, who is away from the keyboard:\n\n${text}`, 'framed, otherwise untouched (no filter)');
    s.service.delivered(id, line.type === 'message' ? line.messageId : '');
    assert.deepEqual(await sending, { sent: true, delivered: true });
    const record = s.records[0] as NightRecord & { note?: { id: string; text: string } };
    assert.equal(record.kind as string, 'note');
    assert.equal(record.sent, 'message');
    assert.equal(record.outcome, 'followed-up');
    assert.equal(record.delivered, true);
    assert.deepEqual(record.note, { id: 'note-1', text });
    assert.equal(record.followUp, null, 'a note is the user’s, not a decider follow-up');

    s.link.connected.delete(id);
    assert.deepEqual(await s.service.sendNote(id, 'again', 'note-2'), { sent: false, delivered: false, reason: "the agent's bridge is not connected" });
    assert.equal(s.records[1].outcome, 'deferred');
    assert.equal(s.records[1].deferral?.rule, 'not-connected');
    assert.deepEqual(s.service.status().pending, [], 'notes never fill the night pending list');
  } finally {
    await s.cleanup();
  }
});

test('at night start each pending note is delivered once: terminal notes to it, workspace notes to every connected agent of the workspace', async () => {
  const s = await nightSetup();
  try {
    const alpha = s.open('dev', 'alpha');
    const beta = s.open('dev', 'beta');
    const offline = s.open('dev', 'gamma', 'agent', false);
    const shell = s.open('dev', 'alpha', 'shell');
    const other = s.open('ops', 'infra');
    const gone = s.open('dev', 'old');
    const forTerminal = await s.notes.add({ workspaceId: 'dev', terminalId: alpha, text: 'Alpha: finish N5.' });
    const forWorkspace = await s.notes.add({ workspaceId: 'dev', text: 'Everyone in Dev: run the tests before stopping.' });
    const forGone = await s.notes.add({ workspaceId: 'dev', terminalId: gone, text: 'Old: clean up.' });
    const forNobody = await s.notes.add({ workspaceId: 'ops', text: 'Ops: check the logs.' });
    s.link.connected.delete(other);
    s.terminals.close(gone);

    s.service.setActive(true);
    await s.service.noteDelivery;
    const sent = noteLines(s).map(([to, line]) => [to, line.type === 'message' ? line.text.split('\n\n')[1] : '']);
    assert.deepEqual(sent.sort(), [
      [alpha, 'Alpha: finish N5.'],
      [alpha, 'Everyone in Dev: run the tests before stopping.'],
      [beta, 'Everyone in Dev: run the tests before stopping.'],
    ].sort());
    assert.ok(!sent.some(([to]) => to === offline || to === shell || to === other), 'never a disconnected agent, a shell or another workspace');

    const notes = Object.fromEntries((await s.notes.list()).map((note) => [note.id, note]));
    assert.deepEqual(notes[forTerminal.id].deliveredTo, [alpha]);
    assert.deepEqual(notes[forWorkspace.id].deliveredTo?.sort(), [alpha, beta].sort());
    assert.equal(notes[forGone.id].deliveredAt, undefined);
    assert.equal(notes[forGone.id].pendingReason, 'the terminal is closed');
    assert.equal(notes[forNobody.id].pendingReason, 'no agent terminal of this workspace is connected');
    assert.equal(s.records.filter((record) => (record.kind as string) === 'note').length, 3, 'one log record per terminal reached');

    // Off and on again: nothing is sent twice.
    s.service.setActive(false);
    s.service.setActive(true);
    await s.service.noteDelivery;
    assert.equal(noteLines(s).length, 3);
  } finally {
    await s.cleanup();
  }
});

test('turning the night shift on sweeps agents that finished before: one follow-up flow each, staggered; a typed-in one is skipped', async () => {
  const s = await nightSetup({ sweepMs: 30 });
  try {
    const first = s.open('dev', 'alpha');
    const second = s.open('dev', 'beta');
    const typed = s.open('dev', 'gamma');
    const unknown = s.open('dev', 'delta');
    s.finish(first, '1-1');
    s.finish(second, '2-1');
    s.finish(typed, '3-1');
    s.finish(unknown, '4-1', null);
    s.terminals.write(typed, 'looking at it');
    await sleepMs(20);
    assert.equal(s.contexts.length, 0, 'nothing runs while the night shift is off');

    s.service.setActive(true);
    await waitUntil(() => s.records.length >= 3);
    await sleepMs(120);
    const auto = s.records.filter((record) => record.kind === 'auto-follow-up') as Array<NightRecord & { sweep?: boolean }>;
    assert.deepEqual(auto.filter((record) => record.outcome === 'followed-up').map((record) => record.terminalId).sort(), [first, second].sort(), 'exactly one follow-up each');
    assert.ok(auto.every((record) => record.sweep === true));
    assert.deepEqual(s.contexts.map((context) => context.lastMessage), [ASK, ASK], 'the decider reads the whole final message');
    assert.ok(!auto.some((record) => record.terminalId === typed), 'the user typed in it: left alone, not logged');
    const missing = auto.find((record) => record.terminalId === unknown);
    assert.equal(missing?.outcome, 'deferred');
    assert.equal(missing?.deferral?.rule, 'no-final-message');
    assert.ok(s.service.status().pending.some((item) => item.terminalId === unknown && item.rule === 'no-final-message'));
    const times = auto.filter((record) => record.outcome === 'followed-up').map((record) => Date.parse(record.time)).sort();
    assert.ok(times[1] - times[0] >= 25, 'one start every interval');

    // Turning it on again is a new sweep only for what finished again; the same turn is not swept twice.
    s.service.setActive(false);
    s.service.setActive(true);
    await sleepMs(150);
    assert.equal(s.records.filter((record) => record.kind === 'auto-follow-up' && record.outcome === 'followed-up').length, 2);
  } finally {
    await s.cleanup();
  }
});

test('the sweep skips an agent that just received an execution note, and stops when the night shift is turned off', async () => {
  const s = await nightSetup({ sweepMs: 300 });
  try {
    const noted = s.open('dev', 'alpha');
    const a = s.open('dev', 'beta');
    const b = s.open('dev', 'gamma');
    for (const [id, turn] of [[noted, '1-1'], [a, '2-1'], [b, '3-1']] as const) s.finish(id, turn);
    await s.notes.add({ workspaceId: 'dev', terminalId: noted, text: 'Start on the docs.' });
    s.service.setActive(true);
    await waitUntil(() => s.contexts.length === 1);
    s.service.setActive(false);
    await s.service.sweepDone;
    const auto = s.records.filter((record) => record.kind === 'auto-follow-up');
    assert.equal(auto.length, 1, 'the second start never came');
    assert.notEqual(auto[0].terminalId, noted);
  } finally {
    await s.cleanup();
  }
});

test('closingQuestion keeps the last line that asks something', () => {
  assert.equal(closingQuestion(ASK), 'Next I can wire the schedule. ¿Avanzamos con el horario (recomendado) o con las notas?');
  assert.equal(closingQuestion('All done. Tests pass.'), null);
  assert.equal(closingQuestion(''), null);
  assert.equal(closingQuestion(`${'x'.repeat(5000)}\nShall I go on?`), 'Shall I go on?');
});

test('reminder() lists running agents per workspace with their state, what they ask, the mission and what waits', async () => {
  const s = await nightSetup();
  try {
    const alpha = s.open('dev', 'alpha');
    const beta = s.open('dev', 'beta', 'agent', false);
    const infra = s.open('ops', 'infra');
    s.open('dev', 'alpha', 'shell');
    s.finish(alpha, '1-1');
    s.setItems([s.item(alpha, 'finished', '◐ Wire the schedule'), s.item(infra, 'blocked')]);
    const reminder = s.service.reminder();
    assert.equal(typeof reminder.time, 'string');
    assert.deepEqual(reminder.workspaces.map((w) => [w.workspaceId, w.name, w.hasMission, w.missionNote]), [
      ['dev', 'Dev', true, null],
      ['ops', 'Ops', false, 'This workspace has no mission: Mirador will defer everything there.'],
    ]);
    assert.deepEqual(reminder.workspaces[0].agents, [
      { terminalId: alpha, rel: 'alpha', title: s.terminals.get(alpha)!.title, state: 'finished', connected: true, activity: '◐ Wire the schedule', waitingFor: null, closingQuestion: 'Next I can wire the schedule. ¿Avanzamos con el horario (recomendado) o con las notas?', task: null },
      { terminalId: beta, rel: 'beta', title: s.terminals.get(beta)!.title, state: 'working', connected: false, activity: null, waitingFor: null, closingQuestion: null, task: null },
    ]);
    assert.equal(reminder.workspaces[1].agents[0].state, 'blocked');
    assert.equal(reminder.workspaces[1].agents[0].waitingFor, 'Needs you');
    assert.equal(reminder.waiting, 1, 'agents waiting for an answer now');
    assert.deepEqual(reminder.pending, []);
  } finally {
    await s.cleanup();
  }
});

test('the night service is provided per app', () => {
  const app = {};
  const s = setup();
  assert.equal(nightService(app), null);
  provideNightService(app, s.service);
  assert.equal(nightService(app), s.service);
  assert.equal(nightService({}), null);
});

test('a note written while the night shift is on goes out with deliverNotesNow; off, it waits', async () => {
  const s = await nightSetup();
  try {
    const id = s.open('dev', 'alpha');
    await s.notes.add({ workspaceId: 'dev', terminalId: id, text: 'Late note.' });
    await s.service.deliverNotesNow();
    assert.equal(noteLines(s).length, 0, 'the night shift is off: nothing goes out');
    s.service.setActive(true);
    await s.service.noteDelivery;
    await s.notes.add({ workspaceId: 'dev', terminalId: id, text: 'Another late note.' });
    await s.service.deliverNotesNow();
    assert.deepEqual(noteLines(s).map(([, line]) => (line.type === 'message' ? line.text.split('\n\n')[1] : '')), ['Late note.', 'Another late note.']);
  } finally {
    await s.cleanup();
  }
});

test('turning the night shift on while it is on changes nothing (same night, same since, no event)', async () => {
  const s = setup();
  const heard: boolean[] = [];
  s.service.onActiveChange((active) => heard.push(active));
  const first = s.service.setActive(true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const again = s.service.setActive(true);
  assert.equal(again.since, first.since, 'the night keeps its start, so its budget and caps are not reset');
  assert.deepEqual(heard, [true]);
  s.service.close();
});

test('closing the service at shutdown is not the end of the night: no on/off event, so no morning summary', () => {
  const s = setup();
  const heard: boolean[] = [];
  s.service.onActiveChange((active) => heard.push(active));
  s.service.setActive(true);
  s.service.close();
  assert.deepEqual(heard, [true], 'only the activation was heard');
  assert.equal(s.service.active, false);
});

/* ---------- A task delegated to an agent ---------- */

import { taskText } from '../src/night/service.ts';
import { sleepNote, sleepNoteText } from '../src/terminals/hibernate.ts';

const SLEEP_NOTE = sleepNote('the user');

const TASK = 'Finish the delegate dialog, then push to main and read the deploy token from .env.';

test('a delegated task reaches the decider as that agent’s task, for questions and follow-ups, next to the mission', async () => {
  const s = setup();
  const id = s.agent();
  const other = s.agent('beta');
  s.service.assignTask(id, TASK);
  s.service.setActive(true);
  await s.ask(id);
  await s.ask(other, question(), 'r2');
  assert.equal(s.calls[0].context.task, TASK);
  assert.equal(s.calls[0].context.mission, 'Ship the night shift. Prefer lists.');
  assert.equal('task' in s.calls[1].context, false, 'an agent without a task has none (as before)');
  s.setItems([finished(id)]);
  await s.service.delegate(id)!.done;
  assert.equal(s.calls[2].kind, 'followUp');
  assert.equal(s.calls[2].context.task, TASK);
  s.service.assignTask(id, 'Only run the focused tests.');
  await s.ask(id, question(), 'r3');
  assert.equal(s.calls[3].context.task, 'Only run the focused tests.', 'a newer instruction replaces the task');
  s.service.close();
});

test('a task asking for secrets, pushes or deletes never lets a sensitive question reach the decider', async () => {
  const s = setup();
  const id = s.agent();
  s.service.assignTask(id, TASK);
  s.service.setActive(true);
  for (const [n, labels, text] of [
    [1, ['Push to main', 'Wait'], 'The task says to push. Push now?'],
    [2, ['Read .env', 'Skip'], 'Read the deploy token from .env as the task asks?'],
    [3, ['Delete the branch', 'Keep it'], 'Delete the old branch?'],
  ] as const) {
    await s.ask(id, question([...labels], text), `s${n}`);
    assert.deepEqual(s.link.sent.at(-1), [id, { type: 'pass', requestId: `s${n}` }]);
    assert.match(s.records.at(-1)!.deferral!.rule, /^sensitive:/);
  }
  assert.deepEqual(s.calls, [], 'the decider was never asked');
  s.service.close();
});

test('the reminder lists each agent’s task, and a closed agent’s task is forgotten', async () => {
  const s = await nightSetup();
  try {
    const alpha = s.open('dev', 'alpha');
    const beta = s.open('dev', 'beta');
    s.service.assignTask(alpha, TASK);
    const agents = () => s.service.reminder().workspaces.flatMap((w) => w.agents.map((a) => [a.terminalId, a.task]));
    assert.deepEqual(agents(), [[alpha, TASK], [beta, null]]);
    s.terminals.close(alpha);
    s.service.disconnected(alpha);
    const again = s.open('dev', 'alpha');
    assert.deepEqual(agents(), [[beta, null], [again, null]]);
  } finally {
    await s.cleanup();
  }
});

test('sendNote can frame a delegated task instead of a note; the default framing stays the note’s', async () => {
  const s = await nightSetup();
  try {
    const id = s.open('dev', 'alpha');
    const sending = s.service.sendNote(id, 'Write the dialog tests.', '', taskText);
    const [[, line]] = s.link.sent;
    assert.equal(line.type === 'message' && line.text, 'Task from the user, delegated through Mirador:\n\nWrite the dialog tests.');
    s.service.delivered(id, line.type === 'message' ? line.messageId : '');
    assert.deepEqual(await sending, { sent: true, delivered: true });
    assert.deepEqual((s.records[0] as NightRecord & { note?: unknown }).note, { id: '', text: 'Write the dialog tests.' });
    void s.service.sendNote(id, 'Plain note.', 'n-2');
    const last = s.link.sent.at(-1)![1];
    assert.equal(last.type === 'message' && last.text, 'Execution note from the user, who is away from the keyboard:\n\nPlain note.');
  } finally {
    await s.cleanup();
  }
});

test('Mirador’s idle-sleep note is logged as a note from Mirador, with its own reason', async () => {
  const s = await nightSetup();
  try {
    const id = s.open('dev', 'alpha');
    const sending = s.service.sendNote(id, SLEEP_NOTE, '', sleepNoteText, 'mirador');
    const [[, line]] = s.link.sent;
    assert.equal(line.type === 'message' && line.text, sleepNoteText(SLEEP_NOTE), 'delivered as written');
    s.service.delivered(id, line.type === 'message' ? line.messageId : '');
    assert.deepEqual(await sending, { sent: true, delivered: true });
    const [record] = s.records;
    assert.equal(record.kind as string, 'note');
    assert.deepEqual(record.note, { id: '', text: SLEEP_NOTE, from: 'mirador' });
    assert.deepEqual(record.policy, { allowed: true, rule: 'note', reason: 'a note from Mirador before it puts an idle agent to sleep, delivered as written' });
    assert.equal(record.outcome, 'followed-up');
    assert.equal(record.delivered, true);

    s.link.connected.delete(id);
    assert.deepEqual(await s.service.sendNote(id, SLEEP_NOTE, '', sleepNoteText, 'mirador'), { sent: false, delivered: false, reason: "the agent's bridge is not connected" });
    assert.equal(s.records[1].outcome, 'deferred');
    assert.deepEqual(s.records[1].note, { id: '', text: SLEEP_NOTE, from: 'mirador' });
  } finally {
    await s.cleanup();
  }
});

test('Mirador’s idle-sleep note moves no live night card: it is housekeeping, not a night move', async () => {
  const s = await nightSetup();
  try {
    const id = s.open('dev', 'alpha');
    const states: string[] = [];
    s.service.onTerminalState((state) => states.push(state.state));
    const sending = s.service.sendNote(id, SLEEP_NOTE, '', sleepNoteText, 'mirador');
    const [[, line]] = s.link.sent;
    s.service.delivered(id, line.type === 'message' ? line.messageId : '');
    await sending;
    assert.deepEqual(states, []);
  } finally {
    await s.cleanup();
  }
});

test('the user’s notes and delegated tasks keep their reason, no sender field and their live night card', async () => {
  const s = await nightSetup();
  try {
    const id = s.open('dev', 'alpha');
    const states: string[] = [];
    s.service.onTerminalState((state) => states.push(state.state));
    for (const sending of [() => s.service.sendNote(id, 'Finish the tests.', 'n-1'), () => s.service.sendNote(id, 'Write the dialog tests.', '', taskText)]) {
      const pending = sending();
      const line = s.link.sent.at(-1)![1];
      s.service.delivered(id, line.type === 'message' ? line.messageId : '');
      await pending;
    }
    assert.deepEqual(s.records.map((record) => record.policy?.reason), ['an execution note from the user, delivered as written', 'an execution note from the user, delivered as written']);
    assert.deepEqual(s.records.map((record) => record.note), [{ id: 'n-1', text: 'Finish the tests.' }, { id: '', text: 'Write the dialog tests.' }]);
    assert.deepEqual(states, ['deciding', 'resolved', 'deciding', 'resolved']);
  } finally {
    await s.cleanup();
  }
});

test('manualSaved resolves once the manual on handed to saveManual is on disk', async () => {
  const saved: unknown[] = [];
  let finish: () => void = () => {};
  const service = new NightService({
    link: fakeLink(),
    decider: { decide: async () => ({ action: 'defer', reason: '' }), followUp: async () => ({ action: 'defer', reason: '' }) },
    log: { append: async () => {} },
    terminals: registry().terminals,
    workspaces: { get: () => undefined },
    saveManual: (manual) => new Promise<void>((resolve) => { finish = () => { saved.push(manual); resolve(); }; }),
  });
  service.setActive(true);
  let done = false;
  const waiting = service.manualSaved.then(() => { done = true; });
  await sleepMs(5);
  assert.equal(done, false, 'still writing');
  finish();
  await waiting;
  assert.equal(saved.length, 1);
  assert.equal((saved[0] as { until: unknown }).until, null);
  service.close();
});
