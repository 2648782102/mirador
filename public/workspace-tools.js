// Pure rules behind the tools of a workspace row:
// short visible text on the row, rename and remove in a "Más" menu. Texts are i18n keys
// ({ key, vars }) the caller translates; `icon` names a sprite symbol (public/icons.js), or is
// null. DOM-free so test/workspace-tools.test.ts runs it in Node.

/**
 * The tools on the workspace row, in order: open the saved projects (only when there are
 * some), select several folders, choose folders. `label` is the short visible text; `title`
 * the long one, which names the workspace.
 */
export function rowTools(workspace) {
  const name = workspace.name;
  const count = workspace.projects?.length ?? 0;
  return [
    count ? { id: 'open', icon: 'terminal', label: { key: 'ws.toolOpen', vars: { count } }, title: { key: 'multi.openSaved', vars: { count, name } } } : null,
    { id: 'pick', icon: 'check', label: { key: 'ws.toolPick' }, title: { key: 'multi.toggle', vars: { name } } },
    { id: 'folders', icon: 'files', label: { key: 'ws.toolFolders' }, title: { key: 'ws.chooseFolders', vars: { name } } },
  ].filter(Boolean);
}

/** The button that opens the "Más" menu of a workspace row. */
export function moreButton(workspace) {
  return { id: 'more', icon: 'more', label: { key: 'ws.toolMore' }, title: { key: 'ws.moreTitle', vars: { name: workspace.name } } };
}

/** The items of the "Más" menu, in order: rename (a pencil), remove (a cross). */
export function moreTools(workspace) {
  const name = workspace.name;
  return [
    { id: 'rename', icon: 'pencil', label: { key: 'ws.toolRename' }, title: { key: 'ws.rename', vars: { name } } },
    { id: 'remove', icon: 'close', label: { key: 'ws.toolRemove' }, title: { key: 'ws.remove', vars: { name } } },
  ];
}

/** The menu item `key` moves the focus to from item `index` of `count`, wrapping; null for other keys. */
export function menuFocusIndex(key, index, count) {
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Whether an event closes the open menu: Escape or Tab ({ type: 'keydown', key }), or a press
 * outside the menu and its button ({ type: 'pointerdown', inside }).
 */
export function closesMenu(event) {
  if (event.type === 'keydown') return event.key === 'Escape' || event.key === 'Tab';
  if (event.type === 'pointerdown') return !event.inside;
  return false;
}
