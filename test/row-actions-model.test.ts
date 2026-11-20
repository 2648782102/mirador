// Sidebar row actions never cover the folder or workspace name (public/features/row-actions-model.js):
// the name keeps a guaranteed minimum width, the actions take what is left, and those that do not
// fit move, in order, into the row's "⋯" menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAME_MIN_PX, inlineActionCount, nameMinimum, showsMore } from '../public/features/row-actions-model.js';

test('every action stays inline, without "⋯", when they all fit beside the name minimum', () => {
  // 72 name + 4 + 40 + 4 + 30 + 4 + 50 = 204: a gap also separates the name from the first action.
  const fit = { available: 204, nameMin: 72, moreWidth: 24, widths: [40, 30, 50], gap: 4 };
  assert.equal(inlineActionCount(fit), 3);
  assert.equal(showsMore(3, 3), false);
});

test('actions that do not fit move, in order, into "⋯": as many stay inline as fit beside it', () => {
  // 72 + 4 + 40 + 4 + 30 + 4 + 24 = 178 fits; all three without "⋯" need 204.
  const fit = { available: 203, nameMin: 72, moreWidth: 24, widths: [40, 30, 50], gap: 4 };
  assert.equal(inlineActionCount(fit), 2);
  assert.equal(showsMore(2, 3), true);
  assert.equal(inlineActionCount({ ...fit, available: 177 }), 1, 'one pixel short of two plus "⋯"');
});

test('when no action fits, only "⋯" is shown, and the count is never negative', () => {
  assert.equal(inlineActionCount({ available: 100, nameMin: 72, moreWidth: 24, widths: [40, 30], gap: 4 }), 0);
  assert.equal(showsMore(0, 2), true);
  assert.equal(inlineActionCount({ available: 20, nameMin: 72, moreWidth: 24, widths: [40, 30], gap: 4 }), 0, 'less room than the name minimum');
  assert.equal(inlineActionCount({ available: Number.NaN, nameMin: 72, moreWidth: 24, widths: [40], gap: 4 }), 0, 'an unmeasured row');
});

test('a row without actions shows nothing inline and no "⋯" unless its menu always has entries', () => {
  assert.equal(inlineActionCount({ available: 300, nameMin: 72, moreWidth: 24, widths: [], gap: 4 }), 0);
  assert.equal(showsMore(0, 0), false);
  assert.equal(showsMore(0, 0, true), true, 'a workspace row keeps "⋯" for rename and remove');
});

test('a menu that always has entries takes its room even when every action would fit without it', () => {
  // 72 + 4 + 40 + 4 + 30 = 150 fits alone, but "⋯" (4 + 24) is always there: 178 > 160.
  const fit = { available: 160, nameMin: 72, moreWidth: 24, widths: [40, 30], gap: 4, alwaysMore: true };
  assert.equal(inlineActionCount(fit), 1);
  assert.equal(showsMore(1, 2, true), true);
  assert.equal(inlineActionCount({ ...fit, available: 178 }), 2);
});

test('the name minimum is always respected: inline actions plus "⋯" never take its room', () => {
  for (let available = 0; available <= 400; available += 7) {
    const widths = [52, 36, 61, 44, 28];
    const fit = { available, nameMin: 72, moreWidth: 24, widths, gap: 4 };
    const count = inlineActionCount(fit);
    assert.ok(Number.isInteger(count) && count >= 0 && count <= widths.length, `count ${count} at ${available}`);
    const shown = widths.slice(0, count);
    const items = shown.length + (showsMore(count, widths.length) ? 1 : 0);
    const used = shown.reduce((sum, width) => sum + width, 0) + (showsMore(count, widths.length) ? 24 : 0) + Math.max(0, items - 1) * 4;
    // A gap separates the name from the first action.
    const actionsRoom = available - 72 - (items ? 4 : 0);
    assert.ok(used <= actionsRoom || count === 0, `actions use ${used} of ${actionsRoom} at ${available}`);
  }
});

test('the name minimum is the guaranteed width, or the whole name when it is shorter', () => {
  assert.equal(nameMinimum(200), NAME_MIN_PX);
  assert.equal(nameMinimum(30), 30);
  assert.equal(nameMinimum(-5), 0);
  assert.equal(nameMinimum(Number.NaN), NAME_MIN_PX, 'an unmeasured name keeps the guaranteed width');
});

test('degenerate measurements still give a non-negative whole count', () => {
  for (const bad of [{}, { available: -5 }, { available: 100, widths: [NaN] }, { available: 100, widths: [10, 10], gap: NaN }, { available: 100, nameMin: NaN, widths: [10] }]) {
    const count = inlineActionCount(bad as never);
    assert.ok(Number.isInteger(count) && count >= 0, JSON.stringify(bad));
  }
});

test('a row action that left the row stays hidden even when it holds an svg icon', () => {
  // `.btn:has(> svg.icon)` sets display: inline-flex at a higher specificity than `.row-actions > [hidden]`,
  // so the hidden rule must be !important or an icon button fitRow hid would still show in the row.
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.btn:has\(> svg\.icon\)\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.row-actions > \[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
