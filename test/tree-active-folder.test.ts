// The tree marks the folder of the terminal you are looking at (the user chose option A, 2026-11-09):
// "si tengo una pestana o cuadricual trabajando me deberia resaltar en el workspace ese proyecto".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const js = readFileSync('public/features/workspaces.js', 'utf8');
const css = readFileSync('public/styles.css', 'utf8');
const body = (name: string) => js.match(new RegExp(`\\nfunction ${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}\\n`))?.[1] ?? '';
const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

test('markActive toggles has-active on the row of the active terminal\'s folder only', () => {
  const mark = body('markActive');
  assert.match(mark, /const place = activePlace\(\);/);
  assert.match(mark, /sameFolder\(active, \{ ws: row\.dataset\.ws, rel: row\.dataset\.rel \}\)/);
  assert.match(mark, /row\.classList\.toggle\('has-active', /);
  // It never selects: the main view stays what you chose.
  assert.doesNotMatch(mark, /select\(/);
});

test('the mark follows a tab or pane change, a closed terminal and a redraw', () => {
  assert.match(js, /on\('activate', \(\) => \{\n\s+markActive\(\);/);
  assert.match(body('refreshStatus'), /\n\s+markActive\(\);/);
});

test('the active folder shows an accent bar, also on the selected row', () => {
  assert.match(rule('.row.has-active'), /box-shadow: inset 3px 0 0 var\(--accent\);/);
  assert.match(rule('.row.selected.has-active'), /box-shadow: var\(--shadow-sheet\), inset 0 0 0 1px var\(--rule\), inset 3px 0 0 var\(--accent\);/);
});
