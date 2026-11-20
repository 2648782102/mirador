// Nightly Claude call budget: a persistent counter checked and taken at the
// runner, after the gate slot and before the spawn, so no caller (decider, judge, "Mejorar con IA")
// can go around it. Fake spawns and fake clocks only: no model, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { BUDGET_REASON, CallBudget, budgetMeter, jornadaOf, localNight } from '../src/night/budget.ts';
import type { AppContext } from '../src/http/context.ts';
import { createNightReportRoutes } from '../src/http/routes/night-report.ts';
import type { Notice, NotifyChannel } from '../src/night/notify.ts';
import { PiGate, PiRunError, createPiRunner, type CallMeter, type PiRuntime } from '../src/memory/translate.ts';
import { createDecider } from '../src/night/decider.ts';
import { BUDGET_NOTE, createJudge, JudgmentStore } from '../src/night/judge.ts';
import { NightService, type NightLink } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { MiradorLine, NightQuestion } from '../src/night/protocol.ts';
import type { AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-budget-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

let counter = 0;
const fileFor = (name: string) => join(scratch, `${name}-${++counter}`, 'night', 'budget.json');

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

/** A spawn whose children answer `answer` once their stdin ends; counts spawns. */
function answering(answer: string) {
  const spawned: string[] = [];
  const spawn = ((_command: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push(args[args.indexOf('--model') + 1]);
    child.stdin.on('finish', () => {
      child.stdout.end(answer);
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  }) as never;
  return { spawn, spawned };
}

const limits = (night: number, improveDay: number) => () => ({ night, improveDay });

test('take() is atomic: 50 parallel runs with room for 10 spawn exactly 10, the rest fail as budget without a process', async () => {
  const budget = new CallBudget({ file: fileFor('atomic'), limits: limits(10, 100) });
  const rt = await fakeRuntime();
  const { spawn, spawned } = answering('{}');
  const runner = createPiRunner(rt, { spawn, gate: new PiGate({ maxConcurrent: 50, maxQueue: 50 }), meter: budgetMeter(budget) });
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      runner.run(`input ${i}`, { model: 'claude-sonnet-5-5', systemPrompt: 's', feature: 'decide', promptVersion: 'v' }).then(
        () => 'ok',
        (error) => (error instanceof PiRunError ? error.kind : String(error)),
      ),
    ),
  );
  assert.equal(results.filter((r) => r === 'ok').length, 10);
  assert.equal(results.filter((r) => r === 'budget').length, 40);
  assert.equal(spawned.length, 10, 'an exhausted budget never spawns');
  assert.deepEqual({ used: budget.night().used, limit: budget.night().limit }, { used: 10, limit: 10 });
  await budget.flush();
});

test('direct take(): exactly the limit is granted under a burst, per scope; an unknown feature is refused', () => {
  const budget = new CallBudget({ file: fileFor('take'), limits: limits(3, 2) });
  const granted = Array.from({ length: 20 }, (_, i) => budget.take((['decide', 'follow-up', 'judge'] as const)[i % 3])).filter(Boolean).length;
  assert.equal(granted, 3);
  assert.equal([budget.take('propose'), budget.take('propose'), budget.take('propose')].filter(Boolean).length, 2);
  assert.equal(budget.take('nope' as never), false, 'fail closed');
});

test('the counter persists in a 0600 file inside a 0700 folder and survives a new instance', async () => {
  const file = fileFor('persist');
  const first = new CallBudget({ file, limits: limits(5, 5), today: () => '2026-10-28' });
  first.startNight('2026-10-28T23:00:00.000Z');
  first.take('decide');
  first.take('judge');
  first.take('propose');
  await first.flush();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(file, '..'))).mode & 0o777, 0o700);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.night.used, 2);
  assert.equal(saved.improve.used, 1);
  const second = new CallBudget({ file, limits: limits(5, 5), today: () => '2026-10-28' });
  assert.deepEqual(second.night(), { used: 2, limit: 5, since: '2026-10-28T23:00:00.000Z' });
  assert.deepEqual(second.improveToday(), { used: 1, limit: 5, day: '2026-10-28' });
});

test('a new activation resets the night counter; the same activation does not; the improvements counter resets at day change', async () => {
  let day = '2026-10-28';
  const budget = new CallBudget({ file: fileFor('reset'), limits: limits(2, 1), today: () => day });
  budget.startNight('2026-10-28T23:00:00.000Z');
  assert.ok(budget.take('decide') && budget.take('follow-up'));
  assert.equal(budget.take('judge'), false);
  budget.startNight('2026-10-28T23:00:00.000Z');
  assert.equal(budget.night().used, 2, 'restating the same activation keeps the count');
  budget.startNight('2026-10-29T23:00:00.000Z');
  assert.equal(budget.night().used, 0);
  assert.ok(budget.take('judge'));
  assert.ok(budget.take('propose'));
  assert.equal(budget.take('propose'), false);
  day = '2026-10-29';
  assert.ok(budget.take('propose'), 'a new day');
  assert.deepEqual(budget.improveToday(), { used: 1, limit: 1, day: '2026-10-29' });
  await budget.flush();
});

/* ---------- A restart inside the night keeps the count ---------- */

const ZONE = 'America/Santiago';
const nightOf = (since: string) => localNight(ZONE, since);
// 23:00, 03:30 and 05:00 of the night of 2026-10-28 in Santiago (-03), and 22:00 the next evening.
const NIGHT_START = '2026-10-29T02:00:00.000Z';
const NIGHT_RESTART = '2026-10-29T06:30:00.000Z';
const NIGHT_LATER = '2026-10-29T08:00:00.000Z';
const NEXT_EVENING = '2026-10-30T01:00:00.000Z';

const savedNight = async (file: string) => JSON.parse(await readFile(file, 'utf8')).night;

test('localNight(): the local date of the activation minus 12 hours, noon to noon in the zone', () => {
  assert.equal(localNight(ZONE, NIGHT_START), '2026-10-28');
  assert.equal(localNight(ZONE, NIGHT_RESTART), '2026-10-28', 'after midnight is still the same night');
  assert.equal(localNight(ZONE, '2026-10-29T14:59:00.000Z'), '2026-10-28', '11:59 the next morning');
  assert.equal(localNight(ZONE, '2026-10-29T15:00:00.000Z'), '2026-10-29', 'noon starts the next night');
  assert.equal(localNight(ZONE, NEXT_EVENING), '2026-10-29');
  assert.equal(localNight('UTC', NIGHT_START), '2026-10-28', 'the zone decides the date');
  assert.equal(localNight('UTC', NEXT_EVENING), '2026-10-29');
});

test('a restart inside the same local night keeps the count and the first activation', async () => {
  const file = fileFor('restart');
  const first = new CallBudget({ file, limits: limits(4, 5), nightOf });
  first.startNight(NIGHT_START);
  assert.ok(first.take('decide') && first.take('follow-up') && first.take('judge'));
  await first.flush();
  // The server restarts (no off) and the schedule re-activates a few hours later, same night.
  const second = new CallBudget({ file, limits: limits(4, 5), nightOf });
  second.startNight(NIGHT_RESTART);
  assert.deepEqual(second.night(), { used: 3, limit: 4, since: NIGHT_START });
  assert.ok(second.take('decide'), 'the last call of the night');
  assert.equal(second.take('decide'), false, 'the limit still counts the calls before the restart');
  await second.flush();
  assert.deepEqual(await savedNight(file), { since: NIGHT_START, used: 4, announced: true, ended: false });
});

test('an off does not start the count over: a new activation in the same jornada keeps it, also after a restart (D2)', async () => {
  const file = fileFor('ended');
  const first = new CallBudget({ file, limits: limits(4, 5), nightOf });
  first.startNight(NIGHT_START);
  assert.ok(first.take('decide') && first.take('judge'));
  first.endNight();
  assert.deepEqual(first.night(), { used: 2, limit: 4, since: NIGHT_START }, 'turning off keeps the count for the summary');
  await first.flush();
  assert.deepEqual(await savedNight(file), { since: NIGHT_START, used: 2, announced: false, ended: true }, 'budget.json keeps its keys');
  const second = new CallBudget({ file, limits: limits(4, 5), nightOf });
  second.startNight(NIGHT_RESTART);
  assert.deepEqual(second.night(), { used: 2, limit: 4, since: NIGHT_START });
  await second.flush();
  assert.deepEqual(await savedNight(file), { since: NIGHT_START, used: 2, announced: false, ended: false });
});

test('a night that never ended and an activation in a later local night start over', async () => {
  const file = fileFor('crash');
  const first = new CallBudget({ file, limits: limits(1, 5), nightOf });
  first.startNight(NIGHT_START);
  assert.ok(first.take('decide'));
  assert.equal(first.take('decide'), false);
  await first.flush();
  const second = new CallBudget({ file, limits: limits(1, 5), nightOf });
  second.startNight(NEXT_EVENING);
  assert.deepEqual(second.night(), { used: 0, limit: 1, since: NEXT_EVENING });
  assert.ok(second.take('decide'), 'a new night has room again');
  await second.flush();
  assert.deepEqual(await savedNight(file), { since: NEXT_EVENING, used: 1, announced: false, ended: false });
});

test('a budget file without `ended` (before L16) still loads; a new activation in its jornada keeps the count (D2)', async () => {
  const file = fileFor('legacy');
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ v: 1, night: { since: NIGHT_START, used: 3, announced: false }, translate: { day: '', used: 0, announced: false } }), { mode: 0o600 });
  const budget = new CallBudget({ file, limits: limits(4, 5), nightOf });
  assert.deepEqual(budget.night(), { used: 3, limit: 4, since: NIGHT_START }, 'the saved count is still read');
  budget.startNight(NIGHT_RESTART);
  assert.deepEqual(budget.night(), { used: 3, limit: 4, since: NIGHT_START });
  budget.startNight(NEXT_EVENING);
  assert.deepEqual(budget.night(), { used: 0, limit: 4, since: NEXT_EVENING }, 'a later jornada starts over');
  await budget.flush();
  assert.deepEqual(await savedNight(file), { since: NEXT_EVENING, used: 0, announced: false, ended: false });
});

/** The night report module over a temp folder, with an injected on/off feed and a recording desktop channel. */
async function nightReport(budget: CallBudget) {
  const dir = join(scratch, `report-${++counter}`, 'night');
  const shutdown: Array<() => void | Promise<void>> = [];
  const listeners = new Set<(active: boolean, since: string | null) => void>();
  const desktop: NotifyChannel & { sent: Notice[] } = { name: 'desktop', sent: [], send: async (notice) => void desktop.sent.push(notice) };
  const ctx = {
    config: { nightModel: undefined, notifications: undefined },
    workspaces: { get: () => undefined, list: () => [] },
    onShutdown: (fn: () => void | Promise<void>) => void shutdown.push(fn),
  } as unknown as AppContext;
  await createNightReportRoutes({
    dir,
    telegramFile: join(dir, '..', 'telegram.json'),
    judgeRun: async () => '{"verdict":"ok","note":"fine"}',
    channels: { desktop },
    budget,
    onActiveChange: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  })(ctx);
  return {
    desktop,
    emit: (active: boolean, since: string | null) => {
      for (const listener of [...listeners]) listener(active, since);
    },
    shutdown: async () => {
      for (const fn of shutdown) await fn();
    },
  };
}

async function waitFor<T>(check: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

test('night report: a shutdown does not end the night; a real off does, and the next activation in that jornada keeps the count', async () => {
  const file = fileFor('report');
  const firstBudget = new CallBudget({ file, limits: limits(10, 5), nightOf });
  const firstRun = await nightReport(firstBudget);
  firstRun.emit(true, NIGHT_START);
  assert.ok(firstBudget.take('decide') && firstBudget.take('judge'));
  // The server shuts down inside the night: no off event, no morning summary.
  await firstRun.shutdown();
  await firstBudget.flush();
  assert.equal(firstRun.desktop.sent.some((notice) => notice.kind === 'morning'), false);
  assert.deepEqual(await savedNight(file), { since: NIGHT_START, used: 2, announced: false, ended: false });

  const budget = new CallBudget({ file, limits: limits(10, 5), nightOf });
  const restarted = await nightReport(budget);
  restarted.emit(true, NIGHT_RESTART);
  assert.deepEqual(budget.night(), { used: 2, limit: 10, since: NIGHT_START }, 'the re-activation after the restart keeps the count');
  // The user turns it off: the morning summary goes out and the counted night ends.
  restarted.emit(false, NIGHT_RESTART);
  const morning = await waitFor(() => restarted.desktop.sent.find((notice) => notice.kind === 'morning'));
  assert.match(morning.body, /Llamadas a Claude: 2 de 10/);
  await budget.flush();
  assert.deepEqual(await savedNight(file), { since: NIGHT_START, used: 2, announced: false, ended: true });
  restarted.emit(true, NIGHT_LATER);
  assert.deepEqual(budget.night(), { used: 2, limit: 10, since: NIGHT_START }, 'on again by hand the same jornada: the same count (D2)');
  await restarted.shutdown();
  await budget.flush();
});

test('limits follow the getter at once (a profile change), and exhaustion is announced once per night and once per day', async () => {
  let night = 1;
  const budget = new CallBudget({ file: fileFor('notify'), limits: () => ({ night, improveDay: 1 }), today: () => '2026-10-28' });
  const heard: Array<{ scope: string; used: number; limit: number }> = [];
  budget.onExhausted((event) => heard.push({ scope: event.scope, used: event.used, limit: event.limit }));
  budget.startNight('2026-10-28T23:00:00.000Z');
  assert.ok(budget.take('decide'));
  for (let i = 0; i < 5; i++) assert.equal(budget.take('decide'), false);
  assert.deepEqual(heard, [{ scope: 'night', used: 1, limit: 1 }]);
  night = 3;
  assert.ok(budget.take('decide'), 'a higher limit applies at once');
  budget.take('propose');
  budget.take('propose');
  budget.take('propose');
  assert.deepEqual(heard.map((h) => h.scope), ['night', 'improve']);
  budget.startNight('2026-10-29T23:00:00.000Z');
  night = 0;
  budget.take('decide');
  assert.deepEqual(heard.map((h) => h.scope), ['night', 'improve', 'night'], 'a new night announces again');
  await budget.flush();
});

const refusing = (feature?: string): CallMeter & { taken: string[] } => {
  const taken: string[] = [];
  return { taken, take: (f) => (taken.push(f), f !== feature && feature !== undefined ? true : false), record: () => {} };
};

test('decider: an exhausted budget defers with rule budget and the fixed reason, and spawns nothing', async () => {
  const rt = await fakeRuntime();
  const { spawn, spawned } = answering('{"action":"answer","choices":[0],"reason":"r","confidence":0.9}');
  const meter = refusing();
  const decider = createDecider({ runtime: rt, spawn, meter, gate: new PiGate() });
  const q: NightQuestion = {
    terminalId: 't', toolCallId: 'c', tool: 'ask_user_choice', allowCustomResponse: false,
    items: [{ question: 'Grid or list?', header: '', multiSelect: false, options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }] }],
  };
  const ctx = { workspaceId: 'dev', workspaceName: 'Dev', rel: 'a', cwd: '/a', mission: 'Ship it.', activity: null, recentOutput: '', lastMessage: 'Done. Continue?' };
  assert.deepEqual(await decider.decide(q, ctx), { action: 'defer', reason: BUDGET_REASON, rule: 'budget' });
  assert.deepEqual(await decider.followUp(ctx), { action: 'defer', reason: BUDGET_REASON, rule: 'budget' });
  assert.equal(BUDGET_REASON, 'nightly Claude budget reached');
  assert.deepEqual(meter.taken, ['decide', 'follow-up']);
  assert.equal(spawned.length, 0);
});

test('judge: an exhausted budget stores doubtful "budget reached" without a model process', async () => {
  const rt = await fakeRuntime();
  const { spawn, spawned } = answering('{"verdict":"ok","note":"fine"}');
  const store = new JudgmentStore(join(scratch, `judge-${++counter}`, 'judgments.jsonl'));
  const judge = createJudge({ log: { recent: async () => [] }, store, workspaces: { get: () => ({ name: 'Dev', mission: 'm' }) }, runtime: rt, spawn, meter: refusing('judge') });
  const stored = await judge.review(decided('j1', 0.9));
  assert.equal(stored?.verdict, 'doubtful');
  assert.equal(stored?.note, BUDGET_NOTE);
  assert.match(BUDGET_NOTE, /budget reached/i);
  assert.equal(spawned.length, 0);
  judge.close();
});

test('"Mejorar con IA": an exhausted daily budget refuses the propose run with kind budget and spawns nothing', async () => {
  const rt = await fakeRuntime();
  const { spawn, spawned } = answering('mejor');
  const meter = refusing();
  const run = createPiRunner(rt, { spawn, meter, gate: new PiGate() }).run('hello', { model: 'claude-haiku-5-5', systemPrompt: 's', feature: 'propose', promptVersion: 'v' });
  await assert.rejects(run, (error: unknown) => error instanceof PiRunError && error.kind === 'budget');
  assert.deepEqual(meter.taken, ['propose']);
  assert.equal(spawned.length, 0);
});

test('S3: translate is no call feature any more: a run tagged translate is refused before any process, and take() refuses it', async () => {
  const rt = await fakeRuntime();
  const { spawn, spawned } = answering('hola');
  const meter = refusing('none');
  const run = createPiRunner(rt, { spawn, meter, gate: new PiGate() }).run('hello', { model: 'm', systemPrompt: 's', feature: 'translate' as never, promptVersion: 'v' });
  await assert.rejects(run, (error: unknown) => error instanceof PiRunError && error.kind === 'not-started');
  assert.deepEqual(meter.taken, []);
  assert.equal(spawned.length, 0);
  assert.equal(new CallBudget({ file: fileFor('no-translate'), limits: limits(5, 5) }).take('translate' as never), false);
});

test('S3: a budget.json from before S3 keeps its day counter under translate: it loads without error as today\'s improvements count', async () => {
  const file = fileFor('old-translate');
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({ v: 1, night: { since: null, used: 0, announced: false, ended: true }, translate: { day: '2026-10-28', used: 3, announced: false } }), { mode: 0o600 });
  const budget = new CallBudget({ file, limits: limits(5, 4), today: () => '2026-10-28' });
  assert.deepEqual(budget.improveToday(), { used: 3, limit: 4, day: '2026-10-28' });
  assert.ok(budget.take('propose'));
  assert.equal(budget.take('propose'), false, 'the old count still counts against the limit');
  await budget.flush();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.improve, { day: '2026-10-28', used: 4, announced: true });
  assert.deepEqual(new CallBudget({ file, limits: limits(5, 4), today: () => '2026-10-29' }).improveToday(), { used: 0, limit: 4, day: '2026-10-29' }, 'a new day starts at zero');
});

test('a run without a known feature tag is refused before any process', async () => {
  const rt = await fakeRuntime();
  const { spawn, spawned } = answering('x');
  const runner = createPiRunner(rt, { spawn, meter: refusing('never') });
  await assert.rejects(runner.run('x', { model: 'm', systemPrompt: 's' } as never), (error: unknown) => error instanceof PiRunError && error.kind === 'not-started');
  assert.equal(spawned.length, 0);
});

/* ---------- The service keeps rule `budget` ---------- */

function decided(id: string, confidence: number): NightRecord {
  return {
    id, time: new Date().toISOString(), kind: 'question', terminalId: 't1', workspaceId: 'dev', rel: 'a', tool: 'ask_user_choice',
    question: { allowCustomResponse: false, items: [{ question: 'Grid or list?', header: '', options: ['Grid', 'List'], multiSelect: false }] },
    policy: { allowed: true }, decision: { action: 'answer', choices: [{ item: 0, index: 0, label: 'Grid' }], reason: 'r', confidence },
    followUp: null, sent: 'decided', delivered: null, outcome: 'decided', deferral: null, error: null,
  };
}

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

test('the night service defers a budget refusal with rule budget, for a question and for a follow-up', async () => {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 4096 });
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const link: NightLink = { send: (id, line) => (connected.has(id) ? (sent.push([id, line]), true) : false), isConnected: (id) => connected.has(id), connectedTerminals: () => [...connected] };
  const records: NightRecord[] = [];
  const id = terminals.create({ cwd: '/dev/a', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'a' }).id;
  connected.add(id);
  const item: AttentionItem = { terminalId: id, workspaceId: 'dev', rel: 'a', title: 'a', kind: 'finished', label: 'Finished', detail: null, since: new Date().toISOString(), activity: null };
  const budgetDefer = async () => ({ action: 'defer' as const, reason: BUDGET_REASON, rule: 'budget' });
  const service = new NightService({
    link,
    decider: { decide: budgetDefer, followUp: budgetDefer },
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: () => ({ id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship.' }) },
    attention: () => ({ items: () => [item] }),
    decideBudgetMs: 2000,
    deliveryTimeoutMs: 200,
  });
  service.setActive(true);
  await service.question(id, 'r1', {
    terminalId: id, toolCallId: 'c', tool: 'ask_user_choice', allowCustomResponse: false,
    items: [{ question: 'Grid or list?', header: '', multiSelect: false, options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }] }],
  });
  const delegated = service.delegate(id);
  await delegated?.done;
  assert.deepEqual(records.map((r) => [r.kind, r.outcome, r.deferral?.rule, r.deferral?.reason]), [
    ['question', 'deferred', 'budget', BUDGET_REASON],
    ['delegate', 'deferred', 'budget', BUDGET_REASON],
  ]);
  assert.deepEqual(sent, [[id, { type: 'pass', requestId: 'r1' }]], 'the dialog opens for the user; no follow-up goes out');
  service.close();
});

/* ---------- One budget per jornada; no cap while on by hand ---------- */

/** The jornada of the night schedule 23:00-07:00 in Santiago. */
const jornada = (since: string) => jornadaOf(ZONE, '07:00', since);
// 2026-10-29 in Santiago (UTC-3): 15:00 by day, 23:00 that evening, 06:00 and 07:00 the next morning.
const DAY_SESSION = '2026-10-29T18:00:00.000Z';
const EVENING = '2026-10-30T02:00:00.000Z';
const SIX = '2026-10-30T09:00:00.000Z';
const SEVEN = '2026-10-30T10:00:00.000Z';

test('jornadaOf: the local date a jornada started; it ends when the schedule window ends, at 06:00 without a schedule (D2)', () => {
  assert.equal(jornadaOf(ZONE, '07:00', '2026-10-30T09:59:00.000Z'), '2026-10-29', '06:59 local: still the jornada of the day before');
  assert.equal(jornadaOf(ZONE, '07:00', SEVEN), '2026-10-30', '07:00 local: a new jornada');
  assert.equal(jornada(DAY_SESSION), jornada(EVENING), 'a day session and that evening share one jornada');
  assert.equal(jornadaOf(ZONE, null, '2026-10-30T08:59:00.000Z'), '2026-10-29', 'no schedule: 05:59 is still the jornada before');
  assert.equal(jornadaOf(ZONE, null, SIX), '2026-10-30', 'no schedule: it ends at 06:00');
  assert.equal(jornadaOf('Not/AZone', null, SIX), jornadaOf(undefined, null, SIX), 'an unknown zone falls back to the system zone');
});

test('a day session and that evening\'s night share one count, across an off and a restart (D2)', async () => {
  const file = fileFor('shared');
  let now = Date.parse(DAY_SESSION);
  const day = new CallBudget({ file, limits: limits(10, 5), nightOf: jornada, now: () => now });
  day.startNight(DAY_SESSION);
  assert.ok(day.take('decide') && day.take('judge'));
  day.endNight();
  await day.flush();
  now = Date.parse(EVENING);
  const night = new CallBudget({ file, limits: limits(10, 5), nightOf: jornada, now: () => now });
  night.startNight(EVENING);
  assert.deepEqual(night.night(), { used: 2, limit: 10, since: DAY_SESSION });
  assert.ok(night.take('follow-up'));
  await night.flush();
  assert.deepEqual(await savedNight(file), { since: DAY_SESSION, used: 3, announced: false, ended: false });
});

test('the count starts over when the jornada ends, also while a manual on stays on across it; a restart keeps the new count (D2)', async () => {
  const file = fileFor('rollover');
  let now = Date.parse(SIX);
  const budget = new CallBudget({ file, limits: limits(10, 5), nightOf: jornada, now: () => now, uncapped: () => true });
  budget.startNight(EVENING);
  assert.ok(budget.take('decide') && budget.take('decide'));
  now = Date.parse(SEVEN);
  assert.deepEqual(budget.night(), { used: 0, limit: 10, since: SEVEN }, 'the meter starts over at once');
  assert.ok(budget.take('decide'));
  await budget.flush();
  assert.deepEqual(await savedNight(file), { since: SEVEN, used: 1, announced: false, ended: false });
  now += 30 * 60_000;
  const restarted = new CallBudget({ file, limits: limits(10, 5), nightOf: jornada, now: () => now });
  restarted.startNight(new Date(now).toISOString());
  assert.deepEqual(restarted.night(), { used: 1, limit: 10, since: SEVEN });
  await restarted.flush();
});

test('without a schedule the jornada ends at 06:00: a session from 20:00 keeps its count past midnight (D2)', async () => {
  let now = Date.parse('2026-10-29T23:00:00.000Z');
  const budget = new CallBudget({ file: fileFor('no-schedule'), limits: limits(10, 5), nightOf: (since) => jornadaOf(ZONE, null, since), now: () => now });
  budget.startNight(new Date(now).toISOString());
  assert.ok(budget.take('decide'));
  now = Date.parse('2026-10-30T08:59:00.000Z');
  assert.ok(budget.take('decide'));
  assert.equal(budget.night().used, 2, '05:59: the same jornada');
  now = Date.parse(SIX);
  assert.ok(budget.take('decide'));
  assert.equal(budget.night().used, 1, '06:00: a new one');
  await budget.flush();
});

test('on by hand there is no cap: every call is granted and counted, and passing the limit is announced once per jornada (D2)', async () => {
  let now = Date.parse(DAY_SESSION);
  let manual = true;
  const budget = new CallBudget({ file: fileFor('uncapped'), limits: limits(2, 5), nightOf: jornada, now: () => now, uncapped: () => manual });
  const passed: Array<{ used: number; limit: number }> = [];
  const exhausted: Array<{ scope: string; used: number; limit: number }> = [];
  budget.onPassed((event) => passed.push({ used: event.used, limit: event.limit }));
  budget.onExhausted((event) => exhausted.push({ scope: event.scope, used: event.used, limit: event.limit }));
  budget.startNight(DAY_SESSION);
  for (let i = 0; i < 5; i++) assert.equal(budget.take('decide'), true, `call ${i + 1}`);
  assert.deepEqual(budget.night(), { used: 5, limit: 2, since: DAY_SESSION });
  assert.deepEqual(passed, [{ used: 3, limit: 2 }], 'once, when the count passed the limit');
  assert.deepEqual(exhausted, [], 'nothing refused');
  // Handed over to the schedule: capped from now on, counting what was used.
  manual = false;
  assert.equal(budget.take('judge'), false);
  assert.equal(budget.night().used, 5);
  assert.deepEqual(exhausted, [{ scope: 'night', used: 5, limit: 2 }]);
  // The next jornada, by hand again: a new count and a new single notice.
  manual = true;
  now = Date.parse('2026-10-30T18:00:00.000Z');
  for (let i = 0; i < 4; i++) assert.ok(budget.take('decide'));
  assert.deepEqual(passed, [{ used: 3, limit: 2 }, { used: 3, limit: 2 }]);
  await budget.flush();
});

test('the scheduled night still stops at the cap and announces it once (D2, previous behavior)', async () => {
  const budget = new CallBudget({ file: fileFor('scheduled'), limits: limits(2, 5), nightOf: jornada, now: () => Date.parse(EVENING), uncapped: () => false });
  let heard = 0;
  let passed = 0;
  budget.onExhausted(() => heard++);
  budget.onPassed(() => passed++);
  budget.startNight(EVENING);
  assert.deepEqual([budget.take('decide'), budget.take('judge'), budget.take('decide'), budget.take('follow-up')], [true, true, false, false]);
  assert.deepEqual([budget.night().used, heard, passed], [2, 1, 0]);
  await budget.flush();
});

test('night report: passing the limit by hand sends one Spanish notice with counts only and the autopilot goes on (D2)', async () => {
  const budget = new CallBudget({ file: fileFor('report-passed'), limits: limits(1, 5), nightOf: jornada, now: () => Date.parse(DAY_SESSION), uncapped: () => true });
  const r = await nightReport(budget);
  r.emit(true, DAY_SESSION);
  assert.ok(budget.take('decide') && budget.take('decide') && budget.take('judge'));
  const notice = await waitFor(() => r.desktop.sent.find((n) => n.kind === 'budget'));
  assert.equal(notice.title, 'Mirador: pasaste el tope de llamadas a Claude');
  assert.equal(notice.body, 'Pasaste la 1 llamada de tu perfil (van 2); el piloto automático sigue porque lo activaste a mano. Puedes cambiar el perfil de recursos en Seguimiento.');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(r.desktop.sent.filter((n) => n.kind === 'budget').length, 1, 'once');
  await r.shutdown();
  await budget.flush();
});

test('calls before any activation count toward the jornada they happen in and do not start over at the next call (D2)', async () => {
  let now = Date.parse(DAY_SESSION);
  const budget = new CallBudget({ file: fileFor('no-activation'), limits: limits(5, 5), nightOf: jornada, now: () => now });
  assert.ok(budget.take('decide') && budget.take('follow-up'));
  assert.deepEqual(budget.night(), { used: 2, limit: 5, since: DAY_SESSION });
  now = Date.parse(EVENING);
  budget.startNight(EVENING);
  assert.equal(budget.night().used, 2, 'that evening shares it');
  await budget.flush();
});

test('a resumed manual on whose since is in an earlier jornada keeps the current jornada\'s count after a restart (D2)', async () => {
  const file = fileFor('resume-rollover');
  let now = Date.parse(SIX);
  const first = new CallBudget({ file, limits: limits(10, 5), nightOf: jornada, now: () => now, uncapped: () => true });
  first.startNight(EVENING);
  assert.ok(first.take('decide') && first.take('decide'));
  now = Date.parse(SEVEN);
  assert.ok(first.take('decide'), 'rolled over: the first call of the new jornada');
  await first.flush();
  now += 60 * 60_000;
  const restarted = new CallBudget({ file, limits: limits(10, 5), nightOf: jornada, now: () => now, uncapped: () => true });
  restarted.startNight(EVENING);
  assert.deepEqual(restarted.night(), { used: 1, limit: 10, since: SEVEN });
  // An activation in a later jornada still starts over.
  now = Date.parse('2026-10-31T10:30:00.000Z');
  restarted.startNight(new Date(now).toISOString());
  assert.deepEqual(restarted.night(), { used: 0, limit: 10, since: '2026-10-31T10:30:00.000Z' });
  await restarted.flush();
  assert.deepEqual(await savedNight(file), { since: '2026-10-31T10:30:00.000Z', used: 0, announced: false, ended: false });
});
