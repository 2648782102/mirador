// The files of one folder, for the in-app editor (W5): list, read, write, and create
// `.env` from `.env.example`. Callers pass a folder that already went through
// ctx.resolveFolder; every file name is then checked here against the same rule
// (after symlinks, inside the workspace root) plus "regular text file, at most 1 MiB".
import { constants, type Stats } from 'node:fs';
import { access, chmod, link, lstat, open, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';

/** Largest file the editor reads or writes. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Most entries one listing returns; the rest are dropped and `truncated` is set. */
export const MAX_LISTED_FILES = 1000;

/** Every code a refused file operation carries; the UI translates each as `error.<code>`. */
export const FILE_ERROR_CODES = [
  'file_name',
  'file_not_found',
  'file_not_regular',
  'file_outside',
  'file_too_large',
  'file_binary',
  'file_permission',
  'file_changed',
  'file_exists',
  'file_content',
  'file_version',
] as const;

export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

/** A refused file operation. `code` is stable; the message is English and never holds file contents. */
export class FileError extends Error {
  code: FileErrorCode;
  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = 'FileError';
    this.code = code;
  }
}

export interface FileEntry {
  name: string;
  size: number;
  /** `.env`, `.env.*` or `*.env`: listed first. */
  dotenv: boolean;
  /** A symlink to a regular file inside the workspace root. */
  symlink: boolean;
  /** Larger than MAX_FILE_BYTES: listed, but the editor cannot open it. */
  tooLarge: boolean;
}

export interface FileListing {
  files: FileEntry[];
  truncated: boolean;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function isDotenv(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

/** `.env` first, then the other dotenv files, then everything else; each group by name. */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.dotenv !== b.dotenv) return a.dotenv ? -1 : 1;
  if (a.name === '.env' || b.name === '.env') return a.name === '.env' ? -1 : 1;
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
}

async function assertFolderInside(root: string, folder: string): Promise<string> {
  const realRoot = await realpath(root);
  if (!isInside(realRoot, folder)) throw new FileError('file_outside', 'folder is outside the workspace root');
  return realRoot;
}

/**
 * The regular files of `folder` (one level, hidden ones included), dotenv files first.
 * Folders, `.git`, sockets and symlinks that leave the root or point to a folder are skipped.
 */
export async function listFiles(root: string, folder: string): Promise<FileListing> {
  const realRoot = await assertFolderInside(root, folder);
  const entries = await readdir(folder, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry): Promise<FileEntry | null> => {
      if (entry.name === '.git' || entry.isDirectory()) return null;
      const path = join(folder, entry.name);
      let info: Stats;
      try {
        if (entry.isFile()) {
          info = await lstat(path);
        } else if (entry.isSymbolicLink()) {
          const target = await realpath(path);
          if (!isInside(realRoot, target)) return null;
          info = await stat(target);
        } else {
          return null;
        }
      } catch {
        return null;
      }
      if (!info.isFile()) return null;
      return {
        name: entry.name,
        size: info.size,
        dotenv: isDotenv(entry.name),
        symlink: entry.isSymbolicLink(),
        tooLarge: info.size > MAX_FILE_BYTES,
      };
    }),
  );
  const files = found.filter((entry): entry is FileEntry => entry !== null).sort(compareEntries);
  return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES };
}

export interface TextFile {
  name: string;
  content: string;
  /** Hash of the bytes on disk; a write must send it back (optimistic concurrency). */
  version: string;
  size: number;
  /** Mirador may not write it (no write permission). */
  readOnly: boolean;
}

export interface SavedFile {
  name: string;
  version: string;
  size: number;
}

/** A plain file name inside the folder: no separators, no `.`/`..`, no NUL, not `.git`. */
export function checkName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name === '.git' ||
    /[/\\\0]/.test(name) ||
    Buffer.byteLength(name) > 255
  ) {
    throw new FileError('file_name', 'expected a plain file name inside the folder');
  }
  return name;
}

function versionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function failure(error: unknown, action: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (error instanceof FileError) throw error;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new FileError('file_not_found', 'file not found');
  if (code === 'EACCES' || code === 'EPERM') throw new FileError('file_permission', `no permission to ${action} the file`);
  if (code === 'ELOOP') throw new FileError('file_outside', 'the file changed into a symlink');
  throw error;
}

/**
 * Real path of file `name` in `folder`: a regular file, or a symlink whose target
 * (after realpath) is a regular file inside the workspace root.
 */
async function resolveFile(root: string, folder: string, name: unknown): Promise<{ real: string; info: Stats }> {
  const plain = checkName(name);
  const realRoot = await assertFolderInside(root, folder);
  const candidate = join(folder, plain);
  try {
    let info = await lstat(candidate);
    let real = candidate;
    if (info.isSymbolicLink()) {
      real = await realpath(candidate);
      if (!isInside(realRoot, real)) throw new FileError('file_outside', 'the symlink points outside the workspace root');
      info = await stat(real);
    }
    if (!info.isFile()) throw new FileError('file_not_regular', 'not a regular file');
    return { real, info };
  } catch (error) {
    failure(error, 'read');
  }
}

/** Reads at most MAX_FILE_BYTES from a regular file, without following a last-moment symlink or blocking on a FIFO. */
async function readBytes(real: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    failure(error, 'read');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileError('file_not_regular', 'not a regular file');
    if (info.size > MAX_FILE_BYTES) throw new FileError('file_too_large', 'file is larger than 1 MiB');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new FileError('file_too_large', 'file is larger than 1 MiB');
    return bytes;
  } finally {
    await handle.close();
  }
}

/** UTF-8 text without NUL bytes; a byte-order mark is kept so a save writes it back. */
function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new FileError('file_binary', 'binary file');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FileError('file_binary', 'file is not UTF-8 text');
  }
}

async function isWritable(real: string): Promise<boolean> {
  try {
    await access(real, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(root: string, folder: string, name: unknown): Promise<TextFile> {
  const { real } = await resolveFile(root, folder, name);
  const bytes = await readBytes(real);
  return { name: name as string, content: decodeText(bytes), version: versionOf(bytes), size: bytes.length, readOnly: !(await isWritable(real)) };
}

function encodeText(content: unknown): Buffer {
  if (typeof content !== 'string') throw new FileError('file_content', 'content must be a string');
  // A lone UTF-16 surrogate has no UTF-8 form: Buffer.from would save U+FFFD in its place.
  if (!content.isWellFormed()) throw new FileError('file_content', 'content holds a lone UTF-16 surrogate');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new FileError('file_too_large', 'content is larger than 1 MiB');
  if (bytes.includes(0)) throw new FileError('file_binary', 'content holds NUL bytes');
  return bytes;
}

/** The exact name writeTemp gives a temp file: `.<target>.mirador-<12 hex>.tmp`. */
const TEMP_NAME = /^\..+\.mirador-[0-9a-f]{12}\.tmp$/;
/** A temp file older than this was left by a crash; a save in flight never takes this long. */
const STALE_TEMP_MS = 10 * 60 * 1000;

/**
 * Removes the temp files a hard crash left in `dir` (they can hold `.env` content):
 * only regular files (never through a symlink) named exactly like writeTemp's and
 * older than STALE_TEMP_MS. Best effort: a failure never stops the save.
 */
async function sweepStaleTemps(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => TEMP_NAME.test(name));
    for (const name of names) {
      const path = join(dir, name);
      try {
        const info = await lstat(path);
        if (info.isFile() && Date.now() - info.mtimeMs > STALE_TEMP_MS) await unlink(path);
      } catch {
        // Gone already, or not ours to remove: leave it.
      }
    }
  } catch {
    // An unreadable folder only means nothing is swept.
  }
}

/**
 * Writes `bytes` to a new temp file next to `target` with `mode`, flushed to disk.
 * Returns its path; the caller renames or links it into place and removes it on failure.
 * Stale temp files in the same folder are swept first.
 */
async function writeTemp(target: string, bytes: Buffer, mode: number): Promise<string> {
  await sweepStaleTemps(dirname(target));
  const temp = join(dirname(target), `.${basename(target)}.mirador-${randomBytes(6).toString('hex')}.tmp`);
  // Owner-only until the content is complete: it may be a `.env`.
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    // open() applies the umask, and writing clears setuid/setgid: the mode is set after
    // the write, so the saved file keeps exactly the mode it had.
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temp;
}

// One write at a time per file, so two saves of the same version cannot both win.
const writing = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writing.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  writing.set(key, next);
  try {
    return await next;
  } finally {
    if (writing.get(key) === next) writing.delete(key);
  }
}

/**
 * Replaces the content of an existing file, atomically (temp file in the same
 * folder + rename) and keeping its mode. `version` must be the one the editor
 * read: if the file changed on disk since, nothing is written (`file_changed`).
 * A symlink inside the root stays a symlink: its target is replaced.
 */
export async function writeTextFile(root: string, folder: string, name: unknown, content: unknown, version: unknown): Promise<SavedFile> {
  const bytes = encodeText(content);
  if (typeof version !== 'string' || version === '') throw new FileError('file_version', 'version is required');
  const first = await resolveFile(root, folder, name);
  return oneAtATime(first.real, async () => {
    // Resolved again under the lock: what counts is the file as it is now.
    const { real, info } = await resolveFile(root, folder, name);
    if (versionOf(await readBytes(real)) !== version) throw new FileError('file_changed', 'the file changed on disk');
    if (!(await isWritable(real))) throw new FileError('file_permission', 'no permission to write the file');
    let temp: string | undefined;
    try {
      temp = await writeTemp(real, bytes, info.mode & 0o7777);
      await rename(temp, real);
      temp = undefined;
    } catch (error) {
      failure(error, 'write');
    } finally {
      if (temp) await unlink(temp).catch(() => undefined);
    }
    return { name: name as string, version: versionOf(bytes), size: bytes.length };
  });
}

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates `.env` from `.env.example` in `folder`, like `cp .env.example .env`
 * (same bytes, same mode), and never replaces anything already named `.env`,
 * not even a dangling symlink (`file_exists`). The example passes the same checks
 * as a read: regular UTF-8 text inside the root, at most 1 MiB.
 */
export async function createEnvFromExample(root: string, folder: string): Promise<SavedFile> {
  const target = join(folder, ENV_FILE);
  if (await exists(target)) throw new FileError('file_exists', '.env already exists');
  const { real, info } = await resolveFile(root, folder, ENV_EXAMPLE_FILE);
  const bytes = await readBytes(real);
  decodeText(bytes);
  const mode = info.mode & 0o7777;
  let temp: string | undefined;
  try {
    temp = await writeTemp(target, bytes, mode);
    // link() appears atomically and fails if the name exists, so a concurrent .env is never replaced.
    await link(temp, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST' || !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code ?? '')) throw error;
      // File systems without hard links: exclusive create, still never an overwrite.
      await writeFile(target, bytes, { flag: 'wx', mode });
      await chmod(target, mode);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileError('file_exists', '.env already exists');
    failure(error, 'write');
  } finally {
    if (temp) await unlink(temp).catch(() => undefined);
  }
  return { name: ENV_FILE, version: versionOf(bytes), size: bytes.length };
}
