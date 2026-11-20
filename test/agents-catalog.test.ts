// The agent catalog, the agents Mirador offers, and
// Pi / gentle-shell launching and resuming exactly as before. Fake binaries live in a scratch
// PATH and are never run; gentle-ai's state is a scratch GENTLE_AI_HOME, never the real one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeArgs, resumeArgs } from '../src/attention/agent-args.ts';
import { AGENTS, agentFor, agentLaunch, offeredAgents } from '../src/agents/catalog.ts';

let scratch: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-agents-catalog-')));
});

after(() => rm(scratch, { recursive: true, force: true }));

/** A PATH directory holding executable stubs (and non-executable files for `plain`). */
async function binDir(name: string, executables: string[], plain: string[] = []): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  for (const program of executables) {
    await writeFile(join(dir, program), '#!/bin/sh\nexit 99\n');
    await chmod(join(dir, program), 0o755);
  }
  for (const program of plain) await writeFile(join(dir, program), '#!/bin/sh\nexit 99\n', { mode: 0o644 });
  return dir;
}

async function gentleAi(name: string, installed: unknown[]): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ installed_agents: installed }));
  return dir;
}

const USER_INSTALLED = ['claude-code', 'opencode', 'pi', 'openclaw', 'vscode-copilot', 'antigravity', 'hermes'];

test('the catalog holds the terminal agents by gentle-ai id, and no IDE-only ids', () => {
  assert.deepEqual(AGENTS.map((a) => [a.id, a.binary]), [
    ['pi', 'gentle-shell'],
    ['claude-code', 'claude'],
    ['opencode', 'opencode'],
    ['antigravity', 'agy'],
    ['codex', 'codex'],
    ['gemini-cli', 'gemini'],
    ['kimi', 'kimi'],
  ]);
  for (const ide of ['cursor', 'vscode-copilot', 'windsurf', 'kiro-ide', 'trae-ide']) {
    assert.equal(AGENTS.some((a) => a.id === ide), false, ide);
  }
  for (const agent of AGENTS) assert.equal(agent.launch[0], agent.binary, `${agent.id} launches its binary`);
});

test('only pi, claude-code (S8), opencode (S9) and antigravity (S10) have verified resume and attention; the others record launch info only', () => {
  const pi = AGENTS.find((a) => a.id === 'pi');
  assert.deepEqual(pi?.resume, ['--session', '{session}']);
  assert.equal(pi?.attention, 'hooks');
  for (const agent of AGENTS.filter((a) => !['pi', 'claude-code', 'opencode', 'antigravity'].includes(a.id))) {
    assert.equal(agent.resume, null, agent.id);
    assert.equal(agent.attention, 'none', agent.id);
    assert.equal(agent.bridgeFlag, null, agent.id);
  }
});

test('offered = installed ∩ catalog ∩ PATH, after the configured agentCommand', async () => {
  const PATH = [
    await binDir('bin-a', ['gentle-shell', 'claude', 'cursor', 'openclaw', 'hermes']),
    join(scratch, 'not-there'),
    await binDir('bin-b', ['opencode', 'agy', 'kimi'], ['codex']),
  ].join(':');
  const GENTLE_AI_HOME = await gentleAi('gai-user', [...USER_INSTALLED, 'codex', 'cursor', 'gemini-cli']);
  const offered = await offeredAgents({ agentCommand: 'gentle-shell', env: { PATH, GENTLE_AI_HOME } });
  // pi is the configured agent; codex is not executable, gemini is not on PATH, kimi is not installed,
  // cursor and vscode-copilot are IDEs, openclaw and hermes are not in the catalog.
  assert.deepEqual(offered, [
    { id: 'pi', label: 'Pi (gentle-shell)', command: 'gentle-shell', configured: true, attention: 'hooks', resume: true },
    { id: 'claude-code', label: 'Claude Code', command: 'claude', configured: false, attention: 'hooks', resume: true },
    { id: 'opencode', label: 'opencode', command: 'opencode', configured: false, attention: 'hooks', resume: true },
    { id: 'antigravity', label: 'Antigravity', command: 'agy', configured: false, attention: 'hooks', resume: true },
  ]);
});

test('a catalog agent is offered on its own when the configured command is another one', async () => {
  const PATH = await binDir('bin-c', ['gentle-shell', 'claude']);
  const GENTLE_AI_HOME = await gentleAi('gai-c', ['pi', 'claude-code']);
  const offered = await offeredAgents({ agentCommand: 'claude --verbose', env: { PATH, GENTLE_AI_HOME } });
  assert.deepEqual(offered.map((a) => [a.id, a.command, a.configured]), [
    ['claude-code', 'claude --verbose', true],
    ['pi', 'gentle-shell', false],
  ]);
});

test('the configured agentCommand is always offered, even with no gentle-ai state and nothing on PATH', async () => {
  const env = { PATH: join(scratch, 'not-there'), GENTLE_AI_HOME: join(scratch, 'no-gentle-ai') };
  assert.deepEqual(await offeredAgents({ agentCommand: 'gentle-shell', env }), [
    { id: 'pi', label: 'Pi (gentle-shell)', command: 'gentle-shell', configured: true, attention: 'hooks', resume: true },
  ]);
  assert.deepEqual(await offeredAgents({ agentCommand: 'my-agent --fast', env }), [
    { id: null, label: 'my-agent --fast', command: 'my-agent --fast', configured: true, attention: 'none', resume: false },
  ]);
  // A command Mirador cannot add words to gets neither attention nor resume, as before.
  assert.deepEqual(await offeredAgents({ agentCommand: 'gentle-shell; echo done', env }), [
    { id: null, label: 'gentle-shell; echo done', command: 'gentle-shell; echo done', configured: true, attention: 'none', resume: false },
  ]);
});

test('unknown and IDE ids in gentle-ai state are dropped, never an error', async () => {
  const PATH = await binDir('bin-d', ['cursor', 'windsurf', 'openclaw', 'hermes']);
  const GENTLE_AI_HOME = await gentleAi('gai-d', ['cursor', 'windsurf', 'kiro-ide', 'trae-ide', 'vscode-copilot', 'openclaw', 'hermes', 'made-up']);
  assert.deepEqual((await offeredAgents({ agentCommand: 'bash', env: { PATH, GENTLE_AI_HOME } })).map((a) => a.id), [null]);
});

test('agentFor recognises a plain catalog command by its program name', () => {
  for (const command of ['gentle-shell', '  gentle-shell --model sonnet', '/home/u/.local/bin/gentle-shell', 'pi', 'pi --thinking high']) {
    assert.equal(agentFor(command)?.id, 'pi', command);
  }
  assert.equal(agentFor('claude')?.id, 'claude-code');
  assert.equal(agentFor('agy -c')?.id, 'antigravity');
  for (const command of ['', 'bash', 'gentle-shellx', 'env FOO=1 gentle-shell', 'gentle-shell && clear', 'gentle-shell # note']) {
    assert.equal(agentFor(command), null, JSON.stringify(command));
  }
});

// The same words as before — `-e <bridge>` and `--session <file>` for a plain gentle-shell or pi, nothing else.
test('gentle-shell and pi keep their bridge and --session resume; every other command gets neither', () => {
  const bridge = '/opt/mirador/src/attention/gentle-shell-bridge.ts';
  const session = "/home/u/.pi/sessions/it's a.jsonl";
  for (const command of ['gentle-shell', '  gentle-shell  ', 'gentle-shell --model sonnet', '/home/you/.local/bin/gentle-shell', '~/bin/gentle-shell', 'pi', 'pi --thinking high']) {
    assert.deepEqual(bridgeArgs(command, bridge), ['-e', bridge], command);
    assert.deepEqual(resumeArgs(command, session), ['--session', session], command);
  }
  for (const command of ['', 'claude', 'opencode', 'agy', 'codex', 'gemini', 'kimi', 'bash', 'gentle-shellx', 'env FOO=1 gentle-shell', 'gentle-shell; echo done', 'gentle-shell && clear', 'gentle-shell | tee log', 'gentle-shell # note', 'gentle-shell $(cat flags)', 'gentle-shell `cat flags`', 'gentle-shell > log', 'gentle-shell \\\n --x']) {
    assert.deepEqual(bridgeArgs(command, bridge), [], JSON.stringify(command));
    assert.deepEqual(resumeArgs(command, session), [], JSON.stringify(command));
  }
  // attentionBridge: false drops the bridge only; resume never depended on it.
  assert.deepEqual(bridgeArgs('gentle-shell', bridge, false), []);
  assert.deepEqual(resumeArgs('gentle-shell', session), ['--session', session]);
});

test('S4: a chosen agent starts by its own launch line, the configured one exactly as without an id', () => {
  assert.deepEqual(agentLaunch('pi', 'gentle-shell'), { agent: 'pi' });
  assert.deepEqual(agentLaunch('pi', 'pi --thinking high'), { agent: 'pi' }, 'the configured command keeps its own flags');
  assert.deepEqual(agentLaunch('claude-code', 'gentle-shell'), { agent: 'claude-code', agentCommand: 'claude' });
  assert.deepEqual(agentLaunch('pi', 'claude'), { agent: 'pi', agentCommand: 'gentle-shell' });
  assert.equal(agentLaunch('openclaw', 'gentle-shell'), null, 'not in the catalog');
  assert.equal(agentLaunch('nope', 'gentle-shell'), null);
});
