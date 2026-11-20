import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRegistry, cleanEnv, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  written: string[] = [];
  size: [number, number];
  killed = false;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number }) => void> = [];
  file: string;
  args: string[];
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> };
  constructor(file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }) {
    this.file = file;
    this.args = args;
    this.opts = opts;
    this.size = [opts.cols, opts.rows];
  }
  onData(listener: (d: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (e: { exitCode: number }) => void) { this.exitListeners.push(listener); }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.size = [cols, rows]; }
  kill() { this.killed = true; this.emitExit(0); }
  emitData(d: string) { this.dataListeners.forEach((l) => l(d)); }
  emitExit(exitCode: number, signal?: number) { this.exitListeners.forEach((l) => l(signal === undefined ? { exitCode } : { exitCode, signal })); }
}

function setup(scrollbackLimit = 1000, scopes?: boolean) {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (file, args, opts) => {
    const p = new FakePty(file, args, opts);
    spawned.push(p);
    return p;
  };
  const registry = new TerminalRegistry(spawn, {
    shell: '/bin/bash',
    agentCommand: 'gentle-shell',
    agentRcFile: '/run/mirador/agent.bashrc',
    env: { HOME: '/home/you', PATH: '/usr/bin' },
    scrollbackLimit,
    ...(scopes === undefined ? {} : { scopes }),
  });
  return { registry, spawned };
}

const SCOPE_FLAGS = ['--user', '--scope', '--collect', '--quiet', '--expand-environment=no'];

test('with scopes on, each terminal runs its shell through systemd-run in its own user scope, with the same folder, size and variables', () => {
  const { registry, spawned } = setup(1000, true);
  const agent = registry.create({ cwd: '/home/you/Dev/web/vigia', kind: 'agent', cols: 120, rows: 40, workspaceId: 'dev', rel: '' });
  const shell = registry.create({ cwd: '/home/you/Dev', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });

  assert.equal(spawned[0].file, 'systemd-run');
  assert.deepEqual(spawned[0].args, [...SCOPE_FLAGS, `--unit=mirador-agent-${agent.id}`, '--', '/bin/bash', '--rcfile', '/run/mirador/agent.bashrc', '-i']);
  assert.equal(spawned[0].opts.cwd, '/home/you/Dev/web/vigia');
  assert.deepEqual(spawned[0].size, [120, 40]);
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, 'gentle-shell');
  assert.equal(spawned[0].opts.env.TERM, 'xterm-256color');
  assert.equal(spawned[0].opts.env.PATH, '/usr/bin');

  assert.equal(spawned[1].file, 'systemd-run');
  assert.deepEqual(spawned[1].args, [...SCOPE_FLAGS, `--unit=mirador-shell-${shell.id}`, '--', '/bin/bash', '-i']);
  assert.equal(spawned[1].opts.cwd, '/home/you/Dev');
  assert.equal(spawned[1].opts.env.MIRADOR_AGENT_COMMAND, undefined);
  assert.match(agent.id, /^[0-9a-f-]+$/, 'the terminal id is a valid unit name part');
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.title, 'vigia');
});

test('a terminal in a scope reports its exit code and signal as before', () => {
  const { registry, spawned } = setup(1000, true);
  const killed = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const exited = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  spawned[0].emitExit(0, 9);
  spawned[1].emitExit(3);
  assert.deepEqual([registry.get(killed.id)?.status, registry.get(killed.id)?.exitCode, registry.get(killed.id)?.exitSignal], ['exited', 0, 9]);
  assert.deepEqual([registry.get(exited.id)?.status, registry.get(exited.id)?.exitCode, registry.get(exited.id)?.exitSignal], ['exited', 3, undefined]);
});

test('with scopes off, terminals spawn bash directly exactly as before', () => {
  const { registry, spawned } = setup(1000, false);
  registry.create({ cwd: '/w', kind: 'agent', cols: 100, rows: 30, workspaceId: 'dev', rel: '' });
  registry.create({ cwd: '/w', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  assert.deepEqual(
    spawned.map((p) => [p.file, p.args, p.opts.cwd, p.size]),
    [
      ['/bin/bash', ['--rcfile', '/run/mirador/agent.bashrc', '-i'], '/w', [100, 30]],
      ['/bin/bash', ['-i'], '/w', [80, 24]],
    ],
  );
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, 'gentle-shell');
});

test('an agent terminal runs an interactive bash with the agent rcfile in the folder', () => {
  const { registry, spawned } = setup();
  const info = registry.create({ cwd: '/home/you/Dev/web/vigia', kind: 'agent', cols: 120, rows: 40, workspaceId: 'dev', rel: '' });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, '/bin/bash');
  assert.deepEqual(spawned[0].args, ['--rcfile', '/run/mirador/agent.bashrc', '-i']);
  assert.equal(spawned[0].opts.cwd, '/home/you/Dev/web/vigia');
  assert.deepEqual(spawned[0].size, [120, 40]);
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, 'gentle-shell');
  assert.equal(spawned[0].opts.env.TERM, 'xterm-256color');
  assert.equal(info.kind, 'agent');
  assert.equal(info.title, 'vigia');
  assert.equal(info.status, 'running');
});

test('a terminal remembers the workspace and folder it was opened from', () => {
  const { registry } = setup();
  const info = registry.create({ cwd: '/home/you/Dev/web/vigia', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: 'web/vigia' });
  assert.equal(info.workspaceId, 'dev');
  assert.equal(info.rel, 'web/vigia');
  assert.deepEqual(registry.list().map((t) => [t.workspaceId, t.rel]), [['dev', 'web/vigia']]);
});

test('env providers add variables to each new terminal and see its info', () => {
  const { registry, spawned } = setup();
  const seen: string[] = [];
  registry.addEnvProvider((info) => {
    seen.push(`${info.workspaceId}:${info.rel}`);
    return { HERDR_PANE_ID: info.id, TERM: 'overridden?' };
  });
  const info = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'tools' });
  assert.deepEqual(seen, ['dev:tools']);
  assert.equal(spawned[0].opts.env.HERDR_PANE_ID, info.id);
  assert.equal(spawned[0].opts.env.TERM, 'xterm-256color', 'Mirador keeps its own terminal variables');
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, 'gentle-shell');
});

test('subscribers hear when a terminal is created, exits and is closed', () => {
  const { registry, spawned } = setup();
  const events: string[] = [];
  const unsubscribe = registry.subscribe((event) => events.push(`${event.type}:${event.info.status}`));
  const { id } = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  spawned[0].emitExit(1);
  registry.close(id);
  unsubscribe();
  registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  assert.deepEqual(events, ['created:running', 'exited:exited', 'closed:exited']);
});

test('a shell terminal runs a plain interactive bash', () => {
  const { registry, spawned } = setup();
  registry.create({ cwd: '/home/you/Dev', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  assert.deepEqual(spawned[0].args, ['-i']);
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, undefined);
});

test('attach replays scrollback and then streams live output', () => {
  const { registry, spawned } = setup();
  const { id } = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  spawned[0].emitData('hello ');

  const received: string[] = [];
  const attachment = registry.attach(id, { onData: (d) => received.push(d), onExit: () => {} });
  assert.equal(attachment.scrollback, 'hello ');

  spawned[0].emitData('world');
  assert.deepEqual(received, ['world']);

  attachment.detach();
  spawned[0].emitData('!');
  assert.deepEqual(received, ['world']);
});

test('scrollback keeps only the most recent output within the limit', () => {
  const { registry, spawned } = setup(10);
  const { id } = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  spawned[0].emitData('0123456789');
  spawned[0].emitData('abcdef');

  const { scrollback } = registry.attach(id, { onData: () => {}, onExit: () => {} });
  assert.equal(scrollback, '6789abcdef');
});

test('scrollback trim never starts the replay inside an escape sequence or a surrogate pair', () => {
  const cases: Array<{ name: string; limit: number; chunks: string[]; replay: string }> = [
    { name: 'CSI', limit: 8, chunks: ['ab\x1b[1;31mred'], replay: 'red' },
    { name: 'OSC ended by BEL across chunks', limit: 10, chunks: ['x\x1b]0;title', '\x07after'], replay: 'after' },
    { name: 'OSC ended by ST', limit: 6, chunks: ['\x1b]8;;http://x\x1b\\', 'link'], replay: 'link' },
    { name: 'ESC with an intermediate', limit: 3, chunks: ['ab\x1b(Bcd'], replay: 'cd' },
    { name: 'emoji', limit: 3, chunks: ['a\u{1F600}bc'], replay: 'bc' },
    { name: 'sequence longer than the limit', limit: 5, chunks: ['\x1b]0;' + 'x'.repeat(10), 'yy\x07ok'], replay: 'ok' },
  ];
  for (const { name, limit, chunks, replay } of cases) {
    const { registry, spawned } = setup(limit);
    const { id } = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
    for (const chunk of chunks) spawned[0].emitData(chunk);
    assert.equal(registry.attach(id, { onData: () => {}, onExit: () => {} }).scrollback, replay, name);
  }
});

test('write and resize reach the pty; exit marks the terminal and notifies', () => {
  const { registry, spawned } = setup();
  const { id } = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  let exitCode: number | undefined;
  registry.attach(id, { onData: () => {}, onExit: (code) => { exitCode = code; } });

  registry.write(id, 'ls\r');
  registry.resize(id, 100, 30);
  assert.deepEqual(spawned[0].written, ['ls\r']);
  assert.deepEqual(spawned[0].size, [100, 30]);

  spawned[0].emitExit(3);
  assert.equal(exitCode, 3);
  assert.equal(registry.get(id)?.status, 'exited');
  assert.equal(registry.get(id)?.exitCode, 3);
  assert.equal(registry.get(id)?.exitSignal, undefined, 'no signal, no exitSignal');
});

test('a terminal killed by a signal reports it on its info and its exited event; signal 0 is none', () => {
  const { registry, spawned } = setup();
  const events: Array<[string, number | undefined, number | undefined]> = [];
  registry.subscribe(({ type, info }) => events.push([type, info.exitCode, info.exitSignal]));
  const killed = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const clean = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  spawned[0].emitExit(0, 9);
  spawned[1].emitExit(0, 0);
  assert.equal(registry.get(killed.id)?.exitSignal, 9);
  assert.equal(registry.get(clean.id)?.exitSignal, undefined);
  assert.deepEqual(events, [['created', undefined, undefined], ['created', undefined, undefined], ['exited', 0, 9], ['exited', 0, undefined]]);
});

test('close kills a running terminal and forgets it', () => {
  const { registry, spawned } = setup();
  const { id } = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.close(id);
  assert.equal(spawned[0].killed, true);
  assert.equal(registry.get(id), undefined);
  assert.deepEqual(registry.list(), []);
});

test('unknown ids are rejected', () => {
  const { registry } = setup();
  assert.throws(() => registry.attach('nope', { onData: () => {}, onExit: () => {} }), /unknown terminal/);
  assert.throws(() => registry.write('nope', 'x'), /unknown terminal/);
});

test('global agent args are appended, each quoted, to every agent created afterwards; shells get none', () => {
  const { registry, spawned } = setup();
  registry.addAgentArgs(['-e', "/opt/it's bridge.ts"]);
  registry.create({ cwd: '/w', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.create({ cwd: '/w', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });

  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/it'\\''s bridge.ts'`);
  assert.deepEqual(spawned[1].args, ['-i']);
  assert.equal(spawned[1].opts.env.MIRADOR_AGENT_COMMAND, undefined);
});

test('a request\'s own agent args follow the global ones, quoted, for that terminal only', () => {
  const { registry, spawned } = setup();
  registry.addAgentArgs(['-e', '/opt/bridge.ts']);
  registry.create({ cwd: '/w', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '', agentArgs: ['--session', '/s/it\'s $(x).jsonl'] });
  registry.create({ cwd: '/w', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.create({ cwd: '/w', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '', agentArgs: ['--session', '/s/a.jsonl'] });

  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/bridge.ts' '--session' '/s/it'\\''s $(x).jsonl'`);
  assert.equal(spawned[1].opts.env.MIRADOR_AGENT_COMMAND, `gentle-shell '-e' '/opt/bridge.ts'`);
  assert.deepEqual(spawned[2].args, ['-i'], 'a shell ignores agent args');
  assert.equal(spawned[2].opts.env.MIRADOR_AGENT_COMMAND, undefined);
});

test('a git terminal runs lazygit in its folder, with no agent command and no agent args', () => {
  const { registry, spawned } = setup();
  registry.addAgentArgs(['-e', '/opt/bridge.ts']);
  const info = registry.create({ cwd: '/w/repo', kind: 'git', cols: 80, rows: 24, workspaceId: 'dev', rel: 'repo', agentArgs: ['--session', '/s/a.jsonl'] });

  assert.equal(info.kind, 'git');
  assert.deepEqual(spawned[0].args, ['-ic', 'lazygit']);
  assert.equal(spawned[0].opts.cwd, '/w/repo');
  assert.equal(spawned[0].opts.env.MIRADOR_AGENT_COMMAND, undefined);
});

test('cleanEnv drops variables leaked by gentle-shell and Claude Code sessions', () => {
  const env = cleanEnv({
    HOME: '/home/you',
    PI_CODING_AGENT_DIR: '/home/you/.gentle-shell/agent',
    ENGRAM_BIN: '/x/engram-guard',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    MIRADOR_TOKEN: 'secret',
    LANG: 'es_CL.UTF-8',
  });
  assert.deepEqual(env, { HOME: '/home/you', LANG: 'es_CL.UTF-8' });
});

test('cleanEnv drops TMUX and TMUX_PANE leaked by a parent tmux session (F11 S2)', () => {
  const env = cleanEnv({
    HOME: '/home/you',
    TMUX: '/tmp/tmux-1000/default,1234,0',
    TMUX_PANE: '%3',
  });
  assert.deepEqual(env, { HOME: '/home/you' });
});

test('cleanEnv keeps the variables it kept before, including the other TMUX* names and TERM', () => {
  const kept = {
    HOME: '/home/you',
    PATH: '/usr/bin:/bin',
    TERM: 'tmux-256color',
    TERM_PROGRAM: 'tmux',
    COLORTERM: 'truecolor',
    TMUX_TMPDIR: '/run/user/1000',
    TMUX_PLUGIN_MANAGER_PATH: '/home/you/.tmux/plugins',
    MYTMUX: '1',
    tmux: 'lowercase',
    SHELL: '/bin/bash',
    LANG: 'es_CL.UTF-8',
  };
  assert.deepEqual(cleanEnv({ ...kept, EMPTY: undefined }), kept);
});
