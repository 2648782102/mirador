// Inbox cards follow the night shift live. The night service tells which terminal it is
// deciding for and how that ended; the attention store puts that state on the cards (and keeps
// a short note once a card is gone); the UI words it. Fake decider, fake bridge link, real
// terminal registry over fake ptys; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightService, provideNightService, whenNightService, type NightLink } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightContext, NightDecision, NightFollowUp, NightQuestion } from '../src/night/protocol.ts';
import { AttentionStore, NIGHT_NOTE_MS, type AttentionItem, type NightTerminalState } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalInfo } from '../src/terminals/registry.ts';
import { translate } from '../public/i18n.js';
import { nightRuleKey, nightView } from '../public/i18n/inbox.js';

class FakePty implements PtyProcess {
  data: Array<(d: string) => void> = [];
  onData(listener: (d: string) => void) { this.data.push(listener); }
  onExit() {}
  write() {}
  resize() {}
  kill() {}
  emit(d: string) { this.data.forEach((l) => l(d)); }
}

const OUTPUT = 'TERMINAL-OUTPUT-NEVER-SHOWN';

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
  decide?: (q: NightQuestion, c: NightContext) => Promise<NightDecision>;
  followUp?: (c: NightContext) => Promise<NightFollowUp>;
  deliveryMs?: number;
}

function setup(options: Setup = {}) {
  const ptys: FakePty[] = [];
  const spawn: SpawnFn = () => { const p = new FakePty(); ptys.push(p); return p; };
  const terminals = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const link = fakeLink();
  const records: NightRecord[] = [];
  const decider: Decider = {
    decide: (q, c) => (options.decide ?? (async () => ({ action: 'answer', choices: [1], reason: 'The mission prefers lists.', confidence: 0.9 })))(q, c),
    followUp: (c) => (options.followUp ?? (async () => ({ action: 'follow-up', message: 'Run the tests and fix what fails.', reason: 'Tests were not run.', confidence: 0.8 })))(c),
  };
  let items: AttentionItem[] = [];
  const service = new NightService({
    link,
    decider,
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Prefer lists.' } : undefined) },
    attention: () => ({ items: () => items }),
    decideBudgetMs: 2000,
    deliveryTimeoutMs: options.deliveryMs ?? 2000,
  });
  const states: NightTerminalState[] = [];
  service.onTerminalState((state) => states.push(state));
  const agent = () => {
    const info = terminals.create({ cwd: '/dev/alpha', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'alpha' });
    link.connected.add(info.id);
    ptys.at(-1)!.emit(`${OUTPUT}\r\n`);
    return info.id;
  };
  const finished = (terminalId: string): AttentionItem => ({
    terminalId, workspaceId: 'dev', rel: 'alpha', title: 'alpha', kind: 'finished', label: 'Finished', detail: null, since: new Date().toISOString(), activity: null,
  });
  return { service, link, records, states, agent, terminals, setItems: (next: AttentionItem[]) => { items = next; }, finished };
}

/** The states without their times, for comparison. */
const shapes = (states: NightTerminalState[]) => states.map(({ at, ...rest }) => (assert.ok(!Number.isNaN(Date.parse(at)), at), rest));
const noOutput = (states: NightTerminalState[]) => assert.ok(!JSON.stringify(states).includes(OUTPUT), 'never terminal output');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── Night service ────────────────────────────────────────────────────────────

test('a question Mirador decides goes deciding → resolved with the chosen label', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  await s.service.question(id, 'r1', { ...question(), terminalId: id });
  assert.deepEqual(shapes(s.states), [
    { terminalId: id, state: 'deciding', flow: 'question', summary: '' },
    { terminalId: id, state: 'resolved', flow: 'question', summary: 'List' },
  ]);
  noOutput(s.states);
});

test('a questionnaire names every chosen label in the summary, capped at 120 characters', async () => {
  const long = 'x'.repeat(200);
  const s = setup({ decide: async () => ({ action: 'answer', choices: [0, 1], reason: 'ok', confidence: 0.9 }) });
  const id = s.agent();
  s.service.setActive(true);
  await s.service.question(id, 'r1', {
    terminalId: id, toolCallId: 'c', tool: 'ask_user_question', allowCustomResponse: false,
    items: [
      { question: 'Name?', header: 'Naming', multiSelect: false, options: [{ label: 'parseLine', description: '' }, { label: 'readLine', description: '' }] },
      { question: 'Tests?', header: 'Tests', multiSelect: false, options: [{ label: 'Later', description: '' }, { label: long, description: '' }] },
    ],
  });
  const resolved = s.states.at(-1)!;
  assert.equal(resolved.state, 'resolved');
  assert.ok(resolved.summary.startsWith('parseLine, xxx'), resolved.summary);
  assert.ok(Array.from(resolved.summary).length <= 120, `${resolved.summary.length}`);
});

test('a question the decider defers goes deciding → deferred with its rule and reason; a policy deferral skips deciding', async () => {
  const s = setup({ decide: async () => ({ action: 'defer', reason: 'The mission says nothing about layouts.' }) });
  const id = s.agent();
  s.service.setActive(true);
  await s.service.question(id, 'r1', { ...question(), terminalId: id });
  assert.deepEqual(shapes(s.states), [
    { terminalId: id, state: 'deciding', flow: 'question', summary: '' },
    { terminalId: id, state: 'deferred', flow: 'question', summary: '', rule: 'decider', reason: 'The mission says nothing about layouts.' },
  ]);

  s.states.length = 0;
  await s.service.question(id, 'r2', { ...question(['Yes', 'No'], 'Deploy to production now?'), terminalId: id });
  assert.equal(s.states.length, 1);
  assert.equal(s.states[0].state, 'deferred');
  assert.equal(s.states[0].rule, 'sensitive:production');
  noOutput(s.states);
});

test('a long deferral reason is cut to 200 characters on one line', async () => {
  const s = setup({ decide: async () => ({ action: 'defer', reason: `line one\n${'y'.repeat(400)}` }) });
  const id = s.agent();
  s.service.setActive(true);
  await s.service.question(id, 'r1', { ...question(), terminalId: id });
  const reason = s.states.at(-1)!.reason!;
  assert.ok(!reason.includes('\n'));
  assert.ok(Array.from(reason).length <= 200, `${reason.length}`);
});

test('while the night shift is off, questions leave no state', async () => {
  const s = setup();
  const id = s.agent();
  await s.service.question(id, 'r1', { ...question(), terminalId: id });
  assert.deepEqual(s.states, []);
});

test('a follow-up goes deciding → resolved with the instruction cut to 120 characters', async () => {
  const message = `Run the whole test suite, then fix every failure you find. ${'Keep going. '.repeat(30)}`;
  const s = setup({ followUp: async () => ({ action: 'follow-up', message, reason: 'r', confidence: 0.9 }) });
  const id = s.agent();
  s.setItems([s.finished(id)]);
  const started = s.service.delegate(id)!;
  await tick();
  assert.deepEqual(shapes(s.states), [{ terminalId: id, state: 'deciding', flow: 'follow-up', summary: '' }]);
  s.service.delivered(id, started.id);
  await started.done;
  const resolved = s.states.at(-1)!;
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.flow, 'follow-up');
  assert.ok(resolved.summary.startsWith('Run the whole test suite, then fix every failure you find.'), resolved.summary);
  assert.ok(Array.from(resolved.summary).length <= 120);
  noOutput(s.states);
});

test('a follow-up the decider defers is deferred; one the bridge never confirms is deferred as not-delivered', async () => {
  const s = setup({ followUp: async () => ({ action: 'defer', reason: 'Needs the user.' }) });
  const id = s.agent();
  s.setItems([s.finished(id)]);
  await s.service.delegate(id)!.done;
  assert.deepEqual(shapes(s.states).map((x) => [x.state, x.rule, x.reason]), [['deciding', undefined, undefined], ['deferred', 'decider', 'Needs the user.']]);

  const u = setup({ deliveryMs: 30 });
  const other = u.agent();
  u.setItems([u.finished(other)]);
  await u.service.delegate(other)!.done;
  assert.deepEqual(shapes(u.states).map((x) => [x.state, x.rule]), [['deciding', undefined], ['deferred', 'not-delivered']]);
});

test('a follow-up whose agent started again is dropped: its deciding state is cleared, not deferred', async () => {
  let release!: (value: NightFollowUp) => void;
  const s = setup({ followUp: () => new Promise((resolve) => { release = resolve; }) });
  const id = s.agent();
  s.setItems([s.finished(id)]);
  const started = s.service.delegate(id)!;
  await tick();
  s.setItems([]);
  release({ action: 'follow-up', message: 'Run the tests.', reason: 'r', confidence: 0.9 });
  await started.done;
  assert.deepEqual(shapes(s.states).map((x) => x.state), ['deciding', 'cleared']);
});

test('a delivered execution note goes deciding → resolved with the start of the note', async () => {
  const s = setup();
  const id = s.agent();
  const text = 'Tonight finish the tests.\nDo NOT push anything.';
  const sending = s.service.sendNote(id, text, 'note-1');
  const [[, line]] = s.link.sent;
  s.service.delivered(id, line.type === 'message' ? line.messageId : '');
  await sending;
  assert.deepEqual(shapes(s.states), [
    { terminalId: id, state: 'deciding', flow: 'note', summary: '' },
    { terminalId: id, state: 'resolved', flow: 'note', summary: 'Tonight finish the tests. Do NOT push anything.' },
  ]);
  s.link.connected.delete(id);
  s.states.length = 0;
  await s.service.sendNote(id, 'again', 'note-2');
  assert.deepEqual(s.states, [], 'a note that never went out changes no card');
});

test('a throwing state listener does not stop the flow or the others; unsubscribing stops the events', async () => {
  const s = setup();
  const id = s.agent();
  const heard: string[] = [];
  s.service.onTerminalState(() => { throw new Error('boom'); });
  const off = s.service.onTerminalState((state) => heard.push(state.state));
  s.service.setActive(true);
  await s.service.question(id, 'r1', { ...question(), terminalId: id });
  assert.deepEqual(heard, ['deciding', 'resolved']);
  assert.equal(s.link.sent.at(-1)?.[1].type, 'decided');
  off();
  await s.service.question(id, 'r2', { ...question(), terminalId: id });
  assert.equal(heard.length, 2);
});

test('whenNightService runs once the night service of that app is provided, or at once when it already is', () => {
  const app = {};
  const other = {};
  const seen: unknown[] = [];
  whenNightService(app, (service) => seen.push(service));
  assert.deepEqual(seen, []);
  const service = setup().service;
  provideNightService(other, service);
  assert.deepEqual(seen, [], 'another app');
  provideNightService(app, service);
  assert.deepEqual(seen, [service]);
  whenNightService(app, (later) => seen.push(later));
  assert.deepEqual(seen, [service, service]);
});

// ── Attention store ──────────────────────────────────────────────────────────

function terminal(id: string, rel = 'alpha'): TerminalInfo {
  return { id, workspaceId: 'dev', rel, cwd: `/dev/${rel}`, title: rel, kind: 'agent', status: 'running', createdAt: '2026-10-28T10:00:00.000Z' };
}
const report = (pane: string, seq: number, tokens: Record<string, string> = {}, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source: 'mirador:attention', seq, ttlMs: null, tokens, clear });
const state = (terminalId: string, value: NightTerminalState['state'], flow: NightTerminalState['flow'], extra: Partial<NightTerminalState> = {}): NightTerminalState =>
  ({ terminalId, state: value, flow, summary: '', at: '2026-10-28T01:00:00.000Z', ...extra });

function store() {
  let clock = Date.parse('2026-10-28T02:00:00.000Z');
  const attention = new AttentionStore({ now: () => clock });
  const heard: Array<{ items: AttentionItem[]; notes: AttentionItem[] }> = [];
  attention.subscribe((items, notes) => heard.push({ items, notes: notes ?? [] }));
  attention.track({ type: 'created', info: terminal('t1') });
  return { attention, heard, advance: (ms: number) => { clock += ms; }, iso: () => new Date(clock).toISOString() };
}

test('a night state rides on the waiting card and reaches subscribers; cards without one carry no night field', () => {
  const s = store();
  s.attention.receive(report('t1', 1, { finished: 'turn-1' }));
  assert.equal('night' in s.attention.items()[0], false);
  const at = s.iso();
  assert.equal(s.attention.night(state('t1', 'deciding', 'follow-up')), true);
  assert.deepEqual(s.heard.at(-1)!.items.map((item) => item.night), [{ state: 'deciding', flow: 'follow-up', summary: '', at }]);
  s.attention.night(state('t1', 'deferred', 'follow-up', { rule: 'low-confidence', reason: 'confidence 0.5 is below 0.7' }));
  assert.deepEqual(s.attention.items()[0].night, { state: 'deferred', flow: 'follow-up', summary: '', rule: 'low-confidence', reason: 'confidence 0.5 is below 0.7', at });
  assert.deepEqual(s.attention.nightNotes(), []);
});

test('a resolved follow-up leaves the card when the agent starts, as a note that stays until the user sees it', () => {
  const s = store();
  s.attention.receive(report('t1', 1, { finished: 'turn-1' }));
  const since = s.attention.items()[0].since;
  s.advance(1000);
  s.attention.night(state('t1', 'resolved', 'follow-up', { summary: 'Run the tests.' }));
  s.attention.receive(report('t1', 2, {}, ['finished']));
  assert.deepEqual(s.attention.items(), []);
  const [note] = s.attention.nightNotes();
  assert.deepEqual({ ...note, night: undefined }, {
    terminalId: 't1', workspaceId: 'dev', rel: 'alpha', title: 'alpha', kind: 'finished', label: 'Finished', detail: null, since, activity: null, night: undefined,
  });
  assert.equal(note.night?.state, 'resolved');
  assert.equal(note.night?.summary, 'Run the tests.');
  assert.deepEqual(s.heard.at(-1)!.notes, [note], 'pushed to subscribers');
  assert.equal(s.attention.dismiss('t1'), true);
  assert.deepEqual(s.attention.nightNotes(), []);
  assert.deepEqual(s.heard.at(-1)!.notes, []);
});

test('a resolved note expires after 10 minutes and the expiry is pushed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = store();
  s.attention.night(state('t1', 'resolved', 'question', { summary: 'List' }));
  const [note] = s.attention.nightNotes();
  assert.equal(note.kind, 'prompt', 'a decided question shows with the answers');
  assert.equal(note.night?.summary, 'List');
  assert.equal(NIGHT_NOTE_MS, 10 * 60_000);
  s.advance(NIGHT_NOTE_MS - 1);
  t.mock.timers.tick(NIGHT_NOTE_MS - 1);
  assert.equal(s.attention.nightNotes().length, 1);
  s.advance(1);
  t.mock.timers.tick(1);
  assert.deepEqual(s.attention.nightNotes(), []);
  assert.deepEqual(s.heard.at(-1)!.notes, []);
});

test('a deferred question shows before its dialog, then on the dialog card, and goes when the user answers', () => {
  const s = store();
  s.attention.night(state('t1', 'deciding', 'question'));
  assert.equal(s.attention.nightNotes()[0].night?.state, 'deciding', 'no dialog opened yet');
  s.attention.night(state('t1', 'deferred', 'question', { rule: 'decider', reason: 'Needs the user.' }));
  assert.equal(s.attention.nightNotes()[0].night?.state, 'deferred');
  s.attention.receive(report('t1', 1, { prompt: 'Pick a layout' }));
  assert.deepEqual(s.attention.nightNotes(), []);
  assert.equal(s.attention.items()[0].night?.state, 'deferred');
  assert.equal(s.attention.items()[0].night?.reason, 'Needs the user.');
  assert.equal(s.attention.dismiss('t1'), false, 'a card waiting for an answer stays');
  assert.equal(s.attention.items()[0].night?.state, 'deferred');
  s.attention.receive(report('t1', 2, {}, ['prompt']));
  assert.deepEqual(s.attention.items(), []);
  assert.deepEqual(s.attention.nightNotes(), [], 'answered: nothing left to say');
  s.attention.receive(report('t1', 3, { prompt: 'Another dialog' }));
  assert.equal('night' in s.attention.items()[0], false, 'a later dialog starts clean');
});

test('a deferred follow-up stays on its finished card; seeing the card takes both away', () => {
  const s = store();
  s.attention.receive(report('t1', 1, { finished: 'turn-1' }));
  s.attention.night(state('t1', 'deferred', 'follow-up', { rule: 'sensitive:push', reason: 'mentions push' }));
  assert.equal(s.attention.items()[0].night?.rule, 'sensitive:push');
  assert.equal(s.attention.dismiss('t1'), true);
  assert.deepEqual(s.attention.items(), []);
  assert.deepEqual(s.attention.nightNotes(), []);
});

test('cleared ends a deciding state only; unknown terminals and junk are ignored; texts are one capped line', () => {
  const s = store();
  s.attention.receive(report('t1', 1, { finished: 'turn-1' }));
  s.attention.night(state('t1', 'deciding', 'follow-up'));
  s.attention.night(state('t1', 'cleared', 'follow-up'));
  assert.equal('night' in s.attention.items()[0], false);
  s.attention.night(state('t1', 'resolved', 'follow-up', { summary: 'Done.' }));
  s.attention.night(state('t1', 'cleared', 'follow-up'));
  assert.equal(s.attention.items()[0].night?.state, 'resolved', 'cleared never erases a result');

  assert.equal(s.attention.night(state('nope', 'deciding', 'question')), false);
  assert.equal(s.attention.night({ ...state('t1', 'deciding', 'question'), state: 'weird' as never }), false);
  s.attention.night(state('t1', 'deferred', 'follow-up', { summary: 'a\u202e\nb'.repeat(100), rule: 'decider', reason: `${'r'.repeat(300)}\u0007` }));
  const night = s.attention.items()[0].night!;
  assert.ok(Array.from(night.summary).length <= 120 && !/[\n\u202e]/.test(night.summary), night.summary);
  assert.ok(Array.from(night.reason!).length <= 200 && !night.reason!.includes('\u0007'));
});

test('a note delivered to an agent that had not finished shows with the finished, without the Finished label', () => {
  const s = store();
  s.attention.night(state('t1', 'resolved', 'note', { summary: 'Finish the tests.' }));
  const [note] = s.attention.nightNotes();
  assert.deepEqual([note.kind, note.label, note.night?.flow], ['finished', '', 'note']);
});

test('a terminal that closes takes its night state along', () => {
  const s = store();
  s.attention.night(state('t1', 'resolved', 'question', { summary: 'List' }));
  s.attention.track({ type: 'closed', info: terminal('t1') });
  assert.deepEqual(s.attention.nightNotes(), []);
});

// ── UI wording (DOM-free) ────────────────────────────────────────────────────

const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

test('known deferral rules become short human phrases in both languages, with a fallback', () => {
  const rules = ['low-confidence', 'decider', 'auto-cap', 'no-final-message', 'stale', 'busy', 'not-connected', 'not-delivered', 'timeout', 'stopped', 'error', 'invalid-decision'];
  const seen = new Set<string>();
  for (const rule of rules) {
    const { key } = nightRuleKey(rule);
    assert.notEqual(key, nightRuleKey('who-knows').key, rule);
    for (const t of [es, en]) assert.notEqual(t(key), key, `${rule} is translated`);
    seen.add(es(key));
  }
  assert.equal(seen.size, rules.length, 'every rule reads differently');
  assert.deepEqual(nightRuleKey('sensitive:push'), { key: 'inbox.night.rule.sensitive', vars: { topic: 'push' } });
  assert.match(es('inbox.night.rule.sensitive', { topic: 'push' }), /push/);
  assert.deepEqual(nightRuleKey(undefined), { key: 'inbox.night.rule.other' });
});

test('nightView words each state: deciding, chose, continued, delivered, deferred', () => {
  const at = '2026-10-28T01:00:00.000Z';
  assert.equal(nightView(undefined, es), null);
  assert.equal(nightView({ state: 'deciding', flow: 'question', summary: '', at }, es)!.line, 'Mirador está decidiendo…');
  assert.equal(nightView({ state: 'resolved', flow: 'question', summary: 'List', at }, es)!.line, 'Mirador eligió «List»');
  assert.equal(nightView({ state: 'resolved', flow: 'follow-up', summary: 'Run the tests.', at }, es)!.line, 'Mirador continuó: Run the tests.');
  assert.equal(nightView({ state: 'resolved', flow: 'note', summary: 'Finish it.', at }, es)!.line, 'Mirador entregó tu nota: Finish it.');
  const deferred = nightView({ state: 'deferred', flow: 'follow-up', summary: '', rule: 'low-confidence', reason: 'confidence 0.5 is below 0.7', at }, es)!;
  assert.equal(deferred.line, `Mirador lo dejó pendiente: ${es('inbox.night.rule.lowConfidence')}`);
  assert.equal(deferred.title, 'confidence 0.5 is below 0.7');
  assert.equal(nightView({ state: 'resolved', flow: 'question', summary: 'List', at }, en)!.line, 'Mirador chose “List”');
  for (const value of ['deciding', 'resolved', 'deferred'] as const) {
    const view = nightView({ state: value, flow: 'question', summary: 'x', at }, es)!;
    assert.equal(view.state, value);
    assert.ok(view.badge && view.badge !== `inbox.night.badge.${value}`, value);
  }
});
