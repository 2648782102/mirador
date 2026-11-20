// Pure rules behind the resource figures in the UI (public/features/resources-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOW_MEMORY_SHARE, formatBytes, formatCpu, heaviestFirst, machineMemory, outsideTotal, usageOf } from '../public/features/resources-model.js';

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

test('bytes read as MB under 1 GB and as GB with one decimal above, in the UI language', () => {
  assert.equal(formatBytes(7.4 * GB, 'es'), '7,4 GB');
  assert.equal(formatBytes(7.4 * GB, 'en'), '7.4 GB');
  assert.equal(formatBytes(24509744 * KB, 'es'), '23,4 GB');
  assert.equal(formatBytes(2 * GB, 'es'), '2 GB', 'no trailing ,0');
  assert.equal(formatBytes(123.4 * GB, 'en'), '123 GB', 'whole GB from 100 on');
  assert.equal(formatBytes(850.6 * MB, 'es'), '851 MB');
  assert.equal(formatBytes(0, 'es'), '0 MB');
  assert.equal(formatBytes(1500 * GB, 'es'), '1500 GB', 'no thousands separator in a compact figure');
  assert.equal(formatBytes(null, 'es'), null);
  assert.equal(formatBytes(-1, 'es'), null);
});

test('CPU % shows one decimal under 10 and a whole number from 10 on', () => {
  assert.equal(formatCpu(0.44, 'es'), '0,4');
  assert.equal(formatCpu(3, 'en'), '3');
  assert.equal(formatCpu(12.6, 'es'), '13');
  assert.equal(formatCpu(150, 'en'), '150');
  assert.equal(formatCpu(null, 'es'), null);
});

test('the machine is low on memory below LOW_MEMORY_SHARE of its RAM available', () => {
  assert.equal(LOW_MEMORY_SHARE, 0.15);
  const machine = (memAvailable: number) => ({ memTotal: 100 * GB, memAvailable, swapTotal: 40 * GB, swapFree: 10 * GB });
  assert.deepEqual(machineMemory(machine(15 * GB)), { total: 100 * GB, available: 15 * GB, swapUsed: 30 * GB, swapTotal: 40 * GB, low: false });
  assert.equal(machineMemory(machine(15 * GB - 1))?.low, true);
  assert.equal(machineMemory({ memTotal: 8 * GB, memAvailable: 4 * GB, swapTotal: null, swapFree: null })?.swapUsed, null, 'swap unknown');
  assert.equal(machineMemory({ memTotal: null, memAvailable: 1, swapTotal: 0, swapFree: 0 }), null, 'no RAM figures, no line');
  assert.equal(machineMemory(null), null);
});

test('an agent uses its RAM plus swap; no memory figure, no usage', () => {
  assert.deepEqual(usageOf({ id: 'a', memory: GB, swap: 0.5 * GB, cpu: 3 }), { memory: GB, swap: 0.5 * GB, total: 1.5 * GB, cpu: 3 });
  assert.deepEqual(usageOf({ id: 'a', memory: GB, swap: null, cpu: null }), { memory: GB, swap: null, total: GB, cpu: null });
  assert.equal(usageOf({ id: 'a', memory: null, swap: 5, cpu: 1 }), null);
  assert.equal(usageOf(undefined), null);
});

test('the heaviest agents come first by RAM plus swap, ties by id, without unknown ones, at most `limit`', () => {
  const entries = [
    { id: 'c', kind: 'agent', memory: GB, swap: 0, cpu: null },
    { id: 'a', kind: 'agent', memory: 0.5 * GB, swap: 0.5 * GB, cpu: 1 },
    { id: 'big', kind: 'agent', memory: 0.2 * GB, swap: 3 * GB, cpu: 0 },
    { id: 'gone', kind: 'agent', memory: null, swap: null, cpu: null },
    { id: 'bash', kind: 'shell', memory: 9 * GB, swap: 0, cpu: 0 },
    { id: 'small', kind: 'agent', memory: MB, swap: 0, cpu: 0 },
  ];
  assert.deepEqual(heaviestFirst(entries, 10).map((e) => e.id), ['big', 'a', 'c', 'small']);
  assert.deepEqual(heaviestFirst(entries, 2).map((e) => e.id), ['big', 'a']);
  assert.deepEqual(heaviestFirst(entries, 1)[0], { id: 'big', memory: 0.2 * GB, swap: 3 * GB, total: 3.2 * GB, cpu: 0 });
  assert.deepEqual(heaviestFirst(null, 3), []);
});

test('outside Mirador totals RAM plus swap of every gentle-shell counted', () => {
  assert.deepEqual(outsideTotal({ count: 14, memory: 8 * GB, swap: 2.9 * GB, processes: [], truncated: true }), { count: 14, total: 10.9 * GB });
  assert.equal(outsideTotal(undefined), null);
});
