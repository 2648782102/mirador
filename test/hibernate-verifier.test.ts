// Verifier probes for idle sleep (Risk items 1 and 4).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents, type OpenAgentRecord } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { AttentionStore } from '../src/attention/store.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import { IdleSleep } from '../src/terminals/hibernate.ts';
import { loadConfig } from '../src/config.ts';

const HOUR = 60 * 60_000;
const IDLE_MS = 4 * HOUR;
const SAVE_MS = 15 * 60_000;
let scratch: string;
before(async () => { scratch = await realpath(await mkdtemp(join(tmpdir(), 'verifier-hibernate-'))); });
const started: Array<{ openAgents: OpenAgents; idle: IdleSleep }> = [];
after(async () => {
  for (const { idle } of started) idle.stop();
  await Promise.all(started.map(({ openAgents }) => openAgents.flush()));
  await rm(scratch, { recursive: true, force: true });
});

class FakePty implements PtyProcess {
  readonly env: Record<string, string>;
  exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  constructor(env: Record<string, string>) { this.env = env; }
  onData() {}
  onExit(l: (e: { exitCode: number; signal?: number }) => void) { this.exit = l; }
  write() {}
  resize() {}
  kill() {}
}
function fakeTimers() {
  let clock = 0;
  const timers: Array<{ ms: number; due: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => { const t = { ms, due: clock + ms, run, cancelled: false }; timers.push(t); return () => void (t.cancelled = true); };
  const pass = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock = next.due; next.cancelled = true; next.run();
    }
    clock = until;
  };
  const armed = (ms: number) => timers.filter((t) => !t.cancelled && t.ms === ms).length;
  return { schedule, pass, armed };
}
let counter = 0;
let sessions = 0;
let seq = 1_000_000;
const NOW = 1_000_000;
const errors: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
after(() => { console.error = origError; });

async function mirador(opts: { idleMs?: number; dir?: string; sendNote?: (m: Mirador, id: string) => Promise<{ sent: boolean; reason?: string }> } = {}) {
  const place = opts.dir ?? join(scratch, `case-${++counter}`);
  await mkdir(join(place, 'state'), { recursive: true });
  const owner = join(place, 'config.json');
  await writeFile(owner, '{}');
  const file = join(place, 'state', 'open-agents.json');
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (_f, _a, o) => { const p = new FakePty(o.env); spawned.push(p); return p; };
  const stopped: string[][] = [];
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000, scopes: true, stopScopes: async (u) => void stopped.push(u) });
  const attention = new AttentionStore({ now: () => NOW });
  registry.subscribe((e) => attention.track(e));
  const logs: string[] = [];
  const log = (l: string) => void logs.push(l);
  const openAgents = await OpenAgents.load(file, { owner, log, schedule: () => () => undefined });
  openAgents.track(registry);
  attention.onAgentState((id, s) => void openAgents.recordState(id, s));
  const notes: Array<{ terminalId: string; text: string }> = [];
  const timers = fakeTimers();
  const m: any = { place, file, owner, registry, attention, openAgents, notes, timers, logs, spawned, stopped };
  const idle = new IdleSleep({
    registry, attention, openAgents,
    sendNote: async (terminalId, text) => { notes.push({ terminalId, text }); return opts.sendNote ? opts.sendNote(m, terminalId) : { sent: true }; },
    idleMs: opts.idleMs ?? IDLE_MS, saveTurnMs: SAVE_MS, schedule: timers.schedule, log,
  });
  idle.start();
  m.idle = idle;
  started.push({ openAgents, idle });
  return m as Mirador;
}
type Mirador = { place: string; file: string; owner: string; registry: TerminalRegistry; attention: AttentionStore; openAgents: OpenAgents; idle: IdleSleep; notes: Array<{ terminalId: string; text: string }>; timers: ReturnType<typeof fakeTimers>; logs: string[]; spawned: FakePty[]; stopped: string[][] };
const report = (pane: string, source: string, tokens: Record<string, string>, clear: string[] = []) => JSON.stringify({ v: 1, cmd: 'report-metadata', pane, source, seq: ++seq, tokens, clear });
const working = (m: Mirador, id: string) => m.attention.receive(report(id, 'mirador:attention', {}, ['blocked', 'prompt', 'finished']));
const finished = (m: Mirador, id: string, turn: string) => m.attention.receive(report(id, 'mirador:attention', { finished: turn }, ['blocked', 'prompt']));
const night = (m: Mirador, id: string, state: 'deciding' | 'resolved' | 'deferred' | 'cleared', flow: 'note' | 'follow-up' = 'note') => m.attention.night({ terminalId: id, state, flow, summary: 'x', at: new Date(NOW).toISOString(), ...(state === 'deferred' ? { rule: 'not-delivered', reason: 'no confirm' } : {}) });
async function agentIn(m: Mirador, rel: string) {
  const info = m.registry.create({ cwd: `/w/${rel}`, kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel });
  const session = join(m.place, `${rel}-${++sessions}.jsonl`);
  await writeFile(session, '{}\n');
  assert.equal(await m.openAgents.recordSession(info.id, session), true);
  working(m, info.id);
  return { id: info.id, session };
}
const isOpen = (m: Mirador, id: string) => m.registry.get(id)?.status === 'running';
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { agents: OpenAgentRecord[] };
const gateOf = () => new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }), sleep: async () => undefined });
const resolveFolder = async (workspaceId: string, rel: string) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` });

test('P1 night: a deciding or deferred night state at due keeps the agent open and re-arms; a resolved one does not (S7 night decision pending)', async () => {
  const m = await mirador();
  const deciding = await agentIn(m, 'deciding');
  const deferred = await agentIn(m, 'deferred');
  const resolved = await agentIn(m, 'resolved');
  for (const a of [deciding, deferred, resolved]) finished(m, a.id, 't-1');
  night(m, deciding.id, 'deciding', 'follow-up');
  night(m, deferred.id, 'deferred', 'follow-up');
  night(m, resolved.id, 'resolved', 'follow-up');
  m.timers.pass(IDLE_MS);
  assert.deepEqual(m.notes.map((n) => n.terminalId), [resolved.id]);
  assert.equal(m.timers.armed(IDLE_MS), 2, 'deciding and deferred re-armed');
  assert.equal(isOpen(m, deciding.id) && isOpen(m, deferred.id), true);
});

test('P2 night (real sendNote path): deciding then resolved before the save turn ends still sleeps; a night hold appearing during the save turn keeps it open', async () => {
  const m = await mirador({ sendNote: async (mm, id) => { night(mm, id, 'deciding'); night(mm, id, 'resolved'); return { sent: true }; } });
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.notes.length, 1);
  working(m, a.id);
  finished(m, a.id, 't-2');
  assert.equal(m.registry.get(a.id), undefined, 'closed');
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.rel), ['a']);
  // Same, but the bridge never confirms: the real path leaves `deferred not-delivered` on the pane.
  const n = await mirador({ sendNote: async (mm, id) => { night(mm, id, 'deciding'); night(mm, id, 'deferred'); return { sent: true, delivered: false } as any; } });
  const b = await agentIn(n, 'b');
  finished(n, b.id, 't-1');
  n.timers.pass(IDLE_MS);
  await new Promise((r) => setImmediate(r));
  working(n, b.id);
  finished(n, b.id, 't-2');
  // The note's own night state is bound to the finished card and goes when the save turn starts: it never blocks the sleep.
  assert.equal(n.registry.get(b.id), undefined, 'sleeps: the deferred not-delivered state bound to the old card was dropped at the turn start');
  assert.deepEqual(n.openAgents.sleeping().map((s) => s.rel), ['b']);
  assert.equal(errors.filter((e) => /listener failed/.test(e)).length, 0, 'no swallowed listener error');
});

test('P3 shutdown during the save turn (keep before stop, as server.ts): nothing closes, the record stays live as working, next start reopens it', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, a.id);
  m.openAgents.keep();
  finished(m, a.id, 't-2');
  assert.equal(isOpen(m, a.id), true);
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.deepEqual(m.stopped, []);
  m.idle.stop();
  await m.registry.closeAll();
  await m.openAgents.flush();
  const { agents } = await read(m.file);
  assert.deepEqual(agents.map((r) => [r.id, r.lastState]), [[a.id, 'working']]);
  const next = await mirador({ dir: m.place });
  await next.openAgents.restore({ registry: next.registry, resolveFolder, sessionArgs: (f) => ['--session', f], gate: gateOf(), sleep: async () => undefined });
  assert.deepEqual(next.registry.list().map((t) => t.rel), ['a'], 'reopened, not asleep');
  assert.deepEqual(next.openAgents.sleeping(), []);
});

test('P4 an agent opened by hand in the same folder during the save turn: both records persist, the sleeper is kept, wakes with its own session', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'same');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, a.id);
  const b = await agentIn(m, 'same');
  finished(m, a.id, 't-2');
  assert.equal(m.registry.get(a.id), undefined);
  assert.equal(isOpen(m, b.id), true);
  assert.deepEqual(m.openAgents.sleeping().map((s) => s.id), [a.id]);
  await m.openAgents.flush();
  assert.deepEqual((await read(m.file)).agents.map((r) => [r.id, r.lastState]), [[a.id, 'finished'], [b.id, 'working']]);
  m.idle.stop(); m.openAgents.keep(); await m.registry.closeAll(); await m.openAgents.flush();
  const next = await mirador({ dir: m.place });
  await next.openAgents.restore({ registry: next.registry, resolveFolder, sessionArgs: (f) => ['--session', f], gate: gateOf(), sleep: async () => undefined });
  assert.deepEqual(next.registry.list().map((t) => t.rel), ['same']);
  assert.match(next.spawned.at(-1)!.env.MIRADOR_AGENT_COMMAND, new RegExp(`'--session' '${b.session}'`));
  assert.deepEqual(next.openAgents.sleeping().map((s) => s.id), [a.id]);
  const woken = next.openAgents.wake({ id: a.id })!;
  assert.deepEqual(await woken.done, { restored: 1, dropped: 0 });
  assert.match(next.spawned.at(-1)!.env.MIRADOR_AGENT_COMMAND, new RegExp(`'--session' '${a.session}'`));
  // Rule (baseline): a hand open in a sleeper's folder replaces the sleeper. Candidate keeps it.
  const c = await mirador();
  const s = await agentIn(c, 'f'); finished(c, s.id, 't-1'); c.timers.pass(IDLE_MS); working(c, s.id); finished(c, s.id, 't-2');
  assert.deepEqual(c.openAgents.sleeping().map((x) => x.id), [s.id]);
  await agentIn(c, 'f');
  assert.deepEqual(c.openAgents.sleeping(), [], 'R5a: a later hand open in the folder drops the sleeper (same as baseline for restart sleepers)');
});

test('P6 cost: a silent agent gets at most one note per idle period (+ save timeout); a refused note is retried only an idle period later', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'silent');
  finished(m, a.id, 't-1');
  m.timers.pass(3 * (IDLE_MS + SAVE_MS) - 1);
  assert.equal(m.notes.length, 3);
  assert.equal(isOpen(m, a.id), true);
  const n = await mirador({ sendNote: async () => ({ sent: false, reason: 'no bridge' }) });
  const b = await agentIn(n, 'b');
  finished(n, b.id, 't-1');
  n.timers.pass(IDLE_MS); await new Promise((r) => setImmediate(r));
  n.timers.pass(IDLE_MS - 1); await new Promise((r) => setImmediate(r));
  assert.equal(n.notes.length, 1);
  n.timers.pass(1); await new Promise((r) => setImmediate(r));
  assert.equal(n.notes.length, 2);
});

test('P7 the agent exits by itself during the save turn: nothing is closed by idle sleep, no sleeper, no scope stop from it', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, a.id);
  m.spawned[0].exit!({ exitCode: 0 });
  assert.equal(m.registry.get(a.id)?.status, 'exited');
  assert.deepEqual(m.openAgents.sleeping(), []);
  assert.deepEqual(m.stopped, []);
  assert.equal(m.timers.armed(SAVE_MS), 0);
});

test('P8 the close happens once: a second finished report for the sleeping agent after close is ignored; closed id gone from registry and live file', async () => {
  const m = await mirador();
  const a = await agentIn(m, 'a');
  finished(m, a.id, 't-1');
  m.timers.pass(IDLE_MS);
  working(m, a.id);
  finished(m, a.id, 't-2');
  assert.equal(m.attention.receive(report(a.id, 'mirador:attention', { finished: 't-3' })), false);
  assert.deepEqual(m.stopped, [[`mirador-agent-${a.id}`]]);
  assert.equal(m.logs.filter((l) => /sleeps:/.test(l)).length, 1);
  await m.openAgents.flush();
  assert.deepEqual((await read(m.file)).agents.map((r) => r.id), [a.id]);
});

test('P9 config: null and absent give the default silently; 0.0005 and 168 are kept; 169, "4", -0.1, {} and [] fall back with the problem line', async () => {
  const home = join(scratch, 'cfg-home');
  await mkdir(home, { recursive: true });
  const file = async (name: string, body: unknown) => { const p = join(scratch, `${name}.json`); await writeFile(p, JSON.stringify(body)); return p; };
  assert.equal((await loadConfig(await file('null', { idleSleepHours: null }), { HOME: home })).idleSleepHours, 4);
  assert.deepEqual((await loadConfig(await file('null', { idleSleepHours: null }), { HOME: home })).launchProblems, []);
  for (const v of [0.0005, 168, 0]) assert.equal((await loadConfig(await file(`v${v}`, { idleSleepHours: v }), { HOME: home })).idleSleepHours, v);
  for (const v of [169, '4', -0.1, {}, []]) {
    const c = await loadConfig(await file(`bad${JSON.stringify(v)}`, { idleSleepHours: v }), { HOME: home });
    assert.equal(c.idleSleepHours, 4);
    assert.equal(c.launchProblems.length, 1);
  }
});
