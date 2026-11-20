// Held questions: while holding for
// answers is on, a question the autopilot leaves to the user is held for an answer from
// Telegram instead of opening its dialog. It ends exactly once: answered, released to the
// terminal, its terminal closed, or the autopilot stopped. Fake decider and bridge link,
// real terminal registry over fake ptys; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightService, type HeldQuestion, type NightLink } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightDecision, NightQuestion } from '../src/night/protocol.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

const choice = (labels = ['Yes', 'No'], text = 'Deploy to production now?'): NightQuestion => ({
  terminalId: '', toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: false,
  items: [{ question: text, header: '', multiSelect: false, options: labels.map((label) => ({ label, description: `${label} it` })) }],
});

const questionnaire = (): NightQuestion => ({
  terminalId: '', toolCallId: 'call-2', tool: 'ask_user_question', allowCustomResponse: false,
  items: [
    { question: 'Which checks should run?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }, { label: 'Build', description: '' }] },
    { question: 'Where should the report go?', header: 'Report', multiSelect: false, options: [{ label: 'File', description: '' }, { label: 'Screen', description: '' }] },
  ],
});

function setup(options: { decide?: () => Promise<NightDecision>; budgetMs?: number; setTimer?: (fn: () => void, ms: number) => () => void } = {}) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const link: NightLink = {
    send: (id, line) => (connected.has(id) ? (sent.push([id, line]), true) : false),
    isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected],
  };
  const records: NightRecord[] = [];
  const events: string[] = [];
  const decider: Decider = {
    decide: options.decide ?? (async () => ({ action: 'answer', choices: [1], reason: 'The mission prefers lists.', confidence: 0.9 })),
    followUp: async () => ({ action: 'defer', reason: 'no' }),
  };
  const service = new NightService({
    link,
    decider,
    log: { append: async (record) => { events.push(`record:${record.sent}`); records.push(record); } },
    terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship it.' } : undefined) },
    attention: () => ({ items: () => [] }),
    decideBudgetMs: options.budgetMs ?? 2000,
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
  });
  const held: HeldQuestion[] = [];
  const ended: Array<[string, string]> = [];
  service.onHeld((question) => { events.push('held'); held.push(question); });
  service.onHeldEnd((id, outcome) => void ended.push([id, outcome]));
  const agent = (rel = 'alpha') => {
    const info = terminals.create({ cwd: `/dev/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel });
    connected.add(info.id);
    return info.id;
  };
  const ask = (id: string, q = choice(), requestId = 'r1') => service.question(id, requestId, { ...q, terminalId: id });
  return { service, sent, connected, records, events, held, ended, agent, ask, terminals };
}

test('with holding on, a question the policy leaves to the user is held: a held line, onHeld, listed, then logged as held', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  s.service.holdForAnswers(true);
  await s.ask(id);

  assert.deepEqual(s.sent, [[id, { type: 'held', requestId: 'r1' }]], 'the bridge keeps waiting; no pass, so no dialog');
  assert.equal(s.held.length, 1);
  const [held] = s.held;
  assert.match(held.id, /^[\w-]{1,16}$/, 'short and opaque');
  assert.ok(held.id.length >= 12, 'long enough to be unguessable');
  assert.deepEqual({ ...held, id: '', since: '' }, {
    id: '', since: '', terminalId: id, workspaceId: 'dev', workspaceName: 'Dev', rel: 'alpha', tool: 'ask_user_choice',
    items: [{ question: 'Deploy to production now?', header: '', multiSelect: false, options: [{ label: 'Yes', description: 'Yes it' }, { label: 'No', description: 'No it' }] }],
    reason: s.records[0].deferral!.reason, rule: 'sensitive:production', sensitive: 'production',
  });
  assert.ok(Number.isFinite(Date.parse(held.since)));
  assert.deepEqual(s.service.heldQuestions(), [held]);
  assert.deepEqual(s.events, ['held', 'record:held'], 'listeners hear it before its record is appended');
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].outcome, 'deferred');
  assert.equal(s.records[0].sent, 'held');
  assert.equal(s.records[0].heldId, held.id);
  assert.equal(s.service.status().pending[0]?.id, s.records[0].id, 'still left for the user');

  const other = s.agent('beta');
  await s.ask(other, choice(), 'r2');
  assert.notEqual(s.held[1].id, held.id, 'every held question has its own id');
});

test('a decider deferral and a low-confidence answer are held too, without a sensitive mark', async () => {
  for (const [name, decide, rule] of [
    ['defer', async () => ({ action: 'defer', reason: 'The mission says nothing about layouts.' }), 'decider'],
    ['low confidence', async () => ({ action: 'answer', choices: [0], reason: 'Unsure.', confidence: 0.5 }), 'low-confidence'],
  ] as const) {
    const s = setup({ decide: decide as () => Promise<NightDecision> });
    const id = s.agent();
    s.service.setActive(true);
    s.service.holdForAnswers(true);
    await s.ask(id, choice(['Grid', 'List'], 'Which layout should the report use?'));
    assert.deepEqual(s.sent, [[id, { type: 'held', requestId: 'r1' }]], name);
    assert.equal(s.held[0].rule, rule, name);
    assert.equal(s.held[0].sensitive, null, name);
    assert.equal(s.records[0].sent, 'held', name);
  }
});

test('a decider that fails, runs out of time or gives an answer that does not fit leaves the question held too', async () => {
  for (const [name, decide, rule] of [
    ['error', async () => { throw new Error('boom'); }, 'error'],
    ['timeout', () => new Promise<NightDecision>(() => {}), 'timeout'],
    ['invalid', async () => ({ action: 'answer', choices: [7], reason: 'Off the list.', confidence: 0.9 }), 'invalid-decision'],
  ] as const) {
    const s = setup({ decide: decide as () => Promise<NightDecision>, budgetMs: 20 });
    const id = s.agent();
    s.service.setActive(true);
    s.service.holdForAnswers(true);
    await s.ask(id, choice(['Grid', 'List'], 'Which layout should the report use?'));
    assert.deepEqual(s.sent, [[id, { type: 'held', requestId: 'r1' }]], name);
    assert.equal(s.held[0].rule, rule, name);
    assert.equal(s.records[0].outcome, 'deferred', name);
    assert.equal(s.records[0].sent, 'held', name);
    assert.equal(s.records[0].heldId, s.held[0].id, name);
  }
});

test('without holding, a decider that fails or runs out of time still passes the question at once', async () => {
  for (const [name, decide] of [
    ['error', async () => { throw new Error('boom'); }],
    ['timeout', () => new Promise<NightDecision>(() => {})],
  ] as const) {
    const s = setup({ decide: decide as () => Promise<NightDecision>, budgetMs: 20 });
    const id = s.agent();
    s.service.setActive(true);
    await s.ask(id, choice(['Grid', 'List'], 'Which layout should the report use?'));
    assert.deepEqual(s.sent, [[id, { type: 'pass', requestId: 'r1' }]], name);
    assert.deepEqual(s.records.map((record) => [record.sent, record.heldId]), [['pass', undefined]], name);
  }
});

test('without holding, a question left to the user passes exactly as before: no held line, no heldId', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  await s.ask(id);
  s.service.holdForAnswers(true);
  s.service.holdForAnswers(false);
  const other = s.agent('beta');
  await s.ask(other, choice(), 'r2');
  assert.deepEqual(s.sent, [[id, { type: 'pass', requestId: 'r1' }], [other, { type: 'pass', requestId: 'r2' }]]);
  assert.deepEqual(s.records.map((record) => [record.sent, record.heldId]), [['pass', undefined], ['pass', undefined]]);
  assert.deepEqual(s.held, []);
  assert.deepEqual(s.service.heldQuestions(), []);
});

test('with holding on, a decided question is still decided, and one buttons cannot answer still passes', async () => {
  const s = setup();
  const id = s.agent();
  s.service.setActive(true);
  s.service.holdForAnswers(true);
  await s.ask(id, choice(['Grid', 'List'], 'Which layout should the report use?'));
  assert.equal(s.sent[0][1].type, 'decided');
  assert.equal(s.records[0].sent, 'decided');
  assert.equal(s.records[0].decidedBy, undefined, 'the autopilot decided it');

  const free: NightQuestion = { ...choice(), allowCustomResponse: true, items: [{ question: 'Describe the bug?', header: '', multiSelect: false, options: [] }] };
  await s.ask(id, free, 'r2');
  assert.deepEqual(s.sent[1], [id, { type: 'pass', requestId: 'r2' }], 'a free-text-only question opens its dialog');
  assert.deepEqual(s.held, []);
});

test('while the autopilot is off, nothing is held: every question passes at once', async () => {
  const s = setup();
  const id = s.agent();
  s.service.holdForAnswers(true);
  await s.ask(id);
  assert.deepEqual(s.sent, [[id, { type: 'pass', requestId: 'r1' }]]);
  assert.deepEqual(s.held, []);
  assert.deepEqual(s.records, []);
});

/** Holds `q` in a fresh terminal and returns its held question. */
async function holdOne(s: ReturnType<typeof setup>, q = choice(), requestId = 'r1') {
  const id = s.agent(`t-${s.held.length}`);
  s.service.setActive(true);
  s.service.holdForAnswers(true);
  await s.ask(id, q, requestId);
  assert.equal(s.sent.at(-1)?.[1].type, 'held');
  return { terminalId: id, held: s.held.at(-1)! };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('answerHeld decides a held choice in gentle-pi\'s own result wording, logs it as the user\'s, and ends it answered', async () => {
  const s = setup();
  const { terminalId, held } = await holdOne(s);
  assert.deepEqual(s.service.answerHeld(held.id, [[1]], 'telegram'), { ok: true });
  assert.deepEqual(s.sent.at(-1), [terminalId, { type: 'decided', requestId: 'r1', reason: 'User selected: 2. No' }]);
  assert.deepEqual(s.ended, [[held.id, 'answered']]);
  assert.deepEqual(s.service.heldQuestions(), []);
  await tick();
  assert.equal(s.records.length, 2, 'the held record, then the answer');
  const answer = s.records[1];
  assert.notEqual(answer.id, s.records[0].id);
  assert.equal(answer.kind, 'question');
  assert.equal(answer.outcome, 'decided');
  assert.equal(answer.sent, 'decided');
  assert.equal(answer.decidedBy, 'user-telegram');
  assert.equal(answer.heldId, held.id);
  assert.deepEqual(answer.decision?.choices, [{ item: 0, index: 1, label: 'No' }]);
  assert.deepEqual(s.service.status().pending, [], 'answered, so no longer pending');
});

test('answerHeld answers a questionnaire item by item, a multi-select one with every option chosen', async () => {
  const s = setup();
  const { terminalId, held } = await holdOne(s, questionnaire());
  assert.deepEqual(s.service.answerHeld(held.id, [[0, 2], [1]], 'telegram'), { ok: true });
  assert.deepEqual(s.sent.at(-1), [terminalId, { type: 'decided', requestId: 'r1', reason: '1. Which checks should run? — selected: Lint, Build\n2. Where should the report go? — Screen' }]);
  await tick();
  assert.deepEqual(s.records[1].decision?.choices, [{ item: 0, index: 0, label: 'Lint' }, { item: 0, index: 2, label: 'Build' }, { item: 1, index: 1, label: 'Screen' }]);
});

test('answerHeld refuses choices that do not fit, and unknown ids, without ending the question or sending anything', async () => {
  const s = setup();
  const { held } = await holdOne(s, questionnaire());
  const sent = s.sent.length;
  for (const choices of [[[0]], [[0], [1], [0]], [[], [1]], [[3], [1]], [[0], [0, 1]], [[0, 0], [1]], [[0.5], [1]], [[-1], [1]], 'x', [[0], 'x'], null]) {
    assert.deepEqual(s.service.answerHeld(held.id, choices as number[][], 'telegram'), { ok: false, code: 'invalid' }, JSON.stringify(choices));
  }
  assert.deepEqual(s.service.answerHeld(held.id, [[0], [1]], 'cli' as 'telegram'), { ok: false, code: 'invalid' }, 'only Telegram answers');
  assert.deepEqual(s.service.answerHeld('nope-nope-nope', [[0], [1]], 'telegram'), { ok: false, code: 'unknown' });
  assert.equal(s.sent.length, sent);
  assert.deepEqual(s.ended, []);
  assert.equal(s.service.heldQuestions().length, 1, 'still held');
});

test('a second answer for the same held question is refused as ended: the bridge gets one decision only', async () => {
  const s = setup();
  const { held } = await holdOne(s);
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: true });
  assert.deepEqual(s.service.answerHeld(held.id, [[1]], 'telegram'), { ok: false, code: 'ended' });
  assert.equal(s.sent.filter(([, line]) => line.type === 'decided').length, 1);
  assert.deepEqual(s.ended, [[held.id, 'answered']]);
  await tick();
  assert.equal(s.records.filter((record) => record.decidedBy).length, 1);
});

test('released from the terminal (escape key or abort) ends it terminal; a later answer is ended and the bridge gets nothing', async () => {
  const s = setup();
  const { terminalId, held } = await holdOne(s);
  const sent = s.sent.length;
  s.service.released('someone-else', 'r1');
  s.service.released(terminalId, 'r-other');
  assert.deepEqual(s.ended, [], 'a release names its own terminal and request');
  s.service.released(terminalId, 'r1');
  assert.deepEqual(s.ended, [[held.id, 'terminal']]);
  assert.deepEqual(s.service.heldQuestions(), []);
  s.service.released(terminalId, 'r1');
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
  assert.equal(s.sent.length, sent, 'the dialog is already open: nothing goes to the bridge');
  assert.deepEqual(s.ended, [[held.id, 'terminal']], 'it ended once');
  assert.equal(s.service.status().pending.length, 1, 'still pending for the user at the terminal');
});

test('turning holding off releases every held question to its dialog: pass, ended terminal, a later answer ended', async () => {
  const s = setup();
  const { terminalId, held } = await holdOne(s);
  s.service.holdForAnswers(false);
  assert.deepEqual(s.sent.at(-1), [terminalId, { type: 'pass', requestId: 'r1' }]);
  assert.deepEqual(s.ended, [[held.id, 'terminal']]);
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
  assert.equal(s.sent.filter(([, line]) => line.type === 'decided').length, 0);
});

test('a terminal that closes or whose bridge leaves ends its held question closed, nothing sent; other terminals keep theirs', async () => {
  const s = setup();
  const first = await holdOne(s);
  const second = await holdOne(s, choice(), 'r2');
  const sent = s.sent.length;
  s.connected.delete(first.terminalId);
  s.service.disconnected(first.terminalId);
  assert.deepEqual(s.ended, [[first.held.id, 'closed']]);
  assert.equal(s.sent.length, sent);
  assert.deepEqual(s.service.answerHeld(first.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
  assert.deepEqual(s.service.heldQuestions().map((held) => held.id), [second.held.id]);
  assert.deepEqual(s.service.answerHeld(second.held.id, [[0]], 'telegram'), { ok: true });
});

test('an answer whose bridge is gone without a disconnect yet is ended closed, never reported as answered', async () => {
  const s = setup();
  const { terminalId, held } = await holdOne(s);
  s.connected.delete(terminalId);
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
  assert.deepEqual(s.ended, [[held.id, 'closed']]);
  s.service.disconnected(terminalId);
  assert.deepEqual(s.ended, [[held.id, 'closed']], 'it ended once');
  await tick();
  assert.equal(s.records.filter((record) => record.decidedBy).length, 0);
});

test('turning the autopilot off, or a shutdown, ends held questions stopped and opens their dialogs', async () => {
  const s = setup();
  const { terminalId, held } = await holdOne(s);
  s.service.setActive(false);
  assert.deepEqual(s.sent.at(-1), [terminalId, { type: 'pass', requestId: 'r1' }]);
  assert.deepEqual(s.ended, [[held.id, 'stopped']]);
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });

  const t = setup();
  const other = await holdOne(t);
  t.service.close();
  assert.deepEqual(t.sent.at(-1), [other.terminalId, { type: 'pass', requestId: 'r1' }]);
  assert.deepEqual(t.ended, [[other.held.id, 'stopped']]);
  assert.deepEqual(t.service.heldQuestions(), []);
});

test('a held question is never cut by time: well past the decider budget it is still held and answerable', async () => {
  const s = setup({ budgetMs: 30 });
  const { held } = await holdOne(s);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(s.ended, []);
  assert.equal(s.service.heldQuestions().length, 1);
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: true });
});

/* ---------- Dialogs answered from Telegram ---------- */

/** Timers run by hand: each one set is listed with its delay, and runs only when the test says so. */
function manualTimers() {
  const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    const timer = { ms, fn, cleared: false };
    timers.push(timer);
    return () => void (timer.cleared = true);
  };
  return { timers, setTimer };
}

function holdDialog(s: ReturnType<typeof setup>, requestId = 'd1') {
  const id = s.agent();
  s.service.setActive(true);
  s.service.holdForAnswers(true);
  s.service.dialog(id, requestId, { terminalId: id, kind: 'confirm', title: 'Allow guarded actions: git push?', message: 'git push origin main', options: ['Yes', 'No'] });
  assert.deepEqual(s.sent.at(-1), [id, { type: 'held', requestId }]);
  return { terminalId: id, held: s.held.at(-1)! };
}

const dialogRecords = (s: ReturnType<typeof setup>) => s.records.filter((record) => record.tool === 'dialog');

test('follow-ups S3: a dialog answered from Telegram waits for the bridge: `took` ends it answered and logs the user\'s answer; a second answer meanwhile is ended', async () => {
  const clock = manualTimers();
  const s = setup({ setTimer: clock.setTimer });
  const { terminalId, held } = holdDialog(s);
  assert.deepEqual(s.service.answerHeld(held.id, [[0]], 'telegram'), { ok: true });
  assert.deepEqual(s.sent.at(-1), [terminalId, { type: 'chosen', requestId: 'd1', index: 0 }]);
  assert.deepEqual(s.ended, [], 'sent, not answered yet');
  assert.deepEqual(s.service.answerHeld(held.id, [[1]], 'telegram'), { ok: false, code: 'ended' }, 'one answer goes out');
  assert.equal(s.sent.filter(([, line]) => line.type === 'chosen').length, 1);
  await tick();
  assert.deepEqual(dialogRecords(s), [], 'nothing logged before the bridge took it');

  s.service.took('someone-else', 'd1');
  s.service.took(terminalId, 'd-other');
  assert.deepEqual(s.ended, [], 'a took names its own terminal and request');
  s.service.took(terminalId, 'd1');
  assert.deepEqual(s.ended, [[held.id, 'answered']]);
  await tick();
  const [record] = dialogRecords(s);
  assert.equal(record.decidedBy, 'user-telegram');
  assert.equal(record.heldId, held.id);
  assert.deepEqual(record.decision?.choices, [{ item: 0, index: 0, label: 'Yes' }]);
  assert.equal(record.decision?.reason, 'The user answered from Telegram');
  const grace = clock.timers.filter((timer) => timer.ms === 10_000);
  assert.equal(grace.length, 1, 'one fallback timer');
  assert.equal(grace[0].cleared, true, 'cleared once the bridge took it');
  s.service.took(terminalId, 'd1');
  s.service.released(terminalId, 'd1');
  assert.deepEqual(s.ended, [[held.id, 'answered']], 'it ended once');
  await tick();
  assert.equal(dialogRecords(s).length, 1);
});

test('follow-ups S3: a dialog the terminal answered before the bridge saw Telegram\'s chosen ends `terminal` on `released`, with no Telegram record', async () => {
  const s = setup();
  const { terminalId, held } = holdDialog(s);
  assert.deepEqual(s.service.answerHeld(held.id, [[1]], 'telegram'), { ok: true });
  s.service.released(terminalId, 'd1');
  assert.deepEqual(s.ended, [[held.id, 'terminal']]);
  s.service.took(terminalId, 'd1');
  assert.deepEqual(s.ended, [[held.id, 'terminal']], 'it ended once');
  await tick();
  assert.deepEqual(dialogRecords(s), [], 'no user-telegram record');
});

test('follow-ups S3: a bridge that never says took (an old bridge, a lost line): 10 s later the answer counts as taken', async () => {
  const clock = manualTimers();
  const s = setup({ setTimer: clock.setTimer });
  const { held } = holdDialog(s);
  assert.deepEqual(s.service.answerHeld(held.id, [[1]], 'telegram'), { ok: true });
  const timer = clock.timers.find((each) => each.ms === 10_000);
  assert.ok(timer, 'a 10 s fallback timer');
  assert.deepEqual(s.ended, []);
  timer.fn();
  assert.deepEqual(s.ended, [[held.id, 'answered']]);
  await tick();
  const records = dialogRecords(s);
  assert.equal(records.length, 1);
  assert.equal(records[0].decidedBy, 'user-telegram');
  assert.deepEqual(records[0].decision?.choices, [{ item: 0, index: 1, label: 'No' }]);

  // A `took` for an answer Mirador never sent ends the dialog like `released`: nobody logs it.
  const t = setup({ setTimer: manualTimers().setTimer });
  const other = holdDialog(t);
  t.service.took(other.terminalId, 'd1');
  assert.deepEqual(t.ended, [[other.held.id, 'terminal']]);
  await tick();
  assert.deepEqual(dialogRecords(t), []);
});
