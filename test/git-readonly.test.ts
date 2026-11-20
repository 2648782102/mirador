// Every git call of
// the git state (src/folders/git-status.ts) and the Changes panel (src/folders/git-diff.ts,
// with the re-reads) runs with GIT_OPTIONAL_LOCKS=0 and `-c core.fsmonitor=false`, and asking for
// the state and the diff leaves `.git/index` as it was, even when the index is stale. Paths
// only after `--`, git run from an argument array without a shell, so file names that look like
// options or hold spaces or line breaks are listed and diffed as names. A `git` shim first on PATH
// records each call's argv and environment, then runs the real git.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderGitStatus, runGit } from '../src/folders/git-status.ts';
import { MAX_DIFF_BYTES, folderGitDiff } from '../src/folders/git-diff.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
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

let scratch: string;
let root: string;
let shimLog: string;
/** process.env with the shim first on PATH and a scratch HOME, so the tester's ~/.gitconfig stays out. */
let shimEnv: NodeJS.ProcessEnv;

/** One recorded git call: the two variables the shim reads and the argv git got. */
interface Call {
  locks: string;
  configCount: string;
  argv: string[];
}

async function calls(): Promise<Call[]> {
  const text = await readFile(shimLog, 'utf8').catch(() => '');
  // One NUL-terminated record per call: an argument may hold a line break, never a NUL.
  return text
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [locks, configCount, ...argv] = line.split('\x1f');
      return { locks, configCount, argv };
    });
}

/** The global options before `-C <folder>`: where runGit puts its hardened flags. */
const globalsOf = (call: Call) => call.argv.slice(0, call.argv.indexOf('-C'));
const subcommandOf = (call: Call) => {
  const rest = call.argv.slice(call.argv.indexOf('-C') + 2);
  // Skip the diff flags that come before `diff` (--no-pager, -c key=value).
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-c') i++;
    else if (!rest[i].startsWith('-')) return rest[i];
  }
  return '';
};

function assertHardened(recorded: Call[]) {
  assert.ok(recorded.length > 0, 'git ran through the shim');
  for (const call of recorded) {
    const globals = globalsOf(call);
    assert.equal(call.locks, 'GIT_OPTIONAL_LOCKS=0', call.argv.join(' '));
    assert.ok(globals.includes('--no-optional-locks'), call.argv.join(' '));
    const fsmonitor = globals.findIndex((arg, i) => arg === '-c' && globals[i + 1] === 'core.fsmonitor=false');
    assert.ok(fsmonitor >= 0, call.argv.join(' '));
  }
}

const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const indexState = async (repo: string) => {
  const index = join(repo, '.git', 'index');
  return { hash: await sha(index), mtime: (await stat(index)).mtimeMs, size: (await stat(index)).size };
};

/**
 * A repo whose first file's diff is bigger than MAX_DIFF_BYTES (so the diff reads the later files
 * again), one small change, a tracked file touched without a content change, an index older
 * than the files (a plain `git status` or `git diff` would refresh and rewrite it), an fsmonitor
 * hook and a post-index-change hook that each leave a marker.
 */
async function staleRepo(name: string): Promise<{ repo: string; markers: string }> {
  const repo = join(root, name);
  const markers = join(scratch, `${name}-markers`);
  const hooks = join(scratch, `${name}-hooks`);
  await mkdir(repo);
  await mkdir(markers);
  await mkdir(hooks);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a-huge.txt'), 'start\n');
  await writeFile(join(repo, 'b-small.txt'), 'before\n');
  await writeFile(join(repo, 'c-same.txt'), 'same\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Start');
  const line = `${'x'.repeat(63)}\n`;
  await writeFile(join(repo, 'a-huge.txt'), line.repeat(Math.ceil((MAX_DIFF_BYTES * 1.5) / line.length)));
  await writeFile(join(repo, 'b-small.txt'), 'after\n');
  const later = new Date(Date.now() + 3600_000);
  await utimes(join(repo, 'c-same.txt'), later, later);
  await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch '${join(markers, 'post-index-change')}'\n`, { mode: 0o755 });
  await writeFile(join(scratch, `${name}-fsmonitor.sh`), `#!/bin/sh\ntouch '${join(markers, 'fsmonitor')}'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.hooksPath', hooks);
  git(repo, 'config', 'core.fsmonitor', join(scratch, `${name}-fsmonitor.sh`));
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  return { repo, markers };
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-git-readonly-')));
  root = join(scratch, 'root');
  await mkdir(root);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: fixtureEnv }).toString().trim();
  const shimDir = join(scratch, 'shim');
  shimLog = join(scratch, 'git-calls.log');
  await mkdir(shimDir);
  // One NUL-terminated record per call, fields split by US (0x1f), written with a single printf so concurrent calls do not interleave.
  await writeFile(
    join(shimDir, 'git'),
    [
      '#!/bin/sh',
      "us=$(printf '\\037')",
      'line="GIT_OPTIONAL_LOCKS=${GIT_OPTIONAL_LOCKS-unset}${us}GIT_CONFIG_COUNT=${GIT_CONFIG_COUNT-unset}"',
      'for arg in "$@"; do line="$line$us$arg"; done',
      `printf '%s\\000' "$line" >> '${shimLog}'`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  shimEnv = { ...process.env, HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'cfg'), PATH: `${shimDir}:${process.env.PATH ?? ''}` };
  await startServer();
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server?.once('exit', resolve));
  }
  await rm(scratch, { recursive: true, force: true });
});

test('reading the state and the diff of a stale repo leaves .git/index byte-identical, and every git call is hardened', async () => {
  const { repo, markers } = await staleRepo('direct');
  const before = await indexState(repo);
  await rm(shimLog, { force: true });

  const status = await folderGitStatus(root, 'direct', { env: shimEnv });
  const diff = await folderGitDiff(root, 'direct', { env: shimEnv });

  // Existing behaviour holds: the touched file is no change, the two changed files are.
  assert.ok(status.available);
  if (!status.available) return;
  assert.deepEqual(status.changes.files, [{ code: ' M', path: 'a-huge.txt' }, { code: ' M', path: 'b-small.txt' }]);
  assert.ok(diff.available);
  if (!diff.available) return;
  assert.deepEqual(diff.files.map((file) => [file.path, file.truncated]), [['a-huge.txt', true], ['b-small.txt', false]]);
  assert.match(diff.files[1].patch, /\n-before\n\+after\n$/);

  assert.deepEqual(await indexState(repo), before);
  assert.deepEqual(await readdir(markers), [], 'no fsmonitor or post-index-change hook ran');

  const recorded = await calls();
  assertHardened(recorded);
  const subcommands = recorded.map(subcommandOf);
  for (const name of ['rev-parse', 'symbolic-ref', 'log', 'status', 'config', 'diff', 'ls-files']) assert.ok(subcommands.includes(name), name);
  // The re-read of the files after the huge one, by literal pathspec.
  const reread = recorded.find((call) => call.argv.includes(':(top,literal)b-small.txt'));
  assert.ok(reread, 'the diff read b-small.txt again');
  // The diff keeps its own flags and its filter-free environment on top of the runner's.
  for (const call of recorded.filter((c) => subcommandOf(c) === 'diff')) {
    assert.ok(call.argv.includes('diff.autoRefreshIndex=false'), call.argv.join(' '));
    assert.notEqual(call.configCount, 'GIT_CONFIG_COUNT=unset', call.argv.join(' '));
  }
});

test('runGit sets GIT_OPTIONAL_LOCKS=0 itself, whatever the caller\'s env says, and keeps the caller\'s other variables', async () => {
  const repo = join(root, 'runner');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const callerLocks of [undefined, '1']) {
    await rm(shimLog, { force: true });
    const env: NodeJS.ProcessEnv = { ...shimEnv, GIT_CONFIG_COUNT: '0' };
    if (callerLocks === undefined) delete env.GIT_OPTIONAL_LOCKS;
    else env.GIT_OPTIONAL_LOCKS = callerLocks;
    const run = await runGit(repo, env, ['rev-parse', '--is-inside-work-tree']);
    assert.deepEqual([run.code, run.stdout], [0, 'true\n']);
    const [call] = await calls();
    assert.deepEqual(call, {
      locks: 'GIT_OPTIONAL_LOCKS=0',
      configCount: 'GIT_CONFIG_COUNT=0',
      argv: ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-C', repo, 'rev-parse', '--is-inside-work-tree'],
    });
  }
});

/* ---------- through the HTTP routes ---------- */

let server: ChildProcess | undefined;
let base: string;
let token: string;
const call = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

/** The real server in plain mode on workspace `dev` = root, with the shim first on its PATH. */
async function startServer() {
  const cfg = join(scratch, 'server-cfg');
  await mkdir(join(cfg, 'mirador'), { recursive: true });
  // Engram points at a port nothing listens on: neither route needs it.
  await writeFile(join(cfg, 'mirador', 'config.json'), JSON.stringify({ root, mode: 'plain', agentCommand: 'bash', engramUrl: `http://127.0.0.1:${await freePort()}` }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...shimEnv, XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: cfg, MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  let launchSecret: string | undefined;
  const deadline = Date.now() + 8000;
  while (!launchSecret && Date.now() < deadline) {
    launchSecret = await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8').then((text) => JSON.parse(text).launchSecret, () => undefined);
    if (!launchSecret) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
}

test('GET /api/folder/git and GET /api/folder/diff leave a stale .git/index byte-identical and run no fsmonitor', async () => {
  const { repo, markers } = await staleRepo('served');
  const before = await indexState(repo);
  await rm(shimLog, { force: true });
  const state = (await (await call('/api/folder/git?ws=dev&rel=served')).json()) as any;
  const diff = (await (await call('/api/folder/diff?ws=dev&rel=served')).json()) as any;

  assert.deepEqual(state.git.changes.files, [{ code: ' M', path: 'a-huge.txt' }, { code: ' M', path: 'b-small.txt' }]);
  assert.deepEqual(diff.diff.files.map((file: { path: string }) => file.path), ['a-huge.txt', 'b-small.txt']);
  assert.deepEqual(await indexState(repo), before);
  assert.deepEqual(await readdir(markers), []);
  assertHardened(await calls());
});

/* ---------- File names that look like options, or hold spaces or line breaks ---------- */

/** Tracked names git must take as names: two that read as options, one with a space, one with a line break. */
const ODD_NAMES = ['--output=x', '-n.txt', 'a b.txt', 'new\nline.txt'];

/**
 * A repo whose ODD_NAMES go from 'one\n' to 'two\n', with a stale index. With `huge`, a file that
 * sorts first ('!' is 0x21) holds a diff bigger than MAX_DIFF_BYTES, so every odd name is read
 * again by literal pathspec.
 */
async function oddRepo(name: string, huge: boolean): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const file of ODD_NAMES) await writeFile(join(repo, file), 'one\n');
  if (huge) await writeFile(join(repo, '!huge.txt'), 'start\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Odd names');
  for (const file of ODD_NAMES) await writeFile(join(repo, file), 'two\n');
  const line = `${'x'.repeat(63)}\n`;
  if (huge) await writeFile(join(repo, '!huge.txt'), line.repeat(Math.ceil((MAX_DIFF_BYTES * 1.5) / line.length)));
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  return repo;
}

/** The unified diff git writes for one of ODD_NAMES going from 'one\n' (5626abf) to 'two\n' (f719efd). */
function oddPatch(file: string): string {
  // git quotes a name holding a line break (C-style, in double quotes) and ends a ---/+++ name holding a space with a TAB.
  const quoted = file.includes('\n');
  const side = (prefix: string) => (quoted ? `"${prefix}/${file.replace('\n', '\\n')}"` : `${prefix}/${file}`);
  const tab = file.includes(' ') ? '\t' : '';
  return `diff --git ${side('a')} ${side('b')}\nindex 5626abf..f719efd 100644\n--- ${side('a')}${tab}\n+++ ${side('b')}${tab}\n@@ -1 +1 @@\n-one\n+two\n`;
}

for (const huge of [false, true]) {
  test(`names that look like options or hold a space or a line break are listed and diffed as names${huge ? ', also when read again after a huge file' : ''}`, async () => {
    const name = huge ? 'odd-cut' : 'odd';
    const repo = await oddRepo(name, huge);
    const before = await indexState(repo);
    const repoFiles = await readdir(repo);
    await rm(shimLog, { force: true });

    const stateResponse = await call(`/api/folder/git?ws=dev&rel=${name}`);
    const diffResponse = await call(`/api/folder/diff?ws=dev&rel=${name}`);
    assert.equal(stateResponse.status, 200);
    assert.equal(diffResponse.status, 200);
    const state = (await stateResponse.json()) as any;
    const diff = (await diffResponse.json()) as any;

    const expected = huge ? ['!huge.txt', ...ODD_NAMES] : ODD_NAMES;
    assert.deepEqual(state.git.changes, { count: expected.length, complete: true, files: expected.map((path) => ({ code: ' M', path })) });
    assert.equal(diff.diff.available, true);
    assert.deepEqual(diff.diff.files.map((file: { path: string }) => file.path), expected);
    const odd = diff.diff.files.filter((file: { path: string }) => ODD_NAMES.includes(file.path));
    assert.deepEqual(
      odd.map(({ path, added, removed, binary, patch, truncated }: any) => ({ path, added, removed, binary, patch, truncated })),
      ODD_NAMES.map((path) => ({ path, added: 1, removed: 1, binary: false, patch: oddPatch(path), truncated: false })),
    );
    if (huge) assert.equal(diff.diff.files[0].truncated, true);

    // No option was interpreted: `--output=x` wrote no file `x`, `-n` cut nothing, and nothing new appeared.
    assert.deepEqual(await readdir(repo), repoFiles);
    await assert.rejects(stat(join(APP_DIR, 'x')), { code: 'ENOENT' });
    assert.deepEqual(await indexState(repo), before);

    const recorded = await calls();
    assertHardened(recorded);
    // Every path git got, the folder's '.' or a literal pathspec, comes after `--`.
    const reread = recorded.filter((c) => c.argv.some((arg) => arg.startsWith(':(top,literal)')));
    assert.equal(reread.length > 0, huge, 'the odd names were read again only after the huge file');
    for (const c of recorded) {
      const paths = c.argv.flatMap((arg, i) => (arg === '.' || arg.startsWith(':(top,literal)') || ODD_NAMES.some((file) => arg.includes(file)) ? [i] : []));
      const dashes = c.argv.indexOf('--');
      for (const i of paths) assert.ok(dashes >= 0 && i > dashes, `${JSON.stringify(c.argv[i])} after -- in ${JSON.stringify(c.argv)}`);
    }
    if (huge) for (const file of ODD_NAMES) assert.ok(reread.some((c) => c.argv.includes(`:(top,literal)${file}`)), JSON.stringify(file));
  });
}

test('runGit hands each argument to git as is, without a shell: no split, no expansion, no command', async () => {
  const repo = join(root, 'verbatim');
  const names = [...ODD_NAMES, '$(touch pwned);`touch pwned2`*.txt'];
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const file of names) await writeFile(join(repo, file), 'one\n');
  git(repo, 'add', '-A');
  const run = await runGit(repo, shimEnv, ['ls-files', '-z', '--', ...names.map((file) => `:(top,literal)${file}`)]);
  assert.equal(run.code, 0);
  assert.deepEqual(run.stdout.split('\0').filter(Boolean).sort(), [...names].sort());
  for (const dir of [repo, APP_DIR]) for (const marker of ['pwned', 'pwned2']) await assert.rejects(stat(join(dir, marker)), { code: 'ENOENT' });
});

/* ---------- Verifier probes (independent verifier) ---------- */

/** Names git could read as pathspec magic, a glob, a revision or an option, if they ever reached it unquoted or before `--`. */
const MAGIC_NAMES = ['*.txt', ':(glob)star.txt', ':(top)top.txt', ':!neg.txt', ':^caret.txt', 'a)b.txt', 'HEAD', '-', '--', '-c', '--ext-diff'];

test('names that look like pathspec magic or git tokens are listed and diffed as names after a huge file', async () => {
  const name = 'magic';
  const repo = join(root, name);
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const file of MAGIC_NAMES) await writeFile(join(repo, file), 'one\n');
  await writeFile(join(repo, '!huge.txt'), 'start\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Magic names');
  for (const file of MAGIC_NAMES) await writeFile(join(repo, file), 'two\n');
  const line = `${'x'.repeat(63)}\n`;
  await writeFile(join(repo, '!huge.txt'), line.repeat(Math.ceil((MAX_DIFF_BYTES * 1.5) / line.length)));
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  const before = await indexState(repo);
  const repoFiles = await readdir(repo);
  await rm(shimLog, { force: true });

  const state = (await (await call(`/api/folder/git?ws=dev&rel=${name}`)).json()) as any;
  const diff = (await (await call(`/api/folder/diff?ws=dev&rel=${name}`)).json()) as any;

  const expected = ['!huge.txt', ...MAGIC_NAMES].sort();
  assert.deepEqual(state.git.changes.files.map((file: { path: string }) => file.path).sort(), expected);
  assert.ok(state.git.changes.files.every((file: { code: string }) => file.code === ' M'), JSON.stringify(state.git.changes.files));
  assert.deepEqual(diff.diff.files.map((file: { path: string }) => file.path).sort(), expected);
  for (const file of diff.diff.files.filter((f: { path: string }) => MAGIC_NAMES.includes(f.path))) {
    assert.ok(file.patch.endsWith('\n-one\n+two\n'), `${JSON.stringify(file.path)}: ${JSON.stringify(file.patch)}`);
  }
  assert.equal(diff.diff.files.filter((file: { truncated: boolean }) => !file.truncated).length, MAGIC_NAMES.length);

  assert.deepEqual(await readdir(repo), repoFiles);
  assert.deepEqual(await indexState(repo), before);

  const recorded = await calls();
  assertHardened(recorded);
  for (const file of MAGIC_NAMES) {
    const spec = `:(top,literal)${file}`;
    assert.ok(
      recorded.some((c) => {
        const dashes = c.argv.indexOf('--');
        return dashes >= 0 && c.argv.indexOf(spec, dashes + 1) > dashes;
      }),
      `${JSON.stringify(spec)} after -- in some re-read`,
    );
  }
});

/** Every entry under `dir` with its sha-256 and mtime (regular files) or its kind (anything else, e.g. a socket). */
async function treeState(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const key = path.slice(dir.length + 1);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[key] = `${await sha(path)} ${(await stat(path)).mtimeMs}`;
      else out[key] = 'not a regular file';
    }
  };
  await walk(dir);
  return out;
}

test('core.fsmonitor=true and core.untrackedCache=true: the whole .git tree is byte-identical and no daemon runs', async () => {
  const name = 'fsmonitor-daemon';
  const repo = join(root, name);
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'changed.txt'), 'before\n');
  await writeFile(join(repo, 'future.txt'), 'same\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Start');
  // Set after the fixture's own git calls, so none of them starts the built-in daemon.
  git(repo, 'config', 'core.fsmonitor', 'true');
  git(repo, 'config', 'core.untrackedCache', 'true');
  await writeFile(join(repo, 'changed.txt'), 'after\n');
  await writeFile(join(repo, 'untracked.txt'), 'new\n');
  const later = new Date(Date.now() + 3600_000);
  await utimes(join(repo, 'future.txt'), later, later);
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  const before = await treeState(join(repo, '.git'));
  await rm(shimLog, { force: true });

  const first = (await (await call(`/api/folder/git?ws=dev&rel=${name}`)).json()) as any;
  const diff = (await (await call(`/api/folder/diff?ws=dev&rel=${name}`)).json()) as any;
  const second = (await (await call(`/api/folder/git?ws=dev&rel=${name}`)).json()) as any;

  for (const state of [first, second]) {
    assert.deepEqual(state.git.changes.files, [{ code: ' M', path: 'changed.txt' }, { code: '??', path: 'untracked.txt' }]);
  }
  assert.deepEqual(diff.diff.files.map((file: { path: string }) => file.path), ['changed.txt']);
  assert.deepEqual(diff.diff.untracked.paths, ['untracked.txt']);
  assert.deepEqual(await treeState(join(repo, '.git')), before);
  assertHardened(await calls());
  // `status` exits non-zero when no daemon serves this repo.
  assert.throws(() => git(repo, 'fsmonitor--daemon', 'status'));
});

test('the diff runs no clean filter and the status does, both leaving .git/index as it was', async () => {
  const name = 'clean-filter';
  const repo = join(root, name);
  const marker = join(scratch, `${name}-ran`);
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  // The clean filter upper-cases the content, so the blobs hold 'HELLO' while the files hold 'hello'.
  git(repo, 'config', 'filter.up.clean', `sh -c 'touch "${marker}"; tr a-z A-Z'`);
  await writeFile(join(repo, '.gitattributes'), '*.dat filter=up\n');
  await writeFile(join(repo, 'a.dat'), 'hello\n');
  await writeFile(join(repo, 'b.dat'), 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Filtered');
  // The fixture's own `git add` ran the filter.
  await rm(marker, { force: true });
  // a.dat: a stale stat and the same content; b.dat: a real change.
  const older = new Date('2001-01-01T00:00:00Z');
  await utimes(join(repo, 'a.dat'), older, older);
  await writeFile(join(repo, 'b.dat'), 'world\n');
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  const before = await indexState(repo);

  const diff = (await (await call(`/api/folder/diff?ws=dev&rel=${name}`)).json()) as any;
  assert.deepEqual(diff.diff.files.map((file: { path: string }) => file.path), ['a.dat', 'b.dat']);
  await assert.rejects(stat(marker), { code: 'ENOENT' }, 'the diff ran no clean filter');

  const state = (await (await call(`/api/folder/git?ws=dev&rel=${name}`)).json()) as any;
  assert.deepEqual(state.git.changes.files, [{ code: ' M', path: 'b.dat' }]);
  await stat(marker); // the status ran the user's clean filter (documented)
  assert.deepEqual(await indexState(repo), before);
});
