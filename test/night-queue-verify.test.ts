// Verifier probes: own cases derived from the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, until, sleep, GIB, DELAY } from './helpers/night-queue-harness.ts';
import { suggestedSlots } from '../src/night/night-queue.ts';
import { taskText } from '../src/night/service.ts';
import { reserveFor } from '../src/system/memory-gate.ts';

const auto = (s: any, id: string) => s.records.find((r: any) => r.kind === 'auto-follow-up' && r.terminalId === id);

test('P9 N default on this machine: MemTotal 24509744 kB → 5', () => {
  assert.equal(suggestedSlots(24509744 * 1024), 5);
});

test('P2 FIFO: notes then the sweep follow-up; a waiting agent frees exactly one slot; two finishing at once start two', async () => {
  const s = await setup({ slots: 2 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'working');
    const c = s.agent('c', 'finished'), d = s.agent('d', 'finished'), e = s.agent('e', 'finished'), f = s.agent('f', 'finished');
    s.link.finish(f, '1000-1');
    for (const id of [c, d, e]) await s.note(id, `Go on with ${id}.`);
    s.service.setActive(true);
    await s.service.noteDelivery; await s.service.sweepDone;
    await until(() => s.queue()?.queued === 4);
    assert.deepEqual(s.items(), [[c, 'note'], [d, 'note'], [e, 'note'], [f, 'follow-up']]);
    assert.equal(s.queue().working, 2);
    s.attention.set(a, 'waiting');
    await until(() => s.received(c).length === 1);
    await sleep(40);
    assert.deepEqual([s.received(d).length, s.received(e).length], [0, 0], 'exactly one start for one freed slot');
    assert.deepEqual(s.items(), [[d, 'note'], [e, 'note'], [f, 'follow-up']]);
    assert.equal(s.queue().working, 2, 'b + the claim of c');
    s.attention.set(a, 'working');
    s.attention.set(c, 'working');
    await sleep(40);
    assert.equal(s.queue().working, 3, 'a back at work, b, c: over N by their own state, nothing more starts');
    assert.deepEqual([s.received(d).length, s.received(e).length], [0, 0]);
    s.attention.set(a, 'finished');
    s.attention.set(b, 'finished');
    await until(() => s.received(d).length === 1);
    await sleep(40);
    assert.equal(s.received(e).length, 0, 'c still works: two finishing at once with one other working free one slot');
    s.attention.set(c, 'waiting');
    await until(() => s.received(e).length === 1);
    await sleep(40);
    assert.deepEqual(s.items(), [[f, 'follow-up']]);
    assert.equal(s.followUps.length, 0, 'the queued follow-up asked the decider nothing yet');
    s.attention.set(d, 'working'); s.attention.set(e, 'working');
    await sleep(40);
    assert.equal(s.followUps.length, 0, 'd and e work: still full');
    s.attention.set(d, 'finished');
    await until(() => !!auto(s, f));
    assert.deepEqual([auto(s, f).outcome, auto(s, f).sent, auto(s, f).sweep], ['followed-up', 'message', true]);
    assert.match(s.received(f)[0], /Proceed with option A/);
    await until(async () => (await s.store.pending()).length === 0);
    assert.deepEqual((await s.store.list()).map((n: any) => n.deliveredTo), [[c], [d], [e]]);
  } finally { await s.cleanup(); }
});

test('P3 memory: one byte below the reserve waits, exactly the reserve starts; unreadable never blocks; unknown MemTotal uses the 2 GiB floor', async () => {
  const s = await setup({ slots: 5 });
  try {
    const c = s.agent('c', 'finished');
    await s.note(c, 'C.');
    const reserve = reserveFor({ reserveBytes: null }, 24 * GIB);
    s.memory.memAvailable = reserve - 1;
    s.service.setActive(true);
    await s.service.noteDelivery;
    await until(() => s.queue()?.memoryWait === true);
    await sleep(60);
    assert.deepEqual([s.received(c).length, s.queue().queued, s.queue().working], [0, 1, 0]);
    s.memory.memAvailable = reserve;
    await until(() => s.received(c).length === 1);
    assert.equal(s.queue().memoryWait, false);
    const d = s.agent('d', 'finished'), e = s.agent('e', 'finished');
    s.memory = Object.assign(s.memory, { memTotal: null, memAvailable: 2 * GIB - 1 });
    await s.note(d, 'D.');
    await s.service.deliverNotesNow();
    await until(() => s.queue()?.memoryWait === true);
    await sleep(60);
    assert.equal(s.received(d).length, 0, 'MemTotal unknown: the 2 GiB floor still holds');
    s.memory.memAvailable = 2 * GIB;
    await until(() => s.received(d).length === 1);
    s.memory.memAvailable = null;
    await s.note(e, 'E.');
    await s.service.deliverNotesNow();
    await until(() => s.received(e).length === 1);
    assert.equal(s.queue().memoryWait, false);
  } finally { await s.cleanup(); }
});

test('P4 autopilot off with a full queue: notes.json byte-identical, nothing sent while off, follow-up dropped, note delivered at the next on', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    s.link.finish(c, '1000-1');
    await s.note(b, 'For B.');
    s.service.setActive(true);
    await s.service.noteDelivery; await s.service.sweepDone;
    await until(() => s.queue()?.queued === 2);
    assert.deepEqual(s.items(), [[b, 'note'], [c, 'follow-up']]);
    const before = await s.notesHash();
    s.service.setActive(false);
    await sleep(20);
    assert.equal(await s.notesHash(), before, 'notes.json untouched by the off');
    assert.equal(s.queue(), undefined);
    assert.deepEqual(s.service.queueSummary()!.items, []);
    s.attention.set(a, 'finished');
    await sleep(DELAY * 3);
    assert.deepEqual([s.received(b), s.followUps.length, s.records.filter((r: any) => r.kind === 'auto-follow-up').length], [[], 0, 0]);
    assert.deepEqual((await s.store.pending()).map((n: any) => [n.terminalId, n.deliveredAt]), [[b, undefined]]);
    s.service.setActive(true);
    await until(() => s.received(b).length === 1);
    assert.equal(s.queue().working, 1, 'b holds its slot by claim');
    s.attention.set(b, 'working');
    s.attention.set(b, 'finished');
    await until(() => !!auto(s, c));
    assert.equal(auto(s, c).sweep, true, "c's sweep follow-up came back with the new night");
  } finally { await s.cleanup(); }
});

test('P5 closed while queued; N raised while full starts the waiting ones; N lowered holds until fewer than N work', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished'), d = s.agent('d', 'finished');
    for (const id of [b, c, d]) await s.note(id, `For ${id}.`);
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 3);
    s.terminals.close(b);
    s.service.disconnected(b);
    assert.deepEqual(s.items(), [[c, 'note'], [d, 'note']]);
    await until(async () => (await s.store.pending()).find((n: any) => n.terminalId === b)?.pendingReason === 'the terminal is closed');
    s.limits.slots = 3;
    s.service.queueChanged();
    await until(() => s.received(c).length === 1 && s.received(d).length === 1);
    assert.deepEqual([s.queue().working, s.queue().queued, s.queue().slots], [3, 0, 3]);
    s.limits.slots = 1;
    s.service.queueChanged();
    const e = s.agent('e', 'finished');
    await s.note(e, 'For E.');
    await s.service.deliverNotesNow();
    assert.deepEqual(s.items(), [[e, 'note']]);
    s.attention.set(c, 'working'); s.attention.set(d, 'working');
    s.attention.set(a, 'finished');
    s.attention.set(c, 'finished');
    await sleep(40);
    assert.equal(s.received(e).length, 0, 'd still works and N is 1');
    s.attention.set(d, 'waiting');
    await until(() => s.received(e).length === 1);
  } finally { await s.cleanup(); }
});

test('P6a a workspace note across the queue with a restart in the middle: never lost, never marked delivered early; the reached agents get it again after the restart', async () => {
  const s = await setup({ slots: 1 });
  let base = s.base;
  let note: any;
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    note = await s.note(undefined, 'Everyone: run the tests.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    assert.equal(s.received(a).length, 1);
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    s.attention.set(b, 'working');
    await s.service.noteDelivery; await sleep(40);
    assert.equal((await s.store.pending()).length, 1, 'still pending: c has not got it');
    assert.deepEqual(s.items(), [[c, 'note']]);
  } finally { await s.cleanup(true); }
  const s2 = await setup({ slots: 1, base });
  try {
    assert.equal((await s2.store.pending()).length, 1, 'the note survived the restart');
    const a2 = s2.agent('a', 'working'), b2 = s2.agent('b', 'working'), c2 = s2.agent('c', 'finished');
    s2.service.setActive(true);
    await s2.service.noteDelivery;
    assert.deepEqual([s2.received(a2).length, s2.received(b2).length, s2.received(c2).length], [1, 1, 0], 'RESEND to a and b (the reached set lived in memory)');
    assert.deepEqual(s2.items(), [[c2, 'note']]);
    s2.attention.set(a2, 'finished'); s2.attention.set(b2, 'finished');
    await until(() => s2.received(c2).length === 1);
    await until(async () => (await s2.store.pending()).length === 0);
    const stored = (await s2.store.list()).find((n: any) => n.id === note.id)!;
    assert.deepEqual(stored.deliveredTo, [a2, b2, c2]);
  } finally { await s2.cleanup(); }
});

test('P6b a queued note whose bridge left before its turn is not lost and goes out when asked again', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished');
    const note = await s.note(b, 'For B.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 1);
    s.link.connected.delete(b);
    s.service.disconnected(b);
    s.attention.set(a, 'finished');
    await sleep(60);
    assert.deepEqual([s.received(b), s.queue().queued, s.queue().working], [[], 0, 0], 'granted, nothing went out, slot free again');
    const pending = await s.store.pending();
    assert.deepEqual(pending.map((n: any) => [n.id, n.deliveredAt]), [[note.id, undefined]]);
    s.link.connected.add(b);
    await s.service.deliverNotesNow();
    await until(() => s.received(b).length === 1);
    await until(async () => (await s.store.pending()).length === 0);
  } finally { await s.cleanup(); }
});

test('P7 never queued while full (a working fills N=1; under A2 an unknown agent would not): delegated task, Delegar, a question; typing drops a queued follow-up', async () => {
  const s = await setup({ slots: 1 });
  try {
    s.agent('a', 'working');
    const b = s.agent('b', 'finished'), c = s.agent('c', 'working');
    s.link.finish(b, '1000-1');
    s.service.setActive(true);
    await s.service.noteDelivery; await s.service.sweepDone;
    await until(() => s.queue()?.queued === 1, 500).catch(() => {});
    assert.deepEqual(s.items(), [[b, 'follow-up']], "b's sweep follow-up waits: a and c work, N is 1");
    const sent = await s.service.sendNote(b, 'Ship N3.', '', taskText);
    assert.deepEqual([sent.sent, s.received(b).length], [true, 1]);
    const delegated = s.service.delegate(b)!;
    await delegated.done;
    assert.equal(s.followUps.length, 1);
    await s.service.question(b, 'q-1', { terminalId: b, toolCallId: 'call-1', tool: 'ask_user_choice', allowCustomResponse: false, items: [{ question: 'Which runner?', header: 'Runner', options: [{ label: 'node:test', description: '' }, { label: 'vitest', description: '' }], multiSelect: false }] } as any);
    assert.equal(s.decisions.length, 1);
    s.attention.set(c, 'finished');
    s.link.finish(c, '1000-1');
    await until(() => s.queue()?.queued === 2);
    s.terminals.write(c, 'ok\r');
    assert.deepEqual(s.items(), [[b, 'follow-up']]);
  } finally { await s.cleanup(); }
});

test('P10 (A2) agents that never reported anything hold no slot: their notes wait in the queue like a finished agent', async () => {
  const s = await setup({ slots: 2 });
  try {
    const a = s.agent('a', 'working'); s.agent('b', 'working');
    const c = s.agent('c', 'unknown'), d = s.agent('d', 'unknown'), e = s.agent('e', 'unknown');
    for (const id of [c, d, e]) await s.note(id, `For ${id}.`);
    s.service.setActive(true);
    await s.service.noteDelivery;
    await sleep(40);
    assert.deepEqual([s.received(c).length, s.received(d).length, s.received(e).length], [0, 0, 0]);
    assert.deepEqual([s.queue().working, s.queue().slots, s.queue().queued], [2, 2, 3]);
    assert.deepEqual(s.items(), [[c, 'note'], [d, 'note'], [e, 'note']]);
    s.attention.set(a, 'finished');
    await until(() => s.received(c).length === 1);
    await sleep(40);
    assert.deepEqual([s.received(d).length, s.received(e).length, s.queue().working], [0, 0, 2], 'one freed slot, one start');
  } finally { await s.cleanup(); }
});

test('P11 race: the agent reports working during the delivery, before the claim is timed; no double count, the slot frees on its finish', async () => {
  let attention: any;
  const s = await setup({ slots: 1, deliveryTimeoutMs: 200, onSend: (id, line) => { if (line.type === 'message') { attention.set(id, 'working'); } } });
  attention = s.attention;
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    await s.note(b, 'B.'); await s.note(c, 'C.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    await sleep(250);
    assert.deepEqual([s.received(c).length, s.queue().working, s.queue().queued], [0, 1, 1]);
    s.attention.set(b, 'finished');
    await until(() => s.received(c).length === 1);
  } finally { await s.cleanup(); }
});

test('P12 a note removed while its terminal is queued: the entry stays until granted, then nothing goes out and the next one starts', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    const nb = await s.note(b, 'For B.'); await s.note(c, 'For C.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    await s.store.remove(nb.id);
    assert.deepEqual(s.items(), [[b, 'note'], [c, 'note']], 'stale entry for b remains (advisory)');
    s.attention.set(a, 'finished');
    await until(() => s.received(c).length === 1);
    assert.deepEqual([s.received(b), s.queue().queued], [[], 0]);
  } finally { await s.cleanup(); }
});

test('P13 a workspace note partially delivered, off then on without a restart: the reached agent does not get it twice', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    await s.note(undefined, 'Everyone.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    assert.equal(s.received(a).length, 1);
    await s.service.noteDelivery; await sleep(40);
    s.service.setActive(false);
    await sleep(20);
    assert.equal((await s.store.pending()).length, 1);
    s.service.setActive(true);
    await s.service.noteDelivery;
    await until(() => s.queue()?.queued === 2);
    assert.equal(s.received(a).length, 1, 'not resent');
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    s.attention.set(b, 'working');
    s.attention.set(b, 'finished');
    await until(() => s.received(c).length === 1);
    await until(async () => (await s.store.pending()).length === 0);
    assert.deepEqual((await s.store.list())[0].deliveredTo, [a, b, c]);
  } finally { await s.cleanup(); }
});

test('P13b (A3) a granted agent that reports the end of its turn without a working in between frees its claim at once: the next one starts', async () => {
  const s = await setup({ slots: 1, claimMs: 5000 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    await s.note(b, 'B.'); await s.note(c, 'C.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    await sleep(40);
    assert.deepEqual([s.received(c).length, s.queue().working], [0, 1], "b's claim holds the only slot while its turn runs");
    // The bridge's finished line for b's new turn; the attention state stays finished (no state change event).
    s.link.finish(b, '1000-2');
    s.attention.set(b, 'finished');
    await until(() => s.received(c).length === 1, 1000);
    assert.equal(s.queue().working, 1, "c's claim now holds the slot");
  } finally { await s.cleanup(); }
});

test('P14 two notes for one queued terminal: one entry, both out in order when granted, each with its record and delivered mark', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished');
    await s.note(b, 'First for B.'); await s.note(b, 'Second for B.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 1);
    s.attention.set(a, 'waiting');
    await until(() => s.received(b).length === 2);
    assert.match(s.received(b)[0], /First for B/); assert.match(s.received(b)[1], /Second for B/);
    await until(async () => (await s.store.pending()).length === 0);
    assert.deepEqual((await s.store.list()).map((n: any) => n.deliveredTo), [[b], [b]]);
    assert.equal(s.records.filter((r: any) => r.kind === 'note').length, 2);
  } finally { await s.cleanup(); }
});

test('P15 a timer follow-up while full waits (decider not asked) and runs when a slot frees; the agent reporting working ends its claim', async () => {
  const s = await setup({ slots: 1 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'working');
    s.service.setActive(true);
    s.attention.set(b, 'finished');
    s.link.finish(b, '1000-1');
    await until(() => s.queue()?.queued === 1);
    await sleep(DELAY * 2);
    assert.equal(s.followUps.length, 0);
    s.attention.set(a, 'waiting');
    await until(() => !!auto(s, b));
    assert.deepEqual([auto(s, b).sent, auto(s, b).sweep ?? null, s.queue().working], ['message', null, 1]);
    s.attention.set(b, 'working');
    assert.equal(s.queue().working, 1);
    s.attention.set(b, 'waiting');
    assert.equal(s.queue().working, 0, 'claim ended when it reported working; waiting frees it');
  } finally { await s.cleanup(); }
});

test('P6c BLOCKER repro: autopilot off while a workspace note delivery is in flight marks it delivered; the queued agents never get it', async () => {
  const s = await setup({ slots: 1, deliveryTimeoutMs: 300 });
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    const note = await s.note(undefined, 'Everyone: run the tests.');
    s.service.setActive(true);
    await until(() => s.received(a).length === 1 && s.queue()?.queued === 2);
    s.service.setActive(false);
    await s.service.noteDelivery; await sleep(50);
    const stored = (await s.store.list()).find((n: any) => n.id === note.id)!;
    assert.deepEqual([s.received(b).length, s.received(c).length], [0, 0]);
    assert.equal(stored.deliveredAt, undefined, `marked delivered to ${JSON.stringify(stored.deliveredTo)} while b and c never got it`);
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2, 500);
    assert.equal(s.received(a).length, 1, 'a already got it in this process: not resent');
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    s.attention.set(b, 'finished');
    s.link.finish(b, '1000-2');
    await until(() => s.received(c).length === 1);
    await until(async () => (await s.store.pending()).length === 0);
    assert.deepEqual((await s.store.list()).find((n: any) => n.id === note.id)!.deliveredTo, [a, b, c]);
  } finally { await s.cleanup(); }
});

test('P6d BLOCKER repro: service close (shutdown) while a granted note delivery is in flight marks the workspace note delivered without the queued agent', async () => {
  const s = await setup({ slots: 1, deliveryTimeoutMs: 300 });
  const base = s.base;
  let note: any;
  try {
    const a = s.agent('a', 'working'), b = s.agent('b', 'finished'), c = s.agent('c', 'finished');
    note = await s.note(undefined, 'Everyone: run the tests.');
    s.service.setActive(true);
    await until(() => s.queue()?.queued === 2);
    await s.service.noteDelivery; await sleep(20);
    s.attention.set(a, 'finished');
    await until(() => s.received(b).length === 1);
    assert.equal(s.received(c).length, 0);
  } finally { await s.cleanup(true); }
  const s2 = await setup({ slots: 1, base });
  try {
    const stored = (await s2.store.list()).find((n: any) => n.id === note.id)!;
    assert.equal(stored.deliveredAt, undefined, `marked delivered to ${JSON.stringify(stored.deliveredTo)} after the shutdown; c never got it`);
  } finally { await s2.cleanup(); }
});
