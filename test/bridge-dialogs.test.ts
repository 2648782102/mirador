// Blocking pi dialogs answered from Telegram: the
// bridge wraps ctx.ui.select / ctx.ui.confirm, the terminal dialog stays open, and the dialog is
// held by the night service for an answer from Telegram (answerHeld); whichever answers first wins.
// Real NightService + real NightChannel (Unix socket) + real bridge with a fake pi and a fake
// ctx.ui whose dialogs behave like pi's TUI selector (an abort closes them with no answer).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';
import { NightChannel } from '../src/night/channel.ts';
import { NightService, type HeldQuestion } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { Decider, MiradorLine } from '../src/night/protocol.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { scratchBase } from './helpers/scratch.ts';

let scratch: string;
before(async () => { scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-bridge-dialogs-'))); });
after(() => rm(scratch, { recursive: true, force: true }));

class FakePty implements PtyProcess { onData() {} onExit() {} write() {} resize() {} kill() {} }
type Handler = (...args: unknown[]) => unknown;

function fakePi() {
  const hooks = new Map<string, Handler[]>();
  return {
    api: { on: (name: string, handler: Handler) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]); return () => {}; }, events: { on: () => () => {} }, sendUserMessage: () => {} },
    /** Runs the handlers of `name` the way pi does, awaited in order. */
    async emit(name: string, event: unknown, ctx: unknown) {
      for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
    },
    async toolCall(toolName: string, input: unknown, ctx: unknown = {}) {
      for (const handler of hooks.get('tool_call') ?? []) { const result = await handler({ type: 'tool_call', toolName, toolCallId: 'call-1', input }, ctx); if (result) return result; }
      return undefined;
    },
  };
}

interface Opened {
  kind: 'select' | 'confirm';
  args: unknown[];
  opts: { signal?: AbortSignal; timeout?: number } | undefined;
  answer: (value: unknown) => void;
  aborted: boolean;
}

/** pi's ctx.ui for dialogs: each select / confirm opens until answered or its signal aborts (select → undefined, confirm → false). */
function fakeUi() {
  const opened: Opened[] = [];
  const notes: Array<[string, string | undefined]> = [];
  const open = (kind: Opened['kind'], args: unknown[], opts: Opened['opts'], onAbort: unknown) =>
    new Promise<unknown>((resolve) => {
      const call: Opened = { kind, args, opts, answer: resolve, aborted: false };
      opened.push(call);
      const signal = opts?.signal;
      if (signal?.aborted) return void ((call.aborted = true), resolve(onAbort));
      signal?.addEventListener('abort', () => { call.aborted = true; resolve(onAbort); }, { once: true });
    });
  const ui: Record<string, unknown> = {
    select: (title: string, options: string[], opts?: Opened['opts']) => open('select', [title, options], opts, undefined),
    confirm: (title: string, message: string, opts?: Opened['opts']) => open('confirm', [title, message], opts, false),
    notify: (message: string, type?: string) => void notes.push([message, type]),
    setStatus: () => {},
    onTerminalInput: () => () => {},
  };
  return { ui, opened, notes };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

const GUARDED_TITLE = 'Allow guarded actions: git push; git push?';
const GUARDED_PREVIEW = 'git push origin feat/telegram-dialogs && git push --tags';

async function rig(options: { active?: boolean; holding?: boolean } = {}) {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const records: NightRecord[] = [];
  const held: HeldQuestion[] = [];
  const ended: Array<[string, string]> = [];
  /** The `released` / `took` lines the bridge sent, in order. */
  const bridgeLines: string[] = [];
  let service: NightService;
  const channel = await NightChannel.open(path, {
    question: (t, r, q) => void service.question(t, r, q).catch((e) => console.error('question failed', e)),
    dialog: (t, r, d) => service.dialog(t, r, d),
    delivered: (t, m) => service.delivered(t, m),
    disconnected: (t) => service.disconnected(t),
    released: (t, r) => { bridgeLines.push('released'); service.released(t, r); },
    took: (t, r) => { bridgeLines.push('took'); service.took(t, r); },
  });
  const sent: MiradorLine[] = [];
  const origSend = channel.send.bind(channel);
  (channel as { send: NightChannel['send'] }).send = (t, line) => { sent.push(line); return origSend(t, line); };
  const decider: Decider = { decide: async () => ({ action: 'defer', reason: 'The mission says nothing.' }), followUp: async () => ({ action: 'defer', reason: 'no' }) };
  service = new NightService({ link: channel, decider, log: { append: async (r) => void records.push(r) }, terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship it.' } : undefined) },
    attention: () => ({ items: () => [] }), decideBudgetMs: 2000 });
  service.onHeld((q) => void held.push(q));
  service.onHeldEnd((id, outcome) => void ended.push([id, outcome]));
  const info = terminals.create({ cwd: '/dev/alpha', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'alpha' });
  const token = channel.issueToken(info.id);
  const pi = fakePi();
  createAttentionBridge({ env: { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: info.id, MIRADOR_NIGHT_SOCKET: path, MIRADOR_NIGHT_TOKEN: token }, seq: 1000, night: { questionTimeoutMs: 150, retryMinMs: 20, retryMaxMs: 50 } })(pi.api);
  await until(() => channel.isConnected(info.id));
  if (options.active !== false) service.setActive(true);
  if (options.holding !== false) service.holdForAnswers(true);
  const ui = fakeUi();
  await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, { ui: ui.ui, hasUI: true });
  const close = async () => { service.close(); await channel.close(); };
  return { channel, service, sent, records, held, ended, bridgeLines, pi, ui, terminalId: info.id, close, terminals };
}

/** Calls ctx.ui.<kind> the way gentle-ai does, at call time; the result is read later. */
function ask(ui: Record<string, unknown>, kind: 'select' | 'confirm', ...args: unknown[]) {
  let result: unknown = 'pending';
  const done = (ui[kind] as (...a: unknown[]) => Promise<unknown>)(...args).then((value) => { result = value; return value; });
  return { get result() { return result; }, done };
}

test('S1, S3: a guarded command confirmation is held with its title and full preview; Yes from Telegram returns true and closes the terminal dialog', async () => {
  const r = await rig();
  try {
    const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    await until(() => r.held.length === 1);
    assert.equal(r.ui.opened.length, 1, 'the terminal dialog is open too');
    assert.deepEqual(r.ui.opened[0].args, [GUARDED_TITLE, GUARDED_PREVIEW]);
    const [held] = r.held;
    assert.equal(held.tool, 'dialog');
    assert.deepEqual(held.dialog, { kind: 'confirm', title: GUARDED_TITLE, message: GUARDED_PREVIEW });
    assert.deepEqual(held.items[0].options.map((o) => o.label), ['Yes', 'No']);
    assert.ok(held.sensitive, 'every dialog asks for «Confirmar»');
    assert.equal(r.sent.at(-1)?.type, 'held');
    assert.equal(dialog.result, 'pending', 'held, not answered');

    assert.deepEqual(r.service.answerHeld(held.id, [[0]], 'telegram'), { ok: true });
    assert.deepEqual([r.ended, r.records], [[], []], 'sent, not yet answered: the bridge has not taken it');
    await dialog.done;
    assert.equal(dialog.result, true);
    assert.equal(r.ui.opened[0].aborted, true, 'the terminal dialog was closed');
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[held.id, 'answered']]);
    assert.deepEqual(r.bridgeLines, ['took'], 'the bridge says it took the answer');
    await until(() => r.records.length === 1);
    const record = r.records.at(-1)!;
    assert.equal(record.decidedBy, 'user-telegram');
    assert.equal(record.tool, 'dialog');
    assert.deepEqual(record.decision?.choices, [{ item: 0, index: 0, label: 'Yes' }]);
    assert.equal(r.service.status().pending.length, 0, 'a dialog is never listed as pending');
    assert.deepEqual(r.service.answerHeld(held.id, [[1]], 'telegram'), { ok: false, code: 'ended' }, 'a second answer reaches nobody');
  } finally { await r.close(); }
});

test('S2: a select with four options is held with its options as shown; the third from Telegram returns that exact option; No on a confirm returns false', async () => {
  const r = await rig();
  try {
    const options = ['Push now', 'Push with --force-with-lease', 'Open a PR instead', 'Cancel'];
    const select = ask(r.ui.ui, 'select', 'How should the branch go out?', options);
    await until(() => r.held.length === 1);
    assert.deepEqual(r.held[0].dialog, { kind: 'select', title: 'How should the branch go out?', message: '' });
    assert.deepEqual(r.held[0].items[0].options.map((o) => o.label), options);
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[2]], 'telegram'), { ok: true });
    assert.equal(await select.done, 'Open a PR instead');
    assert.equal(r.ui.opened[0].aborted, true);
    await until(() => r.ended.length === 1);

    const confirm = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    await until(() => r.held.length === 2);
    assert.deepEqual(r.service.answerHeld(r.held[1].id, [[4]], 'telegram'), { ok: false, code: 'invalid' }, 'an index the dialog does not have');
    assert.deepEqual(r.service.answerHeld(r.held[1].id, [[1]], 'telegram'), { ok: true });
    assert.equal(await confirm.done, false);
    await until(() => r.records.length === 2);
    assert.deepEqual(r.records.map((record) => record.decision?.choices?.[0].label), ['Open a PR instead', 'No']);
  } finally { await r.close(); }
});

test('S4: the terminal answers first: its result is returned as is, Mirador ends the hold `terminal`, and a late Telegram answer is ended and sends nothing', async () => {
  const r = await rig();
  try {
    const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    await until(() => r.held.length === 1);
    r.ui.opened[0].answer(true);
    assert.equal(await dialog.done, true);
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[r.held[0].id, 'terminal']]);
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[1]], 'telegram'), { ok: false, code: 'ended' });
    assert.ok(!r.sent.some((line) => line.type === 'chosen'), 'nothing reaches the bridge');
    assert.deepEqual(r.records, [], 'a dialog answered in the terminal leaves no record');

    // Esc in the terminal: pi's selector resolves with no answer (select: undefined).
    const select = ask(r.ui.ui, 'select', 'Background subagents policy', ['status', 'enable', 'disable']);
    await until(() => r.held.length === 2);
    r.ui.opened[1].answer(undefined);
    assert.equal(await select.done, undefined);
    await until(() => r.ended.length === 2);
    assert.deepEqual(r.ended[1], [r.held[1].id, 'terminal']);
  } finally { await r.close(); }
});

/** The request id the service answered `held` last. */
const heldRequest = (r: Awaited<ReturnType<typeof rig>>) => (r.sent.filter((line) => line.type === 'held').at(-1) as { requestId: string }).requestId;

test('follow-ups S2: a chosen the bridge cannot apply is ignored and it keeps waiting: a later valid answer from Telegram, or the terminal, still closes the dialog', async () => {
  const r = await rig();
  try {
    const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    await until(() => r.held.length === 1);
    const requestId = heldRequest(r);
    for (const index of [2, -1, 0.5, '0', null]) r.channel.send(r.terminalId, { type: 'chosen', requestId, index } as unknown as MiradorLine);
    r.channel.send(r.terminalId, { type: 'chosen', requestId: 'another-request', index: 0 });
    await sleep(80);
    assert.equal(dialog.result, 'pending', 'nothing applied');
    assert.equal(r.ui.opened[0].aborted, false, 'the terminal dialog stays open');
    assert.deepEqual(r.ended, [], 'still held');
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[1]], 'telegram'), { ok: true });
    await until(() => dialog.result !== 'pending');
    assert.equal(dialog.result, false, 'the valid answer (No) reaches pi');
    assert.equal(r.ui.opened[0].aborted, true);
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[r.held[0].id, 'answered']]);
    assert.equal(r.records.at(-1)?.decidedBy, 'user-telegram');

    const second = ask(r.ui.ui, 'select', 'Pick one', ['a', 'b']);
    await until(() => r.held.length === 2);
    r.channel.send(r.terminalId, { type: 'chosen', requestId: heldRequest(r), index: 9 });
    await sleep(80);
    r.ui.opened[1].answer('b');
    assert.equal(await second.done, 'b', 'the terminal can still answer');
    await until(() => r.ended.length === 2);
    assert.deepEqual(r.ended[1], [r.held[1].id, 'terminal']);
    assert.equal(r.records.length, 1, 'no record for the terminal answer');
  } finally { await r.close(); }
});

test('follow-ups S3: the terminal answers and a Telegram «Confirmar» goes out the same instant: pi gets the terminal value, the hold ends `terminal`, no Telegram record', async () => {
  const r = await rig();
  try {
    const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    await until(() => r.held.length === 1);
    const [held] = r.held;
    r.ui.opened[0].answer(true);
    assert.deepEqual(r.service.answerHeld(held.id, [[1]], 'telegram'), { ok: true }, 'Mirador has not heard the terminal yet');
    assert.equal(r.sent.at(-1)?.type, 'chosen');
    assert.equal(await dialog.done, true, "the terminal's answer");
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[held.id, 'terminal']]);
    await sleep(80);
    assert.deepEqual(r.bridgeLines, ['released'], 'the bridge never took the late answer');
    assert.deepEqual(r.records, [], 'no «Respondido desde Telegram» record');
    assert.deepEqual(r.service.answerHeld(held.id, [[0]], 'telegram'), { ok: false, code: 'ended' });
  } finally { await r.close(); }
});

test('S4: the caller aborting its own signal closes the dialog with pi\'s own result, and Mirador ends the hold `terminal`', async () => {
  const r = await rig();
  try {
    const caller = new AbortController();
    const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW, { signal: caller.signal, timeout: 60_000 });
    await until(() => r.held.length === 1);
    assert.equal(r.ui.opened[0].opts?.timeout, 60_000, "the caller's options reach the dialog");
    caller.abort();
    assert.equal(await dialog.done, false, 'what pi returns for an aborted confirm');
    await until(() => r.ended.length === 1);
    assert.deepEqual(r.ended, [[r.held[0].id, 'terminal']]);

    const before = new AbortController();
    before.abort();
    const late = ask(r.ui.ui, 'select', 'Pick one', ['a', 'b'], { signal: before.signal });
    assert.equal(await late.done, undefined);
    await sleep(100);
    assert.equal(r.held.length, 1, 'a dialog aborted before it opens is never offered');
  } finally { await r.close(); }
});

test('S4: the terminal closing ends the hold `closed`; holding or the autopilot turning off ends it and the terminal dialog stays open', async () => {
  for (const [name, stop, outcome] of [
    ['closed', (r: Awaited<ReturnType<typeof rig>>) => r.channel.revoke(r.terminalId), 'closed'],
    ['holding off', (r: Awaited<ReturnType<typeof rig>>) => r.service.holdForAnswers(false), 'terminal'],
    ['autopilot off', (r: Awaited<ReturnType<typeof rig>>) => r.service.setActive(false), 'stopped'],
  ] as const) {
    const r = await rig();
    try {
      const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
      await until(() => r.held.length === 1);
      stop(r);
      await until(() => r.ended.length === 1);
      assert.deepEqual(r.ended, [[r.held[0].id, outcome]], name);
      await sleep(50);
      assert.equal(dialog.result, 'pending', `${name}: the terminal dialog stays`);
      assert.equal(r.ui.opened[0].aborted, false, name);
      r.ui.opened[0].answer(true);
      assert.equal(await dialog.done, true, name);
      assert.deepEqual(r.service.answerHeld(r.held[0].id, [[0]], 'telegram'), { ok: false, code: 'ended' }, name);
    } finally { await r.close(); }
  }
});

test('S6, S7: with the autopilot or holding off a dialog behaves exactly as without Mirador: the original once, its result untouched, nothing held', async () => {
  for (const options of [{ active: false }, { holding: false }]) {
    const r = await rig(options);
    try {
      const dialog = ask(r.ui.ui, 'select', 'Background subagents policy', ['status', 'enable', 'disable']);
      await until(() => r.sent.some((line) => line.type === 'pass'));
      assert.equal(r.ui.opened.length, 1, JSON.stringify(options));
      assert.deepEqual(r.ui.opened[0].args, ['Background subagents policy', ['status', 'enable', 'disable']]);
      const answer = { picked: 'enable' };
      r.ui.opened[0].answer(answer);
      assert.equal(await dialog.done, answer, 'the very value the dialog gave');
      assert.deepEqual(r.held, []);
      assert.deepEqual(r.records, [], 'nothing logged');
    } finally { await r.close(); }
  }
});

test('S7: ask_user_choice holding still works unchanged with the dialogs wrapped', async () => {
  const r = await rig();
  try {
    let result: unknown = 'pending';
    void r.pi.toolCall('ask_user_choice', { question: 'Deploy to production now?', options: [{ label: 'Yes', description: 'Deploy', value: 'v1' }, { label: 'No', description: 'Wait', value: 'v2' }] }, { ui: r.ui.ui, hasUI: true }).then((v) => { result = v; });
    await until(() => r.held.length === 1);
    assert.equal(r.held[0].tool, 'ask_user_choice');
    assert.equal(r.held[0].dialog, undefined);
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[1]], 'telegram'), { ok: true });
    await until(() => result !== 'pending');
    assert.deepEqual(result, { block: true, reason: 'User selected: 2. No' });
    assert.equal(r.ui.opened.length, 0, 'no dialog was opened');
  } finally { await r.close(); }
});

test('S6: a new ctx.ui (a new UI binding) is wrapped at its session_start; wrapping again is a no-op, so each dialog opens once and is offered once', async () => {
  const r = await rig();
  try {
    const first = r.ui.ui.confirm;
    await r.pi.emit('session_start', { type: 'session_start', reason: 'reload' }, { ui: r.ui.ui, hasUI: true });
    await r.pi.toolCall('read', { path: 'x' }, { ui: r.ui.ui, hasUI: true });
    assert.equal(r.ui.ui.confirm, first, 'not wrapped twice');
    // A copy of a wrapped ui (spread) keeps the wrappers and is not wrapped again either.
    const copy = { ...r.ui.ui };
    await r.pi.emit('session_start', { type: 'session_start', reason: 'reload' }, { ui: copy, hasUI: true });
    assert.equal(copy.confirm, first);

    const next = fakeUi();
    const raw = next.ui.confirm;
    await r.pi.emit('session_start', { type: 'session_start', reason: 'reload' }, { ui: next.ui, hasUI: true });
    assert.notEqual(next.ui.confirm, raw, 'the new binding is wrapped');
    const dialog = ask(next.ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    await until(() => r.held.length === 1);
    assert.equal(next.opened.length, 1, 'opened once');
    assert.equal(r.sent.filter((line) => line.type === 'held').length, 1, 'offered once');
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[0]], 'telegram'), { ok: true });
    assert.equal(await dialog.done, true);
  } finally { await r.close(); }
});

test('S6: a ctx.ui that cannot be wrapped is left as it is and the terminal is told once; a print-mode ctx is never touched', async () => {
  const r = await rig();
  try {
    const frozen = fakeUi();
    const notes: string[] = [];
    const raw = { ...frozen.ui, notify: (message: string) => void notes.push(message) };
    const ui = Object.freeze(raw);
    for (let i = 0; i < 3; i++) await r.pi.emit('session_start', { type: 'session_start', reason: 'reload' }, { ui, hasUI: true });
    await r.pi.toolCall('read', { path: 'x' }, { ui, hasUI: true });
    assert.equal(ui.confirm, frozen.ui.confirm, 'unchanged');
    assert.equal(notes.length, 1, 'said once');
    assert.match(notes[0], /Telegram/);
    const dialog = ask(ui, 'confirm', GUARDED_TITLE, GUARDED_PREVIEW);
    frozen.opened[0].answer(true);
    assert.equal(await dialog.done, true);
    assert.equal(frozen.opened[0].opts, undefined, 'the original call, untouched');

    const print = fakeUi();
    const confirm = print.ui.confirm;
    await r.pi.emit('session_start', { type: 'session_start', reason: 'startup' }, { ui: print.ui, hasUI: false });
    assert.equal(print.ui.confirm, confirm);
  } finally { await r.close(); }
});

test('S6: a stale ctx (its ui getter throws) is skipped quietly and does not use up the one notice', async () => {
  const r = await rig();
  try {
    const stale = Object.defineProperty({ hasUI: true }, 'ui', { get() { throw new Error('This extension ctx is stale'); } });
    await r.pi.emit('session_start', { type: 'session_start', reason: 'reload' }, stale);
    await r.pi.toolCall('read', { path: 'x' }, stale);
    const frozen = fakeUi();
    const notes: string[] = [];
    const ui = Object.freeze({ ...frozen.ui, notify: (message: string) => void notes.push(message) });
    await r.pi.emit('session_start', { type: 'session_start', reason: 'reload' }, { ui, hasUI: true });
    assert.equal(notes.length, 1);
  } finally { await r.close(); }
});

test('S3, S6: input pi would not take is never offered: the original gets the call exactly as given', async () => {
  const r = await rig();
  try {
    const opts = { timeout: 5 };
    const odd = ask(r.ui.ui, 'select', 'Pick', 'not a list', opts);
    assert.equal(r.ui.opened[0].opts, opts, 'the caller\'s own options object');
    r.ui.opened[0].answer('kept');
    assert.equal(await odd.done, 'kept');
    const untitled = ask(r.ui.ui, 'confirm', 42, 'git push');
    r.ui.opened[1].answer(true);
    assert.equal(await untitled.done, true);
    await sleep(100);
    assert.deepEqual(r.held, []);
    assert.ok(r.sent.every((line) => line.type !== 'held'));
  } finally { await r.close(); }
});

test('S8: a dialog of up to 16 000 characters is held whole, its command never cut', async () => {
  const r = await rig();
  try {
    const command = `git commit -m "${'x'.repeat(15_000)}" && git push --force`;
    const dialog = ask(r.ui.ui, 'confirm', GUARDED_TITLE, command);
    await until(() => r.held.length === 1);
    assert.deepEqual(r.held[0].dialog, { kind: 'confirm', title: GUARDED_TITLE, message: command });
    assert.deepEqual(r.held[0].items[0].options.map((o) => o.label), ['Yes', 'No']);
    assert.deepEqual(r.service.answerHeld(r.held[0].id, [[1]], 'telegram'), { ok: true });
    assert.equal(await dialog.done, false);
  } finally { await r.close(); }
});

test('S8: a dialog over 16 000 characters, over 20 options or whose line passes 64 KB is held as a notice: no options, title cut to 300, never answerable from Telegram, a forged chosen ignored, its end still told', async () => {
  const r = await rig();
  try {
    const cases = [
      { kind: 'confirm' as const, args: [GUARDED_TITLE, `git push ${'x'.repeat(16_000)}`], title: GUARDED_TITLE, answer: true },
      { kind: 'select' as const, args: ['t'.repeat(400), Array.from({ length: 21 }, (_, i) => `option ${i}`)], title: `${'t'.repeat(299)}…`, answer: 'option 3' },
      // Few characters, but every one escaped in JSON to six bytes: the line would pass 64 KB.
      { kind: 'confirm' as const, args: [GUARDED_TITLE, '\u0001'.repeat(12_000)], title: GUARDED_TITLE, answer: false },
    ];
    for (const [i, c] of cases.entries()) {
      const opts = { timeout: 60_000 };
      const dialog = ask(r.ui.ui, c.kind, ...c.args, opts);
      await until(() => r.held.length === i + 1);
      const held = r.held[i];
      assert.deepEqual(held.dialog, { kind: c.kind, title: c.title, message: '', notice: true }, c.kind);
      assert.deepEqual(held.items[0].options, [], 'no options');
      assert.equal(r.ui.opened[i].opts, opts, 'the terminal dialog gets the caller\'s own options: nothing can close it');
      assert.deepEqual(r.service.answerHeld(held.id, [[0]], 'telegram'), { ok: false, code: 'invalid' });
      const requestId = (r.sent.filter((line) => line.type === 'held').at(-1) as { requestId: string }).requestId;
      r.channel.send(r.terminalId, { type: 'chosen', requestId, index: 0 });
      await sleep(80);
      assert.equal(dialog.result, 'pending', 'a forged chosen is ignored');
      assert.equal(r.ui.opened[i].aborted, false);
      r.ui.opened[i].answer(c.answer);
      assert.equal(await dialog.done, c.answer, 'the terminal\'s own answer');
      await until(() => r.ended.length === i + 1);
      assert.deepEqual(r.ended[i], [held.id, 'terminal'], 'its end is told, so the notice is edited');
    }
    assert.deepEqual(r.records, [], 'nothing logged');
  } finally { await r.close(); }
});
