// Pure rule behind a returning window retaking the pty size (public/terminal-size.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returningSizes } from '../public/terminal-size.js';

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
