// Collapsible side panels of the Development view:
// each side is open until this window hid it. A hidden side gives its whole column to the
// terminals and its topbar button (the design's i-sidebar / i-panel)
// brings it back; the 28 px rails are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIDES, clampColumn, isOpen, sideWidth } from '../public/side-panels.js';

const sheet = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
/** The declarations of the first block that starts with exactly `selector {`. */
function block(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `rule ${selector} is missing`);
  return css.slice(at, css.indexOf('}', at));
}

test('a hidden side takes no width; an open side takes its column width', () => {
  assert.equal(sideWidth(false, 360), 0);
  assert.equal(sideWidth(true, 360), 360);
});

test('the clamp leaves room for the terminals, not for a hidden side', () => {
  const sidebar = { min: 200, max: 640 };
  // 900 px window, 320 px kept for the terminals, the panel hidden.
  assert.equal(clampColumn(900, sidebar, { layoutWidth: 900, minCenter: 320, otherWidth: sideWidth(false, 360) }), 580);
});

test('the clamp keeps its existing bounds when both sides are open', () => {
  const sidebar = { min: 200, max: 640 };
  assert.equal(clampColumn(900, sidebar, { layoutWidth: 1600, minCenter: 320, otherWidth: 360 }), 640);
  assert.equal(clampColumn(900, sidebar, { layoutWidth: 900, minCenter: 320, otherWidth: 360 }), 220);
  assert.equal(clampColumn(900, sidebar, { layoutWidth: 700, minCenter: 320, otherWidth: 360 }), 200);
});

test('each side is open until this window saved it hidden; the panel keeps its panelOpen key', () => {
  assert.equal(isOpen(undefined), true);
  assert.equal(isOpen(true), true);
  assert.equal(isOpen(false), false);
  assert.deepEqual(SIDES.panel, { pref: 'panelOpen', hiddenClass: 'panel-hidden' });
  assert.deepEqual(SIDES.sidebar, { pref: 'sidebarOpen', hiddenClass: 'sidebar-hidden' });
});

test('a hidden side gives its column to the terminals, loses its resize handle, and shows its topbar button', () => {
  assert.doesNotMatch(sheet, /--rail-w|\.side-rail/);
  assert.match(block(sheet, '.layout.sidebar-hidden'), /grid-template-columns:\s*minmax\(0, 1fr\) var\(--panel-w, 360px\)/);
  assert.match(block(sheet, '.layout.panel-hidden'), /grid-template-columns:\s*var\(--sidebar-w, 300px\) minmax\(0, 1fr\)/);
  assert.match(block(sheet, '.layout.sidebar-hidden.panel-hidden'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(block(sheet, '.layout.sidebar-hidden > .sidebar, .layout.panel-hidden > .panel'), /display:\s*none/);
  // The button shows while its side is hidden or a drawer, and never over Seguimiento (#layout[hidden]).
  assert.match(block(sheet, '.topbar .btn.side-show'), /display:\s*none/);
  assert.match(
    block(sheet, 'body:has(> #layout:is(.sidebar-hidden, .drawer-sidebar):not([hidden])) .side-show[data-side="sidebar"],\nbody:has(> #layout:is(.panel-hidden, .drawer-panel):not([hidden])) .side-show[data-side="panel"]'),
    /display:\s*inline-flex/,
  );
  assert.match(block(sheet, '.layout.sidebar-hidden .col-handle[data-col="sidebar"]'), /display:\s*none/);
  assert.match(block(sheet, '.layout.panel-hidden .col-handle[data-col="panel"]'), /display:\s*none/);
});

test('each side has a hide button in its header and a topbar button that names it', () => {
  for (const side of ['sidebar', 'panel']) {
    assert.match(page, new RegExp(`<button type="button" class="btn icon side-hide" data-side="${side}"[^>]*data-i18n-label="side\\.hide\\.${side}"`));
    assert.match(page, new RegExp(`<button type="button" class="btn icon icon-btn side-show show-${side === 'sidebar' ? 'side' : 'panel'}" data-side="${side}" aria-controls="${side}" aria-expanded="false" data-i18n-label="side\\.show\\.${side}"`));
  }
  assert.doesNotMatch(page, /side-rail/);
});

test('the topbar has no "Resumen diario" toggle: the panel hides from its own » and comes back from its i-panel button', () => {
  assert.doesNotMatch(page, /id="toggle-panel"/);
  assert.match(page, /class="[^"]*side-hide"[^>]*data-side="panel"/);
  assert.match(page, /class="[^"]*side-show[^"]*" data-side="panel"[^>]*><svg class="icon" aria-hidden="true" focusable="false"><use href="#i-panel"\/><\/svg><\/button>/);
});
