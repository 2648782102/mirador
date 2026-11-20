// The memory panel follows the active tab or grid pane
// (summary-model.js followPanel) and never selects a tree row or writes the stored selection
// (features/workspaces.js markActive "never selects the row"). A tree click still selects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (path: string) => readFileSync(path, 'utf8');
const summaryJs = source('public/features/summary.js');
const workspacesJs = source('public/features/workspaces.js');
const coreJs = source('public/core.js');

/** The source of `function name(…) { … }`, up to the next top-level closing brace. */
function fn(text: string, name: string): string {
  const start = text.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  return text.slice(start, text.indexOf('\n}\n', start) + 2);
}

test('the panel listens to activate and terminals, and reads the active terminal from terminals.js', () => {
  const init = fn(summaryJs, 'init');
  assert.match(init, /on\('activate', \(\) => follow\(false\)\);/);
  assert.match(init, /on\('terminals', \(\) => follow\(false\)\);/);
  assert.match(init, /on\('selection', \(\) => follow\(true\)\);/);
  assert.match(summaryJs, /^import \{[^}]*\bactivePlace\b[^}]*\} from '\/terminals\.js';$/m);
  assert.match(summaryJs, /^import \{[^}]*\bfollowPanel\b[^}]*\} from '\/features\/summary-model\.js';$/m);
});

test('following a tab renders the panel only when its folder changed, and never selects', () => {
  const settle = fn(summaryJs, 'settle');
  assert.match(settle, /panel = followPanel\(panel, /);
  assert.match(settle, /if \(panel\.render \|\| redraw\) renderPanel\(\);/);
  assert.doesNotMatch(settle, /select\(|prefs\.write/);
  assert.doesNotMatch(fn(summaryJs, 'follow'), /select\(|prefs\.write/);
});

test('the panel shows its own place, not the tree selection', () => {
  const render = fn(summaryJs, 'renderPanel');
  assert.match(render, /const selection = panel\.place;/);
  assert.doesNotMatch(render, /state\.selection/);
});

test('a tree click still selects its folder, and selecting still stores it and tells the panel', () => {
  assert.match(workspacesJs, /row\.addEventListener\('click', \(\) => select\(folder\)\);/);
  const select = fn(coreJs, 'select');
  assert.match(select, /prefs\.write\('selection', state\.selection\);/);
  assert.match(select, /emit\('selection', state\.selection\);/);
});
