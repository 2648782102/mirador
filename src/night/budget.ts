import { readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from '../config.ts';
import { CALL_FEATURES, type CallFeature, type CallMeter, type CallOutcome, type CallRecord } from '../memory/translate.ts';

/**
 * Claude call accounting: the budget
 * every Claude run is charged to before its process starts, and one telemetry line per run.
 *
 * Budget: `<stateDir>/night/budget.json` (0700/0600). The decider, its follow-ups and the
 * judge share the nightly counter, one per jornada: an
 * activation in a later jornada than the counted one starts it over (`nightOf`, jornadaOf in
 * the server), an off or a restart inside a jornada does not, so a day session and that
 * evening's night share one count. With `now`, a call (or a read) in a later jornada also
 * starts it over while the autopilot stays on across the boundary. While `uncapped()` (the
 * autopilot is on by hand) every call is granted and counted, and passing the limit is told
 * once per jornada (onPassed; not persisted, so a restart may tell it once more); otherwise
 * the limit stops calls. "Mejorar con IA" (`propose`) has its own counter per day, in the
 * configured time zone. Limits come from a getter (the resource profile), so a profile
 * change applies to the next call. take() checks and charges in one synchronous step: two
 * parallel runs never both get the last call. Refusals fail closed: no process starts.
 * The first refusal of a night (or of a day, for improvements) is announced once. A file from
 * before translation moved to the browser keeps its day counter under `translate`: it is read
 * as today's improvements count.
 *
 * Telemetry: `<stateDir>/telemetry/calls.jsonl` (0700/0600), rotated past 5 MiB into
 * `calls.1.jsonl`. Each line holds exactly the CallRecord fields: never a prompt, an
 * answer, memory text, terminal text or a token.
 */

export type BudgetScope = 'night' | 'improve';

export interface BudgetLimits {
  /** Decider, follow-up and judge calls per night. */
  night: number;
  /** "Mejorar con IA" runs per day. */
  improveDay: number;
}

export interface BudgetUse {
  used: number;
  limit: number;
}

export interface BudgetExhausted extends BudgetUse {
  scope: BudgetScope;
}

/** Why the decider deferred when the nightly budget refused its run. */
export const BUDGET_REASON = 'nightly Claude budget reached';

const NIGHT_FEATURES: ReadonlySet<string> = new Set<CallFeature>(['decide', 'follow-up', 'judge']);

export function budgetPath(env = process.env): string {
  return join(stateDir(env), 'night', 'budget.json');
}

export function telemetryDir(env = process.env): string {
  return join(stateDir(env), 'telemetry');
}

/** Today (YYYY-MM-DD) in `timeZone`, or in the system's zone when Intl does not know it. */
export function dayIn(timeZone: string | undefined, now = new Date()): string {
  const format = (zone?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format();
  }
}

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

/** The local night (YYYY-MM-DD) an activation at `since` belongs to: its date in `timeZone` 12 h earlier, so a night runs noon to noon. */
export function localNight(timeZone: string | undefined, since: string): string {
  return dayIn(timeZone, new Date(Date.parse(since) - HALF_DAY_MS));
}

const JORNADA_END = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Where a jornada ends when no night schedule is enabled (local time). */
export const DEFAULT_JORNADA_END = '06:00';

/**
 * The jornada (YYYY-MM-DD) `instant` belongs to: one budget
 * runs from one end of the night schedule's window (`end`, local 'HH:MM'; DEFAULT_JORNADA_END
 * when null) to the next, so a day session and that evening's night share one count. It is
 * the local date in `timeZone` (the system's when Intl does not know it) of the wall-clock
 * time minus `end`.
 */
export function jornadaOf(timeZone: string | undefined, end: string | null, instant: string): string {
  const [, h, m] = JORNADA_END.exec(end ?? DEFAULT_JORNADA_END) ?? JORNADA_END.exec(DEFAULT_JORNADA_END)!;
  const parts = (zone?: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(instant));
  let list: Intl.DateTimeFormatPart[];
  try {
    list = parts(timeZone);
  } catch {
    list = parts();
  }
  const value: Record<string, number> = {};
  for (const part of list) if (part.type !== 'literal') value[part.type] = Number(part.value);
  const wall = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute) - (Number(h) * 60 + Number(m)) * 60_000;
  return new Date(wall).toISOString().slice(0, 10);
}

interface BudgetState {
  v: 1;
  /** `ended`: the night shift turned off since `since` (a shutdown does not end it). */
  night: { since: string | null; used: number; announced: boolean; ended: boolean };
  improve: { day: string; used: number; announced: boolean };
}

const count = (value: unknown): number => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
const limitOf = (value: unknown): number => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);

export interface CallBudgetOptions {
  file?: string;
  limits: () => BudgetLimits;
  /** Today as YYYY-MM-DD (default: the system's zone). */
  today?: () => string;
  /** The jornada of an instant (server: jornadaOf; default: localNight in the system's zone, noon to noon). */
  nightOf?: (since: string) => string;
  /** The clock of the jornada rollover; without it the count only starts over at an activation. */
  now?: () => number;
  /** True while the autopilot is on by hand: no cap for the nightly counter. */
  uncapped?: () => boolean;
}

export class CallBudget {
  readonly file: string;
  private readonly limits: () => BudgetLimits;
  private readonly today: () => string;
  private readonly nightOf: (since: string) => string;
  private readonly now: (() => number) | null;
  private readonly uncapped: () => boolean;
  private state: BudgetState;
  private readonly listeners = new Set<(event: BudgetExhausted) => void>();
  private readonly passedListeners = new Set<(event: BudgetUse) => void>();
  /** The `since` of the counted jornada whose passed limit was told (memory only). */
  private passedFor: string | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: CallBudgetOptions) {
    this.file = options.file ?? budgetPath();
    this.limits = options.limits;
    this.today = options.today ?? (() => dayIn(undefined));
    this.nightOf = options.nightOf ?? ((since) => localNight(undefined, since));
    this.now = options.now ?? null;
    this.uncapped = options.uncapped ?? (() => false);
    this.state = this.load();
  }

  /**
   * Charges one call of `feature` when its counter has room, at once; false (and nothing
   * charged) when it is used up, the limit cannot be read or the feature is unknown.
   */
  take(feature: CallFeature): boolean {
    if (!CALL_FEATURES.has(feature)) return false;
    const scope: BudgetScope = NIGHT_FEATURES.has(feature) ? 'night' : 'improve';
    let limit: number;
    try {
      limit = this.limitFor(scope);
    } catch {
      return false;
    }
    const counter = scope === 'night' ? this.nightCounter(true) : this.dayCounter();
    if (counter.used >= limit && scope === 'night' && this.isUncapped()) {
      // On by hand: no cap; passing the limit is told once per jornada and the call goes on.
      counter.used++;
      this.save();
      const night = this.state.night;
      if (this.passedFor !== night.since) {
        this.passedFor = night.since;
        this.tellPassed({ used: night.used, limit });
      }
      return true;
    }
    if (counter.used >= limit) {
      if (!counter.announced) {
        counter.announced = true;
        this.save();
        this.announce({ scope, used: counter.used, limit });
      }
      return false;
    }
    counter.used++;
    this.save();
    return true;
  }

  /**
   * The autopilot turned on at `since`: the nightly counter starts over when the activation
   * counts in a later jornada than the counted one; in the same jornada (after an off, or a
   * restart that re-activated it) it keeps its count and first `since`. With a clock, an
   * activation from an earlier jornada (a manual on resumed after a restart, whose count
   * already rolled over) counts in the current one. The same `since` again changes nothing.
   */
  startNight(since: string): void {
    const night = this.state.night;
    if (night.since === since) return;
    const current = this.now ? new Date(this.now()).toISOString() : null;
    if (current && Date.parse(since) < Date.parse(current) && !this.sameNight(since, current)) since = current;
    if (night.since !== null && this.sameNight(night.since, since)) {
      if (night.ended) {
        night.ended = false;
        this.save();
      }
      return;
    }
    this.state.night = { since, used: 0, announced: false, ended: false };
    this.save();
  }

  /** The night shift turned off (not a shutdown): the next activation starts a new count. */
  endNight(): void {
    if (this.state.night.ended) return;
    this.state.night.ended = true;
    this.save();
  }

  night(): BudgetUse & { since: string | null } {
    const night = this.nightCounter();
    return { used: night.used, limit: this.safeLimit('night'), since: night.since };
  }

  improveToday(): BudgetUse & { day: string } {
    const counter = this.dayCounter();
    return { used: counter.used, limit: this.safeLimit('improve'), day: counter.day };
  }

  /** Called once per night (or day) at the first refusal. Returns the unsubscribe function. */
  onExhausted(listener: (event: BudgetExhausted) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Called once per jornada when a call on by hand passes the nightly limit. Returns the unsubscribe function. */
  onPassed(listener: (event: BudgetUse) => void): () => void {
    this.passedListeners.add(listener);
    return () => void this.passedListeners.delete(listener);
  }

  /** Resolves when every change so far is on disk (tests, shutdown). */
  flush(): Promise<void> {
    return this.writes;
  }

  /** False when either local night cannot be told (a bad `since`): starting over is the safe side. */
  private sameNight(a: string, b: string): boolean {
    try {
      return this.nightOf(a) === this.nightOf(b);
    } catch {
      return false;
    }
  }

  /** Fails closed: a getter that throws keeps the cap. */
  private isUncapped(): boolean {
    try {
      return this.uncapped() === true;
    } catch {
      return false;
    }
  }

  /**
   * The nightly counter; with a clock, a later jornada than the counted one starts it over now
   * (rollover). `charging`: a call with nothing activated yet starts counting this jornada.
   */
  private nightCounter(charging = false): BudgetState['night'] {
    if (!this.now) return this.state.night;
    const now = new Date(this.now()).toISOString();
    const night = this.state.night;
    if (night.since === null) {
      if (charging) {
        night.since = now;
        this.save();
      }
      return night;
    }
    if (this.sameNight(night.since, now)) return night;
    this.state.night = { since: now, used: 0, announced: false, ended: night.ended };
    this.save();
    return this.state.night;
  }

  private tellPassed(event: BudgetUse): void {
    for (const listener of [...this.passedListeners]) {
      try {
        listener({ ...event });
      } catch (error) {
        console.error('mirador: budget listener failed:', error);
      }
    }
  }

  private limitFor(scope: BudgetScope): number {
    const limits = this.limits();
    return limitOf(scope === 'night' ? limits.night : limits.improveDay);
  }

  private safeLimit(scope: BudgetScope): number {
    try {
      return this.limitFor(scope);
    } catch {
      return 0;
    }
  }

  /** Today's improvements counter: a new day starts at zero. */
  private dayCounter(): BudgetState['improve'] {
    const day = this.today();
    if (this.state.improve.day !== day) {
      this.state.improve = { day, used: 0, announced: false };
      this.save();
    }
    return this.state.improve;
  }

  private announce(event: BudgetExhausted): void {
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...event });
      } catch (error) {
        console.error('mirador: budget listener failed:', error);
      }
    }
  }

  /** Read once, synchronously, so the very first take() already counts what an earlier run used. */
  private load(): BudgetState {
    const fresh: BudgetState = { v: 1, night: { since: null, used: 0, announced: false, ended: true }, improve: { day: '', used: 0, announced: false } };
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`mirador: could not read the call budget (${(error as NodeJS.ErrnoException).code ?? 'error'}); starting from zero`);
      return fresh;
    }
    try {
      const saved = JSON.parse(raw) as Partial<BudgetState> & { translate?: BudgetState['improve'] };
      const night = saved.night ?? fresh.night;
      // `translate`: the same day counter in a file from before S3.
      const improve = saved.improve ?? saved.translate ?? fresh.improve;
      return {
        v: 1,
        // A file from before `ended` reads as ended: its next activation starts over, as it did then.
        night: { since: typeof night.since === 'string' ? night.since : null, used: count(night.used), announced: night.announced === true, ended: night.ended !== false },
        improve: { day: typeof improve.day === 'string' ? improve.day : '', used: count(improve.used), announced: improve.announced === true },
      };
    } catch {
      console.error('mirador: the call budget file is not valid JSON; starting from zero');
      return fresh;
    }
  }

  /** Writes the whole state (temp file and rename), one write at a time; the in-memory counter stays the authority. */
  private save(): void {
    const text = `${JSON.stringify(this.state)}\n`;
    this.writes = this.writes
      .then(async () => {
        const dir = dirname(this.file);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
        const temp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await writeFile(temp, text, { mode: 0o600 });
          await chmod(temp, 0o600);
          await rename(temp, this.file);
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          throw error;
        }
      })
      .catch((error) => console.error(`mirador: could not save the call budget (${(error as NodeJS.ErrnoException).code ?? 'error'})`));
  }
}

/* ---------- Telemetry ---------- */

export const DEFAULT_TELEMETRY_BYTES = 5 * 1024 * 1024;
const CURRENT = 'calls.jsonl';
const PREVIOUS = 'calls.1.jsonl';
const OUTCOMES: ReadonlySet<string> = new Set<CallOutcome>(['ok', 'timeout', 'error', 'aborted', 'budget', 'busy']);
/** Outcomes that never started a process: they count, but not in the latency. */
const NOT_STARTED: ReadonlySet<string> = new Set<CallOutcome>(['budget', 'busy']);
const MODEL = /^[\w.:/-]{1,80}$/;
const VERSION = /^[\w.-]{1,60}$/;

const isInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Exactly the CallRecord fields, checked; null for anything else. Never copies an unknown key. */
function cleanRecord(value: unknown): CallRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.time !== 'string' || !Number.isFinite(Date.parse(v.time))) return null;
  if (typeof v.feature !== 'string' || !CALL_FEATURES.has(v.feature)) return null;
  if (typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome)) return null;
  if (!isInt(v.ms) || !isInt(v.inputBytes) || !isInt(v.outputBytes)) return null;
  return {
    time: new Date(Date.parse(v.time)).toISOString(),
    feature: v.feature as CallFeature,
    model: typeof v.model === 'string' && MODEL.test(v.model) ? v.model : 'unknown',
    promptVersion: typeof v.promptVersion === 'string' && VERSION.test(v.promptVersion) ? v.promptVersion : 'unknown',
    ms: v.ms,
    outcome: v.outcome as CallOutcome,
    inputBytes: v.inputBytes,
    outputBytes: v.outputBytes,
  };
}

/** The nearest-rank percentile `p` (0-1) of `values`; 0 for none. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
}

export interface TelemetrySummary {
  since: string;
  /** Runs per feature and outcome. */
  calls: Partial<Record<CallFeature, Partial<Record<CallOutcome, number>>>>;
  total: number;
  totalMs: number;
  /** Per feature, over the runs that started a process (not `budget` or `busy`). */
  latency: Partial<Record<CallFeature, { p50: number; p95: number; runs: number }>>;
}

export class CallTelemetry {
  readonly dir: string;
  private readonly maxBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { dir?: string; maxBytes?: number } = {}) {
    this.dir = options.dir ?? telemetryDir();
    this.maxBytes = options.maxBytes ?? DEFAULT_TELEMETRY_BYTES;
  }

  /** Appends one line (checked fields only), in order; never throws. */
  record(call: CallRecord): void {
    const line = cleanRecord(call);
    if (!line) return;
    const text = `${JSON.stringify(line)}\n`;
    this.queue = this.queue
      .then(() => this.append(text))
      .catch((error) => console.error(`mirador: could not write call telemetry (${(error as NodeJS.ErrnoException).code ?? 'error'})`));
  }

  flush(): Promise<void> {
    return this.queue;
  }

  /** Counts, total time and latency percentiles of the runs that ended at or after `since` (epoch ms). */
  async summary(since: number): Promise<TelemetrySummary> {
    await this.queue;
    const summary: TelemetrySummary = { since: new Date(since).toISOString(), calls: {}, total: 0, totalMs: 0, latency: {} };
    const times = new Map<CallFeature, number[]>();
    for (const name of [PREVIOUS, CURRENT]) {
      let text = '';
      try {
        text = await readFile(join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        let call: CallRecord | null = null;
        try {
          call = cleanRecord(JSON.parse(raw));
        } catch {
          continue;
        }
        if (!call || Date.parse(call.time) < since) continue;
        const byOutcome = (summary.calls[call.feature] ??= {});
        byOutcome[call.outcome] = (byOutcome[call.outcome] ?? 0) + 1;
        summary.total++;
        summary.totalMs += call.ms;
        if (!NOT_STARTED.has(call.outcome)) {
          const list = times.get(call.feature) ?? [];
          list.push(call.ms);
          times.set(call.feature, list);
        }
      }
    }
    for (const [feature, list] of times) summary.latency[feature] = { p50: percentile(list, 0.5), p95: percentile(list, 0.95), runs: list.length };
    return summary;
  }

  private async append(text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const current = join(this.dir, CURRENT);
    const size = await stat(current).then((s) => s.size, () => 0);
    if (size > 0 && size + Buffer.byteLength(text) > this.maxBytes) await rename(current, join(this.dir, PREVIOUS));
    const handle = await open(current, 'a', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.appendFile(text);
    } finally {
      await handle.close();
    }
  }
}

/* ---------- The meter the runners use ---------- */

/** The runners' meter over a budget and (optionally) telemetry. */
export function callMeter(budget: CallBudget, telemetry?: CallTelemetry | null): CallMeter {
  return {
    take: (feature) => budget.take(feature),
    record: (call) => telemetry?.record(call),
  };
}

/** A meter with the budget only (tests, tools). */
export function budgetMeter(budget: CallBudget): CallMeter {
  return callMeter(budget, null);
}

/** The budget and telemetry of one app, for its route modules; keyed by an object of that app (its terminal registry). */
const accountingByApp = new WeakMap<object, { budget: CallBudget; telemetry: CallTelemetry }>();

export function provideCallAccounting(app: object, accounting: { budget: CallBudget; telemetry: CallTelemetry }): void {
  accountingByApp.set(app, accounting);
}

export function callAccounting(app: object): { budget: CallBudget; telemetry: CallTelemetry } | null {
  return accountingByApp.get(app) ?? null;
}

