// Pure rules behind the terminal groups (public/terminal-groups.js): tabs and grid panes grouped by workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STACK_PANES_AT, gridColumns, gridTracks, groupTerminals, mostRecentTerminal, reopensActiveGroup, reorderHintGroup, showsTabsBar, stacksPanes, visibleCount } from '../public/terminal-groups.js';

const terminal = (id: string, workspaceId: string, createdAt = '2026-10-28T13:00:00Z') => ({ id, workspaceId, createdAt });
const WORKSPACES = [
  { id: 'dev', name: 'Dev' },
  { id: 'web', name: 'Web' },
  { id: 'ops', name: 'Ops' },
];
const ids = (groups: Array<{ terminals: Array<{ id: string }> }>) => groups.map((g) => g.terminals.map((info) => info.id));

test('terminals are grouped by workspace in sidebar order, keeping tab order inside each group', () => {
  const groups = groupTerminals([terminal('a', 'web'), terminal('b', 'dev'), terminal('c', 'web'), terminal('d', 'dev')], WORKSPACES);
  assert.deepEqual(groups.map((g) => [g.workspaceId, g.name, g.known]), [['dev', 'Dev', true], ['web', 'Web', true]]);
  assert.deepEqual(ids(groups), [['b', 'd'], ['a', 'c']]);
});

test('with no saved order, groups keep sidebar order and creation order inside', () => {
  const list = [terminal('a', 'web'), terminal('b', 'dev'), terminal('c', 'web')];
  assert.deepEqual(ids(groupTerminals(list, WORKSPACES, new Map())), [['b'], ['a', 'c']]);
  assert.deepEqual(ids(groupTerminals(list, WORKSPACES, new Map([['ops', ['x|agent']]]))), [['b'], ['a', 'c']]);
});

test('a saved order reorders the terminals inside their group, never the groups', () => {
  const list = [
    { ...terminal('a', 'web'), rel: 'site', kind: 'agent' },
    { ...terminal('b', 'dev'), rel: '', kind: 'shell' },
    { ...terminal('c', 'web'), rel: '', kind: 'shell' },
  ];
  const groups = groupTerminals(list, WORKSPACES, new Map([['web', ['|shell', 'site|agent']]]));
  assert.deepEqual(groups.map((g) => g.workspaceId), ['dev', 'web']);
  assert.deepEqual(ids(groups), [['b'], ['c', 'a']]);
});

test('workspaces without terminals get no group', () => {
  assert.deepEqual(groupTerminals([terminal('a', 'ops')], WORKSPACES).map((g) => g.workspaceId), ['ops']);
  assert.deepEqual(groupTerminals([], WORKSPACES), []);
});

test('a terminal whose workspace was removed goes to a group named after its workspace id, after the known ones', () => {
  const groups = groupTerminals([terminal('a', 'gone'), terminal('b', 'web'), terminal('c', 'old'), terminal('d', 'gone')], WORKSPACES);
  assert.deepEqual(groups.map((g) => [g.workspaceId, g.name, g.known]), [['web', 'Web', true], ['gone', 'gone', false], ['old', 'old', false]]);
  assert.deepEqual(ids(groups), [['b'], ['a', 'd'], ['c']]);
});

test('collapsed groups do not count as visible panes', () => {
  const groups = groupTerminals([terminal('a', 'dev'), terminal('b', 'dev'), terminal('c', 'web')], WORKSPACES);
  assert.equal(visibleCount(groups, new Set()), 3);
  assert.equal(visibleCount(groups, new Set(['dev'])), 1);
  assert.equal(visibleCount(groups, ['dev', 'web']), 0);
});

test('the grid column count comes from the visible panes', () => {
  assert.deepEqual([0, 1, 2, 4, 5, 9, 10].map(gridColumns), [1, 1, 2, 2, 3, 3, 4]);
});

test('grid tracks: one header row per group, pane rows only for expanded groups, columns from visible panes', () => {
  const groups = groupTerminals(
    [terminal('a', 'dev'), terminal('b', 'dev'), terminal('c', 'dev'), terminal('d', 'web'), terminal('e', 'ops')],
    WORKSPACES,
  );
  const pane = 'minmax(0, 1fr)';
  assert.deepEqual(gridTracks(groups, new Set()), { columns: 3, rows: ['auto', pane, 'auto', pane, 'auto', pane] });
  // dev collapsed: two visible panes → 2 columns, dev keeps only its header row.
  assert.deepEqual(gridTracks(groups, new Set(['dev'])), { columns: 2, rows: ['auto', 'auto', pane, 'auto', pane] });
  // web and ops collapsed: dev's three panes in 2 columns take two rows.
  assert.deepEqual(gridTracks(groups, ['web', 'ops']), { columns: 2, rows: ['auto', pane, pane, 'auto', 'auto'] });
  assert.deepEqual(gridTracks(groups, ['dev', 'web', 'ops']), { columns: 1, rows: ['auto', 'auto', 'auto'] });
});

test('S7: a terminals area of 640px or less stacks the grid panes in one column', () => {
  assert.equal(STACK_PANES_AT, 640);
  assert.equal(stacksPanes(640), true);
  assert.equal(stacksPanes(500), true);
  assert.equal(stacksPanes(641), false);
  assert.equal(stacksPanes(1400), false);
});

test('S7: stacked panes take one column, and each pane row keeps a usable height so the grid scrolls', () => {
  const groups = groupTerminals([terminal('a', 'dev'), terminal('b', 'dev'), terminal('c', 'dev'), terminal('d', 'web')], WORKSPACES);
  const stacked = 'minmax(240px, 1fr)';
  assert.deepEqual(gridTracks(groups, new Set(), 600), { columns: 1, rows: ['auto', stacked, stacked, stacked, 'auto', stacked] });
  // A single visible pane already takes one column: it keeps filling the area.
  assert.deepEqual(gridTracks(groups, ['dev'], 600), { columns: 1, rows: ['auto', 'auto', 'minmax(0, 1fr)'] });
});

test('S7: a wide terminals area, or no width given, keeps the near-square grid', () => {
  const groups = groupTerminals([terminal('a', 'dev'), terminal('b', 'dev'), terminal('c', 'dev'), terminal('d', 'web')], WORKSPACES);
  const pane = 'minmax(0, 1fr)';
  assert.deepEqual(gridTracks(groups, new Set()), { columns: 2, rows: ['auto', pane, pane, 'auto', pane] });
  assert.deepEqual(gridTracks(groups, new Set(), 641), gridTracks(groups, new Set()));
  assert.deepEqual(gridTracks(groups, new Set(), 1920), gridTracks(groups, new Set()));
});

test('V1: the tabs bar shows only in the tabs layout; the grid carries its own group headers', () => {
  assert.equal(showsTabsBar('tabs'), true);
  assert.equal(showsTabsBar('grid'), false);
});

test('V1: a hidden tabs bar takes no space, though .tabs is display: flex', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.tabs\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('V1: switching to tabs reopens the collapsed group of the shown terminal; switching to grid keeps it collapsed', () => {
  // Collapsed in the grid, then back to tabs: its pane is shown, so its tabs come back too.
  assert.equal(reopensActiveGroup('tabs', 'dev', new Set(['dev'])), true);
  // Previous behavior kept: the grid never reopens a group the user collapsed.
  assert.equal(reopensActiveGroup('grid', 'dev', new Set(['dev'])), false);
  // An expanded group or no active terminal: nothing to reopen.
  assert.equal(reopensActiveGroup('tabs', 'dev', new Set(['web'])), false);
  assert.equal(reopensActiveGroup('tabs', undefined, new Set(['dev'])), false);
});

test('the most recent terminal is the last one activated in this window, else the newest', () => {
  const list = [terminal('a', 'dev', '2026-10-28T10:00:00Z'), terminal('b', 'dev', '2026-10-28T12:00:00Z'), terminal('c', 'dev', '2026-10-28T11:00:00Z')];
  assert.equal(mostRecentTerminal(list, new Map([['a', 3], ['c', 1]]))?.id, 'a');
  assert.equal(mostRecentTerminal(list, new Map())?.id, 'b');
  assert.equal(mostRecentTerminal(list, new Map([['other', 9]]))?.id, 'b');
  assert.equal(mostRecentTerminal([], new Map()), null);
});

test('S4: the reorder hint goes on the first expanded group with two or more terminals, as in the artboard', () => {
  const group = (workspaceId: string, count: number) => ({ workspaceId, terminals: Array.from({ length: count }, (_, i) => terminal(`${workspaceId}${i}`, workspaceId)) });
  const groups = [group('dev', 1), group('web', 2), group('ops', 3)];
  assert.equal(reorderHintGroup(groups, new Set()), 'web');
  assert.equal(reorderHintGroup(groups, new Set(['web'])), 'ops', 'a collapsed group shows no pane head to drag');
  assert.equal(reorderHintGroup([group('dev', 1), group('web', 0)], new Set()), null, 'one terminal has nowhere to go');
  assert.equal(reorderHintGroup([], new Set()), null);
});

test('B1: the grid never makes a column narrower than a pane head needs (300px, artboard 03)', async () => {
  const { MIN_PANE_WIDTH, fitColumns } = (await import('../public/terminal-groups.js')) as any;
  assert.equal(MIN_PANE_WIDTH, 300);
  // The area keeps 10px of padding on each side and 8px between panes (styles.css .panes grid).
  assert.deepEqual([500, 640, 641, 935, 936, 1243, 1244].map(fitColumns), [1, 1, 2, 2, 3, 3, 4]);
  assert.equal(fitColumns(Infinity), Infinity, 'an unmeasured area keeps the near-square grid');
  const five = groupTerminals(['a', 'b', 'c', 'd', 'e'].map((id) => terminal(id, 'dev')), WORKSPACES);
  const stacked = 'minmax(240px, 1fr)';
  // Five panes want three columns; 760px fits two, so the rows keep a usable height and scroll.
  assert.deepEqual(gridTracks(five, [], 760), { columns: 2, rows: ['auto', stacked, stacked, stacked] });
  assert.deepEqual(gridTracks(five, [], 1400), { columns: 3, rows: ['auto', 'minmax(0, 1fr)', 'minmax(0, 1fr)'] });
  assert.deepEqual(gridTracks(five, [], 600), { columns: 1, rows: ['auto', stacked, stacked, stacked, stacked, stacked] });
});
