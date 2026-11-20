// The autopilot: who switched the night service on
// (the user by hand or the schedule), a manual on's `until` with a fake clock, what it saves so a
// restart keeps a manual on, and the summary sent when it turns off. Fake link, fake timers,
// real terminal registry over fake ptys; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../src/http/context.ts';
import { createNightReportRoutes } from '../src/http/routes/night-report.ts';
import type { Notice, NotifyChannel } from '../src/night/notify.ts';
import { NightService, type AutopilotSource, type ManualOn, type NightLink } from '../src/night/service.ts';
import { NightScheduler, type NightSchedule, type SchedulerState } from '../src/night/schedule.ts';
import { CallBudget, jornadaOf } from '../src/night/budget.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

const at = (iso: string) => Date.parse(iso);

/** One armed timer at a time, like the scheduler's: `advance` fires it when it falls due. */
function clock(startIso: string) {
  let now = at(startIso);
  const timers = new Set<{ fn: () => void; due: number }>();
  const delays: number[] = [];
  return {
    now: () => now,
    delays,
    armed: () => timers.size,
    setTimer(fn: () => void, ms: number) {
      delays.push(ms);
      const entry = { fn, due: now + ms };
      timers.add(entry);
      return () => void timers.delete(entry);
    },
    advance(iso: string) {
      const target = at(iso);
      for (;;) {
        const next = [...timers].filter((entry) => entry.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        timers.delete(next);
        now = Math.max(now, next.due);
        next.fn();
      }
      now = target;
    },
  };
}

function setup(startIso = '2026-10-29T11:00:00Z') {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 4096 });
  const link: NightLink = { send: () => false, isConnected: () => false, connectedTerminals: () => [] };
  const time = clock(startIso);
  const saved: Array<ManualOn | null> = [];
  const heard: Array<[boolean, string | null, AutopilotSource | undefined]> = [];
  const service = new NightService({
    link,
    decider: { decide: async () => ({ action: 'defer', reason: 'x' }), followUp: async () => ({ action: 'defer', reason: 'x' }) },
    log: { append: async () => {} },
    terminals,
    workspaces: { get: () => undefined },
    now: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
    saveManual: (state) => void saved.push(state),
  });
  service.onActiveChange((active, since, cause) => void heard.push([active, since, cause]));
  return { service, time, saved, heard };
}

test('status says who switched it on and until when; off has neither (D3)', () => {
  const s = setup();
  assert.deepEqual(pick(s.service.status()), { active: false, since: null, source: null, until: null });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  assert.deepEqual(pick(s.service.status()), { active: true, since: '2026-10-29T11:00:00.000Z', source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.service.setActive(false);
  assert.deepEqual(pick(s.service.status()), { active: false, since: '2026-10-29T11:00:00.000Z', source: null, until: null });
  s.service.setActive(true, { source: 'schedule', until: '2026-10-29T21:00:00.000Z' });
  assert.deepEqual(pick(s.service.status()), { active: true, since: '2026-10-29T11:00:00.000Z', source: 'schedule', until: null }, 'the schedule has no until of its own');
  s.service.close();
});

test('setActive without options is a manual on with no limit, as PUT {active} alone (D3, previous behavior)', () => {
  const s = setup();
  s.service.setActive(true);
  assert.deepEqual(pick(s.service.status()), { active: true, since: '2026-10-29T11:00:00.000Z', source: 'manual', until: null });
  assert.deepEqual(s.heard, [[true, '2026-10-29T11:00:00.000Z', 'manual']]);
  s.time.advance('2026-11-05T11:00:00Z');
  assert.equal(s.service.active, true, 'no limit: nothing turns it off');
  s.service.close();
});

test('a manual on turns itself off when `until` passes, as if the user did; not a minute before (D3)', () => {
  const s = setup();
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.time.advance('2026-10-29T20:59:00Z');
  assert.equal(s.service.active, true);
  s.time.advance('2026-10-29T21:00:00Z');
  assert.deepEqual(pick(s.service.status()), { active: false, since: '2026-10-29T11:00:00.000Z', source: null, until: null });
  assert.deepEqual(s.heard, [
    [true, '2026-10-29T11:00:00.000Z', 'manual'],
    [false, '2026-10-29T11:00:00.000Z', 'manual'],
  ]);
  assert.ok(s.time.delays.every((ms) => ms >= 0 && ms <= 60 * 60_000), 'the timer never waits more than an hour');
  assert.equal(s.time.armed(), 0, 'nothing left armed');
  s.service.close();
});

test('an until tomorrow waits across the night; turning off by hand first cancels it (D3)', () => {
  const s = setup('2026-10-29T23:00:00Z');
  s.service.setActive(true, { source: 'manual', until: '2026-10-30T10:30:00.000Z' });
  s.time.advance('2026-10-30T10:29:00Z');
  assert.equal(s.service.active, true);
  s.service.setActive(false);
  assert.equal(s.time.armed(), 0);
  s.service.setActive(true, { source: 'manual' });
  s.time.advance('2026-10-30T10:31:00Z');
  assert.equal(s.service.active, true, 'the old until is gone with the off');
  s.service.close();
});

test('on by hand while the schedule has it on takes it over: source manual and the new until, same activation (D3)', () => {
  const s = setup();
  s.service.setActive(true, { source: 'schedule' });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T15:00:00.000Z' });
  assert.deepEqual(pick(s.service.status()), { active: true, since: '2026-10-29T11:00:00.000Z', source: 'manual', until: '2026-10-29T15:00:00.000Z' });
  assert.deepEqual(s.heard, [[true, '2026-10-29T11:00:00.000Z', 'schedule']], 'not a new activation: no on/off event');
  s.service.setActive(true, { source: 'schedule' });
  assert.equal(s.service.status().source, 'manual', 'the schedule never takes a manual on back');
  s.time.advance('2026-10-29T15:00:00Z');
  assert.equal(s.service.active, false);
  s.service.close();
});

test('a manual on is saved with since and until; off or a scheduled on saves none (D3)', () => {
  const s = setup();
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.service.setActive(false);
  s.service.setActive(true, { source: 'schedule' });
  s.service.setActive(true, { source: 'manual' });
  s.service.setActive(false, { source: 'schedule' });
  assert.deepEqual(s.saved, [
    { since: '2026-10-29T11:00:00.000Z', until: '2026-10-29T21:00:00.000Z' },
    null,
    null,
    { since: '2026-10-29T11:00:00.000Z', until: null },
    null,
  ]);
  assert.deepEqual(s.heard.at(-1), [false, '2026-10-29T11:00:00.000Z', 'schedule']);
  s.service.close();
});

test('a restart resumes the saved manual on with its own since and until (D3)', () => {
  const s = setup('2026-10-29T14:00:00Z');
  s.service.setActive(true, { source: 'manual', since: '2026-10-29T11:00:00.000Z', until: '2026-10-29T21:00:00.000Z' });
  assert.deepEqual(pick(s.service.status()), { active: true, since: '2026-10-29T11:00:00.000Z', source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.time.advance('2026-10-29T21:00:00Z');
  assert.equal(s.service.active, false);
  s.service.close();
});

test('a shutdown is not an off: the until timer stops and the saved manual on stays (D3)', () => {
  const s = setup();
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.service.close();
  assert.equal(s.time.armed(), 0);
  assert.deepEqual(s.saved, [{ since: '2026-10-29T11:00:00.000Z', until: '2026-10-29T21:00:00.000Z' }], 'nothing cleared');
  assert.deepEqual(s.heard.map(([active]) => active), [true], 'no off event');
});

/* ---------- The real service and scheduler on one fake clock ---------- */

const SANTIAGO = 'America/Santiago';
const nightly: NightSchedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', remindBeforeMinutes: 0 };

function withScheduler(startIso: string) {
  const s = setup(startIso);
  const schedulerState: SchedulerState[] = [];
  const scheduler = new NightScheduler({
    service: s.service,
    timeZone: SANTIAGO,
    schedule: nightly,
    saveState: (state) => void schedulerState.push({ ...state }),
    now: s.time.now,
    setTimer: (fn, ms) => s.time.setTimer(fn, ms),
  });
  // Wired like the night routes: a passing until asks the scheduler first.
  s.service.handOverTo(() => scheduler.covers());
  scheduler.start();
  return { ...s, scheduler, schedulerState };
}

test('an until that passes inside a running window hands the autopilot to the schedule: no off, no suppression; off at the window end (D3a)', () => {
  // 20:00 local on 2026-10-28 (UTC-3); the window runs 23:00-07:00.
  const s = withScheduler('2026-10-28T23:00:00Z');
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T04:00:00.000Z' });
  s.time.advance('2026-10-29T02:00:00Z');
  assert.equal(s.service.status().source, 'manual', 'the window start leaves the manual on alone');
  s.time.advance('2026-10-29T04:00:00Z');
  assert.deepEqual(pick(s.service.status()), { active: true, since: '2026-10-28T23:00:00.000Z', source: 'schedule', until: null }, '01:00 local: handed over, same activation');
  assert.deepEqual(s.heard, [[true, '2026-10-28T23:00:00.000Z', 'manual']], 'no off/on flicker, so no summary');
  assert.equal(s.saved.at(-1), null, 'no manual on left to resume');
  assert.equal(s.schedulerState.some((state) => state.suppressedUntil !== undefined), false, 'not taken as the user turning it off');
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, false, 'the schedule turns it off at 07:00');
  assert.deepEqual(s.heard.at(-1), [false, '2026-10-28T23:00:00.000Z', 'schedule'], 'the morning summary wording');
  s.scheduler.close();
  s.service.close();
});

test('an until that passes outside any window turns it off as the user would, without suppressing the next window (D3a)', () => {
  const s = withScheduler('2026-10-28T20:00:00Z');
  s.service.setActive(true, { source: 'manual', until: '2026-10-28T23:00:00.000Z' });
  s.time.advance('2026-10-28T23:00:00Z');
  assert.equal(s.service.active, false);
  assert.deepEqual(s.heard.at(-1), [false, '2026-10-28T20:00:00.000Z', 'manual'], 'the neutral summary');
  s.time.advance('2026-10-29T02:00:00Z');
  assert.deepEqual([s.service.active, s.service.status().source], [true, 'schedule'], 'the night still starts');
  s.scheduler.close();
  s.service.close();
});

test('an explicit off by the user inside a window still sets suppressedUntil, also after a manual on (D3a, previous behavior)', () => {
  const s = withScheduler('2026-10-29T03:00:00Z');
  assert.equal(s.service.status().source, 'schedule');
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T09:00:00.000Z' });
  s.service.setActive(false, { source: 'manual' });
  assert.equal(s.schedulerState.at(-1)?.suppressedUntil, Date.parse('2026-10-29T10:00:00Z'));
  s.time.advance('2026-10-29T09:30:00Z');
  assert.equal(s.service.active, false, 'stays off for the rest of the window');
  s.scheduler.close();
  s.service.close();
});

test('in a window the user already turned off, a later manual on ends with a plain off at its until: no handover (D3a)', () => {
  const s = withScheduler('2026-10-29T03:00:00Z');
  s.service.setActive(false, { source: 'manual' });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T06:00:00.000Z' });
  s.time.advance('2026-10-29T06:00:00Z');
  assert.deepEqual(pick(s.service.status()), { active: false, since: '2026-10-29T03:00:00.000Z', source: null, until: null }, 'the latest explicit choices win');
  assert.deepEqual(s.heard.at(-1), [false, '2026-10-29T03:00:00.000Z', 'manual']);
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, false);
  s.scheduler.close();
  s.service.close();
});

test('the call budget follows who has the autopilot: no cap by hand, capped again from the handover on, counting what was used (D2, D3a)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-autopilot-budget-'));
  const s = withScheduler('2026-10-28T23:00:00Z');
  const budget = new CallBudget({
    file: join(dir, 'night', 'budget.json'),
    limits: () => ({ night: 2, improveDay: 5 }),
    nightOf: (since) => jornadaOf(SANTIAGO, nightly.end, since),
    now: s.time.now,
    // Wired like server.ts: on by hand means no cap.
    uncapped: () => s.service.source === 'manual',
  });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T04:00:00.000Z' });
  budget.startNight(s.service.status().since!);
  assert.deepEqual([budget.take('decide'), budget.take('decide'), budget.take('judge')], [true, true, true], 'by hand: past the limit of 2');
  s.time.advance('2026-10-29T04:00:00Z');
  assert.equal(s.service.source, 'schedule');
  assert.equal(budget.take('decide'), false, 'the schedule has it: capped, with the 3 calls already used');
  assert.equal(budget.night().used, 3);
  s.scheduler.close();
  s.service.close();
  await budget.flush();
  await rm(dir, { recursive: true, force: true });
});

function pick(status: { active: boolean; since: string | null; source?: unknown; until?: unknown }) {
  return { active: status.active, since: status.since, source: status.source, until: status.until };
}

/* ---------- The summary sent when it turns off ---------- */

async function report() {
  const dir = join(await mkdtemp(join(tmpdir(), 'mirador-autopilot-report-')), 'night');
  const shutdown: Array<() => void | Promise<void>> = [];
  const listeners = new Set<(active: boolean, since: string | null, cause?: AutopilotSource) => void>();
  const desktop: NotifyChannel & { sent: Notice[] } = { name: 'desktop', sent: [], send: async (notice) => void desktop.sent.push(notice) };
  const telegram: NotifyChannel & { sent: Notice[] } = { name: 'telegram', sent: [], send: async (notice) => void telegram.sent.push(notice) };
  const ctx = {
    config: { nightModel: undefined, notifications: undefined },
    workspaces: { get: () => undefined, list: () => [] },
    onShutdown: (fn: () => void | Promise<void>) => void shutdown.push(fn),
  } as unknown as AppContext;
  await createNightReportRoutes({
    dir,
    telegramFile: join(dir, '..', 'telegram.json'),
    judgeRun: async () => '{"verdict":"ok","note":"fine"}',
    channels: { desktop, telegram },
    onActiveChange: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  })(ctx);
  return {
    desktop,
    telegram,
    emit: (active: boolean, since: string | null, cause?: AutopilotSource) => {
      for (const listener of [...listeners]) listener(active, since, cause);
    },
    close: async () => {
      for (const fn of shutdown) await fn();
      await rm(join(dir, '..'), { recursive: true, force: true });
    },
  };
}

async function waitFor<T>(check: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

test('turned off by the user (or its until), the summary goes to desktop and Telegram with neutral wording (D5)', async () => {
  const r = await report();
  const since = new Date(Date.now() - 60_000).toISOString();
  r.emit(true, since, 'manual');
  r.emit(false, since, 'manual');
  const notice = await waitFor(() => r.desktop.sent.find((n) => n.kind === 'morning'));
  assert.equal(notice.title, 'Mirador: resumen del piloto automático');
  assert.match(notice.body, /^Mientras no estabas, Mirador hizo esto:\nDecididas: 0 · Seguimientos: 0 · Pendientes para ti: 0/);
  assert.match(notice.body, /Revísalo en Mirador › Seguimiento\.$/);
  assert.ok(!/noche|mañana/i.test(notice.title + notice.body), 'nothing says night or morning');
  const phone = await waitFor(() => r.telegram.sent.find((n) => n.kind === 'morning'));
  assert.deepEqual(phone, notice, 'the same notice on Telegram');
  await r.close();
});

test('a night the schedule ends keeps the morning summary wording (D5, previous behavior)', async () => {
  const r = await report();
  const since = new Date(Date.now() - 60_000).toISOString();
  r.emit(true, since, 'schedule');
  r.emit(false, since, 'schedule');
  const notice = await waitFor(() => r.desktop.sent.find((n) => n.kind === 'morning'));
  assert.equal(notice.title, 'Mirador: resumen del turno de noche');
  assert.match(notice.body, /^Decididas: 0 · Seguimientos: 0/);
  await r.close();
});
