// Pure rules behind the state filter in the Workspaces head:
// which states are picked, what the
// menu lists, which tree rows and terminals stay. The states and their counts are the sidebar's
// (sidebar-status-model.js sidebarStatus), so the menu, the tree glyphs and the panes always agree.
// No DOM: features/workspaces.js and terminals.js draw it and
// test/gentle-deck-state-filter-t2.test.ts runs it in Node.
import { ICONS, STATES } from './sidebar-status-model.js';

/** A saved or toggled selection, cleaned: known states only, once each, in menu order. */
export function normalizeSelection(value) {
  const list = Array.isArray(value) ? value : [];
  return STATES.filter((state) => list.includes(state));
}

/** Picking a state: on when it was off, off when it was on; the other picked states stay. */
export function toggleState(selected, state) {
  return normalizeSelection(selected.includes(state) ? selected.filter((s) => s !== state) : [...selected, state]);
}

/**
 * A menu item picked: a state toggles and the menu stays open to pick another; 'all' ("Ver todos")
 * clears the selection and closes the menu.
 */
export function pick(selected, choice) {
  if (choice === 'all') return { selected: [], close: true };
  return { selected: toggleState(selected, choice), close: false };
}

/**
 * Whether something in `states` (a state, null for no state, or a list) shows: everything while
 * nothing is picked, else it must be in ANY picked state.
 */
export function matches(selected, states) {
  if (!selected.length) return true;
  return [states].flat().some((state) => state !== null && selected.includes(state));
}

/**
 * Whether `terminal` ({ id, state }, a pane-status-model.js state) shows under the filter: its state
 * is picked, or it is the active one (`activeId`), which the user is looking at, so it stays whatever
 * its state turns into. Activating another terminal ends that: the previous one hides if it does
 * not match.
 */
export function showsTerminal(selected, activeId, terminal) {
  return (activeId != null && terminal.id === activeId) || matches(selected, terminal.state);
}

/**
 * The terminal whose pane the tabs layout shows: the active one (`activeId`) while the filter
 * keeps it, else the first one the filter keeps, standing in for it; null when none matches.
 * `terminals` are { id, state } (pane-status-model.js states) in display order. With `exemptActive`
 * the active one counts as kept whatever its state (showsTerminal), so a stand-in shows only while
 * there is no active terminal. The caller only shows a stand-in: activating it would mark it seen
 * (features/inbox.js), and a "Terminó" filter would then drop it.
 */
export function paneToShow(selected, activeId, terminals, { exemptActive = false } = {}) {
  const shown = terminals.filter((info) => showsTerminal(selected, exemptActive ? activeId : null, info));
  return shown.some((info) => info.id === activeId) ? activeId : shown[0]?.id ?? null;
}

/**
 * The menu: "Ver todos" with every agent, checked while nothing is picked, then one checkbox per
 * state with its count (`counts`, sidebarStatus), checked while picked.
 */
export function menuItems(counts, selected) {
  const total = STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  return [
    { state: 'all', count: total, icon: 'filter', checked: !selected.length },
    ...STATES.map((state) => ({ state, count: counts[state] ?? 0, icon: ICONS[state], checked: selected.includes(state) })),
  ];
}

/** Whether the folder `rel` is `match` or holds it ('' is the workspace root, which holds every folder). */
const holds = (rel, match) => rel === '' || rel === match || match.startsWith(`${rel}/`);

/**
 * The tree under the filter, from the sidebar's agents (sidebarStatus `agents`). `keeps(ws, rel)`:
 * the row stays when a folder of it, or one it holds, has an agent in a picked state. `count(ws, rels)`:
 * of a workspace's folder rows `rels`, how many stay ("N de M carpetas"). `empty(ids)`: no workspace
 * of `ids` stays ("Ningún workspace en este estado."). `pinned` are the { workspaceId, rel } the filter
 * must not hide, the active terminal's place (terminals.js activePlace): their folder rows, the
 * folders that hold them and their workspace stay whatever their state now is. With nothing picked every row stays.
 */
export function treeView(agents, selected, pinned = []) {
  const active = selected.length > 0;
  const matched = new Map();
  for (const agent of agents) {
    if (!active || !selected.includes(agent.state)) continue;
    if (!matched.has(agent.workspaceId)) matched.set(agent.workspaceId, []);
    matched.get(agent.workspaceId).push(agent.rel ?? '');
  }
  for (const place of active ? pinned : []) {
    if (!matched.has(place.workspaceId)) matched.set(place.workspaceId, []);
    matched.get(place.workspaceId).push(place.rel ?? '');
  }
  const keeps = (workspaceId, rel) => !active || (matched.get(workspaceId) ?? []).some((match) => holds(rel ?? '', match));
  return {
    active,
    keeps,
    count: (workspaceId, rels) => ({ shown: rels.filter((rel) => keeps(workspaceId, rel)).length, total: rels.length }),
    empty: (workspaceIds) => active && !workspaceIds.some((id) => keeps(id, '')),
  };
}
