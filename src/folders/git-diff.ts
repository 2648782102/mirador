// Read-only changes of a workspace folder for the "Changes" panel:
// the per-file stat (`git diff --numstat`, the machine form of `--stat`) and the unified diff
// of the work tree against HEAD, staged and unstaged together, limited to the folder; untracked
// files by name only. Binary files are flagged, never sent.
//
// Confinement and the hardened git invocation come from src/folders/git-status.ts (openRepo,
// runGit): GIT_* removed, GIT_CEILING_DIRECTORIES at the root, a work tree outside the root
// refused, --no-optional-locks and GIT_OPTIONAL_LOCKS=0 (the index is never refreshed or written),
// fsmonitor off, a timeout. On top of that a diff could run programs the repo's config names, so it adds:
// --no-ext-diff and `-c diff.external=` (no external diff), --no-textconv (no textconv driver),
// -c diff.autoRefreshIndex=false (no index refresh and rewrite), --no-pager, every `filter.<driver>` emptied through GIT_CONFIG_COUNT (no clean, smudge or
// process filter; read from `git config`, so odd driver names are covered), GIT_NO_LAZY_FETCH
// (a partial clone never fetches), and --ignore-submodules=dirty (no git run inside submodules).
// Output is bounded: git's output is read up to fixed byte caps and each file's diff is cut on a
// line end. The patch is read up to MAX_DIFF_BYTES at a time: when one huge file fills a read, the
// files after it are read again by literal pathspec, so each file is held to its own
// MAX_FILE_DIFF_BYTES and only the total of what is kept is held to MAX_DIFF_BYTES.
import { openRepo, runGit, type GitUnavailable } from './git-status.ts';

/** Most bytes of diff text in one answer, all files together. */
export const MAX_DIFF_BYTES = 512 * 1024;
/** Most bytes of one file's diff; past it the file is cut on a line end and marked `truncated`. */
export const MAX_FILE_DIFF_BYTES = 64 * 1024;
/** Most changed files listed; `totals` still counts every file the stat read. */
export const MAX_DIFF_FILES = 200;
/** Most untracked names listed; `untracked.count` still counts them all. */
export const MAX_UNTRACKED = 100;
/** Most `git diff --patch` runs in one answer: the first over the folder, then the re-reads after a cut. */
const MAX_PATCH_RUNS = 10;
/** Most bytes of `git diff --numstat` and `git ls-files --others` read. */
const STAT_MAX_BYTES = 1024 * 1024;
const UNTRACKED_MAX_BYTES = 256 * 1024;
/** runGit's code when git wrote more than its byte cap (the output read so far is kept). */
const CUT = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** Why there is no diff: those of git-status, or a repo without a commit to diff against. */
export type DiffUnavailable = GitUnavailable | 'no_commits';

export interface DiffFile {
  /** Path from the repo root. */
  path: string;
  /** The old path of a rename. */
  from?: string;
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  removed: number | null;
  binary: boolean;
  /** The file's unified diff (headers, hunks), plain text; '' past the total cap. */
  patch: string;
  /** True when `patch` is cut or missing because of a cap. */
  truncated: boolean;
}

export type FolderDiff =
  | { available: false; reason: DiffUnavailable }
  | {
      available: true;
      /** Every changed file the stat read, with its lines added and removed (binary files count 0). */
      totals: { files: number; added: number; removed: number };
      /** At most MAX_DIFF_FILES, in git's order. */
      files: DiffFile[];
      /** False when a file was left out, the stat was cut or a patch was cut. */
      complete: boolean;
      untracked: { count: number; complete: boolean; paths: string[] };
    };

/**
 * Flags of both diff commands; global options first, then the subcommand. `git diff HEAD` refreshes
 * and rewrites the index by itself when a tracked file's stat changed but its content did not
 * (diff.autoRefreshIndex, default true), firing post-index-change; --no-optional-locks does not stop
 * that, so it is turned off here.
 */
const DIFF = ['--no-pager', '-c', 'diff.external=', '-c', 'diff.autoRefreshIndex=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--find-renames', '--ignore-submodules=dirty'];

/**
 * `env` plus command-line config that empties every filter driver the repo's config defines, so
 * no clean, smudge or process program runs when git reads the work tree. GIT_CONFIG_COUNT takes
 * any key verbatim (a `-c` argument would split a driver name holding '='). Null when the
 * config cannot be listed.
 */
async function withoutFilters(folder: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv | null> {
  const listed = await runGit(folder, env, ['config', '-z', '--get-regexp', '^filter\\.']);
  // 1: no filter configured.
  if (listed.code !== 0 && listed.code !== 1) return null;
  const drivers = new Set<string>();
  for (const record of listed.stdout.split('\0')) {
    // `-z`: each record is `key\nvalue`; the key is filter.<driver>.<variable>.
    const key = record.split('\n', 1)[0];
    const dot = key.lastIndexOf('.');
    if (key.startsWith('filter.') && dot > 'filter.'.length) drivers.add(key.slice('filter.'.length, dot));
  }
  const overrides: Array<[string, string]> = [...drivers].flatMap((driver): Array<[string, string]> => [
    [`filter.${driver}.clean`, ''],
    [`filter.${driver}.smudge`, ''],
    [`filter.${driver}.process`, ''],
    [`filter.${driver}.required`, 'false'],
  ]);
  const out: NodeJS.ProcessEnv = { ...env, GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return out;
}

type Listed = Omit<DiffFile, 'patch' | 'truncated'>;

/**
 * `--numstat -z`: `added TAB removed TAB path NUL`, a rename `added TAB removed TAB NUL from NUL to NUL`;
 * '-' marks binary. Stops at the first field that is no record (the empty field that ends the stat
 * part of `--numstat --patch`) or at an unfinished record; `end` is the offset just past the last record.
 */
function parseNumstat(stdout: string): { files: Listed[]; end: number } {
  const files: Listed[] = [];
  let end = 0;
  // The field starting at `from`, or null when it has no closing NUL (a cut output).
  const field = (from: number) => {
    const nul = stdout.indexOf('\0', from);
    return nul < 0 ? null : { value: stdout.slice(from, nul), next: nul + 1 };
  };
  for (;;) {
    const record = field(end);
    const match = record && /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record.value);
    if (!record || !match) break;
    const binary = match[1] === '-';
    const file: Listed = { path: match[3], added: binary ? null : Number(match[1]), removed: binary ? null : Number(match[2]), binary };
    let next = record.next;
    if (match[3] === '') {
      const from = field(next);
      const to = from && field(from.next);
      if (!from || !to) break;
      file.from = from.value;
      file.path = to.value;
      next = to.next;
    }
    files.push(file);
    end = next;
  }
  return { files, end };
}

const keyOf = (file: { path: string; from?: string }) => `${file.from ?? ''}\0${file.path}`;
/** A path from the repo root as a pathspec matched as is: no glob, no magic, from the top. */
const literal = (path: string) => `:(top,literal)${path}`;

/** `text` cut to at most `maxBytes` UTF-8 bytes, on the end of a line. */
function cutOnLine(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false };
  const bytes = Buffer.from(text).subarray(0, Math.max(0, maxBytes));
  const end = bytes.lastIndexOf(0x0a);
  return { text: end >= 0 ? bytes.subarray(0, end + 1).toString('utf8') : '', cut: true };
}

/** The patch split into one chunk per file, each starting at its `diff --git` line (content lines start with ' ', '+', '-' or '\'). */
function splitPatch(stdout: string, cut: boolean): string[] {
  // A cut output ends in the middle of a line: drop that line.
  const text = cut ? stdout.slice(0, stdout.lastIndexOf('\n') + 1) : stdout;
  return text.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '));
}

/**
 * The changes of folder `rel` of the workspace at `root` against HEAD. Confined by openRepo: a
 * folder outside the root throws InvalidFolderError; no repo, no commit, no git and git failing
 * answer `{ available: false, reason }`. `options.env` replaces process.env (tests hide git).
 */
export async function folderGitDiff(root: string, rel: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<FolderDiff> {
  const repo = await openRepo(root, rel, options);
  if (!repo.available) return repo;
  const { folder } = repo;

  const head = await runGit(folder, repo.env, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (head.code === 1) return { available: false, reason: 'no_commits' };
  if (head.code !== 0) return { available: false, reason: 'git_failed' };
  const env = await withoutFilters(folder, repo.env);
  if (!env) return { available: false, reason: 'git_failed' };

  // Pathspec '.' from the folder: only its changes; --no-relative keeps paths from the repo root.
  const [numstat, patch, others] = await Promise.all([
    runGit(folder, env, [...DIFF, '--numstat', '-z', 'HEAD', '--', '.'], STAT_MAX_BYTES),
    runGit(folder, env, [...DIFF, '--patch', 'HEAD', '--', '.'], MAX_DIFF_BYTES),
    runGit(folder, env, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '--full-name', '-z', '--', '.'], UNTRACKED_MAX_BYTES),
  ]);
  for (const step of [numstat, patch, others]) if (step.code !== 0 && step.code !== CUT) return { available: false, reason: 'git_failed' };

  const stat = parseNumstat(numstat.stdout).files;
  const listed = stat.slice(0, MAX_DIFF_FILES);
  const kept: Array<{ patch: string; truncated: boolean } | undefined> = new Array(listed.length);
  let budget = MAX_DIFF_BYTES;
  /**
   * Keeps file `i`'s chunk, cut to what the file and the total may still hold. False, keeping
   * nothing, when the chunk is the cut end of git's output and shorter than that: the file's diff
   * was not read whole, so it is read again.
   */
  const keep = (i: number, chunk: string, cutEnd: boolean): boolean => {
    const room = Math.min(MAX_FILE_DIFF_BYTES, budget);
    if (cutEnd && Buffer.byteLength(chunk) <= room) return false;
    const piece = cutOnLine(chunk, room);
    budget -= Buffer.byteLength(piece.text);
    kept[i] = { patch: piece.text, truncated: piece.cut };
    return true;
  };

  // First read: the folder, chunks paired with the stat by position (same flags, same pathspec).
  const firstChunks = splitPatch(patch.stdout, patch.code === CUT);
  for (let i = 0; i < Math.min(firstChunks.length, listed.length) && budget > 0; i++) {
    if (!keep(i, firstChunks[i], patch.code === CUT && i === firstChunks.length - 1)) break;
  }

  // Re-reads: only the files still without a patch, by literal pathspec (both sides of a rename).
  // `--numstat --patch` names the files of each read before their patches, so chunks are paired
  // by path, not position: a narrower pathspec may pair renames differently, and a file the read
  // does not name keeps no patch. A read that keeps nothing, fails or is cut inside its stat ends
  // the re-reads; every file still without a patch is then marked `truncated` with `patch: ''`.
  for (let run = 1; run < MAX_PATCH_RUNS && budget > 0; run++) {
    const pending = new Map<string, number>();
    listed.forEach((file, i) => {
      if (!kept[i]) pending.set(keyOf(file), i);
    });
    if (pending.size === 0) break;
    const paths = [...pending.values()].flatMap((i) => (listed[i].from === undefined ? [listed[i].path] : [listed[i].from as string, listed[i].path]));
    const again = await runGit(folder, env, [...DIFF, '--numstat', '-z', '--patch', 'HEAD', '--', ...paths.map(literal)], MAX_DIFF_BYTES);
    if (again.code !== 0 && again.code !== CUT) break;
    const named = parseNumstat(again.stdout);
    // The stat part ends with one more NUL; without it the read was cut before any patch.
    if (again.stdout[named.end] !== '\0') break;
    const chunks = splitPatch(again.stdout.slice(named.end + 1), again.code === CUT);
    let progressed = false;
    for (let j = 0; j < named.files.length && budget > 0; j++) {
      const i = pending.get(keyOf(named.files[j]));
      if (i === undefined) continue;
      pending.delete(keyOf(named.files[j]));
      if (j >= chunks.length || !keep(i, chunks[j], again.code === CUT && j === chunks.length - 1)) break;
      progressed = true;
    }
    // A file this read did not name, after reading its whole stat, has no patch to wait for.
    if (again.code === 0) for (const i of pending.values()) kept[i] = { patch: '', truncated: true };
    if (!progressed) break;
  }

  const files: DiffFile[] = listed.map((entry, i) => ({ ...entry, ...(kept[i] ?? { patch: '', truncated: true }) }));

  const untrackedFields = others.stdout.split('\0');
  untrackedFields.pop();
  return {
    available: true,
    totals: { files: stat.length, added: stat.reduce((sum, f) => sum + (f.added ?? 0), 0), removed: stat.reduce((sum, f) => sum + (f.removed ?? 0), 0) },
    files,
    complete: numstat.code === 0 && stat.length <= MAX_DIFF_FILES && files.every((file) => !file.truncated),
    untracked: { count: untrackedFields.length, complete: others.code === 0, paths: untrackedFields.slice(0, MAX_UNTRACKED) },
  };
}
