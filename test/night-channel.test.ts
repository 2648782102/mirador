// The night socket: the only inbound path from agent bridges into Mirador's night shift.
// Every connection authenticates with its terminal's token, every line is bounded, and
// anything unexpected is dropped or answered with `pass` (the dialog opens).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightChannel, nightEnvProvider, nightSocketPath } from '../src/night/channel.ts';
import type { NightQuestion } from '../src/night/protocol.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-channel-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

const QUESTION: NightQuestion = {
  terminalId: 't1', toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: false,
  items: [{ question: 'Which layout?', header: '', multiSelect: false, options: [{ label: 'Grid', description: 'a grid' }, { label: 'List', description: 'a list' }] }],
};

interface Events { questions: Array<[string, string, NightQuestion]>; delivered: Array<[string, string]>; disconnected: string[] }

let counter = 0;
async function openChannel(options: { helloTimeoutMs?: number } = {}) {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const events: Events = { questions: [], delivered: [], disconnected: [] };
  const channel = await NightChannel.open(path, {
    question: (id, requestId, question) => events.questions.push([id, requestId, question]),
    delivered: (id, messageId) => events.delivered.push([id, messageId]),
    disconnected: (id) => events.disconnected.push(id),
  }, options);
  return { path, channel, events };
}

/** A raw client: what it receives, and whether the server closed it. */
async function connect(path: string) {
  const socket: Socket = createConnection(path);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const lines: unknown[] = [];
  let buffer = '';
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { closed = true; });
  return {
    socket,
    lines,
    send: (value: unknown) => socket.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n'),
    closed: () => closed,
  };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the socket lives in <runtime>/night, folder 0700 and socket 0600, and a second Mirador cannot take it', async () => {
  assert.equal(nightSocketPath('/run/user/1000/mirador'), '/run/user/1000/mirador/night/socket');
  const { path, channel } = await openChannel();
  try {
    assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
    const socket = await stat(path);
    assert.ok(socket.isSocket());
    assert.equal(socket.mode & 0o777, 0o600);
    await assert.rejects(NightChannel.open(path, { question() {}, delivered() {}, disconnected() {} }), /in use/);
  } finally {
    await channel.close();
  }
});

test('agent terminals get the socket and a fresh token each; shells get nothing', () => {
  const issued: string[] = [];
  const provider = nightEnvProvider({ issueToken: (id) => { issued.push(id); return `token-${id}`; } }, '/run/night/socket');
  const info = (id: string, kind: 'agent' | 'shell'): TerminalInfo => ({ id, kind, workspaceId: 'dev', rel: '', cwd: '/', title: 'x', status: 'running', createdAt: '' });
  assert.deepEqual(provider(info('a1', 'agent')), { MIRADOR_NIGHT_SOCKET: '/run/night/socket', MIRADOR_NIGHT_TOKEN: 'token-a1' });
  assert.deepEqual(provider(info('s1', 'shell')), {});
  assert.deepEqual(issued, ['a1']);
});

test('a connection whose hello has a wrong token, an unknown terminal, or another first line is closed', async () => {
  const { path, channel } = await openChannel();
  try {
    const token = channel.issueToken('t1');
    channel.issueToken('t2');
    const firstLines: unknown[] = [
      { type: 'hello', terminalId: 't1', token: 'wrong' },
      { type: 'hello', terminalId: 't1', token: token.slice(0, -1) },
      { type: 'hello', terminalId: 't2', token },
      { type: 'hello', terminalId: 'nobody', token },
      { type: 'question', requestId: 'r1', question: QUESTION },
      'not json',
    ];
    for (const first of firstLines) {
      const client = await connect(path);
      client.send(first);
      await until(client.closed);
      assert.deepEqual(client.lines, [], JSON.stringify(first));
    }
    assert.deepEqual(channel.connectedTerminals(), []);
  } finally {
    await channel.close();
  }
});

test('a connection that never says hello is closed after the hello timeout', async () => {
  const { path, channel } = await openChannel({ helloTimeoutMs: 100 });
  try {
    const client = await connect(path);
    await until(client.closed, 1000);
  } finally {
    await channel.close();
  }
});

test('after hello, questions and deliveries reach Mirador and lines go back to that terminal', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    assert.deepEqual(channel.connectedTerminals(), ['t1']);
    client.send({ type: 'question', requestId: 'r1', question: QUESTION });
    client.send({ type: 'delivered', messageId: 'm1' });
    await until(() => events.questions.length === 1 && events.delivered.length === 1);
    assert.deepEqual(events.questions[0], ['t1', 'r1', QUESTION]);
    assert.deepEqual(events.delivered[0], ['t1', 'm1']);

    assert.equal(channel.send('t1', { type: 'decided', requestId: 'r1', reason: 'Chose Grid' }), true);
    assert.equal(channel.send('t2', { type: 'pass', requestId: 'r9' }), false, 'no bridge for t2');
    await until(() => client.lines.length === 1);
    assert.deepEqual(client.lines, [{ type: 'decided', requestId: 'r1', reason: 'Chose Grid' }]);
    client.socket.destroy();
    await until(() => events.disconnected.includes('t1'));
    assert.equal(channel.isConnected('t1'), false);
  } finally {
    await channel.close();
  }
});

test('a released line tells Mirador which held question its bridge gave back to the dialog; malformed ones are dropped', async () => {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const released: Array<[string, string]> = [];
  const delivered: string[] = [];
  const channel = await NightChannel.open(path, {
    question: () => {},
    delivered: (_id, messageId) => void delivered.push(messageId),
    disconnected: () => {},
    released: (id, requestId) => void released.push([id, requestId]),
  });
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    client.send({ type: 'released', requestId: 'bad id with spaces' });
    client.send({ type: 'released', requestId: 42 });
    client.send({ type: 'released', requestId: 'r1' });
    client.send({ type: 'delivered', messageId: 'm1' });
    await until(() => delivered.length === 1);
    assert.deepEqual(released, [['t1', 'r1']]);
    assert.equal(client.closed(), false);
  } finally {
    await channel.close();
  }
});

test('follow-ups S3: a took line tells Mirador which held dialog its bridge closed with the answer from Telegram; malformed ones are dropped', async () => {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const took: Array<[string, string]> = [];
  const released: Array<[string, string]> = [];
  const delivered: string[] = [];
  const channel = await NightChannel.open(path, {
    question: () => {},
    delivered: (_id, messageId) => void delivered.push(messageId),
    disconnected: () => {},
    released: (id, requestId) => void released.push([id, requestId]),
    took: (id, requestId) => void took.push([id, requestId]),
  });
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    client.send({ type: 'took', requestId: 'bad id with spaces' });
    client.send({ type: 'took', requestId: 42 });
    client.send({ type: 'took' });
    client.send({ type: 'took', requestId: 'x'.repeat(129) });
    client.send({ type: 'took', requestId: 'r1' });
    client.send({ type: 'delivered', messageId: 'm1' });
    await until(() => delivered.length === 1);
    assert.deepEqual(took, [['t1', 'r1']]);
    assert.deepEqual(released, [], 'a took is not a release');
    assert.equal(client.closed(), false);
  } finally {
    await channel.close();
  }
});

test('a dialog line reaches Mirador only exactly as pi shows it and within the limits; anything else is answered pass', async () => {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const dialogs: Array<[string, string, unknown]> = [];
  const channel = await NightChannel.open(path, {
    question: () => {},
    dialog: (id, requestId, dialog) => void dialogs.push([id, requestId, dialog]),
    delivered: () => {},
    disconnected: () => {},
  });
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    const confirm = { terminalId: 't1', kind: 'confirm', title: 'Allow guarded command?', message: 'rm -rf build', options: ['Yes', 'No'] };
    const select = { terminalId: 't1', kind: 'select', title: 'Pick', message: '', options: ['a', 'b', 'c', 'd'] };
    client.send({ type: 'dialog', requestId: 'd1', dialog: { ...confirm, options: ['No', 'Yes'] } });
    client.send({ type: 'dialog', requestId: 'd2', dialog: { ...select, message: 'hidden text' } });
    client.send({ type: 'dialog', requestId: 'd3', dialog: { ...select, options: Array.from({ length: 21 }, (_, i) => `o${i}`) } });
    client.send({ type: 'dialog', requestId: 'd4', dialog: { ...confirm, message: 'x'.repeat(16_000) } });
    client.send({ type: 'dialog', requestId: 'd5', dialog: { ...select, options: ['a', 2] } });
    client.send({ type: 'dialog', requestId: 'd6', dialog: { ...select, terminalId: 'other' } });
    client.send({ type: 'dialog', requestId: 'd7', dialog: { ...select, kind: 'input' } });
    client.send({ type: 'dialog', requestId: 'd8', dialog: { ...confirm, extra: 'dropped' } });
    client.send({ type: 'dialog', requestId: 'd9', dialog: select });
    await until(() => dialogs.length === 2 && client.lines.length === 7);
    assert.deepEqual(client.lines.map((line) => (line as { requestId: string }).requestId), ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    assert.ok(client.lines.every((line) => (line as { type: string }).type === 'pass'));
    assert.deepEqual(dialogs, [['t1', 'd8', confirm], ['t1', 'd9', select]], 'only the documented fields');
  } finally {
    await channel.close();
  }
});

test('dialogs S8: a dialog up to 16 000 characters reaches Mirador whole; a notice dialog (no message, no options, title of at most 300) reaches it marked notice', async () => {
  const path = join(scratch, `run${++counter}`, 'night', 'socket');
  const dialogs: Array<[string, unknown]> = [];
  const channel = await NightChannel.open(path, {
    question: () => {},
    dialog: (_id, requestId, dialog) => void dialogs.push([requestId, dialog]),
    delivered: () => {},
    disconnected: () => {},
  });
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    const title = 'Allow guarded actions: git push?';
    const whole = { terminalId: 't1', kind: 'confirm', title, message: 'x'.repeat(16_000 - title.length - 'YesNo'.length), options: ['Yes', 'No'] };
    const notice = { terminalId: 't1', kind: 'confirm', title, message: '', options: [], notice: true };
    client.send({ type: 'dialog', requestId: 'n1', dialog: whole });
    client.send({ type: 'dialog', requestId: 'n2', dialog: notice });
    client.send({ type: 'dialog', requestId: 'n3', dialog: { ...notice, kind: 'select', title: 'é'.repeat(300) } });
    client.send({ type: 'dialog', requestId: 'n4', dialog: { ...whole, message: `${whole.message}x` } });
    client.send({ type: 'dialog', requestId: 'n5', dialog: { ...notice, options: ['Yes', 'No'] } });
    client.send({ type: 'dialog', requestId: 'n6', dialog: { ...notice, message: 'rm -rf /' } });
    client.send({ type: 'dialog', requestId: 'n7', dialog: { ...notice, title: 'x'.repeat(301) } });
    client.send({ type: 'dialog', requestId: 'n8', dialog: { ...notice, notice: 'yes' } });
    client.send({ type: 'dialog', requestId: 'n9', dialog: { ...whole, notice: false } });
    await until(() => dialogs.length === 3 && client.lines.length === 6);
    assert.deepEqual(dialogs.map(([id]) => id), ['n1', 'n2', 'n3']);
    assert.deepEqual(dialogs[0][1], whole);
    assert.deepEqual(dialogs[1][1], notice);
    assert.deepEqual(client.lines.map((line) => (line as { requestId: string }).requestId), ['n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
    assert.ok(client.lines.every((line) => (line as { type: string }).type === 'pass'));
  } finally {
    await channel.close();
  }
});

test('malformed lines are dropped, a malformed question is answered pass, and the connection stays', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    client.send('not json');
    client.send('[1,2]');
    client.send({ type: 'unknown' });
    client.send({ type: 'delivered', messageId: 'bad id with spaces' });
    client.send({ type: 'question', requestId: 'r2', question: { ...QUESTION, items: 'nope' } });
    client.send({ type: 'question', requestId: 'r3', question: { ...QUESTION, tool: 'bash' } });
    client.send({ type: 'question', requestId: 'r4', question: { ...QUESTION, terminalId: 'other' } });
    client.send({ type: 'question', requestId: 'r5', question: QUESTION });
    await until(() => events.questions.length === 1 && client.lines.length === 3);
    assert.deepEqual(client.lines, [{ type: 'pass', requestId: 'r2' }, { type: 'pass', requestId: 'r3' }, { type: 'pass', requestId: 'r4' }]);
    assert.equal(events.questions[0][1], 'r5');
    assert.deepEqual(events.delivered, []);
    assert.equal(client.closed(), false);
  } finally {
    await channel.close();
  }
});

test('past 20 questions a minute on one connection, the rest are answered pass without reaching Mirador', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    for (let i = 0; i < 25; i++) client.send({ type: 'question', requestId: `r${i}`, question: QUESTION });
    await until(() => events.questions.length === 20 && client.lines.length === 5);
    assert.deepEqual(client.lines, ['r20', 'r21', 'r22', 'r23', 'r24'].map((requestId) => ({ type: 'pass', requestId })));
  } finally {
    await channel.close();
  }
});

test('a line over 64 KiB closes the connection and is never handled', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    const big = { type: 'question', requestId: 'r1', question: { ...QUESTION, items: [{ ...QUESTION.items[0], question: 'x'.repeat(70 * 1024) }] } };
    client.send(big);
    await until(client.closed);
    assert.deepEqual(events.questions, []);
    // A huge hello is refused the same way.
    const other = await connect(path);
    other.socket.write('{"type":"hello","terminalId":"t1","token":"' + 'a'.repeat(65 * 1024));
    await until(other.closed);
  } finally {
    await channel.close();
  }
});

test('a new hello replaces the old connection; revoking a terminal closes it and retires its token', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const token = channel.issueToken('t1');
    const first = await connect(path);
    first.send({ type: 'hello', terminalId: 't1', token });
    await until(() => channel.isConnected('t1'));
    const second = await connect(path);
    second.send({ type: 'hello', terminalId: 't1', token });
    await until(first.closed);
    assert.equal(channel.isConnected('t1'), true, 'the new connection stays');
    assert.deepEqual(events.disconnected, [], 'a replaced connection is not a disconnect');
    channel.send('t1', { type: 'pass', requestId: 'r1' });
    await until(() => second.lines.length === 1);

    channel.revoke('t1');
    await until(second.closed);
    assert.equal(channel.isConnected('t1'), false);
    const third = await connect(path);
    third.send({ type: 'hello', terminalId: 't1', token });
    await until(third.closed);
  } finally {
    await channel.close();
  }
});

test('close() ends every connection and removes the socket', async () => {
  const { path, channel } = await openChannel();
  const client = await connect(path);
  client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
  await until(() => channel.isConnected('t1'));
  await channel.close();
  await until(client.closed);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});

/* ---------- Finished lines carry the final assistant message ---------- */

test('a finished line keeps the last final message of its terminal, replaced each turn, and tells the listeners', async () => {
  const { path, channel } = await openChannel();
  try {
    const heard: Array<[string, string, string]> = [];
    const stop = channel.onFinished((id, turn) => heard.push([id, turn.turnId, turn.text]));
    channel.onFinished(() => { throw new Error('a broken listener'); });
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    assert.equal(channel.lastFinished('t1'), null);
    client.send({ type: 'finished', turnId: '1000-1', text: 'Done. ¿Avanzamos con A (recomendado) o B?' });
    await until(() => heard.length === 1);
    assert.deepEqual(heard[0], ['t1', '1000-1', 'Done. ¿Avanzamos con A (recomendado) o B?']);
    assert.equal(channel.lastFinished('t1')?.text, 'Done. ¿Avanzamos con A (recomendado) o B?');
    assert.equal(typeof channel.lastFinished('t1')?.time, 'number');
    client.send({ type: 'finished', turnId: '1000-2', text: '' });
    await until(() => heard.length === 2);
    assert.deepEqual(channel.lastFinished('t1'), { turnId: '1000-2', text: '', time: channel.lastFinished('t1')!.time });
    stop();
    client.send({ type: 'finished', turnId: '1000-3', text: 'Third.' });
    await until(() => channel.lastFinished('t1')?.turnId === '1000-3');
    assert.equal(heard.length, 2, 'an unsubscribed listener hears nothing');
    assert.equal(client.closed(), false, 'a throwing listener does not close the connection');
  } finally {
    await channel.close();
  }
});

test('malformed or oversized finished lines are dropped; at most 20 a minute are kept', async () => {
  const { path, channel } = await openChannel();
  try {
    const heard: string[] = [];
    channel.onFinished((_id, turn) => heard.push(turn.turnId));
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    client.send({ type: 'finished', turnId: 'bad id', text: 'x' });
    client.send({ type: 'finished', turnId: 'ok-1', text: 42 });
    client.send({ type: 'finished', turnId: 'ok-2' });
    client.send({ type: 'finished', turnId: 'ok-3', text: 'ñ'.repeat(16 * 1024 + 1) });
    for (let i = 0; i < 25; i++) client.send({ type: 'finished', turnId: `t-${i}`, text: `turn ${i}` });
    await until(() => heard.length === 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(heard, Array.from({ length: 20 }, (_, i) => `t-${i}`));
    assert.equal(channel.lastFinished('t1')?.turnId, 't-19');
    assert.equal(client.closed(), false);
  } finally {
    await channel.close();
  }
});

test('the final message is dropped when the bridge disconnects or the terminal is revoked, kept when a new hello replaces it', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const token = channel.issueToken('t1');
    const first = await connect(path);
    first.send({ type: 'hello', terminalId: 't1', token });
    await until(() => channel.isConnected('t1'));
    first.send({ type: 'finished', turnId: 'a-1', text: 'One.' });
    await until(() => channel.lastFinished('t1') !== null);
    const second = await connect(path);
    second.send({ type: 'hello', terminalId: 't1', token });
    await until(first.closed);
    assert.equal(channel.lastFinished('t1')?.turnId, 'a-1', 'a replaced connection keeps it');
    second.socket.destroy();
    await until(() => events.disconnected.includes('t1'));
    assert.equal(channel.lastFinished('t1'), null, 'a disconnect drops it');

    const third = await connect(path);
    third.send({ type: 'hello', terminalId: 't1', token });
    await until(() => channel.isConnected('t1'));
    third.send({ type: 'finished', turnId: 'a-2', text: 'Two.' });
    await until(() => channel.lastFinished('t1') !== null);
    channel.revoke('t1');
    assert.equal(channel.lastFinished('t1'), null, 'an exited terminal drops it');
  } finally {
    await channel.close();
  }
});

test('a session line tells the session listeners which pi session file the agent uses; odd ones are dropped', async () => {
  const { path, channel, events } = await openChannel();
  try {
    const heard: Array<[string, string]> = [];
    const stop = channel.onSession((id, file) => heard.push([id, file]));
    channel.onSession(() => { throw new Error('a broken listener'); });
    const client = await connect(path);
    client.send({ type: 'session', file: '/before/hello.jsonl' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.closed(), true, 'a session line is no hello');
    assert.deepEqual(heard, []);

    const bridge = await connect(path);
    bridge.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    bridge.send({ type: 'session', file: 42 });
    bridge.send({ type: 'session' });
    bridge.send({ type: 'session', file: `/${'a'.repeat(4096)}.jsonl` });
    // Mirador checks the path itself (src/terminals/open-agents.ts): the channel passes any short string.
    bridge.send({ type: 'session', file: '/home/u/.pi/sessions/a.jsonl' });
    bridge.send({ type: 'session', file: 'relative.jsonl' });
    await until(() => heard.length === 2);
    assert.deepEqual(heard, [['t1', '/home/u/.pi/sessions/a.jsonl'], ['t1', 'relative.jsonl']]);
    stop();
    bridge.send({ type: 'session', file: '/b.jsonl' });
    bridge.send({ type: 'delivered', messageId: 'm1' });
    await until(() => events.delivered.length === 1);
    assert.equal(heard.length, 2, 'an unsubscribed listener hears nothing');
    assert.equal(bridge.closed(), false, 'odd lines and a throwing listener keep the connection');
  } finally {
    await channel.close();
  }
});

test('past 20 session lines a minute on one connection, the rest are dropped', async () => {
  const { path, channel } = await openChannel();
  try {
    const heard: string[] = [];
    channel.onSession((_id, file) => heard.push(file));
    const client = await connect(path);
    client.send({ type: 'hello', terminalId: 't1', token: channel.issueToken('t1') });
    await until(() => channel.isConnected('t1'));
    for (let i = 0; i < 25; i++) client.send({ type: 'session', file: `/s/${i}.jsonl` });
    await until(() => heard.length === 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(heard, Array.from({ length: 20 }, (_, i) => `/s/${i}.jsonl`));
  } finally {
    await channel.close();
  }
});
