// Pins T3 (S4 the «Dónde quedó» panel segment fits, S5 a long
// objective reads in pages) to the approved artboard design/state-filter/01-chips-y-acordeon.html.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../public/i18n.js';
// Namespace imports: a rule not built yet fails its own test, not the whole file.
import * as leftoffModel from '../public/leftoff-model.js';
import * as summaryModel from '../public/features/summary-model.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const { leftOffLayout, pageCount, pageKey, pageOffset, pagerView, turnPage } = leftoffModel as any;
const { segmentLabel } = summaryModel as any;

const read = (path: string) => readFileSync(path, 'utf8');
const artboard = readArtboard('design/state-filter/01-chips-y-acordeon.html');
const css = read('public/styles.css');
const overviewCss = read('public/styles/overview.css');
const overviewJs = read('public/features/overview.js');
const summaryJs = read('public/features/summary.js');

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/* ---------- S4: the panel segment fits ---------- */

test('S4: the segment spans the head and its parts shrink by their text, never into equal grid columns', { skip: NO_DESIGN }, () => {
  assert.equal(own(css, '.panel-views.segmented').width, '100%');
  const button = own(css, '.panel-views .btn');
  assert.equal(button.flex, '1 1 auto');
  assert.equal(button['min-width'], '0');
  assert.doesNotMatch(css, /\.panel-views[^{]*\{[^}]*grid-template-columns/);
  // The artboard's .seg.fit parts.
  assert.equal(button.flex, own(artboard, '.seg.fit .btn').flex);
  assert.equal(button['min-width'], own(artboard, '.seg.fit .btn')['min-width']);
});

test('S4: a label shortens with an ellipsis; the count and the hide button never shrink', () => {
  assert.deepEqual(own(css, '.panel-views .lbl'), { 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  assert.equal(own(css, '.panel-views .n').flex, 'none');
  assert.equal(own(css, '.panel-top > .btn').flex, 'none');
});

test('S4: a segment label keeps its trailing count apart, so the ellipsis never hides it', () => {
  assert.deepEqual(segmentLabel('Te esperan (3)'), { label: 'Te esperan', count: '(3)' });
  assert.deepEqual(segmentLabel('Waiting for you (12)'), { label: 'Waiting for you', count: '(12)' });
  assert.deepEqual(segmentLabel('Dónde quedó'), { label: 'Dónde quedó', count: null });
  assert.deepEqual(segmentLabel('Día'), { label: 'Día', count: null });
  // The shipped strings split the same way.
  assert.deepEqual(segmentLabel(MESSAGES.es['panel.view.inbox'].replace('{count}', '0')), { label: 'Te esperan', count: '(0)' });
});

test('S4: the segment buttons and the in-place count update draw the label and the count apart', () => {
  assert.match(summaryJs, /segmentLabel\(/);
  assert.match(summaryJs, /class: 'lbl'/);
  assert.match(summaryJs, /class: 'n'/);
  // "Te esperan (N)" updates in place with the same parts, never as one plain text.
  assert.doesNotMatch(summaryJs, /button\.textContent = viewLabel/);
});

/* ---------- S5: the objective in pages ---------- */

test('S5: the page count comes from the scroll width, one column per box width plus the gap', () => {
  assert.equal(pageCount(300, 300, 32), 1);
  assert.equal(pageCount(632, 300, 32), 2);
  assert.equal(pageCount(964, 300, 32), 3);
  assert.equal(pageCount(631.5, 300, 32), 2, 'sub-pixel widths round');
  assert.equal(pageCount(120, 300, 32), 1, 'a short objective is one page');
  assert.equal(pageCount(0, 0, 32), 1, 'a hidden box is one page');
});

test('S5: pages turn one at a time and stop at both ends', () => {
  assert.equal(turnPage(0, 1, 3), 1);
  assert.equal(turnPage(1, -1, 3), 0);
  assert.equal(turnPage(0, -1, 3), 0);
  assert.equal(turnPage(2, 1, 3), 2);
  assert.equal(turnPage(5, 0, 2), 1, 'a page past the end after a resize clamps to the last one');
  assert.equal(turnPage(0, 1, 1), 0);
  assert.equal(pageOffset(2, 300, 32), 664);
  assert.equal(pageOffset(0, 300, 32), 0);
});

test('S5: the pager says n / m, disables ‹ on the first page and › on the last, and hides for one page', () => {
  assert.deepEqual(pagerView(0, 3), { page: 1, total: 3, hidden: false, prevDisabled: true, nextDisabled: false });
  assert.deepEqual(pagerView(1, 3), { page: 2, total: 3, hidden: false, prevDisabled: false, nextDisabled: false });
  assert.deepEqual(pagerView(2, 3), { page: 3, total: 3, hidden: false, prevDisabled: false, nextDisabled: true });
  assert.deepEqual(pagerView(0, 1), { page: 1, total: 1, hidden: true, prevDisabled: true, nextDisabled: true });
});

test('S5: arrow and page keys turn the page; other keys do nothing', () => {
  assert.equal(pageKey('ArrowRight'), 1);
  assert.equal(pageKey('PageDown'), 1);
  assert.equal(pageKey('ArrowLeft'), -1);
  assert.equal(pageKey('PageUp'), -1);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'a', 'Enter']) assert.equal(pageKey(key), 0, key);
});

test('S5: the pages box is six lines high, one column as wide as the box, and turns smoothly only without reduced motion', { skip: NO_DESIGN }, () => {
  const pages = own(overviewCss, '.leftoff-pages');
  assert.equal(pages.height, '6lh');
  assert.equal(pages.height, own(artboard, '.goal-pages').height);
  assert.equal(pages.columns, '1');
  assert.equal(pages['column-fill'], 'auto');
  assert.equal(pages['column-gap'], own(artboard, '.goal-pages')['column-gap']);
  assert.equal(pages.overflow, 'hidden');
  assert.equal(pages['scroll-behavior'], undefined);
  assert.match(overviewCss, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.leftoff-pages \{ scroll-behavior: smooth; \}/);
  assert.equal(own(overviewCss, '.leftoff-pager[hidden]').display, 'none');
  // The reading face stays on .leftoff-read alone: the box carries that class.
  assert.match(overviewJs, /class: 'leftoff-read leftoff-pages'/);
});

test('S5: the objective is a focusable paged region with ‹ n / m › that recounts on resize and content changes', () => {
  for (const needle of [
    "from '/leftoff-model.js'",
    'pageCount(',
    'turnPage(',
    'pagerView(',
    'pageKey(e.key)',
    "role: 'region'",
    "'aria-roledescription': t('overview.pages.role')",
    "'aria-live': 'polite'",
    "'aria-controls'",
    "t('overview.pages.prev')",
    "t('overview.pages.next')",
    "t('overview.pages.group')",
    "t('overview.pages.where'",
    "addEventListener('keydown'",
    'new ResizeObserver(',
    'new MutationObserver(',
  ]) {
    assert.ok(overviewJs.includes(needle), `overview.js should contain ${needle}`);
  }
});

test('S5: the pager copy is the artboard one in es, with an English twin', { skip: NO_DESIGN }, () => {
  assert.equal(MESSAGES.es['overview.pages.prev'], 'Página anterior del objetivo');
  assert.equal(MESSAGES.es['overview.pages.next'], 'Página siguiente del objetivo');
  assert.equal(MESSAGES.es['overview.pages.group'], 'Páginas del objetivo');
  assert.equal(MESSAGES.es['overview.pages.role'], 'texto paginado');
  assert.equal(MESSAGES.es['overview.pages.where'], 'Objetivo, página {page} de {total}');
  assert.equal(MESSAGES.es['overview.pages.count'], '{page} / {total}');
  for (const key of ['prev', 'next', 'group', 'role', 'where', 'count']) assert.ok(MESSAGES.en[`overview.pages.${key}`], key);
  assert.equal(MESSAGES.en['overview.pages.prev'], 'Previous page of the goal');
  assert.equal(MESSAGES.en['overview.pages.next'], 'Next page of the goal');
  // The artboard's own strings.
  assert.match(artboard, /aria-label="Página anterior del objetivo"/);
  assert.match(artboard, /aria-label="Página siguiente del objetivo"/);
});

/* ---------- PRESERVE ---------- */

test('PRESERVE: a long objective is still read first, and next steps still fold open after it', () => {
  const goal = 'Dialysis shift schedule with a quota per chair. '.repeat(30);
  const layout = leftOffLayout({
    lastAt: '2026-11-05 10:44:00',
    lastDay: '2026-11-05',
    hasMemory: true,
    leftOff: { summary: { at: '2026-11-05 10:42:00', goal, nextSteps: '- Push the branch.', accomplished: '- T3 done.' }, memory: null },
  });
  assert.deepEqual(layout.read, ['goal']);
  assert.deepEqual(layout.folds.map((fold: any) => [fold.id, fold.open]), [['next', true], ['done', false]]);
});
