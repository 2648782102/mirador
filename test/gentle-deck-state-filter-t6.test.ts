// Pins T6 (S6 nothing overflows, plus the defects the browser
// audit found in S5, S9 and S11) to the approved artboard design/state-filter/01-chips-y-acordeon.html.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const artboard = readArtboard('design/state-filter/01-chips-y-acordeon.html');
const css = read('public/styles.css');
const workspacesCss = read('public/styles/workspaces.css');
const helpCss = read('public/styles/help.css');
const dialogCss = read('public/styles/dialog.css');
const creditsCss = read('public/styles/credits.css');
const resourcesCss = read('public/styles/resources.css');
const overviewJs = read('public/features/overview.js');
const page = read('public/index.html');

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The inside of the `@container (max-width: <px>px)` block in `source`, braces matched. */
function containerBlock(source: string, px: number): string {
  const head = `@container (max-width: ${px}px) {`;
  const start = source.indexOf(head);
  assert.notEqual(start, -1, `${head} is missing`);
  let depth = 1;
  let i = start + head.length;
  for (; i < source.length && depth; i++) depth += source[i] === '{' ? 1 : source[i] === '}' ? -1 : 0;
  return source.slice(start + head.length, i - 1);
}

/** The declarations of `selector` inside a block, or {} when it has no such rule. */
function inBlock(block: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = block.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

test('S6: a tight Workspaces head drops "Agregar" to its + before the title gives way', { skip: NO_DESIGN }, () => {
  // At 1280px the 256px sidebar ellipsized "Workspaces" while "Agregar" kept its text (artboard
  // .side-head.tight .has-lbl .lbl). The head measures its content box; its widest text (gentleman, es) needs 257px.
  assert.equal(own(workspacesCss, '.sidebar-head')['container-type'], 'inline-size');
  const tight = containerBlock(workspacesCss, 258);
  assert.equal(inBlock(tight, '#ws-add > span').display, 'none');
  assert.deepEqual(inBlock(tight, '.sidebar-head #ws-add'), { width: '28px', padding: '0', 'justify-content': 'center' });
  // The + alone keeps its name: the button is labelled, not only its text.
  assert.match(page, /<button type="button" class="btn" id="ws-add" data-i18n-label="ws\.add"/);
  assert.match(artboard, /\.side-head\.tight \.has-lbl \.lbl/);
});

test('S6: a narrow pane hides its place under 420px and its figures under 340px, the close stays at the end', { skip: NO_DESIGN }, () => {
  // The artboard's .pane container queries; without them a 321px grid pane showed "Zu…" as its place.
  assert.equal(own(css, '.pane')['container-type'], 'inline-size');
  assert.match(artboard, /@container \(max-width: 420px\) \{ \.pane-head \.cwd \{ display: none; \}/);
  assert.match(artboard, /@container \(max-width: 340px\) \{ \.pane-head \.res \{ display: none; \}/);
  assert.equal(inBlock(containerBlock(css, 420), '.pane-head .cwd').display, 'none');
  assert.equal(inBlock(containerBlock(css, 340), '.pane-head .res-badge').display, 'none');
  // A hidden badge still matches resources.css `.pane-head .res-badge + .close { margin-left: 0 }`;
  // the override sits after it in the same sheet, where the same specificity wins.
  const keep = '.pane-head .res-badge + .close { margin-left: 0; }';
  assert.equal(inBlock(containerBlock(resourcesCss, 340), '.pane-head .res-badge + .close')['margin-left'], 'auto');
  assert.ok(resourcesCss.indexOf('@container (max-width: 340px)') > resourcesCss.indexOf(keep));
});

test('S5: turning to the last page keeps the turn: the box takes the focus without scrolling', () => {
  // The › button disables on the last page and hands the focus to the box; a plain focus() cancelled
  // the box's smooth scroll, so "2 / 2" showed the first page.
  assert.match(overviewJs, /box\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(overviewJs, /box\.focus\(\)/);
});

test('S9: the guide lede keeps its 14px above the cards over the dialog paragraph reset', { skip: NO_DESIGN }, () => {
  // dialog.css `.dialog-body p { margin: 0 }` (0,1,1) outranked `.h-lede` (0,1,0): the lede touched the first card.
  assert.equal(own(dialogCss, '.dialog-body p').margin, '0');
  assert.equal(own(helpCss, '.help-body .h-lede').margin, '0 0 14px');
  assert.match(artboard, /\.h-lede \{ margin: 0 0 14px;/);
});

test('S11: the crawl pitch is neon on the night sky in every theme, not the light theme ink', () => {
  // `.credits-zurai .maker-pitch { color: var(--ink) }` painted #1f2328 on the dark stage in light theme.
  const crawl = '.crawl-text :is(.credits-by, .credits-thanks p, .credits-foot, .maker-pitch)';
  assert.equal(own(creditsCss, crawl).color, 'inherit');
  // Same specificity (0,2,0): the crawl rule must come later to win.
  assert.ok(creditsCss.indexOf(crawl) > creditsCss.indexOf('.credits-zurai .maker-pitch'));
});
