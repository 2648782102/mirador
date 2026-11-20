import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateFile } from './schedule.ts';

/**
 * Execution notes: what the user leaves before sleeping for one agent terminal or
 * for every agent of a workspace. They are the user's own instructions, so the night service
 * delivers them verbatim (no sensitive-material filter; the panel only warns) through the
 * authenticated bridge `message` path when the night shift turns on, each note once.
 *
 * `<stateDir>/night/notes.json` (folder 0700, file 0600): `{ notes: ExecutionNote[] }`,
 * oldest first. A note that could not reach anyone stays pending with `pendingReason`;
 * delivered notes are kept for DELIVERED_KEEP_MS so the panel can show them, then dropped.
 */

export interface ExecutionNote {
  id: string;
  /** Absent for a workspace note (every connected agent terminal of the workspace). */
  terminalId?: string;
  workspaceId: string;
  text: string;
  createdAt: string;
  /** When it went out, and to which terminals. */
  deliveredAt?: string;
  deliveredTo?: string[];
  /** Why the last delivery attempt reached nobody. */
  pendingReason?: string;
}

export interface NoteInput {
  terminalId?: string;
  workspaceId: string;
  text: string;
}

/** What parseNoteInput checks ids against: the workspace store and the terminal registry. */
export interface NoteLookup {
  workspace(id: string): boolean;
  terminal(id: string): { workspaceId: string; kind: string; status: string } | undefined;
}

export const MAX_NOTE_CHARS = 2000;
/** Pending notes at most; delivered ones do not count. */
export const MAX_NOTES = 100;
const MAX_STORED = 300;
const DELIVERED_KEEP_MS = 7 * 24 * 60 * 60_000;
const KEYS = new Set(['terminalId', 'workspaceId', 'text']);
const ID = /^[\w-]{1,128}$/;
/** Control characters other than tab and line breaks. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const FILE = 'notes.json';

export type NoteErrorCode = 'night_note' | 'night_note_workspace' | 'night_note_terminal' | 'night_note_full';

export class NoteError extends Error {
  readonly code: NoteErrorCode;
  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A note from untrusted input; ids must exist and a terminal must be a running agent of that workspace. Throws NoteError. */
export function parseNoteInput(value: unknown, lookup: NoteLookup): NoteInput {
  if (!isRecord(value)) throw new NoteError('night_note', 'expected a JSON object { workspaceId, terminalId?, text }');
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw new NoteError('night_note', `unknown field ${key}`);
  if (typeof value.workspaceId !== 'string' || !ID.test(value.workspaceId)) throw new NoteError('night_note', 'workspaceId must be a workspace id');
  if (value.terminalId !== undefined && (typeof value.terminalId !== 'string' || !ID.test(value.terminalId))) throw new NoteError('night_note', 'terminalId must be a terminal id');
  if (typeof value.text !== 'string' || !value.text.trim()) throw new NoteError('night_note', 'text must say what the agents should do');
  const text = value.text.trim();
  if (Array.from(text).length > MAX_NOTE_CHARS) throw new NoteError('night_note', `text must be at most ${MAX_NOTE_CHARS} characters`);
  if (CONTROL.test(text)) throw new NoteError('night_note', 'text must not hold control characters');
  if (!lookup.workspace(value.workspaceId)) throw new NoteError('night_note_workspace', 'unknown workspace');
  if (value.terminalId === undefined) return { workspaceId: value.workspaceId, text };
  const info = lookup.terminal(value.terminalId);
  if (!info) throw new NoteError('night_note_terminal', 'unknown terminal');
  if (info.kind !== 'agent') throw new NoteError('night_note_terminal', 'notes go to agent terminals only');
  if (info.status !== 'running') throw new NoteError('night_note_terminal', 'the terminal is not running');
  if (info.workspaceId !== value.workspaceId) throw new NoteError('night_note_terminal', 'the terminal belongs to another workspace');
  return { workspaceId: value.workspaceId, terminalId: value.terminalId, text };
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** A stored note with only the documented fields, or null. */
function readNote(value: unknown): ExecutionNote | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.workspaceId !== 'string' || typeof value.text !== 'string' || !isTime(value.createdAt)) return null;
  const note: ExecutionNote = { id: value.id, workspaceId: value.workspaceId, text: value.text, createdAt: value.createdAt };
  if (typeof value.terminalId === 'string') note.terminalId = value.terminalId;
  if (isTime(value.deliveredAt)) {
    note.deliveredAt = value.deliveredAt;
    note.deliveredTo = Array.isArray(value.deliveredTo) ? value.deliveredTo.filter((id): id is string => typeof id === 'string') : [];
  }
  if (typeof value.pendingReason === 'string') note.pendingReason = value.pendingReason;
  return note;
}

export class NoteStore {
  readonly dir: string;
  private readonly now: () => number;
  private notes: ExecutionNote[] | null = null;
  /** Changes run one at a time over the same list. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = options.now ?? Date.now;
  }

  /** Every note, oldest first (copies). */
  async list(): Promise<ExecutionNote[]> {
    return this.serial(async () => (await this.load()).map((note) => structuredClone(note)));
  }

  /** The notes not delivered yet, oldest first. */
  async pending(): Promise<ExecutionNote[]> {
    return (await this.list()).filter((note) => !note.deliveredAt);
  }

  add(input: NoteInput): Promise<ExecutionNote> {
    return this.serial(async () => {
      const notes = await this.load();
      if (notes.filter((note) => !note.deliveredAt).length >= MAX_NOTES) throw new NoteError('night_note_full', `at most ${MAX_NOTES} notes can wait; remove one first`);
      const note: ExecutionNote = { id: randomUUID(), workspaceId: input.workspaceId, ...(input.terminalId ? { terminalId: input.terminalId } : {}), text: input.text, createdAt: new Date(this.now()).toISOString() };
      notes.push(note);
      await this.save(notes);
      return structuredClone(note);
    });
  }

  /** False when there is no such note. */
  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const notes = await this.load();
      const index = notes.findIndex((note) => note.id === id);
      if (index < 0) return false;
      notes.splice(index, 1);
      await this.save(notes);
      return true;
    });
  }

  markDelivered(id: string, terminalIds: string[]): Promise<void> {
    return this.change(id, (note) => {
      note.deliveredAt = new Date(this.now()).toISOString();
      note.deliveredTo = [...terminalIds];
      delete note.pendingReason;
    });
  }

  markPending(id: string, reason: string): Promise<void> {
    return this.change(id, (note) => {
      note.pendingReason = reason;
    });
  }

  private change(id: string, edit: (note: ExecutionNote) => void): Promise<void> {
    return this.serial(async () => {
      const notes = await this.load();
      const note = notes.find((entry) => entry.id === id);
      if (!note) return;
      edit(note);
      await this.save(notes);
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<ExecutionNote[]> {
    if (this.notes) return this.notes;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.dir, FILE), 'utf8'));
    } catch {
      raw = null;
    }
    const list = isRecord(raw) && Array.isArray(raw.notes) ? raw.notes : [];
    const oldest = this.now() - DELIVERED_KEEP_MS;
    this.notes = list.map(readNote).filter((note): note is ExecutionNote => note !== null && !(note.deliveredAt && Date.parse(note.deliveredAt) < oldest));
    return this.notes;
  }

  private async save(notes: ExecutionNote[]): Promise<void> {
    // Past the cap, the oldest delivered notes go first; pending ones are capped by add().
    while (notes.length > MAX_STORED) {
      const index = notes.findIndex((note) => note.deliveredAt);
      if (index < 0) break;
      notes.splice(index, 1);
    }
    await writePrivateFile(this.dir, FILE, JSON.stringify({ notes }, null, 2) + '\n');
  }
}
