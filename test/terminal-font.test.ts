// Pins the terminal text size to artboard 03:
// the well uses --fs-sm (12px) mono.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('xterm renders terminal text at the artboard 12px size', () => {
  const source = readFileSync('public/terminals.js', 'utf8');
  assert.match(source, /new Terminal\(\{[^}]*fontSize: 12,/s);
});
