// Pure rules of the summary panel: the folder it shows, the views
// of its segment, the view each kind of selection opens on, the migration of the old preferences, and
// how the view and the sections above it reach the panel body. No DOM and no imports: the browser (public/features/summary.js)
// and test/summary-model.test.ts use it.

// A workspace opens on its summary, a folder on "Dónde quedó" and "nothing selected" on the daily view,
// until the user picks another.
export const DEFAULT_VIEWS = { workspace: 'overview', folder: 'leftoff', none: 'daily' };

/**
 * The version of the saved 'panelViews'. Before version 2 a folder had only the daily view, so a
 * folder id saved then was never a choice and gives way to the default.
 */
export const PANEL_VIEWS_VERSION = 2;

/** The 'panelViews' preference to write for the chosen `views`. */
export function storedViews(views) {
  return { ...views, v: PANEL_VIEWS_VERSION };
}

/**
 * The panel's segment (artboard 03 "Te esperan (N) | Dónde quedó | Día"): the inbox first, then
 * the registered `views` that apply to `selection` in their order, and the daily view last.
 */
export function orderViews(views, selection, { inbox, daily }) {
  return [inbox, ...views.filter((view) => view.applies(selection)), daily];
}

/**
 * What of the panel a view shows besides its head: the inbox cards (the 'inbox' slot), the
 * date nav (only the daily view, "Día") and the panel body (every view but the inbox).
 */
export function viewParts(id) {
  return { inbox: id === 'inbox', dateNav: id === 'daily', body: id !== 'inbox' };
}

/**
 * "Te esperan (N)": of the inbox items (the `inbox` event), the ones that need an answer, not the
 * finished turns, and not the terminal on screen (`inViewId`, or null), which the list leaves out too.
 */
export function waitingCount(items, inViewId) {
  return Array.isArray(items) ? items.filter((item) => item.kind !== 'finished' && item.terminalId !== inViewId).length : 0;
}

/**
 * A segment button's text as its label and its trailing "(N)" count, or null without one: the label
 * shortens with "…" in a narrow panel while the count stays whole.
 */
export function segmentLabel(text) {
  const parts = String(text).match(/^(.*?)\s*(\(\d+\))$/);
  return parts ? { label: parts[1], count: parts[2] } : { label: String(text), count: null };
}

/**
 * The crumb over the panel title: the selection's place,
 * from its workspace (`workspaceName`, else its id) down to the folder; '' with no selection.
 */
export function selectionCrumb(selection, workspaceName) {
  if (!selection) return '';
  return [workspaceName ?? selection.ws, ...selection.rel.split('/').filter(Boolean)].join(' › ');
}

const samePlace = (a, b) => (a === null || b === null ? a === b : a.ws === b.ws && a.rel === b.rel);

/**
 * The folder the panel shows: the active terminal's (its tab or grid
 * pane) while it leads, else `selection`, the tree's. `before` is the last result, null at start;
 * `selected` says a selection happened since (a tree click, "Ver todo"), `activeId` and `active`
 * ({ workspaceId, rel }) are the active terminal, null without one. A selection pins the panel to it,
 * and so does an activation it caused in the same turn (a workspace row enters its last terminal);
 * another terminal becoming active unpins it. Every agent of a folder shows its memory.
 * Returns { place, terminalId, pinned, render }: `render` is false when nothing was selected and the
 * place is the same, so a mousedown, an open or a tab of the same folder never reloads the panel.
 */
export function followPanel(before, { selected, activeId, active, selection }) {
  const pinned = selected || (before !== null && before.pinned && activeId === before.terminalId);
  const place = !pinned && active ? { ws: active.workspaceId, rel: active.rel ?? '' } : selection;
  return { place, terminalId: activeId, pinned, render: selected || before === null || !samePlace(place, before.place) };
}

/** 'none', 'workspace' (its root, rel '') or 'folder': the kinds of selection a view is remembered for. */
export function selectionKind(selection) {
  if (selection === null) return 'none';
  return selection.rel === '' ? 'workspace' : 'folder';
}

/**
 * The chosen view per kind of selection from the stored preferences: `saved` is 'panelViews'
 * ({ kind: view id, v: version }), `legacy` the old 'panelView' (one view id for every selection,
 * before the choice was kept per kind). The legacy choice is migrated into every kind while there
 * is no 'panelViews'. A folder choice saved before PANEL_VIEWS_VERSION is dropped (see there).
 * Returns { views, save (write storedViews(views)), dropLegacy (remove 'panelView') }.
 */
export function chosenViewsFrom(saved, legacy) {
  const dropLegacy = legacy !== null && legacy !== undefined;
  if (saved && typeof saved === 'object') {
    const { v, folder, ...kinds } = saved;
    const current = v === PANEL_VIEWS_VERSION;
    return { views: { ...DEFAULT_VIEWS, ...kinds, ...(current && folder ? { folder } : {}) }, save: !current, dropLegacy };
  }
  if (typeof legacy === 'string' && legacy) return { views: { ...DEFAULT_VIEWS, workspace: legacy, none: legacy }, save: true, dropLegacy };
  return { views: { ...DEFAULT_VIEWS }, save: false, dropLegacy };
}

/** The view a selection of `kind` opens on: the chosen one if offered, else the kind's default, else the first offered. */
export function pickView(applicable, chosen, kind) {
  return applicable.find((v) => v.id === chosen[kind]) ?? applicable.find((v) => v.id === DEFAULT_VIEWS[kind]) ?? applicable[0];
}

/**
 * Fills the panel body as its parts arrive: `view` (a promise of nodes) and `sections` (promises of
 * nodes shown above it, in registration order). The body shows when the view resolves, with the
 * sections already there; a later section is inserted in its place, before the next part shown.
 * A section that fails is left out; a view that fails rejects, and nothing more is shown.
 * `show(nodes)` replaces the body; `insert(nodes, before)` adds nodes before `before` (null: at the end).
 */
export async function fillPanel(view, sections, { show, insert }) {
  const parts = sections.map(() => null);
  let viewNodes = null;
  let failed = false;
  const nextShown = (index) => [...parts.slice(index + 1).flatMap((nodes) => nodes ?? []), ...(viewNodes ?? [])][0] ?? null;
  sections.forEach((section, index) => {
    Promise.resolve(section)
      .catch(() => [])
      .then((nodes) => {
        parts[index] = nodes.flat();
        if (viewNodes !== null && !failed && parts[index].length) insert(parts[index], nextShown(index));
      });
  });
  try {
    viewNodes = await view;
  } catch (error) {
    failed = true;
    throw error;
  }
  show([...parts.flatMap((nodes) => nodes ?? []), ...viewNodes]);
}
