// "Where it left off" in three reading levels: which
// parts show for a folder's data, which folds start open, the one-line gist each fold takes
// from its own text, and when an agent waiting in the folder calls for action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GIST_KEYS, foldGist, leftOffLayout, listCount, pickCall, waitedFor } from '../public/leftoff-model.js';
import { MESSAGES, translate } from '../public/i18n.js';

const summary = {
  at: '2026-11-05 10:42:00',
  goal: 'Dialysis shift schedule with a quota per chair.',
  nextSteps: '- Push the branch and open the PR.\n- T4: WhatsApp notice 24 h before.',
  accomplished: '- T1 and T2: chair and shift model.\n  - with its migration\n- T3: the quota per chair.\n- 18 tests green.',
  excerpt: undefined,
};
const row = { lastAt: '2026-11-05 10:44:00', lastDay: '2026-11-05', hasMemory: true, leftOff: { summary, memory: null } };

test('S8: a full summary keeps everything the old card showed: goal, next steps, done, source', () => {
  assert.deepEqual(leftOffLayout(row), {
    read: ['goal'],
    folds: [
      { id: 'next', field: 'nextSteps', title: 'overview.nextSteps', open: true, gist: { kind: 'pending', count: 2, more: false } },
      { id: 'done', field: 'accomplished', title: 'overview.accomplished', open: false, gist: { kind: 'done', count: 3, more: false } },
    ],
    instead: null,
    foot: { lastWorked: true, source: true, since: false },
  });
});

test('S8: next steps open by default, done closed; done opens when there are no next steps', () => {
  const noNext = leftOffLayout({ ...row, leftOff: { summary: { ...summary, nextSteps: null }, memory: null } });
  assert.deepEqual(noNext.folds.map((f) => [f.id, f.open]), [['done', true]]);
  const noDone = leftOffLayout({ ...row, leftOff: { summary: { ...summary, accomplished: null }, memory: null } });
  assert.deepEqual(noDone.folds.map((f) => [f.id, f.open]), [['next', true]]);
});

test('S8: a free-form summary reads as its excerpt, with no folds', () => {
  const free = leftOffLayout({ ...row, leftOff: { summary: { at: summary.at, goal: null, nextSteps: null, accomplished: null, excerpt: 'Worked on the shifts.' }, memory: null } });
  assert.deepEqual(free.read, ['excerpt']);
  assert.deepEqual(free.folds, []);
  assert.deepEqual(free.foot, { lastWorked: true, source: true, since: false });
});

test('S8: a newer memory than the summary goes to the footer as "since then"', () => {
  const layout = leftOffLayout({ ...row, leftOff: { summary, memory: { title: 'Fix', type: 'bugfix', at: '2026-11-05 11:00:00' } } });
  assert.equal(layout.foot.since, true);
  const older = leftOffLayout({ ...row, leftOff: { summary, memory: { title: 'Old', type: 'bugfix', at: '2026-11-05 09:00:00' } } });
  assert.equal(older.foot.since, false);
});

test('S8: without a summary the block says what it has instead (latest memory, or why nothing)', () => {
  const memoryOnly = leftOffLayout({ ...row, leftOff: { summary: null, memory: { title: 'Fix', type: 'bugfix', at: '2026-11-05 11:00:00' } } });
  assert.deepEqual(memoryOnly, { read: [], folds: [], instead: 'latestMemory', foot: { lastWorked: true, source: false, since: false } });
  const none = leftOffLayout({ lastAt: null, lastDay: null, hasMemory: false, leftOff: { summary: null, memory: null } });
  assert.deepEqual(none, { read: [], folds: [], instead: 'missing', foot: { lastWorked: false, source: false, since: false } });
});

test('S8: the gist counts top-level list items only, and never invents a number', () => {
  assert.deepEqual(listCount('- a\n- b\n  - nested\n* c'), { count: 3, more: false });
  assert.deepEqual(listCount('1. one\n2) two'), { count: 2, more: false });
  assert.deepEqual(listCount('  - indented\n  - also'), { count: 2, more: false });
  // Free text has no items: no gist rather than a made-up count.
  assert.equal(listCount('Just a paragraph about the work.'), null);
  assert.equal(listCount(''), null);
  assert.equal(listCount(null), null);
  assert.equal(foldGist('Plain text.', 'pending'), null);
});

test('S8: a section the server clipped counts as "at least N"', () => {
  // src/memory/overview.ts clip(): "\n…" after the kept lines, or "…" after the kept characters.
  assert.deepEqual(listCount('- a\n- b\n…'), { count: 2, more: true });
  assert.deepEqual(listCount('- a\n- b is lo…'), { count: 2, more: true });
  assert.deepEqual(foldGist('- a\n…', 'done'), { kind: 'done', count: 1, more: true });
});

test('S8: every gist and call key exists in en and es', () => {
  const keys = [...GIST_KEYS, 'overview.call.kicker', 'overview.call.go', 'inbox.waited.now', 'inbox.waited.minutes', 'inbox.waited.hours'];
  for (const lang of ['en', 'es'] as const) for (const key of keys) assert.ok(key in (MESSAGES as any)[lang], `${key} (${lang})`);
  assert.equal((MESSAGES as any).en['overview.gist.pending.other'].replace('{count}', '2'), '2 pending');
  assert.equal((MESSAGES as any).es['overview.gist.pending.other'].replace('{count}', '2'), '2 pendientes');
});

const item = (over: object) => ({ terminalId: 't1', workspaceId: 'dev', rel: 'web', title: 'pi', kind: 'blocked', label: 'Guarded command confirmation', detail: 'git push', since: '2026-11-05T10:38:00.000Z', activity: null, ...over });

test('S8: the call is the longest waiting agent of the selected folder, never a finished one', () => {
  const selection = { ws: 'dev', rel: 'web' };
  const items = [
    item({ terminalId: 'newer', since: '2026-11-05T10:40:00.000Z' }),
    item({ terminalId: 'older', kind: 'prompt', since: '2026-11-05T10:30:00.000Z' }),
    item({ terminalId: 'done', kind: 'finished', since: '2026-11-05T10:00:00.000Z' }),
    item({ terminalId: 'sub', rel: 'web/api', since: '2026-11-05T09:00:00.000Z' }),
    item({ terminalId: 'other', workspaceId: 'ops', since: '2026-11-05T09:00:00.000Z' }),
  ];
  assert.equal(pickCall(items, selection)?.terminalId, 'older');
  assert.equal(pickCall([items[2], items[3]], selection), null);
  assert.equal(pickCall(undefined, selection), null);
  assert.equal(pickCall(items, null), null);
});

test('S8: how long it waits, in the inbox wording', () => {
  const now = Date.parse('2026-11-05T10:44:00.000Z');
  assert.deepEqual(waitedFor('2026-11-05T10:43:30.000Z', now), { key: 'inbox.waited.now', count: 0 });
  assert.deepEqual(waitedFor('2026-11-05T10:38:00.000Z', now), { key: 'inbox.waited.minutes', count: 6 });
  assert.deepEqual(waitedFor('2026-11-05T08:30:00.000Z', now), { key: 'inbox.waited.hours', count: 2 });
  assert.deepEqual(waitedFor('not a date', now), { key: 'inbox.waited.now', count: 0 });
});

test('S8: the card renders every part the layout names (goal, excerpt, folds, footer)', () => {
  const source = readFileSync(new URL('../public/features/overview.js', import.meta.url), 'utf8');
  for (const needle of ["from '/leftoff-model.js'", 'leftOffLayout(', "goal:", "excerpt:", 'summary[fold.field]', 'layout.foot.lastWorked', 'layout.foot.source', 'layout.foot.since', 'activateTerminal(']) {
    assert.ok(source.includes(needle), `overview.js should contain ${needle}`);
  }
});

test('S3: user-facing overview strings name the app through {brand}, which reads Mirador', () => {
  for (const lang of ['en', 'es'] as const) {
    for (const key of ['overview.beyondWindow', 'overview.truncated']) {
      const text = (MESSAGES as any)[lang][key] as string;
      assert.ok(text.includes('{brand}') && !text.includes('Mirador'), `${key} (${lang}): ${text}`);
      assert.ok(translate(lang, key).includes('Mirador') && !/gentle-deck/i.test(translate(lang, key)), `${key} (${lang})`);
    }
  }
});
