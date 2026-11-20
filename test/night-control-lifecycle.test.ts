// Verifier probes: the autopilot's on/off lifecycle
// with a 23:00-09:00 plan in America/Santiago on a fake clock, the real service, scheduler and
// ScheduleStore (autopilot.json, scheduler.json, activations.jsonl) in a temp dir. No model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightService, type AutopilotChange, type AutopilotSource, type NightLink } from '../src/night/service.ts';
import { MAX_ACTIVATIONS, NightScheduler, ScheduleStore, resumeManual, type NightSchedule } from '../src/night/schedule.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

class FakePty implements PtyProcess { onData() {} onExit() {} write() {} resize() {} kill() {} }
const at = (iso: string) => Date.parse(iso);

function clock(startIso: string) {
  let now = at(startIso);
  const timers = new Set<{ fn: () => void; due: number }>();
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      const entry = { fn, due: now + ms };
      timers.add(entry);
      return () => void timers.delete(entry);
    },
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
  };
}
type Clock = ReturnType<typeof clock>;

const SANTIAGO = 'America/Santiago'; // UTC-3 in November: 23:00 local = 02:00Z next day, 09:00 local = 12:00Z
const overnight: NightSchedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '09:00', remindBeforeMinutes: 0 };

/** Wired like src/http/routes/night.ts: the store gets the manual on, the scheduler state and the activation log. */
function setup(time: Clock, store: ScheduleStore, available: boolean, state: { suppressedUntil?: number; remindedFor?: number }) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 4096 });
  const link: NightLink | null = available ? { send: () => false, isConnected: () => false, connectedTerminals: () => [] } : null;
  const heard: Array<[boolean, AutopilotSource | undefined]> = [];
  const changes: AutopilotChange[] = [];
  const service = new NightService({
    link,
    decider: { decide: async () => ({ action: 'defer', reason: 'x' }), followUp: async () => ({ action: 'defer', reason: 'x' }) },
    log: { append: async () => {} },
    terminals,
    workspaces: { get: () => undefined },
    now: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
    saveManual: (manual) => store.saveManual(manual),
  });
  service.onActiveChange((active, _since, cause) => void heard.push([active, cause]));
  service.onAutopilotChange((change) => {
    changes.push(change);
    void store.appendActivation(change);
  });
  const scheduler = new NightScheduler({ service, timeZone: SANTIAGO, schedule: overnight, state, saveState: (s) => store.saveState(s), available: () => available, now: time.now, setTimer: (fn, ms) => time.setTimer(fn, ms) });
  service.handOverTo(() => scheduler.covers());
  return { service, scheduler, heard, changes };
}
type Mirador = ReturnType<typeof setup>;

/** A start as the routes do it: saved manual on first (resumeManual), then the scheduler. */
async function boot(time: Clock, store: ScheduleStore, available = true): Promise<Mirador> {
  const saved = await store.load();
  const s = setup(time, store, available, saved.state);
  await resumeManual({ store, service: s.service, available, now: time.now });
  s.scheduler.start();
  return s;
}
/** A stop as the shutdown hooks run: scheduler, then service, then the pending writes. */
async function shutdown(s: Mirador, store: ScheduleStore): Promise<void> {
  s.scheduler.close();
  s.service.close();
  await store.idle();
}
// `since` only while on: the service keeps the last activation's since after an off (baseline behaviour).
const pick = (s: Mirador) => ({ active: s.service.active, source: s.service.source, until: s.service.status().until, since: s.service.active ? s.service.status().since : null });
const causes = async (store: ScheduleStore) => (await store.activations()).reverse().map((c) => c.cause);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const manualText = (dir: string) => readFile(join(dir, 'autopilot.json'), 'utf8');

async function scratch<T>(run: (dir: string, store: ScheduleStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-verifier-'));
  const store = new ScheduleStore(dir);
  try {
    return await run(dir, store);
  } finally {
    await store.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test('V1 S1: a manual on without until survives window start, window end, two nights, restarts inside and outside the window and a start without the socket followed by one with it; autopilot.json stays byte-identical', () =>
  scratch(async (dir, store) => {
    const time = clock('2026-11-02T20:00:00Z'); // 17:00 local, Monday
    let s = await boot(time, store);
    s.service.setActive(true, { source: 'manual', cause: 'user' });
    await store.idle();
    const since = s.service.status().since;
    const expected = { active: true, source: 'manual', until: null, since };
    const bytes = sha(await manualText(dir));
    assert.deepEqual(JSON.parse(await manualText(dir)), { manual: { since, until: null } });
    const still = async (when: string) => {
      await store.idle();
      assert.deepEqual(pick(s), expected, when);
      assert.equal(sha(await manualText(dir)), bytes, `autopilot.json unchanged, ${when}`);
      assert.equal((await store.load()).state.suppressedUntil, undefined, `no suppression, ${when}`);
    };
    // Night 1
    time.advance('2026-11-03T02:00:00Z'); await still('night 1 window start 23:00');
    time.advance('2026-11-03T03:00:00Z');
    await shutdown(s, store); s = await boot(time, store); await still('night 1 restart inside the window');
    time.advance('2026-11-03T12:00:00Z'); await still('night 1 window end 09:00');
    time.advance('2026-11-03T13:00:00Z');
    await shutdown(s, store); s = await boot(time, store); await still('day restart outside the window');
    // Night 2
    time.advance('2026-11-04T02:00:00Z'); await still('night 2 window start');
    time.advance('2026-11-04T05:00:00Z');
    await shutdown(s, store);
    s = await boot(time, store, false);
    await store.idle();
    assert.deepEqual(pick(s), { active: false, source: null, until: null, since: null }, 'without the socket nothing runs');
    assert.equal(sha(await manualText(dir)), bytes, 'autopilot.json kept by the start without the socket');
    time.advance('2026-11-04T06:00:00Z');
    await shutdown(s, store);
    assert.equal(sha(await manualText(dir)), bytes, 'autopilot.json kept by the shutdown without the socket');
    s = await boot(time, store); await still('night 2 restart with the socket back, inside the window');
    time.advance('2026-11-04T12:00:00Z'); await still('night 2 window end');
    time.advance('2026-11-04T15:00:00Z'); await still('day 3 noon');
    assert.deepEqual(await causes(store), ['user', 'shutdown', 'restart-resume', 'shutdown', 'restart-resume', 'shutdown', 'restart-deferred', 'restart-resume']);
    const deferred = (await store.activations()).find((c) => c.cause === 'restart-deferred')!;
    assert.deepEqual(deferred.saved, { since, until: null });
    await shutdown(s, store);
  }));

test('V2 S1: the user off before 23:00, then the window turns it on as schedule and the 09:00 end turns it off: causes user, user, window-start, window-end', () =>
  scratch(async (dir, store) => {
    const time = clock('2026-11-02T20:00:00Z');
    const s = await boot(time, store);
    s.service.setActive(true, { source: 'manual', cause: 'user' });
    time.advance('2026-11-03T01:00:00Z'); // 22:00 local
    s.service.setActive(false, { source: 'manual', cause: 'user' });
    await store.idle();
    assert.deepEqual(JSON.parse(await manualText(dir)), { manual: null });
    time.advance('2026-11-03T02:00:00Z');
    assert.deepEqual(pick(s), { active: true, source: 'schedule', until: null, since: '2026-11-03T02:00:00.000Z' });
    time.advance('2026-11-03T12:00:00Z');
    assert.deepEqual(pick(s), { active: false, source: null, until: null, since: null });
    await store.idle();
    const log = (await store.activations()).reverse();
    assert.deepEqual(log.map((c) => [c.cause, c.from.source, c.to.source, c.time]), [
      ['user', null, 'manual', '2026-11-02T20:00:00.000Z'],
      ['user', 'manual', null, '2026-11-03T01:00:00.000Z'],
      ['window-start', null, 'schedule', '2026-11-03T02:00:00.000Z'],
      ['window-end', 'schedule', null, '2026-11-03T12:00:00.000Z'],
    ]);
    assert.equal((await store.load()).state.suppressedUntil, undefined, 'an off outside the window suppresses nothing');
    await shutdown(s, store);
  }));

test('V3a S1/D3a: a manual until inside the window hands over (cause handover, autopilot.json cleared) and the window end turns it off', () =>
  scratch(async (dir, store) => {
    const time = clock('2026-11-02T23:00:00Z'); // 20:00 local
    const s = await boot(time, store);
    s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-11-03T05:00:00.000Z' }); // 02:00 local
    await store.idle();
    assert.deepEqual(JSON.parse(await manualText(dir)), { manual: { since: '2026-11-02T23:00:00.000Z', until: '2026-11-03T05:00:00.000Z' } });
    time.advance('2026-11-03T02:00:00Z');
    assert.deepEqual(pick(s), { active: true, source: 'manual', until: '2026-11-03T05:00:00.000Z', since: '2026-11-02T23:00:00.000Z' }, 'the window start does not take it');
    time.advance('2026-11-03T05:00:00Z');
    assert.deepEqual(pick(s), { active: true, source: 'schedule', until: null, since: '2026-11-02T23:00:00.000Z' }, 'handed over: same activation');
    await store.idle();
    assert.deepEqual(JSON.parse(await manualText(dir)), { manual: null });
    time.advance('2026-11-03T12:00:00Z');
    assert.deepEqual(pick(s), { active: false, source: null, until: null, since: null });
    assert.deepEqual(await causes(store), ['user', 'handover', 'window-end']);
    assert.deepEqual(s.heard.map((h) => h[1]), ['manual', 'schedule'], 'no activeChange event for the handover');
    await shutdown(s, store);
  }));

test('V3b S1 boundary: an until one millisecond before the window end still hands over', () =>
  scratch(async (dir, store) => {
    const time = clock('2026-11-02T23:00:00Z');
    const s = await boot(time, store);
    s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-11-03T11:59:59.999Z' });
    time.advance('2026-11-03T11:59:59.999Z');
    assert.deepEqual(pick(s).source, 'schedule');
    time.advance('2026-11-03T12:00:00.000Z');
    assert.equal(s.service.active, false);
    assert.deepEqual(await causes(store), ['user', 'handover', 'window-end']);
    await shutdown(s, store);
  }));

for (const order of ['scheduler-first', 'until-first'] as const) {
  test(`V3c S1 rule (b), ${order}: an until exactly at the window end turns the autopilot off at that instant as the user's off, without handover or suppression, and the next window starts`, () =>
    scratch(async (dir, store) => {
      const time = clock('2026-11-02T23:00:00Z');
      const s = await boot(time, store);
      s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-11-03T12:00:00.000Z' });
      time.advance('2026-11-03T11:30:00Z');
      // Both timers re-arm hourly; the one armed last fires last at the same instant.
      if (order === 'scheduler-first') s.scheduler.update(overnight); // re-arms the scheduler's timer after the until timer
      if (order === 'until-first') s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-11-03T12:00:00.000Z' }); // re-arms the until timer after the scheduler's
      await store.idle();
      const bytes = sha(await manualText(dir));
      time.advance('2026-11-03T11:59:59.999Z');
      assert.deepEqual(pick(s), { active: true, source: 'manual', until: '2026-11-03T12:00:00.000Z', since: '2026-11-02T23:00:00.000Z' });
      assert.equal(sha(await manualText(dir)), bytes);
      time.advance('2026-11-03T12:00:00.000Z');
      assert.deepEqual(pick(s), { active: false, source: null, until: null, since: null }, 'off at the window end');
      assert.deepEqual(s.heard.at(-1), [false, 'manual'], "the user's off (the neutral summary)");
      await store.idle();
      const log = (await store.activations()).reverse();
      assert.deepEqual(log.map((c) => [c.cause, c.from.source, c.to.source]), [['user', null, 'manual'], ['until', 'manual', null]]);
      assert.equal(log[1].time, '2026-11-03T12:00:00.000Z');
      assert.deepEqual(JSON.parse(await manualText(dir)), { manual: null });
      assert.equal((await store.load()).state.suppressedUntil, undefined, 'no suppression: the end is outside the window');
      time.advance('2026-11-04T02:00:00Z');
      assert.deepEqual(pick(s), { active: true, source: 'schedule', until: null, since: '2026-11-04T02:00:00.000Z' }, 'the next window starts');
      await shutdown(s, store);
    }));
}

test('V5 S1: a shutdown while on logs shutdown and keeps autopilot.json; the next start resumes; a saved until that passed while stopped is dropped (restart-dropped) and autopilot.json is cleared', () =>
  scratch(async (dir, store) => {
    const time = clock('2026-11-02T20:00:00Z');
    let s = await boot(time, store);
    s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-11-02T22:00:00.000Z' });
    await store.idle();
    const bytes = sha(await manualText(dir));
    await shutdown(s, store);
    assert.equal(sha(await manualText(dir)), bytes, 'shutdown keeps the saved manual on');
    assert.deepEqual((await store.activations(1))[0].cause, 'shutdown');
    time.advance('2026-11-02T21:00:00Z');
    s = await boot(time, store);
    assert.deepEqual(pick(s), { active: true, source: 'manual', until: '2026-11-02T22:00:00.000Z', since: '2026-11-02T20:00:00.000Z' });
    assert.deepEqual((await store.activations(1))[0].cause, 'restart-resume');
    await shutdown(s, store);
    time.advance('2026-11-02T23:00:00Z'); // the until passed while stopped
    s = await boot(time, store);
    assert.deepEqual(pick(s), { active: false, source: null, until: null, since: null });
    assert.deepEqual(JSON.parse(await manualText(dir)), { manual: null });
    const [dropped] = await store.activations(1);
    assert.deepEqual([dropped.cause, dropped.saved, dropped.time], ['restart-dropped', { since: '2026-11-02T20:00:00.000Z', until: '2026-11-02T22:00:00.000Z' }, '2026-11-02T23:00:00.000Z']);
    assert.deepEqual(await causes(store), ['user', 'shutdown', 'restart-resume', 'shutdown', 'restart-dropped']);
    await shutdown(s, store);
  }));

test('V5b: a start inside a window with a saved manual on whose until passed turns on as schedule after restart-dropped, never as manual', () =>
  scratch(async (dir, store) => {
    await store.saveManual({ since: '2026-11-02T20:00:00.000Z', until: '2026-11-03T01:00:00.000Z' });
    const time = clock('2026-11-03T03:00:00Z'); // 00:00 local, inside the window
    const s = await boot(time, store);
    assert.deepEqual(pick(s), { active: true, source: 'schedule', until: null, since: '2026-11-03T03:00:00.000Z' });
    assert.deepEqual(await causes(store), ['restart-dropped', 'window-start']);
    assert.deepEqual(JSON.parse(await manualText(dir)), { manual: null });
    await shutdown(s, store);
  }));

test('V6 S1: activations.jsonl is 0600, keeps at most MAX_ACTIVATIONS lines (the oldest dropped), and lists latest first with the default limit', () =>
  scratch(async (dir, store) => {
    const change = (n: number): AutopilotChange => ({ time: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(), from: { active: false, source: null, until: null }, to: { active: true, source: 'manual', until: null }, cause: `c${n}` });
    for (let n = 1; n <= MAX_ACTIVATIONS + 5; n++) await store.appendActivation(change(n));
    const file = join(dir, 'activations.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, MAX_ACTIVATIONS);
    assert.equal(JSON.parse(lines[0]).cause, 'c6', 'the oldest 5 dropped');
    assert.equal(JSON.parse(lines.at(-1)!).cause, `c${MAX_ACTIVATIONS + 5}`);
    const all = await store.activations();
    assert.equal(all.length, MAX_ACTIVATIONS);
    assert.deepEqual([all[0].cause, all.at(-1)!.cause], [`c${MAX_ACTIVATIONS + 5}`, 'c6']);
    assert.deepEqual((await store.activations(2)).map((c) => c.cause), [`c${MAX_ACTIVATIONS + 5}`, `c${MAX_ACTIVATIONS + 4}`]);
  }));

test('V2b D3 regression: the user off inside the window logs user, suppresses the rest of that window and the next window starts as usual', () =>
  scratch(async (dir, store) => {
    const time = clock('2026-11-03T03:00:00Z'); // 00:00 local, inside the window: the schedule turns it on
    const s = await boot(time, store);
    assert.deepEqual(pick(s).source, 'schedule');
    time.advance('2026-11-03T03:30:00Z');
    s.service.setActive(false, { source: 'manual', cause: 'user' });
    await store.idle();
    assert.equal((await store.load()).state.suppressedUntil, at('2026-11-03T12:00:00Z'));
    time.advance('2026-11-03T04:00:00Z');
    assert.equal(s.service.active, false, 'stays off for the rest of the window');
    time.advance('2026-11-04T02:00:00Z');
    assert.deepEqual(pick(s), { active: true, source: 'schedule', until: null, since: '2026-11-04T02:00:00.000Z' });
    assert.deepEqual(await causes(store), ['window-start', 'user', 'window-start']);
    await shutdown(s, store);
  }));
