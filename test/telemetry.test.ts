// Per-call telemetry: the runner records one line per Claude run with its
// feature, model, prompt version, time, outcome and sizes, never the prompt or the answer.
// Fake spawns only: no model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { CallTelemetry, callMeter, CallBudget, percentile } from '../src/night/budget.ts';
import { PI_BUSY_MESSAGE, PiGate, PiRunError, createPiRunner, type CallMeter, type CallRecord, type PiRuntime } from '../src/memory/translate.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-telemetry-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

let counter = 0;
const dirFor = (name: string) => join(scratch, `${name}-${++counter}`, 'telemetry');

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  kill() {
    setImmediate(() => this.emit('close', null, 'SIGTERM'));
    return true;
  }
}

async function fakeRuntime(): Promise<PiRuntime> {
  const dir = join(scratch, `pi-${++counter}`);
  await mkdir(join(dir, 'bridge'), { recursive: true });
  await writeFile(join(dir, 'cli.js'), '');
  return { node: process.execPath, cli: join(dir, 'cli.js'), agentDir: dir, bridge: join(dir, 'bridge'), workDir: join(dir, 'work') };
}

const SECRET_PROMPT = 'PROMPT-TEXT-7731 the mission says ship';
const SECRET_ANSWER = 'ANSWER-TEXT-4821';

/** mode: ok answers, fail exits 1, hang never answers. */
function spawnWith(mode: 'ok' | 'fail' | 'hang') {
  return (() => {
    const child = new FakeChild();
    child.stdin.on('finish', () => {
      if (mode === 'ok') {
        child.stdout.end(SECRET_ANSWER);
        setImmediate(() => child.emit('close', 0, null));
      }
      if (mode === 'fail') setImmediate(() => child.emit('close', 1, null));
    });
    return child;
  }) as never;
}

const recorder = (grant = true): CallMeter & { calls: CallRecord[] } => {
  const calls: CallRecord[] = [];
  return { calls, take: () => grant, record: (call) => void calls.push(call) };
};

const print = (feature: CallRecord['feature']) => ({ model: 'claude-sonnet-5-5', systemPrompt: 's', feature, promptVersion: 'night-decider-v1' });
const outcomeOf = (promise: Promise<unknown>) => promise.then(() => 'ok', (error) => (error instanceof PiRunError ? error.kind : 'other'));

test('every run leaves one record with exactly the agreed fields; outcomes ok, error, timeout, aborted, budget and busy', async () => {
  const rt = await fakeRuntime();
  const meter = recorder();
  await createPiRunner(rt, { spawn: spawnWith('ok'), meter }).run(SECRET_PROMPT, print('decide'));
  await outcomeOf(createPiRunner(rt, { spawn: spawnWith('fail'), meter }).run(SECRET_PROMPT, print('follow-up')));
  await outcomeOf(createPiRunner(rt, { spawn: spawnWith('hang'), meter, timeoutMs: 30 }).run(SECRET_PROMPT, print('judge')));
  const controller = new AbortController();
  const aborted = outcomeOf(createPiRunner(rt, { spawn: spawnWith('hang'), meter }).run(SECRET_PROMPT, { ...print('propose'), signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  await aborted;
  await outcomeOf(createPiRunner(rt, { spawn: spawnWith('ok'), meter: { ...meter, take: () => false } }).run(SECRET_PROMPT, print('decide')));
  const gate = new PiGate({ maxConcurrent: 1, maxQueue: 0 });
  const holder = createPiRunner(rt, { spawn: spawnWith('hang'), meter: recorder(), gate });
  const held = outcomeOf(holder.run('hold', print('decide')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(createPiRunner(rt, { spawn: spawnWith('ok'), meter, gate }).run(SECRET_PROMPT, print('judge')), (error: unknown) => error instanceof PiRunError && error.message === PI_BUSY_MESSAGE);
  holder.close();
  await held;

  assert.deepEqual(meter.calls.map((c) => [c.feature, c.outcome]), [
    ['decide', 'ok'],
    ['follow-up', 'error'],
    ['judge', 'timeout'],
    ['propose', 'aborted'],
    ['decide', 'budget'],
    ['judge', 'busy'],
  ]);
  for (const call of meter.calls) {
    assert.deepEqual(Object.keys(call).sort(), ['feature', 'inputBytes', 'model', 'ms', 'outcome', 'outputBytes', 'promptVersion', 'time']);
    assert.equal(call.model, 'claude-sonnet-5-5');
    assert.equal(call.promptVersion, 'night-decider-v1');
    assert.ok(Number.isFinite(Date.parse(call.time)));
    assert.ok(call.ms >= 0);
    assert.equal(call.inputBytes, Buffer.byteLength(SECRET_PROMPT));
  }
  assert.equal(meter.calls[0].outputBytes, Buffer.byteLength(SECRET_ANSWER));
  assert.ok(meter.calls.slice(1).every((c) => c.outputBytes === 0));
  assert.ok(!JSON.stringify(meter.calls).includes('PROMPT-TEXT') && !JSON.stringify(meter.calls).includes('ANSWER-TEXT'));
});

test('CallTelemetry writes 0600 JSON lines in a 0700 folder, never prompt or answer text, and rotates past its size', async () => {
  const dir = dirFor('file');
  const telemetry = new CallTelemetry({ dir, maxBytes: 600 });
  const rt = await fakeRuntime();
  const meter = callMeter(new CallBudget({ file: join(dir, '..', 'budget.json'), limits: () => ({ night: 100, improveDay: 100 }) }), telemetry);
  for (let i = 0; i < 6; i++) await createPiRunner(rt, { spawn: spawnWith('ok'), meter }).run(SECRET_PROMPT, print('decide'));
  telemetry.record({ time: new Date().toISOString(), feature: 'decide', model: 'claude-x', promptVersion: 'v', ms: 1, outcome: 'ok', inputBytes: 1, outputBytes: 1, prompt: 'LEAK' } as never);
  await telemetry.flush();
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ['calls.1.jsonl', 'calls.jsonl']);
  let lines = 0;
  for (const name of names) {
    assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
    const text = await readFile(join(dir, name), 'utf8');
    assert.doesNotMatch(text, /PROMPT-TEXT|ANSWER-TEXT|LEAK|mission/);
    lines += text.split('\n').filter(Boolean).length;
  }
  assert.ok(lines >= 3 && lines <= 7, 'at most two files are kept');
});

test('summary(): counts per feature and outcome, total time, and p50/p95 per feature over the runs that started', async () => {
  const telemetry = new CallTelemetry({ dir: dirFor('summary') });
  const at = (minutes: number) => new Date(Date.parse('2026-10-28T23:00:00.000Z') + minutes * 60_000).toISOString();
  const add = (feature: CallRecord['feature'], outcome: CallRecord['outcome'], ms: number, minutes = 10) =>
    telemetry.record({ time: at(minutes), feature, model: 'claude-sonnet-5-5', promptVersion: 'v', ms, outcome, inputBytes: 10, outputBytes: 5 });
  for (let i = 1; i <= 20; i++) add('decide', 'ok', i * 100);
  add('decide', 'timeout', 9000);
  add('decide', 'budget', 0);
  add('judge', 'ok', 300);
  add('judge', 'busy', 0);
  add('propose', 'ok', 999, -120);
  await telemetry.flush();
  const summary = await telemetry.summary(Date.parse(at(0)));
  assert.deepEqual(summary.calls, { decide: { ok: 20, timeout: 1, budget: 1 }, judge: { ok: 1, busy: 1 } });
  assert.equal(summary.total, 24);
  assert.equal(summary.totalMs, 21000 + 9000 + 300);
  assert.deepEqual(summary.latency.decide, { p50: 1100, p95: 2000, runs: 21 });
  assert.deepEqual(summary.latency.judge, { p50: 300, p95: 300, runs: 1 });
  assert.equal(summary.latency.propose, undefined, 'outside the window');
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([5], 0.95), 5);
});

test('a corrupt or foreign line is skipped by summary()', async () => {
  const dir = dirFor('corrupt');
  const telemetry = new CallTelemetry({ dir });
  telemetry.record({ time: new Date().toISOString(), feature: 'judge', model: 'claude-sonnet-5-5', promptVersion: 'v', ms: 5, outcome: 'ok', inputBytes: 1, outputBytes: 1 });
  await telemetry.flush();
  await writeFile(join(dir, 'calls.jsonl'), `${await readFile(join(dir, 'calls.jsonl'), 'utf8')}not json\n{"feature":"evil","outcome":"ok","ms":1,"time":"${new Date().toISOString()}"}\n`);
  const summary = await new CallTelemetry({ dir }).summary(0);
  assert.deepEqual(summary.calls, { judge: { ok: 1 } });
});

test('S3: a stored line from the translation days (feature translate) is skipped by summary(), and record() writes none', async () => {
  const dir = dirFor('old-translate');
  const telemetry = new CallTelemetry({ dir });
  telemetry.record({ time: new Date().toISOString(), feature: 'propose', model: 'claude-sonnet-5-5', promptVersion: 'v', ms: 5, outcome: 'ok', inputBytes: 1, outputBytes: 1 });
  telemetry.record({ time: new Date().toISOString(), feature: 'translate' as never, model: 'claude-haiku-5-5', promptVersion: 'memory-es-v1', ms: 5, outcome: 'ok', inputBytes: 1, outputBytes: 1 });
  await telemetry.flush();
  assert.equal((await readFile(join(dir, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).length, 1);
  const old = { time: new Date().toISOString(), feature: 'translate', model: 'claude-haiku-5-5', promptVersion: 'memory-es-v1', ms: 900, outcome: 'ok', inputBytes: 10, outputBytes: 12 };
  await writeFile(join(dir, 'calls.1.jsonl'), `${JSON.stringify(old)}\n`);
  const summary = await new CallTelemetry({ dir }).summary(0);
  assert.deepEqual(summary.calls, { propose: { ok: 1 } });
  assert.equal(summary.total, 1);
});
