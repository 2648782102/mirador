import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../src/config.ts';
import { InvalidFolderError } from '../src/folders/tree.ts';
import { InvalidWorkspaceError, UnknownWorkspaceError, WorkspaceStore } from '../src/workspaces/store.ts';

let scratch: string;
let dev: string;
let work: string;
let outside: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-ws-')));
  dev = join(scratch, 'Dev');
  work = join(scratch, 'Work');
  outside = join(scratch, 'outside');
  for (const dir of [join(dev, 'web', 'vigia'), join(dev, 'tools'), join(dev, 'games'), work, outside]) await mkdir(dir, { recursive: true });
  await symlink(outside, join(dev, 'escape'));
});

after(() => rm(scratch, { recursive: true, force: true }));

function setup(workspaces: Workspace[] = [{ id: 'dev', name: 'Dev', root: dev, folders: [], expanded: [] }]) {
  const saved: Workspace[][] = [];
  const store = new WorkspaceStore(workspaces, async (list) => { saved.push(structuredClone(list)); });
  return { store, saved };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof InvalidWorkspaceError && error.code === code);
}

test('adding a workspace saves it with an id from its name, unique among the others', async () => {
  const { store, saved } = setup();
  const added = await store.add({ name: '  Trabajo Cliente  ', root: work });
  assert.deepEqual(added, { id: 'trabajo-cliente', name: 'Trabajo Cliente', root: work, folders: [], expanded: [] });
  const again = await store.add({ name: 'Trabajo cliente', root: `${work}/` });
  assert.equal(again.id, 'trabajo-cliente-2');
  assert.equal(again.root, work);
  assert.deepEqual(saved.at(-1)?.map((w) => w.id), ['dev', 'trabajo-cliente', 'trabajo-cliente-2']);
});

test('a workspace without a name takes its folder name; ~ means the home folder', async () => {
  const { store } = setup();
  const added = await store.add({ root: work });
  assert.equal(added.name, 'Work');
  assert.equal(added.id, 'work');
  const fromHome = await store.add({ name: 'Home work', root: '~/Work' }, { HOME: scratch });
  assert.equal(fromHome.root, work);
});

test('adding needs an existing absolute folder and a short printable name', async () => {
  const { store, saved } = setup();
  await rejectsWith(store.add({ name: 'x', root: 'relative/path' }), 'workspace_root');
  await rejectsWith(store.add({ name: 'x', root: join(scratch, 'missing') }), 'workspace_root');
  await rejectsWith(store.add({ name: 'x', root: 42 }), 'workspace_root');
  await rejectsWith(store.add({ name: 'x'.repeat(61), root: work }), 'workspace_name');
  await rejectsWith(store.add({ name: 'bad\nname', root: work }), 'workspace_name');
  await rejectsWith(store.add({ name: 'x', root: work, folders: ['a'] } as Record<string, unknown>), 'unknown_field');
  assert.equal(saved.length, 0);
});

test('renaming keeps the id; a blank name is refused', async () => {
  const { store } = setup();
  const renamed = await store.update('dev', { name: 'Desarrollo' });
  assert.deepEqual([renamed.id, renamed.name], ['dev', 'Desarrollo']);
  await rejectsWith(store.update('dev', { name: '   ' }), 'workspace_name');
});

test('chosen folders must be folders inside the root; they are stored normalized, sorted and once', async () => {
  const { store } = setup();
  const updated = await store.update('dev', { folders: ['tools/', 'web/vigia', 'Games/../games', 'tools'] });
  assert.deepEqual(updated.folders, ['games', 'tools', 'web/vigia']);
  await rejectsWith(store.update('dev', { folders: ['../Work'] }), 'workspace_folders');
  await rejectsWith(store.update('dev', { folders: ['escape'] }), 'workspace_folders');
  await rejectsWith(store.update('dev', { folders: ['missing'] }), 'workspace_folders');
  await rejectsWith(store.update('dev', { folders: [''] }), 'workspace_folders');
  await rejectsWith(store.update('dev', { folders: 'tools' }), 'workspace_folders');
  assert.deepEqual(store.get('dev')?.folders, ['games', 'tools', 'web/vigia']);
});

test('a saved folder deleted on disk does not block saving the picker; new entries are still checked', async () => {
  await mkdir(join(dev, 'deleted'));
  const { store, saved } = setup([{ id: 'dev', name: 'Dev', root: dev, folders: ['deleted', 'tools'], expanded: [], projects: ['deleted'] }]);
  await rm(join(dev, 'deleted'), { recursive: true });
  const updated = await store.update('dev', { folders: ['tools', 'deleted', 'games'], projects: ['deleted/', 'tools'] });
  assert.deepEqual(updated.folders, ['deleted', 'games', 'tools']);
  assert.deepEqual(updated.projects, ['deleted', 'tools']);
  assert.deepEqual(saved.at(-1), [{ id: 'dev', name: 'Dev', root: dev, folders: ['deleted', 'games', 'tools'], expanded: [], projects: ['deleted', 'tools'] }]);
  await rejectsWith(store.update('dev', { folders: ['deleted', 'missing'] }), 'workspace_folders');
  await rejectsWith(store.update('dev', { projects: ['deleted', 'escape'] }), 'workspace_projects');
  assert.equal(saved.length, 1);
  assert.deepEqual(store.get('dev')?.folders, ['deleted', 'games', 'tools']);
});

test('expanded folders are relative paths without .. and are kept once', async () => {
  const { store } = setup();
  const updated = await store.update('dev', { expanded: ['web', 'web/', 'tools/x'] });
  assert.deepEqual(updated.expanded, ['tools/x', 'web']);
  await rejectsWith(store.update('dev', { expanded: ['/etc'] }), 'workspace_expanded');
  await rejectsWith(store.update('dev', { expanded: ['web/../..'] }), 'workspace_expanded');
  await rejectsWith(store.update('dev', { expanded: [1] }), 'workspace_expanded');
});

test('a workspace root cannot be changed after it is added', async () => {
  const { store } = setup();
  await rejectsWith(store.update('dev', { root: work }), 'unknown_field');
});

test('removing a workspace only edits the list; its folder stays on disk', async () => {
  const { store, saved } = setup();
  await store.remove('dev');
  assert.deepEqual(store.list(), []);
  assert.deepEqual(saved.at(-1), []);
  assert.ok((await stat(dev)).isDirectory());
});

test('unknown workspace ids are reported as such', async () => {
  const { store } = setup();
  await assert.rejects(store.update('nope', { name: 'x' }), UnknownWorkspaceError);
  await assert.rejects(store.remove('nope'), UnknownWorkspaceError);
  await assert.rejects(store.resolve('nope', ''), UnknownWorkspaceError);
});

test('resolve guards every path with that workspace root', async () => {
  const { store } = setup([
    { id: 'dev', name: 'Dev', root: dev, folders: [], expanded: [] },
    { id: 'work', name: 'Work', root: work, folders: [], expanded: [] },
  ]);
  assert.deepEqual(await store.resolve('dev', 'web/vigia/'), { workspace: store.get('dev'), path: join(dev, 'web', 'vigia'), rel: 'web/vigia' });
  assert.deepEqual(await store.resolve('work', ''), { workspace: store.get('work'), path: work, rel: '' });
  await assert.rejects(store.resolve('work', '../Dev'), InvalidFolderError);
  await assert.rejects(store.resolve('dev', 'escape'), InvalidFolderError);
  await assert.rejects(store.resolve('dev', outside), InvalidFolderError);
});

test('a workspace whose folder disappeared says so instead of failing', async () => {
  const gone = join(scratch, 'gone');
  await mkdir(join(gone, 'app'), { recursive: true });
  const { store } = setup([{ id: 'gone', name: 'Gone', root: gone, folders: [], expanded: [] }]);
  await rm(gone, { recursive: true });
  await rejectsWith(store.resolve('gone', ''), 'workspace_root_missing');
  await rejectsWith(store.update('gone', { folders: ['app'] }), 'workspace_root_missing');
  assert.equal(store.get('gone')?.name, 'Gone', 'it can still be renamed or removed');
  await store.remove('gone');
});

test('saves run one after another, so the last change always wins on disk', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new WorkspaceStore([{ id: 'dev', name: 'Dev', root: dev, folders: [], expanded: [] }], async (list) => {
    if (!order.length) await gate;
    order.push(list[0].name);
  });
  const first = store.update('dev', { name: 'One' });
  const second = store.update('dev', { name: 'Two' });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['One', 'Two']);
});

test('while the config holds workspaces Mirador could not read, no change is saved or applied', async () => {
  const saved: Workspace[][] = [];
  const store = new WorkspaceStore([{ id: 'dev', name: 'Dev', root: dev, folders: [], expanded: [] }], async (list) => { saved.push(list); }, {
    problems: ['workspaces[1] has no id, name or root'],
  });
  await rejectsWith(store.add({ root: work }), 'workspace_config');
  await rejectsWith(store.update('dev', { name: 'Renamed' }), 'workspace_config');
  await rejectsWith(store.update('dev', { expanded: ['web'] }), 'workspace_config');
  await rejectsWith(store.remove('dev'), 'workspace_config');
  await assert.rejects(store.update('dev', { name: 'Renamed' }), /workspaces\[1\] has no id, name or root/);
  assert.deepEqual(saved, []);
  assert.deepEqual(store.list().map((w) => [w.id, w.name, w.expanded]), [['dev', 'Dev', []]]);
  assert.equal((await store.resolve('dev', 'web')).rel, 'web', 'reading still works');
});
