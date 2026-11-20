// The bridge's held questions: on Mirador's `held`
// line the bridge keeps the question waiting with no timeout, for an answer from Telegram,
// shows a status line, and gives it back to the dialog on its escape key or an abort,
// telling Mirador with a `released` line. Fake pi, real Unix socket with a scripted Mirador.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bridge-held-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

type Handler = (...args: unknown[]) => unknown;
type InputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

function fakePi() {
  const hooks = new Map<string, Handler[]>();
  return {
    api: {
      on: (name: string, handler: Handler) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        return () => {};
      },
      events: { on: () => () => {} },
      sendUserMessage: () => {},
    },
    /** Calls the tool_call handlers the way pi does: awaited, first block wins. */
    async toolCall(toolName: string, input: unknown, ctx: unknown = {}) {
      for (const handler of hooks.get('tool_call') ?? []) {
        const result = await handler({ type: 'tool_call', toolName, toolCallId: 'call-1', input }, ctx);
        if (result) return result;
      }
      return undefined;
    },
  };
}

/** pi's ctx.ui as the bridge uses it: footer statuses and raw terminal input listeners. */
function fakeUi() {
  const statuses: Array<[string, string | undefined]> = [];
  const inputs = new Set<InputHandler>();
  return {
    statuses,
    inputs,
    ui: {
      setStatus: (key: string, text: string | undefined) => void statuses.push([key, text]),
      onTerminalInput: (handler: InputHandler) => {
        inputs.add(handler);
        return () => void inputs.delete(handler);
      },
    },
    /** Types `data` the way pi's TUI does: listeners first, the first that consumes wins. */
    type(data: string): boolean {
      for (const handler of [...inputs]) if (handler(data)?.consume) return true;
      return false;
    },
  };
}

async function fakeMirador(path: string, reply: (line: Record<string, unknown>, conn: Socket) => void = () => {}) {
  const lines: Array<Record<string, unknown>> = [];
  const conns: Socket[] = [];
  const server: Server = createServer((conn) => {
    conns.push(conn);
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        lines.push(line);
        reply(line, conn);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    lines,
    conns,
    send: (value: unknown) => conns.at(-1)!.write(JSON.stringify(value) + '\n'),
    close: () => new Promise<void>((resolve) => { conns.forEach((c) => c.destroy()); server.close(() => resolve()); }),
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;
const socketPath = () => join(scratch, `held-${++counter}.sock`);
const env = (path: string) => ({ TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', MIRADOR_NIGHT_SOCKET: path, MIRADOR_NIGHT_TOKEN: 'secret-token' });
const CHOICE = { question: 'Deploy to production now?', options: [{ label: 'Yes', description: 'Deploy', value: 'v1' }, { label: 'No', description: 'Wait', value: 'v2' }] };

function bridge(path: string, questionTimeoutMs = 150) {
  const pi = fakePi();
  createAttentionBridge({ env: env(path), seq: 1000, night: { questionTimeoutMs, retryMinMs: 20, retryMaxMs: 50 } })(pi.api);
  return pi;
}

/** A Mirador that holds every question. */
const holding = (line: Record<string, unknown>, conn: Socket) => {
  if (line.type === 'question') conn.write(JSON.stringify({ type: 'held', requestId: line.requestId }) + '\n');
};
const questionOf = (mirador: { lines: Array<Record<string, unknown>> }) => mirador.lines.find((line) => line.type === 'question')!;
const releasedLines = (mirador: { lines: Array<Record<string, unknown>> }) => mirador.lines.filter((line) => line.type === 'released');

test('a held question waits past the question timeout, says so in a status line, and ends with Mirador\'s decision', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, holding);
  try {
    const pi = bridge(path, 100);
    const ui = fakeUi();
    let result: unknown = 'pending';
    void pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true }).then((value) => { result = value; });
    await until(() => ui.statuses.length === 1);
    const [key, text] = ui.statuses[0];
    assert.equal(key, 'mirador');
    assert.match(String(text), /Telegram/);
    assert.match(String(text), /Esc/);
    await sleep(250);
    assert.equal(result, 'pending', 'no timeout while held');
    mirador.send({ type: 'decided', requestId: questionOf(mirador).requestId, reason: 'User selected: 2. No' });
    await until(() => result !== 'pending');
    assert.deepEqual(result, { block: true, reason: 'User selected: 2. No' });
    assert.deepEqual(ui.statuses.at(-1), ['mirador', undefined], 'the status line is cleared');
    assert.equal(ui.inputs.size, 0, 'the escape key is given back');
    assert.deepEqual(releasedLines(mirador), []);
  } finally {
    await mirador.close();
  }
});

test('Esc while held gives the question back to its dialog and tells Mirador; other keys, and Esc when not held, pass through', async () => {
  const path = socketPath();
  let hold = false;
  const mirador = await fakeMirador(path, (line, conn) => { if (hold) holding(line, conn); });
  try {
    const pi = bridge(path, 2000);
    const ui = fakeUi();
    let result: unknown = 'pending';
    void pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true }).then((value) => { result = value; });
    await until(() => !!mirador.lines.find((line) => line.type === 'question'));
    assert.equal(ui.type('\x1b'), false, 'not held yet: Esc is pi\'s');
    mirador.send({ type: 'held', requestId: questionOf(mirador).requestId });
    await until(() => ui.inputs.size === 1);
    assert.equal(ui.type('a'), false);
    assert.equal(ui.type('\x1b[A'), false, 'an arrow key is not Esc');
    assert.equal(result, 'pending');
    assert.equal(ui.type('\x1b'), true, 'Esc is taken while held');
    await until(() => result !== 'pending');
    assert.equal(result, undefined, 'the dialog opens');
    await until(() => releasedLines(mirador).length === 1);
    assert.deepEqual(releasedLines(mirador), [{ type: 'released', requestId: questionOf(mirador).requestId }]);
    assert.deepEqual(ui.statuses.at(-1), ['mirador', undefined]);
    assert.equal(ui.type('\x1b'), false, 'after the release Esc is pi\'s again');

    // The kitty keyboard protocol's Esc counts too.
    hold = true;
    const second = fakeUi();
    let again: unknown = 'pending';
    void pi.toolCall('ask_user_choice', CHOICE, { ui: second.ui, hasUI: true }).then((value) => { again = value; });
    await until(() => second.inputs.size === 1);
    assert.equal(second.type('\x1b[27u'), true);
    await until(() => again !== 'pending');
    assert.equal(again, undefined);
    await until(() => releasedLines(mirador).length === 2);
  } finally {
    await mirador.close();
  }
});

test('an abort while held stops waiting at once, opens nothing and tells Mirador the question was released', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, holding);
  try {
    const pi = bridge(path, 2000);
    const ui = fakeUi();
    const controller = new AbortController();
    const pending = pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true, signal: controller.signal });
    await until(() => ui.inputs.size === 1);
    const started = Date.now();
    controller.abort();
    assert.equal(await pending, undefined);
    assert.ok(Date.now() - started < 500, 'an abort does not wait');
    await until(() => releasedLines(mirador).length === 1);
    assert.equal(releasedLines(mirador)[0].requestId, questionOf(mirador).requestId);
    assert.deepEqual(ui.statuses.at(-1), ['mirador', undefined]);
    assert.equal(ui.inputs.size, 0);
  } finally {
    await mirador.close();
  }
});

test('a held line for a question the bridge no longer waits for (it timed out first) is answered released', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const pi = bridge(path, 60);
    const ui = fakeUi();
    assert.equal(await pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true }), undefined, 'timed out: the dialog opened');
    const { requestId } = questionOf(mirador);
    mirador.send({ type: 'held', requestId });
    await until(() => releasedLines(mirador).length === 1);
    assert.deepEqual(releasedLines(mirador), [{ type: 'released', requestId }]);
    assert.deepEqual(ui.statuses, [], 'nothing was shown');
    assert.equal(ui.inputs.size, 0);
  } finally {
    await mirador.close();
  }
});

test('a pass after held opens the dialog without a release; a lost connection opens it and is released after the next hello', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, holding);
  try {
    const pi = bridge(path, 2000);
    const ui = fakeUi();
    let result: unknown = 'pending';
    void pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true }).then((value) => { result = value; });
    await until(() => ui.inputs.size === 1);
    mirador.send({ type: 'pass', requestId: questionOf(mirador).requestId });
    await until(() => result !== 'pending');
    assert.equal(result, undefined);
    assert.deepEqual(ui.statuses.at(-1), ['mirador', undefined]);
    assert.equal(ui.inputs.size, 0);

    let lost: unknown = 'pending';
    void pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true }).then((value) => { lost = value; });
    await until(() => ui.inputs.size === 1);
    const { requestId } = mirador.lines.filter((line) => line.type === 'question').at(-1)!;
    const hellos = mirador.lines.filter((line) => line.type === 'hello').length;
    mirador.conns.at(-1)!.destroy();
    await until(() => lost !== 'pending');
    assert.equal(lost, undefined, 'the dialog opens');
    assert.equal(ui.inputs.size, 0);
    await until(() => mirador.lines.filter((line) => line.type === 'hello').length === hellos + 1);
    await until(() => releasedLines(mirador).length === 1);
    assert.deepEqual(releasedLines(mirador), [{ type: 'released', requestId }], 'every pass and decided went to a waiting question: only the cut one is released');
  } finally {
    await mirador.close();
  }
});

test('without held, the question timeout still opens the dialog and nothing is shown or taken', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const pi = bridge(path, 100);
    const ui = fakeUi();
    const started = Date.now();
    assert.equal(await pi.toolCall('ask_user_choice', CHOICE, { ui: ui.ui, hasUI: true }), undefined);
    assert.ok(Date.now() - started >= 90, 'it waited the question timeout');
    assert.deepEqual(ui.statuses, []);
    assert.equal(ui.inputs.size, 0);
    assert.deepEqual(releasedLines(mirador), []);
  } finally {
    await mirador.close();
  }
});

test('without a UI, or with one that throws, a held question still waits and takes its decision', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, holding);
  try {
    const pi = bridge(path, 100);
    const broken = { setStatus: () => { throw new Error('stale'); }, onTerminalInput: () => { throw new Error('stale'); } };
    for (const ctx of [{}, { ui: broken, hasUI: true }]) {
      let result: unknown = 'pending';
      const before = mirador.lines.filter((line) => line.type === 'question').length;
      void pi.toolCall('ask_user_choice', CHOICE, ctx).then((value) => { result = value; });
      await until(() => mirador.lines.filter((line) => line.type === 'question').length === before + 1);
      await sleep(200);
      assert.equal(result, 'pending', 'held, no timeout');
      mirador.send({ type: 'decided', requestId: mirador.lines.filter((line) => line.type === 'question').at(-1)!.requestId, reason: 'User selected: 1. Yes' });
      await until(() => result !== 'pending');
      assert.deepEqual(result, { block: true, reason: 'User selected: 1. Yes' });
    }
  } finally {
    await mirador.close();
  }
});
