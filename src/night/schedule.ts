import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { LEGACY_USER_VALUES } from './legacy-owner.ts';
import { savedSlots } from './night-queue.ts';
import type { ActivationOptions, AutopilotChange, AutopilotSource, ManualOn, ReminderContent } from './service.ts';

/**
 * The night shift schedule and the bedtime reminder timing.
 *
 * A schedule is a window from `start` to `end` (local 'HH:MM' in the configured time
 * zone) that opens on each listed day of the week (0 = Sunday … 6 = Saturday, the day
 * the window starts). When `end` is not after `start` the window crosses midnight and
 * ends the next day, so a window is always shorter than 24 h and two never overlap.
 * Local times go through Intl in that zone, so DST changes keep the wall-clock times:
 * a time skipped by the change moves forward by the gap, a repeated one takes its first
 * occurrence.
 *
 * NightScheduler (only while `enabled`), as seen from the user. Who switched the autopilot on
 * decides who switches it off:
 * - At a window start, and when Mirador starts or the schedule is saved inside a window,
 *   it turns the night shift on (source `schedule`), unless the user turned it off by hand
 *   inside that window or it is already on.
 * - At the end of a window it turned on or saw start, it turns the night shift off only
 *   when the schedule turned it on: a manual on (source `manual`, also one that took over a
 *   scheduled on) survives the window start and end.
 * - the user turning it off inside a window (by hand; a manual on whose `until` passes inside a
 *   window it did not suppress is handed over instead, see covers()): it stays off until the
 *   next window starts, also across restarts (`suppressedUntil` in scheduler.json). A manual on
 *   whose `until` passes outside a window, or inside one the user turned off, turns off as the user's off.
 *   An `until` exactly at a window's end is outside it (the end is not part of the window): it
 *   turns off as the user's off and suppresses nothing.
 * - Disabling the schedule leaves the switch as it is; a window already open still ends
 *   at the end it had when it opened.
 * - Reminder: once per window (`remindedFor` in scheduler.json), `remindBeforeMinutes`
 *   before its start (0 = never). If Mirador starts, or the schedule is saved, between
 *   that time and the start, it fires then; never inside the window.
 *
 * Files in `<stateDir>/night` (folder 0700): schedule.json, scheduler.json, autopilot.json
 * (a manual on with its since and until, so a restart resumes it) and activations.jsonl (the
 * activation log: one AutopilotChange per line, the latest MAX_ACTIVATIONS kept), 0600 each,
 * written to a temporary file and renamed, so a crash never leaves half a file.
 */

export interface NightSchedule {
  enabled: boolean;
  /** Days the window starts on, 0 = Sunday … 6 = Saturday, sorted. */
  days: number[];
  /** Local 'HH:MM' in the configured time zone. */
  start: string;
  end: string;
  remindBeforeMinutes: number;
}

/** A window as instants (epoch ms); `end` is not part of it. */
export interface NightWindow {
  start: number;
  end: number;
}

/** What the scheduler remembers across restarts. */
export interface SchedulerState {
  /** Start (epoch ms) of the window whose reminder already went out. */
  remindedFor?: number;
  /** The user turned the night shift off inside a window: no automatic start before this instant. */
  suppressedUntil?: number;
}

export interface NightReminder {
  /** The window the reminder is for (ISO). */
  window: { start: string; end: string };
  /** What `SchedulerOptions.reminder` built when it fired (the service's reminder content). */
  content: unknown;
}

export interface ScheduleView {
  schedule: NightSchedule;
  timeZone: string;
  /** The window now open, or null. */
  current: { start: string; end: string } | null;
  /** The next window to open and when its reminder goes out (null when it has none). */
  next: { start: string; end: string; remindAt: string | null } | null;
  /** The reminder time of the next window has come and the window has not started: the panel shows its banner. */
  reminderDue: boolean;
  /** The user turned the night shift off inside the current window: no automatic start before this time. */
  offUntil: string | null;
}

/** The part of NightService the scheduler drives. */
export interface ActiveSwitch {
  readonly active: boolean;
  /** Who turned it on; the scheduler turns off only its own on (absent: treated as the schedule's). */
  readonly source?: AutopilotSource | null;
  setActive(active: boolean, options?: { source?: AutopilotSource; cause?: string; reason?: string }): unknown;
  onActiveChange(listener: (active: boolean, since: string | null) => void): () => void;
}

export const DEFAULT_SCHEDULE: NightSchedule = Object.freeze({ enabled: false, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', remindBeforeMinutes: 30 }) as NightSchedule;
export const MAX_REMIND_MINUTES = 240;
/** Timers never wait longer than this, so a suspended laptop or a clock change is noticed within the hour. */
export const MAX_TIMER_MS = 60 * 60_000;

const KEYS = new Set(['enabled', 'days', 'start', 'end', 'remindBeforeMinutes']);
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export class ScheduleError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The instant of local `time` ('HH:MM') in `timeZone`: today when still ahead of `now`,
 * otherwise tomorrow (a manual on's `until`). Throws ScheduleError for a malformed time.
 */
export function untilInstant(time: string, timeZone: string, now: number): number {
  if (typeof time !== 'string' || !TIME.test(time)) throw new ScheduleError('until must be a time like 21:00 (HH:MM, 24 h)');
  const { hour, minute } = minutes(time);
  const day = localDay(now, timeZone);
  for (const date of [new Date(day), new Date(day + DAY_MS)]) {
    const instant = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (instant > now) return instant;
  }
  // Only when a DST change folds tomorrow's time back onto today: a day later is still ahead.
  return now + DAY_MS;
}

/** A schedule from untrusted input: every field checked, days sorted, the reminder 30 min when absent. Throws ScheduleError. */
export function parseSchedule(value: unknown): NightSchedule {
  if (!isRecord(value)) throw new ScheduleError('expected a JSON object { enabled, days, start, end, remindBeforeMinutes }');
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw new ScheduleError(`unknown field ${key}`);
  if (typeof value.enabled !== 'boolean') throw new ScheduleError('enabled must be true or false');
  const days = value.days;
  if (!Array.isArray(days) || days.length > 7 || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new ScheduleError('days must be a list of weekdays 0-6 (0 = Sunday)');
  }
  if (new Set(days).size !== days.length) throw new ScheduleError('days lists a day twice');
  if (value.enabled && days.length === 0) throw new ScheduleError('an enabled schedule needs at least one day');
  for (const key of ['start', 'end'] as const) {
    if (typeof value[key] !== 'string' || !TIME.test(value[key] as string)) throw new ScheduleError(`${key} must be a time like 23:00 (HH:MM, 24 h)`);
  }
  if (value.start === value.end) throw new ScheduleError('start and end must differ');
  const remind = value.remindBeforeMinutes === undefined ? DEFAULT_SCHEDULE.remindBeforeMinutes : value.remindBeforeMinutes;
  if (typeof remind !== 'number' || !Number.isInteger(remind) || remind < 0 || remind > MAX_REMIND_MINUTES) {
    throw new ScheduleError(`remindBeforeMinutes must be a whole number of minutes, 0-${MAX_REMIND_MINUTES}`);
  }
  return { enabled: value.enabled, days: [...(days as number[])].sort((a, b) => a - b), start: value.start as string, end: value.end as string, remindBeforeMinutes: remind };
}

/* ---------- Local time in a zone ---------- */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The local wall time of `epoch` in `timeZone`, as if it were UTC (epoch ms, seconds kept). */
function wallClock(epoch: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epoch))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The zone's offset at `epoch` (local − UTC, ms). */
const offset = (epoch: number, timeZone: string) => wallClock(epoch, timeZone) - Math.floor(epoch / 1000) * 1000;

/**
 * The instant of local `year-month-day hour:minute` in `timeZone`. A wall time skipped by a
 * DST change moves forward by the gap; one that happens twice takes the first.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The offsets half a day before and after cover any single change around this time.
  const before = wall - offset(wall - DAY_MS / 2, timeZone);
  const after = wall - offset(wall + DAY_MS / 2, timeZone);
  const fits = [before, after].filter((epoch) => wallClock(epoch, timeZone) === wall);
  if (fits.length) return Math.min(...fits);
  // Skipped: with the offset in force before the change, the same wall time lands after the gap.
  return before;
}

const minutes = (time: string) => {
  const [, h, m] = TIME.exec(time)!;
  return { hour: Number(h), minute: Number(m) };
};

/** Windows starting on the local days from `fromDay` to `toDay` (Date.UTC values of local midnights). */
function windowsOf(schedule: NightSchedule, timeZone: string, fromDay: number, toDay: number): NightWindow[] {
  if (!schedule.enabled || schedule.days.length === 0) return [];
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  const crosses = schedule.end <= schedule.start;
  const list: NightWindow[] = [];
  for (let day = fromDay; day <= toDay; day += DAY_MS) {
    const date = new Date(day);
    if (!schedule.days.includes(date.getUTCDay())) continue;
    const endDate = new Date(day + (crosses ? DAY_MS : 0));
    list.push({
      start: zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), start.hour, start.minute, timeZone),
      end: zonedTime(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate(), end.hour, end.minute, timeZone),
    });
  }
  return list;
}

/** Local midnight of `epoch`'s local day, as a Date.UTC value. */
const localDay = (epoch: number, timeZone: string) => Math.floor(wallClock(epoch, timeZone) / DAY_MS) * DAY_MS;

/** The window open at `now` (start ≤ now < end), or null. */
export function currentWindow(schedule: NightSchedule, timeZone: string, now: number): NightWindow | null {
  const today = localDay(now, timeZone);
  return windowsOf(schedule, timeZone, today - DAY_MS, today).find((window) => window.start <= now && now < window.end) ?? null;
}

/** The first window that starts after `now`, or null when the schedule has none. */
export function nextWindow(schedule: NightSchedule, timeZone: string, now: number): NightWindow | null {
  const today = localDay(now, timeZone);
  return windowsOf(schedule, timeZone, today, today + 8 * DAY_MS).find((window) => window.start > now) ?? null;
}

/* ---------- Scheduler ---------- */

export interface SchedulerOptions {
  service: ActiveSwitch;
  timeZone: string;
  schedule: NightSchedule;
  state?: SchedulerState;
  /** Called with the whole state after every change; should not throw (its rejection is reported). */
  saveState?: (state: SchedulerState) => unknown;
  /** Builds the reminder content when the reminder fires (NightService.reminder()). */
  reminder?: () => unknown;
  /** False while the night shift cannot run (no night socket): the scheduler does not turn it on. */
  available?: () => boolean;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const realTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const iso = (epoch: number) => new Date(epoch).toISOString();

export class NightScheduler {
  private readonly service: ActiveSwitch;
  private readonly timeZone: string;
  private readonly options: SchedulerOptions;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SchedulerOptions['setTimer']>;
  private plan: NightSchedule;
  private state: SchedulerState;
  /** The window the scheduler saw open (it turns the night shift off at its end). */
  private open: NightWindow | null = null;
  /** True while the scheduler itself flips the switch, so onActiveChange does not take it for the user. */
  private applying = false;
  private cancel: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private readonly listeners = new Set<(reminder: NightReminder) => void>();

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.service = options.service;
    this.timeZone = options.timeZone;
    this.plan = options.schedule;
    this.state = { ...(options.state ?? {}) };
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? realTimer;
  }

  /** Starts watching the switch and the clock (and acts at once when inside a window). */
  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = this.service.onActiveChange((active) => this.switched(active));
    this.tick();
  }

  get schedule(): NightSchedule {
    return this.plan;
  }

  /** A new schedule (already validated and saved): the timers re-arm and a window open now is joined. */
  update(schedule: NightSchedule): void {
    this.plan = schedule;
    if (!schedule.enabled) this.open = null;
    if (this.unsubscribe) this.tick();
  }

  /** Hears every bedtime reminder. Returns an unsubscribe function. */
  onReminder(listener: (reminder: NightReminder) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): ScheduleView {
    const now = this.now();
    const current = currentWindow(this.plan, this.timeZone, now);
    const next = nextWindow(this.plan, this.timeZone, now);
    const remindAt = next && this.plan.remindBeforeMinutes > 0 ? next.start - this.plan.remindBeforeMinutes * 60_000 : null;
    const offUntil = current && this.state.suppressedUntil !== undefined && this.state.suppressedUntil > now ? this.state.suppressedUntil : null;
    return {
      schedule: this.plan,
      timeZone: this.timeZone,
      current: current ? { start: iso(current.start), end: iso(current.end) } : null,
      next: next ? { start: iso(next.start), end: iso(next.end), remindAt: remindAt === null ? null : iso(remindAt) } : null,
      reminderDue: !current && remindAt !== null && now >= remindAt,
      offUntil: offUntil === null ? null : iso(offUntil),
    };
  }

  /**
   * Whether the schedule would have the autopilot on now: inside an enabled window that the user
   * did not turn off and while it can run. A manual on whose until passes then is handed over.
   */
  covers(): boolean {
    if (this.closed) return false;
    const now = this.now();
    const current = currentWindow(this.plan, this.timeZone, now);
    if (!current) return false;
    const suppressed = this.state.suppressedUntil !== undefined && this.state.suppressedUntil > now;
    if (suppressed || !(this.options.available?.() ?? true)) return false;
    // The window end turns it off only for a window the scheduler saw open.
    this.open = current;
    return true;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancel?.();
    this.cancel = null;
  }

  /** Does what is due now, then arms the timer for the next boundary. */
  private tick(): void {
    if (this.closed) return;
    this.cancel?.();
    this.cancel = null;
    const now = this.now();
    const current = currentWindow(this.plan, this.timeZone, now);

    if (this.open && now >= this.open.end && current?.start !== this.open.start) {
      const ended = this.open;
      this.open = null;
      // A manual on is the user's to turn off.
      if (this.service.active && this.service.source !== 'manual') this.apply(false, 'window-end', `the window ${iso(ended.start)} to ${iso(ended.end)} ended`);
    }
    if (current) {
      this.open = current;
      const suppressed = this.state.suppressedUntil !== undefined && this.state.suppressedUntil > now;
      if (!suppressed && !this.service.active && (this.options.available?.() ?? true)) this.apply(true, 'window-start', `the window ${iso(current.start)} to ${iso(current.end)} is open`);
    }

    const next = nextWindow(this.plan, this.timeZone, now);
    const remindAt = next && this.plan.remindBeforeMinutes > 0 ? next.start - this.plan.remindBeforeMinutes * 60_000 : null;
    if (!current && next && remindAt !== null && now >= remindAt && this.state.remindedFor !== next.start) {
      this.remember({ remindedFor: next.start });
      this.remind(next);
    }

    const boundaries = [this.open?.end, next?.start, remindAt !== null && remindAt > now ? remindAt : undefined].filter((value): value is number => value !== undefined && value > now);
    if (boundaries.length === 0 && !this.open) return;
    const wait = boundaries.length ? Math.min(...boundaries) - now : MAX_TIMER_MS;
    this.cancel = this.setTimer(() => {
      this.cancel = null;
      this.tick();
    }, Math.min(Math.max(wait, 0), MAX_TIMER_MS));
  }

  private apply(active: boolean, cause: string, reason: string): void {
    this.applying = true;
    try {
      this.service.setActive(active, { source: 'schedule', cause, reason });
    } catch (error) {
      console.error('night scheduler could not switch the night shift:', error);
    } finally {
      this.applying = false;
    }
  }

  /** The switch changed by someone else than the scheduler: the user (PUT /api/night, or a manual on's `until`). */
  private switched(active: boolean): void {
    if (this.applying || this.closed || active) return;
    const current = currentWindow(this.plan, this.timeZone, this.now());
    if (current) this.remember({ suppressedUntil: current.end });
  }

  private remember(patch: SchedulerState): void {
    this.state = { ...this.state, ...patch };
    try {
      Promise.resolve(this.options.saveState?.({ ...this.state })).catch((error) => console.error('night scheduler state was not saved:', error));
    } catch (error) {
      console.error('night scheduler state was not saved:', error);
    }
  }

  private remind(window: NightWindow): void {
    let content: unknown = null;
    try {
      content = this.options.reminder?.() ?? null;
    } catch (error) {
      console.error('night reminder content failed:', error);
    }
    const reminder: NightReminder = { window: { start: iso(window.start), end: iso(window.end) }, content };
    for (const listener of this.listeners) {
      try {
        listener(reminder);
      } catch (error) {
        console.error('night reminder listener failed:', error);
      }
    }
  }
}

/**
 * The scheduler of one app, for other route modules (the notifier routes the reminder):
 * keyed by an object of that app (its terminal registry), like provideNightAttention.
 */
const schedulerByApp = new WeakMap<object, NightScheduler>();

export function provideNightScheduler(app: object, scheduler: NightScheduler): void {
  schedulerByApp.set(app, scheduler);
}

export function nightScheduler(app: object): NightScheduler | null {
  return schedulerByApp.get(app) ?? null;
}

/* ---------- Notification text ---------- */

const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;
const cleanName = (value: string) => Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80).join('');

/**
 * The bedtime reminder as a short Spanish notification (desktop or phone), like the notices
 * of src/night/notify.ts: the window's local times, per workspace how many agents and in which
 * state, and missing missions. Never agent text (activity, closing questions) nor notes.
 */
export function reminderNotice(reminder: NightReminder, timeZone: string): { title: string; body: string } {
  const time = (value: string) => new Intl.DateTimeFormat('es-CL', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  const lines = [`Empieza a las ${time(reminder.window.start)} y termina a las ${time(reminder.window.end)}.`];
  const content = reminder.content as ReminderContent | null;
  for (const workspace of Array.isArray(content?.workspaces) ? content.workspaces : []) {
    const agents = Array.isArray(workspace.agents) ? workspace.agents : [];
    const waiting = agents.filter((agent) => agent.state === 'blocked' || agent.state === 'prompt').length;
    const failed = agents.filter((agent) => agent.state === 'error').length;
    const finished = agents.filter((agent) => agent.state === 'finished').length;
    const offline = agents.filter((agent) => !agent.connected).length;
    const states = [waiting ? `${waiting} te espera${waiting === 1 ? '' : 'n'}` : '', failed ? `${failed} ${failed === 1 ? 'falló' : 'fallaron'}` : '', finished ? `${finished} ${finished === 1 ? 'terminó' : 'terminaron'}` : '', offline ? `${offline} sin conexión` : ''].filter(Boolean);
    let line = `${cleanName(String(workspace.name ?? workspace.workspaceId))}: ${plural(agents.length, 'agente', 'agentes')}${states.length ? ` (${states.join(', ')})` : ''}`;
    if (!workspace.hasMission) line += '; sin misión: Mirador dejará todo pendiente';
    lines.push(line);
  }
  lines.push('Revisa lo que queda y deja tus notas en Mirador › Seguimiento.');
  return { title: 'Mirador: se acerca el turno de noche', body: lines.join('\n') };
}

/* ---------- Files ---------- */

const SCHEDULE_FILE = 'schedule.json';
const STATE_FILE = 'scheduler.json';
const MANUAL_FILE = 'autopilot.json';
const ACTIVATIONS_FILE = 'activations.jsonl';
/** The user's N for the night queue (src/night/night-queue.ts): `{ slots }`, null for the suggested one. */
const QUEUE_FILE = 'queue.json';
/** Lines the activation log keeps (a few per day: months of history). */
export const MAX_ACTIVATIONS = 500;

/** Writes `data` to `path` as a 0600 file, through a temporary file renamed over it. */
export async function writePrivateFile(dir: string, name: string, data: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  const handle = await open(temp, 'w', 0o600);
  try {
    // The umask may loosen a new file.
    await handle.chmod(0o600);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, name));
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const isInstant = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export class ScheduleStore {
  readonly dir: string;
  private readonly maxActivations: number;
  /** Saves run one at a time, so the last one written is the last one asked. */
  private queue: Promise<void> = Promise.resolve();

  constructor(dir: string, options: { maxActivations?: number } = {}) {
    this.dir = dir;
    this.maxActivations = options.maxActivations ?? MAX_ACTIVATIONS;
  }

  /** The saved schedule and scheduler state; the defaults for a missing or unreadable file. */
  async load(): Promise<{ schedule: NightSchedule; state: SchedulerState }> {
    let schedule = DEFAULT_SCHEDULE;
    const saved = await readJsonFile(join(this.dir, SCHEDULE_FILE));
    if (saved !== undefined) {
      try {
        schedule = parseSchedule(saved);
      } catch (error) {
        console.error(`night schedule ignored (${(error as Error).message}); using the default`);
      }
    }
    const raw = await readJsonFile(join(this.dir, STATE_FILE));
    const state: SchedulerState = {};
    if (isRecord(raw)) {
      if (isInstant(raw.remindedFor)) state.remindedFor = raw.remindedFor;
      if (isInstant(raw.suppressedUntil)) state.suppressedUntil = raw.suppressedUntil;
    }
    return { schedule, state };
  }

  saveSchedule(schedule: NightSchedule): Promise<void> {
    return this.save(SCHEDULE_FILE, schedule);
  }

  saveState(state: SchedulerState): Promise<void> {
    return this.save(STATE_FILE, state);
  }

  /** The saved manual on, or null when there is none or the file is unreadable. */
  async loadManual(): Promise<ManualOn | null> {
    const raw = await readJsonFile(join(this.dir, MANUAL_FILE));
    const manual = isRecord(raw) ? raw.manual : null;
    if (!isRecord(manual) || !isIso(manual.since) || !(manual.until === null || isIso(manual.until))) return null;
    return { since: manual.since, until: manual.until };
  }

  /** Saves the manual on, or null once it is off (or the schedule's). */
  saveManual(manual: ManualOn | null): Promise<void> {
    return this.save(MANUAL_FILE, { manual });
  }

  /** The user's N for the night queue, or null (the suggested one) when unset or unreadable. */
  async loadQueue(): Promise<number | null> {
    return savedSlots(await readJsonFile(join(this.dir, QUEUE_FILE)));
  }

  /** Saves the user's N, or null to go back to the suggested one. */
  saveQueue(slots: number | null): Promise<void> {
    return this.save(QUEUE_FILE, { slots });
  }

  /** Appends one change to the activation log, keeping the latest `maxActivations` lines. */
  appendActivation(change: AutopilotChange): Promise<void> {
    return this.write(ACTIVATIONS_FILE, async () => {
      const lines = [...(await this.activationLines()), JSON.stringify(change)];
      return lines.slice(-this.maxActivations).join('\n') + '\n';
    });
  }

  /**
   * The activation log, latest first, at most `limit` entries (unreadable lines skipped). A line
   * written before F5 holds the legacy cause for the user (LEGACY_USER_VALUES.cause): it is read
   * as 'user' and the file keeps its bytes.
   */
  async activations(limit = this.maxActivations): Promise<AutopilotChange[]> {
    await this.queue;
    const list: AutopilotChange[] = [];
    for (const line of (await this.activationLines()).reverse()) {
      if (list.length >= limit) break;
      try {
        const change = JSON.parse(line) as unknown;
        if (isRecord(change) && typeof change.cause === 'string' && isIso(change.time)) list.push({ ...change, cause: change.cause === LEGACY_USER_VALUES.cause ? 'user' : change.cause } as unknown as AutopilotChange);
      } catch {
        // A broken line (a crash halfway, an edit by hand) is skipped.
      }
    }
    return list;
  }

  /** Resolves once every save asked so far is written (or failed). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async activationLines(): Promise<string[]> {
    try {
      return (await readFile(join(this.dir, ACTIVATIONS_FILE), 'utf8')).split('\n').filter((line) => line.trim());
    } catch {
      return [];
    }
  }

  private save(name: string, value: unknown): Promise<void> {
    return this.write(name, async () => JSON.stringify(value, null, 2) + '\n');
  }

  private write(name: string, data: () => Promise<string>): Promise<void> {
    const run = this.queue.then(async () => writePrivateFile(this.dir, name, await data()));
    this.queue = run.catch(() => {});
    return run;
  }
}

const OFF = { active: false, source: null, until: null } as const;

/**
 * The user turned the autopilot off while it was already off: a manual on kept for the next start
 * (resumeManual without the socket) is cleared too, so their off wins (cause 'user').
 */
export async function dropKeptManual(store: ScheduleStore, now: () => number = Date.now): Promise<void> {
  const manual = await store.loadManual();
  if (!manual) return;
  await store.saveManual(null);
  await store.appendActivation({ time: new Date(now()).toISOString(), from: OFF, to: OFF, cause: 'user', reason: 'turned off while a manual on waited for the next start', saved: manual });
}

/**
 * At start, before the scheduler starts so an open window does not take it: resumes the saved
 * manual on while its until is ahead (cause 'restart-resume'). Without the night socket the autopilot
 * cannot run and the socket is never retried while Mirador runs, so the saved manual on is kept for
 * the next start and logged as 'restart-deferred' (erasing it
 * let the next start inside a window turn it into the schedule's on, which the window end turned
 * off). One whose until passed is cleared and logged as 'restart-dropped'.
 */
export async function resumeManual(options: {
  store: ScheduleStore;
  service: { setActive(active: boolean, options: ActivationOptions): unknown };
  available: boolean;
  now?: () => number;
}): Promise<void> {
  const { store, service } = options;
  const manual = await store.loadManual();
  if (!manual) return;
  const now = (options.now ?? Date.now)();
  const time = new Date(now).toISOString();
  if (manual.until !== null && Date.parse(manual.until) <= now) {
    await store.saveManual(null);
    await store.appendActivation({ time, from: OFF, to: OFF, cause: 'restart-dropped', reason: 'its until passed while Mirador was stopped', saved: manual });
  } else if (!options.available) {
    await store.appendActivation({ time, from: OFF, to: OFF, cause: 'restart-deferred', reason: 'the night socket is not available; kept for the next start', saved: manual });
  } else {
    service.setActive(true, { source: 'manual', since: manual.since, until: manual.until, cause: 'restart-resume' });
  }
}
