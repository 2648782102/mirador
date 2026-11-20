// The terminal tabs from the keyboard: each tab is a
// role=tab with a roving tabindex and ←/→/Home/End/Enter, its × is a sibling of the tab in the
// tab's wrapper, not inside it, and a long title ends in an ellipsis at 24ch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');
const terminalsJs = read('public/terminals.js');
const groupsCss = read('public/styles/terminal-groups.css');

/** The source of `function name(…) { … }` in `source`, up to the next top-level closing brace. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

/** The declarations of the first `selector { … }` rule in `css`. */
function rule(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, selector);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(body.split(';').map((d) => d.split(':').map((s) => s.trim())).filter(([k]) => k).map(([k, ...v]) => [k, v.join(':')]));
}

const mount = fn(terminalsJs, 'mountTerminal');
const tabItem = mount.slice(mount.indexOf('const tabItem = el('), mount.indexOf(');\n', mount.indexOf('const tabItem = el(')));

test('S1: the tab is a role=tab out of the Tab order until it is the shown one, controlling its pane', () => {
  assert.match(tabItem, /role: 'tab', id: `term-tab-\$\{info\.id\}`, tabindex: '-1', 'aria-selected': 'false', 'aria-controls': `term-pane-\$\{info\.id\}`/);
  assert.match(mount, /\{ class: 'pane', 'data-terminal-id': info\.id, id: `term-pane-\$\{info\.id\}`,/);
  // Roving tabindex: showPane gives the one Tab stop to the shown tab, and the selected state with it.
  const show = fn(terminalsJs, 'showPane');
  assert.match(show, /record\.tabItem\.setAttribute\('aria-selected', String\(id === next\)\);/);
  assert.match(show, /record\.tabItem\.tabIndex = id === next \? 0 : -1;/);
  assert.match(show, /visibleTabs\(\)/, 'with none shown, the first visible tab keeps the Tab stop');
});

test('S1: ←/→ move to the previous or next visible tab, Home/End to the first or last, Enter and Space activate', () => {
  assert.match(tabItem, /onkeydown: \(event\) => tabKeys\(event, info\.id\)/);
  const keys = fn(terminalsJs, 'tabKeys');
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.match(keys, new RegExp(`${key}: `), key);
  assert.match(keys, /event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(keys, /activateTerminal\(id\)/);
  // Alt+Shift+←/→ stays the reorder of moveByKeyboard, and other modifiers stay the browser's.
  assert.match(keys, /if \(event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey\) return;/);
  assert.match(keys, /\.tabIndex = 0;/);
  assert.match(keys, /\.focus\(\)/);
  assert.match(fn(terminalsJs, 'visibleTabs'), /\$\('#tabs'\)\.querySelectorAll\('\[role="tab"\]'\)\].filter\(\(node\) => !node\.closest\('\[hidden\]'\)\)/);
});

test('S2: the × is a sibling of the tab in its wrapper, never inside the role=tab', () => {
  assert.doesNotMatch(tabItem, /closeButton|'button'/);
  assert.match(mount, /\{ class: 'tab', 'data-terminal-id': info\.id, title: [^\n]*, onclick: \(\) => activateTerminal\(info\.id\) \},\n    tabItem,\n    closeButton\(\),\n  \);/);
  // The wrapper is a plain element: no role of its own, so the tablist holds the tab itself.
  assert.doesNotMatch(mount, /class: 'tab', role:/);
  // The look of the selected tab follows its role=tab, and the state glyph keeps the artboard size.
  assert.deepEqual(rule(groupsCss, '.tab:has(> .tab-item[aria-selected="true"])'), { background: 'var(--paper)', 'border-color': 'var(--rule)' });
  assert.deepEqual(rule(groupsCss, '.tab-item > .term-mark > svg.icon'), { '--icon': 'inherit' });
});

test('S3: a long title ends in an ellipsis at 24ch, and the tab\'s title carries it whole', () => {
  assert.match(tabItem, /el\('span', \{ class: 'tab-title' \}, info\.title\)/);
  const title = rule(groupsCss, '.tab-title');
  assert.equal(title['max-width'], '24ch');
  assert.equal(title.overflow, 'hidden');
  assert.equal(title['text-overflow'], 'ellipsis');
  assert.match(fn(terminalsJs, 'updateStatus'), /term\.tab\.title = `\$\{term\.info\.title\}\\n\$\{placeLabel\(term\.info\)\}/);
});

test('kept: a click on the tab activates it, and its × closes it without activating', () => {
  assert.match(mount, /onclick: \(\) => activateTerminal\(info\.id\) \}/);
  assert.match(mount, /const closeButton = \(\) => el\('button', \{ class: 'close', title: t\('term\.close'\), 'aria-label': t\('term\.close'\), onclick: \(e\) => \{ e\.stopPropagation\(\); closeTerminal\(info\.id\); \} \}, icon\('close'\)\);/);
  // The wrapper still drags, and the filter still hides it by its wrapper.
  assert.match(mount, /wireDrag\(tab, tab, info\.id\);/);
  assert.match(fn(terminalsJs, 'renderGroups'), /record\.tab\.hidden = !shownIds\.has\(id\);/);
});
