// The git calls of the per-project MCP
// view (src/mcp/project-mcp.ts) go through the shared hardened runGit (src/folders/git-status.ts),
// like every other git call: GIT_OPTIONAL_LOCKS=0, `--no-optional-locks` and
// `-c core.fsmonitor=false`. Reading and saving leave `.git/index` as it was, even when the index
// is stale, and no fsmonitor or index hook runs. The answers stay the ones the direct call gave.
// A `git` shim first on PATH records each call's argv and environment, then runs the real git.
// This file changes process.env (PATH, HOME, GIT_DIR) for its own test process only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectMcp, saveProjectMcp } from '../src/mcp/project-mcp.ts';

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
const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: fixtureEnv }).toString().trim();

let scratch: string;
let shimLog: string;
let agentDir: string;
const savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

interface Call {
  locks: string;
  argv: string[];
}

async function calls(): Promise<Call[]> {
  const text = await readFile(shimLog, 'utf8').catch(() => '');
  return text
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [locks, ...argv] = record.split('\x1f');
      return { locks, argv };
    });
}

/** What the caller asked for: the arguments after `-C <folder>`. */
const requestOf = (call: Call) => call.argv.slice(call.argv.indexOf('-C') + 2);

const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const indexState = async (repo: string) => {
  const index = join(repo, '.git', 'index');
  const info = await stat(index);
  return { hash: await sha(index), mtime: info.mtimeMs, size: info.size };
};

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-mcp-git-')));
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  shimLog = join(scratch, 'git-calls.log');
  // One NUL-terminated record per call: GIT_OPTIONAL_LOCKS, then each argument, split by 0x1f.
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh\n{ printf 'GIT_OPTIONAL_LOCKS=%s' "\${GIT_OPTIONAL_LOCKS-unset}"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\000'; } >> '${shimLog}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  // A scratch HOME keeps the tester's ~/.gitconfig out (project-mcp drops every GIT_* variable).
  const home = join(scratch, 'home');
  await mkdir(home);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.PATH = `${bin}:${savedEnv.PATH}`;
  agentDir = join(scratch, 'agent');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx' }, codegraph: { command: 'codegraph' } } }));
});

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A committed repo with a tracked file touched one hour ahead without a content change and an
 * index dated 2020 (a plain `git status` would refresh and rewrite it), plus an fsmonitor hook
 * and a post-index-change hook that each leave a marker.
 */
async function staleRepo(name: string): Promise<{ repo: string; markers: string }> {
  const repo = join(scratch, name);
  const markers = join(scratch, `${name}-markers`);
  const hooks = join(scratch, `${name}-hooks`);
  await mkdir(repo);
  await mkdir(markers);
  await mkdir(hooks);
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'same.txt'), 'same\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Start');
  await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch '${join(markers, 'post-index-change')}'\n`, { mode: 0o755 });
  await writeFile(join(hooks, 'fsmonitor'), `#!/bin/sh\ntouch '${join(markers, 'fsmonitor')}'\nprintf '\\0'\n`, { mode: 0o755 });
  git(repo, 'config', 'core.hooksPath', hooks);
  git(repo, 'config', 'core.fsmonitor', join(hooks, 'fsmonitor'));
  const later = new Date(Date.now() + 3600_000);
  await utimes(join(repo, 'same.txt'), later, later);
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(join(repo, '.git', 'index'), old, old);
  return { repo, markers };
}

const markersIn = async (markers: string) => {
  const found: string[] = [];
  for (const name of ['fsmonitor', 'post-index-change']) {
    if (await stat(join(markers, name)).then(() => true, () => false)) found.push(name);
  }
  return found;
};

test('reading and saving the MCP view of a stale repo leave .git/index byte-identical, run no fsmonitor or index hook, and every git call is hardened', async () => {
  const { repo, markers } = await staleRepo('stale');
  await writeFile(shimLog, '');
  const indexBefore = await indexState(repo);

  const read = await readProjectMcp({ folder: repo, agentDir });
  assert.equal(read.git, 'untracked');
  const saved = await saveProjectMcp({ folder: repo, agentDir, disabled: ['context7'] });
  assert.equal(saved.git, 'ignored');
  assert.deepEqual(saved.saved, { written: true, excluded: true });

  assert.deepEqual(await indexState(repo), indexBefore, '.git/index unchanged (sha-256, size, mtime)');
  assert.deepEqual(await markersIn(markers), [], 'no fsmonitor or post-index-change hook ran');
  const recorded = await calls();
  assert.ok(recorded.length > 0, 'git ran through the shim');
  for (const call of recorded) {
    const globals = call.argv.slice(0, call.argv.indexOf('-C'));
    assert.equal(call.locks, 'GIT_OPTIONAL_LOCKS=0', call.argv.join(' '));
    assert.ok(globals.includes('--no-optional-locks'), call.argv.join(' '));
    assert.ok(globals.some((arg, i) => arg === '-c' && globals[i + 1] === 'core.fsmonitor=false'), call.argv.join(' '));
  }
  // The stale index is still stale: the read did not refresh it in place.
  assert.equal((await stat(join(repo, '.git', 'index'))).mtimeMs, new Date('2020-01-01T00:00:00Z').getTime());
});

test('the MCP view keeps its previous answers: the same git requests, each git state, GIT_DIR ignored, and unknown without git', async () => {
  // untracked -> save -> ignored, through exactly the requests the direct call made.
  const { repo } = await staleRepo('answers');
  await mkdir(join(repo, 'sub'));
  await writeFile(shimLog, '');
  assert.equal((await readProjectMcp({ folder: join(repo, 'sub'), agentDir })).git, 'untracked');
  const saved = await saveProjectMcp({ folder: join(repo, 'sub'), agentDir, disabled: ['codegraph'] });
  assert.equal(saved.git, 'ignored');
  assert.deepEqual(saved.saved, { written: true, excluded: true });
  assert.equal(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').then((text) => text.split('\n').at(-2)), '/sub/.pi/mcp.json');
  const sub = join(repo, 'sub');
  assert.deepEqual(
    (await calls()).map((call) => [call.argv[call.argv.indexOf('-C') + 1], ...requestOf(call)]),
    [
      [sub, 'rev-parse', '--show-prefix'],
      [sub, 'ls-files', '--error-unmatch', '--', '.pi/mcp.json'],
      [sub, 'check-ignore', '-q', '--', '.pi/mcp.json'],
      [sub, 'rev-parse', '--show-prefix'],
      [sub, 'ls-files', '--error-unmatch', '--', '.pi/mcp.json'],
      [sub, 'check-ignore', '-q', '--', '.pi/mcp.json'],
      [sub, 'rev-parse', '--show-prefix'],
      [sub, 'ls-files', '--error-unmatch', '--', '.pi/mcp.json'],
      [sub, 'check-ignore', '-q', '--', '.pi/mcp.json'],
      [sub, 'rev-parse', '--git-path', 'info/exclude'],
      [sub, 'rev-parse', '--show-prefix'],
      [sub, 'ls-files', '--error-unmatch', '--', '.pi/mcp.json'],
      [sub, 'check-ignore', '-q', '--', '.pi/mcp.json'],
    ],
  );

  // tracked
  git(repo, 'add', '-f', 'sub/.pi/mcp.json');
  assert.equal((await readProjectMcp({ folder: sub, agentDir })).git, 'tracked');

  // none: no repo, even with Mirador's own GIT_DIR pointing at one.
  const plain = join(scratch, 'plain');
  await mkdir(plain);
  process.env.GIT_DIR = join(repo, '.git');
  try {
    assert.equal((await readProjectMcp({ folder: plain, agentDir })).git, 'none');
  } finally {
    delete process.env.GIT_DIR;
  }

  // unknown: git is not on PATH.
  const path = process.env.PATH;
  process.env.PATH = join(scratch, 'empty-path');
  try {
    assert.equal((await readProjectMcp({ folder: sub, agentDir })).git, 'unknown');
  } finally {
    process.env.PATH = path;
  }
});
