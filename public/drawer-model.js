// Pure rules behind the responsive drawers (public/features/drawers.js wires them): under
// 1280px the panel folds into a drawer over the terminals, under 960px the sidebar too.
// A closed drawer opens from its topbar button; one drawer is open at a time, and an open
// drawer is modal.

/** Window widths under which each side stops being a column and becomes a drawer. */
export const PANEL_DRAWER_BELOW = 1280;
export const SIDEBAR_DRAWER_BELOW = 960;

/** The #layout class that marks each side as a drawer. */
export const DRAWER_CLASS = { sidebar: 'drawer-sidebar', panel: 'drawer-panel' };

/** The topbar button that opens each side: the design's i-sidebar and i-panel buttons. */
export const DRAWER_OPENER = { sidebar: '.side-show[data-side="sidebar"]', panel: '.side-show[data-side="panel"]' };

/** Each side's element, and what stays behind any open drawer (the two drawer buttons excepted). */
const SIDE_ELEMENT = { sidebar: '#sidebar', panel: '#panel' };
const BACKGROUND = ['.topbar > .brand', '.topbar-slot', '.topbar-actions > :not(.side-show)', '.launch-slot', '#layout > .workspace', '#layout > .col-handle'];

/** The sides that are drawers at this window width, in DOM order. */
export function drawerSides(width) {
  const sides = [];
  if (width < SIDEBAR_DRAWER_BELOW) sides.push('sidebar');
  if (width < PANEL_DRAWER_BELOW) sides.push('panel');
  return sides;
}

/**
 * The open drawer (a side name or null) after an action, with `sides` the current drawer
 * sides (drawerSides): 'open' replaces the open drawer with `side` if it is a drawer,
 * 'toggle' (its topbar button) closes `side` when it is the open one and opens it otherwise,
 * 'close' leaves none open, and 'resize' closes the open one if it stopped being a drawer.
 */
export function nextOpen(open, { action, side, sides }) {
  if (action === 'toggle') return open === side && sides.includes(side) ? null : nextOpen(open, { action: 'open', side, sides });
  if (action === 'open') return sides.includes(side) ? side : open;
  if (action === 'resize') return sides.includes(open) ? open : null;
  return null;
}

/**
 * Where the focus goes when the open drawer changes from `was` to `next`: the hide button of
 * the drawer that opens, or the topbar button of the one that closed. null: it stays.
 */
export function focusTarget(was, next) {
  if (next) return `.side-hide[data-side="${next}"]`;
  return was ? DRAWER_OPENER[was] : null;
}

/** The regions made inert while `open` is the open drawer: all but the drawer and the two drawer buttons. */
export function inertRegions(open) {
  if (!open) return [];
  return [...BACKGROUND, ...Object.entries(SIDE_ELEMENT).filter(([side]) => side !== open).map(([, selector]) => selector)];
}

/**
 * Tab inside an open drawer: the index of its tab stop to focus, or null to let the browser
 * move. `index` is where the focus is among the `count` stops (-1: outside the drawer).
 */
export function trapTab({ index, count, shift }) {
  if (!count) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}
