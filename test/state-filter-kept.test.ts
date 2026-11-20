// Pins the state filter's exemption for the terminal the user is looking at: the active terminal
// stays in view (its tab, its pane, its folder row and its workspace group) after its state stops
// matching the picked states; activating another one ends the exemption.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// Namespace import: a rule not built yet fails its own test, not the whole file.
import * as filterModel from '../public/features/state-filter-model.js';

const { paneToShow, showsTerminal, treeView } = filterModel as any;

const read = (path: string) => readFileSync(path, 'utf8');
const terminals = [
  { id: 'a', state: 'work' },
  { id: 'b', state: 'done' },
  { id: 'c', state: 'wait' },
];
const agents = [
  { workspaceId: 'dev', rel: 'tools/mirador', state: 'work' },
  { workspaceId: 'dev', rel: 'web/acme-clinic', state: 'wait' },
  { workspaceId: 'trabajo', rel: 'acmematch', state: 'err' },
];
const shownIds = (selected: string[], activeId: string | null) => terminals.filter((info) => showsTerminal(selected, activeId, info)).map((info) => info.id);

test('the active terminal shows under a filter its state no longer matches', () => {
  // Opened under "Terminó", it is now working: its tab stays, and its pane, not a stand-in.
  assert.deepEqual(shownIds(['done'], 'a'), ['a', 'b']);
  assert.equal(paneToShow(['done'], 'a', terminals, { exemptActive: true }), 'a');
  assert.equal(paneToShow(['err'], 'c', terminals, { exemptActive: true }), 'c');
});

test('a terminal that was active and does not match hides once another one is activated', () => {
  assert.deepEqual(shownIds(['done'], 'b'), ['b'], 'a, active before, is working: hidden');
  assert.deepEqual(shownIds(['err'], 'c'), ['c']);
  assert.deepEqual(shownIds(['err'], null), [], 'no active terminal: nothing is exempt');
  // The filter changing keeps the active one exempt: only activeId counts, not the picked states.
  assert.deepEqual(shownIds(['wait'], 'a'), ['a', 'c']);
});

test('the active terminal\'s folder row, the folders that hold it and its workspace stay in the tree', () => {
  const view = treeView(agents, ['err'], [{ workspaceId: 'dev', rel: 'tools/mirador' }]);
  assert.equal(view.keeps('dev', 'tools/mirador'), true);
  assert.equal(view.keeps('dev', 'tools'), true, 'an ancestor of the pinned folder');
  assert.equal(view.keeps('dev', ''), true, 'its workspace group');
  assert.equal(view.keeps('dev', 'web/acme-clinic'), false, 'waiting, not in Error, and not pinned');
  assert.equal(view.keeps('dev', 'tools/vigia'), false);
  assert.equal(view.keeps('trabajo', 'acmematch'), true, 'still kept by the filter itself');
  assert.deepEqual(view.count('dev', ['tools', 'web']), { shown: 1, total: 2 });
  assert.equal(view.empty(['dev']), false, 'the active terminal leaves its workspace in view');
  // A terminal opened on the workspace root pins the group, not its folders.
  const root = treeView(agents, ['done'], [{ workspaceId: 'dev', rel: '' }]);
  assert.equal(root.keeps('dev', ''), true);
  assert.equal(root.keeps('dev', 'tools'), false);
  assert.equal(root.empty(['dev', 'trabajo']), false);
});

test('without pinned folders or the exemption the filter behaves as before', () => {
  assert.equal(paneToShow(['done'], 'a', terminals), 'b', 'the stand-in of S12');
  assert.equal(paneToShow(['err'], 'a', terminals), null);
  assert.deepEqual(shownIds([], null), ['a', 'b', 'c'], 'no filter: every terminal');
  const view = treeView(agents, ['err']);
  assert.equal(view.keeps('dev', ''), false);
  assert.equal(view.empty(['dev']), true);
  assert.equal(treeView(agents, ['err'], []).empty(['dev']), true);
  const all = treeView(agents, [], [{ workspaceId: 'dev', rel: 'tools/mirador' }]);
  assert.equal(all.active, false);
  assert.equal(all.keeps('trabajo', 'anything'), true);
});

test('the wiring: terminals.js shows the active terminal off the filter, dimmed, and the tree pins its folder', () => {
  const terminalsJs = read('public/terminals.js');
  const workspacesJs = read('public/features/workspaces.js');
  assert.match(terminalsJs, /showsTerminal\(stateFilter, activeId, /);
  assert.match(terminalsJs, /paneToShow\(stateFilter, activeId, candidates, \{ exemptActive: true \}\)/);
  assert.match(terminalsJs, /classList\.toggle\('off-filter'/);
  assert.match(terminalsJs, /export function activePlace\(\)/);
  assert.doesNotMatch(terminalsJs, /keptPlaces|kept\.add\(/, 'no set of kept terminals');
  assert.match(workspacesJs, /on\('activate', /);
  assert.match(read('public/styles/terminal-groups.css'), /\n\.tab\.off-filter \{ opacity: 0\.6; \}/);
});
