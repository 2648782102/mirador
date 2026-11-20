// Pure rules behind the workspace overview and a folder's "where it left off".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryLookup } from '../src/memory/folder-memory.ts';
import { buildWorkspaceOverview, clip, folderProjects, leftOffFrom, type OverviewFolder } from '../src/memory/overview.ts';
import type { Observation } from '../src/memory/daily-summary.ts';

const SUMMARY = [
  '## Goal',
  'Ship the overview panel.',
  '',
  '## Instructions',
  '- Spanish UI by default.',
  '',
  '## Accomplished',
  '- ✅ Route and tests',
  '- ✅ UI rows',
  '',
  '## Next Steps',
  '- Wire the folder block',
  '- Ask the user to review',
  '',
  '## Relevant Files',
  '- src/memory/overview.ts',
].join('\n');

test('where it left off reads the Goal, Accomplished and Next Steps sections of a session summary', () => {
  assert.deepEqual(leftOffFrom(SUMMARY), {
    goal: 'Ship the overview panel.',
    accomplished: '- ✅ Route and tests\n- ✅ UI rows',
    nextSteps: '- Wire the folder block\n- Ask the user to review',
  });
});

test('where it left off accepts the heading variants agents write, and says null for a missing section', () => {
  const content = '# Session\n## Objetivo:\nOrdenar el backlog\n## Done\n- moved tickets\n### Próximos pasos\n- close the sprint\n';
  assert.deepEqual(leftOffFrom(content), { goal: 'Ordenar el backlog', accomplished: '- moved tickets', nextSteps: '- close the sprint' });
  assert.deepEqual(leftOffFrom('## Goal\nOnly a goal\n## Next Steps\n\n'), { goal: 'Only a goal', accomplished: null, nextSteps: null });
});

test('where it left off keeps the text of a free-form summary as an excerpt, and nothing for a blank one', () => {
  assert.deepEqual(leftOffFrom('plain text, no headings'), { goal: null, accomplished: null, nextSteps: null, excerpt: 'plain text, no headings' });
  assert.deepEqual(leftOffFrom('\n## Notes\n- tidied the docs\n'), { goal: null, accomplished: null, nextSteps: null, excerpt: '## Notes\n- tidied the docs' }, 'unknown headings are free form too');
  assert.deepEqual(leftOffFrom('## Goal\n\n## Next Steps\n'), { goal: null, accomplished: null, nextSteps: null }, 'recognised but empty sections are no excerpt');
  assert.deepEqual(leftOffFrom(' \n\t\n'), { goal: null, accomplished: null, nextSteps: null });
});

test('clip keeps the first lines of a section and marks what it cut', () => {
  assert.equal(clip('- a\n- b\n- c', 2), '- a\n- b\n…');
  assert.equal(clip('- a\n- b', 2), '- a\n- b');
  assert.equal(clip('x'.repeat(30), 5, 10), `${'x'.repeat(10)}…`);
  assert.equal(clip(null, 3), null);
});

const LISTING = [
  { name: 'vigia', observation_count: 40, directories: ['/home/m/Dev/web/vigia', '/home/m/Dev/vigia'] },
  { name: 'shop', observation_count: 4, directories: ['/home/m/Dev/web/shop/'] },
  { name: 'dev', observation_count: 29, directories: ['/home/m/Dev'] },
  { name: 'mirador', observation_count: 3, directories: null },
  { name: 'empty', observation_count: 0, directories: ['/home/m/Dev/games'] },
];

test('a folder maps to the Engram projects used in it or below it, or named like it', () => {
  const projects = folderProjects(LISTING);
  assert.deepEqual(projects.under('/home/m/Dev/web'), ['vigia', 'shop'], 'a container holds every project below it');
  assert.deepEqual(projects.under('/home/m/Dev/web/vigia'), ['vigia']);
  assert.deepEqual(projects.under('/home/m/Dev/tools/Mirador'), ['mirador'], 'by folder name, case-insensitive');
  assert.deepEqual(projects.under('/home/m/Dev/web/vigia/src'), [], 'a project above does not count');
  assert.deepEqual(projects.under('/home/m/Dev/games'), [], 'a project without observations is no memory');
  assert.deepEqual(projects.under('/home/m/Dev/webx'), [], 'a shared prefix is not a parent');
});

test('a workspace root maps only to the projects used in the root itself', () => {
  const projects = folderProjects(LISTING);
  assert.deepEqual(projects.at('/home/m/Dev/'), ['dev']);
  assert.deepEqual(projects.at('/home/m/Dev/web'), [], 'projects below the root are its folders, not the root');
});

test('folder mapping agrees with the sidebar "no memory" badge', () => {
  const projects = folderProjects(LISTING);
  const hasMemory = memoryLookup(LISTING);
  for (const path of ['/home/m/Dev/web', '/home/m/Dev/web/vigia', '/home/m/Dev/tools/mirador', '/home/m/Dev/games', '/home/m/Dev/blender', '/home/m/Dev/web/vigia/src']) {
    assert.equal(projects.under(path).length > 0, hasMemory(path), path);
  }
});

const TZ = 'America/Santiago';
let nextId = 1;
function obs(fields: Partial<Observation> & { session_id?: string }): Observation {
  return { id: nextId++, type: 'decision', title: 't', content: '', project: 'p', created_at: '2026-10-28 12:00:00', ...fields };
}
const folder = (name: string, projects: string[]): OverviewFolder => ({ name, rel: name, path: `/ws/${name}`, isRepo: false, projects, hasMemory: projects.length > 0 });

test('each folder says when it was last worked on, any day, and folders are sorted by the most recent work', () => {
  const observations = [
    obs({ project: 'alpha', created_at: '2026-10-28 15:00:00' }),
    obs({ project: 'beta', created_at: '2026-10-01 12:00:00', updated_at: '2026-10-20 12:00:00' }),
    obs({ project: 'shop', created_at: '2026-10-25 10:00:00' }),
    obs({ project: 'vigia', created_at: '2026-10-26 01:00:00' }),
  ];
  const { rows } = buildWorkspaceOverview({
    date: '2026-10-28',
    timeZone: TZ,
    windowFull: false,
    folders: [folder('beta', ['beta']), folder('gamma', []), folder('alpha', ['alpha']), folder('web', ['shop', 'vigia'])],
    observations,
  });
  assert.deepEqual(
    rows.map((r) => [r.name, r.hasMemory, r.lastAt, r.lastDay]),
    [
      ['alpha', true, '2026-10-28 15:00:00', '2026-10-28'],
      ['web', true, '2026-10-26 01:00:00', '2026-10-25'],
      ['beta', true, '2026-10-20 12:00:00', '2026-10-20'],
      ['gamma', false, null, null],
    ],
  );
});

test('where a folder left off comes from its latest session summary, with the latest memory beside it', () => {
  const observations = [
    obs({ project: 'alpha', type: 'session_summary', title: 'Session summary', created_at: '2026-10-20 10:00:00', content: '## Goal\nOld goal\n## Next Steps\n- old step' }),
    obs({ project: 'alpha', type: 'session_summary', title: 'Session summary', created_at: '2026-10-27 10:00:00', content: SUMMARY }),
    obs({ project: 'alpha', type: 'bugfix', title: 'Fixed the date picker', created_at: '2026-10-27 18:00:00' }),
    obs({ project: 'alpha', type: 'decision', title: 'Older decision', created_at: '2026-10-26 18:00:00' }),
    obs({ project: 'beta', type: 'manual', title: 'Wrote the README', created_at: '2026-10-21 18:00:00' }),
  ];
  const { rows } = buildWorkspaceOverview({
    date: '2026-10-28',
    timeZone: TZ,
    windowFull: false,
    folders: [folder('alpha', ['alpha']), folder('beta', ['beta']), folder('gamma', [])],
    observations,
    excerptLines: 1,
  });
  const [alpha, beta, gamma] = rows;
  const short = buildWorkspaceOverview({ date: '2026-10-28', timeZone: TZ, windowFull: false, folders: [folder('alpha', ['alpha'])], observations, goalChars: 10 });
  assert.equal(short.rows[0].leftOff.summary?.goal, 'Ship the o…', 'the goal is clipped for compact rows');
  assert.deepEqual(alpha.leftOff, {
    summary: { at: '2026-10-27 10:00:00', goal: 'Ship the overview panel.', accomplished: '- ✅ Route and tests\n…', nextSteps: '- Wire the folder block\n…' },
    memory: { title: 'Fixed the date picker', type: 'bugfix', at: '2026-10-27 18:00:00' },
  });
  assert.deepEqual(beta.leftOff, { summary: null, memory: { title: 'Wrote the README', type: 'manual', at: '2026-10-21 18:00:00' } }, 'no summary: the latest memory title');
  assert.deepEqual(gamma.leftOff, { summary: null, memory: null });
});

test('a folder with memory older than the Engram window read says so instead of claiming no memory', () => {
  const input = { date: '2026-10-28', timeZone: TZ, folders: [folder('old', ['old'])], observations: [obs({ project: 'other' })] };
  const [full] = buildWorkspaceOverview({ ...input, windowFull: true }).rows;
  assert.deepEqual([full.hasMemory, full.lastAt, full.beyondWindow], [true, null, true]);
  const [complete] = buildWorkspaceOverview({ ...input, windowFull: false }).rows;
  assert.equal(complete.beyondWindow, false);
});

test('the workspace summary counts the day per folder and overall, with the most relevant headlines first', () => {
  const observations = [
    obs({ project: 'alpha', type: 'decision', title: 'Use SQLite', created_at: '2026-10-28 15:00:00', session_id: 's1' }),
    obs({ project: 'alpha', type: 'discovery', title: 'Engram has no paging', created_at: '2026-10-28 16:00:00', session_id: 's2' }),
    obs({ project: 'alpha', type: 'session_summary', title: 'Session summary', created_at: '2026-10-28 17:00:00', session_id: 's2' }),
    obs({ project: 'alpha', type: 'decision', title: 'Another day', created_at: '2026-10-20 15:00:00', session_id: 's0' }),
    obs({ project: 'shop', type: 'bugfix', title: 'Fixed checkout', created_at: '2026-10-28 14:00:00', session_id: 's3' }),
    obs({ project: 'vigia', type: 'passive', title: 'Learned x', created_at: '2026-10-28 13:00:00', session_id: 's4' }),
    // 23:00 on the 28th in Santiago.
    obs({ project: 'beta', type: 'manual', title: 'Late night note', created_at: '2026-10-29 02:00:00', session_id: 's5' }),
  ];
  const { rows, summary } = buildWorkspaceOverview({
    date: '2026-10-28',
    timeZone: TZ,
    windowFull: false,
    folders: [folder('alpha', ['alpha']), folder('beta', ['beta']), folder('gamma', []), folder('web', ['shop', 'vigia']), folder('vigia', ['vigia'])],
    observations,
  });
  const day = Object.fromEntries(rows.map((r) => [r.name, [r.day.memories, r.day.sessions, r.day.headlines.map((h) => h.title)]]));
  assert.deepEqual(day, {
    alpha: [3, 2, ['Use SQLite', 'Engram has no paging']],
    beta: [1, 1, ['Late night note']],
    gamma: [0, 0, []],
    web: [2, 2, ['Fixed checkout', 'Learned x']],
    vigia: [1, 1, ['Learned x']],
  });
  assert.deepEqual(
    { ...summary, headlines: summary.headlines.map((h) => [h.title, h.type, h.folder, h.rel]) },
    {
      folders: 5,
      activeFolders: 4,
      memories: 6,
      sessions: 5,
      headlines: [
        ['Use SQLite', 'decision', 'alpha', 'alpha'],
        ['Fixed checkout', 'bugfix', 'web', 'web'],
        ['Engram has no paging', 'discovery', 'alpha', 'alpha'],
        ['Late night note', 'manual', 'beta', 'beta'],
        ['Learned x', 'passive', 'web', 'web'],
      ],
    },
    'a project shared by two folders counts once, under the folder worked on most recently',
  );
});

test('folderProjects reads a missing project list as no projects', () => {
  const projects = folderProjects(null as never);
  assert.deepEqual(projects.under('/home/m/Dev/web'), []);
  assert.deepEqual(projects.at('/home/m/Dev'), []);
});
