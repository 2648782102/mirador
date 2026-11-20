// "What Mirador did" grouped by type and filtered:
// Mirador's decisions apart from the user's execution notes, and the filters "Todas",
// "Sin responder" and "Sin nota" with their counts (public/features/night-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFilter, reportRows, reportView } from '../public/features/night-model.js';

/** A night record (src/night/log.ts) of `kind` with the user's `feedback`, if any. */
const record = (id: string, time: string, kind: string, feedback: object | null = null) => ({
  id,
  time,
  kind,
  terminalId: 't1',
  workspaceId: 'dev',
  rel: 'tools/mirador',
  question: kind === 'question' ? { items: [{ question: `Question ${id}?`, header: 'Q', options: ['A', 'B'] }] } : null,
  decision: kind === 'question' ? { action: 'answer', choices: [{ item: 0, index: 0, label: 'A' }] } : null,
  followUp: kind === 'delegate' ? { action: 'follow-up', message: 'Go on.' } : null,
  outcome: kind === 'question' ? 'decided' : 'followed-up',
  note: kind === 'note' ? { id: `n-${id}`, text: 'Run the tests first.' } : undefined,
  feedback,
});

const rows = reportRows([
  record('q-open', '2026-10-29T05:00:00Z', 'question'),
  record('n1', '2026-10-29T04:30:00Z', 'note'),
  record('f-right', '2026-10-29T04:00:00Z', 'delegate', { verdict: 'right', note: '' }),
  record('q-wrong-note', '2026-10-29T03:00:00Z', 'question', { verdict: 'wrong', note: 'ask me first' }),
  record('q-wrong-bare', '2026-10-29T02:00:00Z', 'question', { verdict: 'wrong', note: '' }),
  record('n2', '2026-10-29T01:00:00Z', 'note'),
]);

const ids = (view: { groups: { key: string; rows: { id: string }[] }[] }) => view.groups.map((group) => [group.key, group.rows.map((row) => row.id)]);

test('S5: rows are grouped by type, Mirador decisions first and notes for Mirador after, newest first within each', () => {
  assert.deepEqual(ids(reportView(rows, 'all')), [
    ['decisions', ['q-open', 'f-right', 'q-wrong-note', 'q-wrong-bare']],
    ['notes', ['n1', 'n2']],
  ]);
});

test('S5: "Sin responder" keeps the decisions not marked Right or Wrong; a note cannot be answered', () => {
  assert.deepEqual(ids(reportView(rows, 'unanswered')), [['decisions', ['q-open']]]);
});

test('S5: "Sin nota" keeps the decisions without a note of the user, except those marked Right; a note row cannot carry one', () => {
  // Right needs no note (the user, 2026-10-29: "si esta ok"), so f-right is not missing anything.
  assert.deepEqual(ids(reportView(rows, 'noNote')), [['decisions', ['q-open', 'q-wrong-bare']]]);
});

test('S5: every filter shows its count, whichever filter is chosen', () => {
  const expected = { all: 6, unanswered: 1, noNote: 2 };
  assert.deepEqual(reportView(rows, 'all').counts, expected);
  assert.deepEqual(reportView(rows, 'unanswered').counts, expected);
});

test('S5: a filter with no rows gives no groups, and the empty list counts zero everywhere', () => {
  const answered = reportRows([record('q', '2026-10-29T05:00:00Z', 'question', { verdict: 'wrong', note: 'later' })]);
  assert.deepEqual(reportView(answered, 'unanswered').groups, []);
  assert.deepEqual(reportView([], 'all'), { filter: 'all', counts: { all: 0, unanswered: 0, noNote: 0 }, groups: [] });
});

test('S5: the remembered filter is kept when it is known; anything else falls back to "Todas"', () => {
  assert.equal(reportFilter('unanswered'), 'unanswered');
  assert.equal(reportFilter('noNote'), 'noNote');
  assert.equal(reportFilter('mine'), 'all');
  assert.equal(reportFilter(null), 'all');
  assert.equal(reportView(rows, 'mine').filter, 'all');
});

test('an answered row stays listed under "Todas" with its feedback (as before D5)', () => {
  const decisions = reportView(rows, 'all').groups[0].rows;
  assert.deepEqual(decisions.find((row: { id: string }) => row.id === 'f-right').feedback, { verdict: 'right', note: '' });
  assert.deepEqual(decisions.find((row: { id: string }) => row.id === 'q-wrong-note').feedback, { verdict: 'wrong', note: 'ask me first' });
});
