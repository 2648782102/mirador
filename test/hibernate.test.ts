// Idle sleep: an open agent whose turn has been finished
// for the idle time (4 h by default) with nothing else going on is asked to save its session summary
// through a Mirador note; once it finishes that turn it is closed (the × scope stop) and becomes a
// sleeping record. Real registry, attention store and OpenAgents, fake pty, fake timers, real files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents, type OpenAgentRecord } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { AttentionStore } from '../src/attention/store.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import { IdleSleep, sleepNote, sleepNoteText } from '../src/terminals/hibernate.ts';

const HOUR = 60 * 60_000;
const IDLE_MS = 4 * HOUR;
const SAVE_MS = 15 * 60_000;

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-hibernate-')));
});
/** Every Mirador of these tests, so the last record writes land before the scratch goes. */
const started: Array<{ openAgents: OpenAgents; idle: IdleSleep }> = [];
after(async () => {
  for (const { idle } of started) idle.stop();
  await Promise.all(started.map(({ openAgents }) => openAgents.flush()));
  await rm(scratch, { recursive: true, force: true });
});

class FakePty implements PtyProcess {
  readonly env: Record<string, string>;
  killed = false;
  constructor(env: Record<string, string>) {
    this.env = env;
  }
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {
    this.killed = true;
  }
}

/** Timers on a fake clock: `pass(ms)` moves it forward and runs what falls due, in order. */
function fakeTimers() {
  let clock = 0;
  const timers: Array<{ ms: number; due: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { ms, due: clock + ms, run, cancelled: false };
    timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  const pass = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock = next.due;
      next.cancelled = true;
      next.run();
    }
    clock = until;
  };
  /** Timers of `ms` still to run. */
  const armed = (ms: number) => timers.filter((t) => !t.cancelled && t.ms === ms).length;
  return { schedule, pass, armed };
}

let counter = 0;
let seq = 1_000_000;
const NOW = 1_000_000;

/** A Mirador with every piece the idle sleep needs; `idleMs` and `ownerName` as the config gives them. */
async function mirador(idleMs = IDLE_MS, dir?: string, ownerName?: unknown) {
  const place = dir ?? join(scratch, `case-${++counter}`);
  await mkdir(join(place, 'state'), { recursive: true });
  const owner = join(place, 'config.json');
  await writeFile(owner, '{}');
  const file = join(place, 'state', 'open-agents.json');
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (_file, _args, opts) => {
    const pty = new FakePty(opts.env);
    spawned.push(pty);
    return pty;
  };
  const stopped: string[][] = [];
  const registry = new TerminalRegistry(spawn, {
    shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000,
    scopes: true, stopScopes: async (units) => void stopped.push(units),
  });
  const attention = new AttentionStore({ now: () => NOW });
  registry.subscribe((event) => attention.track(event));
  const logs: string[] = [];
  const log = (line: string) => void logs.push(line);
  const openAgents = await OpenAgents.load(file, { owner, log, schedule: () => () => undefined });
  openAgents.track(registry);
  attention.onAgentState((id, state) => void openAgents.recordState(id, state));
  const notes: Array<{ terminalId: string; text: string; framed: string; from?: string }> = [];
  const timers = fakeTimers();
  const idle = new IdleSleep({
    registry,
    attention,
    openAgents,
    sendNote: async (terminalId, text, _noteId, frame, from) => {
      notes.push({ terminalId, text, framed: frame(text), from });
      return { sent: true, delivered: true };
    },
    idleMs,
    saveTurnMs: SAVE_MS,
    schedule: timers.schedule,
    log,
    ...(ownerName === undefined ? {} : { ownerName: () => ownerName }),
  });
  idle.start();
  started.push({ openAgents, idle });
  return { place, file, owner, registry, attention, openAgents, idle, notes, timers, logs, spawned, stopped };
}

type Mirador = Awaited<ReturnType<typeof mirador>>;

const report = (pane: string, source: string, tokens: Record<string, string>, clear: string[] = []) =>
  JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source, seq: ++seq, tokens, clear });
const working = (m: Mirador, id: string) => m.attention.receive(report(id, 'mirador:attention', {}, ['blocked', 'prompt', 'finished']));
const finished = (m: Mirador, id: string, turn: string) => m.attention.receive(report(id, 'mirador:attention', { finished: turn }, ['blocked', 'prompt']));
const prompt = (m: Mirador, id: string) => m.attention.receive(report(id, 'mirador:attention', { prompt: 'Allow?' }, ['finished']));
const todo = (m: Mirador, id: string, text: string) => m.attention.receive(report(id, 'gentle:activity', { summary: text }));

/** An agent in folder `rel` whose bridge reported a session file and a first turn under way. */
async function agentIn(m: Mirador, rel: string) {
  const info = m.registry.create({ cwd: `/w/${rel}`, kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel });
  const session = join(m.place, `${rel}.jsonl`);
  await writeFile(session, '{}\n');
  assert.equal(await m.openAgents.recordSession(info.id, session), true);
  working(m, info.id);
  return { id: info.id, session };
}

const isOpen = (m: Mirador, id: string) => m.registry.get(id)?.status === 'running';

test('the save note names the owner as config ownerName says; unset or not valid it says the user', async () => {
  for (const [ownerName, expected] of [[undefined, 'the user'], ['Ana', 'Ana'], ['  Ana  ', 'Ana'], ['<b>', 'the user']] as const) {
    const m = await mirador(IDLE_MS, undefined, ownerName);
    const a = await agentIn(m, 'a');
    finished(m, a.id, 't-1');
    m.timers.pass(IDLE_MS);
    assert.equal(m.notes.length, 1, String(ownerName));
    assert.equal(m.notes[0].text, sleepNote(expected), String(ownerName));
    assert.match(m.notes[0].text, new RegExp(`it resumes this same session when ${expected} wakes it\\. Save your session summary now`), String(ownerName));
    assert.equal(m.notes[0].framed, sleepNoteText(m.notes[0].text), 'framed as Mirador’s note');
  }
});
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { agents: OpenAgentRecord[] };

test('an agent finished for 4 hours is asked to save its session summary, and once that turn ends it is closed and sleeps', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(HOUR);
  assert.equal(m.notes.length, 0, 'nothing before the idle time');
  m.timers.pass(IDLE_MS - HOUR);
  assert.equal(m.notes.length, 1);
  assert.equal(m.notes[0].terminalId, a.id);
  assert.match(m.notes[0].text, /mem_session_summary/);
  assert.match(m.notes[0].framed, /^Note from Mirador/);
  assert.equal(m.notes[0].from, 'mirador', 'logged as Mirador’s note, not the user’s');
  assert.equal(isOpen(m, a.id), true, 'open while it saves');

  working(m, a.id);
  assert.equal(isOpen(m, a.id), true);
  finished(m, a.id, 't-2');
  assert.equal(m.registry.get(a.id), undefined, 'closed once the save turn ended');
  assert.deepEqual(m.stopped, [[`mirador-agent-${a.id}`]], 'its scope is stopped, as × does');
  assert.deepEqual(m.openAgents.sleeping().map((s) => [s.id, s.rel, s.resumable]), [[a.id, 'a', true]]);
  await m.openAgents.flush();
  const [record] = (await read(m.file)).agents;
  assert.deepEqual([record.id, record.rel, record.sessionFile, record.lastState], [a.id, 'a', a.session, 'finished']);
  assert.equal(m.logs.filter((line) => /^mirador: .*sleep/.test(line)).length, 1, 'one log line for the agent put to sleep');
});

test('an agent that works, waits for the user, has an unknown state, an open Todo or no session to resume never sleeps', async () => {
  const m = await mirador();
  const busy = await agentIn(m, 'busy');
  const asking = await agentIn(m, 'asking');
  prompt(m, asking.id);
  const silent = m.registry.create({ cwd: '/w/silent', kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel: 'silent' });
  const listed = await agentIn(m, 'listed');
  todo(m, listed.id, 'Fix the bug');
  finished(m, listed.id, 't-1');
  const fresh = m.registry.create({ cwd: '/w/fresh', kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel: 'fresh' });
  working(m, fresh.id);
  finished(m, fresh.id, 't-1');
  // Finished, then it asks something before the idle time ran out.
  const later = await agentIn(m, 'later');
  finished(m, later.id, 't-1');
  prompt(m, later.id);
  assert.equal(m.timers.armed(IDLE_MS), 2, 'only the finished agents have an idle clock');
  for (let round = 0; round < 3; round++) m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes, []);
  for (const id of [busy.id, asking.id, silent.id, listed.id, fresh.id, later.id]) assert.equal(isOpen(m, id), true);
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.equal(m.timers.armed(IDLE_MS), 2, 'the Todo and the missing session restart their clocks; the others have none');
});

// An agent whose program stopped with an error (OSC 7501
// state=error) waits for the user, so idle sleep never counts it as idle, even after the agent left and
// its bash drew a prompt (an error record survives the prompt mark, release-f1).
const osc = (m: Mirador, id: string, state: string, msg?: string) => m.attention.programStatus(id, { id: '', state, ...(msg ? { msg } : {}) } as never);

test('F2: an agent stopped with an error is never idle: no idle clock, no save note, it stays open and awake', async () => {
  const m = await mirador();
  const broken = await agentIn(m, 'broken');
  osc(m, broken.id, 'error', 'Build failed');
  m.attention.programPrompt(broken.id);
  // Finished first, then an error before the idle time ran out: the clock stops.
  const later = await agentIn(m, 'later');
  osc(m, later.id, 'done');
  assert.equal(m.timers.armed(IDLE_MS), 1, 'the finished agent has a clock');
  m.timers.pass(HOUR);
  osc(m, later.id, 'error', 'Out of tokens');
  assert.equal(m.timers.armed(IDLE_MS), 0, 'an error stops it');
  for (let round = 0; round < 3; round++) m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes, []);
  for (const id of [broken.id, later.id]) {
    assert.equal(m.attention.agentState(id), 'error');
    assert.equal(isOpen(m, id), true);
  }
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.deepEqual(m.stopped, []);
  // Once its program says it is done again, it is idle like any finished agent.
  osc(m, broken.id, 'done');
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes.map((n) => n.terminalId), [broken.id]);
});

test('F2: an error during the save turn keeps the agent open, and no idle clock starts until it is finished again', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  osc(m, a.id, 'done');
  m.timers.pass(IDLE_MS);
  assert.equal(m.notes.length, 1, 'asked to save');
  osc(m, a.id, 'working');
  osc(m, a.id, 'error', 'Cannot save');
  assert.equal(isOpen(m, a.id), true);
  assert.equal(m.timers.armed(SAVE_MS), 0, 'the save turn is over');
  assert.equal(m.timers.armed(IDLE_MS), 0, 'an agent in error has no idle clock');
  m.timers.pass(3 * IDLE_MS);
  assert.equal(m.notes.length, 1, 'no second note while in error');
  assert.deepEqual(m.openAgents.sleeping(), []);
  await m.openAgents.flush();
  assert.deepEqual((await read(m.file)).agents.map((r) => [r.id, r.lastState]), [[a.id, 'error']], 'its record reopens it after a restart');
});

test('the user typing into it or a question after the save note keeps the agent open, and its idle clock starts again', async () => {
  const m = await mirador();
  const typed = await agentIn(m, 'typed');
  const asked = await agentIn(m, 'asked');
  finished(m, typed.id, 't-1');
  finished(m, asked.id, 't-1');
  // A focus report is the terminal's own reply, not the user.
  m.registry.write(typed.id, '\x1b[I');
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes.map((n) => n.terminalId), [typed.id, asked.id]);

  working(m, typed.id);
  m.registry.write(typed.id, 'wait, one more thing\r');
  finished(m, typed.id, 't-2');
  working(m, asked.id);
  prompt(m, asked.id);
  finished(m, asked.id, 't-2');
  assert.equal(isOpen(m, typed.id), true);
  assert.equal(isOpen(m, asked.id), true);
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.equal(m.timers.armed(SAVE_MS), 0);

  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes.map((n) => n.terminalId), [typed.id, asked.id, typed.id, asked.id], 'asked again a full idle time later');
});

test('typing into a finished agent restarts its idle clock', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(2 * HOUR);
  m.registry.write(a.id, 'ls\r');
  assert.equal(m.timers.armed(IDLE_MS), 1, 'one clock, from the keystroke');
  m.timers.pass(2 * HOUR);
  assert.equal(m.notes.length, 0, '4 h after the turn ended, but only 2 h after the keystroke');
  m.timers.pass(2 * HOUR);
  assert.equal(m.notes.length, 1);
});

test('a save turn that does not end in time leaves the agent open, and it is not closed when that turn ends later', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, a.id);
  m.timers.pass(SAVE_MS);
  assert.equal(isOpen(m, a.id), true);
  finished(m, a.id, 't-2');
  assert.equal(isOpen(m, a.id), true, 'too late: it stays open');
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.equal(m.timers.armed(IDLE_MS), 1, 'its clock started again');
});

test('a save note that cannot go out leaves the agent open with its clock started again', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  const refused = new IdleSleep({
    registry: m.registry, attention: m.attention, openAgents: m.openAgents,
    sendNote: async () => ({ sent: false, reason: "the agent's bridge is not connected" }),
    idleMs: IDLE_MS, schedule: m.timers.schedule, log: () => undefined,
  });
  m.idle.stop();
  refused.start();
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.timers.armed(SAVE_MS), 0);
  assert.equal(m.timers.armed(IDLE_MS), 1);
  assert.equal(isOpen(m, a.id), true);
});

test('with idle sleep off (0 hours) no agent is ever asked to save or closed', async () => {
  const m = await mirador(0);
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  assert.equal(m.timers.armed(0), 0);
  m.timers.pass(0);
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes, []);
  assert.equal(isOpen(m, a.id), true);
});

test('an agent put to sleep for idling stays asleep after a restart and wakes with its pi session through the gate', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  const b = await agentIn(m, 'b');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, a.id);
  finished(m, a.id, 't-2');
  await m.openAgents.flush();
  // The server stops (keep) with b still working; then it starts again.
  m.idle.stop();
  m.openAgents.keep();
  await m.registry.closeAll();
  await m.openAgents.flush();

  const next = await mirador(IDLE_MS, m.place);
  const gate = new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }), sleep: async () => undefined });
  const resolveFolder = async (workspaceId: string, rel: string) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` });
  await next.openAgents.restore({ registry: next.registry, resolveFolder, sessionArgs: (file) => ['--session', file], gate, sleep: async () => undefined });
  assert.deepEqual(next.registry.list().map((t) => t.rel), ['b'], 'only the working agent reopens');
  assert.deepEqual(next.openAgents.sleeping().map((s) => [s.id, s.rel, s.resumable]), [[a.id, 'a', true]]);
  const woken = next.openAgents.wake({ id: a.id });
  assert.ok(woken);
  assert.deepEqual(await woken.done, { restored: 1, dropped: 0 });
  assert.equal(gate.status().runs.at(-1)?.kind, 'wake');
  assert.deepEqual(next.registry.list().map((t) => t.rel), ['b', 'a']);
  assert.match(next.spawned.at(-1)!.env.MIRADOR_AGENT_COMMAND, new RegExp(`'--session' '${a.session}'`));
  assert.deepEqual(next.openAgents.sleeping(), []);
  void b;
});

test('PRESERVE: × still closes an agent for good, also while it saves, and Olvidar forgets an agent put to sleep for idling', async () => {
  const m = await mirador();
  const saving = await agentIn(m, 'saving');
  const slept = await agentIn(m, 'slept');
  finished(m, saving.id, 't-1');
  finished(m, slept.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, slept.id);
  finished(m, slept.id, 't-2');
  working(m, saving.id);
  m.registry.close(saving.id);
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.rel), ['slept'], 'the agent closed with × does not sleep');
  assert.equal(m.timers.armed(SAVE_MS), 0);
  assert.equal(m.openAgents.forgetSleeping(slept.id), true);
  assert.deepEqual(m.openAgents.sleeping(), []);
  await m.openAgents.flush();
  assert.deepEqual((await read(m.file)).agents, []);
});
