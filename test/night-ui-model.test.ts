// Pure data shaping behind the night shift panel (public/features/night-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autopilotState, defaultUntil, manualOnBody, pendingTitle, reportRow, reportRows, reportSummary, stripCalls, telegramAnswersView, verdictBadge } from '../public/features/night-model.js';
import { MESSAGES, translate } from '../public/i18n.js';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';

test('verdict badges map ok, doubtful and wrong to tones; a missing, null or unknown judgment has no badge', () => {
  assert.deepEqual(verdictBadge({ verdict: 'ok', note: 'fits the mission' }), { verdict: 'ok', tone: 'ok', note: 'fits the mission' });
  assert.deepEqual(verdictBadge({ verdict: 'doubtful', note: '' }), { verdict: 'doubtful', tone: 'warn', note: '' });
  assert.deepEqual(verdictBadge({ verdict: 'wrong' }), { verdict: 'wrong', tone: 'danger', note: '' });
  assert.equal(verdictBadge(undefined), null);
  assert.equal(verdictBadge(null), null);
  assert.equal(verdictBadge({ verdict: 'maybe', note: 'x' }), null);
});

const base = {
  terminalId: 't1',
  workspaceId: 'dev',
  rel: 'tools/mirador',
  tool: null,
  question: null,
  policy: { allowed: true },
  decision: null,
  followUp: null,
  sent: 'none',
  delivered: null,
  deferral: null,
  error: null,
};

const answered = {
  ...base,
  id: 'r1',
  time: '2026-10-28T03:00:00.000Z',
  kind: 'question',
  tool: 'ask_user_choice',
  question: {
    allowCustomResponse: false,
    items: [
      { question: 'Which test runner?', header: 'Runner', options: ['node:test', 'vitest'], multiSelect: false },
      { question: 'Keep the fixtures?', header: 'Fixtures', options: ['Yes', 'No'], multiSelect: false },
    ],
  },
  decision: { action: 'answer', choices: [{ item: 0, index: 0, label: 'node:test' }, { item: 1, index: 1, label: 'No' }], reason: 'the mission asks for no new dependencies', confidence: 0.86 },
  sent: 'decided',
  outcome: 'decided',
  judgment: { verdict: 'ok', note: 'follows the mission' },
  feedback: { verdict: 'right', note: '', time: '2026-10-28T09:00:00.000Z' },
};

const followedUp = {
  ...base,
  id: 'r2',
  time: '2026-10-28T04:00:00.000Z',
  kind: 'delegate',
  followUp: { action: 'follow-up', message: 'Go on with the next task of the plan.', reason: 'the agent recommended it', confidence: 0.912 },
  sent: 'message',
  delivered: true,
  outcome: 'followed-up',
};

const deferred = {
  ...base,
  id: 'r3',
  time: '2026-10-28T02:00:00.000Z',
  kind: 'question',
  tool: 'ask_user_question',
  question: { allowCustomResponse: true, items: [{ question: '', header: 'Deploy', options: ['Now', 'Later'], multiSelect: false }] },
  policy: { allowed: false, rule: 'deploy', reason: 'mentions a deploy' },
  sent: 'pass',
  outcome: 'deferred',
  deferral: { rule: 'deploy', reason: 'mentions a deploy' },
  judgment: null,
  feedback: null,
};

test('a decided question becomes a report row with its question, choices, reason, confidence, verdict and feedback', () => {
  assert.deepEqual(reportRow(answered), {
    id: 'r1',
    time: '2026-10-28T03:00:00.000Z',
    terminalId: 't1',
    workspaceId: 'dev',
    folders: ['tools', 'mirador'],
    type: 'question',
    from: null,
    question: 'Which test runner?',
    moreQuestions: 1,
    outcome: 'decided',
    choices: ['node:test', 'No'],
    message: null,
    delivered: null,
    reason: 'the mission asks for no new dependencies',
    rule: null,
    confidence: 86,
    verdict: { verdict: 'ok', tone: 'ok', note: 'follows the mission' },
    feedback: { verdict: 'right', note: '' },
    error: null,
  });
});

test('a delegated or finished agent is a follow-up row with Mirador message and no question', () => {
  const row = reportRow(followedUp);
  assert.equal(row.type, 'follow-up');
  assert.equal(row.question, null);
  assert.equal(row.moreQuestions, 0);
  assert.equal(row.message, 'Go on with the next task of the plan.');
  assert.equal(row.choices, null);
  assert.equal(row.delivered, true);
  assert.equal(row.confidence, 91);
  assert.equal(row.verdict, null, 'no judgment yet: no badge');
  assert.equal(row.feedback, null);
  assert.equal(row.outcome, 'followed-up');
  assert.equal(reportRow({ ...followedUp, kind: 'finished' }).type, 'follow-up', 'any non-question kind is a follow-up');
});

test('a deferred question keeps the deferral reason and rule, falls back to the header and has no choice or confidence', () => {
  const row = reportRow(deferred);
  assert.equal(row.question, 'Deploy');
  assert.equal(row.outcome, 'deferred');
  assert.equal(row.choices, null);
  assert.equal(row.reason, 'mentions a deploy');
  assert.equal(row.rule, 'deploy');
  assert.equal(row.confidence, null);
  assert.equal(row.verdict, null);
  const failed = reportRow({ ...deferred, deferral: null, policy: { allowed: true }, error: 'decider timed out', outcome: 'dropped' });
  assert.equal(failed.outcome, 'dropped');
  assert.equal(failed.reason, 'decider timed out');
  assert.equal(failed.error, 'decider timed out');
  assert.equal(reportRow({ ...deferred, outcome: 'strange' }).outcome, null, 'an unknown outcome is not guessed');
  assert.equal(reportRow({ ...answered, decision: { ...answered.decision, confidence: 7 } }).confidence, null, 'a confidence outside 0-1 is not shown');
  assert.deepEqual(reportRow({ ...answered, feedback: { verdict: 'wrong', note: 'ask me first' } }).feedback, { verdict: 'wrong', note: 'ask me first' });
  assert.equal(reportRow({ ...answered, feedback: { verdict: 'meh' } }).feedback, null);
});

test('report rows put the newest record first', () => {
  assert.deepEqual(reportRows([deferred, answered, followedUp]).map((row) => row.id), ['r2', 'r1', 'r3']);
  assert.deepEqual(reportRows(undefined), []);
});

test('the report summary keeps the known numbers of the server, in order, and hides missing ones', () => {
  assert.deepEqual(reportSummary({ since: 'x', decided: 3, followUps: 1, deferred: 2, wrong: 0 }, []), [
    { key: 'decided', count: 3 },
    { key: 'followUps', count: 1 },
    { key: 'deferred', count: 2 },
    { key: 'wrong', count: 0 },
  ]);
});

test('without a server summary (the log fallback) the report summary is counted from the records', () => {
  assert.deepEqual(reportSummary(null, [answered, followedUp, deferred, { ...deferred, id: 'r4', judgment: { verdict: 'wrong' } }]), [
    { key: 'decided', count: 1 },
    { key: 'followUps', count: 1 },
    { key: 'deferred', count: 2 },
    { key: 'doubtful', count: 0 },
    { key: 'wrong', count: 1 },
  ]);
  assert.deepEqual(
    reportSummary(undefined, [followedUp, deferred]).map((entry) => entry.key),
    ['decided', 'followUps', 'deferred'],
    'no record was judged: the judge counts are hidden, not zero',
  );
});

/* ---------- Schedule form, notes and the bedtime view ---------- */

import { WEEK_ORDER, bedtimeView, checkNote, checkScheduleForm, scheduleForm } from '../public/features/night-model.js';

test('the schedule form starts from the saved schedule, Monday first', () => {
  assert.deepEqual(WEEK_ORDER, [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(scheduleForm({ enabled: true, days: [0, 5], start: '23:00', end: '07:00', remindBeforeMinutes: 30 }), { enabled: true, days: [0, 5], start: '23:00', end: '07:00', remind: '30' });
  assert.deepEqual(scheduleForm(null), { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', remind: '30' }, 'the server default when nothing loaded');
});

test('checkScheduleForm builds the PUT body or says what to fix, field by field', () => {
  assert.deepEqual(checkScheduleForm({ enabled: true, days: [5, 1], start: '22:30', end: '06:00', remind: ' 45 ' }), {
    schedule: { enabled: true, days: [1, 5], start: '22:30', end: '06:00', remindBeforeMinutes: 45 },
    errors: {},
  });
  assert.deepEqual(checkScheduleForm({ enabled: false, days: [], start: '23:00', end: '07:00', remind: '' }).schedule, { enabled: false, days: [], start: '23:00', end: '07:00', remindBeforeMinutes: 0 }, 'an empty reminder is no reminder; off needs no day');
  const wrong = checkScheduleForm({ enabled: true, days: [], start: '', end: '25:00', remind: '300' });
  assert.equal(wrong.schedule, null);
  assert.deepEqual(wrong.errors, { days: 'night.schedule.error.days', start: 'night.schedule.error.time', end: 'night.schedule.error.time', remind: 'night.schedule.error.remind' });
  assert.deepEqual(checkScheduleForm({ enabled: true, days: [1], start: '23:00', end: '23:00', remind: '30' }).errors, { end: 'night.schedule.error.same' });
  assert.deepEqual(checkScheduleForm({ enabled: true, days: [1], start: '23:00', end: '07:00', remind: '2.5' }).errors, { remind: 'night.schedule.error.remind' });
});

test('checkNote trims, counts characters and names the problem', () => {
  assert.deepEqual(checkNote('  Finish N5.  '), { text: 'Finish N5.', error: null, length: 10 });
  assert.deepEqual(checkNote('   '), { text: '', error: 'night.notes.error.empty', length: 0 });
  assert.equal(checkNote('ñ'.repeat(2000)).error, null);
  assert.equal(checkNote('ñ'.repeat(2001)).error, 'night.notes.error.long');
});

test('bedtimeView joins the reminder and the notes per workspace and agent, in sidebar order', () => {
  const reminder = {
    workspaces: [
      { workspaceId: 'ops', name: 'Ops', hasMission: false, missionNote: 'none', agents: [{ terminalId: 't3', rel: 'infra', title: 'infra', state: 'blocked', connected: true, activity: null, waitingFor: 'Pick one', closingQuestion: null }] },
      { workspaceId: 'dev', name: 'Dev', hasMission: true, missionNote: null, agents: [
        { terminalId: 't1', rel: 'alpha', title: 'alpha', state: 'finished', connected: true, activity: '◐ Schedule', waitingFor: null, closingQuestion: '¿Sigo?' },
        { terminalId: 't2', rel: '', title: 'root', state: 'working', connected: false, activity: null, waitingFor: null, closingQuestion: null },
      ] },
    ],
  };
  const notes = [
    { id: 'n1', workspaceId: 'dev', terminalId: 't1', text: 'Go on', createdAt: '2026-10-28T22:00:00Z', delivered: false, sensitive: null },
    { id: 'n2', workspaceId: 'dev', text: 'All of you', createdAt: '2026-10-28T22:01:00Z', delivered: true, deliveredAt: '2026-10-29T02:00:00Z', sensitive: null },
    { id: 'n3', workspaceId: 'gone', text: 'Old workspace', createdAt: '2026-10-28T22:02:00Z', delivered: false, pendingReason: 'no agent terminal of this workspace is open', sensitive: null },
    { id: 'n4', workspaceId: 'dev', terminalId: 'closed', text: 'For a closed one', createdAt: '2026-10-28T22:03:00Z', delivered: false, pendingReason: 'the terminal is closed', sensitive: 'production' },
  ];
  const view = bedtimeView(reminder, notes, ['dev', 'ops']);
  assert.deepEqual(view.map((w) => w.workspaceId), ['dev', 'ops', 'gone']);
  const dev = view[0];
  assert.deepEqual(dev.agents.map((a) => [a.terminalId, a.folders, a.notes.map((n) => n.id)]), [['t1', ['alpha'], ['n1']], ['t2', [], []]]);
  assert.deepEqual(dev.notes.map((n) => n.id), ['n2'], 'workspace notes');
  assert.deepEqual(dev.otherNotes.map((n) => n.id), ['n4'], 'notes for terminals no longer listed');
  assert.equal(dev.needsYou, 0);
  assert.equal(view[1].needsYou, 1, 'agents waiting for an answer');
  assert.equal(view[1].hasMission, false);
  assert.deepEqual(view[2], { workspaceId: 'gone', name: null, hasMission: null, agents: [], notes: [notes[2]], otherNotes: [], needsYou: 0 });
  assert.deepEqual(bedtimeView(null, [], []), []);
});

test('a note record is a note row with the user’s text, never a follow-up of Mirador', () => {
  const record = { id: 'r', time: '2026-10-29T02:00:00Z', kind: 'note', terminalId: 't1', workspaceId: 'dev', rel: 'alpha', tool: null, question: null, policy: { allowed: true, rule: 'note' }, decision: null, followUp: null, sent: 'message', delivered: true, outcome: 'followed-up', deferral: null, error: null, note: { id: 'n1', text: 'Go on' } };
  const row = reportRow(record);
  assert.equal(row.type, 'note');
  assert.equal(row.message, 'Go on');
  assert.equal(row.delivered, true);
  assert.equal(row.from, 'user', 'a note without `from` is the user’s');
  assert.equal(reportRow({ ...record, note: { ...record.note, from: LEGACY_USER_VALUES.cause } }).from, 'user', 'an old record with the pre-F5 owner value is the user’s (F5)');
});

test('a note Mirador sent before putting an idle agent to sleep is a note row from Mirador', () => {
  const record = { id: 'r', time: '2026-10-29T02:00:00Z', kind: 'note', terminalId: 't1', workspaceId: 'dev', rel: 'alpha', tool: null, question: null, policy: { allowed: true, rule: 'note' }, decision: null, followUp: null, sent: 'message', delivered: true, outcome: 'followed-up', deferral: null, error: null, note: { id: '', text: 'Save your session summary.', from: 'mirador' } };
  const row = reportRow(record);
  assert.equal(row.type, 'note');
  assert.equal(row.from, 'mirador');
  assert.equal(row.message, 'Save your session summary.');
  assert.equal(reportRow({ ...record, note: { ...record.note, from: 'someone' } }).from, 'user', 'an unknown sender is not guessed as Mirador');
  assert.equal(reportRow(followedUp).from, null, 'only notes have a sender');
});

/* ---------- Resource profiles and the budget meter ---------- */

import { budgetMeter, profileTable, profileValue, refreshMs, reportCalls } from '../public/features/night-model.js';

const PROFILES_VIEW = {
  profile: 'ahorro',
  values: { nightBudget: 60, improveBudget: 100, nightModel: 'claude-sonnet-5-5', judgeMode: 'doubtful-only', maxConcurrent: 1, engramCacheMs: 60000, trackingRefreshMs: 30000 },
  overridden: ['nightModel'],
  profiles: {
    ahorro: { nightBudget: 60, improveBudget: 100, nightModel: 'claude-haiku-5-5', judgeMode: 'doubtful-only', maxConcurrent: 1, engramCacheMs: 60000, trackingRefreshMs: 30000 },
    equilibrado: { nightBudget: 150, improveBudget: 300, nightModel: 'claude-sonnet-5-5', judgeMode: 'every', maxConcurrent: 2, engramCacheMs: 20000, trackingRefreshMs: 15000 },
    potencia: { nightBudget: 400, improveBudget: 1000, nightModel: 'claude-opus-5-5', judgeMode: 'every', maxConcurrent: 4, engramCacheMs: 10000, trackingRefreshMs: 10000 },
  },
  budget: { night: { used: 48, limit: 60 }, improveToday: { used: 3, limit: 100 } },
};

test('the profile table has one column per profile in a fixed order and one row per knob, overrides marked', () => {
  const table = profileTable(PROFILES_VIEW);
  assert.deepEqual(table.columns, ['ahorro', 'equilibrado', 'potencia']);
  assert.equal(table.selected, 'ahorro');
  assert.deepEqual(table.rows.map((row) => row.key), ['nightBudget', 'improveBudget', 'nightModel', 'judgeMode', 'maxConcurrent', 'engramCacheMs', 'trackingRefreshMs']);
  const model = table.rows.find((row) => row.key === 'nightModel');
  assert.deepEqual(model, { key: 'nightModel', values: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], effective: 'claude-sonnet-5-5', overridden: true });
  assert.equal(table.rows.find((row) => row.key === 'nightBudget').overridden, false);
  assert.equal(profileTable(null), null);
  assert.equal(profileTable({ profile: 'ahorro' }), null);
});

test('profile values read as short text: models by name, times in seconds, judge mode as an i18n key', () => {
  assert.deepEqual(profileValue('nightModel', 'claude-opus-5-5'), { text: 'Opus 5.5' });
  assert.deepEqual(profileValue('nightModel', 'claude-custom'), { text: 'claude-custom' });
  assert.deepEqual(profileValue('engramCacheMs', 60000), { text: '60 s' });
  assert.deepEqual(profileValue('trackingRefreshMs', 10000), { text: '10 s' });
  assert.deepEqual(profileValue('judgeMode', 'doubtful-only'), { key: 'night.profile.judge.doubtful-only' });
  assert.deepEqual(profileValue('nightBudget', 150), { text: '150' });
});

test('the budget meter shows used/limit and a tone per counter; a missing budget shows nothing', () => {
  assert.deepEqual(budgetMeter(PROFILES_VIEW.budget), [
    { key: 'night', used: 48, limit: 60, percent: 80, tone: 'warn' },
    { key: 'improveToday', used: 3, limit: 100, percent: 3, tone: 'ok' },
  ]);
  assert.deepEqual(budgetMeter({ night: { used: 70, limit: 60 } }), [{ key: 'night', used: 70, limit: 60, percent: 100, tone: 'danger' }]);
  assert.deepEqual(budgetMeter({ night: { used: 0, limit: 0 } }), [{ key: 'night', used: 0, limit: 0, percent: 100, tone: 'danger' }]);
  assert.deepEqual(budgetMeter(undefined), []);
});

test('the tracking refresh follows the profile, within 5 s and 5 min, else 15 s; the report calls come from the summary', () => {
  assert.equal(refreshMs(PROFILES_VIEW), 30000);
  assert.equal(refreshMs({ values: { trackingRefreshMs: 10000 } }), 10000);
  assert.equal(refreshMs({ values: { trackingRefreshMs: 100 } }), 15000);
  assert.equal(refreshMs(null), 15000);
  assert.deepEqual(reportCalls({ decided: 1, calls: { used: 3, limit: 60 } }), { used: 3, limit: 60 });
  assert.equal(reportCalls({ decided: 1 }), null);
});

test('redrawNodes drops null and undefined, which replaceChildren would print as "null"', async () => {
  const { redrawNodes } = await import('../public/features/night-model.js');
  assert.deepEqual(redrawNodes(['a', null, undefined, ['b', null], 'c']), ['a', 'b', 'c']);
});

/* ---------- Autopilot ---------- */

test('defaultUntil: two hours ahead, rounded up to the quarter hour, as local HH:MM in the zone', () => {
  // 2026-10-29 08:07 in Santiago (UTC-3).
  assert.equal(defaultUntil(Date.parse('2026-10-29T11:07:00Z'), 'America/Santiago'), '10:15');
  assert.equal(defaultUntil(Date.parse('2026-10-29T11:00:00Z'), 'America/Santiago'), '10:00', 'already on a quarter');
  assert.equal(defaultUntil(Date.parse('2026-10-30T01:50:00Z'), 'America/Santiago'), '01:00', '22:50: past midnight');
});

test('manualOnBody: "until I turn it off" sends {active} alone; "until HH:MM" sends the time; anything else is an error key', () => {
  assert.deepEqual(manualOnBody('off', ''), { body: { active: true } });
  assert.deepEqual(manualOnBody('off', '25:00'), { body: { active: true } }, 'the time field is ignored');
  assert.deepEqual(manualOnBody('time', '21:30'), { body: { active: true, until: '21:30' } });
  for (const time of ['', '7:00', '24:00', '21:60', ' 21:30']) assert.deepEqual(manualOnBody('time', time), { error: 'night.until.error' }, time);
});

test('autopilotState: off says nothing; on says who switched it on, since when and until when', () => {
  assert.equal(autopilotState(null), null);
  assert.equal(autopilotState({ active: false, since: 'x', source: null, until: null }), null);
  assert.deepEqual(autopilotState({ active: true, since: 'S', source: 'manual', until: null }), { key: 'night.state.onManual', since: 'S', until: null });
  assert.deepEqual(autopilotState({ active: true, since: 'S', source: 'manual', until: 'U' }), { key: 'night.state.onManualUntil', since: 'S', until: 'U' });
  assert.deepEqual(autopilotState({ active: true, since: 'S', source: 'schedule', until: null }), { key: 'night.state.onSchedule', since: 'S', until: null });
  assert.deepEqual(autopilotState({ active: true, since: 'S' }), { key: 'night.state.onSince', since: 'S', until: null }, 'a server without sources');
  assert.deepEqual(autopilotState({ active: true, since: null }), { key: 'night.state.on', since: null, until: null });
});

test('stripCalls: on by hand the calls have no limit (count only); otherwise used of limit with its tone (D2)', () => {
  const budget = { night: { used: 7, limit: 5 }, improveToday: { used: 0, limit: 10 } };
  assert.deepEqual(stripCalls(budget, { active: true, source: 'manual' }), { used: 7, limit: null, uncapped: true, percent: null, tone: 'ok' });
  assert.deepEqual(stripCalls(budget, { active: true, source: 'schedule' }), { used: 7, limit: 5, uncapped: false, percent: 100, tone: 'danger' });
  assert.deepEqual(stripCalls({ night: { used: 4, limit: 5 } }, { active: false, source: null }), { used: 4, limit: 5, uncapped: false, percent: 80, tone: 'warn' }, 'off: a delegation by hand is still capped');
  assert.equal(stripCalls(null, { active: true, source: 'manual' }), null);
  assert.equal(stripCalls({ night: { used: 'x', limit: 5 } }, null), null);
});

test('the night model no longer exports groupPending', async () => {
  const nightModel = await import('../public/features/night-model.js');
  assert.equal('groupPending' in nightModel, false);
});

test('pendingTitle: a follow-up card is titled by its kind in the panel language; a question keeps its text (S6)', () => {
  const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
  const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
  const auto = { kind: 'auto-follow-up', summary: 'Automatic follow-up for a finished agent' };
  assert.equal(pendingTitle(auto, es), 'Continuación automática de un agente que terminó');
  assert.equal(pendingTitle(auto, en), 'Automatic follow-up for a finished agent');
  const delegated = { kind: 'delegate', summary: 'Follow-up for a finished agent' };
  assert.equal(pendingTitle(delegated, es), 'Continuación de un agente que terminó');
  assert.equal(pendingTitle(delegated, en), 'Follow-up for a finished agent');
  const question = { kind: 'question', summary: '¿Hacemos deploy a producción?' };
  assert.equal(pendingTitle(question, es), '¿Hacemos deploy a producción?');
  assert.equal(pendingTitle(question, en), '¿Hacemos deploy a producción?');
  assert.equal(pendingTitle({ kind: 'something-new', summary: 'Server text' }, es), 'Server text', 'an unknown kind keeps the server text');
  assert.equal(pendingTitle({ kind: 'something-new', summary: '' }, es), '(sin texto)');
  assert.equal(pendingTitle({ kind: 'question' }, en), '(no text)');
});

/* ---------- "Antes de dormir": pending agents and agents with a note ---------- */

import { BEDTIME_TABS, bedtimeTab, bedtimeTabs } from '../public/features/night-model.js';

test('bedtimeTabs: an agent with a note not delivered yet, or delivered since the autopilot turned on, goes to "Con nota"', () => {
  const reminder = {
    workspaces: [
      { workspaceId: 'dev', name: 'Dev', hasMission: true, agents: [
        { terminalId: 't1', rel: 'alpha', state: 'working' },
        { terminalId: 't2', rel: 'beta', state: 'working' },
        { terminalId: 't3', rel: 'gamma', state: 'finished' },
      ] },
      { workspaceId: 'ops', name: 'Ops', hasMission: true, agents: [{ terminalId: 't4', rel: '', state: 'blocked' }] },
    ],
  };
  const notes = [
    { id: 'n1', workspaceId: 'dev', terminalId: 't1', text: 'Sigue con los tests', createdAt: '2026-11-02T22:00:00Z', delivered: false },
    { id: 'n2', workspaceId: 'dev', terminalId: 't2', text: 'Anoche', createdAt: '2026-11-01T22:00:00Z', delivered: true, deliveredAt: '2026-11-01T23:00:00Z' },
    { id: 'n3', workspaceId: 'dev', terminalId: 't3', text: 'Esta noche', createdAt: '2026-11-02T22:10:00Z', delivered: true, deliveredAt: '2026-11-02T23:05:00Z' },
    { id: 'n4', workspaceId: 'dev', text: 'Para todos', createdAt: '2026-11-02T22:20:00Z', delivered: false },
  ];
  const entries = bedtimeView(reminder, notes, ['dev', 'ops']);
  const on = bedtimeTabs(entries, { active: true, since: '2026-11-02T23:00:00Z' });
  assert.deepEqual(on.counts, { pending: 2, noted: 2 });
  assert.deepEqual(on.pending.map((e) => [e.workspaceId, e.agents.map((a) => a.terminalId)]), [['dev', ['t2']], ['ops', ['t4']]], 'a workspace keeps its block, notes and form');
  assert.deepEqual(on.pending[0].notes.map((n) => n.id), ['n4'], 'a workspace note moves no agent');
  assert.deepEqual(on.pending[0].agents[0].notes.map((n) => n.id), ['n2'], "last night's note stays under its agent");
  assert.deepEqual(on.noted.map((e) => [e.workspaceId, e.agents.map((a) => [a.terminalId, a.tonight.map((n) => n.id)])]), [['dev', [['t1', ['n1']], ['t3', ['n3']]]]]);

  const off = bedtimeTabs(entries, { active: false, since: null });
  assert.deepEqual(off.counts, { pending: 3, noted: 1 }, 'with the autopilot off only notes not delivered yet count');
  assert.deepEqual(off.noted[0].agents.map((a) => a.terminalId), ['t1']);
  assert.deepEqual(bedtimeTabs([], null), { counts: { pending: 0, noted: 0 }, pending: [], noted: [] });
});

test('bedtimeTab keeps a known tab and otherwise opens "Pendientes"', () => {
  assert.deepEqual(BEDTIME_TABS, ['pending', 'noted']);
  assert.equal(bedtimeTab('noted'), 'noted');
  assert.equal(bedtimeTab('other'), 'pending');
  assert.equal(bedtimeTab(null), 'pending');
});

test('the tab labels carry their counts in both languages', () => {
  assert.equal(translate('es', 'night.bedtime.tab.pending', { count: 3 }), 'Pendientes (3)');
  assert.equal(translate('es', 'night.bedtime.tab.noted', { count: 2 }), 'Con nota (2)');
  assert.equal(translate('en', 'night.bedtime.tab.pending', { count: 3 }), 'Pending (3)');
  assert.equal(translate('en', 'night.bedtime.tab.noted', { count: 2 }), 'With a note (2)');
});

/* ---------- The night queue ---------- */

import { checkSlots, notePlan, noteQueueText, queueAdvice, queueLine } from '../public/features/night-model.js';

const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const GIB = 1024 ** 3;

test('queueLine: the strip says how many work of N and how many wait, in both languages; nothing without a queue', () => {
  const full = { slots: 5, working: 5, queued: 3, memoryWait: false, items: [] };
  assert.equal(queueLine(full, es), 'Trabajando 5 de 5 · 3 en cola');
  assert.equal(queueLine(full, en), 'Working 5 of 5 · 3 queued');
  assert.equal(queueLine({ ...full, working: 2, queued: 0 }, es), 'Trabajando 2 de 5');
  assert.equal(queueLine({ ...full, working: 1, queued: 1, memoryWait: true }, es), 'Trabajando 1 de 5 · 1 en cola · esperando memoria libre');
  assert.equal(queueLine({ ...full, working: 1, queued: 1, memoryWait: true }, en), 'Working 1 of 5 · 1 queued · waiting for free memory');
  assert.equal(queueLine(undefined, es), null);
  assert.equal(queueLine({ slots: 'x' }, es), null);
});

test('queueAdvice: the recommendation for the machine, in whole GB, and the N the user chose when they changed it', () => {
  const machine = { slots: 5, suggested: 5, custom: false, memTotal: 23_935 * 1024 ** 2 };
  assert.equal(queueAdvice(machine, es), 'Para tus 24 GB: hasta 5 agentes trabajando a la vez');
  assert.equal(queueAdvice(machine, en), 'For your 24 GB: up to 5 agents working at once');
  assert.equal(queueAdvice({ slots: 1, suggested: 1, custom: false, memTotal: 7.6 * GIB }, es), 'Para tus 8 GB: hasta 1 agente trabajando a la vez');
  assert.equal(queueAdvice({ ...machine, slots: 3, custom: true }, es), 'Para tus 24 GB: hasta 5 agentes trabajando a la vez · Elegiste 3');
  assert.equal(queueAdvice({ ...machine, slots: 3, custom: true }, en), 'For your 24 GB: up to 5 agents working at once · You chose 3');
  assert.equal(queueAdvice({ slots: 3, suggested: 3, custom: false, memTotal: null }, es), 'Sugerido: hasta 3 agentes trabajando a la vez');
  assert.equal(queueAdvice(null, es), null);
});

test('notePlan: while on, a queued note shows its place in the queue; while off, where it would start when the autopilot turns on', () => {
  const reminder = {
    workspaces: [{ workspaceId: 'dev', agents: [
      { terminalId: 'a', state: 'working' },
      { terminalId: 'b', state: 'finished' },
      { terminalId: 'c', state: 'blocked' },
      { terminalId: 'd', state: 'finished' },
    ] }],
  };
  const note = (id: string, terminalId: string | undefined, createdAt: string, delivered = false) => ({ id, workspaceId: 'dev', ...(terminalId ? { terminalId } : {}), text: id, createdAt, delivered });
  const notes = [
    note('n-d', 'd', '2026-11-02T22:03:00Z'),
    note('n-a', 'a', '2026-11-02T22:00:00Z'),
    note('n-b', 'b', '2026-11-02T22:01:00Z'),
    note('n-c', 'c', '2026-11-02T22:02:00Z'),
    note('n-b2', 'b', '2026-11-02T22:04:00Z'),
    note('n-ws', undefined, '2026-11-02T22:05:00Z'),
    note('n-old', 'b', '2026-11-01T22:00:00Z', true),
  ];
  // Off with N = 2: A works already (it gets its note at once); B takes the free slot; C and D wait.
  const off = notePlan(reminder, notes, { slots: 2 }, false);
  assert.deepEqual(Object.fromEntries(off), {
    'n-a': { state: 'working' },
    'n-b': { state: 'now' },
    'n-b2': { state: 'now' },
    'n-c': { state: 'queued', position: 1 },
    'n-d': { state: 'queued', position: 2 },
  });
  assert.equal(noteQueueText(off.get('n-c'), false, es), 'Al activarse el piloto espera en la cola: n.º 1');
  assert.equal(noteQueueText(off.get('n-b'), false, es), 'Al activarse el piloto arranca enseguida');
  assert.equal(noteQueueText(off.get('n-a'), false, es), 'Está trabajando: la recibe en cuanto se active el piloto');
  assert.equal(noteQueueText(off.get('n-c'), false, en), 'When the autopilot turns on it waits in the queue: #1');

  // On: the server's queue decides.
  const on = notePlan(reminder, notes, { slots: 2, items: [{ terminalId: 'd', kind: 'note' }, { terminalId: 'c', kind: 'follow-up' }, { terminalId: 'c', kind: 'note' }] }, true);
  assert.deepEqual(Object.fromEntries(on), { 'n-d': { state: 'queued', position: 1 }, 'n-c': { state: 'queued', position: 3 } });
  assert.equal(noteQueueText(on.get('n-c'), true, es), 'En cola: n.º 3. La recibe cuando otro agente termine su turno o quede esperando tu decisión.');
  assert.equal(noteQueueText(on.get('n-c'), true, en), "Queued: #3. It gets it when another agent finishes its turn or waits for your decision.");
  assert.equal(noteQueueText(undefined, true, es), null);
  assert.equal(notePlan(reminder, notes, null, false).size, 0, 'no queue settings, no plan');
});

test('checkSlots: a whole number from 1 to 50; anything else is an error key', () => {
  assert.deepEqual(checkSlots('5'), { slots: 5, error: null });
  assert.deepEqual(checkSlots(' 50 '), { slots: 50, error: null });
  assert.deepEqual(checkSlots('1'), { slots: 1, error: null });
  for (const value of ['', ' ']) assert.deepEqual(checkSlots(value), { slots: null, error: 'night.queue.error.empty' }, JSON.stringify(value));
  for (const value of ['0', '51', '2.5', 'cinco', '-1', '1e1']) assert.deepEqual(checkSlots(value), { slots: null, error: 'night.queue.error.range' }, value);
  assert.equal(translate('es', 'night.queue.error.range'), 'Escribe un número entero de 1 a 50, por ejemplo 5.');
});

test('the «Responder desde Telegram» switch shows only for a configured bot, on when saved on and possible, with a hint for why it cannot be', () => {
  const configured = { configured: true, chatIdMasked: '•••242' };
  assert.equal(telegramAnswersView({ configured: false, chatIdMasked: null }, { enabled: false, available: false, privateChat: false }), null, 'no bot, no switch');
  assert.equal(telegramAnswersView(null, null), null, 'still loading');
  assert.equal(telegramAnswersView(configured, null), null, 'a server without the setting');
  assert.deepEqual(telegramAnswersView(configured, { enabled: true, available: true, privateChat: true }), { checked: true, disabled: false, hint: 'night.telegram.answers.hint' });
  assert.deepEqual(telegramAnswersView(configured, { enabled: false, available: true, privateChat: true }), { checked: false, disabled: false, hint: 'night.telegram.answers.hint' });
  assert.deepEqual(telegramAnswersView(configured, { enabled: true, available: false, privateChat: false }), { checked: false, disabled: true, hint: 'night.telegram.answers.private' });
  assert.deepEqual(telegramAnswersView(configured, { enabled: true, available: false, privateChat: true }), { checked: false, disabled: true, hint: 'night.telegram.answers.unavailable' });
  for (const lang of ['es', 'en']) {
    for (const key of ['night.telegram.answers', 'night.telegram.answers.hint', 'night.telegram.answers.private', 'night.telegram.answers.unavailable', 'night.telegram.answers.savedOn', 'night.telegram.answers.savedOff', 'night.telegram.failed.answers']) {
      assert.equal(typeof (MESSAGES as Record<string, Record<string, string>>)[lang][key], 'string', `${lang}: ${key}`);
    }
  }
  assert.equal(translate('es', 'night.telegram.answers'), 'Responder desde Telegram');
  assert.equal(translate('en', 'night.telegram.answers'), 'Answer from Telegram');
});
