// The saved project set of a workspace: validated like
// `folders`, stored as `projects` with the workspace in config.json, absent when empty.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveSettings, type Workspace } from '../src/config.ts';
import { InvalidWorkspaceError, WorkspaceStore } from '../src/workspaces/store.ts';

let scratch: string;
let root: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-ws-projects-')));
  root = join(scratch, 'Dev');
  for (const dir of [join(root, 'web', 'vigia'), join(root, 'tools'), join(root, 'games'), join(scratch, 'outside')]) await mkdir(dir, { recursive: true });
  await symlink(join(scratch, 'outside'), join(root, 'escape'));
});

after(() => rm(scratch, { recursive: true, force: true }));

function setup(workspaces: Workspace[] = [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }]) {
  const saved: Workspace[][] = [];
  const store = new WorkspaceStore(workspaces, async (list) => { saved.push(structuredClone(list)); });
  return { store, saved };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof InvalidWorkspaceError && error.code === code);
}

test('a project set is stored normalized, sorted and once, and saved with the workspace', async () => {
  const { store, saved } = setup();
  const updated = await store.update('dev', { projects: ['tools/', 'web/vigia', 'Games/../games', 'tools'] });
  assert.deepEqual(updated.projects, ['games', 'tools', 'web/vigia']);
  assert.deepEqual(store.get('dev')?.projects, ['games', 'tools', 'web/vigia']);
  assert.deepEqual(saved.at(-1)?.[0].projects, ['games', 'tools', 'web/vigia']);
});

test('a project must be an existing folder inside the root; a rejected set changes and saves nothing', async () => {
  const { store, saved } = setup();
  await store.update('dev', { projects: ['tools'] });
  const writes = saved.length;
  for (const projects of [['../outside'], ['escape'], ['missing'], [''], ['.'], ['/etc'], [7], 'tools', null, Array.from({ length: 51 }, () => 'tools')]) {
    await rejectsWith(store.update('dev', { projects }), 'workspace_projects');
  }
  assert.deepEqual(store.get('dev')?.projects, ['tools']);
  assert.equal(saved.length, writes);
});

test('an empty project set removes the field', async () => {
  const { store } = setup();
  await store.update('dev', { projects: ['tools'] });
  const cleared = await store.update('dev', { projects: [] });
  assert.equal('projects' in cleared, false);
  assert.equal('projects' in (store.get('dev') ?? {}), false);
});

test('a project set survives a save and a reload; configs without one load as before', async () => {
  const dir = join(scratch, 'roundtrip');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'config.json');
  const other = { id: 'work', name: 'Work', root, folders: ['web'], expanded: ['web'] };
  await writeFile(path, JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }, other], custom: 1 }));
  const loaded = await loadConfig(path, { HOME: scratch });
  assert.equal('projects' in loaded.workspaces[0], false);
  const store = new WorkspaceStore(loaded.workspaces, (list) => saveSettings({ workspaces: list }, path, ['root']));
  await store.update('dev', { projects: ['web', 'tools'] });
  const file = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(file.workspaces[0].projects, ['tools', 'web']);
  assert.deepEqual(file.workspaces[1], other);
  assert.equal(file.custom, 1);
  assert.deepEqual((await loadConfig(path, { HOME: scratch })).workspaces[0].projects, ['tools', 'web']);
});

test('a hand-edited project list keeps only its text entries', async () => {
  const path = join(scratch, 'hand.json');
  await writeFile(path, JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, projects: ['tools', 3, null] }, { id: 'b', name: 'B', root, projects: 'tools' }] }));
  const loaded = await loadConfig(path, { HOME: scratch });
  assert.deepEqual(loaded.workspaceProblems, []);
  assert.deepEqual(loaded.workspaces[0].projects, ['tools']);
  assert.equal('projects' in loaded.workspaces[1], false);
});
