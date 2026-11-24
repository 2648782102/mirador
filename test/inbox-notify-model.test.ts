// What a browser notification says (public/features/inbox-notify-model.js): the title, the body's
// two lines and the options for each kind of card, for a burst of cards and in discreet mode.
// Pure: no DOM, no Notification class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentText, asksYou, cardNotification, GROUP_AT, GROUP_TAG, GUARDED_LABEL, groupNotification, NOTIFY_DISCREET_PREF, NOTIFY_STAY_PREF } from '../public/features/inbox-notify-model.js';

const T0 = '2026-10-28T10:00:00.000Z';
const T1 = '2026-10-28T10:05:00.000Z';
const item = (terminalId: string, kind: string, extra: Record<string, unknown> = {}) => ({ terminalId, workspaceId: 'dev', rel: 'web/mi-proyecto', title: 'mi-proyecto', kind, label: 'Awaiting input', detail: null, since: T0, activity: null, ...extra });
const waiting = (count: number) => (count === 1 ? 'An agent is waiting for you' : `${count} agents are waiting for you`);
const text = (extra: Record<string, unknown> = {}) => ({ reason: 'Needs you to choose', workspace: 'Dev', agent: 'Claude Code', lang: 'en', waiting, ...extra });
const IMAGES = { icon: '/notify-icon.png', badge: '/notify-badge.png' };

test('each kind of card: "{project} · {reason}", the question then "{agent} · {path}", and its options', () => {
  assert.deepEqual(cardNotification(item('t1', 'blocked', { detail: 'Which database should I use?' }), text()), {
    title: 'mi-proyecto · Needs you to choose',
    options: { body: 'Which database should I use?\nClaude Code · Dev › web › mi-proyecto', tag: `mirador-inbox:t1:${T0}`, requireInteraction: true, ...IMAGES, lang: 'en', timestamp: Date.parse(T0) },
  });
  assert.deepEqual(cardNotification(item('t2', 'prompt', { since: T1 }), text({ reason: 'Waiting for your answer', lang: 'es' })), {
    title: 'mi-proyecto · Waiting for your answer',
    options: { body: 'Claude Code · Dev › web › mi-proyecto', tag: `mirador-inbox:t2:${T1}`, requireInteraction: true, ...IMAGES, lang: 'es', timestamp: Date.parse(T1) },
  });
  assert.deepEqual(cardNotification(item('t3', 'error', { label: 'Error', detail: 'Build failed' }), text({ reason: 'Stopped with an error' })), {
    title: 'mi-proyecto · Stopped with an error',
    options: { body: 'Build failed\nClaude Code · Dev › web › mi-proyecto', tag: `mirador-inbox:t3:${T0}`, requireInteraction: false, ...IMAGES, lang: 'en', timestamp: Date.parse(T0) },
  });
  assert.deepEqual(['blocked', 'prompt', 'error', 'finished'].map((kind) => asksYou(item('t', kind))), [true, true, false, false]);
});

test('a guarded command: only "{project} · {reason}", never the command (it may carry a token); same tag and options', () => {
  assert.equal(GUARDED_LABEL, 'Guarded command confirmation');
  const guarded = item('t1', 'blocked', { label: GUARDED_LABEL, detail: 'TOKEN=abc123 deploy' });
  const shown = cardNotification(guarded, text({ reason: 'Confirm a guarded command' }));
  assert.deepEqual(shown, {
    title: 'mi-proyecto · Confirm a guarded command',
    options: { body: '', tag: `mirador-inbox:t1:${T0}`, requireInteraction: true, ...IMAGES, lang: 'en', timestamp: Date.parse(T0) },
  });
  assert.doesNotMatch(JSON.stringify(shown), /abc123|deploy|Claude|Dev ›/);
  assert.equal(cardNotification(guarded, text({ discreet: true })).title, 'An agent is waiting for you', 'discreet mode unchanged');
  const questionnaire = item('t2', 'blocked', { label: 'Questionnaire awaiting input', detail: 'Which database should I use?' });
  assert.equal(cardNotification(questionnaire, text()).options.body, 'Which database should I use?\nClaude Code · Dev › web › mi-proyecto');
});

test('at the workspace root the project is the workspace; without an agent the second line is only the path', () => {
  const root = cardNotification(item('t1', 'blocked', { rel: '' }), text());
  assert.deepEqual([root.title, root.options.body], ['Dev · Needs you to choose', 'Claude Code · Dev']);
  const nobody = cardNotification(item('t1', 'blocked'), text({ agent: null }));
  assert.equal(nobody.options.body, 'Dev › web › mi-proyecto');
});

test('agent text is one line: no line breaks or control characters, cut at 120 characters', () => {
  assert.equal(agentText('Line one\r\nline two\t\u0007 and\u202E more\u2028end '), 'Line one line two and more end');
  const long = 'x'.repeat(300);
  assert.equal(agentText(long).length, 120);
  assert.ok(agentText(long).endsWith('…'));
  assert.equal(agentText('a'.repeat(120)), 'a'.repeat(120), 'exactly 120 is not cut');
  assert.equal([...agentText('😀'.repeat(200))].length, 120, 'cut by characters, never inside one');
  assert.equal(agentText(null), '');

  const shown = cardNotification(item('t1', 'blocked', { detail: `Pick one:\n1) ${'y'.repeat(200)}` }), text({ reason: 'Pick\none', agent: 'Claude\u0000 Code' }));
  const [line1, line2] = shown.options.body.split('\n');
  assert.equal(shown.title, 'mi-proyecto · Pick one');
  assert.equal(line1.length, 120);
  assert.ok(line1.startsWith('Pick one: 1) yyy'));
  assert.equal(line2, 'Claude Code · Dev › web › mi-proyecto');
  assert.equal(shown.options.body.split('\n').length, 2);
});

test('agent text drops every format character but the joiner', () => {
  // Arabic letter mark, soft hyphen, a tag character: invisible marks an agent could hide text with.
  assert.equal(agentText('a\u061Cb\u00ADc\u{E0041}d'), 'abcd');
  assert.equal(agentText('x\u{E0001}\u{E0000}\u{E007F}y\u200B\u2066z\uFEFF'), 'xyz');
  assert.equal(agentText('\u{1F468}\u200D\u{1F469}'), '\u{1F468}\u200D\u{1F469}', 'the zero-width joiner builds emoji');
  assert.equal(agentText('one\ntwo\u2029three'), 'one two three', 'line breaks still read as spaces');
});

test('discreet mode without its title text (waiting) does not throw: the English title stands in', () => {
  const card = item('t1', 'blocked', { detail: 'Delete the secret branch?' });
  const shown = cardNotification(card, { reason: 'Needs you to choose', workspace: 'Dev', agent: 'Claude Code', discreet: true });
  assert.deepEqual([shown.title, shown.options.body, shown.options.requireInteraction], ['An agent is waiting for you', '', true]);
  assert.doesNotMatch(JSON.stringify(shown), /mi-proyecto|secret|Dev|Claude|choose/);
  const entries = ['t1', 't2', 't3'].map((id) => ({ item: item(id, 'blocked'), workspace: 'Dev' }));
  assert.equal(groupNotification(entries, { discreet: true } as any).title, '3 agents are waiting for you');
});

test('the interaction switch: off, no card stays on screen by itself', () => {
  for (const kind of ['blocked', 'prompt', 'error']) {
    assert.equal(cardNotification(item('t1', kind), text({ stay: false })).options.requireInteraction, false, kind);
    assert.equal(cardNotification(item('t1', kind), text({ stay: true })).options.requireInteraction, kind !== 'error', kind);
  }
});

test('discreet mode: "An agent is waiting for you", no project, no question, no path; same tag and options', () => {
  const card = item('t1', 'blocked', { detail: 'Delete the secret branch?' });
  const shown = cardNotification(card, text({ discreet: true }));
  assert.deepEqual(shown, {
    title: 'An agent is waiting for you',
    options: { body: '', tag: `mirador-inbox:t1:${T0}`, requireInteraction: true, ...IMAGES, lang: 'en', timestamp: Date.parse(T0) },
  });
  assert.doesNotMatch(JSON.stringify(shown), /mi-proyecto|secret|Dev|Claude|choose/);
});

test('a burst: "{n} agents are waiting for you", the projects in the body, one stable tag', () => {
  const entries = [
    { item: item('t1', 'error', { since: T1 }), workspace: 'Dev' },
    { item: item('t2', 'blocked', { rel: 'api' }), workspace: 'Dev' },
    { item: item('t3', 'prompt', { rel: '' }), workspace: 'Notas' },
    { item: item('t4', 'error', { rel: 'otro/mi-proyecto' }), workspace: 'Dev' },
  ];
  assert.equal(GROUP_AT, 3);
  assert.deepEqual(groupNotification(entries, text()), {
    title: '4 agents are waiting for you',
    options: { body: 'mi-proyecto, api, Notas', tag: GROUP_TAG, requireInteraction: true, ...IMAGES, lang: 'en', timestamp: Date.parse(T0) },
  });
  assert.equal(GROUP_TAG, 'mirador-inbox:group');
  const errors = entries.filter((entry) => entry.item.kind === 'error');
  assert.equal(groupNotification([...errors, errors[0]], text()).options.requireInteraction, false, 'only errors: nothing asks');
  assert.equal(groupNotification(entries, text({ stay: false })).options.requireInteraction, false, 'the switch off');
});

test('a burst in discreet mode names no project', () => {
  const entries = ['t1', 't2', 't3'].map((id) => ({ item: item(id, 'blocked'), workspace: 'Dev' }));
  const shown = groupNotification(entries, text({ discreet: true }));
  assert.deepEqual([shown.title, shown.options.body, shown.options.tag], ['3 agents are waiting for you', '', GROUP_TAG]);
  assert.doesNotMatch(JSON.stringify(shown), /mi-proyecto|Dev/);
});

test('the preferences: their keys in localStorage', () => {
  assert.deepEqual([NOTIFY_STAY_PREF, NOTIFY_DISCREET_PREF], ['inboxNotifyStay', 'inboxNotifyDiscreet']);
});
