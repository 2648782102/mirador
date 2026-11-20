// The repo's config.example.json, copied as the README says,
// loads without problems and sets up a plain machine: bash as the agent, auto mode, one workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const EXAMPLE = fileURLToPath(new URL('../config.example.json', import.meta.url));

test('config.example.json loads without problems: bash, auto mode, one workspace', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mirador-config-example-')));
  try {
    const config = await loadConfig(EXAMPLE, { HOME: home });
    assert.deepEqual(config.workspaceProblems, []);
    assert.deepEqual(config.launchProblems, []);
    assert.equal(config.agentCommand, 'bash');
    assert.equal(config.mode, 'auto');
    assert.equal(config.workspaces.length, 1);
    const [workspace] = config.workspaces;
    assert.ok(workspace.id && workspace.name && workspace.root.startsWith('/'), JSON.stringify(workspace));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
