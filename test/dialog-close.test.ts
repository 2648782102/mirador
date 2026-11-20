// The guide closes with an × at its top right, like the other panels, not with a button at the bottom
// (public/features/help.js, public/dialog.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helpJs = readFileSync('public/features/help.js', 'utf8');
const dialogJs = readFileSync('public/dialog.js', 'utf8');
const dialogCss = readFileSync('public/styles/dialog.css', 'utf8');

test('the guide has no bottom action, only the × labelled "Close the guide"', () => {
  assert.match(helpJs, /actions: \[\],\n    close: t\('help\.close'\),/);
  assert.doesNotMatch(helpJs, /actions: \[\{ label: t\('help\.close'\)/);
});

test('a dialog given a close label draws an × that cancels it; without actions it draws no action bar', () => {
  assert.match(dialogJs, /class: 'dialog-close', title: close, 'aria-label': close, onclick: \(\) => busy \|\| finish\(null\) \}, icon\('close'\)/);
  assert.match(dialogJs, /actions\.length \? el\('div', \{ class: 'dialog-actions' \}, buttons\) : null/);
  assert.match(dialogCss, /\.dialog-close \{ position: absolute; top: 14px; right: 14px;/);
});

// Every window that only closes, or closes next to one action, closes with the × at its top right
// (user: "el cerrar si abre una ventana este arriba a la derecha en vez de abajo"). Forms keep
// "Cancelar" beside their primary action.
const read = (path: string) => readFileSync(path, 'utf8');

test('"Antes de dormir" closes with the ×, with no bottom action bar', () => {
  assert.match(read('public/features/night.js'), /openDialog\(\{ title, body, actions: \[\], close: t\('night\.sheet\.close'\), className: 'night-dialog night-sheet' \}\)/);
});

test('the credits close with the ×; "Saltar" no longer lives in an action bar', () => {
  const credits = read('public/features/credits.js');
  assert.match(credits, /actions: \[\],\n    close: t\('credits\.close'\),/);
  assert.doesNotMatch(credits, /\.dialog-actions'\)\.prepend\(skip\)/);
});

test('MCP and sleeping windows close with the × and keep only their primary action at the bottom', () => {
  for (const [file, key, primary] of [['public/features/mcp.js', 'mcp', 'mcp.save'], ['public/features/sleeping.js', 'sleeping', 'sleeping.wakeAll']]) {
    const src = read(file);
    assert.doesNotMatch(src, new RegExp(`label: t\\('${key}\\.close'\\), value: null`));
    assert.match(src, new RegExp(`close: t\\('${key}\\.close'\\),`));
    assert.match(src, new RegExp(`actions: \\[\\n      \\{ label: t\\('${primary.replace('.', '\\.')}'\\)`));
  }
});

test('a dialog without a cancel action starts on its × when asked to start on cancel', () => {
  assert.match(dialogJs, /const cancel = buttons\[actions\.findIndex\(\(a\) => a\.value === null\)\] \?\? closeButton;/);
});

test('the file editor closes only with its top-right ×, with no "Cerrar" beside Save', () => {
  const files = read('public/features/files.js');
  assert.match(files, /el\('div', \{ class: 'files-foot' \}, status, shortcut, saveButton\)/);
  assert.doesNotMatch(files, /files\.closeShort/);
  assert.doesNotMatch(read('public/i18n/files.js'), /files\.closeShort/);
});
