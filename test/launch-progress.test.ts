// Wiring of the launch notice: the window starts the
// feature, whose slot stays under the top bar for Seguimiento while Desarrollo shows the notice in
// the terminals sheet, and every action that starts one more pi
// carries data-launch-block, which public/features/launch-progress.js disables while agents open.
// bash buttons never carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('R4b: the app starts the launch-progress feature, with its slot under the top bar and its stylesheet', () => {
  assert.match(source('public/app.js'), /import \* as launchProgress from '\/features\/launch-progress\.js';/);
  assert.match(source('public/app.js'), /^\s*launchProgress,$/m);
  const html = source('public/index.html');
  assert.match(html, /<\/header>\s*<div class="launch-slot" data-slot="launches"><\/div>/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\/launches\.css">/);
  assert.match(source('public/i18n.js'), /^\s*launches,$/m);
});

test('R4b: gentle-shell, Delegar, Abrir N (row and selection) and Traer a Mirador are marked; bash is not', () => {
  const workspaces = source('public/features/workspaces.js');
  assert.match(workspaces, /title: t\('tree\.startAgent', \{ path \}\), 'data-launch-block': 'agent',/);
  assert.doesNotMatch(workspaces, /tree\.openShell[^\n]*data-launch-block/);
  assert.match(workspaces, /'data-delegate': 'row', 'data-launch-block': 'delegate',/);
  assert.match(workspaces, /if \(tool\.dataset\.tool === 'open'\) \{\n\s*tool\.dataset\.pick = 'saved';\n\s*tool\.dataset\.launchBlock = 'batch';/);
  assert.match(workspaces, /openButton\.dataset\.launchBlock = 'batch';/);
  assert.match(workspaces, /delegateButton\.dataset\.launchBlock = 'delegate';/);
  assert.match(source('public/features/tracking.js'), /'data-focus': `adopt:\$\{project\.project\}`,\n\s*'data-launch-block': 'adopt',/);
});

test('S2 fidelity: the notice sits at the top of the terminals sheet in Desarrollo and under the top bar in Seguimiento, and reads the sleeping list', () => {
  const feature = source('public/features/launch-progress.js');
  assert.match(feature, /const host = \$\('#layout'\)\.hidden \? slot\('launches'\) : \$\('\.workspace'\);/);
  assert.match(feature, /new MutationObserver\(place\)\.observe\(\$\('#layout'\), \{ attributes: true, attributeFilter: \['hidden'\] \}\);/);
  assert.match(feature, /import \{ sleepingAgents \} from '\/features\/sleeping\.js';/);
  assert.match(feature, /on\('sleeping', \(\) => status && render\(\)\);/);
});
