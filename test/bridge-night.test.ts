// The bridge's night half: inside the agent, it forwards ask_user_choice / ask_user_question
// tool calls to Mirador's night socket and blocks the call only on a `decided` answer; on
// anything else the dialog opens as usual. Fake pi, real Unix socket with a scripted Mirador.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bridge-night-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

type Handler = (...args: unknown[]) => unknown;

function fakePi(options: { sendUserMessage?: (text: unknown, opts: unknown) => unknown } = {}) {
  const hooks = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const messages: Array<[unknown, unknown]> = [];
  const add = (map: Map<string, Handler[]>) => (name: string, handler: Handler) => {
    map.set(name, [...(map.get(name) ?? []), handler]);
    return () => {};
  };
  return {
    api: {
      on: add(hooks),
      events: { on: add(bus) },
      sendUserMessage: options.sendUserMessage ?? ((text: unknown, opts: unknown) => void messages.push([text, opts])),
    },
    /** Calls the tool_call handlers the way pi does: awaited, first block wins. */
    async toolCall(toolName: string, input: unknown, ctx: unknown = {}) {
      for (const handler of hooks.get('tool_call') ?? []) {
        const result = await handler({ type: 'tool_call', toolName, toolCallId: 'call-1', input }, ctx);
        if (result) return result;
      }
      return undefined;
    },
    emit: (name: string, payload: unknown) => bus.get(name)?.forEach((h) => h(payload)),
    messages,
    hooks,
  };
}

/** A scripted Mirador on a real Unix socket: records lines, answers with `reply`. */
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

const HERDR_ENV = { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/run/mirador/herdr/socket', HERDR_BIN_PATH: '/run/mirador/herdr/herdr' };
let counter = 0;
const socketPath = () => join(scratch, `night-${++counter}.sock`);
const nightEnv = (path: string, extra: Record<string, string> = {}) => ({ ...HERDR_ENV, MIRADOR_NIGHT_SOCKET: path, MIRADOR_NIGHT_TOKEN: 'secret-token', ...extra });

const CHOICE = {
  question: 'Which layout should the report use?',
  options: [{ label: 'Grid', description: 'Cards in a grid', value: 'opaque-1' }, { label: 'List', description: 'One per line', value: 'opaque-2' }],
};

function bridge(env: Record<string, string>, pi = fakePi(), night: Record<string, number> = {}) {
  const calls: string[][] = [];
  createAttentionBridge({ env, seq: 1000, exec: (_file, args, done) => { calls.push(args); done(); }, night: { questionTimeoutMs: 2000, retryMinMs: 20, retryMaxMs: 50, ...night } })(pi.api);
  return { pi, calls };
}

test('the bridge connects to the night socket and says hello with its terminal and token first', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    bridge(nightEnv(path));
    await until(() => mirador.lines.length === 1);
    assert.deepEqual(mirador.lines[0], { type: 'hello', terminalId: 'pane-1', token: 'secret-token' });
  } finally {
    await mirador.close();
  }
});

test('a decided ask_user_choice is blocked with Mirador\'s reason; the question carries labels, never the opaque values', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, (line, conn) => {
    if (line.type === 'question') conn.write(JSON.stringify({ type: 'decided', requestId: line.requestId, reason: 'The user is asleep. Chosen option: "List".' }) + '\n');
  });
  try {
    const { pi } = bridge(nightEnv(path));
    const result = await pi.toolCall('ask_user_choice', { ...CHOICE, allowCustomResponse: true });
    assert.deepEqual(result, { block: true, reason: 'The user is asleep. Chosen option: "List".' });
    const question = mirador.lines.find((l) => l.type === 'question')!;
    assert.match(String(question.requestId), /^[\w-]{1,128}$/);
    assert.deepEqual(question.question, {
      terminalId: 'pane-1', toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: true,
      items: [{ question: CHOICE.question, header: '', multiSelect: false, options: [{ label: 'Grid', description: 'Cards in a grid' }, { label: 'List', description: 'One per line' }] }],
    });
    assert.ok(!JSON.stringify(mirador.lines).includes('opaque-'), 'option values stay in the agent');
  } finally {
    await mirador.close();
  }
});

test('an ask_user_question questionnaire is forwarded item by item, previews folded into the description', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, (line, conn) => {
    if (line.type === 'question') conn.write(JSON.stringify({ type: 'pass', requestId: line.requestId }) + '\n');
  });
  try {
    const { pi } = bridge(nightEnv(path));
    const input = { questions: [
      { question: 'Name the helper?', header: 'Naming', options: [{ label: 'parseLine', description: 'short', preview: 'function parseLine() {}' }, { label: 'readLine', description: 'clear' }] },
      { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }] },
    ] };
    assert.equal(await pi.toolCall('ask_user_question', input), undefined, 'pass opens the dialog');
    const { question } = mirador.lines.find((l) => l.type === 'question') as { question: { items: unknown[]; tool: string; allowCustomResponse: boolean } };
    assert.equal(question.tool, 'ask_user_question');
    assert.equal(question.allowCustomResponse, false);
    assert.deepEqual(question.items, [
      { question: 'Name the helper?', header: 'Naming', multiSelect: false, options: [{ label: 'parseLine', description: 'short\n\nPreview:\nfunction parseLine() {}' }, { label: 'readLine', description: 'clear' }] },
      { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }] },
    ]);
  } finally {
    await mirador.close();
  }
});

test('pass, a timeout, a dropped connection, an odd answer or an aborted call all let the dialog open', async () => {
  const path = socketPath();
  let mode = 'silent';
  const mirador = await fakeMirador(path, (line, conn) => {
    if (line.type !== 'question') return;
    if (mode === 'close') conn.destroy();
    if (mode === 'odd') {
      conn.write(JSON.stringify({ type: 'decided', requestId: 'someone-else', reason: 'x' }) + '\n');
      conn.write(JSON.stringify({ type: 'decided', requestId: line.requestId, reason: '' }) + '\n');
      conn.write(JSON.stringify({ type: 'decided', requestId: line.requestId, reason: 42 }) + '\n');
      conn.write('not json\n');
    }
  });
  try {
    const { pi } = bridge(nightEnv(path), fakePi(), { questionTimeoutMs: 150 });
    let started = Date.now();
    assert.equal(await pi.toolCall('ask_user_choice', CHOICE), undefined, 'timeout');
    assert.ok(Date.now() - started >= 140, 'it waited for Mirador');

    mode = 'odd';
    assert.equal(await pi.toolCall('ask_user_choice', CHOICE), undefined, 'odd answers are not decisions');

    mode = 'silent';
    const controller = new AbortController();
    started = Date.now();
    const pending = pi.toolCall('ask_user_choice', CHOICE, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    assert.equal(await pending, undefined, 'aborted');
    assert.ok(Date.now() - started < 140, 'an abort does not wait for the timeout');
    // A late answer to the aborted question is dropped without trouble.
    const asked = mirador.lines.filter((l) => l.type === 'question').at(-1)!;
    mirador.send({ type: 'decided', requestId: asked.requestId, reason: 'too late' });

    mode = 'close';
    started = Date.now();
    assert.equal(await pi.toolCall('ask_user_choice', CHOICE), undefined, 'connection dropped');
    assert.ok(Date.now() - started < 140, 'a dropped connection does not wait for the timeout');
  } finally {
    await mirador.close();
  }
});

test('with no Mirador listening, a question opens the dialog at once', async () => {
  const { pi } = bridge(nightEnv(join(scratch, 'nobody.sock')));
  const started = Date.now();
  assert.equal(await pi.toolCall('ask_user_choice', CHOICE), undefined);
  assert.ok(Date.now() - started < 1000);
});

test('other tools, and question tools with input it cannot forward whole, are never blocked or sent', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path, (line, conn) => {
    if (line.type === 'question') conn.write(JSON.stringify({ type: 'decided', requestId: line.requestId, reason: 'decided' }) + '\n');
  });
  try {
    const { pi } = bridge(nightEnv(path));
    await until(() => mirador.lines.length === 1);
    for (const tool of ['bash', 'read', 'edit', 'write', 'gentle_review', 'subagent_run']) {
      assert.equal(await pi.toolCall(tool, { command: 'rm -rf /', question: 'x', options: CHOICE.options }), undefined, tool);
    }
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    const inputs: unknown[] = [
      null, 'text', [], {}, hostile,
      { question: 42, options: CHOICE.options },
      { question: 'Q?', options: 'Grid' },
      { question: 'Q?', options: [{ label: 'A' }, { label: 'B', description: 'b' }] },
      { question: 'x'.repeat(5000), options: CHOICE.options },
      { question: 'Q?', options: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, description: '' })) },
    ];
    for (const input of inputs) assert.equal(await pi.toolCall('ask_user_choice', input), undefined);
    assert.equal(await pi.toolCall('ask_user_question', { questions: Array.from({ length: 9 }, () => ({ question: 'Q?', header: 'H', options: CHOICE.options })) }), undefined);
    assert.equal(await pi.toolCall('ask_user_question', { questions: 'nope' }), undefined);
    assert.equal(mirador.lines.filter((l) => l.type === 'question').length, 0, 'nothing was sent');
  } finally {
    await mirador.close();
  }
});

test('a message line is delivered as a follow-up user message and confirmed; bad ones are ignored', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const { pi } = bridge(nightEnv(path));
    await until(() => mirador.lines.length === 1);
    mirador.send({ type: 'message', messageId: 'bad id', text: 'x' });
    mirador.send({ type: 'message', messageId: 'm0', text: '' });
    mirador.send({ type: 'message', messageId: 'm0', text: 'y'.repeat(20 * 1024) });
    mirador.send({ type: 'message', messageId: 'm0', text: 42 });
    mirador.send({ type: 'message', messageId: 'm1', text: 'Run the tests and fix what fails.' });
    await until(() => mirador.lines.length === 2);
    assert.deepEqual(pi.messages, [['Run the tests and fix what fails.', { deliverAs: 'followUp', expandPromptTemplates: false }]]);
    assert.deepEqual(mirador.lines[1], { type: 'delivered', messageId: 'm1' });
  } finally {
    await mirador.close();
  }
});

test('a sendUserMessage that throws is not confirmed and never throws into the agent', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    let calls = 0;
    bridge(nightEnv(path), fakePi({ sendUserMessage: () => { calls++; throw new Error('busy'); } }));
    await until(() => mirador.lines.length === 1);
    mirador.send({ type: 'message', messageId: 'm1', text: 'Go on.' });
    await until(() => calls === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mirador.lines.length, 1, 'no delivered line');
  } finally {
    await mirador.close();
  }
});

test('the bridge reconnects with backoff and says hello again', async () => {
  const path = socketPath();
  let mirador = await fakeMirador(path);
  bridge(nightEnv(path));
  await until(() => mirador.lines.length === 1);
  await mirador.close();
  mirador = await fakeMirador(path);
  try {
    await until(() => mirador.lines.length === 1);
    assert.equal(mirador.lines[0].type, 'hello');
  } finally {
    await mirador.close();
  }
});

test('attention reports work exactly as before with the night variables set', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const { pi, calls } = bridge(nightEnv(path));
    pi.emit('herdr:blocked', { active: true, label: 'Guarded command confirmation' });
    assert.deepEqual(calls[0], ['pane', 'report-metadata', 'pane-1', '--source', 'mirador:attention', '--agent', 'pi', '--seq', '1001',
      '--token', 'blocked=Guarded command confirmation', '--clear-token', 'prompt', '--clear-token', 'finished']);
    // The night half never touches the herdr CLI arguments or the environment it passes on.
    assert.ok(!calls.flat().some((arg) => arg.includes('secret-token')));
  } finally {
    await mirador.close();
  }
});

test('without the night variables, in a subagent child or outside Mirador, the night half does nothing', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const cases: Record<string, Record<string, string>> = {
      'no night variables': HERDR_ENV,
      'no token': nightEnv(path, { MIRADOR_NIGHT_TOKEN: '' }),
      'subagent child': nightEnv(path, { GENTLE_PI_AGENTS_CHILD: '1' }),
      'not a Mirador terminal': nightEnv(path, { TERM_PROGRAM: 'xterm' }),
      'no pane id': nightEnv(path, { HERDR_PANE_ID: '' }),
    };
    for (const [name, env] of Object.entries(cases)) {
      const { pi } = bridge(env);
      assert.equal(pi.hooks.has('tool_call'), false, name);
      assert.equal(await pi.toolCall('ask_user_choice', CHOICE), undefined, name);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(mirador.lines, [], 'nobody connected');
  } finally {
    await mirador.close();
  }
});

/* ---------- The final assistant message of each turn ---------- */

const assistant = (content: unknown) => ({ role: 'assistant', content, api: 'x', provider: 'x', model: 'm', usage: {}, stopReason: 'stop', timestamp: 0 });

test('agent_end sends the last assistant message\'s text parts as a finished line with the turn id of the attention token', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const { pi, calls } = bridge(nightEnv(path));
    await until(() => mirador.lines.length === 1);
    const messages = [
      { role: 'user', content: 'Do N4', timestamp: 0 },
      assistant([{ type: 'text', text: 'Earlier answer.' }]),
      { role: 'toolResult', toolCallId: 't', toolName: 'bash', content: [{ type: 'text', text: 'tool output' }], isError: false, timestamp: 0 },
      assistant([
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'N4 is done; tests pass.' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: '¿Avanzamos con A (recomendado) o B?' },
      ]),
      { role: 'user', content: 'queued', timestamp: 0 },
    ];
    await pi.hooks.get('agent_end')![0]({ type: 'agent_end', messages }, {});
    await until(() => mirador.lines.length === 2);
    assert.deepEqual(mirador.lines[1], { type: 'finished', turnId: '1000-1', text: 'N4 is done; tests pass.\n¿Avanzamos con A (recomendado) o B?' });
    // The attention token of the same turn, reported when the run settles, carries the same id.
    for (const handler of pi.hooks.get('agent_settled') ?? []) handler({ type: 'agent_settled', aborted: false }, {});
    assert.ok(calls.at(-1)!.includes('finished=1000-1'));
    await pi.hooks.get('agent_end')![0]({ type: 'agent_end', messages: [assistant([{ type: 'text', text: 'Second turn.' }])] }, {});
    await until(() => mirador.lines.length === 3);
    assert.deepEqual(mirador.lines[2], { type: 'finished', turnId: '1000-2', text: 'Second turn.' });
  } finally {
    await mirador.close();
  }
});

test('the final text is capped at 32 KiB keeping its end, on a character boundary, and odd payloads send an empty text', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const { pi } = bridge(nightEnv(path));
    await until(() => mirador.lines.length === 1);
    const end = pi.hooks.get('agent_end')![0];
    const long = `${'ñ'.repeat(40 * 1024)}THE QUESTION?`;
    await end({ type: 'agent_end', messages: [assistant([{ type: 'text', text: long }])] }, {});
    await until(() => mirador.lines.length === 2);
    const text = String(mirador.lines[1].text);
    assert.ok(Buffer.byteLength(text) <= 32 * 1024, `${Buffer.byteLength(text)} bytes`);
    assert.ok(text.endsWith('ñTHE QUESTION?'), 'the end is kept');
    assert.ok(!text.includes('\ufffd'), 'no character is cut in half');

    const newlines = '\u0001'.repeat(32 * 1024);
    await end({ type: 'agent_end', messages: [assistant([{ type: 'text', text: newlines }])] }, {});
    await until(() => mirador.lines.length === 3);
    assert.ok(Buffer.byteLength(JSON.stringify(mirador.lines[2])) < 64 * 1024, 'the line stays under the socket limit');

    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    for (const payload of [null, {}, { messages: 'x' }, { messages: [hostile] }, { messages: [assistant('plain string')] }, { messages: [{ role: 'user', content: 'hi' }] }]) {
      assert.doesNotThrow(() => end(payload, {}));
    }
    await until(() => mirador.lines.length === 9);
    assert.deepEqual(mirador.lines.slice(3).map((l) => l.text), ['', '', '', '', 'plain string', '']);
  } finally {
    await mirador.close();
  }
});

test('with no connection to Mirador, agent_end sends nothing, never waits and never throws', async () => {
  const { pi } = bridge(nightEnv(join(scratch, 'nobody-final.sock')));
  const started = Date.now();
  const result = pi.hooks.get('agent_end')![0]({ type: 'agent_end', messages: [assistant([{ type: 'text', text: 'Done.' }])] }, {});
  assert.equal(result instanceof Promise, false, 'fire and forget');
  assert.ok(Date.now() - started < 50);

  // A Mirador that appears later never receives the old turn.
  const path = socketPath();
  const late = bridge(nightEnv(path));
  late.pi.hooks.get('agent_end')![0]({ type: 'agent_end', messages: [assistant([{ type: 'text', text: 'Too early.' }])] }, {});
  const mirador = await fakeMirador(path);
  try {
    await until(() => mirador.lines.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(mirador.lines.map((l) => l.type), ['hello']);
  } finally {
    await mirador.close();
  }
});

/** pi's handler context, whose session manager knows the current session file. */
const sessionCtx = (file: unknown) => ({ sessionManager: { getSessionFile: () => file } });
/** Runs every handler of a pi event the way pi does. */
const fire = async (pi: ReturnType<typeof fakePi>, name: string, event: unknown, ctx: unknown) => {
  for (const handler of pi.hooks.get(name) ?? []) await handler(event, ctx);
};

test('the bridge reports its pi session file once connected, on every session_start and at every turn end', async () => {
  const path = socketPath();
  const { pi } = bridge(nightEnv(path));
  // Not connected yet: the file is remembered and sent right after hello.
  await fire(pi, 'session_start', { type: 'session_start', reason: 'startup' }, sessionCtx('/home/u/.pi/sessions/a.jsonl'));
  let mirador = await fakeMirador(path);
  try {
    await until(() => mirador.lines.length === 2);
    assert.deepEqual(mirador.lines, [
      { type: 'hello', terminalId: 'pane-1', token: 'secret-token' },
      { type: 'session', file: '/home/u/.pi/sessions/a.jsonl' },
    ]);
    await fire(pi, 'session_start', { type: 'session_start', reason: 'new', previousSessionFile: '/home/u/.pi/sessions/a.jsonl' }, sessionCtx('/home/u/.pi/sessions/b.jsonl'));
    await until(() => mirador.lines.length === 3);
    assert.deepEqual(mirador.lines[2], { type: 'session', file: '/home/u/.pi/sessions/b.jsonl' });
    await fire(pi, 'agent_end', { type: 'agent_end', messages: [assistant([{ type: 'text', text: 'Done.' }])] }, sessionCtx('/home/u/.pi/sessions/b.jsonl'));
    await until(() => mirador.lines.length === 5);
    assert.deepEqual(mirador.lines.slice(3).map((l) => l.type), ['finished', 'session']);
    assert.equal(mirador.lines[4].file, '/home/u/.pi/sessions/b.jsonl');

    // A reconnect says hello and reports the latest file again.
    await mirador.close();
    mirador = await fakeMirador(path);
    await until(() => mirador.lines.length === 2);
    assert.deepEqual(mirador.lines, [
      { type: 'hello', terminalId: 'pane-1', token: 'secret-token' },
      { type: 'session', file: '/home/u/.pi/sessions/b.jsonl' },
    ]);
  } finally {
    await mirador.close();
  }
});

test('without a session file, or with a context that throws, nothing is reported and nothing throws', async () => {
  const path = socketPath();
  const mirador = await fakeMirador(path);
  try {
    const { pi } = bridge(nightEnv(path));
    await until(() => mirador.lines.length === 1);
    const throwing = { get sessionManager() { throw new Error('stale ctx'); } };
    for (const ctx of [{}, undefined, sessionCtx(undefined), sessionCtx(''), sessionCtx(42), sessionCtx(`/${'a'.repeat(5000)}.jsonl`), { sessionManager: { getSessionFile: () => { throw new Error('boom'); } } }, throwing]) {
      await fire(pi, 'session_start', { type: 'session_start', reason: 'startup' }, ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(mirador.lines.map((l) => l.type), ['hello']);
  } finally {
    await mirador.close();
  }
});
