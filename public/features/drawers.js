// Responsive drawers: under 1280px the panel, and under 960px the sidebar too, leave their column, and their
// topbar button (the design's i-panel and i-sidebar) opens the side as a drawer over the
// terminals. One click on the other button swaps drawers. An open drawer is modal: everything
// behind it is inert but the two drawer buttons, and Tab and Shift+Tab wrap inside it. Its hide
// button, the scrim, Esc or its topbar button close it and give the focus back to the button
// that opened it. This window's sidebarOpen and panelOpen prefs are left as they were: back in a
// wide window each side takes them again. Rules: public/drawer-model.js.
import { $, el, prefs } from '/core.js';
import { refitColumns } from '/columns.js';
import { DRAWER_CLASS, DRAWER_OPENER, drawerSides, focusTarget, inertRegions, nextOpen, trapTab } from '/drawer-model.js';
import { SIDES, isOpen } from '/side-panels.js';
import { refitAll } from '/terminals.js';

const SIDE_ELEMENT = { sidebar: '#sidebar', panel: '#panel' };
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';

let sides = [];
let open = null;

/** Opens the drawer `next` (or closes the open one with null); `focus` moves the focus with it. */
function setOpen(next, { focus = false } = {}) {
  const layout = $('#layout');
  const was = open;
  open = next;
  if (open) layout.dataset.open = open;
  else delete layout.dataset.open;
  for (const name of Object.keys(SIDES)) $(DRAWER_OPENER[name]).setAttribute('aria-expanded', String(open === name));
  // Only the regions this module made inert are given back.
  for (const node of document.querySelectorAll('[data-drawer-inert]')) {
    node.inert = false;
    delete node.dataset.drawerInert;
  }
  for (const node of document.querySelectorAll(inertRegions(open).join(', ') || ':not(*)')) {
    node.inert = true;
    node.dataset.drawerInert = '';
  }
  const target = focus && focusTarget(was, open);
  if (target) $(target).focus();
}

/** The tab stops of the open drawer, in document order. */
function tabStops(drawer) {
  return [...drawer.querySelectorAll(FOCUSABLE)].filter((node) => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0);
}

/** Keeps Tab and Shift+Tab inside the open drawer (drawer-model.js trapTab). */
function trapFocus(event, drawer) {
  const stops = tabStops(drawer);
  const active = document.activeElement;
  let index = stops.indexOf(active);
  if (index < 0 && drawer.contains(active)) {
    // An element the drawer focuses itself (a menu item, tabindex -1) sits between the stops
    // around it: Tab wraps only with no stop after it, Shift+Tab only with none before it.
    const after = stops.findIndex((stop) => active.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING);
    const following = after < 0 ? stops.length : after;
    index = event.shiftKey ? following : following - 1;
  }
  const next = trapTab({ index, count: stops.length, shift: event.shiftKey });
  if (next === null) return;
  event.preventDefault();
  stops[next].focus();
}

/** Turns the sides into drawers or columns for the window width, when that changes. */
function applyMode() {
  const next = drawerSides(window.innerWidth);
  if (next.join() === sides.join()) return;
  sides = next;
  const layout = $('#layout');
  for (const [name, side] of Object.entries(SIDES)) {
    const drawer = sides.includes(name);
    layout.classList.toggle(DRAWER_CLASS[name], drawer);
    // A drawer waits for its topbar button; a column again takes this window's pref.
    layout.classList.toggle(side.hiddenClass, !drawer && !isOpen(prefs.read(side.pref, true)));
  }
  // A drawer that becomes a column again closes, and the background stops being inert.
  setOpen(nextOpen(open, { action: 'resize', sides }));
  refitColumns();
  refitAll();
}

export async function init() {
  const layout = $('#layout');
  layout.append(el('div', { class: 'drawer-scrim', 'aria-hidden': 'true', onclick: () => setOpen(null, { focus: true }) }));
  for (const name of Object.keys(SIDES)) {
    // columns.js wireSide leaves these clicks alone while the side is a drawer.
    $(DRAWER_OPENER[name]).addEventListener('click', () => {
      if (sides.includes(name)) setOpen(nextOpen(open, { action: 'toggle', side: name, sides }), { focus: true });
    });
    $(`.side-hide[data-side="${name}"]`).addEventListener('click', () => {
      if (sides.includes(name)) setOpen(null, { focus: true });
    });
  }
  document.addEventListener('keydown', (event) => {
    if (!open || event.defaultPrevented || !(event.key === 'Escape' || event.key === 'Tab')) return;
    // A dialog opened from the drawer (public/dialog.js) keeps its own keys; a menu that closes
    // on Esc prevents the default and keeps the drawer open.
    if (event.target instanceof Element && event.target.closest('dialog')) return;
    if (event.key === 'Tab') return trapFocus(event, $(SIDE_ELEMENT[open]));
    event.preventDefault();
    setOpen(null, { focus: true });
  });
  applyMode();
  window.addEventListener('resize', applyMode);
}
