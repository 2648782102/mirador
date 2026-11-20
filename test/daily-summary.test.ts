import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, buildDailySummary, buildActivityOverview, activityHours, projectsUnder, windowMayMissDay, type Observation, type Session } from '../src/memory/daily-summary.ts';
import { summaryRoutes } from '../src/http/routes/summary.ts';
import type { AppContext } from '../src/http/context.ts';

const TZ = 'America/Santiago';

function obs(partial: Partial<Observation> & Pick<Observation, 'id' | 'type' | 'title' | 'created_at'>): Observation {
  return { content: `content ${partial.id}`, project: 'vigia', updated_at: partial.created_at, ...partial };
}

test('localDay converts Engram UTC timestamps to the local calendar day', () => {
  assert.equal(localDay('2026-10-28 15:53:29.664030106', TZ), '2026-10-28');
  // 02:10 UTC on the 28th is still the 27th in Santiago (UTC-3).
  assert.equal(localDay('2026-10-28 02:10:00', TZ), '2026-10-27');
});

test('buildDailySummary keeps only the selected local day and groups by type', () => {
  const observations = [
    obs({ id: 1, type: 'bugfix', title: 'Fixed login', created_at: '2026-10-28 13:00:00' }),
    obs({ id: 2, type: 'decision', title: 'Use Hono', created_at: '2026-10-28 14:00:00' }),
    obs({ id: 3, type: 'bugfix', title: 'Fixed logout', created_at: '2026-10-28 16:00:00' }),
    obs({ id: 4, type: 'bugfix', title: 'Yesterday fix', created_at: '2026-10-28 02:00:00' }),
  ];
  const summary = buildDailySummary({ project: 'vigia', date: '2026-10-28', timeZone: TZ, observations, sessions: [] });

  assert.equal(summary.total, 3);
  assert.deepEqual(summary.groups.map((g) => [g.type, g.items.map((i) => i.id)]), [
    ['decision', [2]],
    ['bugfix', [3, 1]],
  ]);
  assert.equal(summary.groups[1].label, 'Bug fixes');
});

test('buildDailySummary puts the latest session summary of the day apart', () => {
  const observations = [
    obs({ id: 10, type: 'session_summary', title: 'Session summary', content: '## Goal\nfirst', created_at: '2026-10-28 13:00:00' }),
    obs({ id: 11, type: 'session_summary', title: 'Session summary', content: '## Goal\nsecond', created_at: '2026-10-28 18:00:00' }),
    obs({ id: 12, type: 'discovery', title: 'Found it', created_at: '2026-10-28 15:00:00' }),
  ];
  const summary = buildDailySummary({ project: 'vigia', date: '2026-10-28', timeZone: TZ, observations, sessions: [] });

  assert.equal(summary.latestSummary?.id, 11);
  assert.equal(summary.latestSummary?.content, '## Goal\nsecond');
  assert.equal(summary.sessionSummaries, 2);
  assert.deepEqual(summary.groups.map((g) => g.type), ['discovery']);
  assert.equal(summary.total, 3);
});

test('buildDailySummary includes observations created earlier but updated that day', () => {
  const observations = [
    obs({ id: 20, type: 'architecture', title: 'Folder map', created_at: '2026-10-20 12:00:00', updated_at: '2026-10-28 12:00:00' }),
  ];
  const summary = buildDailySummary({ project: 'vigia', date: '2026-10-28', timeZone: TZ, observations, sessions: [] });

  assert.equal(summary.total, 1);
  assert.equal(summary.groups[0].items[0].updated, true);
});

test('buildDailySummary counts sessions started that day', () => {
  const sessions: Session[] = [
    { id: 'a', project: 'vigia', started_at: '2026-10-28 15:53:29.664030106', observation_count: 0 },
    { id: 'b', project: 'vigia', started_at: '2026-10-27 15:00:00', observation_count: 2 },
  ];
  const summary = buildDailySummary({ project: 'vigia', date: '2026-10-28', timeZone: TZ, observations: [], sessions });

  assert.equal(summary.sessionCount, 1);
  assert.equal(summary.total, 0);
  assert.equal(summary.latestSummary, null);
});

test('buildActivityOverview lists projects with activity that day, busiest first', () => {
  const observations = [
    obs({ id: 1, project: 'vigia', type: 'bugfix', title: 'A', created_at: '2026-10-28 13:00:00' }),
    obs({ id: 2, project: 'dev', type: 'decision', title: 'B', created_at: '2026-10-28 14:00:00' }),
    obs({ id: 3, project: 'dev', type: 'bugfix', title: 'C', created_at: '2026-10-28 16:00:00' }),
    obs({ id: 4, project: 'zeta', type: 'bugfix', title: 'old', created_at: '2026-10-01 16:00:00' }),
  ];
  const overview = buildActivityOverview({ date: '2026-10-28', timeZone: TZ, observations });

  assert.deepEqual(overview, [
    { project: 'dev', count: 2, lastAt: '2026-10-28 16:00:00', titles: ['C', 'B'] },
    { project: 'vigia', count: 1, lastAt: '2026-10-28 13:00:00', titles: ['A'] },
  ]);
});

test('projectsUnder finds Engram projects bound to the folder or below it', () => {
  const projects = [
    { name: 'vigia', directories: ['/home/you/Dev/vigia', '/home/you/Dev/web/vigia'] },
    { name: 'zeta', directories: ['/home/you/Dev/web'] },
    { name: 'dev', directories: ['/home/you/Dev'] },
    { name: 'webby', directories: ['/home/you/Dev/webby'] },
    { name: 'espia', directories: null },
  ];
  assert.deepEqual(projectsUnder('/home/you/Dev/web', projects), ['vigia', 'zeta']);
  assert.deepEqual(projectsUnder('/home/you/Dev/web/', projects), ['vigia', 'zeta']);
});

test('buildActivityOverview can be limited to some projects', () => {
  const observations = [
    obs({ id: 1, project: 'vigia', type: 'bugfix', title: 'A', created_at: '2026-10-28 13:00:00' }),
    obs({ id: 2, project: 'dev', type: 'decision', title: 'B', created_at: '2026-10-28 14:00:00' }),
  ];
  const overview = buildActivityOverview({ date: '2026-10-28', timeZone: TZ, observations, projects: ['vigia'] });
  assert.deepEqual(overview.map((p) => p.project), ['vigia']);
});

test('windowMayMissDay flags a full Engram window that does not reach back before the day', () => {
  const full = ['2026-10-28 18:00:00', '2026-10-28 15:00:00', '2026-10-28 13:00:00'];
  // The oldest entry is on the day itself: older entries of that day may be missing.
  assert.equal(windowMayMissDay(full, 3, '2026-10-28', TZ), true);
  // The window does not even reach the day.
  assert.equal(windowMayMissDay(full, 3, '2026-10-27', TZ), true);
  // The window reaches back before the day, so the whole day is inside it.
  assert.equal(windowMayMissDay(full, 3, '2026-10-29', TZ), false);
  // 02:10 UTC on the 28th is still the 27th in Santiago: the 28th is complete.
  assert.equal(windowMayMissDay(['2026-10-28 15:00:00', '2026-10-28 02:10:00'], 2, '2026-10-28', TZ), false);
});

test('windowMayMissDay never flags a window shorter than the limit', () => {
  assert.equal(windowMayMissDay(['2026-10-28 13:00:00'], 3, '2026-10-28', TZ), false);
  assert.equal(windowMayMissDay([], 3, '2026-10-28', TZ), false);
});

test('projectsUnder reads a missing project list or missing directories as no projects', () => {
  assert.deepEqual(projectsUnder('/home/you/Dev/web', null as never), []);
  assert.deepEqual(projectsUnder('/home/you/Dev/web', [{ name: 'shop', directories: null }]), []);
});

test('activityHours counts each memory of the day once, at the local hour of its last change that day', () => {
  // America/Santiago is UTC-3 on 2026-10-28.
  const observations = [
    obs({ id: 1, title: 'a', created_at: '2026-10-28 03:10:00' }), // 00:10 local
    obs({ id: 2, title: 'b', created_at: '2026-10-28 02:59:59' }), // 23:59 on the 27th: another day
    obs({ id: 3, title: 'c', created_at: '2026-10-28 12:00:00.123' }), // 09:00
    obs({ id: 4, project: 'dev', title: 'd', created_at: '2026-10-28 12:45:10' }), // 09:45
    obs({ id: 5, title: 'e', created_at: '2026-10-29 02:30:00' }), // 23:30, still the 28th
    obs({ id: 6, title: 'f', created_at: '2026-10-20 12:00:00', updated_at: '2026-10-28 18:05:00' }), // revised at 15:05
    obs({ id: 7, title: 'g', created_at: '2026-10-28 13:00:00', updated_at: '2026-10-29 13:00:00' }), // created at 10:00, revised the next day
    obs({ id: 8, title: 'h', created_at: '2026-10-28 14:00:00', updated_at: '2026-10-28 20:30:00' }), // created at 11:00, revised at 17:30: counted once
  ];
  const hours = activityHours({ date: '2026-10-28', timeZone: TZ, observations });
  assert.equal(hours.length, 24);
  const expected = Array(24).fill(0);
  expected[0] = 1;
  expected[9] = 2;
  expected[23] = 1;
  expected[15] = 1;
  expected[10] = 1;
  expected[17] = 1;
  assert.deepEqual(hours, expected);
  // Every memory the overview counts lands in exactly one hour.
  const overview = buildActivityOverview({ date: '2026-10-28', timeZone: TZ, observations });
  assert.equal(hours.reduce((a, b) => a + b, 0), overview.reduce((sum, p) => sum + p.count, 0));
  assert.deepEqual(activityHours({ date: '2026-10-28', timeZone: TZ, observations, projects: ['dev'] }), Array.from({ length: 24 }, (_, h) => (h === 9 ? 1 : 0)));
  assert.deepEqual(activityHours({ date: '2026-10-28', timeZone: TZ, observations: [] }), Array(24).fill(0));
});

test('GET /api/activity answers hours next to its unchanged fields', async () => {
  const observations = [
    obs({ id: 1, project: 'vigia', title: 'A', created_at: '2026-10-28 13:00:00' }),
    obs({ id: 2, project: 'dev', title: 'B', created_at: '2026-10-28 14:00:00' }),
    obs({ id: 3, project: 'dev', title: 'C', created_at: '2026-10-28 16:00:00' }),
  ];
  const ctx = {
    config: { timeZone: TZ },
    parseDate: (value: string | null) => value ?? '2026-10-28',
    engram: { allObservations: async () => observations },
  } as unknown as AppContext;
  const routes = await summaryRoutes(ctx);
  const route = routes.find((r) => r.path === '/api/activity')!;
  let status = 0;
  let body = '';
  const res = { writeHead: (code: number) => { status = code; return res; }, end: (text: string) => { body = text; } };
  await route.handler({ res, url: new URL('http://127.0.0.1/api/activity?date=2026-10-28') } as never);
  assert.equal(status, 200);
  const answer = JSON.parse(body);
  assert.deepEqual(Object.keys(answer).sort(), ['date', 'hours', 'projects', 'truncated']);
  assert.equal(answer.date, '2026-10-28');
  assert.equal(answer.truncated, false);
  assert.deepEqual(answer.projects, buildActivityOverview({ date: '2026-10-28', timeZone: TZ, observations }));
  assert.deepEqual(answer.hours, Array.from({ length: 24 }, (_, h) => (h === 10 ? 1 : h === 11 ? 1 : h === 13 ? 1 : 0)));
});
