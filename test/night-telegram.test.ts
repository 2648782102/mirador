// Telegram: the user's own bot. Credentials are validated, kept in a 0600 file, never
// returned, logged or put in an error; messages go out by POST with a fake fetch here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TelegramError,
  TelegramStore,
  callTelegram,
  maskChatId,
  parseCredentials,
  sendTelegram,
  telegramChannel,
  telegramPath,
} from '../src/night/telegram.ts';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-telegram-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

let counter = 0;
const fileFor = () => join(scratch, `t${++counter}`, 'telegram.json');

type FetchCall = { url: string; init: RequestInit };
function fakeFetch(answer: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const okAnswer = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('the credentials file lives in the state folder', () => {
  assert.equal(telegramPath({ XDG_STATE_HOME: '/s' }), '/s/mirador/telegram.json');
});

test('parseCredentials accepts a bot token and an integer or @channel chat id, and nothing else', () => {
  assert.deepEqual(parseCredentials({ botToken: TOKEN, chatId: 12345 }), { botToken: TOKEN, chatId: '12345' });
  assert.deepEqual(parseCredentials({ botToken: TOKEN, chatId: '-1001234567890' }), { botToken: TOKEN, chatId: '-1001234567890' });
  assert.deepEqual(parseCredentials({ botToken: TOKEN, chatId: '@mirador_night' }), { botToken: TOKEN, chatId: '@mirador_night' });
  const bad = [
    {},
    { botToken: TOKEN },
    { chatId: 1 },
    { botToken: 'abc', chatId: 1 },
    { botToken: '123:short', chatId: 1 },
    { botToken: `${TOKEN}\n`, chatId: 1 },
    { botToken: `${TOKEN}/../x`, chatId: 1 },
    { botToken: TOKEN, chatId: 1.5 },
    { botToken: TOKEN, chatId: 'me' },
    { botToken: TOKEN, chatId: '@a b' },
    { botToken: TOKEN, chatId: Number.MAX_SAFE_INTEGER + 10 },
    { botToken: TOKEN, chatId: 1, extra: true },
  ];
  for (const body of bad) {
    assert.throws(() => parseCredentials(body as Record<string, unknown>), (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, 'telegram_invalid');
      assert.ok(!error.message.includes(TOKEN.split(':')[1]), 'the token never appears in the error');
      return true;
    }, JSON.stringify(body));
  }
});

test('maskChatId shows only a hint', () => {
  assert.equal(maskChatId('-1001234567890'), '•••890');
  assert.equal(maskChatId('42'), '•••');
  assert.equal(maskChatId('@mirador_night'), '@mi•••');
});

test('the store writes a 0700 folder and a 0600 file, reads it back and reports only { configured, chatIdMasked }', async () => {
  const file = fileFor();
  const store = new TelegramStore(file);
  assert.deepEqual(await store.status(), { configured: false, chatIdMasked: null });
  assert.equal(await store.read(), null);
  await store.write({ botToken: TOKEN, chatId: '-1001234567890' });
  assert.equal((await stat(join(file, '..'))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(), { botToken: TOKEN, chatId: '-1001234567890' });
  const status = await store.status();
  assert.deepEqual(status, { configured: true, chatIdMasked: '•••890' });
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  await store.remove();
  assert.deepEqual(await store.status(), { configured: false, chatIdMasked: null });
  await store.remove();
});

test('a damaged or loosened file reads as not configured, and a loosened one is never trusted', async () => {
  const file = fileFor();
  const store = new TelegramStore(file);
  await store.write({ botToken: TOKEN, chatId: '1' });
  await writeFile(file, '{"botToken":"nope","chatId":"1"}', { mode: 0o600 });
  assert.equal(await store.read(), null);
  await store.write({ botToken: TOKEN, chatId: '1' });
  await chmod(file, 0o644);
  assert.equal(await store.read(), null, 'a file others can read is ignored');
});

test('sendTelegram POSTs JSON to sendMessage with a timeout and no parse mode', async () => {
  const { fetch, calls } = fakeFetch(okAnswer);
  await sendTelegram({ botToken: TOKEN, chatId: '42' }, 'Hola *mundo* <b>', { fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, { chat_id: '42', text: 'Hola *mundo* <b>', disable_web_page_preview: true });
  assert.equal(body.parse_mode, undefined);
});

test('send failures are TelegramError telegram_failed without the token', async () => {
  const failures: Array<() => Response | Promise<Response>> = [
    () => new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` }), { status: 401 }),
    () => new Response('not json', { status: 200 }),
    () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    () => Promise.reject(Object.assign(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`), { cause: { code: 'ENOTFOUND' } })),
  ];
  for (const answer of failures) {
    const { fetch } = fakeFetch(answer);
    await assert.rejects(sendTelegram({ botToken: TOKEN, chatId: '42' }, 'x', { fetch }), (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, 'telegram_failed');
      assert.ok(!error.message.includes(TOKEN) && !error.message.includes(TOKEN.split(':')[1]), error.message);
      return true;
    });
  }
});

test('a long text is cut to Telegram’s limit', async () => {
  const { fetch, calls } = fakeFetch(okAnswer);
  await sendTelegram({ botToken: TOKEN, chatId: '42' }, 'a'.repeat(5000), { fetch });
  assert.ok(JSON.parse(String(calls[0].init.body)).text.length <= 4096);
});

test('the Telegram channel sends title and body when configured, skips otherwise, and logs failures without the token', async () => {
  const file = fileFor();
  const store = new TelegramStore(file);
  const logged: string[] = [];
  const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: false, description: `bad bot${TOKEN}` }), { status: 400 }));
  const channel = telegramChannel(store, { fetch, log: (line) => logged.push(line) });
  await channel.send({ kind: 'pending', urgency: 'normal', title: 'Mirador: pendiente para ti', body: 'Dev / alpha' });
  assert.equal(calls.length, 0, 'not configured: nothing is sent');
  await store.write({ botToken: TOKEN, chatId: '42' });
  await channel.send({ kind: 'pending', urgency: 'normal', title: 'Mirador: pendiente para ti', body: 'Dev / alpha' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(calls[0].init.body)).text, 'Mirador: pendiente para ti\nDev / alpha');
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(TOKEN.split(':')[1]), logged[0]);
  assert.ok(!(await readFile(file, 'utf8')).includes('pendiente'), 'the file holds only the credentials');
});

test('the store keeps the "answer from Telegram" setting next to the credentials: on by default, saved 0600, kept by a new token', async () => {
  const file = fileFor();
  const store = new TelegramStore(file);
  assert.equal(await store.answers(), null, 'not configured: no setting');
  await store.write({ botToken: TOKEN, chatId: '42' });
  assert.equal(await store.answers(), true, 'on by default once a bot is configured');
  await store.setAnswers(false);
  assert.equal(await store.answers(), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(), { botToken: TOKEN, chatId: '42' }, 'the credentials stay as they were');
  assert.deepEqual(await store.status(), { configured: true, chatIdMasked: '•••' }, 'status keeps its shape');
  await store.write({ botToken: TOKEN, chatId: '43' });
  assert.equal(await store.answers(), false, 'a new token or chat keeps the choice');
  await store.remove();
  await assert.rejects(store.setAnswers(true), (error: unknown) => error instanceof TelegramError && error.code === 'telegram_invalid');
});

test('callTelegram POSTs a method to the injected API base and reports the status of a refusal, never the token', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: true, result: [{ update_id: 1 }] }), { status: 200 }));
  const result = await callTelegram({ botToken: TOKEN, chatId: '42' }, 'getUpdates', { offset: 3 }, { fetch, apiBase: 'http://127.0.0.1:9' });
  assert.deepEqual(result, [{ update_id: 1 }]);
  assert.equal(calls[0].url, `http://127.0.0.1:9/bot${TOKEN}/getUpdates`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { offset: 3 });
  const conflict = fakeFetch(() => new Response(JSON.stringify({ ok: false, error_code: 409, description: `Conflict: terminated by other getUpdates request bot${TOKEN}` }), { status: 409 }));
  await assert.rejects(callTelegram({ botToken: TOKEN, chatId: '42' }, 'getUpdates', {}, { fetch: conflict.fetch }), (error: unknown) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.code, 'telegram_failed');
    assert.equal(error.status, 409);
    assert.ok(!error.message.includes(TOKEN.split(':')[1]), error.message);
    return true;
  });
  assert.equal(conflict.calls[0].url, `https://api.telegram.org/bot${TOKEN}/getUpdates`, 'the default base is Telegram over HTTPS');
});
