import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateDir } from '../config.ts';
import { LEGACY_USER_VALUES } from './legacy-owner.ts';

/**
 * The night shift's audit trail: one JSON record per question or delegation in
 * `<stateDir>/night/decisions.jsonl` (folder 0700, file 0600). Append-only; past
 * `maxBytes` the file becomes `decisions.1.jsonl` (replacing the previous one) and
 * a new one starts, so at most twice the limit is kept. Records hold what was asked,
 * what was decided and why, and what was sent; never a token or the environment.
 *
 * subscribe() announces each record once it is on disk. The night routes and the morning
 * report each build a NightLog over the same folder, so listeners, the append queue
 * and the in-memory index are shared by every NightLog of one folder in this process.
 *
 * recent() answers from a bounded in-memory index of the newest records (about
 * `indexBytes` of JSON lines): seeded once from both files on first use, then fed by every
 * append and rotation, and read again only when a file changed on disk behind its back
 * (size, mtime or inode differ). A window reaching past the index reads the files.
 */

/** A question as logged: texts capped, enough for the morning report. */
export interface LoggedQuestion {
  allowCustomResponse: boolean;
  items: Array<{ question: string; header: string; options: string[]; multiSelect: boolean }>;
}

export interface NightRecord {
  id: string;
  /** ISO time the record was written. */
  time: string;
  /** `auto-follow-up`: a follow-up the night shift ran by itself after an agent's final message. */
  kind: 'question' | 'delegate' | 'auto-follow-up' | 'note';
  terminalId: string;
  workspaceId: string | null;
  rel: string | null;
  tool: string | null;
  question: LoggedQuestion | null;
  /** Whether the policy let the decider see it, and the rule that stopped it. */
  policy: { allowed: boolean; rule?: string; reason?: string };
  decision: { action: 'answer' | 'defer'; choices?: Array<{ item: number; index: number; label: string }>; reason: string; confidence?: number } | null;
  followUp: { action: 'follow-up' | 'defer'; message?: string; reason: string; confidence?: number } | null;
  /**
   * What Mirador answered the bridge: `pass` (the dialog opens), `decided`, a follow-up `message`,
   * `held` (the question waits for the user's answer from Telegram), or nothing.
   */
  sent: 'pass' | 'decided' | 'message' | 'held' | 'none';
  /** For a held question (`sent: 'held'`) and the answer that ended it: the HeldQuestion id. */
  heldId?: string;
  /**
   * Set when the user decided it themselves, from Telegram; absent for the autopilot's decisions.
   * Lines written before N1 hold the legacy value (LEGACY_USER_VALUES.decidedBy): they are read as
   * 'user-telegram' and never rewritten.
   */
  decidedBy?: 'user-telegram';
  /** For a follow-up: whether the bridge confirmed delivery; null otherwise. */
  delivered: boolean | null;
  outcome: 'decided' | 'followed-up' | 'deferred' | 'dropped';
  /** Why it was left for the user (`deferred`) or dropped: a stable rule id and plain text. */
  deferral: { rule: string; reason: string } | null;
  /** An unexpected failure (decider error, socket error), when there was one. */
  error: string | null;
  /**
   * For kind `note`: the execution note the user left, or with `from: 'mirador'` the note Mirador
   * sends before it puts an idle agent to sleep. Absent `from`: the user's note.
   */
  note?: { id: string; text: string; from?: 'mirador' };
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** JSON kept in memory for recent(): the newest records, about this many characters of lines. */
export const DEFAULT_INDEX_BYTES = 2 * 1024 * 1024;
const CURRENT = 'decisions.jsonl';
const PREVIOUS = 'decisions.1.jsonl';
const DEFAULT_LIMIT = 500;

export function nightLogDir(env = process.env): string {
  return join(stateDir(env), 'night');
}

export type NightLogListener = (record: NightRecord) => void;

/** What a file looked like when the index last matched it; null when it did not exist. */
type FileSig = { size: number; mtimeMs: number; ino: number } | null;

interface IndexEntry {
  /** Date.parse(record.time). */
  at: number;
  record: NightRecord;
  /** The length of its JSON line. */
  size: number;
  /** The file generation holding it: the current file is `gen`, the previous one `gen - 1`. */
  gen: number;
}

/** The newest records of both files, oldest first: always a suffix of what the files hold. */
interface LogIndex {
  entries: IndexEntry[];
  size: number;
  gen: number;
  /** Per generation still on disk: the newest time among its records left out of the index. */
  dropped: Map<number, number>;
  /** [previous, current] as the index matches them; null while unknown (forces a reload). */
  sigs: [FileSig, FileSig] | null;
}

/** What every NightLog of one folder shares: the append queue, the listeners and the index. */
interface FolderState {
  /** Appends (and index syncs) run one at a time, so lines never interleave and rotation sees the real size. */
  queue: Promise<void>;
  prepared: boolean;
  listeners: Set<NightLogListener>;
  index: LogIndex | null;
  indexBytes: number;
}

const folders = new Map<string, FolderState>();

function folderState(dir: string): FolderState {
  const key = resolve(dir);
  let state = folders.get(key);
  if (!state) {
    state = { queue: Promise.resolve(), prepared: false, listeners: new Set(), index: null, indexBytes: DEFAULT_INDEX_BYTES };
    folders.set(key, state);
  }
  return state;
}

const sigOf = (s: Stats): FileSig => ({ size: s.size, mtimeMs: s.mtimeMs, ino: s.ino });
const sameSig = (a: FileSig, b: FileSig) => a === b || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino);

async function fileSig(path: string): Promise<FileSig> {
  try {
    return sigOf(await stat(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A parsed log line, or null for a damaged line or one without a valid time (never returned by recent()).
 * An old line whose decidedBy is the value (LEGACY_USER_VALUES.decidedBy) is read as
 * 'user-telegram'; the file is never rewritten.
 */
function parseLine(line: string): { record: NightRecord; at: number } | null {
  if (!line) return null;
  let value: NightRecord;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || typeof value.time !== 'string') return null;
  const at = Date.parse(value.time);
  if (Number.isNaN(at)) return null;
  if ((value.decidedBy as string | undefined) === LEGACY_USER_VALUES.decidedBy) value.decidedBy = 'user-telegram';
  return { record: value, at };
}

/** Adds the newest record and drops the oldest past `maxSize`, remembering how new the dropped ones were. */
function addEntry(index: LogIndex, entry: IndexEntry, maxSize: number): void {
  index.entries.push(entry);
  index.size += entry.size;
  let drop = 0;
  while (index.size > maxSize && drop < index.entries.length) {
    const old = index.entries[drop++];
    index.size -= old.size;
    index.dropped.set(old.gen, Math.max(index.dropped.get(old.gen) ?? -Infinity, old.at));
  }
  if (drop) index.entries.splice(0, drop);
}

/** The current file became the previous one: what the old previous file held is gone. */
function rotateIndex(index: LogIndex): void {
  index.gen++;
  const keep = index.entries.findIndex((entry) => entry.gen >= index.gen - 1);
  const gone = keep === -1 ? index.entries.length : keep;
  for (const entry of index.entries.slice(0, gone)) index.size -= entry.size;
  index.entries.splice(0, gone);
  for (const gen of [...index.dropped.keys()]) if (gen < index.gen - 1) index.dropped.delete(gen);
}

export class NightLog {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly shared: FolderState;

  /** `indexBytes`: JSON kept in memory for recent() by every NightLog of this folder (default 2 MiB). */
  constructor(dir = nightLogDir(), options: { maxBytes?: number; indexBytes?: number } = {}) {
    this.dir = dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.shared = folderState(dir);
    if (options.indexBytes !== undefined && Number.isFinite(options.indexBytes) && options.indexBytes >= 0) this.shared.indexBytes = options.indexBytes;
  }

  /** Appends one record. Never rejects: a log failure is reported on stderr, not into the night shift. */
  append(record: NightRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    const run = this.shared.queue
      .then(() => this.write(line))
      .then(
        () => this.announce(record),
        (error) => console.error('night log append failed:', error),
      );
    this.shared.queue = run;
    return run;
  }

  /**
   * Calls `listener` with each record appended to this folder (by any NightLog of it) once
   * it is written; a record that could not be written is not announced. Returns the
   * unsubscribe function. A throwing listener is reported, never the append's problem.
   */
  subscribe(listener: NightLogListener): () => void {
    this.shared.listeners.add(listener);
    return () => void this.shared.listeners.delete(listener);
  }

  private announce(record: NightRecord): void {
    for (const listener of [...this.shared.listeners]) {
      try {
        listener(record);
      } catch (error) {
        console.error('night log listener failed:', error);
      }
    }
  }

  /**
   * Records written at or after `since` (ms, Date or ISO string), oldest first, at most `limit` (the newest).
   * Served from the in-memory index when no record outside it can be part of the answer;
   * the records are shared with other callers, who must not mutate them.
   */
  async recent(options: { since?: number | Date | string; limit?: number } = {}): Promise<NightRecord[]> {
    const ready = this.shared.queue.then(() => this.sync());
    this.shared.queue = ready.then(
      () => undefined,
      () => undefined,
    );
    const index = await ready;
    const since = options.since === undefined ? -Infinity : new Date(options.since).getTime();
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (limit <= 0) return [];
    const matches: NightRecord[] = [];
    for (const entry of index.entries) if (entry.at >= since) matches.push(entry.record);
    // Every record on disk is in the index, none left out of it is that new, or the newest `limit` are all in it.
    if (index.dropped.size === 0 || Math.max(...index.dropped.values()) < since || matches.length >= limit) return matches.slice(-limit);
    return this.readFiles(since, limit);
  }

  /** The index, read again from the files when it is missing or a file changed on disk. Runs in the queue. */
  private async sync(): Promise<LogIndex> {
    const sigs: [FileSig, FileSig] = [await fileSig(join(this.dir, PREVIOUS)), await fileSig(join(this.dir, CURRENT))];
    const known = this.shared.index;
    if (known?.sigs && sameSig(known.sigs[0], sigs[0]) && sameSig(known.sigs[1], sigs[1])) return known;
    const index: LogIndex = { entries: [], size: 0, gen: 1, dropped: new Map(), sigs: null };
    for (const [gen, name] of [[0, PREVIOUS], [1, CURRENT]] as const) {
      if (!sigs[gen]) continue;
      let text: string;
      try {
        text = await readFile(join(this.dir, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const line of text.split('\n')) {
        const parsed = parseLine(line);
        if (parsed) addEntry(index, { ...parsed, size: line.length + 1, gen }, this.shared.indexBytes);
      }
    }
    index.sigs = sigs;
    this.shared.index = index;
    return index;
  }

  /** recent() over both files, for a window that reaches past the index. */
  private async readFiles(since: number, limit: number): Promise<NightRecord[]> {
    const records: NightRecord[] = [];
    for (const name of [PREVIOUS, CURRENT]) {
      let text: string;
      try {
        text = await readFile(join(this.dir, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const line of text.split('\n')) {
        const parsed = parseLine(line);
        if (parsed && parsed.at >= since) records.push(parsed.record);
      }
    }
    return records.slice(-limit);
  }

  private async write(line: string): Promise<void> {
    if (!this.shared.prepared) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      this.shared.prepared = true;
    }
    const path = join(this.dir, CURRENT);
    let before: FileSig = null;
    try {
      before = sigOf(await stat(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The index follows this write only if it matched the current file before it.
    let index = this.shared.index;
    if (index && !(index.sigs && sameSig(index.sigs[1], before))) index = this.shared.index = null;
    const previousSig = index?.sigs?.[0] ?? null;
    // Unknown until the write is done: a failure halfway makes the next recent() read the files.
    if (index) index.sigs = null;
    const size = before?.size ?? 0;
    const rotated = size > 0 && size + Buffer.byteLength(line) > this.maxBytes;
    if (rotated) {
      await rename(path, join(this.dir, PREVIOUS));
      if (index) rotateIndex(index);
    }
    const handle = await open(path, 'a', 0o600);
    let after: FileSig;
    try {
      // The umask may loosen a new file, and an old one may have been loosened by hand.
      await handle.chmod(0o600);
      await handle.appendFile(line);
      after = sigOf(await handle.stat());
    } finally {
      await handle.close();
    }
    if (!index) return;
    const parsed = parseLine(line.slice(0, -1));
    if (parsed) addEntry(index, { ...parsed, size: line.length, gen: index.gen }, this.shared.indexBytes);
    index.sigs = [rotated ? before : previousSig, after];
  }
}
