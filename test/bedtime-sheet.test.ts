// "Antes de dormir", one note per agent: each agent is a compact
// row that opens on click, with one box prefilled with Mirador's proposal and one "Dejar la nota";
// the intro, the capacity and the tabs' explanation sit behind an ⓘ; the notes of closed agents
// stay folded and show only their first line. Pinned through night-model.js and the source of
// public/features/night.js, public/styles/night.css and public/i18n/night.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bedtimeRow, firstLine } from '../public/features/night-model.js';
import * as proposalsModel from '../public/features/proposals-model.js';
import { MESSAGES, translate } from '../public/i18n.js';

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

/* ---------- The agent's row ---------- */

test('bedtimeRow: the row says "propuesta lista", "nota dejada" or "sin nota", and opens by itself only for an agent waiting for you', () => {
  assert.deepEqual(bedtimeRow({ state: 'working' }, { proposed: true }), { status: 'proposal', open: false });
  assert.deepEqual(bedtimeRow({ state: 'finished' }, {}), { status: 'none', open: false });
  assert.deepEqual(bedtimeRow({ state: 'blocked' }, { proposed: true }), { status: 'proposal', open: true });
  assert.deepEqual(bedtimeRow({ state: 'prompt' }), { status: 'none', open: true });
  assert.deepEqual(bedtimeRow({ state: 'working' }, { noted: true, proposed: true }), { status: 'noted', open: false }, 'a note left wins over a proposal');
  assert.deepEqual(bedtimeRow(undefined), { status: 'none', open: false });
  assert.equal(es('night.bedtime.status.proposal'), 'propuesta lista');
  assert.equal(es('night.bedtime.status.noted'), 'nota dejada');
  assert.equal(es('night.bedtime.status.none'), 'sin nota');
  assert.equal(en('night.bedtime.status.proposal'), 'proposal ready');
  assert.equal(en('night.bedtime.status.noted'), 'note left');
  assert.equal(en('night.bedtime.status.none'), 'no note');
});

test('each agent is a <details> row: its summary holds the state chip, the path and the status; the rest opens on demand', () => {
  const item = fn(nightJs, 'agentItem');
  assert.match(item, /bedtimeRow\(agent, \{ proposed: /);
  assert.match(item, /disclosure\(\s*`agent-\$\{agent\.terminalId\}`,\s*row\.open,\s*rowSummary\(agent, row\.status\),\s*\{ class: 'night-agent' \}/);
  const summary = fn(nightJs, 'rowSummary');
  assert.match(summary, /class: `night-tag night-state-\$\{agent\.state\}` \}, t\(`night\.bedtime\.state\.\$\{agent\.state\}`\)\)/);
  assert.match(summary, /el\('span', \{ class: 'night-place' \}/);
  assert.match(summary, /el\('span', \{ class: `night-row-status \$\{status\}` \}, t\(`night\.bedtime\.status\.\$\{status\}`\)\)/);
  // A row with a note under "Con nota" is a row too, saying so.
  assert.match(fn(nightJs, 'notedItem'), /bedtimeRow\(agent, \{ noted: true \}\)[\s\S]*disclosure\(`agent-\$\{agent\.terminalId\}`, row\.open, rowSummary\(agent, row\.status\)/);
});

test('a row\'s open state survives the polling: the disclosure remembers each toggle by key, and its summary keeps the focus', () => {
  const disclosure = fn(nightJs, 'disclosure');
  assert.match(disclosure, /open: \(opened\.get\(key\) \?\? open\) \|\| undefined,/);
  assert.match(disclosure, /ontoggle: \(event\) => \(opened\.has\(key\) \|\| event\.target\.open !== open\) && opened\.set\(key, event\.target\.open\),/, 'only a change from the default is remembered');
  assert.match(disclosure, /el\('summary', \{ 'data-night-focus': key, 'aria-label': label \}, icon\('chev-right'\), summary\)/);
});

/* ---------- One box per agent ---------- */

test('the proposal is the agent\'s one note draft: no separate proposal box, keep checkbox or bottom button', () => {
  for (const gone of ['proposalsButton', 'saveProposals', 'syncProposalsButton', 'buildProposal', 'night-proposal-keep', 'keptNotes', "'night.proposal.keep'", "'night.proposal.legend'", "'night.proposal.save'", "'night.proposal.confirmHint'"]) {
    assert.ok(!nightJs.includes(gone), `${gone} is gone from night.js`);
  }
  assert.equal('keptNotes' in proposalsModel, false, 'keptNotes went with the bottom button');
  // The only note POST is saveNote's: one per agent, through "Dejar la nota".
  assert.equal(nightJs.match(/'POST', '\/api\/night\/notes'/g)?.length, 1);
  assert.match(fn(nightJs, 'saveNote'), /await api\('POST', '\/api\/night\/notes', terminalId \? \{ workspaceId, terminalId, text: checked\.text \} : \{ workspaceId, text: checked\.text \}\)/);
  assert.match(fn(nightJs, 'agentItem'), /noteForm\(`t:\$\{agent\.terminalId\}`, label, workspaceId, agent\.terminalId\)/);
});

test('a proposal fills the agent\'s draft only while it is empty or still Mirador\'s text; an edited draft is never overwritten', () => {
  const load = fn(nightJs, 'loadProposals');
  assert.match(load, /const draft = draftFor\(`t:\$\{proposal\.terminalId\}`\);/);
  assert.match(load, /if \(draft\.busy\) continue;/);
  assert.match(load, /refreshedProposal\(\{ text: draft\.input\.value, original: shown\?\.original \?\? '', source: shown\?\.source \?\? null \}, \{ text: proposal\.text, source \}\)/);
  assert.match(load, /if \(next\.text !== draft\.input\.value\) \{\n\s+draft\.input\.value = next\.text;/);
  // The rule itself: an empty box takes the proposal, a typed one keeps its text and is told a summary exists.
  const source = { summaryAt: '2026-11-07T21:10:00.000Z', latestMemoryAt: null, newerMemories: false, lastSentAt: null };
  assert.deepEqual(proposalsModel.refreshedProposal({ text: '', original: '', source: null }, { text: 'Continúa:\n- tests', source }), { text: 'Continúa:\n- tests', original: 'Continúa:\n- tests', source, newerSource: null });
  assert.deepEqual(proposalsModel.refreshedProposal({ text: 'mi nota', original: '', source: null }, { text: 'Continúa:\n- tests', source }), { text: 'mi nota', original: '', source: null, newerSource: source.summaryAt });
});

test('the box is labelled with the proposal\'s memory and date, and keeps its warnings, "Mejorar con IA" and the sensitive check', () => {
  assert.equal(es('night.proposal.label', { when: '07/11 18:10' }), 'Nota (propuesta de la memoria, 07/11 18:10)');
  assert.equal(en('night.proposal.label', { when: '11/07 18:10' }), 'Note (proposed from memory, 11/07 18:10)');
  assert.match(fn(nightJs, 'agentItem'), /fresh \? t\('night\.proposal\.label', \{ when: fresh\.when \}\) : t\('night\.bedtime\.agentNote'/);
  const form = fn(nightJs, 'noteForm');
  assert.match(form, /el\('label', \{ for: draft\.id \}, label\),\n\s+proposal\?\.origin \?\? null,\n\s+proposal\?\.improve\.node \?\? null,\n\s+draft\.input,\n\s+draft\.warn,/);
  const attach = fn(nightJs, 'attachProposal');
  assert.match(attach, /improveControls\(\{\n\s+read: \(\) => draft\.input\.value,/);
  assert.match(attach, /warnDraft\(draft\)/);
  assert.match(attach, /el\('div', \{ class: 'night-proposal-source', id: `\$\{draft\.id\}-source` \}\)/);
  assert.match(fn(nightJs, 'draftFor'), /'aria-describedby': `\$\{id\}-source \$\{id\}-warn \$\{id\}-hint \$\{id\}-error`/);
  const describe = fn(nightJs, 'describeSource');
  for (const key of ['newerMemory', 'sentAfter', 'newerSource']) assert.match(describe, new RegExp(`t\\('night\\.proposal\\.${key}'`));
});

test('the removed copy is gone from both languages and the new copy is in both', () => {
  for (const lang of ['es', 'en'] as const) {
    const dict = (MESSAGES as any)[lang] as Record<string, string>;
    for (const gone of ['night.proposal.legend', 'night.proposal.keep', 'night.proposal.confirmHint', 'night.proposal.save.one', 'night.proposal.save.other', 'night.proposal.saving', 'night.proposal.saved.one', 'night.proposal.savedNow.other', 'night.proposal.failed', 'night.proposal.source', 'night.proposal.ago.h', 'night.bedtime.otherNotes']) {
      assert.equal(gone in dict, false, `${lang}: ${gone}`);
    }
  }
});

/* ---------- ⓘ: intro, capacity and the tabs' explanation ---------- */

test('the intro, the capacity advice and the tabs hint live in one ⓘ disclosure next to the tabs', () => {
  const about = fn(nightJs, 'bedtimeAbout');
  assert.match(about, /disclosure\(\s*'bedtime-about',\s*false,\s*\[el\('span', \{ class: 'night-about-mark', 'aria-hidden': 'true', title: t\('night\.bedtime\.about'\) \}, 'i'\), el\('span', \{ class: 'night-sr' \}, t\('night\.bedtime\.about'\)\)\],\s*\{ class: 'night-about', label: t\('night\.bedtime\.about'\) \}/);
  assert.match(about, /t\('night\.bedtime\.intro'\)/);
  assert.match(about, /queueAdvice\(queueSettings, t\)/);
  assert.match(about, /t\('night\.queue\.adviceHint'\)/);
  assert.match(about, /t\('night\.bedtime\.tabsHint'\)/);
  const render = fn(nightJs, 'renderBedtime');
  assert.match(render, /el\('div', \{ class: 'night-bedtime-bar' \}, entries\.length \? bedtimeTabsNode : null, bedtimeAbout\(entries\.length > 0\)\)/);
  assert.doesNotMatch(render, /night-intro|night-queue-advice|t\('night\.bedtime\.tabsHint'\)/, 'nothing of it stays in the open');
  assert.equal(es('night.bedtime.about'), 'Cómo funciona «Antes de dormir»');
  assert.equal(en('night.bedtime.about'), 'How "Before bed" works');
});

/* ---------- Notes of closed agents ---------- */

test('firstLine: a note folds to its first line, and says when there is more', () => {
  assert.deepEqual(firstLine('Sigue con los tests\ny luego el push'), { line: 'Sigue con los tests', more: true });
  assert.deepEqual(firstLine('  Una sola línea  '), { line: 'Una sola línea', more: false });
  assert.deepEqual(firstLine('\n\nTras líneas vacías\n'), { line: 'Tras líneas vacías', more: false });
  assert.deepEqual(firstLine(''), { line: '', more: false });
  assert.deepEqual(firstLine(null), { line: '', more: false });
});

test('the notes of closed agents fold under "Notas de agentes cerrados (N)", one line each, with Remove always at hand', () => {
  assert.match(fn(nightJs, 'workspaceBlock'), /entry\.otherNotes\.length\s+\? disclosure\(`closed-\$\{entry\.workspaceId\}`, false, t\('night\.bedtime\.closedNotes', \{ count: entry\.otherNotes\.length \}\), \{ class: 'night-closed' \}, noteList\(entry\.otherNotes, true\)\)/);
  const item = fn(nightJs, 'noteItem');
  assert.match(item, /function noteItem\(note, short = false\)/);
  assert.match(item, /const head = firstLine\(note\.text\);/);
  assert.match(item, /disclosure\(`note-\$\{note\.id\}`, false, el\('span', \{ class: 'night-note-line' \}, head\.more \? `\$\{head\.line\}…` : head\.line\), \{ class: 'night-note-fold' \}, details\)/);
  // The remove button sits outside the fold, so it works without opening it.
  assert.match(item, /short \? disclosure\([^\n]*\) : details,\n\s+remove,/);
  assert.match(fn(nightJs, 'noteList'), /function noteList\(list, short = false\)[\s\S]*list\.map\(\(note\) => noteItem\(note, short\)\)/);
  assert.equal(es('night.bedtime.closedNotes', { count: 2 }), 'Notas de agentes cerrados (2)');
  assert.equal(en('night.bedtime.closedNotes', { count: 2 }), 'Notes for closed agents (2)');
});

/* ---------- Styles ---------- */

test('the rows and folds look like the other disclosures, and their chevron turns only without reduced motion', () => {
  assert.match(nightCss, /\.night-fold > summary \{[^}]*cursor: pointer;[^}]*list-style: none;/);
  assert.match(nightCss, /\.night-fold > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(nightCss, /\.night-fold\[open\] > summary > svg\.icon \{ transform: rotate\(90deg\); \}/);
  assert.match(nightCss, /@media \(prefers-reduced-motion: no-preference\) \{\n\s+\.night-fold > summary > svg\.icon \{ transition: transform [^}]+\}/);
  assert.match(nightCss, /\.night-note-line \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(nightCss, /\.night-about-mark \{[^}]*border: 1\.5px solid currentColor;[^}]*border-radius: 50%;/, 'the ⓘ is an "i" in a circle');
  for (const gone of ['.night-proposal-keep', '.night-proposal-actions', '.night-proposal.dropped', '.night-intro']) assert.ok(!nightCss.includes(gone), `${gone} is gone`);
});
