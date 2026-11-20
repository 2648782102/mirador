// Workspace row tools that say what they do:
// short visible text on the selected row, rename and remove in a "Más" menu (public/workspace-tools.js).
// Icons are sprite names (public/icons.js), drawn beside the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate } from '../public/i18n.js';
import { SYMBOLS } from '../public/icons.js';
import { closesMenu, menuFocusIndex, moreButton, moreTools, rowTools } from '../public/workspace-tools.js';

type Text = { key: string; vars?: Record<string, unknown> };
type Tool = { id: string; icon: string | null; label: Text; title: Text };
const DEV = { id: 'dev1', name: 'Dev 1', projects: ['mirador', 'gentle-shell', 'web'] };
const say = (language: string, text: Text) => translate(language, text.key, text.vars);
const shown = (language: string, tools: Tool[]) => tools.map((tool) => say(language, tool.label));
const icons = (tools: Tool[]) => tools.map((tool) => tool.icon);

test('S2: the row shows open, select several and folders with short visible text in Spanish and English', () => {
  const tools = rowTools(DEV) as Tool[];
  assert.deepEqual(tools.map((tool) => tool.id), ['open', 'pick', 'folders']);
  assert.deepEqual(icons(tools), ['terminal', 'check', 'files']);
  assert.deepEqual(shown('es', tools), ['Abrir 3', 'Marcar varias', 'Carpetas']);
  assert.deepEqual(shown('en', tools), ['Open 3', 'Select several', 'Folders']);
  assert.deepEqual(tools.map((tool) => say('es', tool.title)), [
    'Abrir los 3 proyectos del workspace Dev 1',
    'Seleccionar varias carpetas de Dev 1',
    'Elegir las carpetas de Dev 1',
  ]);
});

test('S2: rename and remove leave the row for the "Más" menu, with text and icons (a pencil and a cross)', () => {
  assert.ok(!(rowTools(DEV) as Tool[]).some((tool) => ['rename', 'remove'].includes(tool.id)));
  const more = moreButton(DEV) as Tool;
  assert.equal(more.icon, 'more');
  assert.equal(say('es', more.label), 'Más');
  assert.equal(say('en', more.label), 'More');
  assert.equal(say('es', more.title), 'Más acciones de Dev 1');
  const items = moreTools(DEV) as Tool[];
  assert.deepEqual(items.map((tool) => tool.id), ['rename', 'remove']);
  assert.deepEqual(icons(items), ['pencil', 'close']);
  assert.ok('pencil' in SYMBOLS, 'the set draws the pencil rename uses');
  assert.deepEqual(shown('es', items), ['Renombrar', 'Quitar']);
  assert.deepEqual(shown('en', items), ['Rename', 'Remove']);
  assert.deepEqual(items.map((tool) => say('es', tool.title)), ['Renombrar Dev 1', 'Quitar Dev 1']);
});

test('existing: a workspace without saved projects shows no open tool', () => {
  assert.deepEqual((rowTools({ id: 'w', name: 'W', projects: [] }) as Tool[]).map((tool) => tool.id), ['pick', 'folders']);
  assert.deepEqual((rowTools({ id: 'w', name: 'W' }) as Tool[]).map((tool) => tool.id), ['pick', 'folders']);
});

test('S2: arrow keys, Home and End move through the menu items, wrapping at the ends', () => {
  assert.equal(menuFocusIndex('ArrowDown', 0, 2), 1);
  assert.equal(menuFocusIndex('ArrowDown', 1, 2), 0);
  assert.equal(menuFocusIndex('ArrowUp', 0, 2), 1);
  assert.equal(menuFocusIndex('ArrowUp', 1, 2), 0);
  assert.equal(menuFocusIndex('Home', 1, 2), 0);
  assert.equal(menuFocusIndex('End', 0, 2), 1);
  assert.equal(menuFocusIndex('Enter', 0, 2), null);
});

test('S2: Escape, Tab and a press outside close the menu; a press inside keeps it open', () => {
  assert.equal(closesMenu({ type: 'keydown', key: 'Escape' }), true);
  assert.equal(closesMenu({ type: 'keydown', key: 'Tab' }), true);
  assert.equal(closesMenu({ type: 'keydown', key: 'ArrowDown' }), false);
  assert.equal(closesMenu({ type: 'pointerdown', inside: false }), true);
  assert.equal(closesMenu({ type: 'pointerdown', inside: true }), false);
});

test('S2: the stylesheet shows tool text only on the selected row and floats the menu above the rows', () => {
  const css = readFileSync(new URL('../public/styles/workspaces.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `rule ${selector} is missing`);
    return css.slice(at, css.indexOf('}', at));
  };
  // Off the selected row (hover or focus), the text stays the accessible name but is not drawn.
  assert.match(block('.ws-row:not(.selected) .ws-tool > .tool-label'), /position:\s*absolute/);
  assert.match(block('.ws-row:not(.selected) .ws-tool > .tool-label'), /clip:\s*rect\(0 0 0 0\)/);
  assert.match(block('.ws-more-menu'), /position:\s*absolute/);
  assert.match(block('.ws-more-menu'), /z-index:\s*\d+/);
  assert.match(block('.ws-more-menu[hidden]'), /display:\s*none/);
});
