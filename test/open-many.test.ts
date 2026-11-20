// Opening agents in several folders at once: every folder
// is checked before any opens, they open one after another with the restore's stagger, and
// each folder gets its own result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidFolderError } from '../src/folders/tree.ts';
import { openAgentBatch } from '../src/terminals/open-many.ts';
import { RESTORE_DELAY_MS } from '../src/terminals/open-agents.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import type { TerminalInfo, TerminalRequest } from '../src/terminals/registry.ts';
import { UnknownWorkspaceError } from '../src/workspaces/store.ts';

const FOLDERS = new Set(['alpha', 'beta', 'gamma']);

/** A registry that records creates and sleeps in one timeline. */
function setup(running: Array<Partial<TerminalInfo>> = []) {
  const timeline: string[] = [];
  const created: TerminalRequest[] = [];
  const list: TerminalInfo[] = running.map((info, i) => ({ id: `old-${i}`, workspaceId: 'dev', rel: '', cwd: '/', title: 't', kind: 'agent', status: 'running', createdAt: '', ...info }) as TerminalInfo);
  let fail: string | null = null;
  const registry = {
    list: () => [...list],
    create(request: TerminalRequest): TerminalInfo {
      if (request.rel === fail) throw new Error('pty failed');
      const info: TerminalInfo = { id: `t-${created.length}`, workspaceId: request.workspaceId, rel: request.rel, cwd: request.cwd, title: request.rel, kind: request.kind, status: 'running', createdAt: 'now', cols: request.cols, rows: request.rows };
      created.push(request);
      list.push(info);
      timeline.push(`open ${request.rel}`);
      return info;
    },
  };
  const resolveFolder = async (workspaceId: string, rel: string) => {
    if (workspaceId !== 'dev') throw new UnknownWorkspaceError(workspaceId);
    const clean = rel.replace(/\/+$/, '');
    if (!FOLDERS.has(clean)) throw new InvalidFolderError(rel);
    return { workspace: { id: 'dev' }, rel: clean, path: `/root/${clean}` };
  };
  const sleep = async (ms: number) => { timeline.push(`sleep ${ms}`); };
  const batch = (rels: string[], over: Partial<Parameters<typeof openAgentBatch>[0]> = {}) =>
    openAgentBatch({ workspaceId: 'dev', rels, missing: 'reject', reopen: false, cols: 90, rows: 33, registry, resolveFolder, sleep, ...over });
  return { batch, timeline, created, failOn: (rel: string) => { fail = rel; } };
}

test('agents open one after another, the restore delay apart, each in its folder with the size asked', async () => {
  const { batch, timeline, created } = setup();
  const results = await batch(['alpha', 'beta', 'gamma']);
  assert.deepEqual(timeline, ['open alpha', `sleep ${RESTORE_DELAY_MS}`, 'open beta', `sleep ${RESTORE_DELAY_MS}`, 'open gamma']);
  assert.deepEqual(created.map((r) => [r.kind, r.cwd, r.rel, r.workspaceId, r.cols, r.rows]), [
    ['agent', '/root/alpha', 'alpha', 'dev', 90, 33],
    ['agent', '/root/beta', 'beta', 'dev', 90, 33],
    ['agent', '/root/gamma', 'gamma', 'dev', 90, 33],
  ]);
  assert.deepEqual(results.map((r) => [r.rel, r.status, r.status === 'opened' ? r.terminal.id : null]), [
    ['alpha', 'opened', 't-0'],
    ['beta', 'opened', 't-1'],
    ['gamma', 'opened', 't-2'],
  ]);
});

test('one folder outside the workspace rejects the whole batch before any agent opens', async () => {
  const { batch, timeline } = setup();
  await assert.rejects(batch(['alpha', '../etc', 'beta']), InvalidFolderError);
  await assert.rejects(batch(['alpha', 'missing']), InvalidFolderError);
  assert.deepEqual(timeline, []);
});

test('an unknown workspace rejects the batch, also when missing folders are skipped', async () => {
  const { batch, timeline } = setup();
  await assert.rejects(batch(['alpha'], { workspaceId: 'nope' }), UnknownWorkspaceError);
  await assert.rejects(batch(['alpha'], { workspaceId: 'nope', missing: 'skip' }), UnknownWorkspaceError);
  assert.deepEqual(timeline, []);
});

test('with missing folders skipped (a saved set), they are reported and the rest open', async () => {
  const { batch, timeline } = setup();
  const results = await batch(['alpha', 'gone', 'beta'], { missing: 'skip' });
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'opened'], ['gone', 'missing'], ['beta', 'opened']]);
  assert.deepEqual(timeline, ['open alpha', `sleep ${RESTORE_DELAY_MS}`, 'open beta']);
});

test('a folder with a running agent is skipped and reported unless reopen is asked; exited agents and shells do not count', async () => {
  const running = [{ id: 'a1', rel: 'alpha' }, { id: 'b1', rel: 'beta', status: 'exited' as const }, { id: 'g1', rel: 'gamma', kind: 'shell' as const }, { id: 'x1', rel: 'alpha', workspaceId: 'work' }];
  const skip = setup(running);
  const results = await skip.batch(['alpha', 'beta', 'gamma']);
  assert.deepEqual(results.map((r) => [r.rel, r.status, r.status === 'already_open' ? r.terminalId : null]), [['alpha', 'already_open', 'a1'], ['beta', 'opened', null], ['gamma', 'opened', null]]);
  // No pause before the first agent that actually opens.
  assert.deepEqual(skip.timeline, ['open beta', `sleep ${RESTORE_DELAY_MS}`, 'open gamma']);

  const again = setup(running);
  const reopened = await again.batch(['alpha'], { reopen: true });
  assert.deepEqual(reopened.map((r) => [r.rel, r.status]), [['alpha', 'opened']]);
});

test('the same folder asked twice opens once', async () => {
  const { batch, created } = setup();
  const results = await batch(['alpha', 'alpha/', 'beta']);
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'opened'], ['beta', 'opened']]);
  assert.equal(created.length, 2);
});

test('an agent that cannot start is reported as failed and the others still open', async () => {
  const { batch, failOn } = setup();
  failOn('alpha');
  const results = await batch(['alpha', 'beta']);
  assert.deepEqual(results.map((r) => [r.rel, r.status, r.status === 'failed' ? r.error : null]), [['alpha', 'failed', 'pty failed'], ['beta', 'opened', null]]);
});

/* ---------- Delegating an instruction ---------- */

function delegation(over: Partial<NonNullable<Parameters<typeof openAgentBatch>[0]['delegation']>> = {}, timeline: string[] = []) {
  const sent: string[] = [];
  const opened: string[] = [];
  return {
    sent,
    opened,
    value: {
      firstMessageArgs: ['Task from the user, delegated through Mirador:\n\nRun the tests.'],
      sendToOpen: async (id: string) => { sent.push(id); timeline.push(`send ${id}`); return null; },
      opened: (id: string) => { opened.push(id); timeline.push(`task ${id}`); },
      ready: () => { timeline.push('ready'); },
      ...over,
    },
  };
}

test('with an instruction, new agents get it as their first message and an open agent gets it as a message instead of a second agent', async () => {
  const s = setup([{ id: 'a1', rel: 'alpha' }]);
  const d = delegation({}, s.timeline);
  const results = await s.batch(['alpha', 'beta', 'gamma'], { delegation: d.value });
  assert.deepEqual(results.map((r) => [r.rel, r.status, r.status === 'sent' ? r.terminalId : r.status === 'opened' ? r.terminal.id : null]), [
    ['alpha', 'sent', 'a1'],
    ['beta', 'opened', 't-0'],
    ['gamma', 'opened', 't-1'],
  ]);
  assert.deepEqual(s.created.map((r) => r.agentArgs), [d.value.firstMessageArgs, d.value.firstMessageArgs]);
  assert.deepEqual(s.timeline, ['ready', 'send a1', 'open beta', 'task t-0', `sleep ${RESTORE_DELAY_MS}`, 'open gamma', 'task t-1']);
  assert.deepEqual(d.opened, ['t-0', 't-1']);
});

test('with an instruction, ready() runs once every folder resolved and never when the batch is rejected', async () => {
  const s = setup();
  const d = delegation({}, s.timeline);
  await assert.rejects(s.batch(['alpha', '../etc'], { delegation: d.value }), InvalidFolderError);
  assert.deepEqual(s.timeline, []);
  const results = await s.batch(['alpha', 'gone'], { delegation: d.value, missing: 'skip' });
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'opened'], ['gone', 'missing']]);
  assert.deepEqual(s.timeline, ['ready', 'open alpha', 'task t-0']);
});

test('an instruction the open agent did not receive, or an agent command that cannot take a first message, is reported as failed', async () => {
  const s = setup([{ id: 'a1', rel: 'alpha' }]);
  const d = delegation({ firstMessageArgs: null, sendToOpen: async () => "the agent's bridge is not connected" });
  const results = await s.batch(['alpha', 'beta'], { delegation: d.value });
  assert.deepEqual(results.map((r) => [r.rel, r.status, r.status === 'failed' ? r.error : null]), [
    ['alpha', 'failed', "the agent's bridge is not connected"],
    ['beta', 'failed', 'the agent command cannot take a first message'],
  ]);
  assert.deepEqual(s.created, [], 'no agent opened without its instruction');
  assert.deepEqual(d.opened, []);
});

test('without an instruction a batch opens agents with no extra args, as before', async () => {
  const s = setup();
  await s.batch(['alpha']);
  assert.equal(s.created[0].agentArgs, undefined);
});

/* ---------- Batches through the memory gate (src/system/memory-gate.ts) ---------- */

const GB = 1024 ** 3;

/** A gate on the batch's fake timeline: its waits are logged as `wait <ms>`. */
function gateOn(timeline: string[], available: () => number, limits: ConstructorParameters<typeof LaunchGate>[0]['limits'] = {}) {
  return new LaunchGate({
    limits,
    readMemory: async () => ({ memTotal: 24 * GB, memAvailable: available() }),
    sleep: async (ms) => { timeline.push(`wait ${ms}`); },
  });
}

test('with a gate, the batch reports its folders as queued the first time it has to wait, then opens them once there is memory', async () => {
  const s = setup();
  const readings = [10 * GB, 1 * GB, 10 * GB];
  const gate = gateOn(s.timeline, () => readings.shift() ?? 10 * GB);
  const snapshots: Array<Array<[string, string]>> = [];
  const results = await s.batch(['alpha', 'gone', 'beta', 'gamma'], {
    missing: 'skip',
    gate,
    onWait: (snapshot) => snapshots.push(snapshot.map((r) => [r.rel, r.status])),
  });
  assert.deepEqual(s.timeline, ['open alpha', `sleep ${RESTORE_DELAY_MS}`, 'wait 2000', 'open beta', `sleep ${RESTORE_DELAY_MS}`, 'open gamma']);
  assert.deepEqual(snapshots[0], [['alpha', 'opened'], ['gone', 'missing'], ['beta', 'queued'], ['gamma', 'queued']]);
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'opened'], ['gone', 'missing'], ['beta', 'opened'], ['gamma', 'opened']]);
});

test('when memory stays under the reserve past the wait budget, the folders left are reported low_memory and nothing more opens; an open agent still gets a delegated instruction', async () => {
  const s = setup([{ id: 'g1', rel: 'gamma' }]);
  const d = delegation({}, s.timeline);
  const gate = gateOn(s.timeline, () => 1 * GB, { maxWaitMs: 4000 });
  const results = await s.batch(['alpha', 'beta', 'gamma'], { gate, delegation: d.value });
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'low_memory'], ['beta', 'low_memory'], ['gamma', 'sent']]);
  assert.deepEqual(s.created, []);
  assert.deepEqual(s.timeline, ['ready', 'wait 2000', 'wait 2000', 'send g1']);
});

test('a shutdown (the gate closed) while the batch waits reports the folders left as cancelled and opens nothing after it', async () => {
  const s = setup();
  let reads = 0;
  const gate = new LaunchGate({
    readMemory: async () => ({ memTotal: 24 * GB, memAvailable: ++reads === 1 ? 10 * GB : 1 * GB }),
    sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  let waiting!: () => void;
  const waited = new Promise<void>((resolve) => (waiting = resolve));
  const batch = s.batch(['alpha', 'beta', 'gamma'], { gate, onWait: () => waiting() });
  await waited;
  gate.close();
  const results = await batch;
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'opened'], ['beta', 'cancelled'], ['gamma', 'cancelled']]);
  assert.deepEqual(s.created.map((r) => r.rel), ['alpha']);
});

test('aborting the batch\'s own signal cancels the folders left', async () => {
  const s = setup();
  const controller = new AbortController();
  const gate = new LaunchGate({ readMemory: async () => ({ memTotal: 24 * GB, memAvailable: 10 * GB }), sleep: async () => undefined });
  const results = await s.batch(['alpha', 'beta'], { gate, signal: controller.signal, sleep: async () => controller.abort() });
  assert.deepEqual(results.map((r) => [r.rel, r.status]), [['alpha', 'opened'], ['beta', 'cancelled']]);
});

test('a gated batch is one launch run of the gate: its id, total and outcome are readable while and after it runs', async () => {
  const s = setup([{ id: 'g1', rel: 'gamma' }]);
  const gate = gateOn(s.timeline, () => 1 * GB, { maxWaitMs: 0 });
  await s.batch(['alpha', 'beta', 'gamma'], { gate, runId: 'batch-1' });
  const [run] = gate.status().runs;
  assert.deepEqual([run.id, run.kind, run.workspaceId, run.state, run.total, run.opened, run.skipped, run.lowMemory], ['batch-1', 'batch', 'dev', 'done', 3, 0, 1, 2]);
});
