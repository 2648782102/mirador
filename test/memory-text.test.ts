// Pure parsing behind the readable memory layout and the glossary (public/memory-text.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGlossary,
  memoryLanguage,
  headingKey,
  isPathLike,
  parseField,
  splitEnumeration,
  splitSentences,
  tokenize,
} from '../public/memory-text.js';

const SAMPLE = [
  '**What**: All units of acme-workspaces are built and merged in worktree acme-worktrees/integration (branch integration): W1 workspaces + extension contract (docs/extending.md), W2 review follow-ups, W3 workspace overview + where-it-left-off, W4 attention inbox (herdr shim/socket + pi bridge loaded with -e, blocked/prompt/finished), W5 guarded file editor. 177/177 tests. Independent security verifier running (baseline a777121).',
  "**Why**: The user asked for all phases delegated to coordinated agents (2026-10-28).",
  "**Where**: odd/tasks/acme-workspaces.md (L1-L11). Main checkout (feat/workspaces) stays as the user's live install until the final fast-forward.",
  '**Learned**: Merge markers per unit in one-entry-per-line registration lists kept parallel worktrees conflict-free except docs. Headless checks must click .name, not row centres (a row-centre click started real gentle-shell agents).',
].join('\n');

const SESSION = [
  '## Goal',
  'Polish the Mirador panel. Keep W5 working.',
  '## Instructions',
  '- Spanish first',
  '## Discoveries',
  '- Static files are read per request',
  '## Accomplished',
  '- T3 done',
  '## Next Steps',
  '- Run the seam check',
  '## Relevant Files',
  '- public/markdown.js',
].join('\n');

test('parseField reads bold, plain, lowercase and Spanish field labels; unknown bold labels keep their text', () => {
  const lines = SAMPLE.split('\n');
  assert.deepEqual(lines.map((line) => parseField(line)?.key), ['what', 'why', 'where', 'learned']);
  assert.equal(parseField(lines[1])?.value, 'The user asked for all phases delegated to coordinated agents (2026-10-28).');
  assert.deepEqual(parseField('**What:** built it'), { key: 'what', label: 'What', value: 'built it' });
  assert.deepEqual(parseField('What: built it'), { key: 'what', label: 'What', value: 'built it' });
  assert.equal(parseField('why: because')?.key, 'why');
  assert.equal(parseField('**Qué**: algo')?.key, 'what');
  assert.equal(parseField('Por qué: razón')?.key, 'why');
  assert.equal(parseField('**Dónde**: aquí')?.key, 'where');
  assert.equal(parseField('Aprendido: esto')?.key, 'learned');
  assert.deepEqual(parseField('**Risk**: none'), { key: null, label: 'Risk', value: 'none' });
  assert.equal(parseField('Note: plain unknown labels are not fields'), null);
  assert.equal(parseField('**bold** without a colon'), null);
  assert.equal(parseField('See https://example.com'), null);
});

test('headingKey recognises the session summary headings in English and Spanish, and nothing else', () => {
  const headings = SESSION.split('\n').filter((line) => line.startsWith('## ')).map((line) => headingKey(line.slice(3)));
  assert.deepEqual(headings, ['goal', 'instructions', 'discoveries', 'accomplished', 'nextSteps', 'relevantFiles']);
  assert.equal(headingKey('next steps'), 'nextSteps');
  assert.equal(headingKey('Siguientes pasos'), 'nextSteps');
  assert.equal(headingKey('Objetivo'), 'goal');
  assert.equal(headingKey('Random heading'), null);
});

test('splitSentences splits on a period followed by an uppercase letter and keeps abbreviations intact', () => {
  assert.deepEqual(splitSentences('Merge markers worked. Headless checks must click .name, not row centres.'), [
    'Merge markers worked.',
    'Headless checks must click .name, not row centres.',
  ]);
  assert.deepEqual(splitSentences('Use a short label, e.g. Qué or Dónde. Then render it.'), ['Use a short label, e.g. Qué or Dónde.', 'Then render it.']);
  assert.deepEqual(splitSentences('Values i.e. Short ones stay. Él lo dijo.'), ['Values i.e. Short ones stay.', 'Él lo dijo.']);
  assert.deepEqual(splitSentences('One sentence (see A. Smith) only.'), ['One sentence (see A. Smith) only.']);
  assert.deepEqual(splitSentences('Ends at 177/177 tests. 3 more.'), ['Ends at 177/177 tests. 3 more.']);
  assert.deepEqual(splitSentences('Inline `a. B` code stays.'), ['Inline `a. B` code stays.']);
});

test('splitEnumeration turns 3+ code-prefixed items into an intro, items and the rest', () => {
  const value = parseField(SAMPLE.split('\n')[0])!.value;
  const parts = splitEnumeration(value);
  assert.ok(parts);
  assert.equal(parts.intro, 'All units of acme-workspaces are built and merged in worktree acme-worktrees/integration (branch integration):');
  assert.deepEqual(parts.items, [
    'W1 workspaces + extension contract (docs/extending.md)',
    'W2 review follow-ups',
    'W3 workspace overview + where-it-left-off',
    'W4 attention inbox (herdr shim/socket + pi bridge loaded with -e, blocked/prompt/finished)',
    'W5 guarded file editor',
  ]);
  assert.equal(parts.rest, '177/177 tests. Independent security verifier running (baseline a777121).');
  assert.equal(splitEnumeration('Done: T1 sidebar, T2 columns.'), null);
  assert.equal(splitEnumeration('No codes here, at all, really.'), null);
  assert.deepEqual(splitEnumeration('S1 names; S2 columns; and S3 labels')?.items, ['S1 names', 'S2 columns', 'S3 labels']);
});

test('isPathLike detects file paths and file names but not ratios, word pairs or abbreviations', () => {
  for (const path of ['odd/tasks/x.md', 'src/a.ts', 'docs/extending.md', 'src/server.ts:136', '~/Dev/tools', './bin/herdr-shim', 'README.md', 'package.json', 'public/styles/']) {
    assert.equal(isPathLike(path), true, path);
  }
  for (const word of ['177/177', 'shim/socket', 'blocked/prompt/finished', 'and/or', 'e.g', 'Node.js', 'acme-worktrees/integration', 'a777121']) {
    assert.equal(isPathLike(word), false, word);
  }
});

test('buildGlossary takes code definitions from the memories shown and ignores ranges and ratios', () => {
  const glossary = buildGlossary([SAMPLE]);
  assert.deepEqual(Object.fromEntries(glossary.definitions), {
    W1: 'workspaces + extension contract (docs/extending.md)',
    W2: 'review follow-ups',
    W3: 'workspace overview + where-it-left-off',
    W4: 'attention inbox (herdr shim/socket + pi bridge loaded with -e, blocked/prompt/finished)',
    W5: 'guarded file editor',
  });
  assert.deepEqual(glossary.codes, ['L1', 'L11', 'W1', 'W2', 'W3', 'W4', 'W5']);
  assert.deepEqual(glossary.terms, ['worktree', 'verifier', 'baseline', 'fastForward', 'herdr', 'gentleShell']);
  // A code defined in one memory explains it in another; "and", status words and long runs are no definition.
  const shared = buildGlossary(['Keep W5 working.', 'W5 guarded file editor', 'S3 and S4 done. T3 done.']);
  assert.equal(shared.definitions.get('W5'), 'guarded file editor');
  assert.equal(shared.definitions.has('S3'), false);
  assert.equal(shared.definitions.has('T3'), false);
  const long = buildGlossary([`T9 ${'very long description '.repeat(8)}`]).definitions.get('T9')!;
  assert.ok(long.length <= 91 && long.endsWith('…'), long);
});

test('tokenize falls back to a generic meaning by prefix for an undefined code, and skips unknown prefixes', () => {
  const glossary = buildGlossary(['W5 guarded file editor']);
  const segments = tokenize('W5 and W7 and S2, T4, L3 and V8', glossary);
  const abbrs = segments.filter((s) => s.type === 'abbr');
  assert.deepEqual(abbrs, [
    { type: 'abbr', kind: 'code', text: 'W5', definition: 'guarded file editor' },
    { type: 'abbr', kind: 'code', text: 'W7', key: 'code.W' },
    { type: 'abbr', kind: 'code', text: 'S2', key: 'code.S' },
    { type: 'abbr', kind: 'code', text: 'T4', key: 'code.T' },
    { type: 'abbr', kind: 'code', text: 'L3', key: 'code.L' },
  ]);
  assert.ok(segments.some((s) => s.type === 'text' && s.text.includes('V8')));
});

test('tokenize marks a term only on its first occurrence per memory, and codes on every occurrence', () => {
  const glossary = buildGlossary([]);
  const seen = new Set<string>();
  const first = tokenize('The worktree and another worktree; W2 then W2.', glossary, seen);
  assert.deepEqual(first.filter((s) => s.type === 'abbr').map((s) => s.text), ['worktree', 'W2', 'W2']);
  assert.equal(first.find((s) => s.type === 'abbr')?.key, 'term.worktree');
  const again = tokenize('Each worktree, ODD and RDD; red stays plain, RED is marked.', glossary, seen);
  assert.deepEqual(again.filter((s) => s.type === 'abbr').map((s) => s.text), ['ODD', 'RDD', 'RED']);
  // A fresh memory marks it again.
  assert.equal(tokenize('worktree', glossary).filter((s) => s.type === 'abbr').length, 1);
});

test('tokenize keeps bold and inline code, renders paths as code and leaves markup as plain text', () => {
  const segments = tokenize('**Bold W5** with `raw W5` in odd/tasks/x.md, (docs/extending.md).', buildGlossary([]));
  assert.deepEqual(segments, [
    { type: 'strong', children: [{ type: 'text', text: 'Bold ' }, { type: 'abbr', kind: 'code', text: 'W5', key: 'code.W' }] },
    { type: 'text', text: ' with ' },
    { type: 'code', text: 'raw W5' },
    { type: 'text', text: ' in ' },
    { type: 'code', text: 'odd/tasks/x.md' },
    { type: 'text', text: ', (' },
    { type: 'code', text: 'docs/extending.md' },
    { type: 'text', text: ').' },
  ]);
  const hostile = tokenize('<script>alert(1)</script> <img src=x onerror=alert(1)>', buildGlossary([]));
  assert.deepEqual(hostile, [{ type: 'text', text: '<script>alert(1)</script> <img src=x onerror=alert(1)>' }]);
});

test('buildGlossary does not take an abbreviation after a code as its definition', () => {
  const glossary = buildGlossary(['Glossary on hover (W5 etc.) and codes (S3 e.g. S4).', 'T2 vs. T3']);
  assert.equal(glossary.definitions.has('W5'), false);
  assert.equal(glossary.definitions.has('S3'), false);
  assert.equal(glossary.definitions.has('T2'), false);
});

test('a memory in Spanish reads as Spanish, so the browser does not translate it as English', () => {
  assert.equal(memoryLanguage('## Objetivo\nHacer que el panel se lea completo y claro. Antes, el objetivo se cortaba con «…».'), 'es');
  assert.equal(memoryLanguage('Resumen de sesión: lectura más clara de "Dónde quedó"'), 'es');
});

test('a memory in English, or with no telling words, stays English as before', () => {
  assert.equal(memoryLanguage('What: Fixed the N+1 query in the user list. Why: it was slow on every load.'), 'en');
  assert.equal(memoryLanguage('PR #4 f289242'), 'en');
  assert.equal(memoryLanguage(''), 'en');
});

test('labels, notes and code in another language do not decide a memory\'s language', () => {
  // English text under Spanish UI labels ("Qué", "Por qué") stays English.
  assert.equal(memoryLanguage('Qué Fixed the bug. Por qué la de que en', ['Qué', 'Por qué la de que en']), 'en');
  // Spanish text with English code stays Spanish.
  assert.equal(memoryLanguage('Se arregló el panel con the of and to in is', ['the of and to in is']), 'es');
});

