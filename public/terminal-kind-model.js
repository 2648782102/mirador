/**
 * Whether a terminal shows as a tab and grid pane. A 'git' terminal (lazygit, opened from the
 * tree's git mark) shows only in the floating panel of public/git-panel.js.
 */
export function showsAsTab(info) {
  return info.kind !== 'git';
}
