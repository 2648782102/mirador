// Theme selection: the three themes, the light default
// for anything unknown, and the stylesheet contract that every theme but light has its own
// `:root[data-theme="…"]` block over the same token names feature CSS consumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_THEME, THEMES, normalizeTheme } from '../public/theme-model.js';

const sheet = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
/** The declarations of the first block that starts with exactly `selector {`. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `rule ${selector} is missing`);
  return css.slice(at, css.indexOf('}', at));
}

test('S1/S6: there are three themes, light first and the default', () => {
  assert.deepEqual(THEMES, ['light', 'dark', 'gentleman']);
  assert.equal(DEFAULT_THEME, 'light');
});

test('S1/S6: a known theme name is kept as is', () => {
  for (const name of THEMES) assert.equal(normalizeTheme(name), name);
});

test('S1: anything unknown falls back to light', () => {
  for (const value of [null, undefined, '', 'claro', 'oscuro', 'Dark', ' dark', 'solarized', 42, {}, ['dark'], true]) {
    assert.equal(normalizeTheme(value), 'light', `normalizeTheme(${JSON.stringify(value)})`);
  }
});

test('S1: the stylesheet keeps every token feature CSS consumes in the light :root block', () => {
  const root = block(sheet, ':root');
  for (const name of ['bg', 'surface', 'surface-2', 'border', 'text', 'muted', 'accent', 'accent-soft', 'row-selected', 'ok', 'warn', 'danger', 'radius', 'font-ui', 'font-mono']) {
    assert.match(root, new RegExp(`--${name}:`), `--${name} is missing from :root`);
  }
  assert.match(root, /color-scheme:\s*light/);
});

test('S1/S6: every theme but light has its own block, and dark themes say so to the browser', () => {
  for (const name of THEMES.filter((theme) => theme !== 'light')) {
    assert.match(block(sheet, `:root[data-theme="${name}"]`), /color-scheme:\s*dark/);
  }
});

test('S6: Gentleman motion runs only when the user has not asked for reduced motion', () => {
  const at = sheet.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.notEqual(at, -1, 'the no-preference motion block is missing');
  const uses = [...sheet.matchAll(/animation:\s*gd-breathe/g)].map((match) => match.index);
  assert.ok(uses.length > 0, 'the breathe animation is not used');
  const end = sheet.indexOf('\n}\n', at);
  for (const index of uses) assert.ok(index > at && index < end, 'breathe is applied outside the no-preference block');
});
