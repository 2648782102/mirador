// Mirador reads gentle-ai's `installed_agents` and never fails on it.
// Every test points GENTLE_AI_HOME (or HOME) at a scratch directory, never the real home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gentleAiStatePath, readInstalledAgents } from '../src/agents/gentle-ai-state.ts';

let scratch: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-gentle-ai-state-')));
});

after(() => rm(scratch, { recursive: true, force: true }));

async function stateIn(name: string, content: string): Promise<string> {
  await mkdir(join(scratch, name), { recursive: true });
  await writeFile(join(scratch, name, 'state.json'), content);
  return join(scratch, name);
}

test('the state file is ${GENTLE_AI_HOME:-$HOME/.gentle-ai}/state.json', () => {
  assert.equal(gentleAiStatePath({ GENTLE_AI_HOME: '/opt/gai', HOME: '/home/u' }), '/opt/gai/state.json');
  assert.equal(gentleAiStatePath({ HOME: '/home/u' }), '/home/u/.gentle-ai/state.json');
  assert.equal(gentleAiStatePath({ GENTLE_AI_HOME: '', HOME: '/home/u' }), '/home/u/.gentle-ai/state.json');
});

test('installed_agents is read as gentle-ai wrote it, unknown ids included', async () => {
  const home = await stateIn('full', JSON.stringify({ installed_agents: ['claude-code', 'opencode', 'pi', 'openclaw', 'vscode-copilot', 'antigravity', 'hermes'], other: 1 }));
  assert.deepEqual(await readInstalledAgents({ GENTLE_AI_HOME: home }), ['claude-code', 'opencode', 'pi', 'openclaw', 'vscode-copilot', 'antigravity', 'hermes']);
});

test('HOME is used when GENTLE_AI_HOME is unset', async () => {
  await mkdir(join(scratch, 'home', '.gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'home', '.gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['pi'] }));
  assert.deepEqual(await readInstalledAgents({ HOME: join(scratch, 'home') }), ['pi']);
});

test('a missing state file gives an empty list', async () => {
  assert.deepEqual(await readInstalledAgents({ GENTLE_AI_HOME: join(scratch, 'nowhere') }), []);
});

test('unreadable JSON gives an empty list', async () => {
  for (const [name, content] of [['truncated', '{"installed_agents": ["pi"'], ['empty', ''], ['text', 'not json']]) {
    assert.deepEqual(await readInstalledAgents({ GENTLE_AI_HOME: await stateIn(name, content) }), [], name);
  }
});

test('a missing or malformed installed_agents field gives an empty list', async () => {
  for (const [name, content] of [
    ['no-field', '{"version": 2}'],
    ['null-field', '{"installed_agents": null}'],
    ['string-field', '{"installed_agents": "pi"}'],
    ['object-field', '{"installed_agents": {"pi": true}}'],
    ['array-root', '["pi"]'],
    ['null-root', 'null'],
  ]) {
    assert.deepEqual(await readInstalledAgents({ GENTLE_AI_HOME: await stateIn(name, content) }), [], name);
  }
});

test('entries that are not ids are skipped, leaving a partial list', async () => {
  const home = await stateIn('mixed', JSON.stringify({ installed_agents: ['pi', 3, null, '', { id: 'x' }, 'claude-code', 'pi'] }));
  assert.deepEqual(await readInstalledAgents({ GENTLE_AI_HOME: home }), ['pi', 'claude-code']);
});

test('a state path that is a directory gives an empty list', async () => {
  await mkdir(join(scratch, 'dir', 'state.json'), { recursive: true });
  assert.deepEqual(await readInstalledAgents({ GENTLE_AI_HOME: join(scratch, 'dir') }), []);
});
