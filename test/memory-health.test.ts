// Pure rules behind the memory health card (src/memory/memory-health.ts and
// public/memory-health-model.js), over a fake Engram observation window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryHealth, resolveFolders, type HealthFolder } from '../src/memory/memory-health.ts';
import { displayTitle, fallbackTitle, healthSections } from '../public/memory-health-model.js';

const HOME = '/home/ana';
const DEV = '/home/ana/Dev';

let n = 0;
const o = (project: string, title: string, over: Record<string, unknown> = {}) => ({
  id: ++n,
  type: 'decision',
  title,
  content: '',
  project,
  created_at: `2026-10-${String(10 + (n % 18)).padStart(2, '0')} 12:00:00`,
  topic_key: `topic/${n}`,
  ...over,
});

const folders: HealthFolder[] = [
  { path: DEV, root: true },
  { path: `${DEV}/alpha`, root: false },
  { path: `${DEV}/beta`, root: false },
];

function health(observations: any[], listing: any[], resolved = new Map<string, string | null>()) {
  return buildMemoryHealth({ observations, listing, folders, resolved, home: HOME, windowFull: false });
}

/* ---------- Fallback titles ---------- */

test('a fallback title is the first meaningful line, with Markdown labels and markers stripped', () => {
  assert.equal(fallbackTitle('**What**: Fixed the login loop\n**Why**: users were stuck'), 'Fixed the login loop');
  assert.equal(fallbackTitle('**What:** Moved the cache'), 'Moved the cache');
  assert.equal(fallbackTitle('What: plain label'), 'plain label');
  assert.equal(fallbackTitle('\n\n  - `npm test` runs **twice**  \n'), 'npm test runs twice');
  assert.equal(fallbackTitle('> quoted *note*'), 'quoted note');
  assert.equal(fallbackTitle('**Qué**: Arreglé el login'), 'Arreglé el login');
});

test('headings are structure: the first line below them wins, and a lone heading is the last resort', () => {
  assert.equal(fallbackTitle('## Goal\nShip the overview\n## Accomplished\n- route'), 'Ship the overview');
  assert.equal(fallbackTitle('**What**:\n---\n## Notes'), 'Notes');
});

test('a fallback title is capped at 80 characters with an ellipsis, and empty content has none', () => {
  const long = 'word '.repeat(40);
  const title = fallbackTitle(long) as string;
  assert.equal(title.length, 80);
  assert.ok(title.endsWith('…'));
  assert.equal(fallbackTitle('x'.repeat(80)), 'x'.repeat(80), 'exactly 80 is kept whole');
  assert.equal(fallbackTitle(''), null);
  assert.equal(fallbackTitle('  \n**What**:\n---  '), null);
  assert.equal(fallbackTitle(undefined), null);
});

test('displayTitle keeps a real title and marks a fallback one', () => {
  assert.deepEqual(displayTitle('Use SQLite', 'whatever'), { text: 'Use SQLite', fallback: false });
  assert.deepEqual(displayTitle('   ', '**What**: Fixed it'), { text: 'Fixed it', fallback: true });
  assert.deepEqual(displayTitle('', ''), { text: null, fallback: true });
});

/* ---------- Untitled ---------- */

test('untitled memories are listed newest first with their fallback title and no content', () => {
  const window = [
    o('alpha', '', { content: '**What**: First thing\nsecret detail', created_at: '2026-10-01 10:00:00' }),
    o('alpha', '  ', { content: 'Second thing', created_at: '2026-10-05 10:00:00' }),
    o('alpha', 'Titled', { content: 'x' }),
  ];
  const before = JSON.stringify(window);
  const result = health(window, [{ name: 'alpha', observation_count: 3, directories: [`${DEV}/alpha`] }]);
  assert.deepEqual(
    result.untitled.map((u) => [u.project, u.fallbackTitle, u.at]),
    [['alpha', 'Second thing', '2026-10-05 10:00:00'], ['alpha', 'First thing', '2026-10-01 10:00:00']],
  );
  assert.equal(result.totals.untitled, 2);
  assert.ok(!JSON.stringify(result).includes('secret detail'), 'memory content never leaves beyond the fallback title');
  assert.equal(JSON.stringify(window), before, 'the shared window is not mutated');
});

test('the untitled and duplicate lists stop at the limit while the totals count everything', () => {
  const window = Array.from({ length: 60 }, (_, i) => o('alpha', '', { content: `line ${i}` }));
  const result = buildMemoryHealth({ observations: window, listing: [], folders, resolved: new Map(), home: HOME, windowFull: false, limit: 50 });
  assert.equal(result.untitled.length, 50);
  assert.equal(result.totals.untitled, 60);
});

/* ---------- Duplicates ---------- */

test('duplicates group by project and normalized title; summaries only within one session', () => {
  const window = [
    o('alpha', 'Fixed  the Cache', { created_at: '2026-10-01 10:00:00' }),
    o('alpha', 'fixed the cache', { created_at: '2026-10-03 10:00:00' }),
    o('alpha', 'Fixed the cache ', { created_at: '2026-10-02 10:00:00' }),
    o('beta', 'Fixed the cache'),
    o('alpha', 'Session summary', { type: 'session_summary', session_id: 's1' }),
    o('alpha', 'Session summary', { type: 'session_summary', session_id: 's2' }),
    o('alpha', 'Session summary', { type: 'session_summary', session_id: 's3', created_at: '2026-10-04 10:00:00' }),
    o('alpha', 'Session summary', { type: 'session_summary', session_id: 's3', created_at: '2026-10-04 11:00:00' }),
    o('alpha', 'Session summary', { type: 'session_summary' }),
    o('alpha', 'Session summary', { type: 'session_summary' }),
    o('alpha', '', { content: '**What**: Same first line\nA' }),
    o('alpha', '', { content: 'Same first line\nB' }),
    o('alpha', '', { content: '' }),
    o('alpha', '', { content: '' }),
  ];
  const result = health(window, []);
  assert.deepEqual(
    result.duplicates.map((d) => [d.project, d.title, d.copies]),
    [
      ['alpha', 'fixed the cache', 3],
      ['alpha', 'Same first line', 2],
      ['alpha', 'Session summary', 2],
    ],
    'most copies first; the title shown is the newest copy’s; untitled memories group by their fallback title',
  );
  assert.equal(result.duplicates[0].lastAt, '2026-10-03 10:00:00');
  assert.equal(result.duplicates[0].ids.length, 3);
  assert.equal(result.totals.duplicateGroups, 3);
  assert.equal(result.totals.duplicateCopies, 4, 'extra copies: 2 + 1 + 1');
});

/* ---------- Projects with no folder, and projects named like a non-project folder ---------- */

const LISTING = [
  { name: 'alpha', observation_count: 5, directories: [`${DEV}/alpha`] },
  { name: 'shop', observation_count: 2, directories: [`${DEV}/beta/shop`] },
  { name: 'renamed', observation_count: 3, directories: ['/srv/other/renamed'] },
  { name: 'remote-name', observation_count: 1, directories: null },
  { name: 'gone', observation_count: 4, directories: ['/old/gone'] },
  { name: 'empty', observation_count: 0, directories: ['/old/empty'] },
  { name: 'ana', observation_count: 18, directories: [HOME] },
  { name: 'dev', observation_count: 36, directories: [DEV] },
  { name: 'downloads', observation_count: 171, directories: [`${HOME}/Downloads`] },
  { name: 'scratchpad', observation_count: 2, directories: ['/tmp'] },
];

test('a project matches a folder by the overview mapping or by Engram resolving that folder to it', () => {
  const resolved = new Map<string, string | null>([[`${DEV}/beta`, 'remote-name'], [DEV, 'dev']]);
  const result = health([], LISTING, resolved);
  assert.deepEqual(
    result.unmatchedProjects.map((p) => [p.name, p.observations]),
    [['gone', 4], ['renamed', 3]],
    'alpha by name/dir, shop below beta, remote-name by resolution; empty projects and suspicious ones are left out',
  );
  assert.deepEqual(result.unmatchedProjects[0].directories, ['/old/gone']);
});

test('projects named like the home folder, a workspace root, Downloads or tmp are suspicious, with the reason', () => {
  const result = health([], LISTING);
  assert.deepEqual(
    result.suspiciousProjects.map((p) => [p.name, p.reason, p.observations]),
    [['downloads', 'scratch', 171], ['dev', 'container', 36], ['ana', 'home', 18], ['scratchpad', 'scratch', 2]],
  );
  assert.equal(result.totals.suspicious, 4);
  assert.equal(result.totals.unmatched, 3);
  assert.deepEqual(
    result.unmatchedProjects.map((p) => p.name),
    ['gone', 'renamed', 'remote-name'],
    'without Engram resolving beta, remote-name has no folder; an empty project never counts',
  );
});

test('a project used only from non-project folders is suspicious even under another name', () => {
  const result = health([], [{ name: 'notes', observation_count: 3, directories: [`${HOME}/Desktop`, '/tmp/x'] }]);
  assert.deepEqual(result.suspiciousProjects.map((p) => [p.name, p.reason]), [['notes', 'scratch']]);
});

/* ---------- Totals and per-project counts ---------- */

test('totals and per-project counts cover the window: topic keys, passive captures, untitled, copies', () => {
  const window = [
    o('alpha', 'A', { topic_key: undefined }),
    o('alpha', 'B', { topic_key: '  ' }),
    o('alpha', 'Captured', { type: 'passive', topic_key: undefined }),
    o('alpha', 'Session summary', { type: 'session_summary', topic_key: undefined, session_id: 's' }),
    o('alpha', '', { content: 'untitled one' }),
    o('stray', 'C'),
    o('stray', 'C'),
  ];
  const result = health(window, [{ name: 'alpha', observation_count: 9, directories: [`${DEV}/alpha`] }]);
  assert.deepEqual(result.totals, {
    projects: 2,
    observations: 11,
    inWindow: 7,
    windowFull: false,
    untitled: 1,
    duplicateGroups: 1,
    duplicateCopies: 1,
    withoutTopicKey: 2,
    passive: 1,
    unmatched: 1,
    suspicious: 0,
  });
  assert.deepEqual(result.projects, [
    { name: 'alpha', observations: 9, inWindow: 5, untitled: 1, duplicateCopies: 0, withoutTopicKey: 2, passive: 1, matched: true, suspicious: null },
    { name: 'stray', observations: 2, inWindow: 2, untitled: 0, duplicateCopies: 1, withoutTopicKey: 0, passive: 0, matched: false, suspicious: null },
  ]);
});

/* ---------- Bounded, cached folder lookups ---------- */

test('folder lookups are bounded, run a few at a time, and are cached for the TTL', async () => {
  let running = 0;
  let peak = 0;
  const asked: string[] = [];
  const lookup = async (path: string) => {
    asked.push(path);
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    return path.endsWith('/none') ? null : path.split('/').pop() as string;
  };
  const cache = new Map();
  let now = 1000;
  const paths = ['/a', '/b', '/c', '/none', '/e', '/f'];
  const first = await resolveFolders(paths, lookup, { max: 5, concurrency: 2, cache, ttlMs: 60_000, now: () => now });
  assert.deepEqual([...first.resolved.entries()], [['/a', 'a'], ['/b', 'b'], ['/c', 'c'], ['/none', null], ['/e', 'e']]);
  assert.equal(first.skipped, 1);
  assert.equal(peak, 2);
  assert.equal(asked.length, 5);

  now += 30_000;
  const second = await resolveFolders(paths, lookup, { max: 5, concurrency: 2, cache, ttlMs: 60_000, now: () => now });
  assert.equal(asked.length, 5, 'cached answers are not asked again');
  assert.equal(second.resolved.get('/none'), null);

  now += 31_000;
  await resolveFolders(['/a'], lookup, { max: 5, concurrency: 2, cache, ttlMs: 60_000, now: () => now });
  assert.equal(asked.length, 6, 'an expired answer is asked again');
});

test('a failed lookup rejects (the route answers 503) and is not cached', async () => {
  const cache = new Map();
  const failing = async () => {
    throw new Error('down');
  };
  await assert.rejects(resolveFolders(['/a'], failing, { max: 5, concurrency: 2, cache, ttlMs: 60_000, now: () => 0 }), /down/);
  assert.equal(cache.size, 0);
});

/* ---------- UI model ---------- */

test('healthSections lists the findings in a fixed order with their counts', () => {
  const result = health(
    [o('alpha', '', { content: 'x' }), o('alpha', 'Dup'), o('alpha', 'Dup'), o('alpha', 'P', { type: 'passive' })],
    LISTING,
  );
  assert.deepEqual(
    healthSections(result).map((s: any) => [s.id, s.count, s.items.length]),
    [
      ['suspicious', 4, 4],
      ['unmatched', 3, 3],
      ['untitled', 1, 1],
      ['duplicates', 1, 1],
      ['topicKey', 0, 0],
      ['passive', 1, 0],
    ],
  );
  assert.deepEqual(healthSections(null), []);
});
