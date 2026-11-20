// The night shift schedule and the bedtime reminder timing: window math in
// the configured time zone (crossing midnight, DST in America/Santiago), the scheduler's
// manual override rules with a fake clock, the reminder once per night, and the 0600 files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SCHEDULE,
  NightScheduler,
  ScheduleError,
  ScheduleStore,
  currentWindow,
  nextWindow,
  nightScheduler,
  parseSchedule,
  provideNightScheduler,
  untilInstant,
  zonedTime,
  type NightSchedule,
  type SchedulerState,
} from '../src/night/schedule.ts';

const SANTIAGO = 'America/Santiago';
const at = (iso: string) => Date.parse(iso);
const schedule = (patch: Partial<NightSchedule> = {}): NightSchedule => ({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', remindBeforeMinutes: 30, ...patch });

test('parseSchedule accepts a complete schedule, sorts the days and defaults the reminder to 30 minutes', () => {
  assert.deepEqual(parseSchedule({ enabled: true, days: [5, 1, 3], start: '22:30', end: '06:15' }), { enabled: true, days: [1, 3, 5], start: '22:30', end: '06:15', remindBeforeMinutes: 30 });
  assert.deepEqual(parseSchedule({ enabled: false, days: [], start: '00:00', end: '23:59', remindBeforeMinutes: 0 }), { enabled: false, days: [], start: '00:00', end: '23:59', remindBeforeMinutes: 0 });
  assert.equal(DEFAULT_SCHEDULE.enabled, false, 'nothing runs by itself until the user sets it');
  assert.equal(DEFAULT_SCHEDULE.remindBeforeMinutes, 30);
});

test('parseSchedule rejects every malformed field with a message that says what to write', () => {
  const good = { enabled: true, days: [1], start: '23:00', end: '07:00', remindBeforeMinutes: 30 };
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/],
    [[], /object/],
    [{ ...good, extra: 1 }, /unknown field extra/],
    [{ ...good, enabled: 'yes' }, /enabled/],
    [{ ...good, days: 'mon' }, /days/],
    [{ ...good, days: [7] }, /days/],
    [{ ...good, days: [1.5] }, /days/],
    [{ ...good, days: [1, 1] }, /twice/],
    [{ ...good, enabled: true, days: [] }, /at least one day/],
    [{ ...good, start: '7:00' }, /start.*HH:MM/],
    [{ ...good, start: '24:00' }, /start/],
    [{ ...good, end: '07:60' }, /end/],
    [{ ...good, end: 700 }, /end/],
    [{ ...good, end: '23:00' }, /start and end/],
    [{ ...good, remindBeforeMinutes: -1 }, /remindBeforeMinutes/],
    [{ ...good, remindBeforeMinutes: 241 }, /remindBeforeMinutes/],
    [{ ...good, remindBeforeMinutes: 2.5 }, /remindBeforeMinutes/],
    [{ ...good, remindBeforeMinutes: '30' }, /remindBeforeMinutes/],
    [{ enabled: true, days: [1], start: '23:00' }, /end/],
  ];
  for (const [value, message] of bad) assert.throws(() => parseSchedule(value), (error: unknown) => error instanceof ScheduleError && message.test((error as Error).message), JSON.stringify(value));
});

test('zonedTime turns a local wall time into an instant; a skipped time moves forward, a repeated one takes the first', () => {
  assert.equal(zonedTime(2026, 10, 28, 23, 0, SANTIAGO), at('2026-10-29T02:00:00Z'), 'summer time: UTC-3');
  assert.equal(zonedTime(2026, 7, 1, 23, 0, SANTIAGO), at('2026-07-02T03:00:00Z'), 'winter time: UTC-4');
  // 2026-09-06 00:00-00:59 does not exist in Santiago (clocks jump to 01:00).
  assert.equal(zonedTime(2026, 9, 6, 0, 30, SANTIAGO), at('2026-09-06T04:30:00Z'), '00:30 becomes 01:30 summer time');
  // 2026-04-04 23:00-23:59 happens twice (clocks go back at 24:00).
  assert.equal(zonedTime(2026, 4, 4, 23, 30, SANTIAGO), at('2026-04-05T02:30:00Z'), 'the first 23:30, still summer time');
  assert.equal(zonedTime(2026, 1, 15, 8, 0, 'UTC'), at('2026-01-15T08:00:00Z'));
});

test('a window that crosses midnight starts on its listed day and ends the next morning', () => {
  // Wednesday 2026-10-28, Santiago (UTC-3).
  const s = schedule({ days: [3] });
  assert.deepEqual(currentWindow(s, SANTIAGO, at('2026-10-29T03:00:00Z')), { start: at('2026-10-29T02:00:00Z'), end: at('2026-10-29T10:00:00Z') }, 'Wednesday 00:00 local → inside Wednesday 23:00-Thursday 07:00');
  assert.equal(currentWindow(s, SANTIAGO, at('2026-10-29T10:00:00Z')), null, 'the end is outside');
  assert.equal(currentWindow(s, SANTIAGO, at('2026-10-29T01:59:00Z')), null, 'before the start');
  assert.deepEqual(nextWindow(s, SANTIAGO, at('2026-10-28T12:00:00Z')), { start: at('2026-10-29T02:00:00Z'), end: at('2026-10-29T10:00:00Z') });
  assert.deepEqual(nextWindow(s, SANTIAGO, at('2026-10-29T03:00:00Z')), { start: at('2026-11-05T02:00:00Z'), end: at('2026-11-05T10:00:00Z') }, 'the next one is a week later');
  // Thursday 01:00 local is inside the window that started on Wednesday, not one of Thursday.
  assert.equal(currentWindow(schedule({ days: [4] }), SANTIAGO, at('2026-10-29T04:00:00Z')), null);
});

test('a window inside one day ends the same day', () => {
  const s = schedule({ days: [6], start: '01:00', end: '06:30' });
  // Saturday 2026-10-31.
  assert.deepEqual(currentWindow(s, SANTIAGO, at('2026-10-31T05:00:00Z')), { start: at('2026-10-31T04:00:00Z'), end: at('2026-10-31T09:30:00Z') });
  assert.equal(currentWindow(s, SANTIAGO, at('2026-10-31T10:00:00Z')), null);
});

test('DST in America/Santiago: the windows around both changes keep their local times', () => {
  // Spring forward on the night of Saturday 2026-09-05: 23:00 UTC-4 to 07:00 UTC-3 is 7 hours.
  const spring = currentWindow(schedule({ days: [6] }), SANTIAGO, at('2026-09-06T05:00:00Z'));
  assert.deepEqual(spring, { start: at('2026-09-06T03:00:00Z'), end: at('2026-09-06T10:00:00Z') });
  // Fall back on the night of Saturday 2026-04-04: 23:30 UTC-3 to 07:00 UTC-4 is 8.5 hours.
  const fall = currentWindow(schedule({ days: [6], start: '23:30' }), SANTIAGO, at('2026-04-05T06:00:00Z'));
  assert.deepEqual(fall, { start: at('2026-04-05T02:30:00Z'), end: at('2026-04-05T11:00:00Z') });
  // A start in the skipped hour starts at 01:xx of the new time.
  const skipped = currentWindow(schedule({ days: [0], start: '00:30', end: '06:00' }), SANTIAGO, at('2026-09-06T05:00:00Z'));
  assert.deepEqual(skipped, { start: at('2026-09-06T04:30:00Z'), end: at('2026-09-06T09:00:00Z') });
});

test('untilInstant: a local HH:MM today when still ahead, otherwise tomorrow (D3)', () => {
  // 2026-10-29 08:00 in Santiago (UTC-3).
  const now = at('2026-10-29T11:00:00Z');
  assert.equal(untilInstant('10:00', SANTIAGO, now), at('2026-10-29T13:00:00Z'), 'later today');
  assert.equal(untilInstant('07:30', SANTIAGO, now), at('2026-10-30T10:30:00Z'), 'already past: tomorrow');
  assert.equal(untilInstant('08:00', SANTIAGO, now), at('2026-10-30T11:00:00Z'), 'right now is not ahead: tomorrow');
  assert.equal(untilInstant('00:15', SANTIAGO, at('2026-10-29T02:30:00Z')), at('2026-10-29T03:15:00Z'), '23:30 local: 00:15 is after midnight, the next local day');
  for (const bad of ['7:00', '24:00', '10:60', '', 'noon']) assert.throws(() => untilInstant(bad, SANTIAGO, now), ScheduleError, bad);
});

test('a disabled schedule or one without days has no windows', () => {
  assert.equal(currentWindow(schedule({ enabled: false }), SANTIAGO, at('2026-10-29T03:00:00Z')), null);
  assert.equal(nextWindow(schedule({ enabled: false }), SANTIAGO, at('2026-10-29T03:00:00Z')), null);
  assert.equal(nextWindow({ ...schedule(), days: [] }, SANTIAGO, at('2026-10-29T03:00:00Z')), null);
});

/* ---------- Scheduler with a fake clock ---------- */

/** Like NightService: who turned it on (`source`); a manual on while on takes it over. */
function fakeService() {
  const listeners = new Set<(active: boolean, since: string | null) => void>();
  const service = {
    active: false,
    source: null as 'manual' | 'schedule' | null,
    calls: [] as boolean[],
    sources: [] as Array<string | undefined>,
    setActive(active: boolean, options: { source?: 'manual' | 'schedule' } = {}) {
      const changed = active !== service.active;
      service.active = active;
      service.calls.push(active);
      service.sources.push(options.source);
      if (!active) service.source = null;
      else if (changed || options.source !== 'schedule') service.source = options.source ?? 'manual';
      if (changed) for (const listener of listeners) listener(active, null);
    },
    onActiveChange(listener: (active: boolean, since: string | null) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The user flips the switch (PUT /api/night). */
    manual(active: boolean) {
      service.setActive(active, { source: 'manual' });
    },
  };
  return service;
}

function clock(startIso: string) {
  let now = at(startIso);
  let timer: { fn: () => void; due: number } | null = null;
  const delays: number[] = [];
  return {
    now: () => now,
    delays,
    setTimer(fn: () => void, ms: number) {
      delays.push(ms);
      const entry = { fn, due: now + ms };
      timer = entry;
      return () => {
        if (timer === entry) timer = null;
      };
    },
    /** Moves the clock to `iso`, firing the armed timer each time it falls due on the way. */
    advance(iso: string) {
      const target = at(iso);
      while (timer && timer.due <= target) {
        const { fn, due } = timer;
        timer = null;
        now = Math.max(now, due);
        fn();
      }
      now = target;
    },
  };
}

function setup(startIso: string, s: NightSchedule = schedule(), state: SchedulerState = {}) {
  const service = fakeService();
  const time = clock(startIso);
  const saved: SchedulerState[] = [];
  const reminders: Array<{ window: { start: string; end: string }; content: unknown }> = [];
  const scheduler = new NightScheduler({
    service,
    timeZone: SANTIAGO,
    schedule: s,
    state,
    saveState: (next) => void saved.push({ ...next }),
    reminder: () => ({ agents: 2 }),
    now: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
  });
  scheduler.onReminder((reminder) => void reminders.push(reminder));
  return { service, time, saved, reminders, scheduler };
}

test('the scheduler turns the night shift on at the start and off at the end', () => {
  const s = setup('2026-10-28T20:00:00Z');
  s.scheduler.start();
  assert.equal(s.service.active, false);
  s.time.advance('2026-10-29T02:00:00Z');
  assert.equal(s.service.active, true, 'on at 23:00 local');
  s.time.advance('2026-10-29T09:59:00Z');
  assert.equal(s.service.active, true);
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, false, 'off at 07:00 local');
  assert.deepEqual(s.service.calls, [true, false]);
  assert.deepEqual(s.service.sources, ['schedule', 'schedule'], 'the scheduler says it is the one switching');
  assert.ok(s.time.delays.every((ms) => ms >= 0 && ms <= 60 * 60_000), 'timers never wait more than an hour');
  s.scheduler.close();
});

test('Mirador starting inside a window turns the night shift on at once', () => {
  const s = setup('2026-10-29T05:00:00Z');
  s.scheduler.start();
  assert.equal(s.service.active, true);
  s.scheduler.close();
});

test('turned off by hand inside the window, it stays off until the next window, also after a restart', () => {
  const s = setup('2026-10-29T01:00:00Z');
  s.scheduler.start();
  s.time.advance('2026-10-29T02:00:00Z');
  assert.equal(s.service.active, true);
  s.time.advance('2026-10-29T04:00:00Z');
  s.service.manual(false);
  s.time.advance('2026-10-29T09:00:00Z');
  assert.equal(s.service.active, false, 'the scheduler did not turn it back on');
  assert.equal(s.saved.at(-1)?.suppressedUntil, at('2026-10-29T10:00:00Z'), 'the override is saved with the end of that window');

  // A restart inside the same window keeps it off.
  const again = setup('2026-10-29T06:00:00Z', schedule(), s.saved.at(-1));
  again.scheduler.start();
  assert.equal(again.service.active, false);
  // The next window turns it on again.
  again.time.advance('2026-10-30T02:00:00Z');
  assert.equal(again.service.active, true);
  s.scheduler.close();
  again.scheduler.close();
});

test('turned on by hand outside the window, it survives the next window’s start and end: only the user turns it off (D3)', () => {
  const s = setup('2026-10-28T15:00:00Z');
  s.scheduler.start();
  s.service.manual(true);
  s.time.advance('2026-10-29T02:00:00Z');
  assert.equal(s.service.active, true);
  assert.equal(s.service.source, 'manual', 'the window start does not take it over');
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, true, 'the window end leaves a manual on alone');
  s.time.advance('2026-10-30T10:00:00Z');
  assert.equal(s.service.active, true, 'and the next window too');
  assert.deepEqual(s.service.calls, [true], 'the scheduler never flipped the switch');
  // The user turns it off outside a window: the next window turns it on again, as the schedule's.
  s.service.manual(false);
  assert.equal(s.saved.some((state) => state.suppressedUntil), false, 'an off outside a window suppresses nothing');
  s.time.advance('2026-10-31T02:00:00Z');
  assert.equal(s.service.source, 'schedule');
  s.time.advance('2026-10-31T10:00:00Z');
  assert.equal(s.service.active, false);
  s.scheduler.close();
});

test('turned back on by hand inside a window after a manual off, it survives the window end (D3)', () => {
  const s = setup('2026-10-29T03:00:00Z');
  s.scheduler.start();
  assert.equal(s.service.source, 'schedule');
  s.service.manual(false);
  assert.equal(s.saved.at(-1)?.suppressedUntil, at('2026-10-29T10:00:00Z'), 'a manual off inside the window still suppresses it');
  s.service.manual(true);
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, true, 'the end of the window does not turn off a manual on');
  s.scheduler.close();
});

test('the user taking over a scheduled on (on by hand while on) keeps it past the window end (D3)', () => {
  const s = setup('2026-10-29T03:00:00Z');
  s.scheduler.start();
  s.service.manual(true);
  assert.equal(s.service.source, 'manual');
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, true);
  assert.deepEqual(s.service.calls, [true, true], 'no off from the scheduler');
  s.scheduler.close();
});

test('the reminder fires once per night at start − remindBeforeMinutes, with the reminder content', () => {
  const s = setup('2026-10-28T20:00:00Z');
  s.scheduler.start();
  s.time.advance('2026-10-29T01:29:00Z');
  assert.equal(s.reminders.length, 0);
  s.time.advance('2026-10-29T01:30:00Z');
  assert.equal(s.reminders.length, 1, 'at 22:30 local');
  assert.deepEqual(s.reminders[0], { window: { start: '2026-10-29T02:00:00.000Z', end: '2026-10-29T10:00:00.000Z' }, content: { agents: 2 } });
  assert.equal(s.saved.at(-1)?.remindedFor, at('2026-10-29T02:00:00Z'));
  assert.equal(s.scheduler.view().reminderDue, true, 'the panel shows its banner until the start');
  s.time.advance('2026-10-29T02:00:00Z');
  assert.equal(s.scheduler.view().reminderDue, false);
  s.time.advance('2026-10-29T12:00:00Z');
  assert.equal(s.reminders.length, 1, 'once for that night');
  s.time.advance('2026-10-30T01:30:00Z');
  assert.equal(s.reminders.length, 2, 'and once the next night');
  s.scheduler.close();
});

test('a restart after the reminder does not repeat it; one inside the window never sends it; 0 minutes turns it off', () => {
  const first = setup('2026-10-29T01:40:00Z', schedule(), { remindedFor: at('2026-10-29T02:00:00Z') });
  first.scheduler.start();
  assert.equal(first.reminders.length, 0, 'already reminded for tonight');
  first.scheduler.close();

  const late = setup('2026-10-29T01:40:00Z');
  late.scheduler.start();
  assert.equal(late.reminders.length, 1, 'Mirador started between the reminder time and the start: it reminds now');
  late.scheduler.close();

  const inside = setup('2026-10-29T03:00:00Z');
  inside.scheduler.start();
  assert.equal(inside.reminders.length, 0);
  inside.scheduler.close();

  const off = setup('2026-10-28T20:00:00Z', schedule({ remindBeforeMinutes: 0 }));
  off.scheduler.start();
  off.time.advance('2026-10-29T03:00:00Z');
  assert.equal(off.reminders.length, 0);
  assert.equal(off.service.active, true);
  off.scheduler.close();
});

test('a disabled schedule never touches the switch; updating it re-arms the timers', () => {
  const s = setup('2026-10-28T20:00:00Z', schedule({ enabled: false }));
  s.scheduler.start();
  s.time.advance('2026-10-29T05:00:00Z');
  assert.equal(s.service.active, false);
  assert.deepEqual(s.service.calls, []);
  s.scheduler.update(schedule());
  assert.equal(s.service.active, true, 'saving a schedule inside its window turns the night shift on');
  s.scheduler.update(schedule({ enabled: false }));
  s.time.advance('2026-10-29T11:00:00Z');
  assert.equal(s.service.active, true, 'disabling leaves the switch as it is');
  assert.equal(s.scheduler.view().next, null);
  s.scheduler.close();
});

test('view() reports the schedule, the zone, the current and next windows and the reminder time', () => {
  const s = setup('2026-10-28T20:00:00Z');
  s.scheduler.start();
  assert.deepEqual(s.scheduler.view(), {
    schedule: schedule(),
    timeZone: SANTIAGO,
    current: null,
    next: { start: '2026-10-29T02:00:00.000Z', end: '2026-10-29T10:00:00.000Z', remindAt: '2026-10-29T01:30:00.000Z' },
    reminderDue: false,
    offUntil: null,
  });
  s.scheduler.close();
});

test('closing the scheduler stops it and a shutdown that turns the night shift off is not taken as the user', () => {
  const s = setup('2026-10-29T03:00:00Z');
  s.scheduler.start();
  s.scheduler.close();
  s.service.setActive(false);
  assert.equal(s.saved.some((state) => state.suppressedUntil), false);
  s.time.advance('2026-10-30T03:00:00Z');
  assert.deepEqual(s.service.calls, [true, false]);
});

test('provideNightScheduler/nightScheduler share the scheduler per app', () => {
  const app = {};
  const s = setup('2026-10-28T20:00:00Z');
  assert.equal(nightScheduler(app), null);
  provideNightScheduler(app, s.scheduler);
  assert.equal(nightScheduler(app), s.scheduler);
  assert.equal(nightScheduler({}), null);
});

test('ScheduleStore keeps the schedule and the scheduler state in 0600 files of a 0700 folder', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'mirador-schedule-')), 'night');
  try {
    const store = new ScheduleStore(dir);
    assert.deepEqual(await store.load(), { schedule: DEFAULT_SCHEDULE, state: {} }, 'defaults when nothing is saved');
    await store.saveSchedule(schedule({ days: [1, 2] }));
    await store.saveState({ remindedFor: 123, suppressedUntil: 456 });
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const name of ['schedule.json', 'scheduler.json']) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name);
    assert.deepEqual(await new ScheduleStore(dir).load(), { schedule: schedule({ days: [1, 2] }), state: { remindedFor: 123, suppressedUntil: 456 } });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'schedule.json'), 'utf8')), schedule({ days: [1, 2] }));
    // A broken or hand-edited file falls back to the defaults instead of failing the start.
    await writeFile(join(dir, 'schedule.json'), '{"enabled": "maybe"}');
    await writeFile(join(dir, 'scheduler.json'), 'not json');
    assert.deepEqual(await new ScheduleStore(dir).load(), { schedule: DEFAULT_SCHEDULE, state: {} });
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('ScheduleStore keeps a manual on (since, until) in a 0600 autopilot.json; off or a broken file reads as none (D3)', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'mirador-autopilot-')), 'night');
  try {
    const store = new ScheduleStore(dir);
    assert.equal(await store.loadManual(), null, 'nothing saved');
    await store.saveManual({ since: '2026-10-29T12:00:00.000Z', until: '2026-10-29T21:00:00.000Z' });
    assert.equal((await stat(join(dir, 'autopilot.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'autopilot.json'), 'utf8')), { manual: { since: '2026-10-29T12:00:00.000Z', until: '2026-10-29T21:00:00.000Z' } });
    assert.deepEqual(await new ScheduleStore(dir).loadManual(), { since: '2026-10-29T12:00:00.000Z', until: '2026-10-29T21:00:00.000Z' });
    await store.saveManual({ since: '2026-10-29T12:00:00.000Z', until: null });
    assert.deepEqual(await new ScheduleStore(dir).loadManual(), { since: '2026-10-29T12:00:00.000Z', until: null }, 'no limit');
    await store.saveManual(null);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'autopilot.json'), 'utf8')), { manual: null });
    assert.equal(await new ScheduleStore(dir).loadManual(), null);
    for (const text of ['not json', '{"manual":{"since":5,"until":null}}', '{"manual":{"since":"2026-10-29T12:00:00.000Z","until":"later"}}']) {
      await writeFile(join(dir, 'autopilot.json'), text);
      assert.equal(await new ScheduleStore(dir).loadManual(), null, text);
    }
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

import { reminderNotice } from '../src/night/schedule.ts';

test('reminderNotice is a short Spanish notification: start time, counts per workspace, missing missions; never agent text', () => {
  const notice = reminderNotice(
    {
      window: { start: '2026-10-29T02:00:00.000Z', end: '2026-10-29T10:00:00.000Z' },
      content: {
        time: '2026-10-29T01:30:00.000Z',
        waiting: 1,
        pending: [],
        workspaces: [
          { workspaceId: 'dev', name: 'Dev', hasMission: true, missionNote: null, agents: [
            { terminalId: 'a', rel: 'x', title: 'x', state: 'finished', connected: true, activity: null, waitingFor: null, closingQuestion: 'Shall I push the secret token?' },
            { terminalId: 'b', rel: 'y', title: 'y', state: 'blocked', connected: true, activity: null, waitingFor: 'Pick one', closingQuestion: null },
          ] },
          { workspaceId: 'ops', name: 'Ops', hasMission: false, missionNote: 'none', agents: [{ terminalId: 'c', rel: '', title: 'root', state: 'working', connected: false, activity: null, waitingFor: null, closingQuestion: null }] },
        ],
      },
    },
    SANTIAGO,
  );
  assert.equal(notice.title, 'Mirador: se acerca el turno de noche');
  assert.equal(notice.body, [
    'Empieza a las 23:00 y termina a las 07:00.',
    'Dev: 2 agentes (1 te espera, 1 terminó)',
    'Ops: 1 agente (1 sin conexión); sin misión: Mirador dejará todo pendiente',
    'Revisa lo que queda y deja tus notas en Mirador › Seguimiento.',
  ].join('\n'));
  assert.ok(!notice.body.includes('secret') && !notice.body.includes('Pick one'), 'no agent text leaves Mirador');
  assert.equal(reminderNotice({ window: { start: '2026-10-29T02:00:00.000Z', end: '2026-10-29T10:00:00.000Z' }, content: null }, SANTIAGO).body.split('\n').length, 2, 'without content: the time and the hint');
});
