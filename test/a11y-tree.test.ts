// The sidebar tree as an APG tree: one Tab stop for the whole
// tree, ↑/↓/Home/End between the rows it shows, and a row's actions out of the Tab order until the
// focus is on that row. Enter, ←, → and Space keep what they did.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');

/** The source of `function name(…) { … }`, up to the next top-level closing brace. */
function fn(name: string): string {
  const start = workspacesJs.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  return workspacesJs.slice(start, workspacesJs.indexOf('\n}\n', start) + 2);
}

test('S4: every row starts out of the Tab order; rovingStop gives the one stop to a shown row', () => {
  assert.doesNotMatch(workspacesJs, /role: 'treeitem', tabindex: 0/);
  assert.equal(workspacesJs.match(/role: 'treeitem', tabindex: -1,/g)?.length, 2, 'folder and workspace rows');
  assert.match(fn('visibleRows'), /\.querySelectorAll\('\.row'\) \?\? \[\]\)\]\.filter\(\(row\) => !row\.closest\('\[hidden\], \.filtered-out'\)\)/);
  const stop = fn('rovingStop');
  assert.match(stop, /const target = row \?\? rows\.find\(\(r\) => r\.tabIndex === 0\) \?\? rows\.find\(\(r\) => r\.classList\.contains\('selected'\)\) \?\? rows\[0\];/);
  assert.match(stop, /r\.tabIndex = r === target \? 0 : -1;/);
  // The stop follows what can hide or rebuild rows: a render, a fold, the filter.
  for (const name of ['markSelected', 'filterTree']) assert.match(fn(name), /rovingStop\(\);/, name);
  assert.equal(workspacesJs.match(/    row\.setAttribute\('aria-expanded', String\(willOpen\)\);\n    rovingStop\(\);/g)?.length, 2, 'both folds');
});

test('S4: ↑/↓ move between the rows the tree shows, Home/End to the first or last', () => {
  const keys = fn('treeKeys');
  assert.match(keys, /if \(!e\.target\.matches\?\.\('\.row'\) \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey\) return;/);
  assert.match(keys, /\{ ArrowUp: here - 1, ArrowDown: here \+ 1, Home: 0, End: rows\.length - 1 \}\[e\.key\]/);
  assert.match(keys, /rows\[index\]\.focus\(\);/);
  assert.match(fn('init'), /tree\.addEventListener\('keydown', treeKeys\);/);
});

test('S4: a row\'s actions leave the Tab order until the focus is on that row', () => {
  assert.match(workspacesJs, /const ROW_ACTIONS = ':scope > \.pick, :scope > \.repo-btn, :scope > \.row-actions button:not\(\.ws-more-item\)';/);
  assert.match(fn('actionStops'), /for \(const node of row\.querySelectorAll\(ROW_ACTIONS\)\) node\.tabIndex = on \? 0 : -1;/);
  assert.match(fn('folderRow'), /actionStops\(row, false\);/);
  assert.match(fn('workspaceGroup'), /row\.querySelector\('\.row-actions'\)\.append\(moreMenu\(workspace, extra\)\);\n  actionStops\(row, false\);/);
  const init = fn('init');
  assert.match(init, /tree\.addEventListener\('focusin', \(e\) => \{\n    const row = e\.target\.closest\?\.\('\.row'\);\n    if \(!row\) return;\n    rovingStop\(row\);\n    actionStops\(row, true\);\n  \}\);/);
  assert.match(init, /tree\.addEventListener\('focusout', \(e\) => \{\n    const row = e\.target\.closest\?\.\('\.row'\);\n    if \(row && !row\.contains\(e\.relatedTarget\)\) actionStops\(row, false\);\n  \}\);/);
});

test('kept: Enter opens an agent, → and ← fold, Space selects, F2 renames a workspace; the caret stays out of the Tab order', () => {
  for (const name of ['folderRow', 'workspaceGroup']) {
    const row = fn(name);
    assert.match(row, /if \(e\.target !== row\) return;\n    if \(e\.key === 'Enter'\) openTerminal\(folder, 'agent'\);/, name);
    assert.match(row, /if \(e\.key === 'ArrowRight'\) toggle\(true\);\n    if \(e\.key === 'ArrowLeft'\) toggle\(false\);\n    if \(e\.key === ' '\) \{ e\.preventDefault\(\); select\(folder\); \}/, name);
    assert.match(row, /el\('button', \{ class: 'caret', 'aria-label': caretLabel\([^)]*\), tabindex: -1/, name);
  }
  assert.match(fn('workspaceGroup'), /if \(e\.key === 'F2'\) startRename\(workspace\.id, row, name\);/);
});
