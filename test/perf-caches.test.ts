// Repeated polls inside one Engram window cost no recomputation, and the
// day formatter is built once per time zone. Reads are counted through getters on the
// observations, so the tests watch the public functions, not their internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../src/memory/daily-summary.ts';
import { buildWorkspaceOverview, type OverviewFolder } from '../src/memory/overview.ts';
import { summaryRoutes } from '../src/http/routes/summary.ts';
import { formatDay, type AppContext } from '../src/http/context.ts';

const TZ = 'America/Santiago';
const DAY = '2026-10-28';

/** `count` observations, two of them on DAY; every read of `created_at` is counted in `reads.n`. */
function countedWindow(count: number, reads: { n: number }): Observation[] {
  return Array.from({ length: count }, (_, i) => {
    const created = i < 2 ? `2026-10-28 1${i}:00:00` : `2026-09-${String(1 + (i % 28)).padStart(2, '0')} 12:00:00`;
    const o = { id: i, type: i === 1 ? 'session_summary' : 'decision', title: `T${i}`, content: '## Goal\nG', project: `p${i % 3}`, session_id: 's1' } as Observation;
    Object.defineProperty(o, 'created_at', { enumerable: true, get: () => (reads.n++, created) });
    return o;
  });
}

function activityRoute(window: () => Observation[]) {
  const ctx = {
    config: { timeZone: TZ },
    parseDate: (value: string | null) => value ?? DAY,
    engram: { allObservations: async () => window() },
  } as unknown as AppContext;
  // Built once, like server.ts does at startup.
  const routes = summaryRoutes(ctx);
  return async (date = DAY) => {
    const route = (await routes).find((r) => r.path === '/api/activity')!;
    let body = '';
    const res = { writeHead: () => res, end: (text: string) => void (body = text) };
    await route.handler({ res, url: new URL(`http://127.0.0.1/api/activity?date=${date}`) } as never);
    return JSON.parse(body);
  };
}

test('GET /api/activity is computed once per Engram window and date, and again for the next window', async () => {
  const reads = { n: 0 };
  let window = countedWindow(500, reads);
  const get = activityRoute(() => window);
  const first = await get();
  assert.ok(reads.n >= 500, `the first poll reads the window (${reads.n})`);
  assert.equal(first.projects.reduce((sum: number, p: { count: number }) => sum + p.count, 0), 2);

  reads.n = 0;
  assert.deepEqual(await get(), first, 'the same answer');
  assert.equal(reads.n, 0, 'a second poll inside the window recomputes nothing');

  reads.n = 0;
  const other = await get('2026-09-02');
  assert.ok(reads.n >= 500, 'another date in the same window is computed');
  assert.notDeepEqual(other.projects, first.projects);

  reads.n = 0;
  window = countedWindow(500, reads);
  assert.deepEqual(await get(), first, 'the next window gives the same answer for the same data');
  assert.ok(reads.n >= 500, 'the next window is computed again');
});

test('the workspace overview reuses its per-project digest within one window and date', () => {
  const reads = { n: 0 };
  const window = countedWindow(600, reads);
  const folders: OverviewFolder[] = [
    { name: 'a', rel: 'a', path: '/w/a', isRepo: true, projects: ['p0'], hasMemory: true },
    { name: 'b', rel: 'b', path: '/w/b', isRepo: true, projects: ['p1', 'p2'], hasMemory: true },
  ];
  const build = (observations: Observation[], date = DAY, list = folders) =>
    buildWorkspaceOverview({ date, timeZone: TZ, folders: list, observations, windowFull: false });
  const first = build(window);
  assert.ok(reads.n >= 600, `the first build reads the window (${reads.n})`);

  reads.n = 0;
  assert.deepEqual(build(window), first, 'the same rows and summary');
  assert.ok(reads.n < 20, `a second build inside the window does not re-read it (${reads.n} reads)`);

  reads.n = 0;
  const one = build(window, DAY, [folders[0]]);
  assert.ok(reads.n < 20, 'another workspace over the same window and date reuses the digest');
  assert.equal(one.rows.length, 1);

  reads.n = 0;
  build(window, '2026-09-02');
  assert.ok(reads.n >= 600, 'another date is digested again');

  reads.n = 0;
  assert.deepEqual(build(countedWindow(600, reads)), first, 'a new window gives the same answer for the same data');
  assert.ok(reads.n >= 600, 'a new window is digested again');
});

test('formatDay builds one Intl.DateTimeFormat per time zone', () => {
  const Original = Intl.DateTimeFormat;
  let built = 0;
  const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    built++;
    return new Original(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Intl.DateTimeFormat = Counting;
  try {
    const date = new Date('2026-10-28T02:30:00Z');
    assert.equal(formatDay(date, 'Asia/Kathmandu'), '2026-10-28');
    assert.equal(formatDay(date, 'Asia/Kathmandu'), '2026-10-28');
    assert.equal(formatDay(date, 'America/Santiago'), '2026-10-27');
    assert.equal(formatDay(new Date('2026-10-28T12:00:00Z'), 'America/Santiago'), '2026-10-28');
    assert.ok(built <= 2, `one formatter per time zone (${built} built)`);
  } finally {
    Intl.DateTimeFormat = Original;
  }
});
