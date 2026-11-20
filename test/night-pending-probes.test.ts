// Regression probes for the autopilot pending list, from
// the independent verifier: one automatic follow-up card per agent, typing clears that agent's
// cards whatever the async order, and the existing pending-list invariants still hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, until, sleep, DELAY, BLOCK_UNTIL_ABORT } from './helpers/night-pending-fixture.ts';
import type { NightFollowUp } from '../src/night/protocol.ts';

test('P1 S6(1): two deferrals in a row of the same agent → one card, the latest; after typing a third lists again, alone', async () => {
  const s = setup(); const a = s.agent('alpha'); s.service.setActive(true);
  s.finish(a, '1-1'); await until(() => s.records.length === 1);
  s.finish(a, '1-2'); await until(() => s.records.length === 2);
  assert.deepEqual(s.pending().map((i) => [i.terminalId, i.id, i.kind]), [[a, s.records[1].id, 'auto-follow-up']]);
  assert.deepEqual(s.service.reminder().pending.map((i) => i.id), [s.records[1].id]);
  s.type(a); s.finish(a, '1-3'); await until(() => s.records.length === 3);
  assert.deepEqual(s.pending().map((i) => i.id), [s.records[2].id]);
});

test('P2 S6(1): two agents keep one card each, ordered by their latest deferral', async () => {
  const s = setup(); const a = s.agent('alpha'); const b = s.agent('beta'); s.service.setActive(true);
  s.finish(a, '1-1'); await until(() => s.records.length === 1);
  s.finish(b, '2-1'); await until(() => s.records.length === 2);
  s.finish(a, '1-2'); await until(() => s.records.length === 3);
  assert.deepEqual(s.pending().map((i) => [i.terminalId, i.id]), [[b, s.records[1].id], [a, s.records[2].id]]);
});

test('P3 S6(2): typing removes only that agent auto cards; its question and delegate cards and other agents stay', async () => {
  const s = setup(); const a = s.agent('alpha'); const b = s.agent('beta'); s.service.setActive(true);
  s.finish(a, '1-1'); s.finish(b, '2-1'); await until(() => s.records.length === 2);
  await s.ask(a, 'Shall we continue with B?');
  const d = s.service.delegate(a); assert.ok(d); await d!.done;
  assert.deepEqual(s.pending().map((i) => [i.terminalId, i.kind]), [[a, 'auto-follow-up'], [b, 'auto-follow-up'], [a, 'question'], [a, 'delegate']]);
  s.type(a);
  assert.deepEqual(s.pending().map((i) => [i.terminalId, i.kind]), [[b, 'auto-follow-up'], [a, 'question'], [a, 'delegate']]);
  s.type(a, 'x'); // typing again is idempotent
  assert.equal(s.pending().length, 3);
  s.type(b, '\x1b[I'); s.type(b, '\x1b[?1;2c'); // terminal replies are not typing
  assert.equal(s.pending().filter((i) => i.terminalId === b).length, 1);
  assert.equal(s.records.length, 4, 'every record logged');
});

test('P4a drop path: typing before keep → logged, not listed; typing after keep → unlisted', async () => {
  { const s = setup(); s.box.followUp = BLOCK_UNTIL_ABORT; const a = s.agent('alpha'); s.service.setActive(true);
    s.finish(a, '1-1'); await until(() => s.contexts.length === 1); s.type(a); s.service.disconnected(a);
    await until(() => s.records.length === 1);
    assert.equal(s.records[0].outcome, 'dropped'); assert.equal(s.records[0].deferral?.rule, 'disconnected'); assert.deepEqual(s.pending(), []); }
  { const s = setup(); s.box.followUp = BLOCK_UNTIL_ABORT; const a = s.agent('alpha'); s.service.setActive(true);
    s.finish(a, '1-1'); await until(() => s.contexts.length === 1); s.service.disconnected(a);
    await until(() => s.records.length === 1);
    assert.deepEqual(s.pending().map((i) => i.rule), ['disconnected']);
    s.type(a); assert.deepEqual(s.pending(), []); assert.equal(s.records.length, 1); }
});

test('P4b decider-defer path: typing before the answer → not listed; after → unlisted', async () => {
  { let release!: (v: NightFollowUp) => void; const s = setup(); s.box.followUp = () => new Promise((r) => { release = r; });
    const a = s.agent('alpha'); s.service.setActive(true); s.finish(a, '1-1'); await until(() => s.contexts.length === 1);
    s.type(a); release({ action: 'defer', reason: 'no' }); await until(() => s.records.length === 1);
    assert.deepEqual(s.pending(), []); assert.equal(s.records[0].outcome, 'dropped'); assert.equal(s.records[0].deferral?.rule, 'stale'); }
  { const s = setup(); const a = s.agent('alpha'); s.service.setActive(true); s.finish(a, '1-1'); await until(() => s.records.length === 1);
    assert.equal(s.pending().length, 1); s.type(a); assert.deepEqual(s.pending(), []); }
});

test('P4c sensitive path: card listed without a decider call, typing unlists it; typing before the delay → no record', async () => {
  { const s = setup(); const a = s.agent('alpha'); s.service.setActive(true);
    s.finish(a, '1-1', 'Listo.\n¿Hago deploy a producción?'); await until(() => s.records.length === 1);
    assert.equal(s.contexts.length, 0); assert.match(s.pending()[0].rule, /^sensitive:/);
    s.type(a); assert.deepEqual(s.pending(), []); }
  { const s = setup(); const a = s.agent('alpha'); s.service.setActive(true);
    s.finish(a, '1-1', 'Listo.\n¿Hago deploy a producción?'); s.type(a); await sleep(DELAY * 3);
    assert.equal(s.records.length, 0); assert.deepEqual(s.pending(), []); }
});

test('P5 S6 risk: typing into an older turn, then a new turn deferring → the new card is listed', async () => {
  const s = setup(); const a = s.agent('alpha'); s.service.setActive(true);
  s.finish(a, '1-1'); await until(() => s.records.length === 1); s.type(a); assert.deepEqual(s.pending(), []);
  s.finish(a, '1-2'); await until(() => s.records.length === 2);
  assert.deepEqual(s.pending().map((i) => i.id), [s.records[1].id]);
  // and a decider answer for the older turn that arrives after the new turn started is discarded, not listed
  let release!: (v: NightFollowUp) => void; s.box.followUp = () => new Promise((r) => { release = r; });
  s.finish(a, '1-3'); await until(() => s.contexts.length === 3); s.finish(a, '1-4'); release({ action: 'defer', reason: 'late' });
  await until(() => s.records.length === 3);
  assert.equal(s.records[2].deferral?.rule, 'stale');
  assert.deepEqual(s.pending().map((i) => i.id), [s.records[1].id], 'the 1-2 card stays until a newer one lists');
});

test('P6 MAX_PENDING (200) trimming still drops the oldest; an auto card trims like any other', async () => {
  const s = setup(); const a = s.agent('alpha'); const b = s.agent('beta'); s.service.setActive(true);
  s.finish(b, '2-1'); await until(() => s.records.length === 1);
  const autoId = s.pending()[0].id;
  for (let i = 0; i < 204; i++) await s.ask(a, `q${i}`, `call-${i}`);
  assert.equal(s.records.length, 205); assert.equal(s.pending().length, 200);
  assert.equal(s.pending().some((i) => i.id === autoId), false, 'the oldest (the auto card) was trimmed');
  assert.deepEqual(s.pending().map((i) => i.summary), Array.from({ length: 200 }, (_, i) => `q${i + 4}`));
});

test('P7 auto-cap path: the cap card replaces the previous card and typing unlists it', async () => {
  const s = setup({ maxAutoPerNight: 1 }); const a = s.agent('alpha'); s.service.setActive(true);
  s.finish(a, '1-1'); await until(() => s.records.length === 1);
  assert.deepEqual(s.pending().map((i) => i.rule), ['decider']);
  s.finish(a, '1-2'); await until(() => s.records.length === 2);
  assert.equal(s.records[1].deferral?.rule, 'auto-cap');
  assert.deepEqual(s.pending().map((i) => [i.id, i.rule]), [[s.records[1].id, 'auto-cap']]);
  s.type(a); assert.deepEqual(s.pending(), []);
  s.finish(a, '1-3'); await sleep(DELAY * 3);
  assert.equal(s.records.length, 2, 'the cap is logged once per night (pre-existing)'); assert.deepEqual(s.pending(), []);
});

test('P8 setActive(true) still starts a new empty pending list', async () => {
  const s = setup(); const a = s.agent('alpha'); s.service.setActive(true);
  s.finish(a, '1-1'); await until(() => s.records.length === 1); assert.equal(s.pending().length, 1);
  s.service.setActive(false); assert.equal(s.pending().length, 1, 'off keeps the list');
  s.service.setActive(true); assert.deepEqual(s.pending(), []);
});

test('P9 typing in a terminal with no auto state and in a closed terminal does not throw', async () => {
  const s = setup(); const a = s.agent('alpha'); s.service.setActive(true);
  s.type(a); assert.deepEqual(s.pending(), []);
  s.finish(a, '1-1'); await until(() => s.records.length === 1);
  s.terminals.close(a);
  assert.equal(s.pending().length, 1, 'a closed terminal keeps its card (pre-existing: "closed" copy in the UI)');
});
