// Safe fixes from the gentle-deck redesign review: no
// native alert or confirm, pager arrows named after their box, the guide's counts at full contrast,
// the git panel modal for real, status regions that stay rendered, and small ARIA names.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../public/i18n.js';

const read = (path: string) => readFileSync(path, 'utf8');
const es = MESSAGES.es as Record<string, string>;
const en = MESSAGES.en as Record<string, string>;

/** The declarations of the first `selector { … }` rule in `css` that starts a line. */
function rule(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, selector);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(body.split(';').map((d) => d.split(':').map((s) => s.trim())).filter(([k]) => k).map(([k, ...v]) => [k, v.join(':')]));
}

const NATIVE = ['public/terminals.js', 'public/git-panel.js', 'public/features/workspaces.js', 'public/features/sleeping.js', 'public/features/launch-progress.js'];

test('S5: no native alert or confirm is left in the reviewed files', () => {
  for (const file of NATIVE) assert.doesNotMatch(read(file), /(^|[^\w.])(alert|confirm)\(/m, file);
});

test('S5: closing a running terminal asks with confirmDialog, which starts on Cancelar', () => {
  const terminalsJs = read('public/terminals.js');
  assert.match(terminalsJs, /import \{ confirmDialog, showAlert \} from '\/dialog\.js';/);
  assert.match(terminalsJs, /record\.info\.status === 'running' &&\n    !\(await confirmDialog\(\{\n      title: t\('term\.confirmCloseTitle'\),\n      message: t\('term\.confirmClose', \{ title: record\.info\.title \}\),\n      confirmLabel: t\('term\.closeConfirm'\),\n      cancelLabel: t\('common\.cancel'\),\n      danger: true,\n    \}\)\)/);
  assert.equal(es['term.confirmCloseTitle'], '¿Cerrar la terminal?');
  assert.equal(es['term.closeConfirm'], 'Cerrar');
  assert.equal(en['term.confirmCloseTitle'], 'Close the terminal?');
  assert.equal(en['term.closeConfirm'], 'Close');
});

test('S5: errors show inline as role=alert, in the open dialog or else in the alerts slot under the top bar', () => {
  const dialogJs = read('public/dialog.js');
  assert.match(dialogJs, /export function showAlert\(message\) \{/);
  assert.match(dialogJs, /const modal = \[\.\.\.document\.querySelectorAll\('dialog\[open\]'\)\]\.at\(-1\);/);
  assert.match(dialogJs, /const host = modal\?\.querySelector\('\.dialog-body'\) \?\? slot\('alerts'\);/);
  assert.match(dialogJs, /el\('p', \{ class: 'field-error inline-alert', role: 'alert' \}, message\)/);
  assert.match(dialogJs, /'aria-label': t\('alert\.dismiss'\), onclick: \(\) => host\.replaceChildren\(\) \}/);
  assert.match(read('public/index.html'), /<div class="launch-slot" data-slot="launches"><\/div>\n  <!-- [^\n]*-->\n  <div class="alerts-slot" data-slot="alerts"><\/div>/);
  assert.match(read('public/styles/terminal-groups.css'), /\n\.alerts-slot:empty \{ display: none; \}/);
  // Each place that called alert() shows the same text inline.
  const calls: [string, RegExp][] = [
    ['public/terminals.js', /showAlert\(t\('term\.openFailed', \{ error: errorText\(error\) \}\)\);/],
    ['public/terminals.js', /if \(error\.status !== 404\) return showAlert\(errorText\(error\)\);/],
    ['public/git-panel.js', /showAlert\(t\('term\.openFailed', \{ error: errorText\(error\) \}\)\);/],
    ['public/features/workspaces.js', /return showAlert\(errorText\(error\)\);/],
    ['public/features/sleeping.js', /showAlert\(t\('sleeping\.failed', \{ error: errorText\(error\) \}\)\);/],
    ['public/features/launch-progress.js', /showAlert\(t\('launch\.pauseFailed', \{ error: errorText\(failure\) \}\)\);/],
  ];
  for (const [file, call] of calls) assert.match(read(file), call, file);
  assert.equal(es['alert.dismiss'], 'Cerrar el aviso');
  assert.equal(en['alert.dismiss'], 'Dismiss the notice');
});

test('S6: a fold\'s pager arrows name their fold; the goal\'s keep their names', () => {
  const overviewJs = read('public/features/overview.js');
  assert.match(overviewJs, /const prev = turn\(-1, kind \? t\('overview\.pages\.prevOf', \{ label \}\) : t\('overview\.pages\.prev'\)\);/);
  assert.match(overviewJs, /const next = turn\(1, kind \? t\('overview\.pages\.nextOf', \{ label \}\) : t\('overview\.pages\.next'\)\);/);
  assert.equal(es['overview.pages.prevOf'], 'Página anterior de {label}');
  assert.equal(es['overview.pages.nextOf'], 'Página siguiente de {label}');
  assert.equal(en['overview.pages.prevOf'], 'Previous page of {label}');
  assert.equal(en['overview.pages.nextOf'], 'Next page of {label}');
  // Kept: the goal's arrows, and the arrows still turn the pages.
  assert.equal(es['overview.pages.prev'], 'Página anterior del objetivo');
  assert.match(overviewJs, /onclick: \(\) => show\(turnPage\(page, step, total\)\)/);
});

test('S7: the guide\'s nav counts are --ink-2 at full opacity', () => {
  const count = rule(read('public/styles/help.css'), '.h-nav-btn .n');
  assert.equal(count.opacity, undefined);
  assert.equal(count.color, 'var(--ink-2)');
});

test('S8: the git panel makes the page behind it inert and gives it back on close; Escape stays with lazygit', () => {
  const panelJs = read('public/git-panel.js');
  assert.match(panelJs, /for \(const node of document\.body\.children\) \{\n    if \(node === overlay \|\| node\.inert \|\| node\.matches\('\[data-slot="modals"\]'\)\) continue;\n    node\.inert = true;\n    node\.dataset\.gitInert = '';\n  \}/);
  const close = panelJs.slice(panelJs.indexOf('export function closeGitPanel'));
  assert.match(close, /for \(const node of document\.querySelectorAll\('\[data-git-inert\]'\)\) \{\n    node\.inert = false;\n    delete node\.dataset\.gitInert;\n  \}/);
  // The background is given back before the focus returns to the opener.
  assert.ok(close.indexOf('[data-git-inert]') < close.indexOf('panel.opener.focus()'));
  assert.doesNotMatch(panelJs, /keydown|'Escape'/);
});

test('S9: the MCP status and the settings error stay rendered with a line of height reserved', () => {
  const mcpCss = read('public/styles/mcp.css');
  assert.doesNotMatch(mcpCss, /\.mcp-status:empty/);
  assert.equal(rule(mcpCss, '.mcp-status')['min-height'], '1.45em');
  const settingsCss = read('public/styles/settings.css');
  assert.doesNotMatch(settingsCss, /\.settings-error\[hidden\]/);
  assert.equal(rule(settingsCss, '.settings-error')['min-height'], '1.45em');
  const settingsJs = read('public/features/settings.js');
  assert.match(settingsJs, /nightError = el\('p', \{ class: 'settings-error', role: 'alert' \}\);/);
  assert.doesNotMatch(settingsJs, /nightError\.hidden/);
  assert.match(settingsJs, /nightError\.textContent = error \?\? '';/);
});

test('S10: the settings toggle claims no popup, the night ⓘ is named, and the tree caret says what it does', () => {
  assert.match(read('public/index.html'), /<button type="button" class="btn icon icon-btn" id="settings-toggle" aria-expanded="false" aria-controls="settings-sheet"/);
  const nightJs = read('public/features/night.js');
  assert.match(nightJs, /el\('summary', \{ 'data-night-focus': key, 'aria-label': label \}, icon\('chev-right'\), summary\)/);
  assert.match(nightJs, /\{ class: 'night-about', label: t\('night\.bedtime\.about'\) \}/);
  const workspacesJs = read('public/features/workspaces.js');
  assert.match(workspacesJs, /const caretLabel = \(open\) => t\(open \? 'tree\.collapse' : 'tree\.expand'\);/);
  assert.match(workspacesJs, /el\('button', \{ class: 'caret', 'aria-label': caretLabel\(false\), tabindex: -1, disabled: !node\.hasChildren \}, caretIcon\(false\)\)/);
  assert.match(workspacesJs, /el\('button', \{ class: 'caret', 'aria-label': caretLabel\(open\), tabindex: -1 \}, caretIcon\(open\)\)/);
  assert.equal(workspacesJs.match(/caret\.setAttribute\('aria-label', caretLabel\(willOpen\)\);/g)?.length, 2, 'both toggles switch it');
  assert.equal(es['tree.expand'], 'Mostrar subcarpetas');
  assert.equal(es['tree.collapse'], 'Ocultar subcarpetas');
  assert.equal(en['tree.expand'], 'Show subfolders');
  assert.equal(en['tree.collapse'], 'Hide subfolders');
});
