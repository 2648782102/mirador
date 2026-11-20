// Night notifications: what goes out, batched to one notification per channel
// per 10 minutes (fake clock), the morning summary always; short Spanish texts with only
// workspace, folder, question summary, action and reason; notify-send without a shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NightRecord } from '../src/night/log.ts';
import { TelegramStore, telegramChannel } from '../src/night/telegram.ts';
import {
  BATCH_WINDOW_MS,
  Notifier,
  budgetNotice,
  desktopChannel,
  enabledChannels,
  isPendingForUser,
  morningText,
  noticeItem,
  type Notice,
  type NotifyChannel,
} from '../src/night/notify.ts';

function record(id: string, extra: Partial<NightRecord> = {}): NightRecord {
  return {
    id,
    time: '2026-10-28T23:00:00.000Z',
    kind: 'question',
    terminalId: 'terminal-SECRET-ID',
    workspaceId: 'dev',
    rel: 'alpha',
    tool: 'ask_user_choice',
    question: { allowCustomResponse: false, items: [{ question: `Which layout should the report use? ${'x'.repeat(200)}`, header: 'Layout', options: ['Grid', 'List'], multiSelect: false }] },
    policy: { allowed: true },
    decision: null,
    followUp: { action: 'follow-up', message: 'FOLLOW-UP-BODY cat .env', reason: 'r', confidence: 0.9 },
    sent: 'pass',
    delivered: null,
    outcome: 'deferred',
    deferral: { rule: 'sensitive:secrets', reason: 'it mentions tokens' },
    error: 'INTERNAL-ERROR-TEXT',
    ...extra,
  };
}

const workspaces = { get: (id: string) => (id === 'dev' ? { name: 'Dev' } : undefined) };

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A channel that records what it was asked to send. */
function recorder(name = 'fake'): NotifyChannel & { sent: Notice[] } {
  const sent: Notice[] = [];
  return { name, sent, send: async (notice) => void sent.push(notice) };
}

/** A fake clock with timers that run when the clock passes them. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    async advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => !t.cancelled && t.at <= now)) {
        timer.cancelled = true;
        timer.fn();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test('pending for the user: deferred questions and sensitive, low-confidence or decider-deferred follow-ups', () => {
  assert.equal(isPendingForUser(record('a')), true);
  assert.equal(isPendingForUser(record('b', { deferral: { rule: 'low-confidence', reason: 'r' } })), true);
  assert.equal(isPendingForUser(record('c', { deferral: { rule: 'stopped', reason: 'off' } })), false, 'turned off: the user is awake');
  assert.equal(isPendingForUser(record('d', { outcome: 'decided', deferral: null })), false);
  const delegate = (rule: string) => record('e', { kind: 'delegate', question: null, deferral: { rule, reason: 'r' } });
  assert.equal(isPendingForUser(delegate('sensitive:destructive')), true);
  assert.equal(isPendingForUser(delegate('low-confidence')), true);
  assert.equal(isPendingForUser(delegate('decider')), true);
  assert.equal(isPendingForUser(delegate('not-finished')), false);
  const auto = (rule: string) => record('g', { kind: 'auto-follow-up', question: null, deferral: { rule, reason: 'r' } });
  assert.equal(isPendingForUser(auto('sensitive:production')), true, 'automatic follow-ups (S10) count like delegations');
  assert.equal(isPendingForUser(auto('auto-cap')), true);
  assert.equal(isPendingForUser(auto('busy')), false);
});

test('a notice holds only workspace, folder, question summary (≤120 chars), action and reason', () => {
  const item = noticeItem(record('a'), workspaces);
  assert.deepEqual(Object.keys(item).sort(), ['action', 'place', 'reason', 'summary']);
  assert.equal(item.place, 'Dev / alpha');
  assert.ok(Array.from(item.summary).length <= 120);
  assert.match(item.summary, /^Which layout should the report use\?/);
  assert.equal(item.reason, 'it mentions tokens');
  assert.equal(noticeItem(record('b', { kind: 'delegate', question: null, workspaceId: 'gone', rel: '' }), workspaces).place, 'gone');
  assert.equal(noticeItem(record('c', { kind: 'auto-follow-up', question: null }), workspaces).summary, 'Seguimiento automático de un agente que terminó');
});

test('the first pending item goes out at once; more within 10 minutes become one aggregated notification', async () => {
  const clock = fakeClock();
  const desktop = recorder('desktop');
  const phone = recorder('telegram');
  const notifier = new Notifier({ channels: [desktop, phone], now: clock.now, setTimer: clock.setTimer });
  notifier.pending(noticeItem(record('a'), workspaces));
  await clock.advance(0);
  assert.equal(desktop.sent.length, 1);
  assert.equal(phone.sent.length, 1);
  assert.equal(desktop.sent[0].title, 'Mirador: pendiente para ti');
  assert.match(desktop.sent[0].body, /Dev \/ alpha/);
  assert.match(desktop.sent[0].body, /Motivo: it mentions tokens/);

  for (const id of ['b', 'c', 'd', 'e']) notifier.pending(noticeItem(record(id), workspaces));
  notifier.judgment(noticeItem(record('f', { outcome: 'decided' }), workspaces), 'doubtful', 'Not covered by the mission.');
  await clock.advance(5 * 60_000);
  assert.equal(desktop.sent.length, 1, 'nothing more inside the window');
  await clock.advance(5 * 60_000);
  assert.equal(desktop.sent.length, 2, 'one aggregated notification at the end of the window');
  assert.equal(phone.sent.length, 2);
  const batch = desktop.sent[1];
  assert.equal(batch.title, 'Mirador: 4 pendientes, 1 dudosa');
  assert.equal(batch.body.split('\n').filter((line) => line.startsWith('• ')).length, 3, 'the first 3 summaries');
  assert.match(batch.body, /y 2 más/);
  await clock.advance(60 * 60_000);
  assert.equal(desktop.sent.length, 2, 'nothing left to send');
  notifier.close();
});

test('judge verdicts doubtful or wrong are notified with the note as the reason', async () => {
  const clock = fakeClock();
  const channel = recorder();
  const notifier = new Notifier({ channels: [channel], now: clock.now, setTimer: clock.setTimer });
  notifier.judgment(noticeItem(record('a', { outcome: 'decided' }), workspaces), 'wrong', 'It chose to push.');
  await clock.advance(0);
  assert.equal(channel.sent[0].title, 'Mirador: el juez marcó una decisión como incorrecta');
  assert.equal(channel.sent[0].urgency, 'critical');
  assert.match(channel.sent[0].body, /Juez: It chose to push\./);
  notifier.close();
});

test('the morning summary always goes out, even inside a batching window', async () => {
  const clock = fakeClock();
  const channel = recorder();
  const notifier = new Notifier({ channels: [channel], now: clock.now, setTimer: clock.setTimer });
  notifier.pending(noticeItem(record('a'), workspaces));
  await clock.advance(0);
  const text = morningText(
    { since: '2026-10-28T22:00:00.000Z', decided: 4, followUps: 2, deferred: 2, doubtful: 1, wrong: 0 },
    [noticeItem(record('p1'), workspaces), noticeItem(record('p2', { deferral: { rule: 'low-confidence', reason: 'confidence 0.5 is below 0.7' } }), workspaces)],
  );
  notifier.morning(text);
  await clock.advance(0);
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[1].title, 'Mirador: resumen del turno de noche');
  assert.match(channel.sent[1].body, /Decididas: 4 · Seguimientos: 2 · Pendientes para ti: 2 · Dudosas: 1 · Incorrectas: 0/);
  assert.match(channel.sent[1].body, /confidence 0\.5 is below 0\.7/);
  notifier.close();
});

test('texts never hold terminal ids, follow-up messages, errors, tokens or long secrets', async () => {
  const clock = fakeClock();
  const channel = recorder();
  const notifier = new Notifier({ channels: [channel], now: clock.now, setTimer: clock.setTimer });
  const token = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';
  const leaky = record('a', { deferral: { rule: 'sensitive:secrets', reason: `use ${token} now` } });
  notifier.pending(noticeItem(leaky, workspaces));
  notifier.morning(morningText({ since: 's', decided: 0, followUps: 0, deferred: 1, doubtful: 0, wrong: 0 }, [noticeItem(leaky, workspaces)]));
  await clock.advance(0);
  for (const notice of channel.sent) {
    const text = `${notice.title}\n${notice.body}`;
    for (const forbidden of ['terminal-SECRET-ID', 'FOLLOW-UP-BODY', 'INTERNAL-ERROR-TEXT', token, 'AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ']) {
      assert.ok(!text.includes(forbidden), `${forbidden} in ${text}`);
    }
  }
  notifier.close();
});

test('a failing channel never stops the others', async () => {
  const clock = fakeClock();
  const good = recorder();
  const bad: NotifyChannel = { name: 'bad', send: async () => Promise.reject(new Error('down')) };
  const notifier = new Notifier({ channels: [bad, good], now: clock.now, setTimer: clock.setTimer, log: () => undefined });
  notifier.morning('hola');
  await clock.advance(0);
  assert.equal(good.sent.length, 1);
  notifier.close();
});

test('desktop: notify-send through execFile with an args array, app name and urgency; skipped when missing', async () => {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const runtime = '/run/user/1000';
  const channel = desktopChannel({
    env: { PATH: '/usr/bin', HOME: '/home/u', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, SECRET_TOKEN: 'leak' },
    exists: () => true,
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options: options as Record<string, unknown> });
      callback(null);
    },
  });
  await channel.send({ kind: 'judgment', urgency: 'critical', title: '-t title', body: '$(rm -rf ~) body' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'notify-send');
  assert.deepEqual(calls[0].args, ['--app-name=Mirador', '--urgency=critical', '--', '-t title', '$(rm -rf ~) body']);
  assert.notEqual(calls[0].options.shell, true);
  const env = calls[0].options.env as Record<string, string>;
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${runtime}/bus`);
  assert.equal(env.SECRET_TOKEN, undefined, 'only what notify-send needs');

  let missingCalls = 0;
  const missing = desktopChannel({
    env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: runtime },
    exists: () => true,
    execFile: (_file, _args, _options, callback) => {
      missingCalls++;
      callback(Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' }));
    },
  });
  await missing.send({ kind: 'pending', urgency: 'normal', title: 't', body: 'b' });
  await missing.send({ kind: 'pending', urgency: 'normal', title: 't', body: 'b' });
  assert.equal(missingCalls, 1, 'after ENOENT the channel stays quiet');

  let noBusCalls = 0;
  const noBus = desktopChannel({ env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/tmp/elsewhere', DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` }, exists: () => false, execFile: () => void noBusCalls++ });
  await noBus.send({ kind: 'pending', urgency: 'normal', title: 't', body: 'b' });
  assert.equal(noBusCalls, 0, 'no session bus in this runtime folder: nothing to notify');
});

test('enabledChannels follows config notifications (default on)', () => {
  const desktop = recorder('desktop');
  const telegram = recorder('telegram');
  assert.deepEqual(enabledChannels(undefined, { desktop, telegram }).map((c) => c.name), ['desktop', 'telegram']);
  assert.deepEqual(enabledChannels({ desktop: false }, { desktop, telegram }).map((c) => c.name), ['telegram']);
  assert.deepEqual(enabledChannels({ telegram: false, desktop: true }, { desktop, telegram }).map((c) => c.name), ['desktop']);
  assert.deepEqual(enabledChannels({ desktop: 'no' as unknown as boolean }, { desktop, telegram }).map((c) => c.name), ['desktop', 'telegram'], 'only an explicit false turns one off');
});

test('an agent swept at activation whose final message was unknown is pending for the user', () => {
  assert.equal(isPendingForUser(record('sweep', { kind: 'auto-follow-up', outcome: 'deferred', deferral: { rule: 'no-final-message', reason: 'final text unknown' } } as never)), true);
});

test('the bedtime reminder goes out at once, even inside a batching window', async () => {
  const clock = fakeClock();
  const channel = recorder();
  const notifier = new Notifier({ channels: [channel], now: clock.now, setTimer: clock.setTimer });
  notifier.pending(noticeItem(record('first'), workspaces));
  await clock.advance(0);
  notifier.reminder({ title: 'Mirador: el turno de noche empieza pronto', body: 'Empieza a las 23:30 y termina a las 07:30.' });
  await clock.advance(0);
  const reminder = channel.sent.find((n) => n.kind === 'reminder');
  assert.ok(reminder, 'sent without waiting for the window');
  assert.equal(reminder.title, 'Mirador: el turno de noche empieza pronto');
  assert.equal(reminder.urgency, 'normal');
  notifier.close();
});

test('the morning summary adds the Claude calls used against the nightly budget when known', () => {
  const base = { since: '2026-10-28T22:00:00.000Z', decided: 1, followUps: 0, deferred: 0, doubtful: 0, wrong: 0 };
  assert.match(morningText({ ...base, calls: { used: 37, limit: 150 } }, []), /^Decididas: 1 .*\nLlamadas a Claude: 37 de 150\n/);
  assert.doesNotMatch(morningText(base, []), /Llamadas/);
});

test('a budget notice goes out at once, with counts only, and a deferral by budget is pending for the user', async () => {
  const clock = fakeClock();
  const channel = recorder();
  const notifier = new Notifier({ channels: [channel], now: clock.now, setTimer: clock.setTimer });
  notifier.pending(noticeItem(record('first'), workspaces));
  await clock.advance(0);
  notifier.budget(budgetNotice({ scope: 'night', used: 60, limit: 60 }));
  notifier.budget(budgetNotice({ scope: 'improve', used: 100, limit: 100 }));
  await clock.advance(0);
  const notices = channel.sent.filter((n) => n.kind === 'budget');
  assert.deepEqual(notices.map((n) => n.title), ['Mirador: se alcanzó el tope de llamadas a Claude de esta noche', 'Mirador: se alcanzó el tope de mejoras con IA de hoy']);
  assert.match(notices[0].body, /60 de 60/);
  assert.match(notices[1].body, /100 de 100/);
  assert.equal(notices[0].urgency, 'normal');
  assert.equal(isPendingForUser(record('b', { kind: 'auto-follow-up', deferral: { rule: 'budget', reason: 'nightly Claude budget reached' } })), true);
  notifier.close();
});

test('S3: Telegram drops the judge and budget notices and the plain notice of a held question; the desktop keeps everything', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mirador-night-notify-'));
  try {
    const store = new TelegramStore(join(scratch, 'telegram.json'));
    await store.write({ botToken: '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr', chatId: '42' });
    const texts: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      texts.push(JSON.parse(String(init.body)).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const clock = fakeClock();
    const desktop = recorder('desktop');
    const notifier = new Notifier({ channels: [desktop, telegramChannel(store, { fetch })], now: clock.now, setTimer: clock.setTimer });
    const settle = async () => {
      await clock.advance(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    notifier.judgment(noticeItem(record('j', { outcome: 'decided' }), workspaces), 'wrong', 'It chose to push.');
    await settle();
    assert.equal(desktop.sent.length, 1, 'the desktop gets the verdict');
    assert.deepEqual(texts, [], 'Telegram does not');

    notifier.budget(budgetNotice({ scope: 'night', used: 60, limit: 60 }));
    await settle();
    assert.equal(desktop.sent.length, 2);
    assert.deepEqual(texts, [], 'no budget notice on Telegram');

    // Inside the window: a held question, a deferred follow-up and a doubtful verdict, aggregated.
    notifier.pending(noticeItem(record('h'), workspaces), { held: true });
    notifier.pending(noticeItem(record('f', { kind: 'delegate', question: null, deferral: { rule: 'decider', reason: 'needs the user' } }), workspaces));
    notifier.judgment(noticeItem(record('d', { outcome: 'decided' }), workspaces), 'doubtful', 'Not covered.');
    await clock.advance(BATCH_WINDOW_MS);
    // Telegram reads its store from disk first, which a loaded machine can stretch past a fixed settle.
    await until(() => texts.length >= 1);
    await settle();
    assert.equal(desktop.sent.at(-1)!.title, 'Mirador: 2 pendientes, 1 dudosa', 'the desktop batch is unchanged');
    assert.equal(texts.length, 1, 'Telegram gets only the follow-up');
    assert.equal(texts[0], 'Mirador: pendiente para ti\nDev / alpha\nSeguimiento de un agente que terminó\nMirador lo dejó pendiente. Motivo: needs the user', 'and in the single-item wording');

    notifier.morning('Decididas: 1');
    await until(() => texts.length >= 2); // both read the store concurrently, so their order is fixed only by waiting in between
    notifier.reminder({ title: 'Mirador: el turno de noche empieza pronto', body: 'Empieza a las 23:30.' });
    await until(() => texts.length >= 3);
    await settle();
    assert.deepEqual(texts.slice(1), ['Mirador: resumen del turno de noche\nDecididas: 1', 'Mirador: el turno de noche empieza pronto\nEmpieza a las 23:30.'], 'the summary and the reminder still go out');
    notifier.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a channel that accepts nothing in a batch gets nothing, and the window still starts for the others', async () => {
  const clock = fakeClock();
  const desktop = recorder('desktop');
  const phone: NotifyChannel & { sent: Notice[] } = { ...recorder('telegram'), accepts: (topic) => topic !== 'held' };
  phone.send = async (notice) => void phone.sent.push(notice);
  const notifier = new Notifier({ channels: [desktop, phone], now: clock.now, setTimer: clock.setTimer });
  notifier.pending(noticeItem(record('h'), workspaces), { held: true });
  await clock.advance(0);
  assert.equal(desktop.sent.length, 1);
  assert.equal(phone.sent.length, 0);
  notifier.close();
});
