import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { NightRecord } from './log.ts';
import type { MorningSummary } from './judge.ts';

/**
 * Night notifications: what Mirador left pending for the user, the judge's
 * doubtful or wrong verdicts, and the morning summary, on the desktop (notify-send) and on
 * their phone (Telegram, src/night/telegram.ts).
 *
 * Texts are short and in Spanish, and hold only the workspace and folder, the question
 * summary (at most 120 characters), the action and the reason: never terminal output,
 * file contents, follow-up messages, errors, tokens or memory text. Pending items and
 * verdicts go out at most once per channel per 10 minutes (the first one at once, the
 * rest aggregated at the end of the window); the morning summary always goes out.
 *
 * A channel may refuse some topics (`accepts`): Telegram gets neither the judge's verdicts nor
 * the budget notices, nor the plain notice of a question held for its answer from Telegram,
 * which arrives with buttons instead. Each channel
 * gets a batch made of the items it accepts.
 */

export type NoticeKind = 'pending' | 'judgment' | 'morning' | 'reminder' | 'budget';
export type Urgency = 'low' | 'normal' | 'critical';

export interface Notice {
  kind: NoticeKind;
  urgency: Urgency;
  title: string;
  body: string;
}

/** What a notice is about: `held`, a pending question held for an answer from Telegram. */
export type NoticeTopic = 'pending' | 'held' | 'judgment' | 'budget' | 'morning' | 'reminder';

export interface NotifyChannel {
  name: string;
  /** Whether this channel wants notices about `topic` (all when absent). */
  accepts?(topic: NoticeTopic): boolean;
  /** Should not reject; the notifier catches and reports a rejection anyway. */
  send(notice: Notice): Promise<void>;
}

/** What a notification may say about one night record. */
export interface NoticeItem {
  /** "Workspace / folder", or the workspace alone at its root. */
  place: string;
  summary: string;
  /** What Mirador did, in Spanish. */
  action: string;
  reason: string;
}

export const BATCH_WINDOW_MS = 10 * 60_000;
const MAX_SUMMARY = 120;
const MAX_REASON = 120;
const MAX_PLACE = 80;
const MAX_LISTED = 3;

/** Deferral rules of a delegated or automatic follow-up that the user must hear about (the rest are routine). */
// no-final-message: an agent swept at activation whose final text Mirador never received.
// budget: the nightly Claude budget was used up.
const FOLLOW_UP_PENDING = /^(sensitive:|low-confidence$|decider$|auto-cap$|no-final-message$|budget$)/;

/**
 * Whether a record is something left for the user: a question the night shift did not
 * decide (except when it was turned off, so the user is awake), or a delegated or automatic
 * follow-up deferred because it was sensitive, uncertain, the decider deferred, or the
 * night's automatic follow-ups for that terminal ran out.
 */
export function isPendingForUser(record: NightRecord): boolean {
  if (record.outcome !== 'deferred' || !record.deferral) return false;
  if (record.kind === 'question') return record.deferral.rule !== 'stopped';
  return FOLLOW_UP_PENDING.test(record.deferral.rule);
}

/** Long runs that look like tokens or keys, and Telegram bot tokens, become "[…]". */
function redact(text: string): string {
  return text.replace(/\d+:[A-Za-z0-9_-]{30,}/g, '[…]').replace(/[A-Za-z0-9_+=-]{32,}/g, '[…]');
}

/** One line of plain text: control and format characters become spaces; secrets redacted; capped. */
export function shortLine(value: unknown, max: number): string {
  const text = redact(String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim());
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function actionOf(record: NightRecord): string {
  if (record.outcome === 'decided') {
    const labels = record.decision?.choices?.map((choice) => `«${shortLine(choice.label, 60)}»`) ?? [];
    return labels.length ? `Mirador eligió ${labels.join(', ')}` : 'Mirador decidió';
  }
  if (record.outcome === 'followed-up') return 'Mirador envió un seguimiento';
  return 'Mirador lo dejó pendiente';
}

/** The notification view of a record: only the allowed fields. */
export function noticeItem(record: NightRecord, workspaces: { get(id: string): { name: string } | undefined }): NoticeItem {
  const workspace = record.workspaceId ? (workspaces.get(record.workspaceId)?.name ?? record.workspaceId) : 'Mirador';
  const place = record.rel ? `${workspace} / ${record.rel}` : workspace;
  const summary = record.question?.items[0]?.question ?? (record.kind === 'auto-follow-up' ? 'Seguimiento automático de un agente que terminó' : 'Seguimiento de un agente que terminó');
  return {
    place: shortLine(place, MAX_PLACE),
    summary: shortLine(summary, MAX_SUMMARY),
    action: actionOf(record),
    reason: shortLine(record.deferral?.reason ?? record.decision?.reason ?? record.followUp?.reason ?? '', MAX_REASON),
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface Queued {
  kind: 'pending' | 'doubtful' | 'wrong';
  item: NoticeItem;
  /** A pending question held for an answer from Telegram. */
  held?: boolean;
}

const topicOf = (entry: Queued): NoticeTopic => (entry.kind === 'pending' ? (entry.held ? 'held' : 'pending') : 'judgment');

function single({ kind, item }: Queued): Notice {
  const lines = [item.place, item.summary];
  if (kind === 'pending') {
    lines.push(`${item.action}. Motivo: ${item.reason || 'sin motivo'}`);
    return { kind: 'pending', urgency: 'normal', title: 'Mirador: pendiente para ti', body: lines.join('\n') };
  }
  lines.push(`${item.action}. Juez: ${item.reason || 'sin nota'}`);
  return kind === 'wrong'
    ? { kind: 'judgment', urgency: 'critical', title: 'Mirador: el juez marcó una decisión como incorrecta', body: lines.join('\n') }
    : { kind: 'judgment', urgency: 'normal', title: 'Mirador: el juez duda de una decisión', body: lines.join('\n') };
}

function aggregate(items: Queued[]): Notice {
  const pending = items.filter((entry) => entry.kind === 'pending').length;
  const doubtful = items.filter((entry) => entry.kind === 'doubtful').length;
  const wrong = items.filter((entry) => entry.kind === 'wrong').length;
  const parts = [
    pending ? plural(pending, 'pendiente', 'pendientes') : '',
    doubtful ? plural(doubtful, 'dudosa', 'dudosas') : '',
    wrong ? plural(wrong, 'incorrecta', 'incorrectas') : '',
  ].filter(Boolean);
  const lines = items.slice(0, MAX_LISTED).map(({ item }) => `• ${item.place}: ${item.summary} — ${item.reason || item.action}`);
  if (items.length > MAX_LISTED) lines.push(`y ${items.length - MAX_LISTED} más`);
  lines.push('Revísalo en Mirador › Seguimiento.');
  return { kind: pending ? 'pending' : 'judgment', urgency: wrong ? 'critical' : 'normal', title: `Mirador: ${parts.join(', ')}`, body: lines.join('\n') };
}

/** The morning summary: counts, the Claude calls against the budget, then the first items left for the user with their reasons. */
export function morningText(summary: MorningSummary, pending: NoticeItem[]): string {
  const lines = [
    `Decididas: ${summary.decided} · Seguimientos: ${summary.followUps} · Pendientes para ti: ${summary.deferred} · Dudosas: ${summary.doubtful} · Incorrectas: ${summary.wrong}`,
  ];
  if (summary.calls) lines.push(`Llamadas a Claude: ${summary.calls.used} de ${summary.calls.limit}`);
  if (pending.length) {
    lines.push('Pendientes:');
    for (const item of pending.slice(0, MAX_LISTED)) lines.push(`• ${item.place}: ${item.summary} — ${item.reason || 'sin motivo'}`);
    if (pending.length > MAX_LISTED) lines.push(`y ${pending.length - MAX_LISTED} más`);
  }
  lines.push('Revísalo en Mirador › Seguimiento.');
  return lines.join('\n');
}

/** The title of the summary sent when the autopilot turns off by the user or a manual on's until. */
export const AWAY_TITLE = 'Mirador: resumen del piloto automático';
const MORNING_TITLE = 'Mirador: resumen del turno de noche';

/** The same summary with neutral wording, for an autopilot turned off by the user or its until: nothing says night or morning. */
export function awayText(summary: MorningSummary, pending: NoticeItem[]): string {
  return ['Mientras no estabas, Mirador hizo esto:', morningText(summary, pending)].join('\n');
}

/** The once-per-night (or per-day) notice of a used-up call budget: counts only. */
export function budgetNotice(event: { scope: 'night' | 'improve'; used: number; limit: number }): { title: string; body: string } {
  return event.scope === 'night'
    ? {
        title: 'Mirador: se alcanzó el tope de llamadas a Claude de esta noche',
        body: `Se usaron ${event.used} de ${event.limit} llamadas. Hasta que termine la jornada, Mirador deja las preguntas y los seguimientos pendientes para ti. Puedes subir el tope con el perfil de recursos en Seguimiento.`,
      }
    : {
        title: 'Mirador: se alcanzó el tope de mejoras con IA de hoy',
        body: `Se usaron ${event.used} de ${event.limit} mejoras con IA. «Mejorar con IA» vuelve a estar disponible mañana.`,
      };
}

/** The once-per-jornada notice of an autopilot on by hand that passed the nightly limit: counts only, nothing stops. */
export function budgetPassedNotice(event: { used: number; limit: number }): { title: string; body: string } {
  return {
    title: 'Mirador: pasaste el tope de llamadas a Claude',
    body: `Pasaste ${event.limit === 1 ? 'la 1 llamada' : `las ${event.limit} llamadas`} de tu perfil (van ${event.used}); el piloto automático sigue porque lo activaste a mano. Puedes cambiar el perfil de recursos en Seguimiento.`,
  };
}

export interface NotifierOptions {
  channels: NotifyChannel[];
  windowMs?: number;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

const realTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export class Notifier {
  private readonly channels: NotifyChannel[];
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<NotifierOptions['setTimer']>;
  private readonly log: (line: string) => void;
  private queued: Queued[] = [];
  /** When the last batched notification went out (every channel gets it at once). */
  private lastSent = -Infinity;
  private cancel: (() => void) | null = null;
  private closed = false;

  constructor(options: NotifierOptions) {
    this.channels = options.channels;
    this.windowMs = options.windowMs ?? BATCH_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? realTimer;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** Something Mirador left for the user; `held`: a question held for an answer from Telegram. */
  pending(item: NoticeItem, options: { held?: boolean } = {}): void {
    this.queue({ kind: 'pending', item, ...(options.held ? { held: true } : {}) });
  }

  /** A judge verdict; `ok` is never notified. `note` becomes the reason. */
  judgment(item: NoticeItem, verdict: 'ok' | 'doubtful' | 'wrong', note: string): void {
    if (verdict === 'ok') return;
    this.queue({ kind: verdict, item: { ...item, reason: shortLine(note, MAX_REASON) } });
  }

  /** The summary (morning title unless given, e.g. AWAY_TITLE): always sent at once, outside the batching window. */
  morning(body: string, title = MORNING_TITLE): void {
    if (this.closed) return;
    this.broadcast({ kind: 'morning', urgency: 'low', title, body }, 'morning');
  }

  /** The bedtime reminder: always sent at once, outside the batching window. */
  reminder(notice: { title: string; body: string }): void {
    if (this.closed) return;
    this.broadcast({ kind: 'reminder', urgency: 'normal', title: notice.title, body: notice.body }, 'reminder');
  }

  /** A used-up call budget: always sent at once, outside the batching window. */
  budget(notice: { title: string; body: string }): void {
    if (this.closed) return;
    this.broadcast({ kind: 'budget', urgency: 'normal', title: notice.title, body: notice.body }, 'budget');
  }

  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
    this.queued = [];
  }

  private queue(entry: Queued): void {
    if (this.closed || this.channels.length === 0) return;
    this.queued.push(entry);
    if (this.cancel) return;
    const wait = this.lastSent + this.windowMs - this.now();
    if (wait <= 0) return this.flush();
    this.cancel = this.setTimer(() => {
      this.cancel = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const items = this.queued;
    this.queued = [];
    if (items.length === 0 || this.closed) return;
    this.lastSent = this.now();
    for (const channel of this.channels) {
      const own = items.filter((entry) => channel.accepts?.(topicOf(entry)) ?? true);
      if (own.length) this.deliver(channel, own.length === 1 ? single(own[0]) : aggregate(own));
    }
  }

  private broadcast(notice: Notice, topic: NoticeTopic): void {
    for (const channel of this.channels) if (channel.accepts?.(topic) ?? true) this.deliver(channel, notice);
  }

  private deliver(channel: NotifyChannel, notice: Notice): void {
    Promise.resolve()
      .then(() => channel.send(notice))
      .catch((error) => this.log(`mirador: ${channel.name} notification failed (${(error as NodeJS.ErrnoException)?.code ?? 'error'})`));
  }
}

/* ---------- Desktop ---------- */

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; timeout: number; shell: false; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown }) | null) => void,
) => void;

export interface DesktopOptions {
  env?: Record<string, string | undefined>;
  execFile?: ExecFileFn;
  /** Whether a path exists (the session bus socket). */
  exists?: (path: string) => boolean;
  log?: (line: string) => void;
}

/**
 * The session bus of Mirador's own runtime folder: the inherited address when it points
 * inside XDG_RUNTIME_DIR, else `$XDG_RUNTIME_DIR/bus`; null when that socket is missing
 * (no desktop session, or an isolated test run), so nothing is sent.
 */
function sessionBus(env: Record<string, string | undefined>, exists: (path: string) => boolean): string | null {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime || !isAbsolute(runtime)) return null;
  const inherited = env.DBUS_SESSION_BUS_ADDRESS?.match(/^unix:path=([^,;]+)$/)?.[1];
  const inside = (path: string) => {
    const rel = relative(runtime, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const path = inherited && inside(inherited) ? inherited : `${runtime}/bus`;
  return exists(path) ? `unix:path=${path}` : null;
}

/**
 * notify-send through execFile with an argument array (never a shell), app name
 * "Mirador", urgency by kind, and only the variables it needs. A missing binary (or no
 * session bus) is skipped silently; after ENOENT the channel stays quiet.
 */
export function desktopChannel(options: DesktopOptions = {}): NotifyChannel {
  const env = options.env ?? process.env;
  const run = options.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const exists = options.exists ?? existsSync;
  const log = options.log ?? ((line: string) => console.error(line));
  let missing = false;
  return {
    name: 'desktop',
    send(notice) {
      if (missing) return Promise.resolve();
      const bus = sessionBus(env, exists);
      if (!bus) return Promise.resolve();
      const childEnv: Record<string, string> = { DBUS_SESSION_BUS_ADDRESS: bus };
      for (const key of ['PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY']) {
        const value = env[key];
        if (value) childEnv[key] = value;
      }
      const args = ['--app-name=Mirador', `--urgency=${notice.urgency}`, '--', notice.title, notice.body];
      return new Promise<void>((resolve) => {
        run('notify-send', args, { env: childEnv, timeout: 5000, shell: false, windowsHide: true }, (error) => {
          if (error?.code === 'ENOENT') missing = true;
          else if (error) log(`mirador: desktop notification failed (${String(error.code ?? 'error')})`);
          resolve();
        });
      });
    },
  };
}

/** The channels config `notifications` keeps: each is on unless set to exactly false. */
export function enabledChannels(
  config: { desktop?: boolean; telegram?: boolean } | undefined,
  channels: { desktop?: NotifyChannel; telegram?: NotifyChannel },
): NotifyChannel[] {
  const list: NotifyChannel[] = [];
  if (channels.desktop && config?.desktop !== false) list.push(channels.desktop);
  if (channels.telegram && config?.telegram !== false) list.push(channels.telegram);
  return list;
}
