// Answering held questions from Telegram.
// A fake Telegram HTTP server on 127.0.0.1 (never the real API) and a fake night service with
// the held-question interface; everything goes through startTelegramAnswers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramStore } from '../src/night/telegram.ts';
import { startTelegramAnswers, type HeldEnd, type HeldQuestion } from '../src/night/telegram-answers.ts';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr';
const SECRET = TOKEN.split(':')[1];
const OWNER = 4242;

interface Call {
  method: string;
  token: string;
  body: Record<string, any>;
  result: unknown;
  at: number;
}

/** A fake Bot API: records every call (a multipart file as `{ name, text }`); getUpdates hands out queued batches (or [] after a short wait). */
async function fakeTelegram() {
  const calls: Call[] = [];
  const batches: Array<{ status?: number; json: unknown } | unknown[]> = [];
  let wake: (() => void) | null = null;
  let nextMessage = 100;
  let fail: ((method: string, body: Record<string, any>) => { status: number; json: unknown } | undefined) | null = null;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const type = req.headers['content-type'] ?? '';
    let body: Record<string, any> = {};
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
      for (const [key, value] of form) body[key] = typeof value === 'string' ? value : { name: (value as File).name, text: await (value as File).text() };
    } else if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof json === 'string' ? json : JSON.stringify(json));
    };
    if (!match) return reply(404, { ok: false, description: 'Not Found' });
    const [, token, method] = match;
    const call: Call = { method, token, body, result: null, at: Date.now() };
    calls.push(call);
    const failed = fail?.(method, body);
    if (failed) return reply(failed.status, failed.json);
    if (method === 'getUpdates') {
      if (!batches.length) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
      const next = batches.shift() ?? [];
      if (Array.isArray(next)) return reply(200, { ok: true, result: next });
      return reply(next.status ?? 200, next.json);
    }
    if (method === 'sendMessage') call.result = { message_id: nextMessage++, chat: { id: Number(body.chat_id), type: 'private' }, date: 0, text: body.text };
    else if (method === 'sendDocument') call.result = { message_id: nextMessage++, chat: { id: Number(body.chat_id), type: 'private' }, date: 0, document: { file_name: body.document?.name } };
    else call.result = true;
    reply(200, { ok: true, result: call.result });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    base,
    calls,
    of: (method: string) => calls.filter((call) => call.method === method),
    /** Queues one getUpdates answer: a list of updates, or a raw `{ status, json }` response. */
    push(batch: unknown[] | { status?: number; json: unknown }) {
      batches.push(batch);
      wake?.();
    },
    failWith(fn: typeof fail) {
      fail = fn;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The night service's held-question side. */
function fakeService() {
  const held = new Map<string, HeldQuestion>();
  const heldListeners = new Set<(question: HeldQuestion) => void>();
  const endListeners = new Set<(id: string, outcome: HeldEnd) => void>();
  const holding: boolean[] = [];
  const answers: Array<{ id: string; choices: number[][]; source: string }> = [];
  const service = {
    holdForAnswers(enabled: boolean) {
      holding.push(enabled);
      if (!enabled) for (const id of [...held.keys()]) service.end(id, 'terminal');
    },
    onHeld(listener: (question: HeldQuestion) => void) {
      heldListeners.add(listener);
      return () => void heldListeners.delete(listener);
    },
    heldQuestions: () => [...held.values()],
    answerHeld(id: string, choices: number[][], source: 'telegram') {
      const question = held.get(id);
      if (!question) return { ok: false as const, code: 'unknown' as const };
      if (choices.length !== question.items.length || choices.some((list, i) => !list.length || list.some((c) => !Number.isInteger(c) || c < 0 || c >= question.items[i].options.length))) {
        return { ok: false as const, code: 'invalid' as const };
      }
      answers.push({ id, choices, source });
      // A dialog ends once its bridge took the answer (or the terminal won): the test says how.
      if (!question.dialog) service.end(id, 'answered');
      return { ok: true as const };
    },
    onHeldEnd(listener: (id: string, outcome: HeldEnd) => void) {
      endListeners.add(listener);
      return () => void endListeners.delete(listener);
    },
    // Test helpers, not part of the interface.
    hold(question: HeldQuestion) {
      held.set(question.id, question);
      for (const listener of heldListeners) listener(question);
    },
    end(id: string, outcome: HeldEnd) {
      if (!held.delete(id)) return;
      for (const listener of endListeners) listener(id, outcome);
    },
    holding,
    answers,
  };
  return service;
}

function heldQuestion(id: string, extra: Partial<HeldQuestion> = {}): HeldQuestion {
  return {
    id,
    terminalId: 't1',
    workspaceId: 'dev',
    workspaceName: 'Dev',
    rel: 'alpha',
    tool: 'ask_user_choice',
    items: [
      {
        question: `Which layout should report ${id} use?`,
        header: 'Layout',
        options: [
          { label: 'Grid', description: 'Cards in columns' },
          { label: 'List', description: 'One row per item' },
        ],
        multiSelect: false,
      },
    ],
    reason: 'The mission does not say which layout',
    rule: 'decider',
    sensitive: null,
    since: new Date().toISOString(),
    ...extra,
  };
}

async function until<T>(check: () => T | undefined | null | false, what = 'condition', ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

let updateId = 1000;
/** A tap on an inline button as Telegram sends it. */
function tap(data: unknown, messageId: number, who: { chat?: number; user?: number } = {}) {
  const id = ++updateId;
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: who.user ?? OWNER, is_bot: false, first_name: 'M' },
      message: { message_id: messageId, chat: { id: who.chat ?? OWNER, type: 'private' }, date: 0, text: '' },
      chat_instance: '1',
      data,
    },
  };
}

/** The buttons of a sendMessage or editMessageText call, flattened. */
const buttonsOf = (call: Call): Array<{ text: string; callback_data: string }> => (call.body.reply_markup?.inline_keyboard ?? []).flat();
const buttonFor = (call: Call, text: RegExp) => {
  const button = buttonsOf(call).find((b) => text.test(b.text));
  assert.ok(button, `no button ${text} in ${JSON.stringify(buttonsOf(call).map((b) => b.text))}`);
  return button.callback_data;
};

/**
 * Button tokens for the tests: a fixed seed, so every run sees the same tokens, and only hex
 * digits, so a token can never spell a button label such as "grid" or "list" by chance.
 */
function seededTokens(seed = 'mirador-telegram-answers') {
  let n = 0;
  return () => createHash('sha256').update(`${seed}:${n++}`).digest('hex').slice(0, 16);
}

async function setup(options: { chatId?: string; answers?: boolean; configured?: boolean; randomTokens?: boolean } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'mirador-telegram-answers-'));
  const store = new TelegramStore(join(scratch, 'telegram.json'));
  if (options.configured !== false) {
    await store.write({ botToken: TOKEN, chatId: options.chatId ?? String(OWNER) });
    if (options.answers === false) await store.setAnswers(false);
  }
  const telegram = await fakeTelegram();
  const service = fakeService();
  const logged: string[] = [];
  const token = options.randomTokens ? undefined : seededTokens();
  const answers = startTelegramAnswers({ service, store, apiBase: telegram.base, pollTimeoutS: 1, retryMs: 20, log: (line) => logged.push(line), token });
  await answers.refresh();
  return {
    store,
    telegram,
    service,
    answers,
    logged,
    async done() {
      await answers.close();
      await telegram.close();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

test('with a private chat and answering on it holds questions and polls getUpdates; off, unconfigured or a group chat it does neither', async () => {
  const on = await setup();
  try {
    assert.deepEqual(on.service.holding, [true]);
    const poll = await until(() => on.telegram.of('getUpdates')[0], 'a getUpdates call');
    assert.equal(poll.token, TOKEN);
    assert.deepEqual(poll.body.allowed_updates, ['callback_query'], 'only button taps are asked for, no webhook');
    assert.equal(poll.body.timeout, 1);
  } finally {
    await on.done();
  }
  for (const options of [{ answers: false }, { configured: false }, { chatId: '-1001234567890' }, { chatId: '@mirador_alerts' }]) {
    const off = await setup(options);
    try {
      await settle();
      assert.deepEqual(off.service.holding, [false], JSON.stringify(options));
      assert.deepEqual(off.telegram.calls, [], `no Telegram call: ${JSON.stringify(options)}`);
    } finally {
      await off.done();
    }
  }
});

test('S1: a held question arrives as one message saying which decision waits and why, with one opaque button per option', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('q1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    assert.equal(sent.body.chat_id, String(OWNER));
    const text: string = sent.body.text;
    assert.match(text, /Dev \/ alpha/);
    assert.match(text, /Layout: Which layout should report q1 use\?/);
    assert.match(text, /Grid — Cards in columns/);
    assert.match(text, /List — One row per item/);
    assert.match(text, /The mission does not say which layout/, 'why it waits');
    assert.ok(!text.includes('⚠'), 'not sensitive');
    const buttons = buttonsOf(sent);
    assert.deepEqual(buttons.map((b) => b.text), ['Grid', 'List']);
    for (const { callback_data: data } of buttons) {
      assert.ok(Buffer.byteLength(data) >= 1 && Buffer.byteLength(data) <= 64, data);
      assert.ok(!data.includes('q1') && !/grid|list/i.test(data), `opaque: ${data}`);
    }
    assert.notEqual(buttons[0].callback_data, buttons[1].callback_data);
  } finally {
    await s.done();
  }
});

test('the buttons carry the tokens the test gives, so S1 never sees a random token that spells grid or list', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('q1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const expected = seededTokens();
    assert.deepEqual(buttonsOf(sent).map((b) => b.callback_data), [expected(), expected()]);
    const tokens = seededTokens();
    for (let i = 0; i < 10000; i++) assert.match(tokens(), /^[0-9a-f]{16}$/);
  } finally {
    await s.done();
  }
});

test('without a token maker each button gets 16 random base64url characters, one per button', async () => {
  const s = await setup({ randomTokens: true });
  try {
    s.service.hold(heldQuestion('q1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const data = buttonsOf(sent).map((b) => b.callback_data);
    assert.equal(data.length, 2);
    for (const token of data) assert.match(token, /^[A-Za-z0-9_-]{16}$/);
    assert.notEqual(data[0], data[1]);
  } finally {
    await s.done();
  }
});

test('S4: the owner’s tap answers that question once, acknowledges the tap and marks the message answered', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('q1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = (sent.result as { message_id: number }).message_id;
    const list = buttonFor(sent, /^List$/);
    const update = tap(list, messageId);
    s.telegram.push([update]);
    await until(() => s.service.answers.length === 1, 'the answer');
    assert.deepEqual(s.service.answers, [{ id: 'q1', choices: [[1]], source: 'telegram' }]);
    const ack = await until(() => s.telegram.of('answerCallbackQuery').find((call) => call.body.callback_query_id === update.callback_query.id), 'the ack');
    assert.match(ack.body.text, /enviada/i);
    const edit = await until(() => s.telegram.of('editMessageText')[0], 'the edit');
    assert.equal(edit.body.chat_id, String(OWNER));
    assert.equal(edit.body.message_id, messageId);
    assert.match(edit.body.text, /Respondida desde Telegram: «List»/);
    assert.deepEqual(buttonsOf(edit), [], 'no buttons left');
    const polls = s.telegram.of('getUpdates').length;
    await until(() => s.telegram.of('getUpdates').length > polls, 'the next poll');
    assert.equal(s.telegram.of('getUpdates').at(-1)!.body.offset, update.update_id + 1, 'the update is confirmed');

    // The same tap again (replayed): nothing more is answered, the tap is still acknowledged.
    const replay = tap(list, messageId);
    s.telegram.push([replay]);
    await until(() => s.telegram.of('answerCallbackQuery').some((call) => call.body.callback_query_id === replay.callback_query.id), 'the replay ack');
    assert.equal(s.service.answers.length, 1);
    assert.equal(s.telegram.of('editMessageText').length, 1);
  } finally {
    await s.done();
  }
});

test('S1: with five held questions, a tap on the third answers the third and a tap on the first answers the first', async () => {
  const s = await setup();
  try {
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) s.service.hold(heldQuestion(id));
    await until(() => s.telegram.of('sendMessage').length === 5, 'five messages');
    const messages = s.telegram.of('sendMessage');
    const byQuestion = (id: string) => messages.find((call) => String(call.body.text).includes(`report ${id} use`))!;
    const third = byQuestion('a3');
    const first = byQuestion('a1');
    s.telegram.push([tap(buttonFor(third, /^List$/), (third.result as { message_id: number }).message_id), tap(buttonFor(first, /^Grid$/), (first.result as { message_id: number }).message_id)]);
    await until(() => s.service.answers.length === 2, 'two answers');
    assert.deepEqual(s.service.answers, [
      { id: 'a3', choices: [[1]], source: 'telegram' },
      { id: 'a1', choices: [[0]], source: 'telegram' },
    ]);
    assert.deepEqual(s.service.heldQuestions().map((q) => q.id), ['a2', 'a4', 'a5']);
    // A button of the fourth message carried to the second message's id answers neither.
    const second = byQuestion('a2');
    s.telegram.push([tap(buttonFor(byQuestion('a4'), /^Grid$/), (second.result as { message_id: number }).message_id)]);
    await settle();
    assert.equal(s.service.answers.length, 2);
  } finally {
    await s.done();
  }
});

test('S4, risk 2: taps from another chat or another user, unknown, oversize or malformed updates change nothing, and polling goes on', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('q1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = (sent.result as { message_id: number }).message_id;
    const grid = buttonFor(sent, /^Grid$/);
    const foreign = [tap(grid, messageId, { chat: 777 }), tap(grid, messageId, { user: 777 }), tap(grid, messageId, { chat: 777, user: 777 }), tap(grid, messageId, { chat: -OWNER, user: OWNER })];
    const unknown = [tap('x'.repeat(16), messageId), tap(`${grid}${'x'.repeat(80)}`, messageId), tap(42, messageId), tap(null, messageId)];
    const noMessage = tap(grid, messageId);
    delete (noMessage.callback_query as Record<string, unknown>).message;
    const malformed = [null, 'x', 7, [], { update_id: 'a' }, { update_id: ++updateId, callback_query: 'x' }, { update_id: ++updateId, callback_query: { id: 5, data: grid } }, { update_id: ++updateId, message: { text: '/start', chat: { id: OWNER } } }];
    s.telegram.push([...foreign, ...unknown, noMessage, ...malformed]);
    s.telegram.push({ json: { ok: true, result: { not: 'a list' } } });
    s.telegram.push({ status: 200, json: 'not json at all' });
    s.telegram.push({ json: { ok: true, result: Array.from({ length: 150 }, () => tap('y'.repeat(16), messageId)) } });
    await until(() => s.telegram.of('getUpdates').length >= 6, 'the polls after the bad batches', 5000);
    await settle();
    assert.deepEqual(s.service.answers, [], 'nothing answered');
    assert.deepEqual(s.telegram.of('editMessageText'), [], 'nothing edited');
    const acks = s.telegram.of('answerCallbackQuery');
    for (const update of foreign) {
      const ack = acks.find((call) => call.body.callback_query_id === update.callback_query.id);
      assert.ok(ack, 'a foreign tap is acknowledged');
      assert.equal(ack.body.text, undefined, 'and told nothing');
    }
    for (const update of [...unknown, noMessage]) assert.ok(acks.some((call) => call.body.callback_query_id === update.callback_query.id), 'an unknown tap is acknowledged');
    assert.ok(acks.length <= foreign.length + unknown.length + 1 + 100, 'at most 100 updates of one answer are handled');

    // The owner's real tap still works afterwards.
    s.telegram.push([tap(grid, messageId)]);
    await until(() => s.service.answers.length === 1, 'the owner’s answer');
    assert.deepEqual(s.service.answers, [{ id: 'q1', choices: [[0]], source: 'telegram' }]);
  } finally {
    await s.done();
  }
});

test('risk 2: Telegram failures are logged and retried without the token, and a 429 waits as told', async () => {
  const s = await setup();
  try {
    let refusals = 3;
    s.telegram.failWith((method) => {
      if (method === 'getUpdates' && refusals === 1) return refusals--, { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } };
      if (method === 'getUpdates' && refusals-- > 0) return { status: 500, json: { ok: false, description: `Internal error for bot${TOKEN} (${SECRET})` } };
      if (method === 'sendMessage') return { status: 400, json: { ok: false, description: `Bad Request: chat not found ${TOKEN}` } };
      return undefined;
    });
    const polls = await until(() => (s.telegram.of('getUpdates').length >= 4 ? s.telegram.of('getUpdates') : null), 'the retries', 5000);
    assert.ok(polls[3].at - polls[2].at >= 900, `after a 429 the next poll waits retry_after (${polls[3].at - polls[2].at} ms)`);
    assert.ok(polls[1].at - polls[0].at < 900, 'other failures wait retryMs');
    s.service.hold(heldQuestion('q1'));
    await until(() => s.logged.some((line) => line.includes('sendMessage')), 'the send failure');
    assert.ok(s.logged.some((line) => /getUpdates|answers/.test(line) && /500/.test(line)), JSON.stringify(s.logged));
    for (const line of s.logged) assert.ok(!line.includes(SECRET), line);
    assert.ok(s.logged.filter((line) => /500/.test(line)).length === 1, 'one line for a run of failures');
  } finally {
    await s.done();
  }
});

test('a question that ends elsewhere has its message edited to say how, without buttons, and its buttons do nothing after', async () => {
  const s = await setup();
  try {
    const outcomes: Array<[string, HeldEnd, RegExp]> = [
      ['e1', 'terminal', /en la terminal/],
      ['e2', 'closed', /la terminal se cerró/],
      ['e3', 'stopped', /piloto automático se apagó/],
      ['e4', 'answered', /Respondida/],
    ];
    for (const [id] of outcomes) s.service.hold(heldQuestion(id));
    await until(() => s.telegram.of('sendMessage').length === 4, 'four messages');
    const messages = s.telegram.of('sendMessage');
    for (const [id, outcome] of outcomes) s.service.end(id, outcome);
    await until(() => s.telegram.of('editMessageText').length === 4, 'four edits');
    for (const [id, , wording] of outcomes) {
      const message = messages.find((call) => String(call.body.text).includes(`report ${id} use`))!;
      const edit = s.telegram.of('editMessageText').find((call) => call.body.message_id === (message.result as { message_id: number }).message_id)!;
      assert.match(edit.body.text, wording, id);
      assert.match(edit.body.text, new RegExp(`report ${id} use`), 'the question stays readable');
      assert.deepEqual(buttonsOf(edit), []);
    }
    const first = messages[0];
    const late = tap(buttonFor(first, /^Grid$/), (first.result as { message_id: number }).message_id);
    s.telegram.push([late]);
    const ack = await until(() => s.telegram.of('answerCallbackQuery').find((call) => call.body.callback_query_id === late.callback_query.id), 'the late ack');
    assert.match(ack.body.text, /ya no/i);
    assert.deepEqual(s.service.answers, []);
    assert.equal(s.telegram.of('editMessageText').length, 4);
  } finally {
    await s.done();
  }
});

test('a tap the service refuses as ended marks the message, and one ended before its message was sent is edited once sent', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('r1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    s.service.answerHeld = () => ({ ok: false, code: 'ended' });
    const update = tap(buttonFor(sent, /^List$/), (sent.result as { message_id: number }).message_id);
    s.telegram.push([update]);
    const edit = await until(() => s.telegram.of('editMessageText')[0], 'the edit');
    assert.match(edit.body.text, /Ya no espera respuesta/);
    // The ack and the edit go out concurrently: under load the ack can land after the edit.
    const ack = await until(() => s.telegram.of('answerCallbackQuery').find((call) => call.body.callback_query_id === update.callback_query.id), 'the ack');
    assert.match(ack.body.text, /ya no espera/i);

    // The send is still in flight when the question ends.
    s.service.hold(heldQuestion('r2'));
    s.service.end('r2', 'closed');
    await until(() => s.telegram.of('sendMessage').length === 2, 'the second message');
    const second = s.telegram.of('sendMessage')[1];
    const late = await until(() => s.telegram.of('editMessageText').find((call) => call.body.message_id === (second.result as { message_id: number }).message_id), 'the edit after the send');
    assert.match(late.body.text, /la terminal se cerró/);
    assert.deepEqual(buttonsOf(late), []);
  } finally {
    await s.done();
  }
});

test('turning answering off or closing releases the held questions, edits their messages and stops polling', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('o1'));
    await until(() => s.telegram.of('sendMessage')[0], 'the message');
    await s.store.setAnswers(false);
    await s.answers.refresh();
    assert.deepEqual(s.service.holding, [true, false]);
    const edit = await until(() => s.telegram.of('editMessageText')[0], 'the edit');
    assert.match(edit.body.text, /en la terminal/);
    const polls = s.telegram.of('getUpdates').length;
    await settle();
    assert.equal(s.telegram.of('getUpdates').length, polls, 'no more polling');

    await s.store.setAnswers(true);
    await s.answers.refresh();
    assert.deepEqual(s.service.holding, [true, false, true]);
    await until(() => s.telegram.of('getUpdates').length > polls, 'polling again');
    await s.answers.refresh();
    assert.deepEqual(s.service.holding, [true, false, true], 'an unchanged store changes nothing');
    await s.answers.close();
    assert.deepEqual(s.service.holding, [true, false, true, false]);
    const after = s.telegram.of('getUpdates').length;
    s.service.hold(heldQuestion('o2'));
    await settle();
    assert.equal(s.telegram.of('getUpdates').length, after);
    assert.equal(s.telegram.of('sendMessage').length, 1, 'nothing is sent once closed');
  } finally {
    await s.done();
  }
});

const idOf = (call: Call) => (call.result as { message_id: number } | null)?.message_id ?? (call.body.message_id as number);
/** The newest view of a message: its last edit, or the message itself. */
const latest = (s: Awaited<ReturnType<typeof setup>>, messageId: number) => s.telegram.of('editMessageText').filter((call) => call.body.message_id === messageId).at(-1) ?? s.telegram.of('sendMessage').find((call) => idOf(call) === messageId)!;

async function press(s: Awaited<ReturnType<typeof setup>>, messageId: number, text: RegExp) {
  const before = s.telegram.of('answerCallbackQuery').length;
  const update = tap(buttonFor(latest(s, messageId), text), messageId);
  s.telegram.push([update]);
  await until(() => s.telegram.of('answerCallbackQuery').length > before, `the ack of ${text}`);
  await settle();
  return s.telegram.of('answerCallbackQuery').find((call) => call.body.callback_query_id === update.callback_query.id)!;
}

test('a multi-select question toggles its options and sends them with «Enviar respuesta»; a used toggle cannot be replayed', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('m1', {
      items: [{ question: 'Which checks should run?', header: 'Checks', options: ['Lint', 'Tests', 'Build'].map((label) => ({ label, description: '' })), multiSelect: true }],
    }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = idOf(sent);
    assert.deepEqual(buttonsOf(sent).map((b) => b.text), ['☐ Lint', '☐ Tests', '☐ Build', 'Enviar respuesta']);
    assert.match(sent.body.text, /puedes elegir varias/);

    const empty = await press(s, messageId, /^Enviar respuesta$/);
    assert.match(empty.body.text, /Elige/);
    assert.deepEqual(s.service.answers, [], 'nothing chosen, nothing sent');

    const lintToken = buttonFor(latest(s, messageId), /Lint$/);
    await press(s, messageId, /Lint$/);
    assert.deepEqual(buttonsOf(latest(s, messageId)).map((b) => b.text), ['☑ Lint', '☐ Tests', '☐ Build', 'Enviar respuesta']);
    s.telegram.push([tap(lintToken, messageId)]);
    await settle();
    assert.deepEqual(buttonsOf(latest(s, messageId)).map((b) => b.text), ['☑ Lint', '☐ Tests', '☐ Build', 'Enviar respuesta'], 'the spent toggle does nothing');
    await press(s, messageId, /Build$/);
    await press(s, messageId, /Tests$/);
    await press(s, messageId, /Tests$/);
    assert.deepEqual(s.service.answers, [], 'toggles only choose');
    const ack = await press(s, messageId, /^Enviar respuesta$/);
    assert.match(ack.body.text, /enviada/i);
    assert.deepEqual(s.service.answers, [{ id: 'm1', choices: [[0, 2]], source: 'telegram' }]);
    assert.match(latest(s, messageId).body.text, /Respondida desde Telegram: «Lint», «Build»/);
  } finally {
    await s.done();
  }
});

test('a question with several items takes one pick per item, and an answer the service refuses keeps the message open', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('m2', {
      items: [
        { question: 'Which layout?', header: 'Layout', options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }], multiSelect: false },
        { question: 'Which theme?', header: 'Theme', options: [{ label: 'Dark', description: '' }, { label: 'Light', description: '' }], multiSelect: false },
      ],
    }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = idOf(sent);
    assert.deepEqual(buttonsOf(sent).map((b) => b.text), ['1· ○ Grid', '1· ○ List', '2· ○ Dark', '2· ○ Light', 'Enviar respuesta']);
    assert.match(sent.body.text, /1\. Layout: Which layout\?/);
    assert.match(sent.body.text, /2\. Theme: Which theme\?/);
    await press(s, messageId, /Grid$/);
    await press(s, messageId, /List$/);
    const missing = await press(s, messageId, /^Enviar respuesta$/);
    assert.match(missing.body.text, /Elige/, 'the theme is missing');
    await press(s, messageId, /Light$/);
    assert.deepEqual(buttonsOf(latest(s, messageId)).map((b) => b.text), ['1· ○ Grid', '1· ● List', '2· ○ Dark', '2· ● Light', 'Enviar respuesta']);

    const answerHeld = s.service.answerHeld;
    s.service.answerHeld = () => ({ ok: false, code: 'invalid' });
    const refused = await press(s, messageId, /^Enviar respuesta$/);
    assert.match(refused.body.text, /no aceptó/);
    assert.ok(buttonsOf(latest(s, messageId)).length === 5, 'the buttons come back');
    s.service.answerHeld = answerHeld;
    await press(s, messageId, /^Enviar respuesta$/);
    assert.deepEqual(s.service.answers, [{ id: 'm2', choices: [[1], [1]], source: 'telegram' }]);
  } finally {
    await s.done();
  }
});

test('S3: a sensitive question says «⚠ sensible» and needs «Confirmar» before its answer goes', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('s1', { sensitive: 'it mentions production credentials', rule: 'sensitive:secrets' }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = idOf(sent);
    assert.match(sent.body.text, /^⚠ sensible: it mentions production credentials\n/);
    const picked = await press(s, messageId, /^List$/);
    assert.match(picked.body.text, /Confirma/);
    assert.deepEqual(s.service.answers, [], 'a pick alone does not answer');
    const confirm = latest(s, messageId);
    assert.match(confirm.body.text, /Vas a responder: «List»/);
    assert.deepEqual(buttonsOf(confirm).map((b) => b.text), ['Confirmar «List»', 'Volver']);
    await press(s, messageId, /^Volver$/);
    assert.deepEqual(buttonsOf(latest(s, messageId)).map((b) => b.text), ['Grid', 'List']);
    assert.deepEqual(s.service.answers, []);
    await press(s, messageId, /^Grid$/);
    await press(s, messageId, /^Confirmar/);
    assert.deepEqual(s.service.answers, [{ id: 's1', choices: [[0]], source: 'telegram' }]);
    assert.match(latest(s, messageId).body.text, /^⚠ sensible[\s\S]*Respondida desde Telegram: «Grid»/);
  } finally {
    await s.done();
  }
});

test('a message Telegram refused is sent again at the next polls, three tries at most', async () => {
  const s = await setup();
  try {
    let refusals = 1;
    s.telegram.failWith((method) => (method === 'sendMessage' && refusals-- > 0 ? { status: 502, json: { ok: false, description: 'Bad Gateway' } } : undefined));
    s.service.hold(heldQuestion('t1'));
    const sent = await until(() => s.telegram.of('sendMessage').find((call) => call.result), 'the second try');
    assert.equal(s.telegram.of('sendMessage').length, 2);
    assert.deepEqual(buttonsOf(sent).map((b) => b.text), ['Grid', 'List']);
    s.telegram.push([tap(buttonFor(sent, /^Grid$/), idOf(sent))]);
    await until(() => s.service.answers.length === 1, 'the answer');

    s.telegram.failWith((method) => (method === 'sendMessage' ? { status: 502, json: { ok: false, description: 'Bad Gateway' } } : undefined));
    s.service.hold(heldQuestion('t2'));
    await until(() => s.telegram.of('sendMessage').length === 5, 'three tries');
    const polls = s.telegram.of('getUpdates').length;
    await until(() => s.telegram.of('getUpdates').length >= polls + 3, 'more polls');
    assert.equal(s.telegram.of('sendMessage').length, 5, 'no fourth try');
  } finally {
    await s.done();
  }
});

/* ---------- Dialogs ---------- */

const GUARDED_TITLE = 'Allow guarded actions: git push; git push?';

function heldDialog(id: string, kind: 'select' | 'confirm', title: string, message: string, options: string[], extra: Partial<HeldQuestion> = {}): HeldQuestion {
  return heldQuestion(id, {
    tool: 'dialog',
    dialog: { kind, title, message },
    items: [{ question: title, header: '', options: options.map((label) => ({ label, description: '' })), multiSelect: false }],
    reason: 'the agent waits for this dialog in its terminal',
    rule: 'dialog',
    sensitive: 'dialog',
    ...extra,
  });
}

test('dialogs S1, S3: a guarded command confirmation arrives with its title and whole command, «Sí» / «No», and answers only after «Confirmar»', async () => {
  const s = await setup();
  try {
    // Long, with the dangerous part at its very end: nothing of it may be cut away.
    const words = Array.from({ length: 300 }, (_, i) => `step${i}`).join(' ');
    const danger = '&& git push --force origin main';
    const preview = `git commit -am "${words}"\n${danger}`;
    s.service.hold(heldDialog('d1', 'confirm', GUARDED_TITLE, preview, ['Yes', 'No']));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const text: string = sent.body.text;
    assert.ok(text.includes(GUARDED_TITLE), 'the title');
    assert.ok(text.includes(`git commit -am "${words}"`), 'the whole command');
    assert.ok(text.includes(danger), 'the dangerous part');
    assert.ok(!text.includes('…'), 'nothing cut');
    assert.match(text, /^⚠ sensible/);
    assert.match(text, /Dev \/ alpha/);
    assert.match(text, /1\) Sí\n2\) No/);
    assert.deepEqual(buttonsOf(sent).map((b) => b.text), ['Sí', 'No']);
    assert.deepEqual(s.telegram.of('sendDocument'), [], 'it fits: one message, no document');
    const messageId = (sent.result as { message_id: number }).message_id;

    const stale = buttonFor(sent, /^Sí$/);
    s.telegram.push([tap(stale, messageId)]);
    const confirming = await until(() => s.telegram.of('editMessageText')[0], 'the confirmation step');
    assert.deepEqual(s.service.answers, [], 'one tap answers nothing');
    assert.ok(String(confirming.body.text).includes(danger), 'the command stays in view');
    assert.match(confirming.body.text, /Vas a responder: «Sí»/);
    s.telegram.push([tap(buttonFor(confirming, /^Confirmar/), messageId)]);
    await until(() => s.service.answers.length === 1, 'the answer');
    assert.deepEqual(s.service.answers, [{ id: 'd1', choices: [[0]], source: 'telegram' }]);
    const sending = await until(() => s.telegram.of('editMessageText')[1], 'sending');
    assert.match(sending.body.text, /Enviando respuesta…$/);
    assert.deepEqual(buttonsOf(sending), []);
    s.service.end('d1', 'answered');
    const done = await until(() => s.telegram.of('editMessageText')[2], 'the end');
    assert.match(done.body.text, /✓ Respondido desde Telegram: «Sí»/);
    assert.ok(String(done.body.text).includes(danger), 'the answered message still says which command');
    assert.deepEqual(buttonsOf(done), []);

    const late = tap(stale, messageId);
    s.telegram.push([late]);
    const ack = await until(() => s.telegram.of('answerCallbackQuery').find((call) => call.body.callback_query_id === late.callback_query.id), 'the late ack');
    assert.equal(ack.body.text, 'Este botón ya no sirve.');
    assert.equal(s.service.answers.length, 1);
  } finally {
    await s.done();
  }
});

test('dialogs S2: a select with four options gets one button per option with its exact label; the third, confirmed, answers index 2', async () => {
  const s = await setup();
  try {
    const options = ['Push now', 'Push with --force-with-lease', 'Open a PR instead', 'Cancel'];
    // Even one the service did not mark sensitive asks for «Confirmar».
    s.service.hold(heldDialog('d2', 'select', 'How should the branch go out?', '', options, { sensitive: null }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    assert.deepEqual(buttonsOf(sent).map((b) => b.text), options);
    assert.match(sent.body.text, /^⚠ sensible: diálogo de la terminal\nMirador: un agente espera tu respuesta en su terminal/);
    assert.match(sent.body.text, /How should the branch go out\?/);
    assert.match(sent.body.text, /1\) Push now\n2\) Push with --force-with-lease\n3\) Open a PR instead\n4\) Cancel/);
    const messageId = (sent.result as { message_id: number }).message_id;
    s.telegram.push([tap(buttonFor(sent, /^Open a PR instead$/), messageId)]);
    const confirming = await until(() => s.telegram.of('editMessageText')[0], 'the confirmation step');
    assert.deepEqual(s.service.answers, []);
    s.telegram.push([tap(buttonFor(confirming, /^Volver$/), messageId)]);
    const back = await until(() => s.telegram.of('editMessageText')[1], 'back to the options');
    assert.deepEqual(buttonsOf(back).map((b) => b.text), options);
    s.telegram.push([tap(buttonFor(back, /^Open a PR instead$/), messageId)]);
    const again = await until(() => s.telegram.of('editMessageText')[2], 'confirm again');
    s.telegram.push([tap(buttonFor(again, /^Confirmar/), messageId)]);
    await until(() => s.service.answers.length === 1, 'the answer');
    assert.deepEqual(s.service.answers, [{ id: 'd2', choices: [[2]], source: 'telegram' }]);
  } finally {
    await s.done();
  }
});

test('dialogs S4: a dialog that ends in the terminal, its terminal closing or the autopilot turning off edits the message without buttons; a late tap no longer works', async () => {
  const s = await setup();
  try {
    const ends: Array<[string, HeldEnd, RegExp]> = [
      ['e1', 'terminal', /Ya no espera aquí: se respondió en la terminal o quedó para responder allí\.$/],
      ['e2', 'closed', /Ya no espera respuesta: la terminal se cerró\.$/],
      ['e3', 'stopped', /Ya no espera aquí: el piloto automático se apagó; respóndelo en la terminal\.$/],
    ];
    for (const [id] of ends) s.service.hold(heldDialog(id, 'confirm', GUARDED_TITLE, `git push ${id}`, ['Yes', 'No']));
    await until(() => s.telegram.of('sendMessage').length === 3, 'three messages');
    for (const [id, outcome, line] of ends) {
      const sent = s.telegram.of('sendMessage').find((call) => String(call.body.text).includes(`git push ${id}`))!;
      const messageId = (sent.result as { message_id: number }).message_id;
      s.service.end(id, outcome);
      const edit = await until(() => s.telegram.of('editMessageText').find((call) => call.body.message_id === messageId), `the edit of ${id}`);
      assert.match(edit.body.text, line, outcome);
      assert.ok(String(edit.body.text).includes(`git push ${id}`), `${outcome}: still says which command`);
      assert.deepEqual(buttonsOf(edit), [], outcome);
      const late = tap(buttonFor(sent, /^Sí$/), messageId);
      s.telegram.push([late]);
      const ack = await until(() => s.telegram.of('answerCallbackQuery').find((call) => call.body.callback_query_id === late.callback_query.id), 'the late ack');
      assert.equal(ack.body.text, 'Este botón ya no sirve.', outcome);
    }
    assert.deepEqual(s.service.answers, []);
  } finally {
    await s.done();
  }
});

const SHA = '3f786850e387550fdab836ed7e6dc881de23001b';
const LONG_PATH = '/home/you/Dev/tools/mirador-worktrees/telegram-dialogs-feature-branch-checkout/src/night/telegram-answers.ts';
const BASE64 = 'U29tZSBsb25nIGJhc2U2NCBwYXlsb2FkIHRoYXQgaXMgbm90IGEgc2VjcmV0IGF0IGFsbA==';
const CREDENTIALS = {
  bearer: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789',
  flag: 'tok9f8e7d6c5b4a39281706',
  github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
  inUrl: 'ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210',
  skInUrl: 'sk-abcdefghijklmnopqrstuvwxyz',
};
const CREDENTIAL_LINES = [
  `curl -H "Authorization: Bearer ${CREDENTIALS.bearer}" https://api.example.com/v1/deploy`,
  `deploy --token=${CREDENTIALS.flag} --ref ${SHA}`,
  `GITHUB_TOKEN=${CREDENTIALS.github} gh release create`,
  `notify ${TOKEN}`,
  `git push https://${CREDENTIALS.inUrl}@github.com/o/r.git`,
  `curl https://${CREDENTIALS.skInUrl}@api.example.com`,
];

test('dialogs S9: a dialog shows commit SHAs, long paths and base64 whole; only credentials are covered, each marked «[credencial oculta]»', async () => {
  const s = await setup();
  try {
    const message = [`git push origin ${SHA}`, `cp ${LONG_PATH} /tmp`, `echo ${BASE64}`, ...CREDENTIAL_LINES].join('\n');
    s.service.hold(heldDialog('k1', 'confirm', GUARDED_TITLE, message, ['Yes', 'No']));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const text: string = sent.body.text;
    for (const visible of [`git push origin ${SHA}`, `cp ${LONG_PATH} /tmp`, `echo ${BASE64}`, 'https://api.example.com/v1/deploy', `--ref ${SHA}`, 'gh release create']) assert.ok(text.includes(visible), visible);
    for (const secret of [...Object.values(CREDENTIALS), SECRET]) assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes('curl -H "Authorization: Bearer [credencial oculta]" https://api.example.com/v1/deploy'), text);
    assert.ok(text.includes('deploy --token=[credencial oculta] --ref'));
    assert.ok(text.includes('GITHUB_TOKEN=[credencial oculta] gh release create'));
    assert.ok(text.includes('notify [credencial oculta]'));
    assert.ok(text.includes('git push https://[credencial oculta]@github.com/o/r.git'), 'a token right after the scheme');
    assert.ok(text.includes('curl https://[credencial oculta]@api.example.com'));
    assert.ok(!text.includes('[…]'), 'the generic heuristic does not apply');
    assert.deepEqual(s.telegram.of('sendDocument'), [], 'it fits: one message, as before');

    s.service.hold(heldDialog('k2', 'select', 'Where should main go?', '', [`Reset to ${SHA}`, 'Cancel']));
    const select = await until(() => s.telegram.of('sendMessage')[1], 'the select');
    assert.deepEqual(buttonsOf(select).map((b) => b.text), [`Reset to ${SHA}`, 'Cancel']);
    await press(s, idOf(select), /^Reset/);
    assert.ok(latest(s, idOf(select)).body.text.includes(`Vas a responder: «Reset to ${SHA}»`));

    const keys = ['AKIAIOSFODNN7EXAMPLE', 'xoxb-1234567890-abcdefghij', 'glpat-ABCDEFGHIJ0123456789', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'github_pat_11ABCDEFG0123456789_abcdefghijk'];
    const values = ['hunter2hunter2', 'p4ssw0rd', 's3cr3tValue'];
    const named = [...keys.map((key) => `use ${key} now`), `mysql --password ${values[0]} db`, `export DB_PASSWORD=${values[1]}`, `curl "https://x.test/cb?client_secret=${values[2]}&state=1"`];
    s.service.hold(heldDialog('k3', 'confirm', GUARDED_TITLE, named.join('\n'), ['Yes', 'No']));
    const third: string = (await until(() => s.telegram.of('sendMessage')[2], 'the third')).body.text;
    for (const secret of [...keys, ...values]) assert.ok(!third.includes(secret), secret);
    assert.equal(third.split('use [credencial oculta] now').length - 1, keys.length, third);
    assert.ok(third.includes('mysql --password [credencial oculta] db'));
    assert.ok(third.includes('export DB_PASSWORD=[credencial oculta]'));
    assert.ok(third.includes('client_secret=[credencial oculta]&state=1'));
  } finally {
    await s.done();
  }
});

test('follow-ups S1: a value after «password:», a JSON password / token / secret and a URL password are covered too, names and users kept; what S9 keeps visible stays visible', async () => {
  const s = await setup();
  try {
    const covered = [
      ['mysql -u root password: hunter2 db', 'mysql -u root password: [credencial oculta] db'],
      ['DB_PASSWORD: p4ss-w0rd', 'DB_PASSWORD: [credencial oculta]'],
      ['Token:tkn-12345678', 'Token:[credencial oculta]'],
      ['client secret: "two words" here', 'client secret: [credencial oculta] here'],
      ['{"token":"abc123","api_token": "def456","DB_Password":"pw\\"789","user":"ana"}', '{"token":"[credencial oculta]","api_token": "[credencial oculta]","DB_Password":"[credencial oculta]","user":"ana"}'],
      ['git clone https://ana:hunter3@example.com/o/r.git', 'git clone https://ana:[credencial oculta]@example.com/o/r.git'],
    ];
    const visible = [`git push origin ${SHA}`, `cp ${LONG_PATH} /tmp`, `echo ${BASE64}`, 'curl https://example.com:8080/x?page=2', 'git clone ssh://git@example.com/o/r.git', 'git push origin main', '{"user":"ana","tokens":3}', 'gh auth login --token-file ./creds.txt', '{"max_tokens":4096,"token_count":12,"tokens_used":7}', 'TOKEN_FILE: ./creds.txt', 'git clone https://ana@example.com/o/r.git'];
    const message = [...covered.map(([line]) => line), ...visible].join('\n');
    s.service.hold(heldDialog('c1', 'confirm', GUARDED_TITLE, message, ['Yes', 'No']));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const text: string = sent.body.text;
    for (const [, line] of covered) assert.ok(text.includes(line), `${line}\n---\n${text}`);
    for (const secret of ['hunter2', 'p4ss-w0rd', 'tkn-12345678', 'two words', 'abc123', 'def456', '789', 'hunter3']) assert.ok(!text.includes(secret), secret);
    for (const line of visible) assert.ok(text.includes(line), line);

    // The document of a long dialog, the summary and the button labels follow the same rule.
    const long = `${'step '.repeat(1000)}\n${message}`;
    s.service.hold(heldDialog('c2', 'select', 'Run with password: hunter2?', long, ['Use https://ana:hunter3@example.com', 'Cancel']));
    const second = await until(() => s.telegram.of('sendMessage')[1], 'the buttons message');
    const file: string = s.telegram.of('sendDocument')[0].body.document.text;
    for (const [, line] of covered) assert.ok(file.includes(line), line);
    for (const line of visible) assert.ok(file.includes(line), line);
    assert.ok(second.body.text.includes('Run with password: [credencial oculta]'), second.body.text);
    assert.deepEqual(buttonsOf(second).map((b) => b.text), ['Use https://ana:[credencial oculta]@example.com', 'Cancel']);
    for (const secret of ['hunter2', 'hunter3']) assert.ok(!JSON.stringify(second.body).includes(secret), secret);
  } finally {
    await s.done();
  }
});

test('follow-ups S3: a confirmed dialog answer shows «Enviando respuesta…» until it ends: answered → «✓ Respondido desde Telegram», the terminal first → its terminal line, never «Respondido»', async () => {
  const s = await setup();
  try {
    for (const [id, outcome] of [['w1', 'answered'], ['w2', 'terminal']] as const) {
      s.service.hold(heldDialog(id, 'confirm', GUARDED_TITLE, `git push ${id}`, ['Yes', 'No']));
      const sent = await until(() => s.telegram.of('sendMessage').find((call) => String(call.body.text).includes(`git push ${id}`)), `the message of ${id}`);
      const messageId = idOf(sent);
      await press(s, messageId, /^No$/);
      const ack = await press(s, messageId, /^Confirmar/);
      assert.equal(ack.body.text, 'Respuesta enviada.', outcome);
      assert.deepEqual(s.service.answers.at(-1), { id, choices: [[1]], source: 'telegram' });
      const sending = latest(s, messageId);
      assert.match(sending.body.text, /\n\nEnviando respuesta…$/, outcome);
      assert.ok(sending.body.text.includes(`git push ${id}`), 'still says which command');
      assert.deepEqual(buttonsOf(sending), [], 'no buttons while it goes');
      const edits = s.telegram.of('editMessageText').length;
      s.service.end(id, outcome);
      await until(() => s.telegram.of('editMessageText').length > edits, `the end of ${id}`);
      await settle();
      const done = latest(s, messageId);
      if (outcome === 'answered') assert.match(done.body.text, /\n\n✓ Respondido desde Telegram: «No»$/);
      else assert.match(done.body.text, /\n\nYa no espera aquí: se respondió en la terminal o quedó para responder allí\.$/);
      if (outcome === 'terminal') assert.ok(!done.body.text.includes('Respondido'), 'never says Telegram answered it');
      assert.deepEqual(buttonsOf(done), []);
      assert.equal(s.telegram.of('editMessageText').length, edits + 1, 'one end edit');
    }
  } finally {
    await s.done();
  }
});

test('dialogs S9 pin: a held question that is not a dialog is still redacted exactly as before', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('p1', {
      items: [{ question: `Deploy ${SHA}?`, header: '', options: [{ label: 'Yes', description: `copies ${LONG_PATH}` }, { label: 'No', description: '' }], multiSelect: false }],
      reason: `the bot ${TOKEN} is involved`,
    }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const text: string = sent.body.text;
    assert.ok(text.includes('Deploy […]?'), text);
    assert.ok(text.includes('copies /home/you/Dev/tools/mirador-worktrees/[…]/src/night/telegram-answers.ts'), text);
    assert.ok(text.includes('the bot […] is involved'), text);
    assert.ok(!text.includes(SHA) && !text.includes(SECRET));
    assert.ok(!text.includes('[credencial oculta]'));
  } finally {
    await s.done();
  }
});

test('dialogs S8: a dialog too long for one message goes first as a document with its whole text, then a buttons message replying to it; a tap answers after «Confirmar»', async () => {
  const s = await setup();
  try {
    const steps = Array.from({ length: 700 }, (_, i) => `step${i}`).join(' ');
    const danger = `&& git push --force origin ${SHA}`;
    const message = `git commit -am "${steps}"\n${danger}\n${CREDENTIAL_LINES[0]}`;
    s.service.hold(heldDialog('L1', 'confirm', GUARDED_TITLE, message, ['Yes', 'No']));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the buttons message');
    const [document] = s.telegram.of('sendDocument');
    assert.ok(document, 'a document');
    assert.ok(s.telegram.calls.indexOf(document) < s.telegram.calls.indexOf(sent), 'the document first');
    assert.equal(document.body.chat_id, String(OWNER));
    assert.equal(document.body.document.name, 'dialogo.txt');
    assert.equal(document.body.reply_markup, undefined, 'no buttons on the document');
    const caption: string = document.body.caption;
    assert.match(caption, /Dev \/ alpha/);
    assert.match(caption, /comando protegido/);
    assert.match(caption, /archivo adjunto/);
    const file: string = document.body.document.text;
    assert.ok(file.includes(GUARDED_TITLE));
    assert.ok(file.includes(`git commit -am "${steps}"\n${danger}\n`), 'the whole command, line by line');
    assert.ok(file.includes('Authorization: Bearer [credencial oculta]'));
    assert.ok(!file.includes(CREDENTIALS.bearer));
    assert.match(file, /1\) Sí\n2\) No/);

    const documentId = (document.result as { message_id: number }).message_id;
    assert.deepEqual(sent.body.reply_parameters, { message_id: documentId }, 'the buttons reply to the document');
    const text: string = sent.body.text;
    assert.ok(Array.from(text).length <= 4096);
    assert.ok(text.includes('El texto completo está en el archivo adjunto.'), text);
    assert.ok(text.includes(GUARDED_TITLE));
    assert.match(text, /Dev \/ alpha/);
    assert.ok(!text.includes('step699'), 'a summary, not the whole text');
    assert.deepEqual(buttonsOf(sent).map((b) => b.text), ['Sí', 'No']);

    const messageId = idOf(sent);
    await press(s, messageId, /^Sí$/);
    assert.deepEqual(s.service.answers, [], 'one tap answers nothing');
    assert.match(latest(s, messageId).body.text, /Vas a responder: «Sí»/);
    await press(s, messageId, /^Confirmar/);
    assert.deepEqual(s.service.answers, [{ id: 'L1', choices: [[0]], source: 'telegram' }]);
    assert.match(latest(s, messageId).body.text, /Enviando respuesta…$/);
    s.service.end('L1', 'answered');
    await settle();
    const done = latest(s, messageId);
    assert.match(done.body.text, /✓ Respondido desde Telegram: «Sí»$/);
    assert.ok(done.body.text.includes('El texto completo está en el archivo adjunto.'));
    assert.deepEqual(buttonsOf(done), []);
    assert.equal(s.telegram.of('sendDocument').length, 1);
  } finally {
    await s.done();
  }
});

test('dialogs S8: a refused document is retried like a refused message, three tries at most, and the buttons message never goes without it', async () => {
  const s = await setup();
  try {
    const long = `git push ${'x'.repeat(5000)}`;
    const badGateway = { status: 502, json: { ok: false, description: 'Bad Gateway' } };
    let refusals = 1;
    s.telegram.failWith((method) => (method === 'sendDocument' && refusals-- > 0 ? badGateway : undefined));
    s.service.hold(heldDialog('R1', 'confirm', GUARDED_TITLE, `${long} R1`, ['Yes', 'No']));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the buttons message');
    const documents = s.telegram.of('sendDocument');
    assert.equal(documents.length, 2, 'the document was sent again');
    assert.deepEqual(sent.body.reply_parameters, { message_id: (documents[1].result as { message_id: number }).message_id });

    // A refused buttons message is sent again without sending its document twice.
    refusals = 1;
    s.telegram.failWith((method) => (method === 'sendMessage' && refusals-- > 0 ? badGateway : undefined));
    s.service.hold(heldDialog('R2', 'confirm', GUARDED_TITLE, `${long} R2`, ['Yes', 'No']));
    const second = await until(() => s.telegram.of('sendMessage').find((call, i) => i > 0 && call.result), 'the second buttons message');
    assert.equal(s.telegram.of('sendDocument').length, 3);
    assert.equal(s.telegram.of('sendMessage').length, 3);
    assert.deepEqual(second.body.reply_parameters, { message_id: (s.telegram.of('sendDocument')[2].result as { message_id: number }).message_id });

    s.telegram.failWith((method) => (method === 'sendDocument' ? badGateway : undefined));
    s.service.hold(heldDialog('R3', 'confirm', GUARDED_TITLE, `${long} R3`, ['Yes', 'No']));
    await until(() => s.telegram.of('sendDocument').length === 6, 'three tries');
    const polls = s.telegram.of('getUpdates').length;
    await until(() => s.telegram.of('getUpdates').length >= polls + 3, 'more polls');
    assert.equal(s.telegram.of('sendDocument').length, 6, 'no fourth try');
    assert.equal(s.telegram.of('sendMessage').length, 3, 'no buttons message without its document');
  } finally {
    await s.done();
  }
});

test('dialogs S8: a notice (a dialog too big to forward) arrives without buttons, says which agent waits and to answer it on the laptop, and its end still edits it', async () => {
  const s = await setup();
  try {
    s.service.hold(heldDialog('N1', 'confirm', GUARDED_TITLE, '', [], { dialog: { kind: 'confirm', title: GUARDED_TITLE, message: '', notice: true } }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the notice');
    const text: string = sent.body.text;
    assert.deepEqual(buttonsOf(sent), [], 'no buttons');
    assert.match(text, /Dev \/ alpha/);
    assert.ok(text.includes(GUARDED_TITLE));
    assert.match(text, /comando protegido/);
    assert.match(text, /respóndelo en el laptop/);
    assert.deepEqual(s.telegram.of('sendDocument'), []);
    s.service.end('N1', 'terminal');
    const edit = await until(() => s.telegram.of('editMessageText')[0], 'the edit');
    assert.equal(edit.body.message_id, idOf(sent));
    assert.match(edit.body.text, /se respondió en la terminal o quedó para responder allí\.$/);
    assert.ok(edit.body.text.includes(GUARDED_TITLE));
    assert.deepEqual(buttonsOf(edit), []);

    s.service.hold(heldDialog('N2', 'select', 'Pick a model', '', [], { dialog: { kind: 'select', title: 'Pick a model', message: '', notice: true } }));
    const other = await until(() => s.telegram.of('sendMessage')[1], 'the second notice');
    assert.match(other.body.text, /un diálogo/);
    assert.doesNotMatch(other.body.text, /comando protegido/);
    assert.deepEqual(buttonsOf(other), []);
  } finally {
    await s.done();
  }
});
