// Pure data shaping behind the tracking charts (public/charts-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STATES, agentStateShares, hourBuckets, hourColumns, percentages, projectBars } from '../public/charts-model.js';

test('agent state shares keep the four states in order, with counts and percentages that add up to 100', () => {
  const shares = agentStateShares({ working: 2, waiting: 1, finished: 0, exited: 3, running: 3, shells: 4, projects: 2 });
  assert.deepEqual(AGENT_STATES, ['working', 'waiting', 'finished', 'exited']);
  assert.equal(shares.total, 6);
  assert.deepEqual(
    shares.slices.map(({ state, count, percent }) => [state, count, percent]),
    [
      ['working', 2, 33],
      ['waiting', 1, 17],
      ['finished', 0, 0],
      ['exited', 3, 50],
    ],
  );
  assert.deepEqual(
    shares.slices.map((slice) => slice.offset),
    [0, 2 / 6, 3 / 6, 3 / 6],
  );
  assert.equal(shares.slices[3].share, 0.5);
});

test('agent state shares with no agents have a zero total and zero shares', () => {
  const shares = agentStateShares({ working: 0, waiting: 0, finished: 0, exited: 0 });
  assert.equal(shares.total, 0);
  assert.deepEqual(shares.slices.map((slice) => [slice.count, slice.share, slice.percent]), [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.equal(agentStateShares({}).total, 0, 'missing counts read as zero');
});

test('percentages round by the largest remainder so they always add up to 100', () => {
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(percentages([1, 2]), [33, 67]);
  assert.deepEqual(percentages([5]), [100]);
  assert.deepEqual(percentages([0, 0]), [0, 0]);
  assert.deepEqual(percentages([]), []);
});

const project = (name: string, count: number) => ({ project: name, count, lastAt: '2026-10-28 12:00:00', titles: [] });

test('project bars sort by count (then name), keep the top 8 and fold the rest into others', () => {
  const activity = [
    project('b', 3),
    project('a', 3),
    project('c', 9),
    project('d', 1),
    project('e', 2),
    project('f', 7),
    project('g', 4),
    project('h', 5),
    project('i', 6),
    project('j', 1),
  ];
  const bars = projectBars(activity);
  assert.equal(bars.total, 41);
  assert.equal(bars.max, 9);
  assert.deepEqual(
    bars.bars.map((bar) => [bar.project, bar.count]),
    [
      ['c', 9],
      ['f', 7],
      ['i', 6],
      ['h', 5],
      ['g', 4],
      ['a', 3],
      ['b', 3],
      ['e', 2],
    ],
  );
  assert.equal(bars.bars[0].share, 1);
  assert.equal(bars.bars[7].share, 2 / 9);
  assert.deepEqual(bars.others, { count: 2, projects: 2, share: 2 / 9 });
});

test('project bars without a remainder have no others, and the limit can be changed', () => {
  const few = projectBars([project('x', 2), project('y', 4)]);
  assert.deepEqual(few.bars.map((bar) => bar.project), ['y', 'x']);
  assert.equal(few.others, null);
  const two = projectBars([project('x', 2), project('y', 4), project('z', 1)], 2);
  assert.deepEqual(two.bars.map((bar) => bar.project), ['y', 'x']);
  assert.deepEqual(two.others, { count: 1, projects: 1, share: 1 / 4 });
});

test('project bars skip projects without memories and are empty for no activity', () => {
  assert.deepEqual(projectBars([]), { bars: [], others: null, total: 0, max: 0 });
  assert.deepEqual(projectBars([project('idle', 0)]), { bars: [], others: null, total: 0, max: 0 });
});

test('hour buckets count Engram UTC times by local hour of the chosen day in a non-UTC time zone', () => {
  // America/Santiago is UTC-3 on 2026-10-28 (daylight saving time).
  const buckets = hourBuckets(
    [
      '2026-10-28 03:10:00', // 00:10 local, on the day
      '2026-10-28 02:59:59', // 23:59 local on 2026-10-27: another day
      '2026-10-28 12:00:00.123', // 09:00 local
      '2026-10-28 12:45:10', // 09:45 local
      '2026-10-29 02:30:00', // 23:30 local, still 2026-10-28
      '2026-10-29 03:00:00', // 00:00 local on 2026-10-29: another day
      'not a date',
    ],
    'America/Santiago',
    '2026-10-28',
  );
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0], 1);
  assert.equal(buckets[9], 2);
  assert.equal(buckets[23], 1);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 4);
});

test('hour buckets are 24 zeros for no times', () => {
  assert.deepEqual(hourBuckets([], 'America/Santiago', '2026-10-28'), Array(24).fill(0));
});

test('hour columns turn the 24 counts of GET /api/activity into columns relative to the busiest hour', () => {
  const hours = Array(24).fill(0);
  hours[9] = 4;
  hours[10] = 2;
  hours[23] = 4;
  const columns = hourColumns(hours);
  assert.equal(columns.total, 10);
  assert.equal(columns.max, 4);
  assert.deepEqual(columns.peaks, [9, 23], 'every hour with the most memories, in order');
  assert.equal(columns.columns.length, 24);
  assert.deepEqual(columns.columns[9], { hour: 9, count: 4, share: 1 });
  assert.deepEqual(columns.columns[10], { hour: 10, count: 2, share: 0.5 });
  assert.deepEqual(columns.columns[0], { hour: 0, count: 0, share: 0 });
});

test('hour columns are empty for no memories and read a missing or short answer as zeros', () => {
  assert.deepEqual(hourColumns(Array(24).fill(0)), { total: 0, max: 0, peaks: [], columns: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, share: 0 })) });
  assert.equal(hourColumns(undefined).total, 0);
  assert.equal(hourColumns([3]).columns.length, 24);
  assert.equal(hourColumns([3]).total, 3);
  assert.equal(hourColumns(['x', -1, 2.5, 1]).total, 1, 'only whole non-negative counts count');
});
