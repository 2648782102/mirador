// Pins the three decisions of the audit:
// the tabs layout under the state filter shows a stand-in without marking it seen, the
// crawl pitch is centered, an objective that fits sizes its box to its text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// Namespace import: a rule not built yet fails its own test, not the whole file.
import * as filterModel from '../public/features/state-filter-model.js';

const { paneToShow } = filterModel as any;

const read = (path: string) => readFileSync(path, 'utf8');
const terminalsJs = read('public/terminals.js');
const css = read('public/styles.css');
const creditsCss = read('public/styles/credits.css');
const overviewCss = read('public/styles/overview.css');
const overviewJs = read('public/features/overview.js');

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The source of the top-level function `name` in `source`, braces matched. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `function ${name} is missing`);
  let i = source.indexOf('{', source.indexOf(')', start));
  let depth = 1;
  for (i++; i < source.length && depth; i++) depth += source[i] === '{' ? 1 : source[i] === '}' ? -1 : 0;
  return source.slice(start, i);
}

const terminals = [
  { id: 'a', state: 'work' },
  { id: 'b', state: 'done' },
  { id: 'c', state: 'wait' },
  { id: 'd', state: 'done' },
  { id: 'e', state: null },
];

test('S12: the active terminal shows while the filter keeps it', () => {
  assert.equal(paneToShow(['done'], 'd', terminals), 'd');
  assert.equal(paneToShow(['work', 'wait'], 'c', terminals), 'c');
});

test('S12: an active terminal the filter hides gives way to the first one it shows', () => {
  assert.equal(paneToShow(['done'], 'a', terminals), 'b');
  assert.equal(paneToShow(['wait', 'done'], 'e', terminals), 'b');
  // No active terminal yet (a reload with a saved filter activates none): the first one it shows.
  assert.equal(paneToShow(['wait'], null, terminals), 'c');
});

test('S12: nothing in a picked state shows no pane', () => {
  assert.equal(paneToShow(['err'], 'a', terminals), null);
  assert.equal(paneToShow(['sleep'], null, terminals), null);
  assert.equal(paneToShow(['done'], 'a', []), null);
});

test('S12: with nothing picked the active terminal shows whatever its state', () => {
  assert.equal(paneToShow([], 'e', terminals), 'e');
  assert.equal(paneToShow([], 'b', terminals), 'b');
  assert.equal(paneToShow([], null, terminals), 'a');
  assert.equal(paneToShow([], null, []), null);
});

test('S12: terminals.js shows the stand-in without the activation that marks it seen', () => {
  assert.match(terminalsJs, /import \{[^}]*\bpaneToShow\b[^}]*\} from '\/features\/state-filter-model\.js'/);
  const show = fn(terminalsJs, 'showPane');
  assert.match(show, /paneToShow\(stateFilter, activeId,/);
  assert.match(show, /classList\.toggle\('stand-in'/);
  // features/inbox.js marks a terminal seen on the `activate` event activateTerminal emits.
  for (const path of ['activateTerminal(', "emit('activate'", 'activeId =', '.focus(']) assert.ok(!show.includes(path), `showPane must not call ${path}`);
  // Every layout pass and every activation repaints which pane shows.
  assert.match(fn(terminalsJs, 'renderGroups'), /showPane\(\)/);
  assert.match(fn(terminalsJs, 'activateTerminal'), /showPane\(\)/);
  // The tabs layout shows the stand-in's pane like the active one's.
  assert.equal(own(css, '.panes[data-layout="tabs"] .pane.stand-in').display, 'flex');
  // And hides the active one the filter left out: same specificity as .active (0,4,0), so later.
  const hidden = '.panes[data-layout="tabs"] .pane[hidden]';
  assert.equal(own(css, hidden).display, 'none');
  assert.ok(css.indexOf(hidden) > css.indexOf('.panes[data-layout="tabs"] .pane.active {'));
});

test('S12: with no terminal in a picked state the tabs layout shows the notice, not a blank pane', () => {
  const render = fn(terminalsJs, 'renderGroups');
  assert.match(render, /\$\('#filter-empty'\)\.hidden = /);
  assert.match(render, /showsTabsBar\(layout\) \? !visible\.length : !groups\.length/);
});

test('S12: after a reload the saved filter applies before the first terminal is picked, and a filtered start activates none', () => {
  assert.match(terminalsJs, /let stateFilter = normalizeSelection\(prefs\.read\('stateFilter', \[\]\)\);/);
  assert.match(fn(terminalsJs, 'initTerminals'), /if \(first && !stateFilter\.length\) activateTerminal\(first\.id\);/);
});

test('S13: the crawl centers the pitch; the other crawl paragraphs stay justified', () => {
  const justified = '.crawl-text :is(.credits-by, .credits-thanks p, .credits-foot, .maker-pitch)';
  assert.equal(own(creditsCss, justified)['text-align'], 'justify');
  // (0,3,0) beats the justified rule's (0,2,1), which `.credits-thanks p` gives it.
  const pitch = '.crawl-text .credits-zurai .maker-pitch';
  assert.equal(own(creditsCss, pitch)['text-align'], 'center');
  assert.ok(creditsCss.indexOf(pitch) > creditsCss.indexOf(justified));
});

test('S14: an objective that fits sizes its box to its text; a paged one keeps six lines', () => {
  assert.equal(own(overviewCss, '.leftoff-pages').height, '6lh');
  assert.equal(own(overviewCss, '.leftoff-pages.fits').height, 'auto');
  const measure = overviewJs.slice(overviewJs.indexOf('function measure()'));
  // Counted at the page height, so a box that fits can grow pages again on a narrower panel.
  assert.ok(measure.indexOf("box.classList.remove('fits')") > -1, 'measure() must count at the page height');
  assert.ok(measure.indexOf("box.classList.remove('fits')") < measure.indexOf('pageCount('));
  assert.match(overviewJs, /box\.classList\.toggle\('fits', view\.hidden\)/);
  // The pager fix stays.
  assert.match(overviewJs, /box\.focus\(\{ preventScroll: true \}\)/);
});
