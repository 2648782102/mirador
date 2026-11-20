import type { AgentAttentionState } from '../attention/store.ts';

/**
 * The night queue: while the autopilot is on, at most
 * `slots` agents work at once. What would start an agent working (an execution note for an agent
 * that finished or waits, an automatic follow-up) waits here, first in first out, and starts when a
 * slot frees: an agent that finishes its turn or waits for the user frees its slot, so one stuck agent
 * never holds the night. The night service (src/night/service.ts) owns the queue and does the starts;
 * this module is the bookkeeping, with no I/O and no timers.
 *
 * - A running agent holds a slot while its attention state (AttentionStore.agentState) is `working`.
 *   An `unknown` one (nothing reported yet, or pi quit with its terminal open) holds none and gets
 *   no note past the queue: a start to it waits its turn like one to a finished agent.
 * - A start the queue granted holds a claim on a slot from the grant until the agent reports a new
 *   turn (its state turns `working`) or the end of a turn (its bridge's finished line), or until the
 *   night service gives up on it: nothing went out, or CLAIM_MS passed after it went out with neither.
 * - One entry per terminal and kind. A note takes the place of a follow-up queued for the same
 *   terminal (the user's words go first; the note starts the agent anyway), and a follow-up never
 *   joins a terminal whose note waits. A second note for a queued terminal adds no entry: when the
 *   entry starts, every note waiting for that terminal goes out, oldest first.
 *
 * N (`slots`) defaults to suggestedSlots(MemTotal) and the user can set it from 1 to 50.
 */

export const GIB = 1024 ** 3;
/**
 * Memory one working agent is given in the default N:
 * an agent takes ~1 GB idle, 2-3 GB working and peaks at 5-6 GB; 4.5 GiB covers a working agent with
 * room for some of them peaking at once, next to the launch gate's reserve, the desktop and Mirador.
 */
export const AGENT_SHARE_GIB = 4.5;
export const MIN_SLOTS = 1;
export const MAX_SLOTS = 50;
/** N when MemTotal cannot be read. */
export const FALLBACK_SLOTS = 3;
/** How long a start that went out holds its slot while the agent reports no new turn. */
export const CLAIM_MS = 2 * 60_000;
/** How often a start waiting for free memory reads meminfo again. */
export const MEMORY_POLL_MS = 5000;

/** The default N: max(1, floor(MemTotal GiB / AGENT_SHARE_GIB)), at most MAX_SLOTS; 5 on a 24 GB machine. */
export function suggestedSlots(memTotal: number | null): number {
  if (memTotal === null || !Number.isFinite(memTotal) || memTotal <= 0) return FALLBACK_SLOTS;
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, Math.floor(memTotal / GIB / AGENT_SHARE_GIB)));
}

export class QueueError extends Error {
  readonly code = 'night_queue';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The user's N from untrusted input `{ slots }`: a whole number 1-50, or null for the suggested one. Throws QueueError. */
export function parseQueueSettings(value: unknown): number | null {
  const invalid = () => new QueueError(`expected { slots: a whole number 1-${MAX_SLOTS} | null }`);
  if (!isRecord(value) || !('slots' in value) || Object.keys(value).some((key) => key !== 'slots')) throw invalid();
  if (value.slots === null) return null;
  if (typeof value.slots !== 'number' || !Number.isInteger(value.slots) || value.slots < MIN_SLOTS || value.slots > MAX_SLOTS) throw invalid();
  return value.slots;
}

/** A saved N (queue.json), or null for anything that is not one. */
export function savedSlots(value: unknown): number | null {
  try {
    return parseQueueSettings(value);
  } catch {
    return null;
  }
}

export type QueueKind = 'note' | 'follow-up';

/** One start waiting, as GET /api/night shows it. */
export interface QueueItem {
  terminalId: string;
  kind: QueueKind;
  /** When it joined the queue (ISO). */
  since: string;
}

/** N and where it comes from. */
export interface QueueLimit {
  slots: number;
  /** suggestedSlots(memTotal). */
  suggested: number;
  /** The user set `slots` themselves. */
  custom: boolean;
  /** MemTotal in bytes, or null when unreadable. */
  memTotal: number | null;
}

export interface QueueSummary extends QueueLimit {
  /** Agents holding a slot now: working, plus starts not yet reported. */
  working: number;
  queued: number;
  /** A slot is free but free memory is below the reserve: the next start waits for it. */
  memoryWait: boolean;
  items: QueueItem[];
}

/** Whether an agent in `state` holds a slot. */
export const holdsSlot = (state: AgentAttentionState): boolean => state === 'working';

export interface QueueEntry<T> {
  terminalId: string;
  kind: QueueKind;
  since: number;
  data: T;
}

export class NightQueue<T> {
  private entries: Array<QueueEntry<T>> = [];
  /** Granted starts not yet reported working: terminal → when the start went out (null: still going out). */
  private readonly claims = new Map<string, number | null>();

  get size(): number {
    return this.entries.length;
  }

  /**
   * Queues a start for `terminalId` (see the rules at the top); returns whether one is queued for it
   * now. The same kind again replaces the data and keeps the place.
   */
  add(terminalId: string, kind: QueueKind, data: T, now: number): boolean {
    const own = this.entries.find((entry) => entry.terminalId === terminalId);
    if (own?.kind === kind) {
      own.data = data;
      return true;
    }
    if (own && own.kind === 'note') return false;
    if (own) {
      Object.assign(own, { kind, data });
      return true;
    }
    this.entries.push({ terminalId, kind, since: now, data });
    return true;
  }

  has(terminalId: string, kind?: QueueKind): boolean {
    return this.entries.some((entry) => entry.terminalId === terminalId && (kind === undefined || entry.kind === kind));
  }

  /** Takes out the entries of `terminalId` (of `kind` when given) and returns them. */
  remove(terminalId: string, kind?: QueueKind): Array<QueueEntry<T>> {
    const out = this.entries.filter((entry) => entry.terminalId === terminalId && (kind === undefined || entry.kind === kind));
    this.entries = this.entries.filter((entry) => !out.includes(entry));
    return out;
  }

  /** Empties the queue and forgets every claim. */
  clear(): void {
    this.entries = [];
    this.claims.clear();
  }

  /** The first entry, taken out, with a claim on a slot for its terminal. */
  grant(): QueueEntry<T> | undefined {
    const entry = this.entries.shift();
    if (entry) this.claims.set(entry.terminalId, null);
    return entry;
  }

  /** A claim on a slot for `terminalId` without a queue entry (a start that found a free slot at once). */
  claim(terminalId: string): void {
    this.claims.set(terminalId, null);
  }

  claimed(terminalId: string): boolean {
    return this.claims.has(terminalId);
  }

  /** The granted start went out at `now`; false when its claim is already gone. */
  sent(terminalId: string, now: number): boolean {
    if (!this.claims.has(terminalId)) return false;
    this.claims.set(terminalId, now);
    return true;
  }

  /** The claim of `terminalId` ends (it reported a new turn, nothing went out, or it timed out). */
  release(terminalId: string): boolean {
    return this.claims.delete(terminalId);
  }

  /** Slots in use: the running agents in `agents` that hold one by their state, and every claim. */
  busy(agents: Iterable<[string, AgentAttentionState]>): number {
    const ids = new Set(this.claims.keys());
    for (const [id, state] of agents) if (holdsSlot(state)) ids.add(id);
    return ids.size;
  }

  items(): QueueItem[] {
    return this.entries.map((entry) => ({ terminalId: entry.terminalId, kind: entry.kind, since: new Date(entry.since).toISOString() }));
  }
}
