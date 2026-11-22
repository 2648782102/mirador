// "Where it left off" without Engram: a bounded local record of what Claude Code's own hooks hand
// over. bin/claude-hook forwards three documented hook fields (https://code.claude.com/docs/en/hooks)
// over Mirador's herdr socket as `left-off` lines:
//   UserPromptSubmit  prompt                  → lastUserMessage (as received: pasted text already expanded)
//   Stop              last_assistant_message  → lastMessage
//   PostCompact       compact_summary         → compactSummary
// The hook writes nothing itself: the server validates each line (its shape, a running agent
// terminal, the session id, the size) and writes the record, one per (workspace, folder, agent),
// at <stateDir>/left-off/<workspace>/<hash of rel>.claude-code.json, 0600 in 0700 folders, through
// writePrivateFile (atomic). Mirador never reads Claude Code's configuration or transcripts.
// The text is untrusted (model output, the user's own pastes): it is stored and shown only as text,
// never logged, never sent anywhere. Records older than `leftOffDays` are removed at start and on
// writes, and never read back.
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writePrivateFile } from '../night/schedule.ts';
import type { TerminalInfo } from '../terminals/registry.ts';

export const LEFT_OFF_CMD = 'left-off';
export const LEFT_OFF_AGENT = 'claude-code';
/** Each stored text, in UTF-8 bytes, marker included (bin/claude-hook cuts to the same bound). */
export const LEFT_OFF_MAX_TEXT_BYTES = 16 * 1024;
/**
 * One left-off line on the socket: a bounded text JSON-escaped (a control character takes six bytes)
 * plus its envelope. Attention reports keep their own 4096-byte cap (src/attention/store.ts).
 */
export const LEFT_OFF_MAX_LINE_BYTES = 128 * 1024;
/** Appended to a text that was cut. */
export const TRUNCATED_MARK = '…';
/** Writes sweep expired records at most this often (start always sweeps). */
const SWEEP_EVERY_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const EVENT_FIELDS = { UserPromptSubmit: 'lastUserMessage', Stop: 'lastMessage', PostCompact: 'compactSummary' } as const;
type Field = (typeof EVENT_FIELDS)[keyof typeof EVENT_FIELDS];
const FIELDS: Field[] = ['lastUserMessage', 'lastMessage', 'compactSummary'];
const LINE_KEYS = new Set(['v', 'cmd', 'pane', 'agent', 'event', 'session', 'text', 'truncated']);
const PANE = /^[\w-]{1,64}$/;
/** As SESSION_ID in src/agents/catalog.ts and bin/claude-hook. */
const SESSION_ID = /^[A-Za-z0-9][\w-]{0,127}$/;
const SAFE_NAME = /^[\w-]{1,64}$/;

/** One stored text: when it arrived, and whether it was cut to the bound. */
export interface LeftOffText {
  text: string;
  /** ISO time the server received it. */
  at: string;
  truncated?: true;
}

/** The record of one folder (format v1; docs/attention.md#where-it-left-off). */
export interface LeftOffRecord {
  v: 1;
  agent: typeof LEFT_OFF_AGENT;
  workspaceId: string;
  rel: string;
  /** The Claude Code session the texts come from; a new session starts a new record. */
  sessionId: string;
  /** ISO time of the latest write. */
  at: string;
  lastUserMessage: LeftOffText | null;
  lastMessage: LeftOffText | null;
  compactSummary: LeftOffText | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * `text` when it fits in `max` UTF-8 bytes; otherwise its longest start that fits with TRUNCATED_MARK
 * after it, cut between characters (never inside one).
 */
export function boundText(text: string, max = LEFT_OFF_MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return { text, truncated: false };
  let end = max - Buffer.byteLength(TRUNCATED_MARK);
  // A UTF-8 continuation byte (10xxxxxx) is inside a character: step back to its first byte.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8') + TRUNCATED_MARK, truncated: true };
}

/** <stateDir>/left-off. */
export function leftOffDir(stateDir: string): string {
  return join(stateDir, 'left-off');
}

/** The record file of folder `rel` of workspace `workspaceId`: the id as a folder (hashed unless plain), the folder hashed. */
export function recordFile(dir: string, workspaceId: string, rel: string): string {
  const workspace = SAFE_NAME.test(workspaceId) ? workspaceId : `ws-${sha(workspaceId).slice(0, 16)}`;
  return join(dir, workspace, `${sha(rel).slice(0, 32)}.${LEFT_OFF_AGENT}.json`);
}

function validText(value: unknown): value is LeftOffText {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    Buffer.byteLength(value.text) <= LEFT_OFF_MAX_TEXT_BYTES &&
    typeof value.at === 'string' &&
    Number.isFinite(Date.parse(value.at)) &&
    (value.truncated === undefined || value.truncated === true)
  );
}

/** The record in `text` when it is a valid v1 record, else null. */
function parseRecord(text: string): LeftOffRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || value.agent !== LEFT_OFF_AGENT) return null;
  if (typeof value.workspaceId !== 'string' || typeof value.rel !== 'string' || typeof value.sessionId !== 'string') return null;
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  for (const field of FIELDS) if (value[field] !== null && !validText(value[field])) return null;
  return value as unknown as LeftOffRecord;
}

const expired = (at: string, days: number, now: number) => Date.parse(at) < now - days * DAY_MS;

/** The record of folder `rel`, or null when there is none, it is not valid, or it is older than `days`. */
export async function readLeftOff(dir: string, workspaceId: string, rel: string, options: { days: number; now?: number }): Promise<LeftOffRecord | null> {
  let text: string;
  try {
    text = await readFile(recordFile(dir, workspaceId, rel), 'utf8');
  } catch {
    return null;
  }
  const record = parseRecord(text);
  if (!record || record.workspaceId !== workspaceId || record.rel !== rel) return null;
  return expired(record.at, options.days, options.now ?? Date.now()) ? null : record;
}

/**
 * Removes every record older than `days` (by its `at`; a file that is no record, by its mtime) and
 * workspace folders left empty. Returns how many records went.
 */
export async function sweepLeftOff(dir: string, options: { days: number; now?: number }): Promise<number> {
  const now = options.now ?? Date.now();
  let removed = 0;
  const workspaces = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const folder = join(dir, workspace.name);
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const file = join(folder, name);
      try {
        const record = parseRecord(await readFile(file, 'utf8'));
        const old = record ? expired(record.at, options.days, now) : (await stat(file)).mtimeMs < now - options.days * DAY_MS;
        if (!old) continue;
        await rm(file, { force: true });
        removed++;
      } catch {
        continue;
      }
    }
    await rmdir(folder).catch(() => undefined);
  }
  return removed;
}

/** A valid left-off line. */
interface LeftOffLine {
  pane: string;
  field: Field;
  session: string;
  text: string;
  truncated: boolean;
}

/**
 * The left-off line in `line`: undefined when it is no left-off line at all (an attention report),
 * null when it is one but not valid. Never throws.
 */
export function parseLeftOffLine(line: string): LeftOffLine | null | undefined {
  if (Buffer.byteLength(line) > LEFT_OFF_MAX_LINE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // A cut left-off line is still one: never hand it on as an attention report.
    return line.includes(`"${LEFT_OFF_CMD}"`) ? null : undefined;
  }
  if (!isRecord(value) || value.cmd !== LEFT_OFF_CMD) return undefined;
  if (value.v !== 1 || !Object.keys(value).every((key) => LINE_KEYS.has(key))) return null;
  const { pane, agent, event, session, text, truncated = false } = value;
  if (typeof pane !== 'string' || !PANE.test(pane) || agent !== LEFT_OFF_AGENT) return null;
  if (typeof event !== 'string' || !Object.hasOwn(EVENT_FIELDS, event)) return null;
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  if (typeof text !== 'string' || !text.trim() || typeof truncated !== 'boolean') return null;
  const bounded = boundText(text);
  return { pane, field: EVENT_FIELDS[event as keyof typeof EVENT_FIELDS], session, text: bounded.text, truncated: truncated || bounded.truncated };
}

/**
 * Receives left-off lines from the herdr socket and writes the records. `terminal` says which
 * terminal a pane id is (TerminalRegistry.get): only a running agent terminal's lines are kept, filed
 * under its workspace and folder. Writes run one after another, in the order the lines arrived.
 */
export class LeftOffStore {
  private readonly dir: string;
  private readonly days: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly terminal: (id: string) => TerminalInfo | undefined;
  private queue: Promise<void> = Promise.resolve();
  private lastSweep = 0;

  constructor(options: { dir: string; days: number; enabled: boolean; terminal: (id: string) => TerminalInfo | undefined; now?: () => number }) {
    this.dir = options.dir;
    this.days = options.days;
    this.enabled = options.enabled;
    this.terminal = options.terminal;
    this.now = options.now ?? Date.now;
  }

  /**
   * Applies one socket line: undefined when it is no left-off line (hand it to the attention store),
   * false when it is one and was refused (nothing is written), true when its write was queued.
   */
  receive(line: string): boolean | undefined {
    const parsed = parseLeftOffLine(line);
    if (parsed === undefined) return undefined;
    if (!parsed || !this.enabled) return false;
    const info = this.terminal(parsed.pane);
    if (!info || info.kind !== 'agent' || info.status !== 'running') return false;
    const { workspaceId, rel } = info;
    this.queue = this.queue.then(() => this.write(workspaceId, rel, parsed)).catch((error) => {
      // Never the text: only that a write failed, and why.
      console.error(`mirador: a left-off record could not be written: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`);
    });
    return true;
  }

  /** Resolves once every queued write has ended. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Removes expired records (sweepLeftOff); makes the folder 0700 first. */
  async sweep(): Promise<number> {
    this.lastSweep = this.now();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    return sweepLeftOff(this.dir, { days: this.days, now: this.now() });
  }

  private async write(workspaceId: string, rel: string, line: LeftOffLine): Promise<void> {
    if (this.now() - this.lastSweep >= SWEEP_EVERY_MS) await this.sweep();
    else {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
    }
    const file = recordFile(this.dir, workspaceId, rel);
    const at = new Date(this.now()).toISOString();
    const previous = await readLeftOff(this.dir, workspaceId, rel, { days: this.days, now: this.now() });
    // One current record per folder: a new session replaces the last one's texts.
    const record: LeftOffRecord =
      previous && previous.sessionId === line.session
        ? { ...previous, at }
        : { v: 1, agent: LEFT_OFF_AGENT, workspaceId, rel, sessionId: line.session, at, lastUserMessage: null, lastMessage: null, compactSummary: null };
    record[line.field] = { text: line.text, at, ...(line.truncated ? { truncated: true as const } : {}) };
    await writePrivateFile(dirname(file), basename(file), JSON.stringify(record, null, 2) + '\n');
  }
}

/** Which text of `record` the view parses: the final message, else the compaction summary, else none. */
export function leftOffSource(record: LeftOffRecord): { from: Field; text: LeftOffText | null } {
  if (record.lastMessage) return { from: 'lastMessage', text: record.lastMessage };
  if (record.compactSummary) return { from: 'compactSummary', text: record.compactSummary };
  return { from: 'lastUserMessage', text: null };
}

/** An ISO time as Engram writes its own ("YYYY-MM-DD HH:MM:SS", UTC), so the two compare as text. */
export function engramTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}
