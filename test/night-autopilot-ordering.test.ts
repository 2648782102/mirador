// The autopilot's ordering: races between a manual
// on's until timer and the scheduler, and the call budget across jornadas and restarts. Probes from
// the independent verifier; the real service and scheduler on one fake clock, no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightService, type AutopilotChange, type AutopilotSource, type ManualOn, type NightLink } from '../src/night/service.ts';
import { NightScheduler, ScheduleStore, resumeManual, type NightSchedule, type SchedulerState } from '../src/night/schedule.ts';
import { CallBudget, jornadaOf } from '../src/night/budget.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess { onData() {} onExit() {} write() {} resize() {} kill() {} }
const at = (iso: string) => Date.parse(iso);

function clock(startIso: string) {
  let now = at(startIso);
  const timers = new Set<{ fn: () => void; due: number }>();
  return {
    now: () => now,
    armed: () => timers.size,
    setTimer(fn: () => void, ms: number) {
      const entry = { fn, due: now + ms };
      timers.add(entry);
      return () => void timers.delete(entry);
    },
    /** Fires each due timer at its own due time (a running machine). */
    advance(iso: string) {
      const target = at(iso);
      for (;;) {
        const next = [...timers].filter((e) => e.due <= target).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        timers.delete(next);
        now = Math.max(now, next.due);
        next.fn();
      }
      now = target;
    },
    /** The clock jumps (a suspended laptop): every due timer fires only now, in due order. */
    jump(iso: string) {
      now = at(iso);
      for (;;) {
        const next = [...timers].filter((e) => e.due <= now).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        timers.delete(next);
        next.fn();
      }
    },
  };
}

const SANTIAGO = 'America/Santiago';
const nightly: NightSchedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', remindBeforeMinutes: 0 };

/**
 * The service and scheduler wired like the night routes. Options: the schedule (default 23:00-07:00),
 * a clock and a store shared across restarts (the store gets the manual on and the activation log),
 * and whether the night socket is available.
 */
function setup(startIso: string, options: { plan?: NightSchedule; time?: ReturnType<typeof clock>; store?: ScheduleStore; available?: boolean } = {}) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 4096 });
  const available = options.available ?? true;
  const link: NightLink | null = available ? { send: () => false, isConnected: () => false, connectedTerminals: () => [] } : null;
  const time = options.time ?? clock(startIso);
  const saved: Array<ManualOn | null> = [];
  const heard: Array<[boolean, string | null, AutopilotSource | undefined]> = [];
  const changes: AutopilotChange[] = [];
  const service = new NightService({
    link,
    decider: { decide: async () => ({ action: 'defer', reason: 'x' }), followUp: async () => ({ action: 'defer', reason: 'x' }) },
    log: { append: async () => {} },
    terminals,
    workspaces: { get: () => undefined },
    now: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
    saveManual: (state) => {
      saved.push(state);
      return options.store?.saveManual(state);
    },
  });
  service.onActiveChange((active, since, cause) => void heard.push([active, since, cause]));
  service.onAutopilotChange((change) => {
    changes.push(change);
    void options.store?.appendActivation(change);
  });
  const schedulerState: SchedulerState[] = [];
  const scheduler = new NightScheduler({ service, timeZone: SANTIAGO, schedule: options.plan ?? nightly, saveState: (s) => void schedulerState.push({ ...s }), available: () => available, now: time.now, setTimer: (fn, ms) => time.setTimer(fn, ms) });
  service.handOverTo(() => scheduler.covers());
  return { service, time, saved, heard, changes, scheduler, schedulerState, suppressed: () => schedulerState.some((s) => s.suppressedUntil !== undefined) };
}
const pick = (s: ReturnType<NightService['status']>) => ({ active: s.active, source: s.source, until: s.until });

test('P1 D3: a manual on with no until spans a window start and end, and the next ones; the scheduler never turns it off', () => {
  const s = setup('2026-10-28T20:00:00Z'); // 17:00 local
  s.scheduler.start();
  s.service.setActive(true, { source: 'manual' });
  s.time.advance('2026-10-29T02:00:00Z'); // 23:00 window start
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: null });
  s.time.advance('2026-10-29T10:30:00Z'); // 07:30 after window end
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: null });
  s.time.advance('2026-10-30T10:30:00Z'); // through a second window
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: null });
  assert.deepEqual(s.heard.map(([a, , c]) => [a, c]), [[true, 'manual']]);
  assert.equal(s.suppressed(), false);
  s.service.setActive(false, { source: 'manual' }); // off outside a window
  assert.equal(s.suppressed(), false, 'an off outside a window suppresses nothing');
  s.scheduler.close(); s.service.close();
});

for (const order of ['scheduler-first', 'until-first'] as const) {
  test(`P2 D3a race: until exactly at the window start, ${order}: handover, no off event, no suppression`, () => {
    const s = setup('2026-10-28T23:00:00Z'); // 20:00 local
    if (order === 'scheduler-first') s.scheduler.start();
    s.service.setActive(true, { source: 'manual', until: '2026-10-29T02:00:00.000Z' }); // 23:00 local = window start
    if (order === 'until-first') s.scheduler.start();
    s.time.advance('2026-10-29T02:00:00Z');
    assert.deepEqual(pick(s.service.status()), { active: true, source: 'schedule', until: null });
    assert.deepEqual(s.heard.map(([a, , c]) => [a, c]), [[true, 'manual']]);
    assert.equal(s.suppressed(), false);
    assert.equal(s.saved.at(-1), null);
    s.time.advance('2026-10-29T10:00:00Z');
    assert.deepEqual(s.heard.at(-1)?.slice(0, 1).concat(s.heard.at(-1)![2]), [false, 'schedule']);
    s.scheduler.close(); s.service.close();
  });
}

test('P3 D3: repeated PUTs with different untils keep one timer; only the last until fires; on/off/on cancels the old one', () => {
  const s = setup('2026-10-29T11:00:00Z');
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T22:00:00.000Z' });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:30:00.000Z' });
  assert.equal(s.time.armed(), 1, 'one until timer, no leftovers');
  s.time.advance('2026-10-29T21:00:00Z');
  assert.equal(s.service.active, true, 'the first until no longer applies');
  s.time.advance('2026-10-29T21:30:00Z');
  assert.equal(s.service.active, false);
  assert.deepEqual(s.heard.map(([a]) => a), [true, false]);
  assert.equal(s.time.armed(), 0);
  // on/off/on quickly
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T22:00:00.000Z' });
  s.service.setActive(false, { source: 'manual' });
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T23:30:00.000Z' });
  assert.equal(s.time.armed(), 1);
  s.time.advance('2026-10-29T22:00:00Z');
  assert.equal(s.service.active, true, 'the cancelled until does not fire');
  s.time.advance('2026-10-29T23:30:00Z');
  assert.equal(s.service.active, false);
  s.service.close();
});

test('P4 D3: PUT {active} alone while an until is pending clears the limit; the old until does not fire', () => {
  const s = setup('2026-10-29T11:00:00Z');
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T21:00:00.000Z' });
  s.service.setActive(true, { source: 'manual' });
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: null });
  assert.equal(s.time.armed(), 0);
  s.time.advance('2026-10-29T23:00:00Z');
  assert.equal(s.service.active, true);
  assert.deepEqual(s.saved.at(-1), { since: '2026-10-29T11:00:00.000Z', until: null });
  s.service.close();
});

test('P5 D3/D3a: a scheduled on taken over by hand with an until inside the window hands back to the schedule; off at the window end as the schedule', () => {
  const s = setup('2026-10-29T03:00:00Z'); // 00:00 local, inside the window
  s.scheduler.start();
  assert.equal(s.service.source, 'schedule');
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T06:00:00.000Z' }); // 03:00 local
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: '2026-10-29T06:00:00.000Z' });
  assert.deepEqual(s.saved.at(-1), { since: '2026-10-29T03:00:00.000Z', until: '2026-10-29T06:00:00.000Z' });
  s.time.advance('2026-10-29T06:00:00Z');
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'schedule', until: null });
  assert.equal(s.saved.at(-1), null);
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, false);
  assert.deepEqual(s.heard.map(([a, , c]) => [a, c]), [[true, 'schedule'], [false, 'schedule']]);
  assert.equal(s.suppressed(), false);
  s.scheduler.close(); s.service.close();
});

test('P6 D3: a scheduled on taken over by hand with no until survives the window end; a later off by hand outside the window suppresses nothing', () => {
  const s = setup('2026-10-29T03:00:00Z');
  s.scheduler.start();
  s.service.setActive(true, { source: 'manual' });
  s.time.advance('2026-10-29T12:00:00Z'); // 09:00 local
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: null });
  s.service.setActive(false, { source: 'manual' });
  assert.deepEqual(s.heard.map(([a, , c]) => [a, c]), [[true, 'schedule'], [false, 'manual']]);
  assert.equal(s.suppressed(), false);
  s.time.advance('2026-10-30T02:00:00Z');
  assert.equal(s.service.source, 'schedule', 'the next night starts');
  s.scheduler.close(); s.service.close();
});

// Accepted advisory: after a suspend, which of the two timers runs first decides the cause of the off.
test('P7 D3a edge: the until passed inside the window but the clock jumps past the window end (suspended laptop)', { todo: 'accepted advisory: the cause of the off after a clock jump is not pinned' }, () => {
  const s = setup('2026-10-28T23:30:00Z'); // 20:30 local
  s.scheduler.start();
  s.service.setActive(true, { source: 'manual', until: '2026-10-29T04:00:00.000Z' }); // 01:00 local
  s.time.jump('2026-10-29T11:00:00Z'); // 08:00 local
  assert.equal(s.service.active, false);
  s.scheduler.close(); s.service.close();
});

test('P8 D3: scheduled on/off unchanged: a window turns it on and off; an explicit off inside sets suppressedUntil = window end', () => {
  const s = setup('2026-10-28T23:00:00Z');
  s.scheduler.start();
  assert.equal(s.service.active, false);
  s.time.advance('2026-10-29T02:00:00Z');
  assert.deepEqual(pick(s.service.status()), { active: true, source: 'schedule', until: null });
  s.time.advance('2026-10-29T10:00:00Z');
  assert.equal(s.service.active, false);
  assert.deepEqual(s.heard.map(([a, , c]) => [a, c]), [[true, 'schedule'], [false, 'schedule']]);
  s.time.advance('2026-10-30T03:00:00Z');
  s.service.setActive(false, { source: 'manual' });
  assert.equal(s.schedulerState.at(-1)?.suppressedUntil, at('2026-10-30T10:00:00Z'));
  s.scheduler.close(); s.service.close();
});

async function budgetAt(file: string, s: ReturnType<typeof setup>, limit = 2) {
  return new CallBudget({ file, limits: () => ({ night: limit, improveDay: 5 }), nightOf: (since) => jornadaOf(SANTIAGO, nightly.end, since), now: s.time.now, uncapped: () => s.service.source === 'manual' });
}

test('P9 D2: manual uncapped with one passed notice per jornada; rollover while on at the window end resets the count and allows a second notice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verifier-budget-'));
  const s = setup('2026-10-28T15:00:00Z'); // 12:00 local, schedule enabled but no window now
  s.scheduler.start();
  const budget = await budgetAt(join(dir, 'budget.json'), s);
  const passed: Array<{ used: number; limit: number }> = [];
  budget.onPassed((e) => void passed.push(e));
  const refused: unknown[] = [];
  budget.onExhausted((e) => void refused.push(e));
  s.service.setActive(true, { source: 'manual' });
  budget.startNight(s.service.status().since!);
  assert.deepEqual([budget.take('decide'), budget.take('decide'), budget.take('decide'), budget.take('judge')], [true, true, true, true]);
  assert.deepEqual(passed, [{ used: 3, limit: 2 }], 'told once, at the first call past the limit');
  assert.equal(refused.length, 0);
  assert.equal(budget.night().used, 4);
  s.time.advance('2026-10-29T02:00:00Z'); // window start: manual on untouched
  assert.equal(s.service.source, 'manual');
  s.time.advance('2026-10-29T10:30:00Z'); // 07:30 local: past the jornada end, still on by hand
  assert.equal(s.service.active, true);
  assert.equal(budget.night().used, 0, 'rolled over at the jornada boundary while on');
  assert.deepEqual([budget.take('decide'), budget.take('decide'), budget.take('decide')], [true, true, true]);
  assert.equal(passed.length, 2, 'a second notice in the new jornada');
  await budget.flush();
  s.scheduler.close(); s.service.close();
  await rm(dir, { recursive: true, force: true });
});

test('P10 D2: a capped scheduled night taken over by hand becomes uncapped, counting what was used', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verifier-budget-'));
  const s = setup('2026-10-29T03:00:00Z'); // inside the window
  s.scheduler.start();
  const budget = await budgetAt(join(dir, 'budget.json'), s);
  const passed: unknown[] = [];
  budget.onPassed((e) => void passed.push(e));
  budget.startNight(s.service.status().since!);
  assert.deepEqual([budget.take('decide'), budget.take('decide'), budget.take('decide')], [true, true, false], 'scheduled night: capped as before');
  s.service.setActive(true, { source: 'manual' });
  assert.equal(budget.take('decide'), true, 'by hand: no cap');
  assert.equal(budget.night().used, 3);
  assert.equal(passed.length, 1);
  await budget.flush();
  s.scheduler.close(); s.service.close();
  await rm(dir, { recursive: true, force: true });
});

test('P11 D2: restart keeps the count (same jornada) and after a rollover while on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verifier-budget-'));
  const file = join(dir, 'budget.json');
  const s = setup('2026-10-28T20:00:00Z'); // 17:00 local
  const since = new Date(s.time.now()).toISOString();
  const budget = await budgetAt(file, s);
  s.service.setActive(true, { source: 'manual' });
  budget.startNight(since);
  assert.deepEqual([budget.take('decide'), budget.take('decide'), budget.take('decide')], [true, true, true]);
  await budget.flush();
  // Restart inside the same jornada: the resumed manual on re-activates with its saved since.
  const again = await budgetAt(file, s);
  again.startNight(since);
  assert.equal(again.night().used, 3, 'same jornada: count kept across a restart');
  // Rollover while on, then a restart in the new jornada.
  s.time.advance('2026-10-29T10:30:00Z'); // 07:30 local, new jornada
  assert.equal(again.take('decide'), true);
  assert.equal(again.night().used, 1, 'new jornada: 1 call so far');
  await again.flush();
  const third = await budgetAt(file, s);
  assert.equal(third.night().used, 1, 'loaded from disk');
  third.startNight(since); // the resumed manual on still carries its original since (yesterday's jornada)
  const afterRestart = third.night().used;
  assert.equal(afterRestart, 1, 'D2: a restart keeps the count');
  await third.flush();
  s.service.close();
  await rm(dir, { recursive: true, force: true });
});

test('P12 D2: an old budget.json (no `ended`, F2 keys) loads and keeps its count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verifier-budget-'));
  const file = join(dir, 'budget.json');
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ v: 1, night: { since: '2026-10-28T23:30:00.000Z', used: 7, announced: false }, translate: { day: '2026-10-28', used: 2, announced: false } }));
  const s = setup('2026-10-29T03:00:00Z');
  const budget = await budgetAt(file, s, 10);
  assert.deepEqual(budget.night(), { used: 7, limit: 10, since: '2026-10-28T23:30:00.000Z' });
  budget.startNight('2026-10-29T03:00:00.000Z');
  assert.equal(budget.night().used, 7, 'same jornada: the old count stays');
  await budget.flush();
  s.service.close();
  await rm(dir, { recursive: true, force: true });
});

/* ---------- The 23:00-09:00 plan of 2026-11-02 ---------- */

const overnight: NightSchedule = { ...nightly, end: '09:00' };

/** A Mirador start as the night routes do it: the saved manual on first, then the scheduler. */
async function boot(time: ReturnType<typeof clock>, store: ScheduleStore, available = true) {
  const s = setup('', { plan: overnight, time, store, available });
  await resumeManual({ store, service: s.service, available, now: time.now });
  s.scheduler.start();
  return s;
}

/** A Mirador stop: the scheduler first, then the service, then what they asked to save. */
async function shutdown(s: ReturnType<typeof setup>, store: ScheduleStore) {
  s.scheduler.close();
  s.service.close();
  await store.idle();
}

test('S1 regression: with a 23:00-09:00 plan a manual on (no until) made before 23:00 survives the window start, restarts inside the window (one without the night socket) and the 09:00 end, two nights; autopilot.json stays manual', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-overnight-'));
  try {
    const store = new ScheduleStore(dir);
    const time = clock('2026-10-29T21:00:00Z'); // 18:00 local (UTC-3)
    let s = await boot(time, store);
    s.service.setActive(true, { source: 'manual', cause: 'user' });
    const since = s.service.status().since;
    const stillManual = async (when: string) => {
      await store.idle();
      assert.deepEqual({ active: s.service.active, source: s.service.source, until: s.service.status().until, since: s.service.status().since }, { active: true, source: 'manual', until: null, since }, when);
      assert.deepEqual(await store.loadManual(), { since, until: null }, `autopilot.json, ${when}`);
    };
    await stillManual('turned on by hand');

    // Night 1: window start, a restart inside the window, the 09:00 end.
    time.advance('2026-10-30T02:00:30Z');
    await stillManual('night 1, 23:00');
    await shutdown(s, store);
    s = await boot(time, store);
    await stillManual('night 1, after a restart at 23:00');
    time.advance('2026-10-30T12:00:00.050Z');
    await stillManual('night 1, 09:00:00.05');

    // Night 2: a restart without the night socket, then one with it, both inside the window.
    time.advance('2026-10-31T02:00:30Z');
    await stillManual('night 2, 23:00');
    time.advance('2026-10-31T06:00:00Z');
    await shutdown(s, store);
    s = await boot(time, store, false);
    assert.equal(s.service.active, false, 'without the socket nothing runs');
    assert.deepEqual(await store.loadManual(), { since, until: null }, 'autopilot.json kept without the socket');
    time.advance('2026-10-31T06:30:00Z');
    await shutdown(s, store);
    s = await boot(time, store);
    await stillManual('night 2, after a restart with the socket back');
    time.advance('2026-10-31T12:00:00.050Z');
    await stillManual('night 2, 09:00:00.05');
    time.advance('2026-10-31T15:00:00Z');
    await stillManual('night 2, 12:00');

    const causes = (await store.activations()).reverse().map((c) => c.cause);
    assert.deepEqual(causes, ['user', 'shutdown', 'restart-resume', 'shutdown', 'restart-deferred', 'restart-resume']);
    await shutdown(s, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const order of ['scheduler-first', 'until-first'] as const) {
  test(`S1 rule: a manual until exactly at a window end is outside the window, ${order}: off at that instant as the user's, no handover, no suppression; the next window starts`, () => {
    const s = setup('2026-10-30T03:00:00Z', { plan: overnight }); // 00:00 local, inside the 23:00-09:00 window
    if (order === 'scheduler-first') s.scheduler.start();
    s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-10-30T12:00:00.000Z' }); // 09:00 local = the window end
    if (order === 'until-first') s.scheduler.start();
    s.time.advance('2026-10-30T11:59:59Z');
    assert.deepEqual(pick(s.service.status()), { active: true, source: 'manual', until: '2026-10-30T12:00:00.000Z' });
    s.time.advance('2026-10-30T12:00:00Z');
    assert.deepEqual(pick(s.service.status()), { active: false, source: null, until: null });
    assert.deepEqual(s.heard.at(-1)?.[2], 'manual', "the user's off: the neutral summary");
    assert.deepEqual([s.changes.at(-1)?.cause, s.changes.at(-1)?.from.source], ['until', 'manual']);
    assert.equal(s.changes.some((c) => c.cause === 'handover'), false);
    assert.equal(s.suppressed(), false);
    assert.equal(s.saved.at(-1), null);
    s.time.advance('2026-10-31T02:00:00Z');
    assert.deepEqual(pick(s.service.status()), { active: true, source: 'schedule', until: null }, 'the next window starts');
    s.scheduler.close(); s.service.close();
  });
}
