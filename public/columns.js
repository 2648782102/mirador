// Resizable columns: a handle between the sidebar and the terminals, and one between the
// terminals and the details panel. Drag them, use the arrow keys (Shift for bigger steps),
// or double-click to go back to the default width. Widths are remembered per window (prefs).
// Each side also hides (wireSide): the terminals take its column, its topbar button brings it
// back, and a hidden side has no handle. In a narrow window a side is a drawer instead
// (features/drawers.js): it takes no column either.
import { $, el, on, prefs, t } from '/core.js';
import { DRAWER_CLASS } from '/drawer-model.js';
import { SIDES, clampColumn, isOpen, sideWidth } from '/side-panels.js';
import { refitAll } from '/terminals.js';

const COLUMNS = {
  sidebar: { variable: '--sidebar-w', min: 200, max: 640, label: 'columns.sidebar' },
  panel: { variable: '--panel-w', min: 280, max: 900, label: 'columns.panel' },
};
/** The terminals keep at least this much width, whatever the columns ask for. */
const MIN_CENTER = 320;
const STEP = 16;

const widths = { ...prefs.read('columns', {}) };
const handles = {};
let refitQueued = false;

function queueRefit() {
  if (refitQueued) return;
  refitQueued = true;
  requestAnimationFrame(() => {
    refitQueued = false;
    refitAll();
  });
}

/** Whether `name` is a drawer now: it has no column, and drawers.js opens and closes it. */
function isDrawer(name) {
  return $('#layout').classList.contains(DRAWER_CLASS[name]);
}

/** The width a column may take now: its own bounds, then room for the terminals and the other side (none when hidden or a drawer). */
function clamp(name, value) {
  const layout = $('#layout');
  const other = name === 'sidebar' ? 'panel' : 'sidebar';
  const otherOpen = !layout.classList.contains(SIDES[other].hiddenClass) && !isDrawer(other);
  return clampColumn(value, COLUMNS[name], { layoutWidth: layout.clientWidth, minCenter: MIN_CENTER, otherWidth: sideWidth(otherOpen, current(other)) });
}

/**
 * Wires hiding a side: its hide button (`.side-hide`), the topbar button that brings it back
 * (`.side-show`, shown by styles.css while the side is hidden), and `toggles` that mirror it
 * with aria-pressed. The state is remembered per window under the side's pref key.
 */
export function wireSide(name, toggles = []) {
  const side = SIDES[name];
  const hide = $(`.side-hide[data-side="${name}"]`);
  const show = $(`.side-show[data-side="${name}"]`);
  const setOpen = (open, { focus = false } = {}) => {
    $('#layout').classList.toggle(side.hiddenClass, !open);
    for (const toggle of toggles) toggle.setAttribute('aria-pressed', String(open));
    prefs.write(side.pref, open);
    // The pressed button disappears with its state: keep the focus on the one that replaces it.
    if (focus) (open ? hide : show).focus();
    refitAll();
  };
  setOpen(isOpen(prefs.read(side.pref, true)));
  // A drawer's hide and topbar buttons close and open the drawer; this window's pref stays as it was.
  hide.addEventListener('click', () => isDrawer(name) || setOpen(false, { focus: true }));
  show.addEventListener('click', () => isDrawer(name) || setOpen(true, { focus: true }));
  for (const toggle of toggles) toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-pressed') !== 'true'));
}

/**
 * The width of a column nobody resized, as styles.css sets it on .layout: clamp(220px, 20vw, 320px)
 * for the tree, or clamp(220px, 26vw, 300px) while the panel is a drawer, and clamp(300px, 25vw,
 * 420px) for the panel. A drawer side takes the design's drawer width (320px and 400px).
 */
function defaultWidth(name) {
  const vw = window.innerWidth;
  const between = (low, value, high) => Math.round(Math.min(high, Math.max(low, value)));
  if (isDrawer(name)) return name === 'sidebar' ? 320 : 400;
  if (name === 'panel') return between(300, vw * 0.25, 420);
  return isDrawer('panel') ? between(220, vw * 0.26, 300) : between(220, vw * 0.2, 320);
}

function current(name) {
  return widths[name] ?? defaultWidth(name);
}

function apply(name, value, { save = false } = {}) {
  const column = COLUMNS[name];
  const width = clamp(name, value);
  widths[name] = width;
  $('#layout').style.setProperty(column.variable, `${width}px`);
  const handle = handles[name];
  handle.setAttribute('aria-valuenow', String(width));
  handle.setAttribute('aria-valuemax', String(column.max));
  if (save) prefs.write('columns', widths);
  queueRefit();
}

function reset(name) {
  delete widths[name];
  $('#layout').style.removeProperty(COLUMNS[name].variable);
  prefs.write('columns', widths);
  handles[name].setAttribute('aria-valuenow', String(current(name)));
  queueRefit();
}

function makeHandle(name) {
  const column = COLUMNS[name];
  const handle = el('div', {
    class: 'col-handle',
    role: 'separator',
    tabindex: 0,
    'data-col': name,
    'aria-orientation': 'vertical',
    'aria-valuemin': String(column.min),
    'aria-valuemax': String(column.max),
    'aria-valuenow': String(current(name)),
  });
  // The sidebar grows to the right, the panel to the left.
  const direction = name === 'sidebar' ? 1 : -1;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing-cols');
    const startX = event.clientX;
    const startWidth = current(name);
    const move = (e) => apply(name, startWidth + (e.clientX - startX) * direction);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-cols');
      prefs.write('columns', widths);
      refitAll();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop, { once: true });
    handle.addEventListener('pointercancel', stop, { once: true });
  });
  handle.addEventListener('dblclick', () => reset(name));
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? STEP * 4 : STEP;
    if (event.key === 'ArrowRight') apply(name, current(name) + step * direction, { save: true });
    else if (event.key === 'ArrowLeft') apply(name, current(name) - step * direction, { save: true });
    else if (event.key === 'Home' || event.key === 'Escape') reset(name);
    else return;
    event.preventDefault();
  });
  return handle;
}

function applyLabels() {
  for (const [name, handle] of Object.entries(handles)) {
    const label = t(COLUMNS[name].label);
    handle.setAttribute('aria-label', label);
    handle.title = label;
  }
}

/** Fits the saved widths to the window again, without saving (a smaller window, a side that became a drawer). */
export function refitColumns() {
  for (const name of Object.keys(COLUMNS)) {
    if (name in widths) apply(name, widths[name]);
    // The default follows the window: keep the handle's value with it.
    else handles[name]?.setAttribute('aria-valuenow', String(current(name)));
  }
}

export async function init() {
  wireSide('sidebar');
  const layout = $('#layout');
  for (const name of Object.keys(COLUMNS)) {
    handles[name] = makeHandle(name);
    layout.append(handles[name]);
  }
  applyLabels();
  refitColumns();
  // A smaller window can leave saved widths too wide: fit them again, without saving.
  window.addEventListener('resize', refitColumns);
  on('language', applyLabels);
}
