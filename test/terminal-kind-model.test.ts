// Pure rules about which terminals a window shows (public/terminal-kind-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showsAsTab, unknownTerminalIds } from '../public/terminal-kind-model.js';

test('kept: a git terminal never shows as a tab; any other kind does', () => {
  assert.equal(showsAsTab({ kind: 'git' }), false);
  assert.equal(showsAsTab({ kind: 'agent' }), true);
  assert.equal(showsAsTab({ kind: 'shell' }), true);
});

test('the inbox names terminals this window lacks: each once, in order, ignoring items without an id', () => {
  const items = [{ terminalId: 'new' }, { terminalId: 'known' }, { terminalId: 'new' }, { terminalId: 'other' }, {}, { terminalId: '' }, null];
  assert.deepEqual(unknownTerminalIds(items, new Set(['known'])), ['new', 'other']);
  assert.deepEqual(unknownTerminalIds(items, new Set(['known', 'new', 'other'])), []);
  assert.deepEqual(unknownTerminalIds(null, new Set()), [], 'no list: nothing');
});
