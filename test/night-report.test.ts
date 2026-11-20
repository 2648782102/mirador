// "Qué hizo Mirador", decluttered: each row shows only its tag and
// place chips, the summary, the verdict and the time; what it did, the reason, the confidence and the
// judge's note open on demand in a per-row fold; Right / Wrong and the verdict the user gave stay inline.
// Pinned through night-model.js and the source of public/features/night.js, public/styles/night.css
// and public/i18n/night.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportDetails, reportRow } from '../public/features/night-model.js';
import { translate } from '../public/i18n.js';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const nightJs = read('public/features/night.js');
const nightCss = read('public/styles/night.css');
const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

/** The source of `function name(…)` in `source`, up to the next top-level function, doc comment or export. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `function ${name} is missing`);
  const end = source.slice(start + 1).search(/\n(?:async )?function |\n\/\*\*|\nexport |\nconst /);
  return end === -1 ? source.slice(start) : source.slice(start, start + 1 + end);
}

const base = { terminalId: 't1', workspaceId: 'dev', rel: 'tools/mirador', time: '2026-11-07T03:00:00.000Z', policy: { allowed: true }, decision: null, followUp: null, deferral: null, error: null };
const question = { items: [{ question: 'Which runner?', header: 'Runner', options: ['node:test', 'vitest'], multiSelect: false }] };

test('reportDetails: what a row folds away, in order: what it did, the reason, the confidence and the judge\'s note', () => {
  const decided = reportRow({
    ...base,
    id: 'r1',
    kind: 'question',
    question,
    outcome: 'decided',
    decision: { action: 'answer', choices: [{ item: 0, index: 0, label: 'node:test' }], reason: 'the mission asks for no dependencies', confidence: 0.86 },
    judgment: { verdict: 'doubtful', note: 'vitest was already there' },
  });
  assert.deepEqual(reportDetails(decided), ['outcome', 'reason', 'confidence', 'judge']);
  const deferred = reportRow({ ...base, id: 'r2', kind: 'question', question, outcome: 'deferred', deferral: { rule: 'low-confidence', reason: 'confidence 0.5 is below 0.7' } });
  assert.deepEqual(reportDetails(deferred), ['outcome', 'reason']);
  const dropped = reportRow({ ...base, id: 'r3', kind: 'question', question, outcome: 'dropped' });
  assert.deepEqual(reportDetails(dropped), ['outcome']);
  const note = reportRow({ ...base, id: 'r4', kind: 'note', outcome: 'followed-up', note: { text: 'Termina los tests.', from: LEGACY_USER_VALUES.cause }, delivered: true });
  assert.deepEqual(reportDetails(note), ['outcome'], 'a note\'s text is what it did');
  const judgedOk = reportRow({ ...base, id: 'r5', kind: 'question', question, outcome: 'decided', decision: { action: 'answer', choices: [], reason: '', confidence: 7 }, judgment: { verdict: 'ok', note: '' } });
  assert.deepEqual(reportDetails(judgedOk), [], 'no choice, no reason, no usable confidence and no judge note: nothing to open');
  assert.deepEqual(reportDetails({}), []);
});

test('a report row keeps the tag and place chips, the verdict, the time and the summary in the open', () => {
  const item = fn(nightJs, 'reportItem');
  assert.match(item, /el\('span', \{ class: 'night-tag' \}/);
  assert.match(item, /const where = place\(row\.workspaceId, row\.folders\);/);
  assert.match(item, /el\('span', \{ class: 'night-place', title: where \}, where\)/, 'the place is a chip cut short, whole in its title');
  assert.match(item, /el\('span', \{ class: `night-verdict \$\{verdict\.tone\}`, title: verdict\.note \|\| undefined \}, t\(`night\.verdict\.\$\{verdict\.verdict\}`\)\)/);
  assert.match(item, /el\('span', \{ class: 'night-time' \}, when\(row\.time\)\)/);
  assert.match(item, /el\(\s*'p',\s*\{ class: 'night-summary' \}/);
});

test('what it did, the reason, the confidence and the judge\'s note open on demand in the row\'s own fold', () => {
  const item = fn(nightJs, 'reportItem');
  assert.match(item, /const details = reportDetails\(row\);/);
  assert.match(item, /details\.length\s+\? disclosure\(`report-\$\{row\.id\}`, false, t\('night\.report\.details'\), \{ class: 'night-report-more' \}, \.\.\.details\.map\(\(key\) => reportDetail\(row, key\)\)\)\s+: null,/);
  for (const gone of ['outcomeLine(row)', "t('night.report.reason'", "t('night.report.confidence'", "t('night.report.judgeNote'"]) {
    assert.ok(!item.includes(gone), `${gone} is no longer drawn on the row itself`);
  }
  const detail = fn(nightJs, 'reportDetail');
  assert.match(detail, /if \(key === 'outcome'\) return outcomeLine\(row\);/);
  assert.match(detail, /el\('p', \{ class: 'night-reason' \}, t\('night\.report\.reason', \{ reason: row\.reason \}\)\)/);
  assert.match(detail, /el\('p', \{ class: 'muted tracking-small' \}, t\('night\.report\.confidence', \{ percent: row\.confidence \}\)\)/);
  assert.match(detail, /el\('p', \{ class: 'night-judge' \}, t\('night\.report\.judgeNote', \{ note: row\.verdict\.note \}\)\)/);
});

test('Right / Wrong and the verdict the user gave stay inline, after the fold', () => {
  const item = fn(nightJs, 'reportItem');
  const fold = item.indexOf("disclosure(`report-${row.id}`");
  assert.ok(fold > 0);
  assert.ok(item.indexOf("t(row.feedback.verdict === 'right' ? 'night.feedback.markedRight' : 'night.feedback.markedWrong')") > fold, 'the verdict the user gave follows the fold');
  assert.ok(item.indexOf("{ class: 'night-actions', role: 'group', 'aria-label': t('night.feedback.group') }") > fold, 'the buttons follow the fold');
  assert.match(item, /'data-night-focus': `right-\$\{row\.id\}`/);
  assert.match(item, /'data-night-focus': `wrong-\$\{row\.id\}`/);
});

test('the fold is labelled in both languages and looks small; the place chip is cut short on one line', () => {
  assert.equal(es('night.report.details'), 'Detalles');
  assert.equal(en('night.report.details'), 'Details');
  assert.match(nightCss, /\.night-report-more > summary \{[^}]*font-size: var\(--fs-sm\);[^}]*color: var\(--muted\);/);
  assert.match(nightCss, /\.night-item-head \.night-place \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
});
