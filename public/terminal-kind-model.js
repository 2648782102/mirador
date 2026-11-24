/**
 * Whether a terminal shows as a tab and grid pane. A 'git' terminal (lazygit, opened from the
 * tree's git mark) shows only in the floating panel of public/git-panel.js.
 */
export function showsAsTab(info) {
  return info.kind !== 'git';
}

/**
 * The terminal ids the inbox `items` name that `known` (a Set) lacks, each once, in order: a
 * terminal opened in another window after this page loaded, which this window has to read.
 */
export function unknownTerminalIds(items, known) {
  const ids = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = item?.terminalId;
    if (typeof id === 'string' && id && !known.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
