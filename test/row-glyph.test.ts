// A folder row's state glyph sits left of its name, so it is not mistaken for one of the actions at
// the row's end; a row without a state shows no gap there (public/features/workspaces.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');
const css = readFileSync('public/styles.css', 'utf8');

test('the state glyph slot comes right before the name, before the git mark and the actions', () => {
  assert.match(workspacesJs, /pickBox\(workspaceId, node\.rel\),\n    glyphSlot\(workspaceId, node\.rel\),\n    el\('span', \{ class: 'name'/);
  assert.doesNotMatch(workspacesJs, /el\('span', \{ class: 'name', title: node\.path \}, node\.name\),\n    stateGlyph/);
});

test('a state change replaces only the slot content, so the name does not move', () => {
  assert.match(workspacesJs, /const box = row\.querySelector\(':scope > \.glyph-slot'\);/);
  assert.match(workspacesJs, /box\.replaceChildren\(/);
});

test('a row without a state takes no room for the slot, so names follow the tree indent', () => {
  assert.match(css, /\.glyph-slot:empty \{ display: none; \}/);
});
