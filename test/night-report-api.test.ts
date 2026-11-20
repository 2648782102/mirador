// Night report API. In-process: the route module over a temp state folder, a
// fake judge run, a fake Telegram fetch, a fake writable Engram and recording notification
// channels. Integration: the real server's auth and answer shapes (no model, no network).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../src/http/context.ts';
import { HttpError, sendJson } from '../src/http/respond.ts';
import { Router } from '../src/http/router.ts';
import { createNightReportRoutes } from '../src/http/routes/night-report.ts';
import { EngramClient } from '../src/memory/engram.ts';
import { NightLog, type NightRecord } from '../src/night/log.ts';
import type { Notice, NotifyChannel } from '../src/night/notify.ts';
import type { HeldQuestion, HeldQuestions } from '../src/night/telegram-answers.ts';
import { CallBudget } from '../src/night/budget.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQrr';

function record(id: string, extra: Partial<NightRecord> = {}): NightRecord {
  return {
    id,
    time: new Date().toISOString(),
    kind: 'question',
    terminalId: 't1',
    workspaceId: 'dev',
    rel: 'alpha',
    tool: 'ask_user_choice',
    question: { allowCustomResponse: false, items: [{ question: 'Which layout should the report use?', header: 'Layout', options: ['Grid', 'List'], multiSelect: false }] },
    policy: { allowed: true },
    decision: { action: 'answer', choices: [{ item: 0, index: 0, label: 'Grid' }], reason: 'The mission asks for cards.', confidence: 0.9 },
    followUp: null,
    sent: 'decided',
    delivered: null,
    outcome: 'decided',
    deferral: null,
    error: null,
    ...extra,
  };
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await Promise.resolve(check()).catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

describe('in-process', () => {
  let scratch: string;
  let base: string;
  let server: Server;
  let engramServer: Server;
  const engramWrites: Array<Record<string, unknown>> = [];
  const shutdown: Array<() => void | Promise<void>> = [];
  const desktop: NotifyChannel & { sent: Notice[] } = { name: 'desktop', sent: [], send: async (notice) => void desktop.sent.push(notice) };
  const telegramCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let telegramOk = true;
  let night = { active: false, since: null as string | null };
  const judgeInputs: string[] = [];
  let log: NightLog;
  let budget: CallBudget;

  before(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-report-')));
    engramServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/sessions') return res.end(JSON.stringify({ id: body.id, status: 'created' }));
      engramWrites.push(body);
      res.end(JSON.stringify({ id: engramWrites.length }));
    });
    await new Promise<void>((resolve) => engramServer.listen(0, '127.0.0.1', resolve));
    const engramAddress = engramServer.address();
    const engramUrl = `http://127.0.0.1:${typeof engramAddress === 'object' && engramAddress ? engramAddress.port : 0}`;

    const ctx = {
      config: { nightModel: undefined, notifications: undefined },
      workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/r', folders: [], expanded: [], mission: 'Ship the report.' } : undefined), list: () => [] },
      engram: new EngramClient(engramUrl),
      onShutdown: (fn: () => void | Promise<void>) => void shutdown.push(fn),
    } as unknown as AppContext;
    const dir = join(scratch, 'state', 'night');
    log = new NightLog(dir);
    budget = new CallBudget({ file: join(dir, 'budget.json'), limits: () => ({ night: 2, improveDay: 5 }) });
    const routes = await createNightReportRoutes({
      dir,
      telegramFile: join(scratch, 'state', 'telegram.json'),
      engramDirectory: join(scratch, 'state', 'engram', 'mirador-night'),
      judgeRun: async (prompt) => {
        judgeInputs.push(prompt.user);
        return '{"verdict":"doubtful","note":"The mission does not mention layouts."}';
      },
      fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
        telegramCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return telegramOk ? new Response('{"ok":true}', { status: 200 }) : new Response(`{"ok":false,"description":"bot${TOKEN} blocked"}`, { status: 403 });
      }) as typeof fetch,
      channels: { desktop },
      nightStatus: async () => night,
      pollMs: 20,
      budget,
    })(ctx);
    const router = new Router();
    for (const route of routes) router.add(route);
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const found = router.match(req.method ?? 'GET', url.pathname);
        if (!found) throw new HttpError(404, 'not found');
        await found.route.handler({ req, res, url, params: found.params });
      } catch (error) {
        if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
        sendJson(res, 500, { error: String(error) });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    for (const fn of shutdown) await fn();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => engramServer.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  test('a decided move is judged and the report carries the verdict and the summary', async () => {
    await log.append(record('m1'));
    await log.append(record('p1', { decision: null, sent: 'pass', outcome: 'deferred', deferral: { rule: 'sensitive:secrets', reason: 'it mentions tokens' } }));
    const report = await waitFor(async () => {
      const value = (await (await api('GET', '/api/night/report')).json()) as { records: Array<NightRecord & { judgment?: unknown }>; summary: Record<string, unknown> };
      return value.records.find((r) => r.id === 'm1')?.judgment ? value : undefined;
    });
    assert.deepEqual(report.records.find((r) => r.id === 'm1')!.judgment, { verdict: 'doubtful', note: 'The mission does not mention layouts.' });
    assert.equal('judgment' in report.records.find((r) => r.id === 'p1')!, false, 'deferred records are not judged');
    assert.equal('feedback' in report.records.find((r) => r.id === 'm1')!, false);
    assert.equal(typeof report.summary.since, 'string');
    assert.deepEqual({ ...report.summary, since: undefined }, { since: undefined, decided: 1, followUps: 0, deferred: 1, doubtful: 1, wrong: 0, calls: { used: 0, limit: 2 } });
    assert.match(judgeInputs[0], /Ship the report\./, 'the judge reads the workspace mission');
    const judgments = join(scratch, 'state', 'night', 'judgments.jsonl');
    assert.equal((await stat(judgments)).mode & 0o777, 0o600);
  });

  test('a pending item is notified at once, in Spanish, without anything but place, summary and reason', async () => {
    const pending = await waitFor(() => desktop.sent.find((n) => n.kind === 'pending'));
    assert.equal(pending.title, 'Mirador: pendiente para ti');
    assert.match(pending.body, /Dev \/ alpha/);
    assert.match(pending.body, /it mentions tokens/);
  });

  test('GET /api/night/report validates since', async () => {
    assert.equal(((await (await api('GET', '/api/night/report?since=yesterday')).json()) as { code: string }).code, 'night_since');
    const future = (await (await api('GET', `/api/night/report?since=${Date.now() + 60_000}`)).json()) as { records: unknown[]; summary: { decided: number } };
    assert.deepEqual(future.records, []);
    assert.equal(future.summary.decided, 0);
  });

  test('POST /api/night/feedback stores the user’s verdict, saves it to Engram and shows it in the report', async () => {
    const response = await api('POST', '/api/night/feedback', { recordId: 'm1', verdict: 'wrong', note: 'Use the list layout for reports.' });
    assert.equal(response.status, 204, await response.text());
    const saved = engramWrites.at(-1)!;
    assert.equal(saved.project, 'mirador-night');
    assert.equal(saved.topic_key, 'night-feedback/dev/m1');
    assert.equal(saved.type, 'preference');
    const content = String(saved.content);
    assert.match(content, /wrong/i);
    assert.match(content, /Use the list layout for reports\./);
    // With no `ownerName` in the config the memory the decider reads back names nobody.
    assert.match(content, /^The user marked Mirador's night move wrong: Use the list layout for reports\./);
    assert.doesNotMatch(content, /mat[ií]as/i);
    assert.match(content, /Which layout should the report use\?/);
    assert.match(content, /Grid/);
    const report = (await (await api('GET', '/api/night/report')).json()) as { records: Array<{ id: string; feedback?: { verdict: string; note: string; time: string } }> };
    const feedback = report.records.find((r) => r.id === 'm1')!.feedback!;
    assert.equal(feedback.verdict, 'wrong');
    assert.equal(feedback.note, 'Use the list layout for reports.');
    assert.equal(typeof feedback.time, 'string');
  });

  test('feedback bodies are validated; an unknown record is 404 night_record', async () => {
    const code = async (body: unknown) => ((await (await api('POST', '/api/night/feedback', body)).json()) as { code: string }).code;
    assert.equal(await code({ recordId: 'nope', verdict: 'right' }), 'night_record');
    for (const body of [{}, { recordId: 'm1' }, { recordId: 'm1', verdict: 'ok' }, { recordId: 'm1', verdict: 'right', note: 'x'.repeat(501) }, { recordId: 'm1', verdict: 'right', extra: 1 }, { recordId: 5, verdict: 'right' }]) {
      assert.equal(await code(body), 'night_feedback_invalid', JSON.stringify(body).slice(0, 60));
    }
    const before = engramWrites.length;
    await code({ recordId: 'm1', verdict: 'ok' });
    assert.equal(engramWrites.length, before, 'nothing saved for a rejected body');
  });

  test('Telegram: GET masked status, PUT validates and sends a test message before storing, test and DELETE', async () => {
    assert.deepEqual(await (await api('GET', '/api/night/telegram')).json(), { configured: false, chatIdMasked: null });
    const invalid = await api('PUT', '/api/night/telegram', { botToken: 'nope', chatId: 1 });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code: string }).code, 'telegram_invalid');
    assert.equal(telegramCalls.length, 0, 'nothing is sent for invalid credentials');

    telegramOk = false;
    const failed = await api('PUT', '/api/night/telegram', { botToken: TOKEN, chatId: '-1001234567890' });
    assert.equal(failed.status, 502);
    const failedText = await failed.text();
    assert.equal(JSON.parse(failedText).code, 'telegram_failed');
    assert.ok(!failedText.includes(TOKEN.split(':')[1]), 'the token never comes back');
    assert.deepEqual(await (await api('GET', '/api/night/telegram')).json(), { configured: false, chatIdMasked: null }, 'stored only on success');

    telegramOk = true;
    const stored = await api('PUT', '/api/night/telegram', { botToken: TOKEN, chatId: '-1001234567890' });
    assert.equal(stored.status, 204);
    assert.equal(telegramCalls.at(-1)!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.match(String(telegramCalls.at(-1)!.body.text), /Mirador/);
    const status = await (await api('GET', '/api/night/telegram')).text();
    assert.deepEqual(JSON.parse(status), { configured: true, chatIdMasked: '•••890' });
    assert.ok(!status.includes(TOKEN.split(':')[1]));
    const file = join(scratch, 'state', 'telegram.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    assert.equal((await api('POST', '/api/night/telegram/test')).status, 204);
    telegramOk = false;
    assert.equal((await api('POST', '/api/night/telegram/test')).status, 502);
    telegramOk = true;
    assert.equal((await api('DELETE', '/api/night/telegram')).status, 204);
    assert.deepEqual(await (await api('GET', '/api/night/telegram')).json(), { configured: false, chatIdMasked: null });
    assert.equal((await api('POST', '/api/night/telegram/test')).status, 502, 'not configured');
    for (const body of [{ botToken: TOKEN }, { botToken: TOKEN, chatId: 1, extra: 1 }]) {
      assert.equal((await api('PUT', '/api/night/telegram', body)).status, 400);
    }
  });

  test('when the night shift turns off, the morning summary goes out, and the report starts at the activation', async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    night = { active: true, since };
    await new Promise((resolve) => setTimeout(resolve, 80));
    const report = (await (await api('GET', '/api/night/report')).json()) as { summary: { since: string } };
    assert.equal(report.summary.since, since, 'the default since is the last activation');
    night = { active: false, since };
    const morning = await waitFor(() => desktop.sent.find((n) => n.kind === 'morning'));
    assert.equal(morning.title, 'Mirador: resumen del turno de noche');
    assert.match(morning.body, /Llamadas a Claude: \d+ de 2/);
    assert.equal(budget.night().since, since, 'the activation started a new nightly count');
    assert.match(morning.body, /Decididas: 1/);
    assert.match(morning.body, /Pendientes para ti: 1/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(desktop.sent.filter((n) => n.kind === 'morning').length, 1, 'once per night');
  });

  test('an exhausted nightly budget is notified once per night, with counts only', async () => {
    budget.startNight(new Date().toISOString());
    budget.take('decide');
    budget.take('decide');
    for (let i = 0; i < 4; i++) assert.equal(budget.take('judge'), false);
    const notice = await waitFor(() => desktop.sent.find((n) => n.kind === 'budget'));
    assert.equal(notice.title, 'Mirador: se alcanzó el tope de llamadas a Claude de esta noche');
    assert.match(notice.body, /2 de 2/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(desktop.sent.filter((n) => n.kind === 'budget').length, 1);
  });
});

describe('answering from Telegram', () => {
  let scratch: string;
  let base: string;
  let server: Server;
  let log: NightLog;
  const shutdown: Array<() => void | Promise<void>> = [];
  const desktop: NotifyChannel & { sent: Notice[] } = { name: 'desktop', sent: [], send: async (notice) => void desktop.sent.push(notice) };
  const telegramCalls: Array<{ method: string; body: Record<string, any> }> = [];
  const holding: boolean[] = [];
  const heldListeners: Array<(question: HeldQuestion) => void> = [];
  const held: HeldQuestions = {
    holdForAnswers: (enabled) => void holding.push(enabled),
    onHeld: (listener) => void heldListeners.push(listener),
    heldQuestions: () => [],
    answerHeld: () => ({ ok: false, code: 'unknown' }),
    onHeldEnd: () => undefined,
  };

  before(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-answers-')));
    const ctx = {
      config: { nightModel: undefined, notifications: undefined },
      workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/r', folders: [], expanded: [] } : undefined), list: () => [] },
      engram: new EngramClient('http://127.0.0.1:9'),
      onShutdown: (fn: () => void | Promise<void>) => void shutdown.push(fn),
    } as unknown as AppContext;
    const dir = join(scratch, 'state', 'night');
    log = new NightLog(dir);
    const routes = await createNightReportRoutes({
      dir,
      telegramFile: join(scratch, 'state', 'telegram.json'),
      engramDirectory: join(scratch, 'state', 'engram', 'mirador-night'),
      judgeRun: async () => '{"verdict":"ok","note":""}',
      fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
        const method = String(url).split('/').at(-1)!;
        telegramCalls.push({ method, body: JSON.parse(String(init.body)) });
        if (method === 'getUpdates') await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : { message_id: telegramCalls.length } }), { status: 200 });
      }) as typeof fetch,
      channels: { desktop },
      held,
      nightStatus: async () => ({ active: false, since: null }),
      pollMs: 60_000,
    })(ctx);
    const router = new Router();
    for (const route of routes) router.add(route);
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const found = router.match(req.method ?? 'GET', url.pathname);
        if (!found) throw new HttpError(404, 'not found');
        await found.route.handler({ req, res, url, params: found.params });
      } catch (error) {
        if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, code: error.code });
        sendJson(res, 500, { error: String(error) });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    for (const fn of shutdown) await fn();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  test('GET/PUT /api/night/telegram/answers: on by default for a private chat, saved, validated, and it drives holdForAnswers', async () => {
    assert.deepEqual(await (await api('GET', '/api/night/telegram/answers')).json(), { enabled: false, available: false, privateChat: false });
    const unconfigured = await api('PUT', '/api/night/telegram/answers', { enabled: true });
    assert.equal(unconfigured.status, 400);
    assert.equal(((await unconfigured.json()) as { code: string }).code, 'telegram_invalid');

    assert.equal((await api('PUT', '/api/night/telegram', { botToken: TOKEN, chatId: '4242' })).status, 204);
    await waitFor(() => (holding.at(-1) === true ? true : undefined));
    const view = await (await api('GET', '/api/night/telegram/answers')).text();
    assert.deepEqual(JSON.parse(view), { enabled: true, available: true, privateChat: true });
    assert.ok(!view.includes(TOKEN.split(':')[1]), 'the token never comes back');
    await waitFor(() => telegramCalls.find((call) => call.method === 'getUpdates'));

    for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }, { enabled: null }]) {
      const response = await api('PUT', '/api/night/telegram/answers', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(((await response.json()) as { code: string }).code, 'night_answers_invalid');
    }
    assert.equal(holding.at(-1), true, 'a rejected body changes nothing');

    assert.equal((await api('PUT', '/api/night/telegram/answers', { enabled: false })).status, 204);
    assert.equal(holding.at(-1), false);
    assert.deepEqual(await (await api('GET', '/api/night/telegram/answers')).json(), { enabled: false, available: true, privateChat: true });
    assert.equal((await api('PUT', '/api/night/telegram/answers', { enabled: true })).status, 204);
    assert.equal(holding.at(-1), true);
  });

  test('a held question goes to Telegram with its buttons, its plain notice stays on the desktop only, and removing the bot stops holding', async () => {
    const question: HeldQuestion = {
      id: 'h1', terminalId: 't1', workspaceId: 'dev', workspaceName: 'Dev', rel: 'alpha', tool: 'ask_user_choice',
      items: [{ question: 'Which layout should the report use?', header: 'Layout', options: [{ label: 'Grid', description: '' }, { label: 'List', description: '' }], multiSelect: false }],
      reason: 'needs the user', rule: 'decider', sensitive: null, since: new Date().toISOString(),
    };
    for (const listener of heldListeners) listener(question);
    const sent = await waitFor(() => telegramCalls.find((call) => call.method === 'sendMessage' && call.body.reply_markup));
    assert.match(sent.body.text, /Which layout should the report use\?/);
    await log.append(record('held1', { decision: null, sent: 'held', heldId: 'h1', outcome: 'deferred', deferral: { rule: 'decider', reason: 'needs the user' } } as Partial<NightRecord>));
    const pending = await waitFor(() => desktop.sent.find((n) => n.kind === 'pending'));
    assert.match(pending.body, /needs the user/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(telegramCalls.filter((call) => call.method === 'sendMessage' && String(call.body.text).startsWith('Mirador: pendiente')).length, 0, 'no plain notice on Telegram');

    assert.equal((await api('DELETE', '/api/night/telegram')).status, 204);
    assert.equal(holding.at(-1), false);
    assert.deepEqual(await (await api('GET', '/api/night/telegram/answers')).json(), { enabled: false, available: false, privateChat: false });
  });
});

describe('integration', () => {
  let scratch: string;
  let server: ChildProcess;
  let base: string;
  let token: string;

  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return typeof address === 'object' && address ? address.port : 0;
  }

  before(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-report-int-')));
    const root = join(scratch, 'root');
    await mkdir(join(root, 'alpha'), { recursive: true });
    await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
    await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9' }));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['src/server.ts'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        HOME: join(scratch, 'home'),
        GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
        XDG_RUNTIME_DIR: join(scratch, 'run'),
        XDG_CONFIG_HOME: join(scratch, 'cfg'),
        XDG_STATE_HOME: join(scratch, 'state'),
        MIRADOR_PORT: String(port),
        MIRADOR_SCOPES: '0',
      },
      stdio: 'ignore',
    });
    const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')), 10_000);
    const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
    const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    token = ((await session.json()) as { token: string }).token;
  });

  after(async () => {
    server?.kill('SIGTERM');
    await new Promise((resolve) => server?.once('exit', resolve));
    await rm(scratch, { recursive: true, force: true });
  });

  const routes: Array<[string, string]> = [
    ['GET', '/api/night/report'],
    ['POST', '/api/night/feedback'],
    ['GET', '/api/night/telegram'],
    ['PUT', '/api/night/telegram'],
    ['DELETE', '/api/night/telegram'],
    ['POST', '/api/night/telegram/test'],
    ['GET', '/api/night/telegram/answers'],
    ['PUT', '/api/night/telegram/answers'],
  ];

  test('every night report route needs the session token, and changes need the app origin', async () => {
    for (const [method, path] of routes) {
      assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base } })).status, 401, `${method} ${path}`);
      assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base, authorization: 'Bearer wrong' } })).status, 401, `${method} ${path}`);
    }
    for (const [method, path] of routes.filter(([method]) => method !== 'GET')) {
      const response = await fetch(`${base}${path}`, { method, headers: { origin: 'http://evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  });

  test('the real server answers the report, the Telegram status and rejects bad bodies without any network', async () => {
    const headers = { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const report = await fetch(`${base}/api/night/report`, { headers });
    assert.equal(report.status, 200);
    const body = (await report.json()) as { records: unknown[]; summary: Record<string, unknown> };
    assert.deepEqual(body.records, []);
    assert.deepEqual(Object.keys(body.summary).sort(), ['calls', 'decided', 'deferred', 'doubtful', 'followUps', 'since', 'wrong']);
    assert.deepEqual(body.summary.calls, { used: 0, limit: 150 });
    assert.deepEqual(await (await fetch(`${base}/api/night/telegram`, { headers })).json(), { configured: false, chatIdMasked: null });
    const put = await fetch(`${base}/api/night/telegram`, { method: 'PUT', headers, body: JSON.stringify({ botToken: 'x', chatId: 1 }) });
    assert.equal(put.status, 400);
    const feedback = await fetch(`${base}/api/night/feedback`, { method: 'POST', headers, body: JSON.stringify({ recordId: 'nope', verdict: 'right' }) });
    assert.equal(feedback.status, 404);
    assert.equal(((await feedback.json()) as { code: string }).code, 'night_record');
    assert.equal((await fetch(`${base}/api/night/telegram`, { method: 'DELETE', headers })).status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/night/telegram/answers`, { headers })).json(), { enabled: false, available: false, privateChat: false });
  });
});
