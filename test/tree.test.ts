import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeFolders, listFolders, resolveInsideRoot, InvalidFolderError } from '../src/folders/tree.ts';

const IGNORE = ['node_modules', 'bin', 'obj'];
let root: string;
let outside: string;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mirador-tree-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'mirador-outside-')));
  await mkdir(join(root, 'web', 'vigia', '.git'), { recursive: true });
  await mkdir(join(root, 'web', 'vigia', 'node_modules'), { recursive: true });
  await mkdir(join(root, 'web', 'zeta', 'src'), { recursive: true });
  await mkdir(join(root, 'Games'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'notes.txt'), 'not a folder');
  await symlink(outside, join(root, 'escape'));
  await symlink(join(root, 'web'), join(root, 'web-link'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('lists only visible subfolders of the root, sorted case-insensitively', async () => {
  const nodes = await listFolders(root, '', IGNORE);
  assert.deepEqual(nodes.map((n) => n.name), ['empty', 'Games', 'web', 'web-link']);
});

test('reports children, git repos and paths relative to the root', async () => {
  const [vigia, zeta] = await listFolders(root, 'web', IGNORE);
  assert.deepEqual(vigia, { name: 'vigia', rel: 'web/vigia', path: join(root, 'web', 'vigia'), hasChildren: false, isRepo: true });
  assert.deepEqual(zeta, { name: 'zeta', rel: 'web/zeta', path: join(root, 'web', 'zeta'), hasChildren: true, isRepo: false });
});

test('skips symlinks that point outside the root', async () => {
  const names = (await listFolders(root, '', IGNORE)).map((n) => n.name);
  assert.ok(!names.includes('escape'));
});

test('resolveInsideRoot accepts the root itself and nested folders', async () => {
  assert.equal(await resolveInsideRoot(root, ''), root);
  assert.equal(await resolveInsideRoot(root, 'web/zeta'), join(root, 'web', 'zeta'));
});

test('resolveInsideRoot rejects traversal, absolute paths and escaping symlinks', async () => {
  await assert.rejects(resolveInsideRoot(root, '../'), InvalidFolderError);
  await assert.rejects(resolveInsideRoot(root, outside), InvalidFolderError);
  await assert.rejects(resolveInsideRoot(root, 'escape'), InvalidFolderError);
});

test('resolveInsideRoot rejects a sibling folder that shares the root prefix', async () => {
  const sibling = `${root}-sibling`;
  await mkdir(sibling, { recursive: true });
  try {
    await assert.rejects(resolveInsideRoot(root, `../${sibling.split('/').pop()}`), InvalidFolderError);
  } finally {
    await rm(sibling, { recursive: true, force: true });
  }
});

test('resolveInsideRoot rejects files and missing folders', async () => {
  await assert.rejects(resolveInsideRoot(root, 'notes.txt'), InvalidFolderError);
  await assert.rejects(resolveInsideRoot(root, 'missing'), InvalidFolderError);
});

test('a root of / still resolves folders below it', async () => {
  assert.equal(await resolveInsideRoot('/', root.slice(1)), root);
});

test('describeFolders lists chosen folders by their path from the root and skips stale or escaping ones', async () => {
  const nodes = await describeFolders(root, ['Games', 'web/vigia', 'gone', 'escape', '../'], IGNORE);
  assert.deepEqual(nodes, [
    { name: 'Games', rel: 'Games', path: join(root, 'Games'), hasChildren: false, isRepo: false },
    { name: 'web/vigia', rel: 'web/vigia', path: join(root, 'web', 'vigia'), hasChildren: false, isRepo: true },
  ]);
});
