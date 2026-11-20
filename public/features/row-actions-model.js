// Pure rule behind the actions of a sidebar row (workspaces.js): the folder or workspace name is
// never covered. It keeps a guaranteed minimum width, the actions take only what is left, and the
// ones that do not fit move, in order, into the row's "⋯" menu. DOM-free so
// test/row-actions-model.test.ts runs it in Node; the caller measures the widths in pixels.

/** The width of a name that is always visible, clipped with … beyond it. */
export const NAME_MIN_PX = 72;

/** The minimum width a name keeps: the guaranteed width, or the whole name when it is shorter. */
export function nameMinimum(nameWidth, floor = NAME_MIN_PX) {
  if (!Number.isFinite(nameWidth)) return floor;
  return Math.max(0, Math.min(nameWidth, floor));
}

/**
 * How many of the ordered actions stay inline. `available` is the room for the name and the
 * actions together; `gap` separates the name from the first item and each item from the next.
 * Every action stays inline when they all fit without "⋯" (unless `alwaysMore`: the menu has
 * entries of its own); otherwise as many as fit beside "⋯", which may be none.
 */
export function inlineActionCount({ available, nameMin = 0, moreWidth = 0, widths = [], gap = 0, alwaysMore = false }) {
  const room = (Number.isFinite(available) ? available : 0) - nameMin;
  // Width of the first `count` actions, plus "⋯" when shown, with the gaps before each item.
  const used = (count, more) => {
    let total = 0;
    for (let i = 0; i < count; i++) total += gap + widths[i];
    return more ? total + gap + moreWidth : total;
  };
  if (!alwaysMore && used(widths.length, false) <= room) return widths.length;
  let count = 0;
  while (count < widths.length && used(count + 1, true) <= room) count++;
  return count;
}

/** Whether the row shows its "⋯" button: some action left the row, or the menu has entries of its own. */
export function showsMore(inline, total, alwaysMore = false) {
  return alwaysMore || inline < total;
}
