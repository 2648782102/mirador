// Pure rules behind a window retaking the pty size (public/terminal-size.js): when it comes back,
// and when the user types or clicks in a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_RETAKE_GAP, inputRetakeDue, returningSizes } from '../public/terminal-size.js';

const record = (id: string, visible: boolean, replaying: boolean, cols: number, rows: number) => ({ id, visible, replaying, cols, rows });

test('a returning window resends the size of its visible terminals, even unchanged; hidden and replaying ones send nothing', () => {
  const messages = returningSizes([
    record('shown', true, false, 120, 32),
    record('hidden', false, false, 80, 24),
    record('replaying', true, true, 93, 40),
    record('also-shown', true, false, 60, 20),
    record('unmeasured', true, false, 0, 24),
  ]);
  assert.deepEqual(messages, [
    { id: 'shown', message: { t: 'r', c: 120, r: 32 } },
    { id: 'also-shown', message: { t: 'r', c: 60, r: 20 } },
  ]);
});

test('nothing to resend: no terminals, hidden and replaying, or a size never measured', () => {
  assert.deepEqual(returningSizes([]), []);
  assert.deepEqual(returningSizes([record('a', false, true, 100, 30)]), []);
  assert.deepEqual(returningSizes([record('a', true, false, 80, 0)]), []);
  assert.deepEqual(returningSizes([record('a', true, false, -1, 24)]), []);
  assert.deepEqual(returningSizes([record('a', true, false, NaN, 24)]), []);
});

test('two visible terminals with the same unchanged size both resend, in order, with only t, c and r', () => {
  const messages = returningSizes([record('a', true, false, 80, 24), record('b', true, false, 80, 24)]);
  assert.deepEqual(messages, [
    { id: 'a', message: { t: 'r', c: 80, r: 24 } },
    { id: 'b', message: { t: 'r', c: 80, r: 24 } },
  ]);
  assert.deepEqual(Object.keys(messages[0].message), ['t', 'c', 'r']);
});

test('typing or clicking resends the size the first time, then at most once per INPUT_RETAKE_GAP (1 s)', () => {
  assert.equal(INPUT_RETAKE_GAP, 1000);
  assert.equal(inputRetakeDue(undefined, 5000), true, 'never resent: resend');
  assert.equal(inputRetakeDue(5000, 5000), false, 'same moment: no');
  assert.equal(inputRetakeDue(5000, 5999), false, 'inside the gap: no');
  assert.equal(inputRetakeDue(5000, 6000), true, 'the gap passed: resend');
  assert.equal(inputRetakeDue(5000, 7500, 3000), false, 'a longer gap given: still inside it');
});
