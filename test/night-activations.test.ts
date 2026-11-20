// The autopilot's activation log: every change of its state
// with the state before and after and its cause, kept in a bounded 0600 activations.jsonl, and the
// start that resumes, keeps or drops a saved manual on. The real service, scheduler and store on a
// fake clock; no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightService, type AutopilotChange, type NightLink } from '../src/night/service.ts';
import { NightScheduler, ScheduleStore, resumeManual, type NightSchedule } from '../src/night/schedule.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';

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

const SANTIAGO = 'America/Santiago';
const overnight: NightSchedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '09:00', remindBeforeMinutes: 0 };

function setup(startIso: string, link: NightLink | null = { send: () => false, isConnected: () => false, connectedTerminals: () => [] }) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 4096 });
  const time = clock(startIso);
  const service = new NightService({
    link,
    decider: { decide: async () => ({ action: 'defer', reason: 'x' }), followUp: async () => ({ action: 'defer', reason: 'x' }) },
    log: { append: async () => {} },
    terminals,
    workspaces: { get: () => undefined },
    now: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
  });
  const changes: AutopilotChange[] = [];
  service.onAutopilotChange((change) => void changes.push(change));
  const scheduler = new NightScheduler({ service, timeZone: SANTIAGO, schedule: overnight, now: time.now, setTimer: (fn, ms) => time.setTimer(fn, ms) });
  service.handOverTo(() => scheduler.covers());
  return { service, scheduler, time, changes };
}

const brief = (changes: AutopilotChange[]) => changes.map((c) => [c.cause, `${c.from.active ? c.from.source : 'off'}>${c.to.active ? c.to.source : 'off'}`, c.to.until]);

test('every change of the autopilot reaches onAutopilotChange with the state before and after and its cause', () => {
  const s = setup('2026-10-29T20:00:00Z'); // 17:00 local
  s.scheduler.start();
  s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-10-30T05:00:00.000Z' }); // until 02:00 local, inside the window
  s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-10-30T05:00:00.000Z' }); // the same: no change
  s.time.advance('2026-10-30T05:00:00Z'); // the until passes inside the window: handover
  s.time.advance('2026-10-30T12:00:00Z'); // 09:00 local: the window ends
  s.time.advance('2026-10-31T02:00:00Z'); // 23:00 local: the next window
  s.service.setActive(true, { source: 'manual', cause: 'user' }); // The user takes it over
  s.service.setActive(true, { source: 'manual', cause: 'user', until: '2026-10-31T23:00:00.000Z' }); // a new until
  s.time.advance('2026-10-31T23:00:00Z'); // outside any window: off as the user's
  assert.deepEqual(brief(s.changes), [
    ['user', 'off>manual', '2026-10-30T05:00:00.000Z'],
    ['handover', 'manual>schedule', null],
    ['window-end', 'schedule>off', null],
    ['window-start', 'off>schedule', null],
    ['user', 'schedule>manual', null],
    ['user', 'manual>manual', '2026-10-31T23:00:00.000Z'],
    ['until', 'manual>off', null],
  ]);
  assert.equal(s.changes[0].time, '2026-10-29T20:00:00.000Z');
  assert.deepEqual(s.changes[0].from, { active: false, source: null, until: null });
  assert.equal(s.changes[2].reason, 'the window 2026-10-30T02:00:00.000Z to 2026-10-30T12:00:00.000Z ended');
  assert.deepEqual(s.changes[5].from, { active: true, source: 'manual', until: null });
  s.scheduler.close(); s.service.close();
});

test('a shutdown while on is logged as shutdown; while off it logs nothing', () => {
  const s = setup('2026-10-29T20:00:00Z');
  s.service.setActive(true, { source: 'manual', cause: 'user' });
  s.service.close();
  assert.deepEqual(brief(s.changes), [['user', 'off>manual', null], ['shutdown', 'manual>off', null]]);
  const off = setup('2026-10-29T20:00:00Z');
  off.service.close();
  assert.deepEqual(off.changes, []);
});

test('without a cause, an on by hand is logged as user and one by the schedule as schedule (PUT /api/night, D6 delegation)', () => {
  const s = setup('2026-10-29T20:00:00Z');
  s.service.setActive(true);
  s.service.setActive(false);
  s.service.setActive(true, { source: 'schedule' });
  assert.deepEqual(s.changes.map((c) => c.cause), ['user', 'user', 'schedule']);
  s.service.close();
});

test('ScheduleStore keeps the activation log in a 0600 activations.jsonl, latest first, bounded, skipping broken lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-activations-'));
  try {
    const store = new ScheduleStore(dir, { maxActivations: 3 });
    assert.deepEqual(await store.activations(), [], 'no file: an empty log');
    const change = (n: number): AutopilotChange => ({ time: new Date(Date.UTC(2026, 10, 2, 12, n)).toISOString(), from: { active: false, source: null, until: null }, to: { active: true, source: 'manual', until: null }, cause: `c${n}` });
    for (const n of [1, 2, 3, 4]) await store.appendActivation(change(n));
    const file = join(dir, 'activations.jsonl');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await store.activations()).map((c) => c.cause), ['c4', 'c3', 'c2'], 'the latest 3 kept, latest first');
    assert.deepEqual((await store.activations(1)).map((c) => c.cause), ['c4']);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3);
    await writeFile(file, `${JSON.stringify(change(5))}\n{broken\n${JSON.stringify({ cause: 'no time' })}\n`);
    assert.deepEqual((await store.activations()).map((c) => c.cause), ['c5']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an old activations.jsonl line whose cause is the legacy owner value still loads, read as user; the file keeps its bytes and new lines say user (F5)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-activations-'));
  try {
    const store = new ScheduleStore(dir);
    const file = join(dir, 'activations.jsonl');
    const old = { time: '2026-11-01T02:00:00.000Z', from: { active: false, source: null, until: null }, to: { active: true, source: 'manual', until: null }, cause: LEGACY_USER_VALUES.cause };
    const oldOff = { time: '2026-11-01T03:00:00.000Z', from: { active: false, source: null, until: null }, to: { active: false, source: null, until: null }, cause: LEGACY_USER_VALUES.cause, reason: 'turned off while a manual on waited for the next start', saved: { since: '2026-11-01T02:00:00.000Z', until: null } };
    const oldLines = `${JSON.stringify(old)}\n${JSON.stringify(oldOff)}\n`;
    await writeFile(file, oldLines, { mode: 0o600 });
    assert.deepEqual(await store.activations(), [{ ...oldOff, cause: 'user' }, { ...old, cause: 'user' }], 'both old lines load, every other field as written');
    assert.equal(await readFile(file, 'utf8'), oldLines, 'reading never rewrites the file');
    const s = setup('2026-11-01T04:00:00Z');
    s.service.setActive(true);
    await store.appendActivation(s.changes[0]);
    s.service.close();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.deepEqual(lines.slice(0, 2), oldLines.trim().split('\n'), 'an append keeps the old lines byte for byte');
    assert.equal(JSON.parse(lines.at(-1)!).cause, 'user', 'a new on by hand is written as user');
    assert.deepEqual((await store.activations()).map((c) => c.cause), ['user', 'user', 'user']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a start resumes a saved manual on (restart-resume), keeps it without the night socket (restart-deferred) and drops one whose until passed (restart-dropped)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-activations-'));
  try {
    const store = new ScheduleStore(dir);
    const saved = { since: '2026-10-29T20:00:00.000Z', until: null };
    await store.saveManual(saved);

    const unavailable = setup('2026-11-01T06:00:00Z', null);
    unavailable.service.onAutopilotChange((change) => void store.appendActivation(change));
    await resumeManual({ store, service: unavailable.service, available: false, now: unavailable.time.now });
    assert.equal(unavailable.service.active, false);
    assert.deepEqual(await store.loadManual(), saved, 'kept for the next start');
    const [deferred] = await store.activations();
    assert.deepEqual({ ...deferred }, { time: '2026-11-01T06:00:00.000Z', from: { active: false, source: null, until: null }, to: { active: false, source: null, until: null }, cause: 'restart-deferred', reason: 'the night socket is not available; kept for the next start', saved });

    const available = setup('2026-11-01T07:00:00Z');
    available.service.onAutopilotChange((change) => void store.appendActivation(change));
    await resumeManual({ store, service: available.service, available: true, now: available.time.now });
    await store.idle();
    assert.deepEqual([available.service.source, available.service.status().since], ['manual', saved.since]);
    assert.deepEqual(brief(await store.activations(1)), [['restart-resume', 'off>manual', null]]);
    available.service.close();

    const passed = { since: '2026-10-29T20:00:00.000Z', until: '2026-11-01T07:30:00.000Z' };
    await store.saveManual(passed);
    const late = setup('2026-11-01T08:00:00Z');
    await resumeManual({ store, service: late.service, available: true, now: late.time.now });
    assert.equal(late.service.active, false);
    assert.equal(await store.loadManual(), null);
    const [dropped] = await store.activations(1);
    assert.deepEqual([dropped.cause, dropped.reason, dropped.saved], ['restart-dropped', 'its until passed while Mirador was stopped', passed]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
