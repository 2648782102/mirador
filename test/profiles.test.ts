// Resource profiles: Ahorro, Equilibrado and Potencia change capacity only
// (call budgets, decider model, judge mode, concurrency, Engram cache, tracking refresh),
// never a safety rule. Stored in a private file, switched at runtime without a restart.
// In-process with fakes, plus the real server for auth and shapes (no model, no network).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROFILE,
  JUDGE_DOUBT_BELOW,
  PROFILES,
  PROFILE_NAMES,
  ProfileError,
  ResourceProfiles,
  effectiveValues,
  profilePath,
} from '../src/profiles.ts';
import { CallBudget, CallTelemetry } from '../src/night/budget.ts';
import { EngramClient } from '../src/memory/engram.ts';
import { PiGate, createPiRunner, piGate, type PiRuntime } from '../src/memory/translate.ts';
import { createDecider, isSensitiveText } from '../src/night/decider.ts';
import { createJudge, JudgmentStore } from '../src/night/judge.ts';
import { checkQuestion, findSensitive } from '../src/night/policy.ts';
import { MIN_CONFIDENCE, type NightQuestion } from '../src/night/protocol.ts';
import { MAX_AUTO_PER_NIGHT, MAX_AUTO_DEFERRALS } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { AppContext } from '../src/http/context.ts';
import { HttpError, sendJson } from '../src/http/respond.ts';
import { Router } from '../src/http/router.ts';
import { createProfileRoutes } from '../src/http/routes/profile.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-profiles-')));
});
after(() => rm(scratch, { recursive: true, force: true }));
let counter = 0;
const fileFor = (name: string) => join(scratch, `${name}-${++counter}`, 'profile.json');

describe('the three profiles', () => {
  test('carry the agreed values, Equilibrado by default', () => {
    assert.deepEqual(PROFILE_NAMES, ['ahorro', 'equilibrado', 'potencia']);
    assert.equal(DEFAULT_PROFILE, 'equilibrado');
    assert.deepEqual(PROFILES, {
      ahorro: { nightBudget: 60, improveBudget: 100, nightModel: 'claude-haiku-5-5', judgeMode: 'doubtful-only', maxConcurrent: 1, engramCacheMs: 60000, trackingRefreshMs: 30000 },
      equilibrado: { nightBudget: 150, improveBudget: 300, nightModel: 'claude-sonnet-5-5', judgeMode: 'every', maxConcurrent: 2, engramCacheMs: 20000, trackingRefreshMs: 15000 },
      potencia: { nightBudget: 400, improveBudget: 1000, nightModel: 'claude-opus-5-5', judgeMode: 'every', maxConcurrent: 4, engramCacheMs: 10000, trackingRefreshMs: 10000 },
    });
    assert.ok(Object.isFrozen(PROFILES) && Object.isFrozen(PROFILES.ahorro));
    assert.equal(JUDGE_DOUBT_BELOW, 0.85);
  });

  test('explicit config keys override the profile and are marked; invalid ones are ignored; the env Engram TTL wins', () => {
    const { values, overridden } = effectiveValues('ahorro', { nightModel: 'claude-sonnet-5-5', maxConcurrent: 3, engramCacheMs: 5000, nightBudget: 90 }, {});
    assert.deepEqual(values, { ...PROFILES.ahorro, nightModel: 'claude-sonnet-5-5', maxConcurrent: 3, engramCacheMs: 5000, nightBudget: 90 });
    assert.deepEqual(overridden, ['nightModel', 'maxConcurrent', 'engramCacheMs', 'nightBudget']);
    const bad = effectiveValues('potencia', { nightModel: 'gpt-4', maxConcurrent: 0, engramCacheMs: -1, nightBudget: 1.5 }, {});
    assert.deepEqual(bad, { values: PROFILES.potencia, overridden: [] });
    const env = effectiveValues('equilibrado', {}, { MIRADOR_ENGRAM_CACHE_MS: '0' });
    assert.equal(env.values.engramCacheMs, 0);
    assert.deepEqual(env.overridden, ['engramCacheMs']);
  });

  test('safety is identical in every profile: no safety knob exists, and policy, filters, MIN_CONFIDENCE and caps do not move', async () => {
    const knobs = ['nightBudget', 'improveBudget', 'nightModel', 'judgeMode', 'maxConcurrent', 'engramCacheMs', 'trackingRefreshMs'];
    for (const name of PROFILE_NAMES) assert.deepEqual(Object.keys(PROFILES[name]).sort(), [...knobs].sort(), name);
    const sensitive: NightQuestion = {
      terminalId: 't', toolCallId: 'c', tool: 'ask_user_choice', allowCustomResponse: false,
      items: [{ question: 'Should I push to main and deploy?', header: '', multiSelect: false, options: [{ label: 'Push (Recommended)', description: '' }, { label: 'Wait', description: '' }] }],
    };
    const quiet: NightQuestion = { ...sensitive, items: [{ question: 'Which runner?', header: '', multiSelect: false, options: [{ label: 'Merge the release branch', description: '' }, { label: 'Wait', description: '' }] }] };
    const results: string[] = [];
    for (const name of PROFILE_NAMES) {
      const profiles = new ResourceProfiles({ file: fileFor('safety'), profile: name });
      const decider = createDecider({ model: () => profiles.values().nightModel, run: async () => '{"action":"answer","choices":[0],"reason":"Fine.","confidence":0.99}' });
      const ctx = { workspaceId: 'dev', workspaceName: 'Dev', rel: 'a', cwd: '/a', mission: 'Ship everything.', activity: null, recentOutput: '' };
      const followUp = createDecider({ model: () => profiles.values().nightModel, run: async () => '{"action":"follow-up","message":"git push --force origin main","reason":"Fine.","confidence":0.99}' });
      results.push(
        JSON.stringify([
          checkQuestion(sensitive, true),
          (await decider.decide(quiet, ctx)).action,
          (await followUp.followUp(ctx)).action,
          findSensitive('cat .env'),
          isSensitiveText('deploy to prod'),
          MIN_CONFIDENCE,
          MAX_AUTO_PER_NIGHT,
          MAX_AUTO_DEFERRALS,
        ]),
      );
    }
    assert.equal(new Set(results).size, 1, 'the same answers in every profile');
    assert.deepEqual(JSON.parse(results[0]).slice(1), ['defer', 'defer', JSON.parse(results[0])[3], true, 0.7, 10, 2]);
    assert.equal(JSON.parse(results[0])[0].allow, false);
  });
});

describe('the stored choice', () => {
  test('lives in <stateDir>/profile.json (0600); missing or invalid means Equilibrado', async () => {
    assert.equal(profilePath({ XDG_STATE_HOME: '/s' }), '/s/mirador/profile.json');
    const file = fileFor('store');
    assert.equal((await ResourceProfiles.load({ file })).profile, 'equilibrado');
    const profiles = await ResourceProfiles.load({ file });
    await profiles.set('potencia');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { profile: 'potencia' });
    assert.equal((await ResourceProfiles.load({ file })).profile, 'potencia');
    await writeFile(file, '{"profile":"turbo"}');
    assert.equal((await ResourceProfiles.load({ file })).profile, 'equilibrado');
    await assert.rejects(profiles.set('turbo'), (error: unknown) => error instanceof ProfileError && error.code === 'profile_invalid');
    assert.equal(profiles.profile, 'potencia', 'a refused change changes nothing');
  });

  test('S3: a profile.json or config overrides from before S3 with translateBudget load without error and are ignored: improveBudget is the profile\'s', async (t) => {
    const errors = t.mock.method(console, 'error', () => undefined);
    const file = fileFor('old-translate');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ profile: 'ahorro', translateBudget: 5, translateModel: 'claude-sonnet-5-5' }));
    const profiles = await ResourceProfiles.load({ file, overrides: { translateBudget: 7, translateModel: 'claude-sonnet-5-5' } as never, env: {} });
    assert.equal(errors.mock.callCount(), 0, 'nothing is reported');
    assert.equal(profiles.profile, 'ahorro');
    assert.equal(profiles.values().improveBudget, PROFILES.ahorro.improveBudget);
    assert.equal(profiles.values().improveBudget, 100);
    assert.equal('translateBudget' in profiles.values(), false);
    assert.deepEqual(profiles.view().overridden, []);
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  kill() {
    return true;
  }
}

async function fakeRuntime(): Promise<PiRuntime> {
  const dir = join(scratch, `pi-${++counter}`);
  await mkdir(join(dir, 'bridge'), { recursive: true });
  await writeFile(join(dir, 'cli.js'), '');
  return { node: process.execPath, cli: join(dir, 'cli.js'), agentDir: dir, bridge: join(dir, 'bridge'), workDir: join(dir, 'work') };
}

const decidedRecord = (id: string, confidence: number | undefined, outcome: 'decided' | 'followed-up' = 'decided'): NightRecord => ({
  id, time: new Date().toISOString(), kind: outcome === 'decided' ? 'question' : 'delegate', terminalId: 't', workspaceId: 'dev', rel: 'a', tool: 'ask_user_choice',
  question: { allowCustomResponse: false, items: [{ question: 'Grid or list?', header: '', options: ['Grid', 'List'], multiSelect: false }] },
  policy: { allowed: true },
  decision: outcome === 'decided' ? { action: 'answer', choices: [{ item: 0, index: 0, label: 'Grid' }], reason: 'r', ...(confidence === undefined ? {} : { confidence }) } : null,
  followUp: outcome === 'followed-up' ? { action: 'follow-up', message: 'Run the tests.', reason: 'r', confidence: 0.9 } : null,
  sent: outcome === 'decided' ? 'decided' : 'message', delivered: outcome === 'decided' ? null : true, outcome, deferral: null, error: null,
});

describe('switching at runtime, without a restart', () => {
  test('the concurrency cap, the Engram TTL, the decider model, the judge mode and the budget follow at once', async () => {
    const profiles = new ResourceProfiles({ file: fileFor('runtime'), profile: 'equilibrado' });
    // What server.ts wires: listeners apply the process-wide knobs.
    let now = 0;
    let engramHits = 0;
    const engramServer = createServer((_req, res) => {
      engramHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => engramServer.listen(0, '127.0.0.1', resolve));
    const address = engramServer.address();
    const engram = new EngramClient(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, 2000, { cacheMs: profiles.values().engramCacheMs, now: () => now });
    const stop = profiles.onChange((values) => {
      piGate.configure({ maxConcurrent: values.maxConcurrent });
      engram.setCacheMs(values.engramCacheMs);
    });
    try {
      await engram.allObservations();
      now = 15_000;
      await engram.allObservations();
      assert.equal(engramHits, 1, 'Equilibrado shares the window for 20 s');
      await profiles.set('potencia');
      assert.equal(piGate.stats().maxConcurrent, 4);
      await engram.allObservations();
      assert.equal(engramHits, 2, 'Potencia keeps it 10 s');
      await profiles.set('ahorro');
      assert.equal(piGate.stats().maxConcurrent, 1);
      now = 50_000;
      await engram.allObservations();
      assert.equal(engramHits, 2, 'Ahorro keeps it 60 s');

      // Decider model: read per call.
      const rt = await fakeRuntime();
      const models: string[] = [];
      const spawn = ((_c: string, args: string[]) => {
        const child = new FakeChild();
        models.push(args[args.indexOf('--model') + 1]);
        child.stdin.on('finish', () => {
          child.stdout.end('{"action":"defer","reason":"Not covered."}');
          setImmediate(() => child.emit('close', 0, null));
        });
        return child;
      }) as never;
      const decider = createDecider({ model: () => profiles.values().nightModel, runtime: rt, spawn, gate: new PiGate({ maxConcurrent: 4 }) });
      const ctx = { workspaceId: 'dev', workspaceName: 'Dev', rel: 'a', cwd: '/a', mission: 'm', activity: null, recentOutput: '' };
      await decider.followUp(ctx);
      await profiles.set('potencia');
      await decider.followUp(ctx);
      assert.deepEqual(models, ['claude-haiku-5-5', 'claude-opus-5-5']);

      // Judge mode: Ahorro reviews only doubtful decisions (confidence < 0.85) and follow-ups.
      const reviewed: string[] = [];
      const judge = createJudge({
        log: { recent: async () => [] },
        store: new JudgmentStore(join(scratch, `judge-${++counter}`, 'judgments.jsonl')),
        workspaces: { get: () => ({ name: 'Dev', mission: 'm' }) },
        mode: () => profiles.values().judgeMode,
        run: async (prompt) => {
          reviewed.push(prompt.user.includes('follow-up') ? 'follow-up' : 'decision');
          return '{"verdict":"ok","note":"Fine."}';
        },
      });
      await profiles.set('ahorro');
      assert.equal(await judge.review(decidedRecord('sure', 0.9)), null, 'a confident decision is not reviewed in Ahorro');
      assert.equal((await judge.review(decidedRecord('unsure', 0.8)))?.verdict, 'ok');
      assert.equal((await judge.review(decidedRecord('unknown', undefined)))?.verdict, 'ok', 'no confidence counts as doubtful');
      assert.equal((await judge.review(decidedRecord('f', 0.9, 'followed-up')))?.verdict, 'ok');
      await profiles.set('equilibrado');
      assert.equal((await judge.review(decidedRecord('sure-2', 0.9)))?.verdict, 'ok', 'every move in Equilibrado');
      assert.equal(reviewed.length, 4);
      judge.close();

      // Budget: the limit is read per take.
      const budget = new CallBudget({ file: join(scratch, `budget-${++counter}.json`), limits: () => ({ night: profiles.values().nightBudget, improveDay: profiles.values().improveBudget }) });
      assert.equal(budget.night().limit, 150);
      await profiles.set('ahorro');
      assert.deepEqual([budget.night().limit, budget.improveToday().limit], [60, 100]);
      await budget.flush();
    } finally {
      stop();
      piGate.configure({ maxConcurrent: 2 });
      await new Promise((resolve) => engramServer.close(resolve));
    }
  });
});

describe('GET/PUT /api/profile and GET /api/telemetry (in-process)', () => {
  let server: Server;
  let base: string;
  let profiles: ResourceProfiles;
  let budget: CallBudget;
  let telemetry: CallTelemetry;

  before(async () => {
    profiles = new ResourceProfiles({ file: fileFor('routes'), overrides: { nightModel: 'claude-sonnet-5-5' } });
    budget = new CallBudget({ file: join(scratch, `routes-budget-${++counter}.json`), limits: () => ({ night: profiles.values().nightBudget, improveDay: profiles.values().improveBudget }), today: () => '2026-10-28' });
    telemetry = new CallTelemetry({ dir: join(scratch, `routes-telemetry-${++counter}`) });
    const routes = await createProfileRoutes({ profiles, budget, telemetry })({ onShutdown: () => {} } as unknown as AppContext);
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
  after(() => new Promise((resolve) => server.close(resolve)));

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  test('GET answers the profile, the effective values with overrides marked, every profile and the budget', async () => {
    budget.startNight('2026-10-28T23:00:00.000Z');
    budget.take('decide');
    budget.take('propose');
    const view = await (await api('GET', '/api/profile')).json();
    assert.deepEqual(view, {
      profile: 'equilibrado',
      values: { ...PROFILES.equilibrado },
      overridden: ['nightModel'],
      profiles: PROFILES,
      budget: { night: { used: 1, limit: 150 }, improveToday: { used: 1, limit: 300 } },
    });
  });

  test('PUT switches the profile; anything but { profile: <name> } is 400 profile_invalid', async () => {
    const answer = await api('PUT', '/api/profile', { profile: 'ahorro' });
    assert.equal(answer.status, 200);
    const view = await answer.json();
    assert.equal(view.profile, 'ahorro');
    assert.equal(view.values.nightModel, 'claude-sonnet-5-5', 'the config override still wins');
    assert.equal(view.values.maxConcurrent, 1);
    assert.equal(view.budget.night.limit, 60);
    for (const body of [{}, { profile: 'turbo' }, { profile: 'ahorro', extra: 1 }, { profile: 3 }]) {
      const bad = await api('PUT', '/api/profile', body);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal((await bad.json()).code, 'profile_invalid');
    }
    assert.equal(profiles.profile, 'ahorro');
    await api('PUT', '/api/profile', { profile: 'equilibrado' });
  });

  test('GET /api/telemetry: counts, total time, p50/p95 per feature and the budget; since is validated', async () => {
    telemetry.record({ time: new Date().toISOString(), feature: 'judge', model: 'claude-sonnet-5-5', promptVersion: 'night-judge-v1', ms: 420, outcome: 'ok', inputBytes: 10, outputBytes: 4 });
    await telemetry.flush();
    const body = await (await api('GET', `/api/telemetry?since=${Date.now() - 60_000}`)).json();
    assert.deepEqual(Object.keys(body).sort(), ['budget', 'calls', 'latency', 'since', 'total', 'totalMs']);
    assert.deepEqual(body.calls, { judge: { ok: 1 } });
    assert.deepEqual(body.latency, { judge: { p50: 420, p95: 420, runs: 1 } });
    assert.equal(body.totalMs, 420);
    assert.deepEqual(body.budget.night, { used: 1, limit: 150 });
    const bad = await api('GET', '/api/telemetry?since=yesterday');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'telemetry_since');
  });
});

describe('integration (the real server)', () => {
  let dir: string;
  let server: ChildProcess;
  let base: string;
  let token: string;

  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'mirador-profiles-int-')));
    await mkdir(join(dir, 'root'), { recursive: true });
    await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
    await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(dir, 'root'), engramUrl: 'http://127.0.0.1:9', maxConcurrent: 3 }));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    server = spawnProcess(process.execPath, ['src/server.ts'], {
      cwd: APP_DIR,
      env: { ...process.env, HOME: join(dir, 'home'), GENTLE_SHELL_HOME: join(dir, 'none'), XDG_RUNTIME_DIR: join(dir, 'run'), XDG_CONFIG_HOME: join(dir, 'cfg'), XDG_STATE_HOME: join(dir, 'state'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    let state: { launchSecret: string } | undefined;
    while (!state && Date.now() < deadline) {
      state = await readFile(join(dir, 'run', 'mirador', 'state.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      if (!state) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(state, 'server started');
    const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
    const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    token = ((await session.json()) as { token: string }).token;
  });

  after(async () => {
    server?.kill('SIGTERM');
    await new Promise((resolve) => server?.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  });

  test('every route needs the session token, and PUT needs the app origin', async () => {
    for (const [method, path] of [['GET', '/api/profile'], ['PUT', '/api/profile'], ['GET', '/api/telemetry']]) {
      assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base } })).status, 401, `${method} ${path}`);
      assert.equal((await fetch(`${base}${path}`, { method, headers: { origin: base, authorization: 'Bearer wrong' } })).status, 401, `${method} ${path}`);
    }
    const cross = await fetch(`${base}/api/profile`, { method: 'PUT', headers: { origin: 'http://evil.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"profile":"potencia"}' });
    assert.equal(cross.status, 403);
  });

  test('the real server answers the shapes, marks the config override and stores the choice in a 0600 file', async () => {
    const headers = { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const view = await (await fetch(`${base}/api/profile`, { headers })).json();
    assert.equal(view.profile, 'equilibrado');
    assert.equal(view.values.maxConcurrent, 3);
    assert.deepEqual(view.overridden, ['maxConcurrent']);
    assert.deepEqual(view.budget, { night: { used: 0, limit: 150 }, improveToday: { used: 0, limit: 300 } });
    const put = await fetch(`${base}/api/profile`, { method: 'PUT', headers, body: JSON.stringify({ profile: 'potencia' }) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).values.nightModel, 'claude-opus-5-5');
    const file = join(dir, 'state', 'mirador', 'profile.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const telemetry = await (await fetch(`${base}/api/telemetry`, { headers })).json();
    assert.deepEqual(telemetry.calls, {});
    assert.deepEqual(telemetry.budget.night, { used: 0, limit: 400 });
    const report = await (await fetch(`${base}/api/night/report`, { headers })).json();
    assert.deepEqual(report.summary.calls, { used: 0, limit: 400 });
  });
});
