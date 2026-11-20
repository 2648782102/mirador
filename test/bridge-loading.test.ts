// Mirador loads the attention bridge itself: `-e <bridge>` appended to a plain gentle-shell
// (or pi) agent command, quoted so the agent rcfile's `eval` passes it as one word.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeArgs } from '../src/attention/agent-args.ts';
import { loadConfig } from '../src/config.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

let scratch: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bridge-loading-')));
});

after(() => rm(scratch, { recursive: true, force: true }));

test('attentionBridge is on unless the config turns it off with false', async () => {
  const load = async (name: string, saved?: unknown) => {
    await mkdir(join(scratch, name), { recursive: true });
    if (saved !== undefined) await writeFile(join(scratch, name, 'config.json'), JSON.stringify(saved));
    return (await loadConfig(join(scratch, name, 'config.json'), { HOME: scratch })).attentionBridge;
  };
  assert.equal(await load('none'), true);
  assert.equal(await load('unset', { port: 5000 }), true);
  assert.equal(await load('off', { attentionBridge: false }), false);
  assert.equal(await load('odd', { attentionBridge: 'no' }), true, 'only a real false turns it off');
});

test('the bridge is added to a plain gentle-shell or pi command, and to nothing else', () => {
  const bridge = '/opt/mirador/src/attention/gentle-shell-bridge.ts';
  for (const command of ['gentle-shell', '  gentle-shell  ', 'gentle-shell --model sonnet', '/home/you/.local/bin/gentle-shell', '~/bin/gentle-shell', 'pi', 'pi --thinking high']) {
    assert.deepEqual(bridgeArgs(command, bridge), ['-e', bridge], command);
  }
  for (const command of ['', 'claude', 'bash', 'gentle-shellx', 'env FOO=1 gentle-shell', 'gentle-shell; echo done', 'gentle-shell && clear', 'gentle-shell | tee log', 'gentle-shell # note', 'gentle-shell $(cat flags)', 'gentle-shell `cat flags`', 'gentle-shell > log', 'gentle-shell \\\n --x']) {
    assert.deepEqual(bridgeArgs(command, bridge), [], JSON.stringify(command));
  }
  assert.deepEqual(bridgeArgs('gentle-shell', bridge, false), [], 'attentionBridge: false');
});

class FakePty implements PtyProcess {
  env: Record<string, string>;
  constructor(env: Record<string, string>) { this.env = env; }
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

test('agent arguments reach the agent as exact words through the rcfile eval; shells and the base command are untouched', () => {
  const spawned: FakePty[] = [];
  const spawn: SpawnFn = (_file, _args, opts) => { const p = new FakePty(opts.env); spawned.push(p); return p; };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: "printf '%s\\n'", agentRcFile: '/run/rc', env: {}, scrollbackLimit: 100 });
  registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const awkward = "/home/m/My Projects/it's $HOME `x` \"q\"/bridge.ts";
  registry.addAgentArgs(['-e', awkward]);
  registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });

  assert.equal(spawned[0].env.MIRADOR_AGENT_COMMAND, "printf '%s\\n'", 'terminals created before keep the plain command');
  assert.equal(spawned[2].env.MIRADOR_AGENT_COMMAND, undefined);
  // What agent.bashrc does with the variable.
  const words = execFileSync('/bin/bash', ['-c', 'eval "$MIRADOR_AGENT_COMMAND"'], { env: { MIRADOR_AGENT_COMMAND: spawned[1].env.MIRADOR_AGENT_COMMAND }, encoding: 'utf8' });
  assert.deepEqual(words.split('\n').slice(0, -1), ['-e', awkward]);
});
