// Public release phase 4: the public clone keeps odd/tasks/ and design/ private with a
// pre-push hook, scripts/hooks/pre-push, installed by scripts/install-hooks.sh. The hook rejects a push
// when any pushed commit's tree holds any path under odd/tasks/ or design/, with no exceptions.
// Each case runs a real `git push` into a temp bare remote, with core.hooksPath on a temp copy of the hook.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from './helpers/export-archive.ts';

const HOOK = join(ROOT, 'scripts', 'hooks', 'pre-push');
const INSTALL = join(ROOT, 'scripts', 'install-hooks.sh');
const PRIVATE = 'odd/tasks/ and design/ stay private';

const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mirador-pre-push-')));
  scratch.push(dir);
  return dir;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}
function run(cwd: string, command: string, args: string[]): Run {
  const result = spawnSync(command, args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
function commitFile(work: string, path: string, text: string, force = false): string {
  write(work, path, text);
  git(work, 'add', ...(force ? ['-f'] : []), path);
  git(work, 'commit', '-q', '-m', `add ${path}`);
  return git(work, 'rev-parse', 'HEAD');
}

/**
 * A public clone: a bare remote and a work repository whose .gitignore leaves out the private folders,
 * with the hook installed through core.hooksPath and one clean commit already pushed to main.
 */
function publicClone(): { work: string; remote: string; base: string } {
  const dir = tempDir();
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks);
  copyFileSync(HOOK, join(hooks, 'pre-push'));
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main', work);
  git(work, 'config', 'core.hooksPath', hooks);
  git(work, 'remote', 'add', 'origin', remote);
  write(work, '.gitignore', '/odd/tasks\n/design\n');
  write(work, 'odd/README.md', '# The method\n');
  git(work, 'add', '.gitignore', 'odd/README.md');
  git(work, 'commit', '-q', '-m', 'initial');
  const pushed = run(work, 'git', ['push', '-q', 'origin', 'main']);
  assert.equal(pushed.status, 0, `the first clean push passes: ${pushed.stderr}`);
  return { work, remote, base: git(work, 'rev-parse', 'HEAD') };
}

/** The remote's commit for `branch`, or undefined when it has no such branch. */
function remoteHead(remote: string, branch: string): string | undefined {
  const result = run(remote, 'git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function assertRejected(push: Run, ref: string, commit: string, paths: string[]): void {
  assert.equal(push.status, 1, `the push is rejected: ${push.stderr}`);
  assert.match(push.stderr, new RegExp(`pre-push: ${ref}: commit ${commit} tracks private paths:`));
  for (const path of paths) assert.ok(push.stderr.includes(`  ${path}\n`), `stderr names ${path}: ${push.stderr}`);
  assert.ok(push.stderr.includes(`pre-push: push rejected; ${PRIVATE} and are never pushed from this clone.`), push.stderr);
}

test('(a) a push of an ordinary commit passes', () => {
  const { work, remote } = publicClone();
  const head = commitFile(work, 'src/a.ts', 'export const a = 1;\n');
  const push = run(work, 'git', ['push', '-q', 'origin', 'main']);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stderr, '');
  assert.equal(remoteHead(remote, 'main'), head);
});

test('(b) a commit with `git add -f odd/tasks/f.md` is rejected and the remote keeps its commit', () => {
  const { work, remote, base } = publicClone();
  const leak = commitFile(work, 'odd/tasks/f.md', '# private\n', true);
  const push = run(work, 'git', ['push', '-q', 'origin', 'main']);
  assertRejected(push, 'refs/heads/main', leak, ['odd/tasks/f.md']);
  assert.equal(remoteHead(remote, 'main'), base);
});

test('(c) a commit with `git add -f design/a.html` is rejected and the remote keeps its commit', () => {
  const { work, remote, base } = publicClone();
  const leak = commitFile(work, 'design/a.html', '<p>artboard</p>\n', true);
  const push = run(work, 'git', ['push', '-q', 'origin', 'main']);
  assertRejected(push, 'refs/heads/main', leak, ['design/a.html']);
  assert.equal(remoteHead(remote, 'main'), base);
});

test('(d) a new branch whose commit leaks is rejected and never reaches the remote', () => {
  const { work, remote } = publicClone();
  git(work, 'switch', '-q', '-c', 'feature');
  const leak = commitFile(work, 'odd/tasks/g.md', '# private\n', true);
  const push = run(work, 'git', ['push', '-q', 'origin', 'feature']);
  assertRejected(push, 'refs/heads/feature', leak, ['odd/tasks/g.md']);
  assert.equal(remoteHead(remote, 'feature'), undefined);
});

test('(e) a leak buried under a later clean commit is rejected, though the tip tree is clean', () => {
  const { work, remote, base } = publicClone();
  const leak = commitFile(work, 'design/b.html', '<p>artboard</p>\n', true);
  git(work, 'rm', '-q', '--cached', 'design/b.html');
  git(work, 'commit', '-q', '-m', 'untrack design/b.html');
  commitFile(work, 'src/b.ts', 'export const b = 2;\n');
  assert.equal(git(work, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'odd/tasks', 'design'), '', 'the tip tree is clean');
  const push = run(work, 'git', ['push', '-q', 'origin', 'main']);
  assertRejected(push, 'refs/heads/main', leak, ['design/b.html']);
  assert.equal(remoteHead(remote, 'main'), base);
});

test('(f) deleting a remote branch passes', () => {
  const { work, remote } = publicClone();
  git(work, 'switch', '-q', '-c', 'old');
  commitFile(work, 'src/old.ts', 'export {};\n');
  assert.equal(run(work, 'git', ['push', '-q', 'origin', 'old']).status, 0);
  assert.ok(remoteHead(remote, 'old'));
  const push = run(work, 'git', ['push', '-q', 'origin', '--delete', 'old']);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stderr, '');
  assert.equal(remoteHead(remote, 'old'), undefined);
});

/** A repository with one commit; `tracked` adds files to it. Returns it and its hooks folder. */
function repoWith(tracked: Record<string, string> = {}): { repo: string; installed: string } {
  const repo = join(tempDir(), 'repo');
  git(dirname(repo), 'init', '-q', '-b', 'main', repo);
  for (const [path, text] of Object.entries({ 'README.md': '# repo\n', ...tracked })) write(repo, path, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return { repo, installed: join(repo, '.git', 'hooks', 'pre-push') };
}

test('install-hooks installs the hook into .git/hooks, executable, and is idempotent', () => {
  const { repo, installed } = repoWith();
  const first = run(repo, 'sh', [INSTALL]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, `install-hooks: installed the pre-push hook at ${installed}\n`);
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(HOOK, 'utf8'));
  assert.ok((statSync(installed).mode & 0o111) !== 0, 'the installed hook is executable');

  const again = run(repo, 'sh', [INSTALL]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, '');
  assert.equal(again.stdout, `install-hooks: the pre-push hook is already installed at ${installed}\n`);
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(HOOK, 'utf8'));
});

test('install-hooks refuses to replace a different pre-push hook unless --force', () => {
  const { repo, installed } = repoWith();
  const other = '#!/bin/sh\nexit 0\n';
  write(repo, '.git/hooks/pre-push', other);
  const refused = run(repo, 'sh', [INSTALL]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, `install-hooks: a different pre-push hook is already installed at ${installed}; pass --force to replace it\n`);
  assert.equal(readFileSync(installed, 'utf8'), other, 'the existing hook is left as it was');

  const forced = run(repo, 'sh', [INSTALL, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(forced.stdout, `install-hooks: installed the pre-push hook at ${installed}\n`);
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(HOOK, 'utf8'));
});

test('install-hooks refuses a clone whose HEAD tracks odd/tasks/ unless --force', () => {
  const { repo, installed } = repoWith({ 'odd/tasks/f.md': '# private\n' });
  const refused = run(repo, 'sh', [INSTALL]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, 'install-hooks: this clone still tracks the private folders; install it in the public clone (--force installs it anyway)\n');
  assert.equal(existsSync(installed), false, 'nothing is installed');

  const forced = run(repo, 'sh', [INSTALL, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(HOOK, 'utf8'));
});
