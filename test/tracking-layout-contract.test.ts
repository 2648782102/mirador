// Contract of the Seguimiento layout: the
// stylesheets keep the rules that give the view no page scroll, one bounded scroll per
// module, and a four-sided accent border on a hovered segmented button (wox5vczj).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sheet = (file: string) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
/** The declarations of the first block that starts with exactly `selector {`. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `rule ${selector} is missing`);
  return css.slice(at, css.indexOf('}', at));
}

test('S1: the tracking view fills the window and only its lanes and panes scroll', () => {
  const css = sheet('styles/tracking.css');
  assert.match(block(css, '.app-view'), /overflow:\s*hidden/);
  assert.match(block(css, '.tracking'), /height:\s*100%/);
  assert.match(block(css, '.tracking-scroll'), /overflow:\s*auto/);
  assert.match(block(css, '.tracking-scroll'), /min-height:\s*0/);
  assert.match(block(css, '.tracking-lane'), /min-height:\s*0/);
  assert.match(block(css, '.tracking-dock'), /min-height:\s*0/);
});

test('L4 (wox5vczj): segmented buttons overlap the shared edge instead of dropping the left border', () => {
  const css = sheet('styles.css');
  assert.doesNotMatch(block(css, '.segmented .btn:last-child'), /border-left:\s*0/);
  assert.match(block(css, '.segmented .btn'), /position:\s*relative/);
  assert.match(block(css, '.segmented .btn + .btn'), /margin-left:\s*-1px/);
  assert.match(block(css, '.segmented .btn:hover, .segmented .btn:focus-visible'), /z-index:\s*2/);
  assert.match(block(css, '.segmented .btn[aria-pressed="true"]'), /z-index:\s*1/);
});
