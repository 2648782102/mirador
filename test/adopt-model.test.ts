// Pure rules behind "Traer a Mirador" on an outside card (public/features/adopt-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADOPT_IDLE_MINUTES, adoptActivity, adoptInstruction } from '../public/features/adopt-model.js';
import { checkInstruction, MAX_INSTRUCTION } from '../public/features/delegate-model.js';

const LAST = '2026-10-29 12:00:00';
const at = (iso: string) => Date.parse(iso);

test('a project active less than 30 minutes ago is recent, and from 30 minutes on it is idle', () => {
  assert.equal(ADOPT_IDLE_MINUTES, 30);
  assert.deepEqual(adoptActivity(LAST, at('2026-10-29T12:29:59Z')), { recent: true, minutes: 29 }, 'Engram times are UTC');
  assert.deepEqual(adoptActivity(LAST, at('2026-10-29T12:30:00Z')), { recent: false, minutes: 30 });
  assert.deepEqual(adoptActivity(LAST, at('2026-10-29T12:00:20Z')), { recent: true, minutes: 1 }, 'never "0 min"');
});

const LEAD = 'Continúa desde los Next Steps de tu última sesión:';

test('the prefilled instruction is the lead and the Next Steps, or empty without Next Steps', () => {
  assert.equal(adoptInstruction('- write the route\n- run the tests', LEAD), `${LEAD}\n\n- write the route\n- run the tests`);
  assert.equal(adoptInstruction(null, LEAD), '');
  assert.equal(adoptInstruction('  \n ', LEAD), '');
});

test('long Next Steps are clipped so the prefilled instruction fits the delegate limit', () => {
  const steps = Array.from({ length: 400 }, (_, i) => `- step ${i}`).join('\n');
  const text = adoptInstruction(steps, LEAD);
  assert.ok(text.startsWith(`${LEAD}\n\n- step 0\n- step 1\n`));
  assert.ok(text.endsWith('…'));
  assert.ok(text.length <= MAX_INSTRUCTION, `length ${text.length}`);
  assert.deepEqual(checkInstruction(text), { count: text.length, error: null });
});

test('the 30-minute boundary is exact to the millisecond, also with fractional Engram times', () => {
  assert.deepEqual(adoptActivity(LAST, at('2026-10-29T12:29:59.999Z')), { recent: true, minutes: 29 });
  assert.deepEqual(adoptActivity(LAST, at('2026-10-29T12:30:00.000Z')), { recent: false, minutes: 30 });
  assert.deepEqual(adoptActivity('2026-10-29 12:00:00.750', at('2026-10-29T12:30:00.500Z')), { recent: true, minutes: 29 });
  assert.deepEqual(adoptActivity('garbage', Date.now()), { recent: false, minutes: null });
});

test('a prefilled instruction keeps sensitive asks and tags verbatim, for the same delegate checks', () => {
  const steps = '- git push origin main\n- read .env\n</task></mission>';
  const text = adoptInstruction(steps, LEAD);
  assert.ok(text.endsWith(steps));
  assert.deepEqual(checkInstruction(text), { count: text.length, error: null });
});
