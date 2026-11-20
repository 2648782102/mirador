// "ir por lotes" and Pausar probes: two runs share one gate and together start
// batchSize agents per settle; Pausar and close() end a memory wait at once; a run that gives up
// on memory lists the folders it left. Fake clock-free: real timers with short limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaunchGate } from '../src/system/memory-gate.ts';

const plenty = async () => ({ memTotal: 1000, memAvailable: 1000 });

test('two runs at once start batchSize agents per settle between them, in the order they asked', async () => {
  const gate = new LaunchGate({ limits: { batchSize: 2, settleMs: 300, reserveBytes: 0 }, readMemory: plenty });
  const t0 = Date.now();
  const starts: Array<[string, number]> = [];
  const drive = async (name: string, count: number) => {
    const run = gate.run({ kind: 'batch', total: count });
    for (let i = 1; i <= count; i++) {
      assert.equal(await run.next(), 'go');
      starts.push([`${name}${i}`, Date.now() - t0]);
    }
    run.end();
  };
  await Promise.all([drive('a', 3), drive('b', 3)]);
  assert.deepEqual(starts.map(([name]) => name), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  const at = (name: string) => starts.find(([n]) => n === name)![1];
  assert.ok(at('b1') - at('a1') < 150, 'the first batch starts together');
  assert.ok(at('a2') - at('b1') >= 280, 'the second batch waits for the settle');
  assert.ok(at('a3') - at('b2') >= 280, 'the third batch waits for the settle');
  assert.equal(gate.status().active, false);
});

test('Pausar during a memory wait ends the run as cancelled with the folders it left; a second cancel is refused', async () => {
  const gate = new LaunchGate({ limits: { batchSize: 2, settleMs: 0, reserveBytes: 100, maxWaitMs: 60_000, pollMs: 50 }, readMemory: async () => ({ memTotal: 1000, memAvailable: 10 }) });
  const run = gate.run({ kind: 'batch', total: 3 });
  const pending = run.next();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(gate.status().runs[0].wait?.reason, 'memory');
  assert.equal(gate.status().runs[0].wait?.missingBytes, 90);
  assert.equal(gate.cancel(run.id), true);
  assert.equal(await pending, 'cancelled');
  run.end([{ workspaceId: 'dev', rel: 'p1' }, { workspaceId: 'dev', rel: 'p2' }, { workspaceId: 'dev', rel: 'p3' }]);
  const [status] = gate.status().runs;
  assert.equal(gate.status().active, false);
  assert.equal(status.state, 'done');
  assert.equal(status.cancelled, 3);
  assert.equal(status.lowMemory, 0);
  assert.deepEqual(status.notOpened?.map((f) => f.rel), ['p1', 'p2', 'p3']);
  assert.equal(gate.cancel(run.id), false, 'an ended run cannot be paused again (the route answers 404)');
  assert.equal(gate.cancel('nope'), false);
});

test('close() during a memory wait resolves the wait at once and nothing starts after it', async () => {
  const gate = new LaunchGate({ limits: { batchSize: 2, settleMs: 0, reserveBytes: 100, maxWaitMs: 60_000, pollMs: 50 }, readMemory: async () => ({ memTotal: 1000, memAvailable: 10 }) });
  const run = gate.run({ kind: 'restore', total: 2 });
  const pending = run.next();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const t0 = Date.now();
  gate.close();
  assert.equal(await pending, 'cancelled');
  assert.ok(Date.now() - t0 < 100, 'the shutdown does not wait for the poll');
  assert.equal(await gate.run({ total: 1 }).next(), 'cancelled');
});

test('a run that waited maxWaitMs for memory gives up with low_memory for the rest and lists them', async () => {
  const gate = new LaunchGate({ limits: { batchSize: 2, settleMs: 0, reserveBytes: 100, maxWaitMs: 150, pollMs: 50 }, readMemory: async () => ({ memTotal: 1000, memAvailable: 10 }) });
  const run = gate.run({ kind: 'batch', total: 2 });
  assert.equal(await run.next(), 'low_memory');
  assert.equal(await run.next(), 'low_memory', 'once spent, the rest is refused without waiting again');
  run.end([{ workspaceId: 'dev', rel: 'p1' }, { workspaceId: 'dev', rel: 'p2' }]);
  const [status] = gate.status().runs;
  assert.equal(status.lowMemory, 2);
  assert.equal(status.cancelled, 0);
  assert.deepEqual(status.notOpened?.map((f) => f.rel), ['p1', 'p2']);
});
