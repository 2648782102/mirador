// Read-only git state of a workspace folder: branch, last
// commit, changed files and the recent log, for plain mode's "Where it left off". Reused by the
// read-only changes panel (src/folders/git-diff.ts) through openRepo and runGit, so both
// share one confinement and one hardened way of running git.
//
// Only read-only commands run (rev-parse, symbolic-ref, log, status with --no-optional-locks, so
// the index is never refreshed), with Mirador's GIT_* variables removed, English messages, a
// timeout, fsmonitor off and signatures not checked, so no hook, fsmonitor or gpg program runs.
// GIT_CEILING_DIRECTORIES stops repository discovery at the workspace root, and a repo whose
// work tree lies outside the root (core.worktree) is refused: nothing outside the root is listed.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { resolveInsideRoot } from './tree.ts';

/** Most changed files listed; `changes.count` still counts them all. */
export const MAX_CHANGES = 50;
/** Commits in the recent log. */
export const RECENT_COMMITS = 5;
/** Each git command is cut after this long. */
const GIT_TIMEOUT_MS = 5000;
/** Most bytes of `git status` read; past it the list is cut and `changes.complete` is false. */
const STATUS_MAX_BYTES = 4 * 1024 * 1024;

export interface GitCommit {
  /** Abbreviated sha. */
  sha: string;
  /** Author date, strict ISO 8601 with the author's offset. */
  date: string;
  subject: string;
}

export interface GitChange {
  /** The two-letter porcelain v1 code: ' M' modified, 'M ' staged, '??' untracked, 'R ' renamed… */
  code: string;
  /** Path from the repo root. */
  path: string;
  /** The old path of a rename or copy. */
  from?: string;
}

/**
 * Why there is no git state: no repo at or above the folder (up to the workspace root), a work
 * tree outside the root, git not on PATH, or git failing or timing out.
 */
export type GitUnavailable = 'not_repo' | 'outside_root' | 'git_missing' | 'git_failed';

export type FolderGit =
  | { available: false; reason: GitUnavailable }
  | {
      available: true;
      /** The checked-out branch; null when HEAD is detached. */
      branch: string | null;
      /** HEAD's abbreviated sha; null before the first commit. */
      head: string | null;
      lastCommit: GitCommit | null;
      /** The newest RECENT_COMMITS commits of HEAD, newest first. */
      recent: GitCommit[];
      /** Every changed path counted, at most MAX_CHANGES listed; `complete` false when the status output was cut. */
      changes: { count: number; complete: boolean; files: GitChange[] };
    };

export interface GitRun {
  code: number | string;
  stdout: string;
  stderr: string;
}

function gitEnv(env: NodeJS.ProcessEnv, realRoot: string): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  // The ceiling is the root's parent: the root's own .git is found, nothing above it.
  return { ...kept, LC_ALL: 'C', GIT_CEILING_DIRECTORIES: dirname(realRoot), GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Runs one git command in `folder` with the hardened flags (no optional locks, fsmonitor off, no
 * signature check) and the `env` of openRepo, cut after GIT_TIMEOUT_MS or `maxBuffer` bytes of
 * output. The read-only part is set here, not by the caller, so no call can miss it:
 * `--no-optional-locks` and GIT_OPTIONAL_LOCKS=0 (git
 * never takes the index lock to refresh it, whatever `env` says) and `-c core.fsmonitor=false`.
 * A diff still needs `-c diff.autoRefreshIndex=false` of its own (src/folders/git-diff.ts).
 * git is run from an argument array without a shell, so no argument is split, expanded or
 * quoted; callers pass paths only after `--` (a name like `--output=x` is never an option).
 * `code` is 0, git's exit code, or Node's error code ('ENOENT' without git,
 * 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' when the output was cut; stdout then holds what was read).
 */
export function runGit(folder: string, env: NodeJS.ProcessEnv, args: string[], maxBuffer = 256 * 1024): Promise<GitRun> {
  const argv = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-C', folder, ...args];
  return new Promise((done) =>
    execFile('git', argv, { env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) =>
      done({ code: error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );
}

const isInside = (root: string, target: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/** `%h NUL %aI NUL %s` per line; a subject never holds a line break. */
function parseLog(stdout: string): GitCommit[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject = ''] = line.split('\0');
      return { sha, date, subject };
    });
}

/** `git status --porcelain=v1 -z`: `XY path NUL`, a rename or copy followed by `from NUL`. A cut last entry is dropped. */
function parseStatus(stdout: string, complete: boolean): { count: number; complete: boolean; files: GitChange[] } {
  const fields = stdout.split('\0');
  // The text after the last NUL is an unfinished entry (or '' when the output ended cleanly).
  fields.pop();
  const files: GitChange[] = [];
  let count = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const change: GitChange = { code, path: entry.slice(3) };
    if (code[0] === 'R' || code[0] === 'C') {
      if (i + 1 >= fields.length) break;
      change.from = fields[++i];
    }
    count++;
    if (files.length < MAX_CHANGES) files.push(change);
  }
  return { count, complete, files };
}

/** A folder whose repository may be read: its real path and git's environment. */
export type OpenRepo = { available: false; reason: GitUnavailable } | { available: true; folder: string; env: NodeJS.ProcessEnv };

/**
 * The confinement every git reader goes through. `rel` goes through resolveInsideRoot
 * (src/folders/tree.ts): a folder outside the root throws InvalidFolderError before git runs.
 * Discovery stops at the root (GIT_CEILING_DIRECTORIES) and a work tree outside the root is
 * refused. No repo, no git and git failing are an `{ available: false, reason }` answer.
 * `options.env` replaces process.env (tests use it to hide git from PATH).
 */
export async function openRepo(root: string, rel: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<OpenRepo> {
  const realRoot = await realpath(root);
  const folder = await resolveInsideRoot(realRoot, rel);
  const env = gitEnv(options.env ?? process.env, realRoot);

  const top = await runGit(folder, env, ['rev-parse', '--show-toplevel']);
  if (top.code === 'ENOENT') return { available: false, reason: 'git_missing' };
  if (top.code !== 0) {
    // A bare repo or the inside of .git: no work tree to show.
    const notRepo = top.code === 128 && /not a git repository|must be run in a work tree/i.test(top.stderr);
    return { available: false, reason: notRepo ? 'not_repo' : 'git_failed' };
  }
  const topLevel = await realpath(resolve(folder, top.stdout.replace(/\n$/, ''))).catch(() => null);
  if (!topLevel || !isInside(realRoot, topLevel)) return { available: false, reason: 'outside_root' };
  return { available: true, folder, env };
}

/**
 * The git state of folder `rel` of the workspace at `root`, confined by openRepo: a folder outside
 * the root throws InvalidFolderError; no repo, no git and git failing answer `{ available: false, reason }`.
 */
export async function folderGitStatus(root: string, rel: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<FolderGit> {
  const repo = await openRepo(root, rel, options);
  if (!repo.available) return repo;
  const { folder, env } = repo;

  const [branch, log, status] = await Promise.all([
    runGit(folder, env, ['symbolic-ref', '-q', '--short', 'HEAD']),
    runGit(folder, env, ['log', `-n${RECENT_COMMITS}`, '--no-color', '--no-show-signature', '--format=%h%x00%aI%x00%s', 'HEAD', '--']),
    runGit(folder, env, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], STATUS_MAX_BYTES),
  ]);
  // symbolic-ref answers 1 for a detached HEAD.
  if (branch.code !== 0 && branch.code !== 1) return { available: false, reason: 'git_failed' };
  const cut = status.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  if (status.code !== 0 && !cut) return { available: false, reason: 'git_failed' };
  // log fails on an unborn branch (no commits yet, HEAD does not verify): no commit to show, not a failure.
  if (log.code !== 0 && (await runGit(folder, env, ['rev-parse', '-q', '--verify', 'HEAD'])).code !== 1) return { available: false, reason: 'git_failed' };
  const recent = log.code === 0 ? parseLog(log.stdout) : [];
  return {
    available: true,
    branch: branch.code === 0 ? branch.stdout.replace(/\n$/, '') || null : null,
    head: recent[0]?.sha ?? null,
    lastCommit: recent[0] ?? null,
    recent,
    changes: parseStatus(status.stdout, !cut),
  };
}
