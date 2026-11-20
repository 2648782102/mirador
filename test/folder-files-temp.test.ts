// The editor's temp files: created owner-only, and stale ones left by a hard crash
// are swept on the next save in the same folder, never anything else. Temp folders only.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, lutimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvFromExample, readTextFile, writeTextFile } from '../src/files/folder-files.ts';

const MINUTE = 60 * 1000;

let scratch: string;
let root: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-files-temp-')));
  root = join(scratch, 'root');
  await mkdir(root, { recursive: true });
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function folderWith(name: string, files: Record<string, string>): Promise<string> {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(join(folder, file), content);
  return folder;
}

/**
 * Whether `folder` tells names apart by case (Linux file systems do; macOS's APFS by default does
 * not, so there `.…ab.TMP` and `.…AB.tmp` are one file and cannot both be look-alikes).
 */
async function caseSensitive(folder: string): Promise<boolean> {
  await writeFile(join(folder, '.case-probe'), '');
  const sensitive = await lstat(join(folder, '.CASE-PROBE')).then(() => false, () => true);
  await rm(join(folder, '.case-probe'));
  return sensitive;
}

async function save(folder: string, name: string, content: string) {
  const { version } = await readTextFile(root, folder, name);
  return writeTextFile(root, folder, name, content, version);
}

async function age(path: string, minutes: number, link = false): Promise<void> {
  const when = new Date(Date.now() - minutes * MINUTE);
  await (link ? lutimes(path, when, when) : utimes(path, when, when));
}

/** Replaces one fs/promises function for the module under test; returns the restore. */
function spy<K extends 'open' | 'unlink'>(name: K, replacement: (typeof fsp)[K]): () => void {
  const handle = mock.method(fsp, name, replacement as never);
  syncBuiltinESMExports();
  return () => {
    handle.mock.restore();
    syncBuiltinESMExports();
  };
}

test('a save removes a stale Mirador temp file left next to the target by a hard crash', async () => {
  const folder = await folderWith('stale', { '.env': 'A=1\n', 'notes.txt': 'one\n' });
  const stale = join(folder, '..env.mirador-0123456789ab.tmp');
  await writeFile(stale, 'SECRET=left by a crash\n');
  await age(stale, 11);

  const saved = await save(folder, 'notes.txt', 'two\n');
  assert.equal(saved.name, 'notes.txt');
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'two\n');
  assert.deepEqual((await readdir(folder)).sort(), ['.env', 'notes.txt']);
  assert.equal(await readFile(join(folder, '.env'), 'utf8'), 'A=1\n');
});

test('creating .env from .env.example also removes a stale temp file in that folder', async () => {
  const folder = await folderWith('stale-env', { '.env.example': 'A=\n' });
  const stale = join(folder, '..env.mirador-ba9876543210.tmp');
  await writeFile(stale, 'SECRET=left by a crash\n');
  await age(stale, 30);

  await createEnvFromExample(root, folder);
  assert.deepEqual((await readdir(folder)).sort(), ['.env', '.env.example']);
  assert.equal(await readFile(join(folder, '.env'), 'utf8'), 'A=\n');
});

test('the sweep keeps fresh temp files, look-alikes, folders and symlinks with a matching name', async () => {
  const folder = await folderWith('keep', { 'notes.txt': 'one\n', 'target.txt': 'linked\n' });
  // Younger than 10 minutes: may belong to a save still in flight.
  const fresh = '.notes.txt.mirador-aaaaaaaaaaaa.tmp';
  await writeFile(join(folder, fresh), 'fresh\n');
  await age(join(folder, fresh), 5);
  const lookAlikes = [
    'notes.txt.mirador-0123456789ab.tmp', // no leading dot
    '.notes.txt.mirador-0123456789AB.tmp', // upper-case hex
    '.notes.txt.mirador-0123456789a.tmp', // 11 hex digits
    '.notes.txt.mirador-0123456789abc.tmp', // 13 hex digits
    '.notes.txt.mirador-0123456789ab.tmp.bak',
    // Upper-case extension; on a case-insensitive file system (macOS) it is the upper-case hex file above.
    ...((await caseSensitive(folder)) ? ['.notes.txt.mirador-0123456789ab.TMP'] : []),
    '.mirador-0123456789ab.tmp', // no target name
    '.notes.txt-0123456789ab.tmp',
  ];
  for (const name of lookAlikes) {
    await writeFile(join(folder, name), 'user file\n');
    await age(join(folder, name), 60);
  }
  const dir = '.dir.mirador-bbbbbbbbbbbb.tmp';
  await mkdir(join(folder, dir));
  await age(join(folder, dir), 60);
  const link = '.link.mirador-cccccccccccc.tmp';
  await symlink(join(folder, 'target.txt'), join(folder, link));
  await age(join(folder, link), 60, true);

  await save(folder, 'notes.txt', 'two\n');
  assert.deepEqual((await readdir(folder)).sort(), ['notes.txt', 'target.txt', fresh, ...lookAlikes, dir, link].sort());
  assert.ok((await lstat(join(folder, link))).isSymbolicLink());
  assert.equal(await readFile(join(folder, 'target.txt'), 'utf8'), 'linked\n');
});

test('a failing sweep never fails the save', async () => {
  const folder = await folderWith('sweep-fails', { 'notes.txt': 'one\n' });
  const stale = join(folder, '.notes.txt.mirador-dddddddddddd.tmp');
  await writeFile(stale, 'old\n');
  await age(stale, 20);
  const realUnlink = fsp.unlink;
  let tried = false;
  const restore = spy('unlink', (async (path: Parameters<typeof fsp.unlink>[0]) => {
    if (String(path) === stale) tried = true;
    if (String(path) === stale) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return realUnlink(path);
  }) as typeof fsp.unlink);
  try {
    const saved = await save(folder, 'notes.txt', 'two\n');
    assert.equal(saved.size, 4);
  } finally {
    restore();
  }
  assert.ok(tried, 'the sweep tried to remove the stale temp file');
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'two\n');
  assert.equal(await readFile(stale, 'utf8'), 'old\n');

  // A folder Mirador can write into but not list: the save still works, nothing is swept.
  if (process.getuid?.() === 0) return; // root lists any folder
  await chmod(folder, 0o300);
  try {
    const { version } = await readTextFile(root, folder, 'notes.txt');
    assert.equal((await writeTextFile(root, folder, 'notes.txt', 'three\n', version)).size, 6);
  } finally {
    await chmod(folder, 0o755);
  }
  assert.equal(await readFile(join(folder, 'notes.txt'), 'utf8'), 'three\n');
  assert.deepEqual((await readdir(folder)).sort(), ['.notes.txt.mirador-dddddddddddd.tmp', 'notes.txt']);
});

test('temp files are created owner-only, and the saved file still gets the target mode', async () => {
  const folder = await folderWith('mode', { '.env': 'A=1\n', '.env.example': 'A=\n' });
  await chmod(join(folder, '.env'), 0o644);
  await chmod(join(folder, '.env.example'), 0o640);
  const realOpen = fsp.open;
  const created: Array<{ name: string; mode: number }> = [];
  const restore = spy('open', (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    const path = String(args[0]);
    // The mode the temp file has on disk the moment it exists, before any content arrives.
    if (path.includes('.mirador-')) created.push({ name: path.slice(folder.length + 1), mode: (await lstat(path)).mode & 0o7777 });
    return handle;
  }) as typeof fsp.open);
  try {
    await save(folder, '.env', 'A=2\n');
    assert.equal((await lstat(join(folder, '.env'))).mode & 0o7777, 0o644);
    await rm(join(folder, '.env'));
    await createEnvFromExample(root, folder);
  } finally {
    restore();
  }
  assert.equal(created.length, 2);
  for (const { name, mode } of created) {
    assert.match(name, /^\.\.env\.mirador-[0-9a-f]{12}\.tmp$/);
    assert.equal(mode, 0o600, `${name} was created with mode ${mode.toString(8)}`);
  }
  assert.equal((await lstat(join(folder, '.env'))).mode & 0o7777, 0o640);
  assert.deepEqual((await readdir(folder)).sort(), ['.env', '.env.example']);
});
