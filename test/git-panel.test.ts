// The tree's git mark opens lazygit in a floating panel, never as a tab or grid pane, and the
// panel closes itself when lazygit ends (public/git-panel.js, public/terminal-kind-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { showsAsTab } from '../public/terminal-kind-model.js';

const terminalsJs = readFileSync('public/terminals.js', 'utf8');
const panelJs = readFileSync('public/git-panel.js', 'utf8');
const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');

test('agents and shells are tabs; a git terminal is not', () => {
  assert.equal(showsAsTab({ kind: 'agent' }), true);
  assert.equal(showsAsTab({ kind: 'shell' }), true);
  assert.equal(showsAsTab({ kind: 'git' }), false);
});

test('no path mounts a git terminal as a tab: the first load and every later batch skip it', () => {
  assert.match(terminalsJs, /for \(const info of await api\('GET', '\/api\/terminals'\)\) if \(showsAsTab\(info\)\) mountTerminal\(info\);/);
  assert.match(terminalsJs, /export function showOpenedTerminals\(infos\) \{\n  infos = infos\.filter\(showsAsTab\);/);
});

test('the git mark opens the floating panel for its folder', () => {
  assert.match(workspacesJs, /onclick: \(e\) => \{ e\.stopPropagation\(\); openGitPanel\(folder, node\.name\); \}/);
  assert.doesNotMatch(workspacesJs, /openTerminal\(folder, 'git'\)/);
});

test('the panel closes and deletes its terminal when lazygit ends or on ×, never on Escape', () => {
  assert.match(panelJs, /exited: \(\) => closeGitPanel\(\)/);
  assert.match(panelJs, /onclick: \(\) => closeGitPanel\(\)/);
  assert.match(panelJs, /api\('DELETE', `\/api\/terminals\/\$\{/);
  assert.doesNotMatch(panelJs, /keydown|'Escape'/, 'Escape stays with lazygit');
  assert.match(panelJs, /opener\?\.isConnected/, 'focus goes back to where it was');
});
