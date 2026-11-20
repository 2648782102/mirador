// Responsive drawers: under 1280px the panel becomes a
// drawer over the terminals, under 960px the sidebar too; one drawer is open at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAWER_CLASS, DRAWER_OPENER, PANEL_DRAWER_BELOW, SIDEBAR_DRAWER_BELOW, drawerSides, focusTarget, inertRegions, nextOpen, trapTab } from '../public/drawer-model.js';

test('the panel is a drawer under 1280px and the sidebar too under 960px', () => {
  assert.equal(PANEL_DRAWER_BELOW, 1280);
  assert.equal(SIDEBAR_DRAWER_BELOW, 960);
  assert.deepEqual(drawerSides(1279), ['panel']);
  assert.deepEqual(drawerSides(1200), ['panel']);
  assert.deepEqual(drawerSides(960), ['panel']);
  assert.deepEqual(drawerSides(959), ['sidebar', 'panel']);
  assert.deepEqual(drawerSides(900), ['sidebar', 'panel']);
  assert.deepEqual(drawerSides(720), ['sidebar', 'panel']);
});

test('wide screens have no drawer: both sides keep their columns, resize and hide', () => {
  assert.deepEqual(drawerSides(1280), []);
  assert.deepEqual(drawerSides(1920), []);
  assert.deepEqual(drawerSides(2560), []);
});

test('each drawer side marks #layout with its own class', () => {
  assert.deepEqual(DRAWER_CLASS, { sidebar: 'drawer-sidebar', panel: 'drawer-panel' });
});

test('opening a drawer replaces the open one; closing leaves none open', () => {
  const sides = ['sidebar', 'panel'];
  assert.equal(nextOpen(null, { action: 'open', side: 'panel', sides }), 'panel');
  assert.equal(nextOpen('panel', { action: 'open', side: 'sidebar', sides }), 'sidebar');
  assert.equal(nextOpen('sidebar', { action: 'open', side: 'sidebar', sides }), 'sidebar');
  assert.equal(nextOpen('panel', { action: 'close', sides }), null);
  assert.equal(nextOpen(null, { action: 'close', sides }), null);
});

test('a side that is not a drawer does not open as one', () => {
  assert.equal(nextOpen(null, { action: 'open', side: 'sidebar', sides: ['panel'] }), null);
  assert.equal(nextOpen('panel', { action: 'open', side: 'sidebar', sides: ['panel'] }), 'panel');
  assert.equal(nextOpen(null, { action: 'open', side: 'panel', sides: [] }), null);
});

test('when the window grows, an open drawer that stops being a drawer closes', () => {
  assert.equal(nextOpen('sidebar', { action: 'resize', sides: ['panel'] }), null);
  assert.equal(nextOpen('panel', { action: 'resize', sides: [] }), null);
  assert.equal(nextOpen('panel', { action: 'resize', sides: ['panel'] }), 'panel');
  assert.equal(nextOpen('panel', { action: 'resize', sides: ['sidebar', 'panel'] }), 'panel');
  assert.equal(nextOpen(null, { action: 'resize', sides: ['sidebar', 'panel'] }), null);
});

// The topbar opens each drawer, an open drawer is
// modal, and one click on the other drawer's button swaps them.

test('each drawer opens from its topbar button, as the artboard i-sidebar and i-panel buttons', () => {
  assert.deepEqual(DRAWER_OPENER, { sidebar: '.side-show[data-side="sidebar"]', panel: '.side-show[data-side="panel"]' });
});

test('S7: a topbar button toggles its drawer, and one click on the other button swaps them', () => {
  const sides = ['sidebar', 'panel'];
  assert.equal(nextOpen(null, { action: 'toggle', side: 'panel', sides }), 'panel');
  assert.equal(nextOpen('panel', { action: 'toggle', side: 'panel', sides }), null);
  assert.equal(nextOpen('panel', { action: 'toggle', side: 'sidebar', sides }), 'sidebar');
  assert.equal(nextOpen('sidebar', { action: 'toggle', side: 'panel', sides }), 'panel');
  // A column is not a drawer: its button does not touch the open one.
  assert.equal(nextOpen('panel', { action: 'toggle', side: 'sidebar', sides: ['panel'] }), 'panel');
});

test('S6: the focus goes to the hide button of the drawer that opens, and back to the button that opened it on close', () => {
  assert.equal(focusTarget(null, 'panel'), '.side-hide[data-side="panel"]');
  assert.equal(focusTarget('sidebar', 'panel'), '.side-hide[data-side="panel"]');
  assert.equal(focusTarget('panel', null), '.side-show[data-side="panel"]');
  assert.equal(focusTarget('sidebar', null), '.side-show[data-side="sidebar"]');
  assert.equal(focusTarget(null, null), null);
});

test('S6: while a drawer is open everything behind it is inert, except the two drawer buttons', () => {
  assert.deepEqual(inertRegions(null), []);
  const behindPanel = inertRegions('panel');
  assert.deepEqual(behindPanel, ['.topbar > .brand', '.topbar-slot', '.topbar-actions > :not(.side-show)', '.launch-slot', '#layout > .workspace', '#layout > .col-handle', '#sidebar']);
  const behindSidebar = inertRegions('sidebar');
  assert.ok(behindSidebar.includes('#panel'));
  assert.ok(!behindSidebar.includes('#sidebar'));
  // The modals slot stays live: a dialog opened from the drawer (public/dialog.js) must work.
  for (const regions of [behindPanel, behindSidebar]) assert.ok(!regions.some((selector) => /modals|dialog|overlay/.test(selector)));
});

test('S6: Tab and Shift+Tab wrap at the ends of the drawer, and come back into it from outside', () => {
  assert.equal(trapTab({ index: 4, count: 5, shift: false }), 0);
  assert.equal(trapTab({ index: 0, count: 5, shift: true }), 4);
  assert.equal(trapTab({ index: 2, count: 5, shift: false }), null);
  assert.equal(trapTab({ index: 2, count: 5, shift: true }), null);
  assert.equal(trapTab({ index: -1, count: 5, shift: false }), 0);
  assert.equal(trapTab({ index: -1, count: 5, shift: true }), 4);
  assert.equal(trapTab({ index: 0, count: 1, shift: false }), 0);
  assert.equal(trapTab({ index: -1, count: 0, shift: false }), null);
});
