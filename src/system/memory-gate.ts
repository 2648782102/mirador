import { randomUUID } from 'node:crypto';
import { readMachineMemory } from './resources.ts';

/**
 * The launch gate ("ir por lotes"): agents Mirador
 * starts in a row (a multi-open batch, the restore at startup) go through one gate per server.
 *
 * - Batches: at most `batchSize` agents start, then the next waits until `settleMs` passed since
 *   the batch's last start. An agent grows for about its first minute while pi and its MCP
 *   servers start, so a fixed settle time is the rule: it needs no reading per scope, works
 *   with scopes off, and the memory check below still catches a batch that grew more than usual.
 *   After `settleMs` without a start, a new batch begins at once.
 * - Memory: before each start it reads MemAvailable and waits, polling every `pollMs`, while it
 *   is under the reserve: `reserveBytes`, or max(2 GiB, 15 % of MemTotal). An unreadable
 *   meminfo never blocks.
 * - Bounded: each run (one batch, one restore) waits for memory `maxWaitMs` in total at most;
 *   then it answers `low_memory` and its remaining agents are not started. close() (the server's
 *   shutdown) and the run's own signal cancel any wait at once.
 * - Ordered: starts are granted one at a time, first asked first served, so two batches (or a
 *   batch and the restore) at once still start `batchSize` agents per settle between them.
 *
 * Only agents go through it: bash terminals and an agent opened by hand start at once.
 *
 * Other modules read the runs through status() (GET /api/terminals/launches): each run's
 * progress, what it waits for and how much memory is missing; cancel(id) stops what a run has
 * left to start (Pausar, POST /api/terminals/launches/:id/cancel). A run's caller says how many agents it may start (`total`), takes out the
 * ones that need none (skip) or did not start once granted (fail), and ends it (end): its folders left
 * then count as `lowMemory` when the gate gave up on memory, else as `cancelled`.
 */

/** Agents started together before a settle. */
export const BATCH_SIZE = 3;
/** How long a batch settles after its last start before the next batch starts. */
export const SETTLE_MS = 45_000;
/** The reserve's floor, and its share of MemTotal (the larger one applies). */
export const MIN_RESERVE_BYTES = 2 * 1024 ** 3;
export const RESERVE_SHARE = 0.15;
/** How long one run waits for memory in total before it gives up on the rest. */
export const MAX_WAIT_MS = 10 * 60_000;
/** How often a wait for memory reads meminfo again. */
export const POLL_MS = 2000;

export interface LaunchLimits {
  batchSize: number;
  settleMs: number;
  /** A fixed reserve; null for max(MIN_RESERVE_BYTES, RESERVE_SHARE of MemTotal). 0 never waits. */
  reserveBytes: number | null;
  maxWaitMs: number;
  pollMs: number;
}

export const DEFAULT_LIMITS: LaunchLimits = { batchSize: BATCH_SIZE, settleMs: SETTLE_MS, reserveBytes: null, maxWaitMs: MAX_WAIT_MS, pollMs: POLL_MS };

/** The config's `launches` (src/config.ts, already validated) as limits. */
export function limitsFromConfig(launches: { batchSize?: number; settleMs?: number; reserveMb?: number; maxWaitMs?: number } = {}): Partial<LaunchLimits> {
  return {
    ...(launches.batchSize !== undefined ? { batchSize: launches.batchSize } : {}),
    ...(launches.settleMs !== undefined ? { settleMs: launches.settleMs } : {}),
    ...(launches.reserveMb !== undefined ? { reserveBytes: launches.reserveMb * 1024 * 1024 } : {}),
    ...(launches.maxWaitMs !== undefined ? { maxWaitMs: launches.maxWaitMs } : {}),
  };
}

/** The memory a start leaves free at least, in bytes. */
export function reserveFor(limits: Pick<LaunchLimits, 'reserveBytes'>, memTotal: number | null): number {
  if (limits.reserveBytes !== null) return limits.reserveBytes;
  return Math.max(MIN_RESERVE_BYTES, Math.round(RESERVE_SHARE * (memTotal ?? 0)));
}

export type GateOutcome = 'go' | 'low_memory' | 'cancelled';

/** How long an ended run stays in status(), and how many runs it keeps. */
export const RUN_KEEP_MS = 10 * 60_000;
export const MAX_RUNS = 20;

export interface LaunchRun {
  readonly id: string;
  /** Waits until the next agent may start: 'go' (counted as opened), 'low_memory' or 'cancelled'. */
  next(): Promise<GateOutcome>;
  /** One of the run's folders needs no new agent (already open, instruction sent, folder gone). */
  skip(): void;
  /** The agent next() just granted did not start: it counts as failed instead of opened. */
  fail(): void;
  /**
   * The run is over: what it has left counts as lowMemory or cancelled. Call it once, always.
   * `left`: the folders it did not open, for the loading bar; status() lists them as notOpened.
   */
  end(left?: LaunchFolder[]): void;
}

/** What a run waits for now: its turn behind another run, a batch to settle (until when), or memory. */
export interface LaunchWait {
  reason: 'turn' | 'settle' | 'memory';
  /** The next batch time, while settling. */
  until: string | null;
  memAvailable: number | null;
  reserveBytes: number | null;
  /** reserveBytes - memAvailable, while waiting for memory. */
  missingBytes: number | null;
}

/** A folder a run did not open. */
export interface LaunchFolder {
  workspaceId: string;
  rel: string;
}

export interface LaunchRunStatus {
  id: string;
  /** A multi-open batch, the restore at startup, or sleeping agents woken. */
  kind: 'batch' | 'restore' | 'wake';
  workspaceId: string | null;
  state: 'running' | 'done';
  total: number;
  opened: number;
  failed: number;
  skipped: number;
  /** Still to start (0 once done). */
  queued: number;
  lowMemory: number;
  cancelled: number;
  startedAt: string;
  endedAt: string | null;
  wait: LaunchWait | null;
  /** Once ended, the folders the run left (low memory or cancelled), when its caller named them. */
  notOpened?: LaunchFolder[];
  /** A restore: the agents it left asleep (lazy restore), which it does not count in `total`. */
  sleeping?: number;
}

const NO_WAIT = { until: null, memAvailable: null, reserveBytes: null, missingBytes: null };

export interface GateOptions {
  limits?: Partial<LaunchLimits>;
  readMemory?: () => Promise<{ memTotal: number | null; memAvailable: number | null }>;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));

export class LaunchGate {
  readonly limits: LaunchLimits;
  private readonly readMemory: NonNullable<GateOptions['readMemory']>;
  private readonly sleep: NonNullable<GateOptions['sleep']>;
  private readonly now: () => number;
  private readonly closed = new AbortController();
  /** Resolves when the start granted last is decided: the next one waits for it. */
  private turn: Promise<void> = Promise.resolve();
  private inBatch = 0;
  private lastStart = -Infinity;
  private readonly runs = new Map<string, { status: LaunchRunStatus; cancel: AbortController; endedMs: number }>();

  constructor(options: GateOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.readMemory = options.readMemory ?? (() => readMachineMemory());
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  /** The server is shutting down: every wait ends now and nothing starts any more. */
  close(): void {
    this.closed.abort();
  }

  /** Every run in progress, and the ones ended in the last RUN_KEEP_MS; `active` while any runs. */
  status(): { active: boolean; runs: LaunchRunStatus[] } {
    const runs = [...this.runs.values()].map(({ status }) => ({
      ...status,
      wait: status.wait && { ...status.wait },
      ...(status.notOpened ? { notOpened: status.notOpened.map((folder) => ({ ...folder })) } : {}),
    }));
    return { active: runs.some((run) => run.state === 'running'), runs };
  }

  /** Stops what run `id` has left to start (Pausar); false when no such run is in progress. */
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status.state !== 'running') return false;
    run.cancel.abort();
    return true;
  }

  /**
   * One batch or restore that may start up to `total` agents. `onWait` hears each wait as it
   * begins: 'settle' or 'memory'. `signal`, cancel(id) and close() all cancel it.
   */
  run(options: { id?: string; kind?: LaunchRunStatus['kind']; workspaceId?: string; total?: number; sleeping?: number; signal?: AbortSignal; onWait?: (reason: 'settle' | 'memory') => void } = {}): LaunchRun {
    const cancel = new AbortController();
    const signal = AbortSignal.any([this.closed.signal, cancel.signal, ...(options.signal ? [options.signal] : [])]);
    const status: LaunchRunStatus = {
      id: options.id ?? randomUUID(),
      kind: options.kind ?? 'batch',
      workspaceId: options.workspaceId ?? null,
      state: 'running',
      total: options.total ?? 0,
      opened: 0,
      failed: 0,
      skipped: 0,
      queued: options.total ?? 0,
      lowMemory: 0,
      cancelled: 0,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: null,
      wait: null,
      ...(options.sleeping ? { sleeping: options.sleeping } : {}),
    };
    this.prune();
    this.runs.set(status.id, { status, cancel, endedMs: 0 });
    const left = () => Math.max(0, status.total - status.opened - status.failed - status.skipped);
    const count = () => void (status.queued = status.state === 'running' ? left() : 0);
    let waited = 0;
    let spent = false;
    const decide = async (): Promise<GateOutcome> => {
      if (signal.aborted) return 'cancelled';
      if (spent) return 'low_memory';
      if (this.now() - this.lastStart >= this.limits.settleMs) this.inBatch = 0;
      if (this.inBatch >= this.limits.batchSize) {
        const settle = this.lastStart + this.limits.settleMs - this.now();
        if (settle > 0) {
          status.wait = { reason: 'settle', ...NO_WAIT, until: new Date(this.lastStart + this.limits.settleMs).toISOString() };
          options.onWait?.('settle');
          await this.sleep(settle, signal);
          if (signal.aborted) return 'cancelled';
        }
        this.inBatch = 0;
      }
      for (;;) {
        const { memTotal, memAvailable } = await this.readMemory();
        if (signal.aborted) return 'cancelled';
        const reserve = reserveFor(this.limits, memTotal);
        if (memAvailable === null || memAvailable >= reserve) break;
        if (waited >= this.limits.maxWaitMs) {
          spent = true;
          return 'low_memory';
        }
        const step = Math.min(this.limits.pollMs, this.limits.maxWaitMs - waited);
        status.wait = { reason: 'memory', until: null, memAvailable, reserveBytes: reserve, missingBytes: reserve - memAvailable };
        options.onWait?.('memory');
        await this.sleep(step, signal);
        waited += step;
        if (signal.aborted) return 'cancelled';
      }
      this.inBatch++;
      this.lastStart = this.now();
      status.opened++;
      return 'go';
    };
    return {
      id: status.id,
      next: async () => {
        const previous = this.turn;
        let release!: () => void;
        this.turn = new Promise((resolve) => (release = resolve));
        try {
          status.wait = { reason: 'turn', ...NO_WAIT };
          await Promise.race([previous, aborted(signal)]);
          return await decide();
        } finally {
          status.wait = null;
          count();
          // A run cancelled while queued still lets the ones behind it go in order.
          void previous.then(release);
        }
      },
      skip: () => {
        status.skipped++;
        count();
      },
      fail: () => {
        status.opened = Math.max(0, status.opened - 1);
        status.failed++;
        count();
      },
      end: (folders) => {
        if (status.state === 'done') return;
        if (spent) status.lowMemory = left();
        else status.cancelled = left();
        if (folders) status.notOpened = folders.map(({ workspaceId, rel }) => ({ workspaceId, rel }));
        status.state = 'done';
        status.wait = null;
        status.endedAt = new Date(this.now()).toISOString();
        this.runs.get(status.id)!.endedMs = this.now();
        count();
      },
    };
  }

  /** Drops ended runs older than RUN_KEEP_MS, then the oldest ended ones over MAX_RUNS. */
  private prune(): void {
    for (const [id, run] of this.runs) if (run.status.state === 'done' && this.now() - run.endedMs > RUN_KEEP_MS) this.runs.delete(id);
    for (const [id, run] of this.runs) if (this.runs.size >= MAX_RUNS && run.status.state === 'done') this.runs.delete(id);
  }
}

/** The server's one gate, kept next to its terminal registry (like the night service). */
const gates = new WeakMap<object, LaunchGate>();

export function provideLaunchGate(registry: object, gate: LaunchGate): void {
  gates.set(registry, gate);
}

export function launchGate(registry: object): LaunchGate | undefined {
  return gates.get(registry);
}
