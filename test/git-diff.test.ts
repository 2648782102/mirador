// The read-only changes of a folder for the "Changes"
// panel (src/folders/git-diff.ts): the per-file stat and the unified diff of the work tree
// against HEAD (staged and unstaged), untracked files by name, binary files flagged, hard caps,
// and no write to the repository even when its config asks git to run programs. Every fixture
// lives in a fresh temp folder; git runs with no global or system config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { InvalidFolderError } from '../src/folders/tree.ts';
import { MAX_DIFF_BYTES, MAX_DIFF_FILES, MAX_FILE_DIFF_BYTES, MAX_UNTRACKED, folderGitDiff } from '../src/folders/git-diff.ts';

const fixtureEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: fixtureEnv, stdio: 'pipe' }).toString();
const commitAll = (cwd: string, subject: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', subject);
};

let scratch: string;
let root: string;
// A scratch HOME and XDG_CONFIG_HOME keep the tester's own ~/.gitconfig out.
const env = () => ({ ...process.env, HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'cfg') });
const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix} ${String(i).padStart(5, '0')}\n`).join('');

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-git-diff-')));
  root = join(scratch, 'root');
  await mkdir(root, { recursive: true });

  // work: a modified, a staged, a deleted, a renamed and a binary file, plus untracked ones.
  const work = join(root, 'work');
  await mkdir(work);
  git(work, 'init', '-q', '-b', 'main');
  await writeFile(join(work, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(work, 'b.txt'), 'bee\n');
  await writeFile(join(work, 'gone.txt'), 'x\ny\n');
  await writeFile(join(work, 'old.txt'), lines('kept', 20));
  await writeFile(join(work, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  commitAll(work, 'Start');
  await writeFile(join(work, 'a.txt'), 'one\nTWO\nthree\n');
  await writeFile(join(work, 'b.txt'), 'bee\nstaged line\n');
  git(work, 'add', 'b.txt');
  await rm(join(work, 'gone.txt'));
  git(work, 'mv', 'old.txt', 'new.txt');
  await writeFile(join(work, 'img.bin'), Buffer.from([0, 9, 9, 9, 0, 255, 7]));
  await writeFile(join(work, 'fresh.txt'), 'untracked\n');
  await mkdir(join(work, 'scratchpad'));
  await writeFile(join(work, 'scratchpad', 'inner.txt'), 'untracked too\n');

  // clean: a commit and nothing changed.
  const clean = join(root, 'clean');
  await mkdir(clean);
  git(clean, 'init', '-q', '-b', 'main');
  await writeFile(join(clean, 'a.txt'), 'a\n');
  commitAll(clean, 'Start');

  // unborn: no commit yet.
  const unborn = join(root, 'unborn');
  await mkdir(unborn);
  git(unborn, 'init', '-q', '-b', 'main');
  await writeFile(join(unborn, 'draft.md'), 'draft\n');

  // big: twelve files whose diffs pass the per-file cap and, together, the total cap.
  const big = join(root, 'big');
  await mkdir(big);
  git(big, 'init', '-q', '-b', 'main');
  for (let i = 0; i < 12; i++) await writeFile(join(big, `f${String(i).padStart(2, '0')}.txt`), '');
  commitAll(big, 'Empty files');
  for (let i = 0; i < 12; i++) await writeFile(join(big, `f${String(i).padStart(2, '0')}.txt`), lines(`file ${i} line`, 5000));

  // wide: more changed files than the list keeps, and more untracked files than it names.
  const wide = join(root, 'wide');
  await mkdir(wide);
  git(wide, 'init', '-q', '-b', 'main');
  for (let i = 0; i < MAX_DIFF_FILES + 5; i++) await writeFile(join(wide, `t${String(i).padStart(4, '0')}.txt`), 'a\n');
  commitAll(wide, 'Many files');
  for (let i = 0; i < MAX_DIFF_FILES + 5; i++) await writeFile(join(wide, `t${String(i).padStart(4, '0')}.txt`), 'b\n');
  for (let i = 0; i < MAX_UNTRACKED + 3; i++) await writeFile(join(wide, `u${String(i).padStart(4, '0')}.new`), 'u\n');

  // mono: one repo with two project folders; a folder shows only its own changes.
  const mono = join(root, 'mono');
  await mkdir(join(mono, 'api'), { recursive: true });
  await mkdir(join(mono, 'web'));
  git(mono, 'init', '-q', '-b', 'main');
  await writeFile(join(mono, 'api', 'server.ts'), 'old\n');
  await writeFile(join(mono, 'web', 'page.ts'), 'old\n');
  commitAll(mono, 'Start');
  await writeFile(join(mono, 'api', 'server.ts'), 'new\n');
  await writeFile(join(mono, 'web', 'page.ts'), 'new\n');
  await writeFile(join(mono, 'api', 'todo.md'), 'u\n');
  await writeFile(join(mono, 'web', 'todo.md'), 'u\n');

  await mkdir(join(root, 'plain'));
  await mkdir(join(scratch, 'outside'));

  // escaping: a repo inside the root whose core.worktree points outside it.
  const escaping = join(root, 'escaping');
  await mkdir(escaping);
  await mkdir(join(scratch, 'elsewhere'));
  await writeFile(join(scratch, 'elsewhere', 'outside-file.txt'), 'x');
  git(escaping, 'init', '-q', '-b', 'main');
  git(escaping, 'config', 'core.worktree', join(scratch, 'elsewhere'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test('staged and unstaged changes against HEAD come with their stat and their unified diff', async () => {
  const diff = await folderGitDiff(root, 'work', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'b.txt', 'gone.txt', 'img.bin', 'new.txt']);
  assert.deepEqual(
    { added: byPath['a.txt'].added, removed: byPath['a.txt'].removed, binary: byPath['a.txt'].binary, truncated: byPath['a.txt'].truncated },
    { added: 1, removed: 1, binary: false, truncated: false },
  );
  assert.equal(byPath['a.txt'].patch, 'diff --git a/a.txt b/a.txt\nindex 4cb29ea..ddc897f 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n');
  // The staged change shows like the unstaged one: both are against HEAD.
  assert.match(byPath['b.txt'].patch, /\n\+staged line\n$/);
  assert.deepEqual([byPath['b.txt'].added, byPath['b.txt'].removed], [1, 0]);
  assert.deepEqual([byPath['gone.txt'].added, byPath['gone.txt'].removed], [0, 2]);
  assert.match(byPath['gone.txt'].patch, /^deleted file mode/m);
  assert.equal(byPath['new.txt'].from, 'old.txt');
  assert.deepEqual([byPath['new.txt'].added, byPath['new.txt'].removed], [0, 0]);
  assert.match(byPath['new.txt'].patch, /^rename from old\.txt$/m);
  assert.equal(diff.totals.files, 5);
  assert.equal(diff.totals.added, 2);
  assert.equal(diff.totals.removed, 3);
  assert.equal(diff.complete, true);
});

test('a binary file is reported as binary, with no line counts and no content', async () => {
  const diff = await folderGitDiff(root, 'work', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  const image = diff.files.find((file) => file.path === 'img.bin');
  assert.equal(image?.binary, true);
  assert.equal(image?.added, null);
  assert.equal(image?.removed, null);
  assert.match(image?.patch ?? '', /^Binary files a\/img\.bin and b\/img\.bin differ$/m);
  assert.doesNotMatch(image?.patch ?? '', /\0/);
});

test('untracked files and folders are listed by name only', async () => {
  const diff = await folderGitDiff(root, 'work', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.deepEqual(diff.untracked, { count: 2, complete: true, paths: ['fresh.txt', 'scratchpad/'] });
  assert.doesNotMatch(JSON.stringify(diff.files), /untracked too/);
});

test('a clean repo has no changes', async () => {
  assert.deepEqual(await folderGitDiff(root, 'clean', { env: env() }), {
    available: true,
    totals: { files: 0, added: 0, removed: 0 },
    files: [],
    complete: true,
    untracked: { count: 0, complete: true, paths: [] },
  });
});

test('a folder inside a repo shows only its own changes, with paths from the repo root', async () => {
  const diff = await folderGitDiff(root, 'mono/api', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.deepEqual(diff.files.map((file) => file.path), ['api/server.ts']);
  assert.deepEqual(diff.untracked.paths, ['api/todo.md']);
});

test('one file\'s diff is cut at MAX_FILE_DIFF_BYTES on a line end, and the whole diff at MAX_DIFF_BYTES', async () => {
  const diff = await folderGitDiff(root, 'big', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.equal(diff.files.length, 12);
  assert.equal(diff.complete, false);
  // The stat still counts every line of every file.
  assert.ok(diff.files.every((file) => file.added === 5000 && file.removed === 0));
  assert.equal(diff.totals.added, 60000);
  const first = diff.files[0];
  assert.equal(first.truncated, true);
  assert.ok(Buffer.byteLength(first.patch) <= MAX_FILE_DIFF_BYTES, `${Buffer.byteLength(first.patch)} bytes`);
  assert.ok(Buffer.byteLength(first.patch) > MAX_FILE_DIFF_BYTES / 2);
  assert.match(first.patch, /^diff --git a\/f00\.txt b\/f00\.txt\n/);
  assert.match(first.patch, /\n\+file 0 line \d{5}\n$/);
  const total = diff.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch), 0);
  assert.ok(total <= MAX_DIFF_BYTES, `${total} bytes`);
  // Past the total cap a file keeps its stat, has no patch and says so.
  const last = diff.files[11];
  assert.equal(last.patch, '');
  assert.equal(last.truncated, true);
});

test('the changed files are counted in full and listed up to MAX_DIFF_FILES; untracked names up to MAX_UNTRACKED', async () => {
  const diff = await folderGitDiff(root, 'wide', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.equal(diff.totals.files, MAX_DIFF_FILES + 5);
  assert.equal(diff.totals.added, MAX_DIFF_FILES + 5);
  assert.equal(diff.files.length, MAX_DIFF_FILES);
  assert.equal(diff.complete, false);
  assert.equal(diff.untracked.count, MAX_UNTRACKED + 3);
  assert.equal(diff.untracked.paths.length, MAX_UNTRACKED);
  assert.equal(diff.untracked.paths[0], 'u0000.new');
});

test('a repo without commits, a folder that is no repo and a machine without git are "not available"', async () => {
  assert.deepEqual(await folderGitDiff(root, 'unborn', { env: env() }), { available: false, reason: 'no_commits' });
  assert.deepEqual(await folderGitDiff(root, 'plain', { env: env() }), { available: false, reason: 'not_repo' });
  const empty = join(scratch, 'empty-bin');
  await mkdir(empty, { recursive: true });
  assert.deepEqual(await folderGitDiff(root, 'work', { env: { ...env(), PATH: empty } }), { available: false, reason: 'git_missing' });
});

test('a folder outside the root is refused before git runs, and a work tree outside it is not read', async () => {
  await assert.rejects(folderGitDiff(root, '../outside', { env: env() }), InvalidFolderError);
  await assert.rejects(folderGitDiff(root, join(scratch, 'outside'), { env: env() }), InvalidFolderError);
  await assert.rejects(folderGitDiff(root, 'missing', { env: env() }), InvalidFolderError);
  const escaping = await folderGitDiff(root, 'escaping', { env: env() });
  assert.deepEqual(escaping, { available: false, reason: 'outside_root' });
  assert.doesNotMatch(JSON.stringify(escaping), /outside-file/);
});

test('GIT_DIR and GIT_WORK_TREE in Mirador\'s environment never point git at another repo', async () => {
  const leaked = { ...env(), GIT_DIR: join(root, 'work', '.git'), GIT_WORK_TREE: join(root, 'work') };
  assert.deepEqual(await folderGitDiff(root, 'plain', { env: leaked }), { available: false, reason: 'not_repo' });
});

/* ---------- No write, no program run ---------- */

/** Every file under .git with the sha-256 of its bytes: refs, HEAD, index, objects, config. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[relative(dir, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

test('a diff never runs a filter, textconv, external diff, hook or fsmonitor, and writes nothing to .git', async () => {
  const repo = join(root, 'trap');
  const markers = join(scratch, 'markers');
  await mkdir(repo);
  await mkdir(markers);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'code.txt'), 'one\n');
  await writeFile(join(repo, 'notes.md'), 'one\n');
  await writeFile(join(repo, '.gitattributes'), '*.txt filter=trap diff=trap\n*.md filter=a=b\n');
  commitAll(repo, 'Start');
  // Each program git could be told to run leaves its own marker file.
  const writer = (name: string, tail = '') => `sh -c 'touch "${join(markers, name)}"${tail}'`;
  const hooks = join(scratch, 'trap-hooks');
  await mkdir(hooks);
  for (const hook of ['post-index-change', 'pre-commit', 'post-checkout']) await writeFile(join(hooks, hook), `#!/bin/sh\ntouch '${join(markers, hook)}'\n`, { mode: 0o755 });
  await writeFile(join(scratch, 'trap-fsmonitor.sh'), `#!/bin/sh\ntouch '${join(markers, 'fsmonitor')}'\n`, { mode: 0o755 });
  const config: Array<[string, string]> = [
    ['filter.trap.clean', writer('clean', '; cat')],
    ['filter.trap.smudge', writer('smudge', '; cat')],
    ['filter.trap.process', writer('process')],
    ['filter.trap.required', 'true'],
    ['filter.a=b.clean', writer('clean-odd-name', '; cat')],
    ['diff.trap.textconv', writer('textconv', '; cat "$0"')],
    ['diff.trap.command', writer('diff-command')],
    ['diff.external', writer('diff-external')],
    ['core.hooksPath', hooks],
    ['core.fsmonitor', join(scratch, 'trap-fsmonitor.sh')],
    ['core.pager', writer('pager')],
  ];
  for (const [key, value] of config) git(repo, 'config', key, value);
  await writeFile(join(repo, 'code.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'notes.md'), 'one\ntwo\n');
  // A stale index: a plain `git diff` would refresh it, rewrite it and run post-index-change.
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  const before = await snapshot(join(repo, '.git'));
  const indexBefore = await stat(join(repo, '.git', 'index'));

  const diff = await folderGitDiff(root, 'trap', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.deepEqual(diff.files.map((file) => [file.path, file.added, file.removed]), [['code.txt', 1, 0], ['notes.md', 1, 0]]);
  assert.match(diff.files[0].patch, /\n\+two\n$/);

  assert.deepEqual(await readdir(markers), []);
  assert.deepEqual(await snapshot(join(repo, '.git')), before);
  assert.equal((await stat(join(repo, '.git', 'index'))).mtimeMs, indexBefore.mtimeMs);
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').trim().split('\n').length, 1);
});

/* ---------- A per-file cap on top of the total ---------- */

// Verifier advisory: git's raw patch output was read up to MAX_DIFF_BYTES once, so a huge
// first file filled the read and every later file came back with `patch: ''`.
test('a huge first file does not leave the other files without a diff; each huge file is cut at MAX_FILE_DIFF_BYTES', async () => {
  const repo = join(root, 'huge');
  const markers = join(scratch, 'huge-markers');
  const hooks = join(scratch, 'huge-hooks');
  await mkdir(repo);
  await mkdir(markers);
  await mkdir(hooks);
  git(repo, 'init', '-q', '-b', 'main');
  for (const name of ['a-huge.txt', 'm-huge.txt']) await writeFile(join(repo, name), '');
  await writeFile(join(repo, 'b-small.txt'), 'one\n');
  // Glob characters and a space: the paths are passed to git as literal pathspecs.
  await writeFile(join(repo, 'c [*].txt'), 'star\n');
  await writeFile(join(repo, 'd-old.txt'), lines('kept', 20));
  await writeFile(join(repo, 'f-touched.txt'), 'same\n');
  await writeFile(join(repo, 'z-last.txt'), 'last\n');
  commitAll(repo, 'Start');
  // About 2.3 MB and 1.1 MB of diff: each alone is more than MAX_DIFF_BYTES.
  await writeFile(join(repo, 'a-huge.txt'), lines('first huge line', 120_000));
  await writeFile(join(repo, 'b-small.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'c [*].txt'), 'star\nstars\n');
  git(repo, 'mv', 'd-old.txt', 'e-new.txt');
  await writeFile(join(repo, 'm-huge.txt'), lines('middle huge line', 60_000));
  await writeFile(join(repo, 'z-last.txt'), 'last\nreally last\n');
  // Stat-dirty, content-identical: neither listed nor a reason to refresh the index.
  const later = new Date(Date.now() + 3600_000);
  await utimes(join(repo, 'f-touched.txt'), later, later);
  // Installed after the fixture's own index writes (git mv fires it too).
  await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch '${join(markers, 'post-index-change')}'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.hooksPath', hooks);
  const index = join(repo, '.git', 'index');
  const indexBefore = createHash('sha256').update(await readFile(index)).digest('hex');

  const diff = await folderGitDiff(root, 'huge', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a-huge.txt', 'b-small.txt', 'c [*].txt', 'e-new.txt', 'm-huge.txt', 'z-last.txt']);
  for (const [path, prefix] of [['a-huge.txt', 'first'], ['m-huge.txt', 'middle']]) {
    const file = byPath[path];
    assert.equal(file.truncated, true, path);
    assert.ok(Buffer.byteLength(file.patch) <= MAX_FILE_DIFF_BYTES, `${path}: ${Buffer.byteLength(file.patch)} bytes`);
    assert.ok(Buffer.byteLength(file.patch) > MAX_FILE_DIFF_BYTES / 2, `${path}: ${Buffer.byteLength(file.patch)} bytes`);
    assert.match(file.patch, new RegExp(String.raw`^diff --git a/${path.replace('.', '\\.')} b/${path.replace('.', '\\.')}\n`));
    assert.match(file.patch, new RegExp(String.raw`\n\+${prefix} huge line \d{5}\n$`));
  }
  // The small files after (and between) the huge ones come whole.
  assert.deepEqual([byPath['b-small.txt'].truncated, byPath['b-small.txt'].added, byPath['b-small.txt'].removed], [false, 1, 0]);
  assert.match(byPath['b-small.txt'].patch, /^diff --git a\/b-small\.txt b\/b-small\.txt\n[\s\S]*\n@@ -1 \+1,2 @@\n one\n\+two\n$/);
  assert.equal(byPath['c [*].txt'].truncated, false);
  assert.match(byPath['c [*].txt'].patch, /^diff --git a\/c \[\*\]\.txt b\/c \[\*\]\.txt\n[\s\S]*\n@@ -1 \+1,2 @@\n star\n\+stars\n$/);
  assert.equal(byPath['e-new.txt'].from, 'd-old.txt');
  assert.equal(byPath['e-new.txt'].truncated, false);
  assert.match(byPath['e-new.txt'].patch, /^diff --git a\/d-old\.txt b\/e-new\.txt\nsimilarity index 100%\nrename from d-old\.txt\nrename to e-new\.txt\n$/);
  assert.equal(byPath['z-last.txt'].truncated, false);
  assert.match(byPath['z-last.txt'].patch, /\n@@ -1 \+1,2 @@\n last\n\+really last\n$/);
  assert.equal(diff.complete, false);
  assert.deepEqual([diff.totals.files, diff.totals.added, diff.totals.removed], [6, 180_003, 0]);
  const total = diff.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch), 0);
  assert.ok(total <= MAX_DIFF_BYTES, `${total} bytes`);
  // Every extra read is as read-only as the first.
  assert.equal(createHash('sha256').update(await readFile(index)).digest('hex'), indexBefore);
  assert.deepEqual(await readdir(markers), []);
});

test('a small file whose diff the total read cut short is read again and comes whole', async () => {
  const repo = join(root, 'straddle');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), '');
  await writeFile(join(repo, 'b.txt'), '');
  commitAll(repo, 'Empty files');
  // a.txt's diff is just under MAX_DIFF_BYTES, so the read ends inside b.txt's 28 KB diff.
  const aLines = 36_000;
  await writeFile(join(repo, 'a.txt'), lines('a line', aLines));
  await writeFile(join(repo, 'b.txt'), lines('b line', 2000));
  assert.ok(aLines * 14 < MAX_DIFF_BYTES && aLines * 14 + 2000 * 14 > MAX_DIFF_BYTES);

  const diff = await folderGitDiff(root, 'straddle', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  const [a, b] = diff.files;
  assert.equal(a.truncated, true);
  assert.ok(Buffer.byteLength(a.patch) <= MAX_FILE_DIFF_BYTES);
  assert.equal(b.path, 'b.txt');
  assert.equal(b.truncated, false);
  assert.match(b.patch, /^diff --git a\/b\.txt b\/b\.txt\n[\s\S]*\n@@ -0,0 \+1,2000 @@\n\+b line 00000\n/);
  assert.match(b.patch, /\n\+b line 01999\n$/);
  assert.equal(b.patch.split('\n').filter((line) => line.startsWith('+b line')).length, 2000);
  assert.equal(diff.complete, false);
});

// Verifier blocker: `git diff HEAD` refreshes the index on its own (diff.autoRefreshIndex,
// default true) when a tracked file's stat changed but its content did not; --no-optional-locks
// does not stop that write, nor the post-index-change hook it fires.
test('a tracked file touched without a content change is not listed, and the index is not refreshed', async () => {
  const repo = join(root, 'touched');
  const markers = join(scratch, 'touched-markers');
  const hooks = join(scratch, 'touched-hooks');
  await mkdir(repo);
  await mkdir(markers);
  await mkdir(hooks);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'same\n');
  await writeFile(join(repo, 'b.txt'), 'before\n');
  commitAll(repo, 'Start');
  await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch '${join(markers, 'post-index-change')}'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.hooksPath', hooks);
  // Stat-dirty, content-identical: only the mtime moves, an hour ahead.
  const later = new Date(Date.now() + 3600_000);
  await utimes(join(repo, 'a.txt'), later, later);
  await writeFile(join(repo, 'b.txt'), 'after\n');
  const index = join(repo, '.git', 'index');
  const before = createHash('sha256').update(await readFile(index)).digest('hex');

  const diff = await folderGitDiff(root, 'touched', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.deepEqual(diff.files.map((file) => file.path), ['b.txt']);
  assert.equal(createHash('sha256').update(await readFile(index)).digest('hex'), before);
  assert.deepEqual(await readdir(markers), []);
});

/* ---------- Verifier probes (independent verifier) ---------- */

test('twelve 100 KB files: eight whole 64 KiB cuts, a remainder, then empty patches, never above 512 KiB in all', async () => {
  const diff = await folderGitDiff(root, 'big', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.equal(diff.files.length, 12);
  const sizes = diff.files.map((file) => Buffer.byteLength(file.patch));
  assert.equal(sizes.filter((size) => size > MAX_FILE_DIFF_BYTES - 64 && size <= MAX_FILE_DIFF_BYTES).length, 8, JSON.stringify(sizes));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  assert.ok(total <= MAX_DIFF_BYTES, `${total} bytes`);
  for (const file of diff.files) {
    assert.equal(file.truncated, true, file.path);
    assert.ok(file.patch === '' || file.patch.endsWith('\n'), `${file.path}: ${JSON.stringify(file.patch.slice(-40))}`);
  }
  assert.equal(diff.complete, false);
});

test('a huge first file followed by 199 small files leaves every small file whole', async () => {
  const repo = join(root, 'huge-then-many');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const names = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')} sp.txt`);
  for (const name of names) await writeFile(join(repo, name), 'one\n');
  commitAll(repo, 'Start');
  await writeFile(join(repo, names[0]), lines('huge line', 120_000));
  for (const name of names.slice(1)) await writeFile(join(repo, name), 'two\n');

  const diff = await folderGitDiff(root, 'huge-then-many', { env: env() });
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.equal(diff.files.length, 200);
  assert.deepEqual(diff.files.map((file) => file.path), names);
  const [first, ...rest] = diff.files;
  assert.equal(first.truncated, true);
  const whole = rest.filter((file) => !file.truncated && file.patch.endsWith('\n-one\n+two\n'));
  assert.equal(whole.length, 199, JSON.stringify(rest.filter((file) => !whole.includes(file)).map((file) => file.path)));
  assert.equal(diff.complete, false);
});
