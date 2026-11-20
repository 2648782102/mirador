// Open agents: Mirador keeps a record of
// every open agent terminal in <stateDir>/open-agents.json and reopens them at the next start,
// continuing each one's pi session. Real registry with a fake pty, real files in a scratch dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents, openAgentsPath, validSessionFile, type OpenAgentRecord } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalRequest } from '../src/terminals/registry.ts';
import { resumeArgs } from '../src/attention/agent-args.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-open-agents-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

class FakePty implements PtyProcess {
  killed = false;
  private exitListeners: Array<(e: { exitCode: number }) => void> = [];
  readonly opts: { cwd: string; cols: number; rows: number; env: Record<string, string> };
  constructor(_file: string, _args: string[], opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }) {
    this.opts = opts;
  }
  onData() {}
  onExit(listener: (e: { exitCode: number }) => void) { this.exitListeners.push(listener); }
  write() {}
  resize() {}
  kill() { this.killed = true; this.emitExit(0); }
  emitExit(exitCode: number, signal?: number) { this.exitListeners.forEach((l) => l(signal === undefined ? { exitCode } : { exitCode, signal })); }
}

function setup() {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (file, args, opts) => {
    const pty = new FakePty(file, args, opts);
    spawned.push(pty);
    return pty;
  };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/home/u' }, scrollbackLimit: 1000 });
  registry.addAgentArgs(['-e', '/opt/bridge.ts']);
  return { registry, spawned };
}

let counter = 0;
/** A fresh state dir with a config file that exists, as the owner of the records. */
async function place() {
  const dir = join(scratch, `case-${++counter}`);
  await mkdir(join(dir, 'state'), { recursive: true });
  const owner = join(dir, 'config.json');
  await writeFile(owner, '{}');
  const logs: string[] = [];
  return { dir, file: join(dir, 'state', 'open-agents.json'), owner, logs, log: (line: string) => void logs.push(line) };
}

const read = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const agent = (rel: string, extra: Partial<{ cols: number; rows: number; workspaceId: string }> = {}) =>
  ({ cwd: `/w/${rel}`, kind: 'agent' as const, cols: extra.cols ?? 100, rows: extra.rows ?? 30, workspaceId: extra.workspaceId ?? 'dev', rel });

test('the records live in <stateDir>/open-agents.json', () => {
  assert.equal(openAgentsPath({ XDG_STATE_HOME: '/s' }), '/s/mirador/open-agents.json');
  assert.equal(openAgentsPath({ HOME: '/home/u' }), '/home/u/.local/state/mirador/open-agents.json');
});

test('every open agent terminal is recorded, written whole with mode 0600; shells are not', async () => {
  const { file, owner, log } = await place();
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const a = registry.create(agent('alpha', { cols: 120, rows: 40 }));
  registry.create({ ...agent('beta'), kind: 'shell' });
  const b = registry.create(agent('beta/sub'));
  await store.flush();

  assert.deepEqual(await read(file), {
    owner,
    agents: [
      { id: a.id, workspaceId: 'dev', rel: 'alpha', cwd: '/w/alpha', cols: 120, rows: 40, sessionFile: null, createdAt: a.createdAt },
      { id: b.id, workspaceId: 'dev', rel: 'beta/sub', cwd: '/w/beta/sub', cols: 100, rows: 30, sessionFile: null, createdAt: b.createdAt },
    ],
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(file, '..')), ['open-agents.json'], 'no temporary file is left behind');
});

/** A fake timer: records each scheduled removal so the test decides when the grace delay ends. */
function fakeTimers() {
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { ms, run, cancelled: false };
    timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  const fire = () => timers.filter((t) => !t.cancelled).forEach((t) => { t.cancelled = true; t.run(); });
  return { timers, schedule, fire };
}
const ids = async (file: string) => (await read(file)).agents.map((r: OpenAgentRecord) => r.id);

test('an agent closed by the user leaves the records at once', async () => {
  const { file, owner, log } = await place();
  const { registry } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const closed = registry.create(agent('a'));
  const kept = registry.create(agent('b'));
  registry.close(closed.id);
  await store.flush();
  assert.deepEqual(await ids(file), [kept.id]);
  timers.fire();
  await store.flush();
  assert.deepEqual(await ids(file), [kept.id]);
});

test('an agent that exits cleanly leaves the records only after a 5 s grace, so a server dying meanwhile keeps it', async () => {
  const { file, owner, log } = await place();
  const { registry, spawned } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const exited = registry.create(agent('a'));
  const failed = registry.create(agent('b'));
  const kept = registry.create(agent('c'));
  spawned[0].emitExit(0);
  spawned[1].emitExit(1, 0);
  await store.flush();
  assert.deepEqual(await ids(file), [exited.id, failed.id, kept.id], 'still on disk during the grace delay');
  assert.deepEqual(timers.timers.map((t) => t.ms), [5000, 5000]);
  assert.equal(registry.get(exited.id)?.status, 'exited', 'the exited terminal itself stays listed, as before');
  timers.fire();
  await store.flush();
  assert.deepEqual(await ids(file), [kept.id]);
});

test('an agent killed by a signal, or exiting with code 128 or more, keeps its record until the user closes it', async () => {
  const { file, owner, log } = await place();
  const { registry, spawned } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const killed = registry.create(agent('a'));
  const oom = registry.create(agent('b'));
  spawned[0].emitExit(0, 9);
  spawned[1].emitExit(137);
  timers.fire();
  await store.flush();
  assert.deepEqual(timers.timers, [], 'no removal is scheduled');
  assert.deepEqual(await ids(file), [killed.id, oom.id]);
  registry.close(killed.id);
  await store.flush();
  assert.deepEqual(await ids(file), [oom.id], 'closing the exited terminal removes its record at once');
});

test('the user closing an agent during its grace delay removes it at once; the server\'s own shutdown keeps every record', async () => {
  const { file, owner, log } = await place();
  const { registry, spawned } = setup();
  const timers = fakeTimers();
  const store = await OpenAgents.load(file, { owner, log, schedule: timers.schedule });
  store.track(registry);
  const closing = registry.create(agent('a'));
  const exiting = registry.create(agent('b'));
  const running = registry.create(agent('c'));
  spawned[0].emitExit(0);
  registry.close(closing.id);
  await store.flush();
  assert.deepEqual(await ids(file), [exiting.id, running.id]);
  assert.equal(timers.timers[0].cancelled, true, 'its grace removal is cancelled');

  spawned[1].emitExit(0);
  store.keep();
  registry.closeAll();
  timers.fire();
  await store.flush();
  assert.deepEqual(await ids(file), [exiting.id, running.id], 'a grace delay ending after keep() removes nothing');
  assert.equal(registry.list().length, 0, 'closeAll still closes every terminal');
});

test('the default grace timer never keeps the process alive', async () => {
  const { file, owner, log } = await place();
  const { registry, spawned } = setup();
  const store = await OpenAgents.load(file, { owner, log, exitGraceMs: 20 });
  store.track(registry);
  registry.create(agent('a'));
  spawned[0].emitExit(0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await store.flush();
  assert.deepEqual(await ids(file), []);
});

test('a reported session file is kept only when it is an absolute path to an existing .jsonl regular file', async () => {
  const { dir, file, owner, log } = await place();
  const good = join(dir, "it's a session.jsonl");
  await writeFile(good, '{}\n');
  await mkdir(join(dir, 'folder.jsonl'));
  await writeFile(join(dir, 'notes.txt'), '');
  await symlink(good, join(dir, 'link.jsonl'));
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const a = registry.create(agent('a'));
  const shell = registry.create({ ...agent('s'), kind: 'shell' });
  await store.flush();
  const before = await readFile(file, 'utf8');

  const rejected: unknown[] = [
    'session.jsonl', // relative
    '-rf.jsonl', // could become an option
    '--session=x.jsonl',
    join(dir, 'missing.jsonl'),
    join(dir, 'folder.jsonl'), // a directory
    join(dir, 'notes.txt'),
    join(dir, 'link.jsonl'), // a symlink, not a regular file
    `${good}\n`,
    `${dir}/a\nb.jsonl`,
    '',
    42,
    null,
    `/${'a'.repeat(5000)}.jsonl`,
  ];
  for (const value of rejected) {
    assert.equal(await validSessionFile(value), null, JSON.stringify(value));
    assert.equal(await store.recordSession(a.id, value), false, JSON.stringify(value));
  }
  assert.equal(await store.recordSession(shell.id, good), false, 'shell terminals are never recorded');
  assert.equal(await store.recordSession('unknown', good), false);
  await store.flush();
  assert.equal(await readFile(file, 'utf8'), before, 'nothing rejected reaches the file');

  assert.equal(await validSessionFile(good), good);
  assert.equal(await store.recordSession(a.id, good), true);
  await store.flush();
  assert.equal((await read(file)).agents[0].sessionFile, good);
});

/** Records as a previous run left them. */
async function previousRun(file: string, owner: string, agents: Array<Partial<OpenAgentRecord>>) {
  const full = agents.map((record, i) => ({ id: `old-${i}`, workspaceId: 'dev', rel: '', cwd: '/old', cols: 100, rows: 30, sessionFile: null, createdAt: '2026-10-29T00:00:00.000Z', ...record }));
  await writeFile(file, JSON.stringify({ owner, agents: full }), { mode: 0o600 });
}

/** Resolves folders of workspace `dev` under /w, like WorkspaceStore.resolve; anything else is gone. */
const resolveFolder = async (workspaceId: string, rel: string) => {
  if (workspaceId !== 'dev') throw new Error(`unknown workspace: ${workspaceId}`);
  if (rel === 'gone') throw new Error('not a folder: gone');
  return { workspace: { id: 'dev' }, rel, path: rel ? `/w/${rel}` : '/w' };
};
const sessionArgs = (sessionFile: string) => ['--session', sessionFile];

test('at startup each recorded agent reopens in its folder, one after another, continuing its session when the file still exists', async () => {
  const { dir, file, owner, logs, log } = await place();
  const session = join(dir, "it's $(rm -rf ~) a session.jsonl");
  await writeFile(session, '{}\n');
  await previousRun(file, owner, [
    { rel: 'alpha', cols: 120, rows: 40, sessionFile: session },
    { workspaceId: 'gone-ws', rel: 'x' },
    { rel: 'beta', sessionFile: join(dir, 'deleted.jsonl') },
    { rel: 'gone' },
    { rel: '', sessionFile: '-oops.jsonl' },
  ]);
  const { registry, spawned } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const sleeps: number[] = [];
  const result = await store.restore({ registry, resolveFolder, sessionArgs, delayMs: 2000, sleep: async (ms) => void sleeps.push(ms) });
  await store.flush();

  assert.deepEqual(registry.list().map((t) => [t.kind, t.workspaceId, t.rel, t.cwd, t.cols, t.rows]), [
    ['agent', 'dev', 'alpha', '/w/alpha', 120, 40],
    ['agent', 'dev', 'beta', '/w/beta', 100, 30],
    ['agent', 'dev', '', '/w', 100, 30],
  ]);
  assert.deepEqual(sleeps, [2000, 2000], 'a pause between two spawns, none before the first or for dropped records');
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/bridge.ts' '--session' '${session.replaceAll("'", `'\\''`)}'`);
  assert.equal(spawned[1].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/bridge.ts'`, 'a missing session file starts a fresh session');
  assert.equal(spawned[2].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/bridge.ts'`, 'an invalid session file is ignored');
  // The rcfile evals the command: through a real shell the session path stays one literal word.
  const words = execFileSync('bash', ['-c', 'eval "set -- $CMD"; printf "%s\\0" "$@"'], { env: { CMD: spawned[0].opts.env.MIRADOR_AGENT_COMMAND.replace(/^gentle-shell /, '') } })
    .toString().split('\0').slice(0, -1);
  assert.deepEqual(words, ['-e', '/opt/bridge.ts', '--session', session]);

  const ids = registry.list().map((t) => t.id);
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => [r.id, r.rel, r.sessionFile]), [[ids[0], 'alpha', session], [ids[1], 'beta', null], [ids[2], '', null]], 'the restored terminals replace the old records');
  assert.deepEqual(result, { restored: 3, dropped: 2 });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /dropped .*gone-ws.*x.*unknown workspace/);
  assert.match(logs[1], /dropped .*dev.*gone.*not a folder/);
});

test('records not reopened yet stay on disk, and a shutdown stops the restore', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a' }, { rel: 'b' }, { rel: 'c' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  let wake!: () => void;
  const napping = new Promise<void>((resolve) => {
    const sleep = () => new Promise<void>((done) => { wake = done; resolve(); });
    void store.restore({ registry, resolveFolder, sessionArgs, delayMs: 10, sleep }).then(() => undefined);
  });
  await napping;
  await store.flush();
  // A crash now must not lose b and c.
  const first = registry.list()[0];
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => [r.id, r.rel]), [['old-1', 'b'], ['old-2', 'c'], [first.id, 'a']]);

  store.keep();
  registry.closeAll();
  wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.flush();
  assert.equal(registry.list().length, 0, 'nothing reopens once the shutdown began');
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => r.rel), ['b', 'c', 'a']);
});

test('records of another Mirador config are left untouched; records of a config that is gone are discarded', async () => {
  const other = await place();
  const { file, owner, logs, log } = await place();
  await previousRun(file, other.owner, [{ rel: 'a' }]);
  const before = await readFile(file, 'utf8');
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, delayMs: 0 }), { restored: 0, dropped: 0 });
  registry.create(agent('mine'));
  await store.flush();
  assert.equal(registry.list().length, 1);
  assert.equal(await readFile(file, 'utf8'), before, 'another config\'s records are neither restored nor rewritten');
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`belongs to ${other.owner.replaceAll('/', '\\/')}`));

  await previousRun(file, join(other.dir, 'deleted', 'config.json'), [{ rel: 'a' }]);
  const second = setup();
  const taken = await OpenAgents.load(file, { owner, log });
  taken.track(second.registry);
  assert.deepEqual(await taken.restore({ registry: second.registry, resolveFolder, sessionArgs, delayMs: 0 }), { restored: 0, dropped: 0 });
  assert.equal(second.registry.list().length, 0);
  assert.match(logs[1], /discarded 1 record.* no longer exists/);
  const mine = second.registry.create(agent('mine'));
  await taken.flush();
  assert.deepEqual(await read(file), { owner, agents: [{ id: mine.id, workspaceId: 'dev', rel: 'mine', cwd: '/w/mine', cols: 100, rows: 30, sessionFile: null, createdAt: mine.createdAt }] });
});

test('a missing file restores nothing and is not created until an agent opens; a malformed one is logged and replaced', async () => {
  const { file, owner, logs, log } = await place();
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, delayMs: 0 }), { restored: 0, dropped: 0 });
  await store.flush();
  await assert.rejects(stat(file), { code: 'ENOENT' });

  await writeFile(file, '{"owner": 3, "agents": [');
  const second = setup();
  const reloaded = await OpenAgents.load(file, { owner, log });
  reloaded.track(second.registry);
  assert.deepEqual(await reloaded.restore({ registry: second.registry, resolveFolder, sessionArgs, delayMs: 0 }), { restored: 0, dropped: 0 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cannot read .*open-agents\.json/);
  const opened = second.registry.create(agent('x'));
  await reloaded.flush();
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => r.id), [opened.id]);
});

test('records sharing a session file: only the first continues it, the others start fresh and one line is logged', async () => {
  const { dir, file, owner, logs, log } = await place();
  const shared = join(dir, 'shared.jsonl');
  const own = join(dir, 'own.jsonl');
  await writeFile(shared, '{}\n');
  await writeFile(own, '{}\n');
  await previousRun(file, owner, [{ rel: 'a', sessionFile: shared }, { rel: 'b', sessionFile: own }, { rel: 'c', sessionFile: shared }]);
  const { registry, spawned } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, delayMs: 0, sleep: async () => undefined }), { restored: 3, dropped: 0 });
  await store.flush();
  assert.deepEqual(spawned.map((p) => p.opts.env.MIRADOR_AGENT_COMMAND), [
    `gentle-shell '-e' '/opt/bridge.ts' '--session' '${shared}'`,
    `gentle-shell '-e' '/opt/bridge.ts' '--session' '${own}'`,
    `gentle-shell '-e' '/opt/bridge.ts'`,
  ]);
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => [r.rel, r.sessionFile]), [['a', shared], ['b', own], ['c', null]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /folder "c".*shares its session file .*shared\.jsonl.*fresh session/);
});

test('S3/S8: a gentle-shell record carrying a session id still continues its session file, and still owns it', async () => {
  const { dir, file, owner, logs, log } = await place();
  const ID = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';
  const own = join(dir, 'own.jsonl');
  const slept = join(dir, 'slept.jsonl');
  await writeFile(own, '{}\n');
  await writeFile(slept, '{}\n');
  await previousRun(file, owner, [
    { rel: 'a', sessionFile: own, session: ID, lastState: 'working' },
    { rel: 'b', sessionFile: own, lastState: 'working' },
    { rel: 'z', sessionFile: slept, session: ID, lastState: 'finished' },
  ]);
  const { registry, spawned } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const requests: TerminalRequest[] = [];
  const recording = { create: (request: TerminalRequest) => (requests.push(request), registry.create(request)) };
  // What server.ts passes: the configured agentCommand's resume argv.
  const restoreArgs = (key: string) => resumeArgs('gentle-shell', key);
  assert.deepEqual(await store.restore({ registry: recording, resolveFolder, sessionArgs: restoreArgs, delayMs: 0, sleep: async () => undefined }), { restored: 2, dropped: 0 });
  await store.flush();
  assert.deepEqual(requests.map((r) => r.agentArgs), [['--session', own], []]);
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/bridge.ts' '--session' '${own}'`);
  assert.match(logs.at(-1) ?? '', /folder "b".*shares its session file .*own\.jsonl.*fresh session/);
  assert.deepEqual((await read(file)).agents.filter((r: OpenAgentRecord) => r.rel !== 'z').map((r: OpenAgentRecord) => [r.rel, r.sessionFile]), [['a', own], ['b', null]]);
  assert.deepEqual(store.sleeping().map((s) => [s.rel, s.resumable]), [['z', true]], 'its session file keeps it resumable');
});

/* ---------- The restore goes through the memory gate (src/system/memory-gate.ts) ---------- */

test('the restore reopens agents through the memory gate: in batches that settle, and it stops when memory stays low, keeping the rest for the next start', async () => {
  const { file, owner, logs, log } = await place();
  await previousRun(file, owner, [{ rel: 'a' }, { rel: 'b' }, { rel: 'c' }, { rel: 'd' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const timeline: string[] = [];
  registry.subscribe(({ type, info }) => type === 'created' && timeline.push(`open ${info.rel}`));
  let clock = 0;
  // Plenty of memory for the first three agents; then it stays under the reserve.
  let reads = 0;
  const gate = new LaunchGate({
    limits: { batchSize: 2, settleMs: 30_000, maxWaitMs: 4000, pollMs: 2000 },
    now: () => clock,
    readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: ++reads <= 3 ? 10 * 1024 ** 3 : 1024 ** 3 }),
    sleep: async (ms) => { timeline.push(`wait ${ms}`); clock += ms; },
  });
  const result = await store.restore({ registry, resolveFolder, sessionArgs, gate, delayMs: 2000, sleep: async (ms) => { timeline.push(`sleep ${ms}`); clock += ms; } });
  await store.flush();

  assert.deepEqual(timeline, ['open a', 'sleep 2000', 'open b', 'sleep 2000', 'wait 28000', 'open c', 'sleep 2000', 'wait 2000', 'wait 2000']);
  assert.deepEqual(result, { restored: 3, dropped: 0 });
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => r.rel), ['d', 'a', 'b', 'c'], 'the agent not reopened keeps its record');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /1 open agent\(s\) not reopened: available memory stayed under the reserve.*next start/);
  const [run] = gate.status().runs;
  assert.deepEqual([run.kind, run.state, run.total, run.opened, run.lowMemory], ['restore', 'done', 4, 3, 1], 'the restore is a launch run others can read');
});

test('a gate closed by the shutdown stops the restore while it waits', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a' }, { rel: 'b' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  const gate = new LaunchGate({
    readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 1024 ** 3 }),
    sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  const restoring = store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.close();
  assert.deepEqual(await restoring, { restored: 0, dropped: 0 });
  assert.equal(registry.list().length, 0);
  await store.flush();
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => r.rel), ['a', 'b']);
});

test('R4b: the restore tells its launch run which folders it left (low memory or Pausar), for the loading bar', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'a' }, { rel: 'b' }, { rel: 'c' }]);
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  let reads = 0;
  const gate = new LaunchGate({
    limits: { maxWaitMs: 0 },
    readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: ++reads <= 1 ? 10 * 1024 ** 3 : 1024 ** 3 }),
    sleep: async () => undefined,
  });
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined }), { restored: 1, dropped: 0 });
  const [run] = gate.status().runs;
  assert.deepEqual([run.lowMemory, run.notOpened], [2, [{ workspaceId: 'dev', rel: 'b' }, { workspaceId: 'dev', rel: 'c' }]]);

  // Pausar during a wait: every folder left is listed; a restore that opens everything lists none.
  const { file: file2, owner: owner2 } = await place();
  await previousRun(file2, owner2, [{ rel: 'x' }, { rel: 'y' }]);
  const second = setup();
  const paused = await OpenAgents.load(file2, { owner: owner2, log });
  paused.track(second.registry);
  const waiting = new LaunchGate({
    readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 1024 ** 3 }),
    sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  const restoring = paused.restore({ registry: second.registry, resolveFolder, sessionArgs, gate: waiting, sleep: async () => undefined });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(waiting.cancel(waiting.status().runs[0].id), true);
  await restoring;
  assert.deepEqual(waiting.status().runs[0].notOpened, [{ workspaceId: 'dev', rel: 'x' }, { workspaceId: 'dev', rel: 'y' }]);

  const { file: file3, owner: owner3 } = await place();
  await previousRun(file3, owner3, [{ rel: 'z' }]);
  const third = setup();
  const full = await OpenAgents.load(file3, { owner: owner3, log });
  full.track(third.registry);
  const roomy = new LaunchGate({ readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 10 * 1024 ** 3 }) });
  await full.restore({ registry: third.registry, resolveFolder, sessionArgs, gate: roomy, sleep: async () => undefined });
  assert.deepEqual(roomy.status().runs[0].notOpened, []);
});

test('two agents open on purpose in one folder before a stop both restore; low memory lists that folder once', async () => {
  const { file, owner, log } = await place();
  await previousRun(file, owner, [{ rel: 'p2' }, { rel: 'p2' }]);

  // Low memory from the start: nothing reopens, the folder shows once among those not opened.
  const low = setup();
  const waiting = await OpenAgents.load(file, { owner, log });
  waiting.track(low.registry);
  const gate = new LaunchGate({ limits: { maxWaitMs: 0 }, readMemory: async () => ({ memTotal: 24 * 1024 ** 3, memAvailable: 1024 ** 3 }), sleep: async () => undefined });
  assert.deepEqual(await waiting.restore({ registry: low.registry, resolveFolder, sessionArgs, gate, sleep: async () => undefined }), { restored: 0, dropped: 0 });
  assert.deepEqual(gate.status().runs[0].notOpened, [{ workspaceId: 'dev', rel: 'p2' }]);
  waiting.keep();
  await waiting.flush();

  // With memory, both records reopen: the restore's own agents never replace each other's records.
  const { registry } = setup();
  const store = await OpenAgents.load(file, { owner, log });
  store.track(registry);
  assert.deepEqual(await store.restore({ registry, resolveFolder, sessionArgs, sleep: async () => undefined }), { restored: 2, dropped: 0 });
  await store.flush();
  assert.deepEqual(registry.list().map((t) => t.rel), ['p2', 'p2']);
  assert.deepEqual((await read(file)).agents.map((r: OpenAgentRecord) => r.rel), ['p2', 'p2']);
});
