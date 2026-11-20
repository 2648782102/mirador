// Translation moved to the browser: no route and no model
// translate memories, old config keys still load, and the page marks memory text English and
// terminals, paths, code and names not to translate. The pi runner every Claude run still uses
// (decider, judge, "Mejorar con IA"): its command line, its process handling and the shared gate.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  PiGate,
  PiRunError,
  configurePiConcurrency,
  configurePiHold,
  createPiRunner,
  piGate,
  PI_LAUNCHING_MESSAGE,
  type CallRecord,
  piEnv,
  piPrintArgs,
  type PiRuntime,
} from '../src/memory/translate.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

async function scratchDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * Waits until `check` holds. A run reads and creates files before it takes a slot, so a fixed
 * pause does not tell when it got there; this polls with setImmediate, so it also works while
 * a test mocks setTimeout.
 */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const kindOf = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error) => (error instanceof PiRunError ? error.kind : String(error)));

describe('pi command', () => {
  const runtime: PiRuntime = {
    node: '/usr/bin/node',
    cli: '/opt/pi/cli.js',
    agentDir: '/home/u/.gentle-shell/agent',
    bridge: '/home/u/.gentle-shell/agent/npm/node_modules/pi-claude-bridge',
    workDir: '/home/u/.local/state/mirador/translate-work',
  };

  test('print mode, no extensions but the Claude bridge, no tools or session, the subscription provider and the model', () => {
    const args = piPrintArgs(runtime, { model: 'claude-haiku-5-5', systemPrompt: 'A fixed system prompt for this caller.' });
    assert.ok(Array.isArray(args));
    assert.equal(args[0], runtime.cli);
    for (const flag of ['-p', '--no-extensions', '--no-tools', '--no-session', '--no-context-files', '--no-skills']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('-e') + 1], runtime.bridge);
    assert.equal(args[args.indexOf('--provider') + 1], 'claude-bridge');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(args[args.indexOf('--thinking') + 1], 'off');
    assert.equal(args[args.indexOf('--system-prompt') + 1], 'A fixed system prompt for this caller.');
    const low = piPrintArgs(runtime, { model: 'm', systemPrompt: 's', thinking: 'low' });
    assert.equal(low[low.indexOf('--thinking') + 1], 'low');
    // pi reads the next word after -p as the prompt unless it is a flag: the text comes on stdin.
    assert.ok(args[args.indexOf('-p') + 1].startsWith('-'));
  });

  test('the environment points pi at the gentle-shell agent home and drops API keys and inherited agent variables', () => {
    const env = piEnv(runtime, {
      HOME: '/home/u',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'http://proxy',
      PI_CODING_AGENT_DIR: '/elsewhere',
      CLAUDECODE: '1',
      MIRADOR_TRANSLATE_PI: '/x',
    });
    assert.equal(env.PI_CODING_AGENT_DIR, runtime.agentDir);
    assert.equal(env.PATH, '/usr/bin');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'MIRADOR_TRANSLATE_PI']) assert.equal(env[key], undefined, key);
  });

  class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    killed: string[] = [];
    kill(signal = 'SIGTERM') {
      this.killed.push(signal);
      setImmediate(() => this.emit('close', null, signal));
      return true;
    }
  }

  async function fakeRuntime(): Promise<PiRuntime> {
    const dir = await scratchDir('mirador-pi-');
    await mkdir(join(dir, 'bridge'));
    await writeFile(join(dir, 'cli.js'), '');
    return { node: process.execPath, cli: join(dir, 'cli.js'), agentDir: dir, bridge: join(dir, 'bridge'), workDir: join(dir, 'work') };
  }

  const print = { model: 'm', systemPrompt: 's', feature: 'decide' as const, promptVersion: 'v' };

  test('spawns node with an argument array, never a shell, and passes the input only on stdin', async () => {
    const rt = await fakeRuntime();
    const seen: Array<{ command: string; args: string[]; options: Record<string, unknown>; stdin: string }> = [];
    const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChild();
      let stdin = '';
      child.stdin.on('data', (d) => (stdin += d));
      child.stdin.on('end', () => {
        seen.push({ command, args, options, stdin });
        child.stdout.end('  answer  \n');
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    }) as never;
    const secret = '$(rm -rf ~) `x` @/etc/passwd -p';
    assert.equal(await createPiRunner(rt, { spawn: spawnFn }).run(secret, { ...print, model: 'claude-haiku-5-5' }), '  answer  \n', "pi's raw stdout");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].command, process.execPath);
    assert.ok(!seen[0].options.shell, 'no shell');
    assert.equal(seen[0].options.cwd, rt.workDir);
    assert.ok(!seen[0].args.some((a) => a.includes(secret)), 'the input is not in argv');
    assert.equal(seen[0].stdin, secret);
    assert.equal((await stat(rt.workDir)).mode & 0o777, 0o700);
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  test('a non-zero exit, too much output or a timeout fails and kills the process', async () => {
    const rt = await fakeRuntime();
    const children: FakeChild[] = [];
    const behave = (mode: string) => ((() => {
      const child = new FakeChild();
      children.push(child);
      child.stdin.on('finish', () => {
        if (mode === 'exit') { child.stderr.end('secret stderr'); setImmediate(() => child.emit('close', 1, null)); }
        if (mode === 'flood') child.stdout.write('x'.repeat(2048));
        // 'hang' never answers
      });
      return child;
    }) as never);
    assert.equal(await kindOf(createPiRunner(rt, { spawn: behave('exit') }).run('t', print)), 'exit');
    assert.equal(await kindOf(createPiRunner(rt, { spawn: behave('flood'), maxOutputBytes: 1024 }).run('t', print)), 'too-long');
    assert.ok(children[1].killed.length, 'flooding process killed');
    assert.equal(await kindOf(createPiRunner(rt, { spawn: behave('hang'), timeoutMs: 50 }).run('t', print)), 'timeout');
    assert.ok(children[2].killed.length, 'hung process killed');
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  test('a missing pi or Claude bridge is unavailable and spawns nothing', async () => {
    const rt = await fakeRuntime();
    let spawned = 0;
    const spawnFn = (() => (spawned++, new FakeChild())) as never;
    assert.equal(await kindOf(createPiRunner({ ...rt, bridge: join(rt.agentDir, 'nope') }, { spawn: spawnFn }).run('t', print)), 'unavailable');
    assert.equal(await kindOf(createPiRunner({ ...rt, cli: join(rt.agentDir, 'nope.js') }, { spawn: spawnFn }).run('t', print)), 'unavailable');
    assert.equal(spawned, 0);
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  /** A spawn whose children answer only when the test calls `finish(n)`. */
  function heldSpawn() {
    const children: FakeChild[] = [];
    const spawnFn = (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never;
    const finish = (n: number) => {
      children[n].stdout.end('done');
      setImmediate(() => children[n].emit('close', 0, null));
    };
    return { children, spawnFn, finish };
  }

  test('one cap is shared by every runner (decider, judge, "Mejorar con IA"): the third concurrent run waits for a slot', async () => {
    const rt = await fakeRuntime();
    const gate = new PiGate({ maxConcurrent: 2, maxQueue: 4 });
    const { children, spawnFn, finish } = heldSpawn();
    const runners = [0, 1, 2].map(() => createPiRunner(rt, { spawn: spawnFn, gate }));
    // Each run reads files before it reaches the gate, so they can arrive in any order: start
    // them one at a time, so children[n] is the process of runs[n].
    const runs: Array<Promise<string>> = [];
    for (const [n, runner] of runners.entries()) {
      runs.push(runner.run('x', print));
      await until(() => gate.stats().active + gate.stats().waiting === n + 1);
    }
    assert.equal(children.length, 2, 'two runs started, the third waits');
    assert.deepEqual(gate.stats(), { active: 2, waiting: 1, maxConcurrent: 2, maxQueue: 4 });
    finish(0);
    assert.equal(await runs[0], 'done');
    await until(() => children.length === 3);
    assert.equal(children.length, 3, 'the freed slot goes to the waiting run');
    finish(1);
    finish(2);
    assert.deepEqual(await Promise.all(runs.slice(1)), ['done', 'done']);
    assert.deepEqual(gate.stats(), { active: 0, waiting: 0, maxConcurrent: 2, maxQueue: 4 });
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  test('runners share the process-wide cap by default, and configurePiConcurrency changes it', async () => {
    const rt = await fakeRuntime();
    const { children, spawnFn, finish } = heldSpawn();
    configurePiConcurrency({ maxConcurrent: 1 });
    try {
      const a = createPiRunner(rt, { spawn: spawnFn }).run('a', print);
      await until(() => piGate.stats().active === 1);
      const b = createPiRunner(rt, { spawn: spawnFn }).run('b', print);
      await until(() => piGate.stats().waiting === 1);
      assert.equal(children.length, 1, 'a second runner waits behind the first');
      finish(0);
      await a;
      await until(() => children.length === 2);
      finish(1);
      assert.equal(await b, 'done');
    } finally {
      configurePiConcurrency({ maxConcurrent: 2 });
    }
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  test('a full queue fails fast as unavailable without spawning', async () => {
    const rt = await fakeRuntime();
    const gate = new PiGate({ maxConcurrent: 1, maxQueue: 1 });
    const { children, spawnFn, finish } = heldSpawn();
    const runner = createPiRunner(rt, { spawn: spawnFn, gate });
    const first = runner.run('1', print);
    await until(() => gate.stats().active === 1);
    const second = runner.run('2', print);
    await until(() => gate.stats().waiting === 1);
    const started = Date.now();
    await assert.rejects(runner.run('3', print), (error: unknown) => error instanceof PiRunError && error.kind === 'unavailable' && /waiting/.test(error.message));
    assert.ok(Date.now() - started < 1000, 'without waiting');
    assert.equal(children.length, 1);
    finish(0);
    await first;
    await until(() => children.length === 2);
    finish(1);
    assert.equal(await second, 'done');
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  test('a queued run leaves the queue when aborted, when its runner closes, or when it waited longer than its timeout', async (t) => {
    const rt = await fakeRuntime();
    const gate = new PiGate({ maxConcurrent: 1, maxQueue: 8 });
    const { children, spawnFn, finish } = heldSpawn();
    const holder = createPiRunner(rt, { spawn: spawnFn, gate });
    const busy = holder.run('busy', print);
    await until(() => gate.stats().active === 1);
    // The slow run's 40 ms wait runs on mocked time: it cannot time out before all three are queued.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const aborted = kindOf(createPiRunner(rt, { spawn: spawnFn, gate }).run('a', { ...print, signal: controller.signal }));
    const closing = createPiRunner(rt, { spawn: spawnFn, gate });
    const closed = kindOf(closing.run('c', print));
    const slow = kindOf(createPiRunner(rt, { spawn: spawnFn, gate, timeoutMs: 40 }).run('t', print));
    await until(() => gate.stats().waiting === 3);
    assert.equal(gate.stats().waiting, 3);
    controller.abort();
    closing.close();
    assert.equal(await aborted, 'aborted');
    assert.equal(await closed, 'aborted');
    t.mock.timers.tick(40);
    assert.equal(await slow, 'timeout');
    t.mock.timers.reset();
    assert.equal(gate.stats().waiting, 0);
    assert.equal(children.length, 1, 'none of them started');
    finish(0);
    assert.equal(await busy, 'done');
    assert.equal(gate.stats().active, 0);
    await rm(rt.agentDir, { recursive: true, force: true });
  });

  test('R4b: while Mirador opens agents no Claude run starts: refused at once as unavailable (telemetry busy); it runs again after', async () => {
    const rt = await fakeRuntime();
    const { children, spawnFn, finish } = heldSpawn();
    const gate = new PiGate({ maxConcurrent: 1, maxQueue: 4 });
    const calls: CallRecord[] = [];
    const meter = { take: () => true, record: (call: CallRecord) => void calls.push(call) };
    let launching = true;
    configurePiHold(() => launching);
    try {
      const started = Date.now();
      await assert.rejects(createPiRunner(rt, { spawn: spawnFn, gate, meter }).run('x', print), (error: unknown) => error instanceof PiRunError && error.kind === 'unavailable' && error.message === PI_LAUNCHING_MESSAGE);
      assert.ok(Date.now() - started < 1000, 'without waiting');
      assert.deepEqual(calls.map((c) => c.outcome), ['busy']);
      // A run queued behind a busy slot when the launches begin does not start once the slot frees.
      launching = false;
      const holder = createPiRunner(rt, { spawn: spawnFn, gate }).run('h', print);
      await until(() => gate.stats().active === 1);
      const queued = kindOf(createPiRunner(rt, { spawn: spawnFn, gate }).run('q', print));
      await until(() => gate.stats().waiting === 1);
      launching = true;
      finish(0);
      assert.equal(await holder, 'done');
      assert.equal(await queued, 'unavailable');
      assert.equal(children.length, 1, 'only the run started before the launches spawned');
      // The launches ended: the next run starts.
      launching = false;
      const after = createPiRunner(rt, { spawn: spawnFn, gate }).run('a', print);
      await until(() => children.length === 2);
      finish(1);
      assert.equal(await after, 'done');
      assert.equal(gate.stats().active, 0);
    } finally {
      configurePiHold(null);
    }
    await rm(rt.agentDir, { recursive: true, force: true });
  });
});

describe('S3: translation is the browser\'s, through the server', () => {
  let scratch: string;
  let server: ChildProcess;
  let base: string;
  let token: string;
  let agentDir: string;
  /** Today in UTC, the config's time zone: the day of the old budget.json counter. */
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  // A pi that only logs that it ran: no translation may reach it.
  const FAKE_PI = `import { appendFileSync } from 'node:fs';
process.stdin.resume();
process.stdin.on('end', () => {
  appendFileSync(process.env.PI_CODING_AGENT_DIR + '/calls.jsonl', '{}\\n');
  process.stdout.write('ran\\n');
});
`;

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const calls = async () => (await readFile(join(agentDir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

  before(async () => {
    scratch = await scratchDir('mirador-browser-translation-');
    agentDir = join(scratch, 'agent');
    await mkdir(join(agentDir, 'npm', 'node_modules', 'pi-claude-bridge'), { recursive: true });
    await writeFile(join(scratch, 'fake-pi.mjs'), FAKE_PI);
    await mkdir(join(scratch, 'root'));
    await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
    // A config and stored state: the translate keys and the old day counter.
    await writeFile(
      join(scratch, 'cfg', 'mirador', 'config.json'),
      JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:9', timeZone: 'UTC', translateModel: 'claude-sonnet-5-5', translateBudget: 7 }),
    );
    await mkdir(join(scratch, 'state', 'mirador', 'night'), { recursive: true });
    await writeFile(join(scratch, 'state', 'mirador', 'profile.json'), JSON.stringify({ profile: 'ahorro', translateBudget: 5 }));
    await writeFile(
      join(scratch, 'state', 'mirador', 'night', 'budget.json'),
      JSON.stringify({ v: 1, night: { since: null, used: 0, announced: false, ended: true }, translate: { day: today, used: 4, announced: false } }),
    );
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['src/server.ts'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        HOME: join(scratch, 'home'),
        XDG_RUNTIME_DIR: join(scratch, 'run'),
        XDG_CONFIG_HOME: join(scratch, 'cfg'),
        XDG_STATE_HOME: join(scratch, 'state'),
        GENTLE_SHELL_HOME: agentDir,
        MIRADOR_TRANSLATE_PI: join(scratch, 'fake-pi.mjs'),
        MIRADOR_PORT: String(port),
        MIRADOR_SCOPES: '0',
      },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 8000;
    let state: { launchSecret: string } | undefined;
    while (!state && Date.now() < deadline) {
      state = await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      if (!state) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(state, 'the server starts with the old config and state');
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

  test('POST /api/translate is gone: 404 with the router\'s answer, and no pi runs', async () => {
    const response = await call('POST', '/api/translate', { id: 41, text: '**What**: hello', to: 'es' });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not found' });
    assert.equal(await calls(), 0);
  });

  test('a config with translateModel and translateBudget and a profile.json with translateBudget load as before: ignored, improveBudget is the profile\'s', async () => {
    const response = await call('GET', '/api/profile');
    assert.equal(response.status, 200);
    const view = (await response.json()) as { profile: string; values: Record<string, unknown>; overridden: string[]; profiles: Record<string, Record<string, unknown>> };
    assert.equal(view.profile, 'ahorro');
    assert.equal(view.values.improveBudget, 100);
    assert.deepEqual(view.overridden, []);
    for (const values of [view.values, ...Object.values(view.profiles)]) assert.equal('translateBudget' in values, false);
    const config = await call('GET', '/api/config');
    assert.equal(config.status, 200);
  });

  test('an old budget.json with a translate counter is read as today\'s "Mejorar con IA" count', async () => {
    const view = (await (await call('GET', '/api/profile')).json()) as { budget: Record<string, unknown> };
    assert.deepEqual(view.budget, { night: { used: 0, limit: 60 }, improveToday: { used: 4, limit: 100 } });
  });
});

describe('S3: the page leaves translation to the browser', () => {
  const source = (path: string) => readFileSync(join(APP_DIR, path), 'utf8');
  /** The source of `function name(…) { … }`, up to the next top-level closing brace. */
  const fn = (text: string, name: string) => {
    const start = text.search(new RegExp(`(export )?(async )?function ${name}\\(`));
    assert.ok(start >= 0, `function ${name}`);
    return text.slice(start, text.indexOf('\n}\n', start) + 2);
  };
  const summaryJs = source('public/features/summary.js');
  const overviewJs = source('public/features/overview.js');
  const terminalsJs = source('public/terminals.js');

  test('memory text is marked with its own language, its code and pre not to translate; its labels and notes keep the UI language', () => {
    const mark = fn(summaryJs, 'markMemory');
    assert.match(mark, /const own = \[\.\.\.node\.querySelectorAll\('\.mem-label, \.mem-abbr-note'\)\];/);
    assert.match(mark, /const code = \[\.\.\.node\.querySelectorAll\('code, pre'\)\];/);
    assert.match(mark, /node\.setAttribute\('lang', memoryLanguage\(node\.textContent, \[\.\.\.own, \.\.\.code\]\.map\(\(part\) => part\.textContent\)\)\);/);
    assert.match(mark, /for \(const part of code\) part\.setAttribute\('translate', 'no'\);/);
    assert.match(mark, /for \(const part of own\) part\.setAttribute\('lang', document\.documentElement\.lang\);/);
  });

  test('an opened memory, its title and the latest session summary are Engram text: marked with their language, translated by nothing in the page', () => {
    const item = fn(summaryJs, 'itemView');
    assert.match(item, /details\.append\(markMemory\(el\('div', \{ class: 'memory-body' \}, renderMarkdown\(item\.content, memory\)\)\)\);/);
    assert.match(item, /el\('span', \{ lang: memoryLanguage\(item\.title\) \}, item\.title\)/);
    assert.match(fn(summaryJs, 'summaryView'), /markMemory\(renderMarkdown\(s\.latestSummary\.content, memory\)\)/);
    assert.match(fn(summaryJs, 'activityView'), /el\('li', \{ lang: memoryLanguage\(title\) \}, title\)/);
    assert.match(fn(summaryJs, 'activityView'), /el\('span', \{ translate: 'no' \}, p\.project\)/);
    for (const [name, text] of Object.entries({ summaryJs, overviewJs })) {
      assert.doesNotMatch(text, /\/api\/translate|translatedView|showsExtra\(state\.config, 'translate'\)/, name);
    }
  });

  test('"Dónde quedó" and the workspace view mark their Engram text with its language and folder names not to translate', () => {
    assert.equal((overviewJs.match(/panel\.markMemory\(/g) ?? []).length, 6);
    assert.match(fn(overviewJs, 'rowView'), /el\('span', \{ class: 'overview-name', translate: 'no' \}, row\.name\)/);
    assert.match(fn(overviewJs, 'summaryCard'), /el\('span', \{ lang: memoryLanguage\(h\.title\) \}, h\.title\)/);
  });

  test('terminals, tabs and panes carry translate="no"', () => {
    const connect = fn(terminalsJs, 'connectTerminal');
    assert.match(connect, /body\.setAttribute\('translate', 'no'\);\n\s*term\.open\(body\);/);
    const mount = fn(terminalsJs, 'mountTerminal');
    assert.match(mount, /\{ class: 'tab', 'data-terminal-id': info\.id, title: [^\n]*, translate: 'no', onclick:/);
    assert.match(mount, /\{ class: 'pane', 'data-terminal-id': info\.id, [^\n]*, translate: 'no' \},/);
  });

  test('every code, pre and kbd the page builds, folder and workspace names, file paths, the crumb and the brand carry translate="no"', () => {
    assert.match(fn(source('public/core.js'), 'el'), /if \(tag === 'code' \|\| tag === 'pre' \|\| tag === 'kbd'\) node\.setAttribute\('translate', 'no'\);/);
    const workspacesJs = source('public/features/workspaces.js');
    assert.match(workspacesJs, /el\('span', \{ class: 'name', translate: 'no', title: node\.path \}, node\.name\)/);
    assert.match(workspacesJs, /el\('span', \{ class: 'name', translate: 'no', title: workspace\.root \}, workspace\.name\)/);
    const filesJs = source('public/features/files.js');
    for (const cls of ['hint files-where', 'files-name', 'files-item-name']) assert.match(filesJs, new RegExp(`\\{ class: '${cls}', translate: 'no'`), cls);
    const html = source('public/index.html');
    for (const id of ['credits-open', 'panel-crumb', 'panel-subtitle']) assert.match(html, new RegExp(`id="${id}" translate="no"`), id);
  });

  test('no translate button or notice is left in either language', async () => {
    const { MESSAGES } = await import('../public/i18n.js');
    for (const language of ['en', 'es'] as const) {
      const keys = Object.keys((MESSAGES as Record<string, Record<string, string>>)[language]);
      assert.deepEqual(keys.filter((key) => /^summary\.(translat|showOriginal|showTranslation)/.test(key)), [], language);
    }
  });
});
