// Concurrency probes for held questions (Risk 4), from the independent verification.
// real NightService + real NightChannel (Unix socket) + real bridge with a fake pi; a Telegram answer
// (answerHeld) arriving around every way a hold can end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';
import { NightChannel } from '../src/night/channel.ts';
import { NightService, type HeldQuestion } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine, NightDecision } from '../src/night/protocol.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

let scratch: string;
before(async () => { scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-verify-held-'))); });
after(() => rm(scratch, { recursive: true, force: true }));

class FakePty implements PtyProcess { onData() {} onExit() {} write() {} resize() {} kill() {} }
type Handler = (...args: unknown[]) => unknown;
type InputHandler = (data: string) => { consume?: boolean } | undefined;
function fakePi() {
  const hooks = new Map<string, Handler[]>();
  return {
    api: { on: (name: string, handler: Handler) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]); return () => {}; }, events: { on: () => () => {} }, sendUserMessage: () => {} },
    async toolCall(toolName: string, input: unknown, ctx: unknown = {}) {
      for (const handler of hooks.get('tool_call') ?? []) { const result = await handler({ type: 'tool_call', toolName, toolCallId: 'call-1', input }, ctx); if (result) return result; }
      return undefined;
    },
  };
}
function fakeUi() {
  const statuses: Array<[string, string | undefined]> = [];
  const inputs = new Set<InputHandler>();
  return { statuses, inputs, ui: { setStatus: (k: string, t: string | undefined) => void statuses.push([k, t]), onTerminalInput: (h: InputHandler) => { inputs.add(h); return () => void inputs.delete(h); } },
    type(data: string): boolean { for (const h of [...inputs]) if (h(data)?.consume) return true; return false; } };
}
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
let counter = 0;
const SENSITIVE = { question: 'Deploy to production now?', options: [{ label: 'Yes', description: 'Deploy', value: 'v1' }, { label: 'No', description: 'Wait', value: 'v2' }] };
const PLAIN = { question: 'Which layout should the report use?', options: [{ label: 'Grid', description: 'g', value: 'v1' }, { label: 'List', description: 'l', value: 'v2' }] };

async function rig(options: { decide?: () => Promise<NightDecision>; budgetMs?: number; questionTimeoutMs?: number } = {}) {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const records: NightRecord[] = [];
  const held: HeldQuestion[] = [];
  const ended: Array<[string, string]> = [];
  const disconnects: string[] = [];
  let service: NightService;
  const channel = await NightChannel.open(path, {
    question: (t, r, q) => void service.question(t, r, q).catch((e) => console.error('question failed', e)),
    delivered: (t, m) => service.delivered(t, m),
    disconnected: (t) => { disconnects.push(t); service.disconnected(t); },
    released: (t, r) => service.released(t, r),
  });
  const sent: MiradorLine[] = [];
  const origSend = channel.send.bind(channel);
  (channel as { send: NightChannel['send'] }).send = (t, line) => { sent.push(line); return origSend(t, line); };
  const decider: Decider = { decide: options.decide ?? (async () => ({ action: 'defer', reason: 'The mission says nothing.' })), followUp: async () => ({ action: 'defer', reason: 'no' }) };
  service = new NightService({ link: channel, decider, log: { append: async (r) => void records.push(r) }, terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship it.' } : undefined) },
    attention: () => ({ items: () => [] }), decideBudgetMs: options.budgetMs ?? 2000 });
  service.onHeld((q) => void held.push(q));
  service.onHeldEnd((id, outcome) => void ended.push([id, outcome]));
  const info = terminals.create({ cwd: '/dev/alpha', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'alpha' });
  const token = channel.issueToken(info.id);
  const pi = fakePi();
  createAttentionBridge({ env: { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: info.id, MIRADOR_NIGHT_SOCKET: path, MIRADOR_NIGHT_TOKEN: token }, seq: 1000, night: { questionTimeoutMs: options.questionTimeoutMs ?? 150, retryMinMs: 20, retryMaxMs: 50 } })(pi.api);
  await until(() => channel.isConnected(info.id));
  const decidedLines = () => sent.filter((l) => l.type === 'decided');
  const close = async () => { service.close(); await channel.close(); };
  return { path, channel, service, sent, records, held, ended, disconnects, pi, terminalId: info.id, decidedLines, close, terminals };
}

/** Holds one sensitive question; returns the pi result holder and the held question. */
async function hold(r: Awaited<ReturnType<typeof rig>>, ctx: Record<string, unknown>, input: unknown = SENSITIVE) {
  r.service.setActive(true);
  r.service.holdForAnswers(true);
  let result: unknown = 'pending';
  const done = r.pi.toolCall('ask_user_choice', input, ctx).then((v) => { result = v; return v; });
  await until(() => r.held.length === 1);
  assert.equal(r.sent.at(-1)?.type, 'held');
  return { get result() { return result; }, done, held: r.held[0] };
}

test('P1 answer from Telegram: the bridge gets exactly one decided, the tool is blocked with it, a second answer is ended and sends nothing', async () => {
  const r = await rig();
  try {
    const ui = fakeUi();
    const q = await hold(r, { ui: ui.ui, hasUI: true });
    await sleep(300);
    assert.equal(q.result, 'pending', 'no 150 ms timeout while held');
    assert.deepEqual(r.service.answerHeld(q.held.id, [[1]], 'telegram'), { ok: true });
    assert.deepEqual(await q.done, { block: true, reason: 'User selected: 2. No' });
    assert.deepEqual(r.service.answerHeld(q.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
    assert.equal(r.decidedLines().length, 1);
    assert.deepEqual(r.ended, [[q.held.id, 'answered']]);
    assert.equal(ui.inputs.size, 0);
    await tick();
    assert.deepEqual(r.records.map((x) => [x.sent, x.outcome, x.decidedBy ?? null]), [['held', 'deferred', null], ['decided', 'decided', 'user-telegram']]);
    assert.deepEqual(r.service.status().pending, []);
  } finally { await r.close(); }
});

test('P2 Esc at the terminal: the dialog opens, Mirador ends it terminal once, a later Telegram answer is ended and nothing reaches the bridge', async () => {
  const r = await rig();
  try {
    const ui = fakeUi();
    const q = await hold(r, { ui: ui.ui, hasUI: true });
    await until(() => ui.inputs.size === 1);
    assert.equal(ui.type('\x1b'), true);
    assert.equal(await q.done, undefined);
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[q.held.id, 'terminal']]);
    assert.deepEqual(r.service.answerHeld(q.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
    assert.equal(r.decidedLines().length, 0);
    assert.equal(ui.type('\x1b'), false, 'a second Esc is pi\'s again');
    r.service.released(r.terminalId, 'stale-id');
    await sleep(50);
    assert.equal(r.ended.length, 1, 'ended exactly once');
    assert.equal(r.service.status().pending.length, 1, 'still pending for the terminal');
  } finally { await r.close(); }
});

test('P3 abort of the tool call: nothing opens, Mirador ends it terminal once, a later answer is ended', async () => {
  const r = await rig();
  try {
    const ui = fakeUi();
    const controller = new AbortController();
    const q = await hold(r, { ui: ui.ui, hasUI: true, signal: controller.signal });
    await until(() => ui.inputs.size === 1);
    controller.abort();
    assert.equal(await q.done, undefined);
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[q.held.id, 'terminal']]);
    assert.deepEqual(r.service.answerHeld(q.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
    assert.equal(r.decidedLines().length, 0);
    assert.equal(ui.inputs.size, 0);
  } finally { await r.close(); }
});

test('P4 bridge connection cut and reconnected: ended closed once by the disconnect; the released sent after the new hello is a no-op', async () => {
  const r = await rig();
  try {
    const ui = fakeUi();
    const q = await hold(r, { ui: ui.ui, hasUI: true });
    await until(() => ui.inputs.size === 1);
    const conn = (r.channel as unknown as { connections: Map<string, { destroy(): void }> }).connections.get(r.terminalId)!;
    conn.destroy();
    assert.equal(await q.done, undefined, 'the dialog opens at the terminal');
    await until(() => r.disconnects.length === 1);
    assert.deepEqual(r.ended, [[q.held.id, 'closed']]);
    await until(() => r.channel.isConnected(r.terminalId));
    await sleep(100);
    assert.equal(r.ended.length, 1, 'the released after hello ends nothing twice');
    assert.deepEqual(r.service.answerHeld(q.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
    assert.equal(r.decidedLines().length, 0);
    assert.deepEqual(r.service.heldQuestions(), []);
  } finally { await r.close(); }
});

test('P5 holding off / autopilot off / shutdown: pass reaches the bridge (dialog opens), ended once with terminal / stopped / stopped', async () => {
  for (const [name, act, outcome] of [
    ['holding off', (s: NightService) => s.holdForAnswers(false), 'terminal'],
    ['autopilot off', (s: NightService) => void s.setActive(false), 'stopped'],
    ['shutdown', (s: NightService) => s.close(), 'stopped'],
  ] as const) {
    const r = await rig();
    try {
      const ui = fakeUi();
      const q = await hold(r, { ui: ui.ui, hasUI: true });
      await until(() => ui.inputs.size === 1);
      act(r.service);
      assert.equal(r.sent.at(-1)?.type, 'pass', name);
      assert.equal(await q.done, undefined, name);
      assert.deepEqual(r.ended, [[q.held.id, outcome]], name);
      assert.deepEqual(r.service.answerHeld(q.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' }, name);
      await sleep(50);
      assert.equal(r.ended.length, 1, name);
      assert.equal(r.decidedLines().length, 0, name);
      assert.equal(ui.inputs.size, 0, name);
    } finally { await r.close(); }
  }
});

test('P6 held line after the bridge timed out: the bridge releases it, Mirador ends it terminal once; onHeld fired once; the answer is ended', async () => {
  const r = await rig({ decide: () => new Promise((resolve) => setTimeout(() => resolve({ action: 'defer', reason: 'slow' }), 300)), questionTimeoutMs: 100 });
  try {
    const ui = fakeUi();
    r.service.setActive(true);
    r.service.holdForAnswers(true);
    const started = Date.now();
    assert.equal(await r.pi.toolCall('ask_user_choice', PLAIN, { ui: ui.ui, hasUI: true }), undefined);
    assert.ok(Date.now() - started < 250, 'the bridge timed out before the decider');
    await until(() => r.ended.length === 1);
    assert.equal(r.held.length, 1);
    assert.deepEqual(r.ended, [[r.held[0].id, 'terminal']]);
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[0]], 'telegram'), { ok: false, code: 'ended' });
    assert.deepEqual(ui.statuses, []);
  } finally { await r.close(); }
});

test('P7 autopilot off while the decider runs, holding on: pass once, nothing held (S3: stopped still passes)', async () => {
  const r = await rig({ decide: () => new Promise(() => {}) });
  try {
    r.service.setActive(true);
    r.service.holdForAnswers(true);
    let result: unknown = 'pending';
    void r.pi.toolCall('ask_user_choice', PLAIN, {}).then((v) => { result = v; });
    await until(() => r.records.length === 0 && r.service.status().active && (r.service as unknown as { flights: Map<string, unknown> }).flights.size === 1);
    r.service.setActive(false);
    await until(() => result !== 'pending');
    assert.equal(result, undefined);
    assert.deepEqual(r.sent.map((l) => l.type), ['pass']);
    assert.deepEqual(r.held, []);
    await tick();
    assert.deepEqual(r.records.map((x) => [x.sent, x.deferral?.rule]), [['pass', 'stopped']]);
  } finally { await r.close(); }
});

test('P8 decider error / timeout / unfit answer are held (S3 addition); the answer from Telegram then decides them', async () => {
  for (const [name, decide] of [
    ['error', async () => { throw new Error('boom'); }],
    ['timeout', () => new Promise<NightDecision>(() => {})],
    ['unfit', async () => ({ action: 'answer', choices: [9], reason: 'off', confidence: 0.9 })],
  ] as const) {
    const r = await rig({ decide: decide as () => Promise<NightDecision>, budgetMs: 30 });
    try {
      const q = await hold(r, {}, PLAIN);
      assert.deepEqual(r.service.answerHeld(q.held.id, [[0]], 'telegram'), { ok: true }, name);
      assert.deepEqual(await q.done, { block: true, reason: 'User selected: 1. Grid' }, name);
      assert.deepEqual(r.ended, [[q.held.id, 'answered']], name);
    } finally { await r.close(); }
  }
});

test('P10 answerHeld called synchronously inside onHeld (before the held record is logged): ends once, not pending, one decided', async () => {
  const r = await rig();
  try {
    r.service.onHeld((q) => void r.service.answerHeld(q.id, [[0]], 'telegram'));
    r.service.setActive(true);
    r.service.holdForAnswers(true);
    const result = await r.pi.toolCall('ask_user_choice', SENSITIVE, {});
    assert.deepEqual(result, { block: true, reason: 'User selected: 1. Yes' });
    await until(() => r.records.length === 2);
    assert.equal(r.ended.length, 1);
    assert.equal(r.decidedLines().length, 1);
    assert.deepEqual(r.service.status().pending, []);
  } finally { await r.close(); }
});

test('P11 two questions from the same terminal in a row: abort the first (released), the second is held fresh and answered; no cross-talk', async () => {
  const r = await rig();
  try {
    const ui = fakeUi();
    const controller = new AbortController();
    const first = await hold(r, { ui: ui.ui, hasUI: true, signal: controller.signal });
    controller.abort();
    assert.equal(await first.done, undefined);
    let second: unknown = 'pending';
    void r.pi.toolCall('ask_user_choice', SENSITIVE, { ui: ui.ui, hasUI: true }).then((v) => { second = v; });
    await until(() => r.held.length === 2);
    assert.notEqual(r.held[1].id, first.held.id);
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[first.held.id, 'terminal']]);
    assert.deepEqual(r.service.answerHeld(first.held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
    assert.equal(second, 'pending');
    assert.deepEqual(r.service.answerHeld(r.held[1].id, [[1]], 'telegram'), { ok: true });
    await until(() => second !== 'pending');
    assert.deepEqual(second, { block: true, reason: 'User selected: 2. No' });
    assert.equal(r.decidedLines().length, 1);
  } finally { await r.close(); }
});
