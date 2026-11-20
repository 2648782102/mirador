// Pure rules behind the collapsible side columns of the Development view (public/columns.js
// wires them): a hidden side gives its column to the terminals and its topbar button brings it
// back, remembered per window.

/** Each side: its per-window pref key and the #layout class that hides it. */
export const SIDES = {
  sidebar: { pref: 'sidebarOpen', hiddenClass: 'sidebar-hidden' },
  panel: { pref: 'panelOpen', hiddenClass: 'panel-hidden' },
};

/** A side is open unless this window saved it hidden. */
export function isOpen(saved) {
  return saved !== false;
}

/** The width a side takes from the window: its column when open, none when hidden. */
export function sideWidth(open, width) {
  return open ? width : 0;
}

/**
 * The width a column may take: its own bounds ({ min, max }), then room for the terminals
 * (`minCenter`) and for the other side (`otherWidth`, see sideWidth). `min` wins over the room.
 */
export function clampColumn(value, { min, max }, { layoutWidth, minCenter, otherWidth }) {
  const room = layoutWidth - minCenter - otherWidth;
  return Math.round(Math.max(min, Math.min(max, room, value)));
}
