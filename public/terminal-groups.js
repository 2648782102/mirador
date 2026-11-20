// Pure rules behind the terminal groups: tabs and grid panes grouped by workspace, and the
// label of an ended terminal. DOM-free (no core.js import) so tests can run it in Node.
import { orderGroup } from './terminal-order-model.js';

const PANE_ROW = 'minmax(0, 1fr)';
/** A stacked pane keeps this much height; the grid scrolls past it (styles.css .panes[data-stacked]). */
const STACKED_ROW = 'minmax(240px, 1fr)';

/** A terminals area this wide or narrower stacks the grid panes in one column (two would be under 300px each). */
export const STACK_PANES_AT = 640;

/** Whether the grid panes stack in one column in a terminals area `areaWidth` px wide. */
export function stacksPanes(areaWidth) {
  return areaWidth <= STACK_PANES_AT;
}

/** The narrowest a grid pane gets, so its head keeps the close button in view (artboard 03: two per row while each gets 300px). */
export const MIN_PANE_WIDTH = 300;
/** The grid's padding on both sides and its gap between panes (styles.css .panes[data-layout="grid"]). */
const GRID_PADDING = 20;
const GRID_GAP = 8;

/** The most columns a terminals area `areaWidth` px wide holds at MIN_PANE_WIDTH each; one where it stacks (stacksPanes). */
export function fitColumns(areaWidth) {
  if (stacksPanes(areaWidth)) return 1;
  return Math.max(1, Math.floor((areaWidth - GRID_PADDING + GRID_GAP) / (MIN_PANE_WIDTH + GRID_GAP)));
}

/**
 * Groups terminals (TerminalInfo, in creation order) by workspace: one group per workspace
 * that has terminals, in sidebar order (`workspaces`), then the terminals whose workspace
 * was removed, one group per workspace id in order of first appearance, named after the id.
 * Inside a group the terminals follow its saved order (`order`, terminal-order-model.js),
 * which tabs and grid share. Returns [{ workspaceId, name, known, terminals }].
 */
export function groupTerminals(terminals, workspaces, order = new Map()) {
  const byWorkspace = new Map();
  for (const info of terminals) {
    if (!byWorkspace.has(info.workspaceId)) byWorkspace.set(info.workspaceId, []);
    byWorkspace.get(info.workspaceId).push(info);
  }
  for (const [workspaceId, list] of byWorkspace) byWorkspace.set(workspaceId, orderGroup(list, order.get(workspaceId)));
  const groups = [];
  for (const workspace of workspaces) {
    const list = byWorkspace.get(workspace.id);
    if (!list) continue;
    groups.push({ workspaceId: workspace.id, name: workspace.name, known: true, terminals: list });
    byWorkspace.delete(workspace.id);
  }
  for (const [workspaceId, list] of byWorkspace) groups.push({ workspaceId, name: workspaceId, known: false, terminals: list });
  return groups;
}

/** Panes the grid shows: the terminals of every group not in `collapsed` (workspace ids). */
export function visibleCount(groups, collapsed) {
  const hidden = new Set(collapsed);
  return groups.reduce((sum, group) => sum + (hidden.has(group.workspaceId) ? 0 : group.terminals.length), 0);
}

/** Columns of a near-square grid for `visible` panes. */
export function gridColumns(visible) {
  return Math.max(1, Math.ceil(Math.sqrt(visible)));
}

/**
 * Grid tracks for the panes: the column count from the visible panes, and the rows
 * in DOM order: each group's header row ('auto'), then its pane rows unless collapsed.
 * The terminals area (`areaWidth`) caps the columns at the ones it holds (fitColumns), down
 * to one where it stacks; with fewer columns than near-square each row keeps a usable
 * height. Without `areaWidth` the grid stays near-square.
 */
export function gridTracks(groups, collapsed, areaWidth = Infinity) {
  const hidden = new Set(collapsed);
  const square = gridColumns(visibleCount(groups, hidden));
  const columns = Math.min(square, fitColumns(areaWidth));
  const paneRow = columns < square ? STACKED_ROW : PANE_ROW;
  const rows = [];
  for (const group of groups) {
    rows.push('auto');
    if (!hidden.has(group.workspaceId)) for (let i = 0; i < Math.ceil(group.terminals.length / columns); i++) rows.push(paneRow);
  }
  return { columns, rows };
}

/**
 * The group whose grid header says how to reorder (artboard 03 .group-hint): the first group not in
 * `collapsed` with two or more terminals, since only those have a place to move to; else null.
 */
export function reorderHintGroup(groups, collapsed) {
  const hidden = new Set(collapsed);
  return groups.find((group) => !hidden.has(group.workspaceId) && group.terminals.length >= 2)?.workspaceId ?? null;
}

/** The tabs bar belongs to the tabs layout; the grid shows a header above each group's panes instead. */
export function showsTabsBar(layout) {
  return layout !== 'grid';
}

/**
 * After a layout switch, whether to expand the collapsed group of the shown terminal (its
 * workspace `activeWorkspaceId`). Tabs show that terminal's pane, so its tabs come back too;
 * the grid keeps a group the user collapsed.
 */
export function reopensActiveGroup(layout, activeWorkspaceId, collapsed) {
  return layout === 'tabs' && activeWorkspaceId !== undefined && new Set(collapsed).has(activeWorkspaceId);
}

/**
 * The terminal to show when entering a workspace: the one activated last in this window
 * (`activations` maps id → increasing sequence number), else the newest by createdAt.
 */
export function mostRecentTerminal(terminals, activations) {
  let best = null;
  const rank = (info) => [activations.get(info.id) ?? -1, info.createdAt ?? ''];
  for (const info of terminals) {
    if (!best) { best = info; continue; }
    const [seq, created] = rank(info);
    const [bestSeq, bestCreated] = rank(best);
    if (seq > bestSeq || (seq === bestSeq && created > bestCreated)) best = info;
  }
  return best;
}

/**
 * What an ended terminal's tab (`tab`) and pane (`line`) say, from its TerminalInfo: stopped
 * for lack of memory when Mirador saw it (`oomKilled`), else stopped by its signal, else its
 * exit code. `t` is the translator (core.js t), passed in to keep this module DOM-free.
 */
export function exitLabels(info, t) {
  if (info.oomKilled) return { tab: t('term.exitedOom'), line: t('term.exitLineOom') };
  if (info.exitSignal) return { tab: t('term.exitedSignal', { signal: info.exitSignal }), line: t('term.exitLineSignal', { signal: info.exitSignal }) };
  return { tab: t('term.exited', { code: info.exitCode ?? '' }).trim(), line: t('term.exitLine', { code: info.exitCode ?? '' }) };
}
