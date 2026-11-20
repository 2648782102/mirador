// The read-only git state and NOTES.md of a folder, for
// plain mode's "Where it left off" (src/folders/git-status.ts, src/folders/notes.ts). Every
// fixture lives in a fresh temp folder; git runs with no global or system config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidFolderError } from '../src/folders/tree.ts';
import { MAX_CHANGES, RECENT_COMMITS, folderGitStatus } from '../src/folders/git-status.ts';
import { MAX_NOTES_BYTES, NOTES_FILE, readNotes } from '../src/folders/notes.ts';

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
/** A commit with a fixed author date, so its ISO date is known. */
function commit(cwd: string, subject: string, date: string) {
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', subject], { cwd, env: { ...fixtureEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'pipe' });
}

let scratch: string;
let root: string;
// The helper drops every GIT_* variable and reads the user's git config like any git command: a
// scratch HOME and XDG_CONFIG_HOME keep the tester's own ~/.gitconfig out.
const env = () => ({ ...process.env, HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'cfg') });

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-git-status-')));
  root = join(scratch, 'root');
  await mkdir(root, { recursive: true });

  // clean: three commits on main, nothing changed.
  const clean = join(root, 'clean');
  await mkdir(clean);
  git(clean, 'init', '-q', '-b', 'main');
  commit(clean, 'First commit', '2026-11-01T09:00:00+00:00');
  commit(clean, 'Second commit', '2026-11-02T10:30:00-03:00');
  commit(clean, 'Add the plain left-off', '2026-11-03T11:45:00-03:00');

  // dirty: one tracked file modified, one staged, one untracked, one renamed.
  const dirty = join(root, 'dirty');
  await mkdir(dirty);
  git(dirty, 'init', '-q', '-b', 'feature/x');
  for (const name of ['a.txt', 'b.txt', 'old name.txt']) await writeFile(join(dirty, name), `${name}\n`);
  git(dirty, 'add', '.');
  commit(dirty, 'Files', '2026-11-04T08:00:00+00:00');
  await writeFile(join(dirty, 'a.txt'), 'changed\n');
  await writeFile(join(dirty, 'b.txt'), 'staged\n');
  git(dirty, 'add', 'b.txt');
  git(dirty, 'mv', 'old name.txt', 'new name.txt');
  await writeFile(join(dirty, 'new.txt'), 'untracked\n');

  // detached: HEAD at the first of two commits.
  const detached = join(root, 'detached');
  await mkdir(detached);
  git(detached, 'init', '-q', '-b', 'main');
  commit(detached, 'One', '2026-11-05T08:00:00+00:00');
  commit(detached, 'Two', '2026-11-05T09:00:00+00:00');
  git(detached, 'checkout', '-q', '--detach', 'HEAD~1');

  // unborn: a repo without commits yet.
  const unborn = join(root, 'unborn');
  await mkdir(unborn);
  git(unborn, 'init', '-q', '-b', 'trunk');
  await writeFile(join(unborn, 'draft.md'), 'draft\n');

  // many: more untracked files than the list keeps.
  const many = join(root, 'many');
  await mkdir(many);
  git(many, 'init', '-q', '-b', 'main');
  for (let i = 0; i < MAX_CHANGES + 7; i++) await writeFile(join(many, `f${String(i).padStart(3, '0')}.txt`), 'x');

  await mkdir(join(root, 'plain'));

  // nested: the workspace root of its own sits inside a repo, which must not be reached.
  const outer = join(scratch, 'outer');
  await mkdir(join(outer, 'ws', 'inner'), { recursive: true });
  git(outer, 'init', '-q', '-b', 'main');
  await writeFile(join(outer, 'secret-name.txt'), 'x');

  // escaping: a repo inside the root whose core.worktree points outside it.
  const escaping = join(root, 'escaping');
  await mkdir(escaping);
  await mkdir(join(scratch, 'elsewhere'));
  await writeFile(join(scratch, 'elsewhere', 'outside-file.txt'), 'x');
  git(escaping, 'init', '-q', '-b', 'main');
  git(escaping, 'config', 'core.worktree', join(scratch, 'elsewhere'));

  await mkdir(join(scratch, 'outside'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test('a clean repo reports its branch, last commit, the recent log and no changed files', async () => {
  const status = await folderGitStatus(root, 'clean', { env: env() });
  assert.equal(status.available, true);
  if (!status.available) return;
  assert.equal(status.branch, 'main');
  assert.match(status.head ?? '', /^[0-9a-f]{7,}$/);
  assert.deepEqual(status.lastCommit, { sha: status.head, date: '2026-11-03T11:45:00-03:00', subject: 'Add the plain left-off' });
  assert.deepEqual(status.recent.map((c) => c.subject), ['Add the plain left-off', 'Second commit', 'First commit']);
  assert.equal(status.recent[1].date, '2026-11-02T10:30:00-03:00');
  assert.deepEqual(status.changes, { count: 0, complete: true, files: [] });
});

test('the recent log keeps at most RECENT_COMMITS commits', async () => {
  const busy = join(root, 'busy');
  await mkdir(busy);
  git(busy, 'init', '-q', '-b', 'main');
  for (let i = 1; i <= RECENT_COMMITS + 3; i++) commit(busy, `c${i}`, `2026-11-06T0${i}:00:00+00:00`);
  const status = await folderGitStatus(root, 'busy', { env: env() });
  assert.ok(status.available);
  if (status.available) assert.deepEqual(status.recent.map((c) => c.subject), ['c8', 'c7', 'c6', 'c5', 'c4'].slice(0, RECENT_COMMITS));
});

test('modified, staged, renamed and untracked files are listed with their porcelain code', async () => {
  const status = await folderGitStatus(root, 'dirty', { env: env() });
  assert.ok(status.available);
  if (!status.available) return;
  assert.equal(status.branch, 'feature/x');
  assert.deepEqual(status.changes, {
    count: 4,
    complete: true,
    files: [
      { code: ' M', path: 'a.txt' },
      { code: 'M ', path: 'b.txt' },
      { code: 'R ', path: 'new name.txt', from: 'old name.txt' },
      { code: '??', path: 'new.txt' },
    ],
  });
});

test('a detached HEAD has no branch and names its short sha', async () => {
  const status = await folderGitStatus(root, 'detached', { env: env() });
  assert.ok(status.available);
  if (!status.available) return;
  assert.equal(status.branch, null);
  assert.equal(status.lastCommit?.subject, 'One');
  assert.equal(status.head, status.lastCommit?.sha);
  assert.equal(status.head, git(join(root, 'detached'), 'rev-parse', '--short', 'HEAD').trim());
});

test('a repo without commits has its branch, no commit and its untracked files', async () => {
  const status = await folderGitStatus(root, 'unborn', { env: env() });
  assert.ok(status.available);
  if (!status.available) return;
  assert.equal(status.branch, 'trunk');
  assert.equal(status.head, null);
  assert.equal(status.lastCommit, null);
  assert.deepEqual(status.recent, []);
  assert.deepEqual(status.changes.files, [{ code: '??', path: 'draft.md' }]);
});

test('the changed files are counted in full and listed up to MAX_CHANGES', async () => {
  const status = await folderGitStatus(root, 'many', { env: env() });
  assert.ok(status.available);
  if (!status.available) return;
  assert.equal(status.changes.count, MAX_CHANGES + 7);
  assert.equal(status.changes.files.length, MAX_CHANGES);
  assert.equal(status.changes.complete, true);
});

test('a folder that is no repo is "not available", not an error', async () => {
  assert.deepEqual(await folderGitStatus(root, 'plain', { env: env() }), { available: false, reason: 'not_repo' });
});

test('git is never asked about a repo above the workspace root', async () => {
  const wsRoot = join(scratch, 'outer', 'ws');
  assert.deepEqual(await folderGitStatus(wsRoot, 'inner', { env: env() }), { available: false, reason: 'not_repo' });
  assert.deepEqual(await folderGitStatus(wsRoot, '', { env: env() }), { available: false, reason: 'not_repo' });
});

test('a repo whose work tree lies outside the workspace root is refused', async () => {
  const status = await folderGitStatus(root, 'escaping', { env: env() });
  assert.deepEqual(status, { available: false, reason: 'outside_root' });
  assert.doesNotMatch(JSON.stringify(status), /outside-file/);
});

test('without git on PATH the answer is "not available", not an error', async () => {
  const empty = join(scratch, 'empty-bin');
  await mkdir(empty, { recursive: true });
  assert.deepEqual(await folderGitStatus(root, 'clean', { env: { ...env(), PATH: empty } }), { available: false, reason: 'git_missing' });
});

test('a folder outside the workspace root is refused before git runs', async () => {
  await assert.rejects(folderGitStatus(root, '../outside', { env: env() }), InvalidFolderError);
  await assert.rejects(folderGitStatus(root, join(scratch, 'outside'), { env: env() }), InvalidFolderError);
  await assert.rejects(folderGitStatus(root, 'missing', { env: env() }), InvalidFolderError);
});

test('reading the state writes nothing: the index and git status stay as they were', async () => {
  const repo = join(root, 'dirty');
  const index = join(repo, '.git', 'index');
  // A tracked file whose stat no longer matches the index: a plain `git status` would refresh and rewrite the index.
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(index, old, old);
  await utimes(join(repo, 'new name.txt'), new Date(), new Date());
  const before = { mtime: (await stat(index)).mtimeMs, hash: createHash('sha256').update(await readFile(index)).digest('hex'), status: git(repo, '--no-optional-locks', 'status', '--porcelain=v1') };
  await folderGitStatus(root, 'dirty', { env: env() });
  const afterCall = { mtime: (await stat(index)).mtimeMs, hash: createHash('sha256').update(await readFile(index)).digest('hex'), status: git(repo, '--no-optional-locks', 'status', '--porcelain=v1') };
  assert.deepEqual(afterCall, before);
});

test('a hook or fsmonitor configured in the repo never runs', async () => {
  const repo = join(root, 'hooked');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const marker = join(scratch, 'fsmonitor-ran');
  const script = join(scratch, 'fsmonitor.sh');
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.fsmonitor', script);
  const status = await folderGitStatus(root, 'hooked', { env: env() });
  assert.ok(status.available);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('GIT_DIR and GIT_WORK_TREE in Mirador\'s environment never point git at another repo', async () => {
  const leaked = { ...env(), GIT_DIR: join(root, 'clean', '.git'), GIT_WORK_TREE: join(root, 'clean') };
  assert.deepEqual(await folderGitStatus(root, 'plain', { env: leaked }), { available: false, reason: 'not_repo' });
});

test('a post-index-change hook from core.hooksPath never runs, and a stale index keeps its bytes', async () => {
  const repo = join(root, 'hookspath');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'tracked.txt'), 'x\n');
  git(repo, 'add', '.');
  commit(repo, 'Tracked', '2026-11-07T08:00:00+00:00');
  const hooks = join(scratch, 'hooks');
  const marker = join(scratch, 'post-index-change-ran');
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.hooksPath', hooks);
  // A stale stat in the index: a plain `git status` would refresh it, write the index and run the hook.
  const index = join(repo, '.git', 'index');
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(index, old, old);
  await utimes(join(repo, 'tracked.txt'), new Date(), new Date());
  const before = createHash('sha256').update(await readFile(index)).digest('hex');
  const status = await folderGitStatus(root, 'hookspath', { env: env() });
  assert.ok(status.available);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(createHash('sha256').update(await readFile(index)).digest('hex'), before);
});

// Advisory, decided: a .git file whose gitdir lies outside the root is accepted. That is how
// git worktrees work, the user wrote that file, and the work tree itself is inside the root.
test('a worktree inside the root whose gitdir lies outside it is read', async () => {
  const main = join(scratch, 'main-repo');
  await mkdir(main);
  git(main, 'init', '-q', '-b', 'main');
  commit(main, 'Main start', '2026-11-08T08:00:00+00:00');
  git(main, 'worktree', 'add', '-q', '-b', 'wt-branch', join(root, 'wt'));
  assert.ok((await stat(join(root, 'wt', '.git'))).isFile(), 'the worktree has a .git file, not a folder');
  const status = await folderGitStatus(root, 'wt', { env: env() });
  assert.ok(status.available);
  if (!status.available) return;
  assert.equal(status.branch, 'wt-branch');
  assert.equal(status.lastCommit?.subject, 'Main start');
  assert.deepEqual(status.changes, { count: 0, complete: true, files: [] });
});

/* ---------- NOTES.md ---------- */

test('NOTES.md at the folder root is read as plain text', async () => {
  await writeFile(join(root, 'clean', NOTES_FILE), '# Next\n- <script>alert(1)</script> stays text\n');
  assert.deepEqual(await readNotes(root, 'clean'), { text: '# Next\n- <script>alert(1)</script> stays text\n', truncated: false });
});

test('a folder without NOTES.md has no notes, and another casing does not count', async () => {
  assert.equal(await readNotes(root, 'plain'), null);
  await writeFile(join(root, 'detached', 'notes.md'), 'lowercase');
  assert.equal(await readNotes(root, 'detached'), null);
});

test('an oversized NOTES.md is cut at MAX_NOTES_BYTES on a whole character', async () => {
  // 'é' is two bytes: one starts on the last byte kept, so it is dropped whole.
  await writeFile(join(root, 'many', NOTES_FILE), `${'a'.repeat(MAX_NOTES_BYTES - 1)}é and more`);
  const notes = await readNotes(root, 'many');
  assert.equal(notes?.truncated, true);
  assert.equal(notes?.text, 'a'.repeat(MAX_NOTES_BYTES - 1));
});

test('a NOTES.md that is a folder, binary, or a symlink out of the root is not read', async () => {
  await mkdir(join(root, 'unborn', NOTES_FILE));
  assert.equal(await readNotes(root, 'unborn'), null);
  await writeFile(join(root, 'busy', NOTES_FILE), Buffer.from([0x50, 0x00, 0x4b]));
  assert.equal(await readNotes(root, 'busy'), null);
  await writeFile(join(scratch, 'outside', 'private.md'), 'outside the root');
  await symlink(join(scratch, 'outside', 'private.md'), join(root, 'plain', NOTES_FILE));
  assert.equal(await readNotes(root, 'plain'), null);
});

test('a NOTES.md symlink inside the root is followed', async () => {
  await mkdir(join(root, 'linked'));
  await symlink(join(root, 'clean', NOTES_FILE), join(root, 'linked', NOTES_FILE));
  assert.equal((await readNotes(root, 'linked'))?.truncated, false);
});

test('a FIFO named NOTES.md answers null at once, without waiting for a writer', async () => {
  await mkdir(join(root, 'fifo'));
  execFileSync('mkfifo', [join(root, 'fifo', NOTES_FILE)]);
  const started = Date.now();
  assert.equal(await readNotes(root, 'fifo'), null);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('notes of a folder outside the workspace root are refused', async () => {
  await assert.rejects(readNotes(root, '../outside'), InvalidFolderError);
});
