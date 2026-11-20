// Pins T2 (S1 state filter in the Workspaces head, S2 the tree
// and the terminals follow it, S3 no state bars elsewhere) to the approved artboard
// design/state-filter/01-chips-y-acordeon.html.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { translate } from '../public/i18n.js';
import { sidebarStatus } from '../public/features/sidebar-status-model.js';
import { paneStatus } from '../public/pane-status-model.js';
// Namespace import: a rule not built yet fails its own test, not the whole file.
import * as filterModel from '../public/features/state-filter-model.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const { matches, menuItems, normalizeSelection, pick, toggleState, treeView } = filterModel as any;

const read = (path: string) => readFileSync(path, 'utf8');
const artboard = readArtboard('design/state-filter/01-chips-y-acordeon.html');
const page = read('public/index.html');
const workspacesJs = read('public/features/workspaces.js');
const workspacesCss = read('public/styles/workspaces.css');
const terminalsJs = read('public/terminals.js');

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const agent = (id: string, workspaceId: string, rel: string, extra: Record<string, unknown> = {}) => ({ id, workspaceId, rel, kind: 'agent', status: 'running', ...extra });
const waiting = (terminalId: string) => ({ terminalId, kind: 'blocked', since: '2026-11-07T10:00:00Z' });
const finished = (terminalId: string) => ({ terminalId, kind: 'finished', since: '2026-11-07T10:00:00Z' });

/** The artboard's tree: Dev with 7 top-level folders and Trabajo with 2, agents as its glyphs show. */
function artboardStatus() {
  return sidebarStatus({
    terminals: [
      agent('mirador', 'dev', 'tools/mirador'),
      agent('clinic', 'dev', 'web/acme-clinic'),
      agent('puzzle', 'dev', 'games/acme-puzzle'),
      agent('acmematch', 'trabajo', 'acmematch', { status: 'exited', exitCode: 1 }),
      agent('compliance', 'trabajo', 'acme-compliance'),
    ],
    items: [waiting('clinic'), waiting('puzzle'), finished('compliance')],
    sleeping: [{ id: 'z1', workspaceId: 'dev', rel: 'tools/vigia' }],
  });
}
const DEV_FOLDERS = ['apis', 'docs', 'games', 'infra', 'mobile', 'tools', 'web'];

test('S1: picking a state toggles it, several stay picked, in menu order; unknown or repeated states are dropped', () => {
  assert.deepEqual(toggleState([], 'err'), ['err']);
  assert.deepEqual(toggleState(['err'], 'wait'), ['wait', 'err'], 'menu order: Trabajando, Esperándote, Terminó, Dormidos, Error');
  assert.deepEqual(toggleState(['wait', 'err'], 'wait'), ['err'], 'picked again, it goes off');
  assert.deepEqual(normalizeSelection(['err', 'nope', 'err', 'work']), ['work', 'err']);
  assert.deepEqual(normalizeSelection('work'), [], 'a saved value that is not a list means no filter');
  assert.deepEqual(normalizeSelection(null), []);
});

test('S1: a state keeps the menu open; "Ver todos" clears the selection and closes it', () => {
  assert.deepEqual(pick(['err'], 'wait'), { selected: ['wait', 'err'], close: false });
  assert.deepEqual(pick(['wait', 'err'], 'err'), { selected: ['wait'], close: false });
  assert.deepEqual(pick(['wait', 'err'], 'all'), { selected: [], close: true });
  assert.deepEqual(pick([], 'all'), { selected: [], close: true });
});

test('S1: an item matches when it is in ANY picked state; with none picked everything shows', () => {
  const picked = ['wait', 'err'];
  assert.equal(matches(picked, 'wait'), true);
  assert.equal(matches(picked, 'err'), true);
  assert.equal(matches(picked, 'work'), false);
  assert.equal(matches(picked, null), false, 'a shell, with no state, hides while a filter is on');
  assert.equal(matches(picked, ['work', 'err']), true, 'a list matches through any of its states');
  assert.equal(matches([], null), true);
  assert.equal(matches([], 'sleep'), true);
});

test('S1, S3: the menu lists "Ver todos" and the five states with the sidebar counts, and checks what is picked', () => {
  const status = artboardStatus();
  assert.deepEqual(menuItems(status.counts, []), [
    { state: 'all', count: 6, icon: 'filter', checked: true },
    { state: 'work', count: 1, icon: 'work', checked: false },
    { state: 'wait', count: 2, icon: 'wait', checked: false },
    { state: 'done', count: 1, icon: 'check', checked: false },
    { state: 'sleep', count: 1, icon: 'sleep', checked: false },
    { state: 'err', count: 1, icon: 'error', checked: false },
  ]);
  const picked = menuItems(status.counts, ['wait', 'err']);
  assert.deepEqual(picked.map((item: { checked: boolean }) => item.checked), [false, false, true, false, false, true]);
  const labels = ['all', 'work', 'wait', 'done', 'sleep', 'err'].map((key) => translate('es', `filter.state.${key}`));
  assert.deepEqual(labels, ['Ver todos', 'Trabajando', 'Esperándote', 'Terminó', 'Dormidos', 'Error']);
  assert.deepEqual(['all', 'work', 'wait', 'done', 'sleep', 'err'].map((key) => translate('en', `filter.state.${key}`)), ['Show all', 'Working', 'Waiting for you', 'Done', 'Sleeping', 'Error']);
});

test('S3: the menu counts and the tree glyphs come from the same agents', () => {
  const status = artboardStatus();
  const tally = Object.fromEntries(['work', 'wait', 'done', 'sleep', 'err'].map((state) => [state, status.agents.filter((a: { state: string }) => a.state === state).length]));
  assert.deepEqual(tally, status.counts);
  // Every glyph is the state of an agent in that folder.
  for (const [key, glyph] of status.folders) {
    const [workspaceId, rel] = JSON.parse(key);
    assert.ok(status.agents.some((a: { workspaceId: string; rel: string; state: string }) => a.workspaceId === workspaceId && a.rel === rel && a.state === glyph), key);
  }
});

test('S2: the tree keeps the folders in a picked state and the folders that hold them, nothing else', () => {
  const view = treeView(artboardStatus().agents, ['work']);
  assert.equal(view.active, true);
  assert.equal(view.keeps('dev', ''), true, 'the workspace holds a working agent');
  assert.equal(view.keeps('dev', 'tools'), true, 'an ancestor of tools/mirador');
  assert.equal(view.keeps('dev', 'tools/mirador'), true);
  assert.equal(view.keeps('dev', 'tools/vigia'), false, 'sleeping, not working');
  assert.equal(view.keeps('dev', 'tools/mira'), false, 'a name prefix is not an ancestor');
  assert.equal(view.keeps('dev', 'web'), false);
  assert.equal(view.keeps('trabajo', ''), false, 'no working agent in Trabajo');
});

test('S2: two picked states keep the folders of either, and a folder matches through any of its agents', () => {
  const view = treeView(artboardStatus().agents, ['wait', 'err']);
  assert.equal(view.keeps('dev', 'web/acme-clinic'), true);
  assert.equal(view.keeps('dev', 'games'), true);
  assert.equal(view.keeps('trabajo', 'acmematch'), true);
  assert.equal(view.keeps('trabajo', 'acme-compliance'), false);
  assert.equal(view.keeps('dev', 'tools'), false);
  // A folder whose glyph says Esperándote also holds a working agent: Trabajando keeps it.
  const both = sidebarStatus({ terminals: [agent('a', 'dev', 'x'), agent('b', 'dev', 'x')], items: [waiting('b')], sleeping: [] });
  assert.equal(treeView(both.agents, ['work']).keeps('dev', 'x'), true);
});

test('S2: each workspace counts "N de M carpetas" over the folders it shows', () => {
  const agents = artboardStatus().agents;
  assert.deepEqual(treeView(agents, ['work']).count('dev', DEV_FOLDERS), { shown: 1, total: 7 });
  assert.deepEqual(treeView(agents, ['work', 'wait']).count('dev', DEV_FOLDERS), { shown: 3, total: 7 });
  assert.deepEqual(treeView(agents, []).count('dev', DEV_FOLDERS), { shown: 7, total: 7 });
  assert.equal(translate('es', 'ws.folderCountOf.other', { shown: 1, count: 7 }), '1 de 7 carpetas');
  assert.equal(translate('es', 'ws.folderCountOf.one', { shown: 0, count: 1 }), '0 de 1 carpeta');
  assert.equal(translate('en', 'ws.folderCountOf.other', { shown: 1, count: 7 }), '1 of 7 folders');
});

test('S2: nothing in a picked state says "Ningún workspace en este estado."; no filter keeps every row', () => {
  const agents = artboardStatus().agents;
  assert.equal(treeView(agents, ['done']).empty(['dev', 'trabajo']), false);
  assert.equal(treeView(agents, ['done']).empty(['dev']), true);
  assert.equal(treeView([], ['work']).empty(['dev', 'trabajo']), true);
  const all = treeView(agents, []);
  assert.equal(all.active, false);
  assert.equal(all.keeps('dev', 'apis'), true);
  assert.equal(all.empty(['dev']), false);
  assert.equal(translate('es', 'filter.noWorkspaces'), 'Ningún workspace en este estado.');
  assert.equal(translate('es', 'filter.noTerminals'), 'Ninguna terminal en este estado.');
});

test('S2, S3: a terminal shows under the filter by the state its pane shows', () => {
  const info = agent('clinic', 'dev', 'web/acme-clinic');
  assert.equal(matches(['wait'], paneStatus(info, waiting('clinic')).state), true);
  assert.equal(matches(['wait'], paneStatus(info, undefined).state), false);
  assert.equal(matches(['wait'], paneStatus({ ...info, kind: 'shell' }, undefined).state), false);
  // terminals.js filters with that same pane state, and shows the sleeping entries only for Dormidos.
  assert.match(terminalsJs, /import \{[^}]*\bmatches\b[^}]*\} from '\/features\/state-filter-model\.js'/);
  assert.match(terminalsJs, /const paneState = \(info\) => paneStatus\(info, inboxByTerminal\.get\(info\.id\)\)\.state;/);
  assert.match(terminalsJs, /showsTerminal\(stateFilter, activeId, \{ id: info\.id, state: paneState\(info\) \}\)/);
  assert.match(terminalsJs, /matches\(stateFilter, 'sleep'\)/);
});

test('S1: the funnel opens a menu of menuitemcheckbox items with aria-checked, from the sidebar counts', () => {
  assert.match(workspacesJs, /'aria-haspopup': 'menu'/);
  assert.match(workspacesJs, /role: 'menu'/);
  assert.match(workspacesJs, /role: 'menuitemcheckbox'/);
  assert.match(workspacesJs, /'aria-checked': String\(item\.checked\)/);
  assert.match(workspacesJs, /menuItems\(status\.counts, chosenStates\)/);
  assert.match(workspacesJs, /status = sidebarStatus\(/);
  assert.match(workspacesJs, /treeView\(status\.agents, chosenStates, place \? \[place\] : \[\]\)/);
  // The menu reuses the "Más" menu keys: arrows, Home and End move; Escape, Tab or a press outside close.
  assert.match(workspacesJs, /menuFocusIndex\(e\.key/);
  assert.match(workspacesJs, /closesMenu\(\{ type: 'pointerdown'/);
  // The selection survives a reload in the window's prefs, as the collapsed workspaces do.
  assert.match(workspacesJs, /prefs\.read\('stateFilter', \[\]\)/);
  assert.match(workspacesJs, /prefs\.write\('stateFilter', chosenStates\)/);
});

test('S3: no "Estados" legend in the sidebar and no state chip bar above the terminals', () => {
  assert.doesNotMatch(page, /data-slot="states"/);
  assert.doesNotMatch(page, /side-foot|class="legend/);
  assert.doesNotMatch(workspacesJs, /legendChip|renderLegend|slot\('states'\)|states\.heading/);
  assert.doesNotMatch(workspacesCss, /\.side-foot|\.legend\b|\.chipbtn/);
  const terms = page.slice(page.indexOf('<section class="workspace"'), page.indexOf('</section>', page.indexOf('<section class="workspace"')));
  assert.doesNotMatch(terms, /legend|chipbtn|role="group"/);
  assert.match(page, /<p class="active-filter" data-slot="active-filter" hidden><\/p>/);
});

test('S1: the active-filter line and its removable chips are the artboard ones', { skip: NO_DESIGN }, () => {
  assert.deepEqual(own(workspacesCss, '.active-filter'), own(artboard, '.active-filter'));
  assert.deepEqual(own(workspacesCss, '.active-filter[hidden]'), own(artboard, '.active-filter[hidden]'));
  assert.deepEqual(own(workspacesCss, '.af-chip'), own(artboard, '.af-chip'));
  assert.deepEqual(own(workspacesCss, '.af-chip .n'), own(artboard, '.af-chip .n'));
  assert.deepEqual(own(workspacesCss, '.af-chip .x'), own(artboard, '.af-chip .x'));
  assert.deepEqual(own(workspacesCss, '.state-menu'), own(artboard, '.state-menu'));
  assert.deepEqual(own(workspacesCss, '.filter-btn.on'), own(artboard, '.filter-btn.on'));
  assert.equal(translate('es', 'filter.remove', { state: 'Error' }), 'Quitar Error del filtro');
  assert.equal(translate('es', 'filter.active'), 'Filtrando:');
  assert.equal(translate('es', 'filter.button'), 'Filtrar por estado');
});
