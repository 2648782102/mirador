import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ownerAtStart, ownerNameFrom, stateDir } from '../../config.ts';
import { EngramUnavailableError } from '../../memory/engram.ts';
import { FEEDBACK_PROJECT, feedbackTopic } from '../../night/decider.ts';
import { JudgmentStore, createJudge, summarizeNight, type FeedbackVerdict, type JudgeRun } from '../../night/judge.ts';
import { NightLog, nightLogDir, type NightRecord } from '../../night/log.ts';
import { nightService, type AutopilotSource } from '../../night/service.ts';
import { nightScheduler, reminderNotice } from '../../night/schedule.ts';
import { AWAY_TITLE, Notifier, awayText, budgetNotice, budgetPassedNotice, desktopChannel, enabledChannels, isPendingForUser, morningText, noticeItem, type NotifyChannel } from '../../night/notify.ts';
import { callAccounting, type CallBudget } from '../../night/budget.ts';
import { resourceProfiles } from '../../profiles.ts';
import { TelegramError, TelegramStore, parseCredentials, sendTelegram, telegramChannel, telegramPath } from '../../night/telegram.ts';
import { isPrivateChat, startTelegramAnswers, type HeldQuestions } from '../../night/telegram-answers.ts';
import type { AppContext, RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson, sendNoContent } from '../respond.ts';

/**
 * Night report: the judge that reviews
 * Mirador's night moves, the user's feedback (kept locally and saved to Engram for the
 * decider), notifications (desktop and their Telegram bot) and the morning summary.
 *
 * GET    /api/night/report?since=   → { records: Array<NightRecord & { judgment?, feedback? }>, summary }
 *                                       since: ISO time or epoch ms; default the last activation, else 24 h
 * POST   /api/night/feedback        { recordId, verdict: 'right'|'wrong', note? (≤500) } → 204; 404 night_record
 * GET    /api/night/telegram        → { configured, chatIdMasked }
 * PUT    /api/night/telegram        { botToken, chatId } → 204 after a test message; 400 telegram_invalid, 502 telegram_failed
 * DELETE /api/night/telegram        → 204
 * POST   /api/night/telegram/test   → 204; 502 telegram_failed (also when not configured)
 * GET    /api/night/telegram/answers → { enabled, available, privateChat }
 * PUT    /api/night/telegram/answers { enabled } → 204; 400 night_answers_invalid, 400 telegram_invalid (not configured)
 *
 * "Responder desde Telegram": with the bot set for a
 * private chat (`privateChat`), Telegram notifications on and a night service that holds
 * questions (`available`), the saved setting (`enabled`, on by default) drives the inbound of
 * src/night/telegram-answers.ts, which starts and stops with these routes. The deferred record
 * of a held question (`sent: 'held'`) reaches the desktop as usual; on Telegram it arrives with
 * its buttons instead of the plain notice.
 *
 * The report's and the morning summary's `calls` are the nightly Claude calls against the
 * budget; the count is one per jornada (an off or a restart inside it keeps the count); a
 * used-up budget is notified once per night (once per day for translations) and logged as one
 * line; an autopilot on by hand is not capped, and passing the limit is notified once per jornada. The judge's model
 * and mode follow the resource profile.
 *
 * The summary goes out when the autopilot turns off: with
 * the morning wording when the schedule ended the night, otherwise (the user, or a manual on's
 * until) with neutral wording ("Mientras no estabas…"). The night service lives inside the
 * night routes, so `onActiveChange` is wired when it is reachable; otherwise `nightStatus` is
 * polled every minute and the off is taken as the schedule's unless a manual on was seen.
 */

export interface NightStatusView {
  active: boolean;
  since: string | null;
  source?: AutopilotSource | null;
}

export interface NightReportOptions {
  /** The night log folder (default `<stateDir>/night`); judgments.jsonl lives there too. */
  dir?: string;
  telegramFile?: string;
  /** The folder Engram's write session is registered for (default `<stateDir>/engram/mirador-night`). */
  engramDirectory?: string;
  /** Telegram's fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Replaces the judge's model run (tests). */
  judgeRun?: JudgeRun;
  /** Replaces the notification channels (tests); config `notifications` still applies. */
  channels?: { desktop?: NotifyChannel; telegram?: NotifyChannel };
  /** The night shift's state, read every `pollMs` when `onActiveChange` is not given. */
  nightStatus?: () => Promise<NightStatusView | null> | NightStatusView | null;
  onActiveChange?: (listener: (active: boolean, since: string | null, cause?: AutopilotSource) => void) => () => void;
  pollMs?: number;
  /** The call budget (tests); default the app's (src/night/budget.ts provideCallAccounting). */
  budget?: CallBudget;
  /** The questions held for an answer from Telegram (tests); default the night service's. */
  held?: HeldQuestions;
  /** The Bot API base of the Telegram inbound (tests). */
  telegramApi?: string;
}

/** The night service when it can hold questions for an answer from Telegram. */
function heldQuestionsOf(service: object | null): HeldQuestions | null {
  return service && typeof (service as Partial<HeldQuestions>).holdForAnswers === 'function' ? (service as HeldQuestions) : null;
}

function parseAnswers(body: Record<string, unknown>): boolean {
  if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new HttpError(400, 'expected { enabled: true | false }', 'night_answers_invalid');
  return body.enabled;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_RECORDS = 1000;
const MAX_NOTE = 500;
const MAX_RECORD_ID = 200;
/** The morning summary waits this long at most for the last reviews. */
const MORNING_WAIT_MS = 2 * 60_000;
const TEST_MESSAGE = 'Mirador: Telegram conectado. Aquí llegarán los avisos del turno de noche.';

/** Plain text: control and format characters removed, spaces collapsed, capped. */
function plain(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function sinceParam(url: URL): number | null {
  const value = url.searchParams.get('since');
  if (value === null) return null;
  const since = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(since)) throw new HttpError(400, 'since must be an ISO time or epoch milliseconds', 'night_since');
  return since;
}

function parseFeedback(body: Record<string, unknown>): { recordId: string; verdict: FeedbackVerdict; note: string } {
  const invalid = () => new HttpError(400, `expected { recordId, verdict: "right" | "wrong", note? (at most ${MAX_NOTE} characters) }`, 'night_feedback_invalid');
  if (Object.keys(body).some((key) => key !== 'recordId' && key !== 'verdict' && key !== 'note')) throw invalid();
  const { recordId, verdict, note } = body;
  if (typeof recordId !== 'string' || !recordId || recordId.length > MAX_RECORD_ID) throw invalid();
  if (verdict !== 'right' && verdict !== 'wrong') throw invalid();
  if (note !== undefined && (typeof note !== 'string' || Array.from(note).length > MAX_NOTE)) throw invalid();
  return { recordId, verdict, note: plain(note ?? '', MAX_NOTE) };
}

/**
 * The compact memory the decider reads back (one fact per line, the verdict first), naming the owner
 * as config `ownerName` says (`ownerName`; unset or not valid: "the user").
 */
export function feedbackMemory(record: NightRecord, workspaceName: string, verdict: FeedbackVerdict, note: string, ownerName?: unknown): { title: string; content: string } {
  const owner = ownerAtStart(ownerNameFrom(ownerName));
  const summary = plain(record.question?.items[0]?.question ?? (record.kind === 'question' ? 'a question' : 'a follow-up for a finished agent'), 300);
  const move = record.outcome === 'followed-up'
    ? `Mirador sent a follow-up: ${plain(record.followUp?.message, 300)}`
    : record.decision?.choices?.length
      ? `Mirador chose: ${record.decision.choices.map((choice) => `"${plain(choice.label, 120)}"`).join(', ')}`
      : `Mirador left it pending: ${plain(record.deferral?.reason, 200)}`;
  const why = plain(record.decision?.reason ?? record.followUp?.reason ?? '', 200);
  const lines = [
    verdict === 'wrong' ? `${owner} marked Mirador's night move wrong${note ? `: ${note}` : '.'}` : `${owner} confirmed Mirador's night move was right${note ? `: ${note}` : '.'}`,
    `Question: ${summary}`,
    move,
    why ? `Mirador's reason: ${why}` : '',
    `Where: ${plain(workspaceName, 80)}${record.rel ? ` / ${plain(record.rel, 120)}` : ''} (${record.time.slice(0, 10)})`,
  ].filter(Boolean);
  return { title: `Night feedback (${verdict}): ${plain(summary, 80)}`, content: lines.join('\n') };
}

export function createNightReportRoutes(options: NightReportOptions = {}): RouteModule {
  return async (ctx: AppContext) => {
    const dir = options.dir ?? nightLogDir();
    const log = new NightLog(dir);
    const store = new JudgmentStore(join(dir, 'judgments.jsonl'));
    const telegram = new TelegramStore(options.telegramFile ?? telegramPath());
    const engramDirectory = options.engramDirectory ?? join(stateDir(), 'engram', FEEDBACK_PROJECT);
    const profiles = resourceProfiles(ctx.terminals);
    const budget = options.budget ?? callAccounting(ctx.terminals)?.budget ?? null;
    const judge = createJudge({
      log,
      store,
      workspaces: ctx.workspaces,
      model: () => profiles?.values().nightModel ?? ctx.config.nightModel,
      ownerName: () => ctx.config.ownerName,
      mode: () => profiles?.values().judgeMode ?? 'every',
      run: options.judgeRun,
    });
    const channels = options.channels ?? { desktop: desktopChannel(), telegram: telegramChannel(telegram, { fetch: options.fetch }) };
    const notifier = new Notifier({ channels: enabledChannels(ctx.config.notifications, channels) });
    const nightCalls = () => (budget ? { used: budget.night().used, limit: budget.night().limit } : null);
    const stopBudget =
      budget?.onExhausted((event) => {
        console.error(`mirador: the ${event.scope === 'night' ? 'nightly Claude' : 'daily AI improvement'} budget is used up (${event.used}/${event.limit} calls)`);
        notifier.budget(budgetNotice(event));
      }) ?? (() => {});
    // On by hand there is no cap: passing the limit is only told, once per jornada.
    const stopPassed = budget?.onPassed((event) => notifier.budget(budgetPassedNotice(event))) ?? (() => {});

    // The night routes register before this module, so their service and scheduler are reachable here.
    const service = nightService(ctx.terminals);
    const held = options.held ?? heldQuestionsOf(service);
    const answers = held && ctx.config.notifications?.telegram !== false ? startTelegramAnswers({ service: held, store: telegram, fetch: options.fetch, apiBase: options.telegramApi }) : null;
    await answers?.refresh();
    const answersView = async () => {
      const credentials = await telegram.read();
      const privateChat = !!credentials && isPrivateChat(credentials.chatId);
      return { enabled: !!credentials && (await telegram.answers()) === true, available: !!answers && privateChat, privateChat };
    };

    const unsubscribeLog = log.subscribe((record) => {
      if (isPendingForUser(record)) notifier.pending(noticeItem(record, ctx.workspaces), { held: record.sent === 'held' });
    });
    const unsubscribeJudge = judge.subscribe((judgment, record) => notifier.judgment(noticeItem(record, ctx.workspaces), judgment.verdict, judgment.note));

    const readStatus = async (): Promise<NightStatusView | null> => {
      try {
        const status = await options.nightStatus?.();
        return status && typeof status.active === 'boolean'
          ? { active: status.active, since: typeof status.since === 'string' ? status.since : null, source: status.source === 'manual' || status.source === 'schedule' ? status.source : null }
          : null;
      } catch {
        return null;
      }
    };
    const defaultSince = async () => {
      const since = (await readStatus())?.since;
      const at = since ? Date.parse(since) : NaN;
      return Number.isFinite(at) ? at : Date.now() - DAY_MS;
    };

    /** `bySchedule`: the schedule ended the night (morning wording); otherwise the user is back (neutral wording). */
    const sendMorning = async (since: string | null, bySchedule: boolean) => {
      const from = since && Number.isFinite(Date.parse(since)) ? Date.parse(since) : Date.now() - DAY_MS;
      await Promise.race([judge.idle(), new Promise((resolve) => setTimeout(resolve, MORNING_WAIT_MS).unref())]);
      const summary = { ...(await judge.summarize(from)), ...(budget ? { calls: nightCalls()! } : {}) };
      const records = await log.recent({ since: from, limit: Number.MAX_SAFE_INTEGER });
      const pending = records.filter(isPendingForUser).map((record) => noticeItem(record, ctx.workspaces));
      if (bySchedule) notifier.morning(morningText(summary, pending));
      else notifier.morning(awayText(summary, pending), AWAY_TITLE);
    };
    let wasActive: boolean | null = null;
    let lastSince: string | null = null;
    let lastSource: AutopilotSource | null = null;
    /** `cause`: who turned it off (the service's event); unknown when polled, then a manual on seen while on decides. */
    const observe = (active: boolean, since: string | null, cause?: AutopilotSource, source?: AutopilotSource | null) => {
      if (since) lastSince = since;
      if (active && source) lastSource = source;
      // A new activation starts a new nightly count unless it re-activates the same unended night (a restart).
      if (active && since) budget?.startNight(since);
      if (wasActive === true && !active) {
        // A real off ends the counted night; a shutdown sends no off event, so it never does.
        budget?.endNight();
        const bySchedule = cause ? cause === 'schedule' : lastSource !== 'manual';
        sendMorning(since ?? lastSince, bySchedule).catch((error) => console.error('mirador: the morning summary failed:', error));
      }
      if (!active) lastSource = null;
      wasActive = active;
    };

    let stopWatching: () => void;
    const watch = options.onActiveChange ?? (service ? (listener: (active: boolean, since: string | null, cause?: AutopilotSource) => void) => service.onActiveChange(listener) : null);
    if (watch) {
      if (service) observe(service.status().active, service.status().since);
      stopWatching = watch((active, since, cause) => observe(active, since, cause));
    } else {
      let polling = false;
      const poll = async () => {
        if (polling) return;
        polling = true;
        try {
          const status = await readStatus();
          if (status) observe(status.active, status.since, undefined, status.source);
        } finally {
          polling = false;
        }
      };
      const timer = setInterval(() => void poll(), options.pollMs ?? 60_000);
      timer.unref();
      void poll();
      stopWatching = () => clearInterval(timer);
    }

    // The bedtime reminder reaches the user on the desktop and on their Telegram bot.
    const stopReminder = nightScheduler(ctx.terminals)?.onReminder((reminder) => notifier.reminder(reminderNotice(reminder, ctx.config.timeZone))) ?? (() => {});

    ctx.onShutdown(() => {
      stopBudget();
      stopPassed();
      stopReminder();
      stopWatching();
      unsubscribeLog();
      unsubscribeJudge();
      notifier.close();
      judge.close();
    });
    ctx.onShutdown(() => answers?.close());

    const sendOrFail = async (credentials: Parameters<typeof sendTelegram>[0], text: string) => {
      try {
        await sendTelegram(credentials, text, { fetch: options.fetch });
      } catch (error) {
        throw new HttpError(502, error instanceof TelegramError ? error.message : 'the Telegram message could not be sent', 'telegram_failed');
      }
    };

    return [
      {
        method: 'GET',
        path: '/api/night/report',
        handler: async ({ res, url }) => {
          const since = sinceParam(url) ?? (await defaultSince());
          const records = await log.recent({ since, limit: Number.MAX_SAFE_INTEGER });
          const { judgments, feedback } = await store.all();
          const shown = records.slice(-MAX_REPORT_RECORDS).map((record) => {
            const judgment = judgments.get(record.id);
            const given = feedback.get(record.id);
            return {
              ...record,
              ...(judgment ? { judgment: { verdict: judgment.verdict, note: judgment.note } } : {}),
              ...(given ? { feedback: { verdict: given.verdict, note: given.note, time: given.time } } : {}),
            };
          });
          sendJson(res, 200, { records: shown, summary: summarizeNight(records, judgments, since, nightCalls()) });
        },
      },
      {
        method: 'POST',
        path: '/api/night/feedback',
        handler: async ({ req, res }) => {
          const { recordId, verdict, note } = parseFeedback(await readJson(req));
          const record = (await log.recent({ limit: Number.MAX_SAFE_INTEGER })).find((entry) => entry.id === recordId);
          if (!record) throw new HttpError(404, 'unknown night record', 'night_record');
          await store.putFeedback({ recordId, time: new Date().toISOString(), verdict, note, workspaceId: record.workspaceId });
          if (record.workspaceId) {
            const memory = feedbackMemory(record, ctx.workspaces.get(record.workspaceId)?.name ?? record.workspaceId, verdict, note, ctx.config.ownerName);
            try {
              await mkdir(engramDirectory, { recursive: true, mode: 0o700 });
              await ctx.engram.saveObservation({
                project: FEEDBACK_PROJECT,
                topicKey: `${feedbackTopic(record.workspaceId)}/${record.id}`,
                type: 'preference',
                directory: engramDirectory,
                ...memory,
              });
            } catch (error) {
              // Kept in judgments.jsonl either way; only the status goes to the log, never the text.
              const status = error instanceof EngramUnavailableError ? (error.status ?? 'unreachable') : 'error';
              console.error(`mirador: night feedback was not saved to Engram (${status})`);
            }
          }
          sendNoContent(res);
        },
      },
      { method: 'GET', path: '/api/night/telegram', handler: async ({ res }) => sendJson(res, 200, await telegram.status()) },
      {
        method: 'PUT',
        path: '/api/night/telegram',
        handler: async ({ req, res }) => {
          let credentials;
          try {
            credentials = parseCredentials(await readJson(req));
          } catch (error) {
            if (error instanceof TelegramError) throw new HttpError(400, error.message, 'telegram_invalid');
            throw error;
          }
          await sendOrFail(credentials, TEST_MESSAGE);
          await telegram.write(credentials);
          await answers?.refresh();
          sendNoContent(res);
        },
      },
      {
        method: 'DELETE',
        path: '/api/night/telegram',
        handler: async ({ res }) => {
          await telegram.remove();
          await answers?.refresh();
          sendNoContent(res);
        },
      },
      {
        method: 'POST',
        path: '/api/night/telegram/test',
        handler: async ({ res }) => {
          const credentials = await telegram.read();
          if (!credentials) throw new HttpError(502, 'Telegram is not configured', 'telegram_failed');
          await sendOrFail(credentials, TEST_MESSAGE);
          sendNoContent(res);
        },
      },
      { method: 'GET', path: '/api/night/telegram/answers', handler: async ({ res }) => sendJson(res, 200, await answersView()) },
      {
        method: 'PUT',
        path: '/api/night/telegram/answers',
        handler: async ({ req, res }) => {
          const enabled = parseAnswers(await readJson(req));
          try {
            await telegram.setAnswers(enabled);
          } catch (error) {
            if (error instanceof TelegramError) throw new HttpError(400, error.message, 'telegram_invalid');
            throw error;
          }
          await answers?.refresh();
          sendNoContent(res);
        },
      },
    ];
  };
}
