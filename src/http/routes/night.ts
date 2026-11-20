import { runtimeDir } from '../../config.ts';
import { NightChannel, nightEnvProvider, nightSocketPath } from '../../night/channel.ts';
import { NightLog, nightLogDir } from '../../night/log.ts';
import { NoteError, NoteStore, parseNoteInput, type ExecutionNote } from '../../night/notes.ts';
import { findSensitive } from '../../night/policy.ts';
import type { Decider } from '../../night/protocol.ts';
import { MAX_ACTIVATIONS, NightScheduler, ScheduleError, ScheduleStore, dropKeptManual, parseSchedule, provideNightScheduler, resumeManual, untilInstant } from '../../night/schedule.ts';
import { NightService, nightAttention, provideNightService } from '../../night/service.ts';
import { QueueError, parseQueueSettings, suggestedSlots, type QueueLimit } from '../../night/night-queue.ts';
import { DEFAULT_LIMITS, launchGate, reserveFor } from '../../system/memory-gate.ts';
import { readMachineMemory } from '../../system/resources.ts';
import type { AppContext, RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson, sendNoContent } from '../respond.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_RECORDS = 1000;
const NOTE_ID = /^[\w-]{1,128}$/;
const MAX_CHECKED_TEXT = 8000;
const NOTE_STATUS: Record<NoteError['code'], number> = { night_note: 400, night_note_workspace: 404, night_note_terminal: 400, night_note_full: 409 };

/** A note as the panel reads it: plus whether it went out and the sensitive topic it mentions (the panel warns). */
const noteView = (note: ExecutionNote) => ({ ...note, delivered: !!note.deliveredAt, sensitive: findSensitive(note.text) });

/** The configured zone when Intl knows it, otherwise the system's (a bad zone must not stop the server). */
function usableTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.error(`night schedule: unknown time zone ${JSON.stringify(timeZone)}, using ${fallback}`);
    return fallback;
  }
}

/** Until a real decider is plugged in: every question and follow-up defers, so turning the night shift on is safe. */
export const notInstalledDecider: Decider = {
  decide: async () => ({ action: 'defer', reason: 'decider not installed' }),
  followUp: async () => ({ action: 'defer', reason: 'decider not installed' }),
};

/**
 * Night shift: the night socket agent
 * bridges connect to (src/night/channel.ts), the night service and its decision
 * log. If the socket cannot be opened (or another Mirador serves it), the night
 * shift stays unavailable and terminals start without the night variables.
 *
 * GET  /api/night                       → NightStatus { active, available, since, source, until, connectedTerminals, pending, queue? }
 *                                          source: who turned it on ('manual' | 'schedule', null while off);
 *                                          until: when a manual on turns itself off (ISO), or null;
 *                                          queue: the night queue's QueueSummary, only while it is on
 * GET  /api/night/queue                  → QueueSummary { slots, suggested, custom, memTotal, working, queued, memoryWait,
 *                                          items: [{ terminalId, kind: 'note' | 'follow-up', since }] }
 *                                          (src/night/night-queue.ts), also while off
 * PUT  /api/night/queue { slots: 1-50 | null } → the same; null goes back to the suggested N. Saved in queue.json
 *                                          (0600); 400 night_queue for anything else.
 * PUT  /api/night { active: boolean, until?: 'HH:MM' | null }
 *                                        → NightStatus; turning it off passes the questions in flight. An on is
 *                                          the user's (source 'manual'): `until` is a local time, today when still
 *                                          ahead, otherwise tomorrow; absent or null means no limit. On while on
 *                                          takes it over with the new until. 400 night_invalid for anything else
 *                                          (an until with an off, unknown keys). A manual on is saved in
 *                                          autopilot.json and resumed after a restart while its until is ahead.
 * POST /api/night/delegate/:terminalId   → 202 { id }: the record id of the follow-up attempt (see the log)
 * GET  /api/night/log?since=&limit=      → { records: NightRecord[] } since an ISO time or epoch ms (default: the last 24 h)
 * GET  /api/night/activations?limit=    → { activations: AutopilotChange[] }, latest first (default 100, at most
 *                                          MAX_ACTIVATIONS): every on, off, take-over, handover, until change,
 *                                          shutdown and saved manual on resumed, kept or dropped at a start, with
 *                                          the state before and after and the cause.
 *                                          400 night_limit for a bad limit.
 *
 * The schedule (src/night/schedule.ts), the bedtime reminder and the execution notes.
 * GET  /api/night/schedule               → ScheduleView { schedule, timeZone, current, next, reminderDue, offUntil }
 * PUT  /api/night/schedule NightSchedule → ScheduleView; 400 night_schedule for anything malformed
 * GET  /api/night/reminder               → ReminderContent plus { due, current, next } of the schedule
 * GET  /api/night/notes                  → { notes: Array<ExecutionNote & { delivered, sensitive }> }
 * POST /api/night/notes { workspaceId, terminalId?, text } → 201 the note; 400 night_note / night_note_terminal,
 *                                          404 night_note_workspace, 409 night_note_full. While the night shift is
 *                                          on, a new note goes out at once; otherwise at the next activation.
 * DELETE /api/night/notes/:id            → 204; 404 night_note_unknown
 * POST /api/night/sensitive { text }     → { topic }: the sensitive topic (policy.ts) `text` mentions, or null, for the
 *                                          delegate dialog's warning; 400 night_text
 *                                          unless text is a string of at most 8000 characters. Changes nothing.
 *
 * `makeDecider` builds the decider once at startup (src/night/decider.ts when installed);
 * its `close()`, when it has one, runs on shutdown.
 */
export function createNightRoutes(makeDecider: (ctx: AppContext) => Decider | Promise<Decider>): RouteModule {
  return async (ctx) => {
    const decider = await makeDecider(ctx);
    // A decider that runs model processes (NightDecider) stops them on shutdown.
    const closable = decider as Decider & { close?: () => void };
    if (typeof closable.close === 'function') ctx.onShutdown(() => closable.close!());
    const log = new NightLog(nightLogDir());
    const socketPath = nightSocketPath(runtimeDir());
    let service: NightService | undefined;
    let channel: NightChannel | null = null;
    try {
      channel = await NightChannel.open(socketPath, {
        question: (terminalId, requestId, question) => {
          service!.question(terminalId, requestId, question).catch((error) => {
            console.error('night question failed:', error);
            channel?.send(terminalId, { type: 'pass', requestId });
          });
        },
        dialog: (terminalId, requestId, dialog) => service!.dialog(terminalId, requestId, dialog),
        delivered: (terminalId, messageId) => service!.delivered(terminalId, messageId),
        disconnected: (terminalId) => service!.disconnected(terminalId),
        released: (terminalId, requestId) => service!.released(terminalId, requestId),
        took: (terminalId, requestId) => service!.took(terminalId, requestId),
      });
    } catch (error) {
      console.error('night shift disabled, the night socket could not be opened:', error);
    }
    const notes = new NoteStore(nightLogDir());
    const scheduleStore = new ScheduleStore(nightLogDir());
    // N of the night queue: the user's, else suggested from MemTotal (read once: it does not change).
    const memTotal = (await readMachineMemory().catch(() => null))?.memTotal ?? null;
    let customSlots = await scheduleStore.loadQueue();
    const queueLimit = (): QueueLimit => ({ slots: customSlots ?? suggestedSlots(memTotal), suggested: suggestedSlots(memTotal), custom: customSlots !== null, memTotal });
    const night = new NightService({
      link: channel,
      decider,
      log,
      terminals: ctx.terminals,
      workspaces: ctx.workspaces,
      attention: () => nightAttention(ctx.terminals),
      notes,
      saveManual: (manual) => scheduleStore.saveManual(manual),
      // Config `ownerName`: who the texts agents receive and the night reasons name ("the user" unset).
      ownerName: () => ctx.config.ownerName,
      // Free memory under the launch gate's reserve holds the next start, like the gate holds a launch.
      queue: {
        limit: queueLimit,
        readMemory: () => readMachineMemory(),
        reserve: (total) => reserveFor(launchGate(ctx.terminals)?.limits ?? DEFAULT_LIMITS, total),
      },
    });
    service = night;
    provideNightService(ctx.terminals, night);
    night.onAutopilotChange((change) => void scheduleStore.appendActivation(change).catch((error) => console.error('night activation was not logged:', error)));

    const saved = await scheduleStore.load();
    const timeZone = usableTimeZone(ctx.config.timeZone);
    const scheduler = new NightScheduler({
      service: night,
      timeZone,
      schedule: saved.schedule,
      state: saved.state,
      saveState: (state) => scheduleStore.saveState(state),
      reminder: () => night.reminder(),
      available: () => channel !== null,
    });
    provideNightScheduler(ctx.terminals, scheduler);
    // A manual on whose until passes inside a running window stays on as the schedule's.
    night.handOverTo(() => scheduler.covers());
    // Before the service closes: a shutdown that turns the night shift off is not the user turning it off.
    ctx.onShutdown(() => scheduler.close());
    // A manual on survives a restart while its until is ahead, and a start without the socket.
    await resumeManual({ store: scheduleStore, service: night, available: channel !== null });
    if (channel) {
      const open = channel;
      ctx.terminals.addEnvProvider(nightEnvProvider(open, socketPath));
      ctx.terminals.subscribe((event) => {
        if (event.type === 'created') return;
        open.revoke(event.info.id);
        night.disconnected(event.info.id);
      });
      ctx.onShutdown(async () => {
        night.close();
        await open.close();
        // The shutdown's activation log line.
        await scheduleStore.idle();
      });
    }
    scheduler.start();

    return [
      { method: 'GET', path: '/api/night', handler: ({ res }) => sendJson(res, 200, night.status()) },
      {
        method: 'PUT',
        path: '/api/night',
        handler: async ({ req, res }) => {
          const body = await readJson(req);
          const invalid = () => new HttpError(400, 'expected { active: boolean, until?: "HH:MM" | null } (until only with active: true)', 'night_invalid');
          if (typeof body.active !== 'boolean' || Object.keys(body).some((key) => key !== 'active' && key !== 'until')) throw invalid();
          if ('until' in body && (!body.active || (body.until !== null && typeof body.until !== 'string'))) throw invalid();
          let until: string | null = null;
          if (typeof body.until === 'string') {
            try {
              until = new Date(untilInstant(body.until, timeZone, Date.now())).toISOString();
            } catch (error) {
              if (error instanceof ScheduleError) throw invalid();
              throw error;
            }
          }
          if (body.active && !channel) throw new HttpError(503, 'the night socket is not available', 'night_unavailable');
          const wasOff = !night.active;
          const status = body.active ? night.setActive(true, { source: 'manual', until, cause: 'user' }) : night.setActive(false, { source: 'manual', cause: 'user' });
          // An off while a manual on only waits for the next start (kept by resumeManual without the
          // socket) clears it too: the user's off wins, and the next start leaves the autopilot off.
          if (!body.active && wasOff) await dropKeptManual(scheduleStore);
          // The answer comes once the manual on (or its end) is on disk, so a restart right after keeps it.
          await scheduleStore.idle();
          sendJson(res, 200, status);
        },
      },
      {
        method: 'POST',
        path: '/api/night/delegate/:terminalId',
        handler: ({ res, params }) => {
          const started = night.delegate(params.terminalId);
          if (!started) throw new HttpError(404, 'unknown terminal', 'night_terminal');
          started.done.catch((error) => console.error('night delegation failed:', error));
          sendJson(res, 202, { id: started.id });
        },
      },
      {
        method: 'GET',
        path: '/api/night/log',
        handler: async ({ res, url }) => {
          const sinceParam = url.searchParams.get('since');
          const limitParam = url.searchParams.get('limit');
          let since = Date.now() - DAY_MS;
          if (sinceParam !== null) {
            since = /^\d+$/.test(sinceParam) ? Number(sinceParam) : Date.parse(sinceParam);
            if (!Number.isFinite(since)) throw new HttpError(400, 'since must be an ISO time or epoch milliseconds', 'night_since');
          }
          let limit = 500;
          if (limitParam !== null) {
            limit = Number(limitParam);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_RECORDS) throw new HttpError(400, `limit must be 1-${MAX_LOG_RECORDS}`, 'night_limit');
          }
          sendJson(res, 200, { records: await log.recent({ since, limit }) });
        },
      },
      {
        method: 'GET',
        path: '/api/night/activations',
        handler: async ({ res, url }) => {
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam === null ? 100 : Number(limitParam);
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVATIONS) throw new HttpError(400, `limit must be 1-${MAX_ACTIVATIONS}`, 'night_limit');
          sendJson(res, 200, { activations: await scheduleStore.activations(limit) });
        },
      },
      { method: 'GET', path: '/api/night/queue', handler: ({ res }) => sendJson(res, 200, night.queueSummary()) },
      {
        method: 'PUT',
        path: '/api/night/queue',
        handler: async ({ req, res }) => {
          let slots: number | null;
          try {
            slots = parseQueueSettings(await readJson(req));
          } catch (error) {
            if (error instanceof QueueError) throw new HttpError(400, error.message, error.code);
            throw error;
          }
          await scheduleStore.saveQueue(slots);
          customSlots = slots;
          night.queueChanged();
          sendJson(res, 200, night.queueSummary());
        },
      },
      { method: 'GET', path: '/api/night/schedule', handler: ({ res }) => sendJson(res, 200, scheduler.view()) },
      {
        method: 'PUT',
        path: '/api/night/schedule',
        handler: async ({ req, res }) => {
          let schedule;
          try {
            schedule = parseSchedule(await readJson(req));
          } catch (error) {
            if (error instanceof ScheduleError) throw new HttpError(400, error.message, 'night_schedule');
            throw error;
          }
          await scheduleStore.saveSchedule(schedule);
          scheduler.update(schedule);
          sendJson(res, 200, scheduler.view());
        },
      },
      {
        method: 'GET',
        path: '/api/night/reminder',
        handler: ({ res }) => {
          const view = scheduler.view();
          sendJson(res, 200, { ...night.reminder(), due: view.reminderDue, current: view.current, next: view.next });
        },
      },
      { method: 'GET', path: '/api/night/notes', handler: async ({ res }) => sendJson(res, 200, { notes: (await notes.list()).map(noteView) }) },
      {
        method: 'POST',
        path: '/api/night/notes',
        handler: async ({ req, res }) => {
          const body = await readJson(req);
          let note;
          try {
            note = await notes.add(
              parseNoteInput(body, {
                workspace: (id) => !!ctx.workspaces.get(id),
                terminal: (id) => ctx.terminals.get(id),
              }),
            );
          } catch (error) {
            if (error instanceof NoteError) throw new HttpError(NOTE_STATUS[error.code], error.message, error.code);
            throw error;
          }
          if (night.active) night.deliverNotesNow().catch((error) => console.error('night execution note failed:', error));
          sendJson(res, 201, noteView(note));
        },
      },
      {
        method: 'POST',
        path: '/api/night/sensitive',
        handler: async ({ req, res }) => {
          const { text } = await readJson(req);
          if (typeof text !== 'string' || text.length > MAX_CHECKED_TEXT) throw new HttpError(400, `text must be a string of at most ${MAX_CHECKED_TEXT} characters`, 'night_text');
          sendJson(res, 200, { topic: findSensitive(text) });
        },
      },
      {
        method: 'DELETE',
        path: '/api/night/notes/:id',
        handler: async ({ res, params }) => {
          if (!NOTE_ID.test(params.id) || !(await notes.remove(params.id))) throw new HttpError(404, 'no such note', 'night_note_unknown');
          sendNoContent(res);
        },
      },
    ];
  };
}

export const nightRoutes = createNightRoutes(() => notInstalledDecider);
