// Every fold of "Dónde quedó" (Siguientes pasos, Hecho, ...) turns pages like the objective, so a
// long list never makes the sidebar scroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const overviewJs = readFileSync(new URL('../public/features/overview.js', import.meta.url), 'utf8');
const overviewCss = readFileSync(new URL('../public/styles/overview.css', import.meta.url), 'utf8');

test("a fold's body is a paged box with the objective's pager, named after the fold", () => {
  const fold = overviewJs.slice(overviewJs.indexOf('function foldView'), overviewJs.indexOf('function pagedBox'));
  // The text is Engram's, marked English for the browser's translator.
  assert.match(fold, /pagedBox\(panel\.markMemory\(renderMarkdown\(text, textOptions\)\), t\(fold\.title\), 'fold'\)/);
  // The goal comes whole (test/overview-api.test.ts), as Markdown when it spans lines (test/leftoff-reading.test.ts).
  assert.match(overviewJs, /pagedBox\(panel\.markMemory\(goalText\(summary\.goal, textOptions\)\), t\('overview\.goal'\)\)/);
  assert.doesNotMatch(overviewJs, /goalPages/);
});

test('a fold page is taller than the objective page, and an item never splits across pages', () => {
  assert.match(overviewCss, /\.leftoff-pages\.fold-pages \{ height: 12lh; \}/);
  assert.match(overviewCss, /\.leftoff-pages\.fold-pages\.fits \{ height: auto; \}/);
  assert.match(overviewCss, /\.fold-pages li \{ break-inside: avoid; \}/);
});
