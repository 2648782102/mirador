// Pure rules of the terminal order: tabs and grid cells reordered by drag and drop inside their
// workspace group. DOM-free so tests can run it in Node.
//
// The order is saved per workspace as a list of slots, one per terminal, keyed by folder and kind
// ("<rel>|<kind>"), never by terminal id: a restart gives restored agents new ids. The n-th
// terminal (in creation order) of a folder and kind takes the n-th slot with that key, so several
// terminals of one folder and kind keep their creation order among themselves. The saved order is
// a Map of workspace id → slots, least recently reordered workspace first; prefs keeps it as
// [[workspaceId, slots], ...].

/** Slots kept per workspace; the ones of folders that are not open are dropped first. */
export const MAX_SLOTS = 50;
/** Workspaces kept; the least recently reordered one is dropped first. */
export const MAX_WORKSPACES = 30;

/** The slot of a terminal (TerminalInfo): its folder and kind. */
export function slotKey(info) {
  return `${info.rel ?? ''}|${info.kind}`;
}

/** The saved order from what prefs read (anything): a Map of workspace id → slots, bad entries left out. */
export function readOrder(raw) {
  const order = new Map();
  if (!Array.isArray(raw)) return order;
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue;
    order.delete(entry[0]);
    order.set(entry[0], entry[1].filter((slot) => typeof slot === 'string').slice(0, MAX_SLOTS));
  }
  return bounded(order);
}

/**
 * One workspace's terminals (TerminalInfo, in creation order) in their saved order (`slots`):
 * the ones with a saved place first, by place, then the rest in creation order.
 */
export function orderGroup(terminals, slots = []) {
  const places = new Map();
  slots.forEach((slot, place) => {
    if (!places.has(slot)) places.set(slot, []);
    places.get(slot).push(place);
  });
  const seen = new Map();
  const ranked = terminals.map((info, index) => {
    const key = slotKey(info);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { info, index, place: places.get(key)?.[n] ?? Infinity };
  });
  // Infinity - Infinity is NaN, so two unsaved terminals fall back to creation order.
  ranked.sort((a, b) => a.place - b.place || a.index - b.index);
  return ranked.map((entry) => entry.info);
}

/**
 * The saved order once terminal `draggedId` is dropped `place` ('before' | 'after') terminal
 * `targetId`; `terminals` lists every open terminal in creation order. A drop onto another
 * workspace's terminal, onto itself or onto an unknown one returns `order` unchanged.
 */
export function moveTerminal(order, terminals, draggedId, targetId, place) {
  const dragged = terminals.find((info) => info.id === draggedId);
  const target = terminals.find((info) => info.id === targetId);
  if (!dragged || !target || dragged === target || dragged.workspaceId !== target.workspaceId) return order;
  const workspaceId = dragged.workspaceId;
  const slots = order.get(workspaceId) ?? [];
  const group = orderGroup(terminals.filter((info) => info.workspaceId === workspaceId), slots).filter((info) => info !== dragged);
  group.splice(group.indexOf(target) + (place === 'after' ? 1 : 0), 0, dragged);
  const next = new Map(order);
  next.delete(workspaceId);
  next.set(workspaceId, mergeSlots(slots, group.map(slotKey)));
  return bounded(next);
}

/** The saved order once terminal `id` moves one place back (`step` -1) or forward (1) in its group. */
export function moveTerminalBy(order, terminals, id, step) {
  const info = terminals.find((candidate) => candidate.id === id);
  if (!info) return order;
  const group = orderGroup(terminals.filter((candidate) => candidate.workspaceId === info.workspaceId), order.get(info.workspaceId));
  const neighbour = group[group.indexOf(info) + step];
  return neighbour ? moveTerminal(order, terminals, id, neighbour.id, step < 0 ? 'before' : 'after') : order;
}

/**
 * The new slots of a workspace: the open terminals' slots (`open`, in their new order) fill the
 * places the open terminals held in `slots`, then follow at the end; the slots of folders that
 * are not open stay where they were. Over MAX_SLOTS, the last of those are dropped.
 */
function mergeSlots(slots, open) {
  const openCount = new Map();
  for (const slot of open) openCount.set(slot, (openCount.get(slot) ?? 0) + 1);
  const queue = [...open];
  const seen = new Map();
  const merged = slots.map((slot) => {
    const n = seen.get(slot) ?? 0;
    seen.set(slot, n + 1);
    return n < (openCount.get(slot) ?? 0) ? { slot: queue.shift(), open: true } : { slot, open: false };
  });
  merged.push(...queue.map((slot) => ({ slot, open: true })));
  for (let i = merged.length - 1; i >= 0 && merged.length > MAX_SLOTS; i--) if (!merged[i].open) merged.splice(i, 1);
  return merged.map((entry) => entry.slot);
}

/** `order` with at most MAX_WORKSPACES workspaces, dropping the least recently reordered. */
function bounded(order) {
  for (const workspaceId of order.keys()) {
    if (order.size <= MAX_WORKSPACES) break;
    order.delete(workspaceId);
  }
  return order;
}
