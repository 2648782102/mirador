// Security probes for answering held questions from Telegram (Risk 2).
// A fake Telegram HTTP server on 127.0.0.1 (never the real API) and a fake night service with
// the held-question interface; everything goes through startTelegramAnswers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

/** A fake Bot API: records every call; getUpdates hands out queued batches (or [] after a short wait). */
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
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
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
      service.end(id, 'answered');
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

async function setup(options: { chatId?: string; answers?: boolean; configured?: boolean } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'mirador-telegram-answers-'));
  const store = new TelegramStore(join(scratch, 'telegram.json'));
  if (options.configured !== false) {
    await store.write({ botToken: TOKEN, chatId: options.chatId ?? String(OWNER) });
    if (options.answers === false) await store.setAnswers(false);
  }
  const telegram = await fakeTelegram();
  const service = fakeService();
  const logged: string[] = [];
  const answers = startTelegramAnswers({ service, store, apiBase: telegram.base, pollTimeoutS: 1, retryMs: 20, log: (line) => logged.push(line) });
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

// ---------------- Probes from the independent Risk 2 (security) verification ----------------

test('V1 (S4): type-confused or incomplete sender ids never answer: string ids, fractional ids, missing from, a bot sender with the owner id but a foreign chat', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('v1'));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = (sent.result as { message_id: number }).message_id;
    const grid = buttonFor(sent, /^Grid$/);
    const base = () => tap(grid, messageId);
    const bad: any[] = [];
    let u = base(); u.callback_query.message.chat.id = String(OWNER) as any; bad.push(u);
    u = base(); u.callback_query.from.id = String(OWNER) as any; bad.push(u);
    u = base(); u.callback_query.from.id = OWNER + 0.5 as any; bad.push(u);
    u = base(); delete (u.callback_query as any).from; bad.push(u);
    u = base(); (u.callback_query.message.chat as any).id = -1000000000000 - OWNER; bad.push(u);
    u = base(); u.callback_query.message.message_id = messageId + 1; bad.push(u);
    u = base(); (u.callback_query.message as any).chat = { id: OWNER, type: 'private' }; (u.callback_query as any).from = { id: 1, is_bot: true }; bad.push(u);
    s.telegram.push(bad);
    await until(() => bad.every((b) => s.telegram.of('answerCallbackQuery').some((c) => c.body.callback_query_id === b.callback_query.id)), 'all acks', 5000);
    assert.deepEqual(s.service.answers, []);
    assert.deepEqual(s.telegram.of('editMessageText'), []);
    // The real owner tap still answers afterwards: the bad taps did not spend the token.
    s.telegram.push([base()]);
    await until(() => s.service.answers.length === 1, 'the real answer');
    assert.deepEqual(s.service.answers, [{ id: 'v1', choices: [[0]], source: 'telegram' }]);
  } finally {
    await s.done();
  }
});

test('V2 (risk 2): question text with HTML, Markdown, control and bidi characters goes out literally, without parse_mode, in the message, buttons, confirmation and final edit', async () => {
  const s = await setup();
  try {
    const nasty = '<b>bold</b> *star* _under_ [link](http://evil.example) `code`';
    const control = 'line1\nline2\r\n\u202Ereversed\u0000nul\ttab';
    s.service.hold(heldQuestion('v2', {
      sensitive: '<i>secret</i> &amp; </pre>',
      reason: `why ${nasty}`,
      workspaceName: '<script>alert(1)</script>',
      items: [{ question: `Q ${nasty} ${control}`, header: '<h1>', options: [{ label: `${nasty} ${control}`, description: `D ${nasty}` }, { label: 'Plain', description: '' }], multiSelect: false }],
    }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const text: string = sent.body.text;
    assert.equal('parse_mode' in sent.body, false, 'plain text: no parse mode');
    assert.ok(text.includes('<b>bold</b> *star* _under_ [link](http://evil.example) `code`'), text);
    assert.ok(text.includes('<script>alert(1)</script>'));
    assert.ok(text.includes('⚠ sensible: <i>secret</i> &amp; </pre>'));
    assert.ok(!/[\u0000-\u0008\u000B-\u001F\u202E\t\r]/.test(text), 'control and format characters are flattened');
    assert.ok(text.includes('line1 line2 reversed nul tab'), text);
    const buttons = buttonsOf(sent);
    assert.ok(buttons[0].text.startsWith('<b>bold</b> *star*'), buttons[0].text);
    assert.ok(!/[\n\r\t\u202E]/.test(buttons[0].text));
    for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64 && /^[A-Za-z0-9_-]{16}$/.test(b.callback_data), b.callback_data);
    const messageId = messageIdOf(sent);
    s.telegram.push([tap(buttons[0].callback_data, messageId)]);
    const confirm = await until(() => s.telegram.of('editMessageText')[0], 'the confirmation');
    assert.equal('parse_mode' in confirm.body, false);
    assert.ok(confirm.body.text.includes('Vas a responder: «<b>bold</b>'), confirm.body.text);
    const confirmButton = buttonsOf(confirm).find((b) => b.text.startsWith('Confirmar'))!;
    assert.ok(Buffer.byteLength(confirmButton.callback_data) <= 64);
    s.telegram.push([tap(confirmButton.callback_data, messageId)]);
    await until(() => s.service.answers.length === 1, 'the answer');
    const final = await until(() => s.telegram.of('editMessageText')[1], 'the final edit');
    assert.equal('parse_mode' in final.body, false);
    assert.ok(final.body.text.includes('Respondida desde Telegram: «<b>bold</b>'), final.body.text);
    assert.equal(final.body.reply_markup, undefined);
  } finally {
    await s.done();
  }
});
const messageIdOf = (call: Call) => (call.result as { message_id: number }).message_id;

test('V3 (S3, S4): a sensitive answer goes once: the pick alone, a replayed pick, a stale «Confirmar» after «Volver» and a replayed «Confirmar» never answer again', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('v3', { sensitive: 'touches production' }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    const messageId = messageIdOf(sent);
    const grid = buttonFor(sent, /^Grid$/);
    s.telegram.push([tap(grid, messageId)]);
    const confirm1 = await until(() => s.telegram.of('editMessageText')[0], 'confirm view');
    const staleConfirm = buttonFor(confirm1, /^Confirmar/);
    s.telegram.push([tap(grid, messageId)]); // replayed pick: token spent by the redraw
    await settle();
    assert.equal(s.telegram.of('editMessageText').length, 1, 'a replayed pick redraws nothing');
    s.telegram.push([tap(buttonFor(confirm1, /^Volver$/), messageId)]);
    const back = await until(() => s.telegram.of('editMessageText')[1], 'back view');
    assert.deepEqual(buttonsOf(back).map((b) => b.text), ['Grid', 'List']);
    s.telegram.push([tap(staleConfirm, messageId)]); // stale Confirmar
    await settle();
    assert.deepEqual(s.service.answers, [], 'a stale Confirmar answers nothing');
    s.telegram.push([tap(buttonFor(back, /^List$/), messageId)]);
    const confirm2 = await until(() => s.telegram.of('editMessageText')[2], 'confirm view 2');
    const liveConfirm = buttonFor(confirm2, /^Confirmar «List»$/);
    s.telegram.push([tap(liveConfirm, messageId), tap(liveConfirm, messageId), tap(staleConfirm, messageId)]);
    await until(() => s.service.answers.length >= 1, 'the answer');
    await settle();
    assert.deepEqual(s.service.answers, [{ id: 'v3', choices: [[1]], source: 'telegram' }], 'exactly one answer');
    assert.equal(s.telegram.of('editMessageText').length, 4, 'one final edit');
  } finally {
    await s.done();
  }
});

test('V4 (S1): five held questions, answered 3rd then 1st in one batch; a token of one question on another message, and a second tap on an answered one, change nothing', async () => {
  const s = await setup();
  try {
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5'];
    for (const id of ids) s.service.hold(heldQuestion(id));
    await until(() => s.telegram.of('sendMessage').length === 5, 'five messages');
    const msgs = s.telegram.of('sendMessage');
    const by = (id: string) => msgs.find((c) => String(c.body.text).includes(`report ${id} use`))!;
    const mid = (id: string) => messageIdOf(by(id));
    s.telegram.push([
      tap(buttonFor(by('f3'), /^Grid$/), mid('f3')),
      tap(buttonFor(by('f1'), /^List$/), mid('f1')),
      tap(buttonFor(by('f3'), /^List$/), mid('f3')), // second tap on the 3rd: already answered
      tap(buttonFor(by('f2'), /^Grid$/), mid('f3')), // f2's token on f3's message
      tap(buttonFor(by('f5'), /^Grid$/), mid('f2')), // f5's token on f2's message
    ]);
    await until(() => s.service.answers.length === 2, 'two answers');
    await settle();
    assert.deepEqual(s.service.answers, [{ id: 'f3', choices: [[0]], source: 'telegram' }, { id: 'f1', choices: [[1]], source: 'telegram' }]);
    assert.deepEqual(s.service.heldQuestions().map((q) => q.id), ['f2', 'f4', 'f5']);
    const edits = s.telegram.of('editMessageText');
    assert.deepEqual(edits.map((e) => e.body.message_id).sort(), [mid('f1'), mid('f3')].sort(), 'only the two answered messages are edited');
    assert.match(edits.find((e) => e.body.message_id === mid('f3'))!.body.text, /report f3 use[\s\S]*Respondida desde Telegram: «Grid»/);
    assert.match(edits.find((e) => e.body.message_id === mid('f1'))!.body.text, /report f1 use[\s\S]*Respondida desde Telegram: «List»/);
    // f2 and f5 still answer with their own buttons on their own messages.
    s.telegram.push([tap(buttonFor(by('f2'), /^Grid$/), mid('f2')), tap(buttonFor(by('f5'), /^Grid$/), mid('f5'))]);
    await until(() => s.service.answers.length === 4, 'four answers');
    assert.deepEqual(s.service.answers.slice(2).map((a) => a.id), ['f2', 'f5']);
  } finally {
    await s.done();
  }
});

test('V5 (risk 2): an unreachable API and a 401 do not spin: exponential waits, one log line per run, no secret in any line', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mirador-verifier-v5-'));
  const store = new TelegramStore(join(scratch, 'telegram.json'));
  await store.write({ botToken: TOKEN, chatId: String(OWNER) });
  const service = fakeService();
  const logged: string[] = [];
  let attempts = 0;
  const counting = (async (url: string | URL | Request, init?: RequestInit) => { attempts++; return globalThis.fetch(url, init); }) as typeof fetch;
  const dead = startTelegramAnswers({ service, store, apiBase: 'http://127.0.0.1:1', fetch: counting, pollTimeoutS: 1, retryMs: 20, log: (l) => logged.push(l) });
  await dead.refresh();
  await new Promise((r) => setTimeout(r, 700));
  await dead.close();
  assert.ok(attempts >= 3 && attempts <= 8, `bounded retries in 700 ms (${attempts})`);
  assert.equal(logged.length, 1, JSON.stringify(logged));
  assert.match(logged[0], /could not read updates: Telegram could not be reached \((ECONNREFUSED|TypeError)\)/);
  for (const line of logged) assert.ok(!line.includes(SECRET) && !line.includes('127.0.0.1:1/bot'), line);

  const s = await setup();
  try {
    s.telegram.failWith((method) => (method === 'getUpdates' ? { status: 401, json: { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` } } : undefined));
    await new Promise((r) => setTimeout(r, 700));
    const polls = s.telegram.of('getUpdates').length;
    assert.ok(polls >= 3 && polls <= 8, `bounded polls under 401 (${polls})`);
    assert.equal(s.logged.length, 1, JSON.stringify(s.logged));
    assert.match(s.logged[0], /401: Unauthorized \[token\]/);
  } finally {
    await s.done();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('V6 (risk 2): boundary data sizes: a 64-byte unknown token and a 65-byte one are acknowledged only; a huge question is cut to one Telegram message and still answers', async () => {
  const s = await setup();
  try {
    s.service.hold(heldQuestion('v6', { items: [{ question: 'Q'.repeat(5000), header: 'H'.repeat(100), options: Array.from({ length: 30 }, (_, i) => ({ label: `Opt ${i} ${'x'.repeat(200)}`, description: 'd'.repeat(500) })), multiSelect: false }] }));
    const sent = await until(() => s.telegram.of('sendMessage')[0], 'the message');
    assert.ok(Array.from(sent.body.text).length <= 4096, `message within Telegram's limit (${Array.from(sent.body.text).length})`);
    assert.equal(buttonsOf(sent).length, 30);
    for (const b of buttonsOf(sent)) assert.ok(Array.from(b.text).length <= 60 && Buffer.byteLength(b.callback_data) <= 64);
    const messageId = messageIdOf(sent);
    const u64 = tap('a'.repeat(64), messageId);
    const u65 = tap('a'.repeat(65), messageId);
    const uEmpty = tap('', messageId);
    s.telegram.push([u64, u65, uEmpty]);
    await until(() => [u64, u65, uEmpty].every((u) => s.telegram.of('answerCallbackQuery').some((c) => c.body.callback_query_id === u.callback_query.id)), 'acks');
    assert.deepEqual(s.service.answers, []);
    s.telegram.push([tap(buttonsOf(sent)[29].callback_data, messageId)]);
    await until(() => s.service.answers.length === 1, 'the answer');
    assert.deepEqual(s.service.answers[0].choices, [[29]]);
  } finally {
    await s.done();
  }
});

test('V7 (exploratory): two overlapping refresh() calls do not leave an orphan poller after answering is turned off', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mirador-verifier-v7-'));
  const store = new TelegramStore(join(scratch, 'telegram.json'));
  await store.write({ botToken: TOKEN, chatId: String(OWNER) });
  const telegram = await fakeTelegram();
  const service = fakeService();
  const answers = startTelegramAnswers({ service, store, apiBase: telegram.base, pollTimeoutS: 1, retryMs: 20, log: () => {} });
  try {
    await Promise.all([answers.refresh(), answers.refresh()]);
    await until(() => telegram.of('getUpdates').length >= 2, 'polling');
    await store.setAnswers(false);
    await answers.refresh();
    await settle();
    const after = telegram.of('getUpdates').length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(telegram.of('getUpdates').length, after, 'no poller survives turning answering off');
    assert.deepEqual(service.holding.at(-1), false);
  } finally {
    await answers.close();
    await telegram.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
