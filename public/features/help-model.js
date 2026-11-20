// The help guide's content and its "?" key rule (.help-dialog). Each section of the nav lists its
// entries, so the nav counts come from this data. Texts are i18n keys (public/i18n/help.js; the
// state names are the state filter's, the folder badge the tree's); `icon` names a sprite symbol
// (public/icons.js). Only what the app really has. No DOM: features/help.js draws it and
// test/gentle-deck-state-filter-t4.test.ts runs it in Node.
import { ICONS, STATES } from './sidebar-status-model.js';

/** One card per agent state, in the filter's order: its chip, what it means and what you do. */
const STATE_ENTRIES = STATES.map((state) => ({
  state,
  icon: ICONS[state],
  nameKey: `filter.state.${state}`,
  whatKey: `help.state.${state}.what`,
  doKey: `help.state.${state}.do`,
}));

/** The buttons of a folder row and a pane head; `tone` colors the tile like the button does. */
const ICON_ENTRIES = [
  { id: 'git', icon: 'git' },
  { id: 'rose', icon: 'rose', tone: 'rose' },
  { id: 'bash', icon: 'terminal' },
  { id: 'delegate', icon: 'delegate' },
  { id: 'files', icon: 'files' },
  { id: 'mcp', icon: 'plug' },
  { id: 'filter', icon: 'filter' },
  { id: 'grip', icon: 'grip' },
  { id: 'more', icon: 'more' },
  { id: 'sereno', icon: 'sereno', tone: 'accent' },
].map((entry) => ({ tone: null, ...entry, titleKey: `help.icon.${entry.id}.title`, textKey: `help.icon.${entry.id}.text` }));

/**
 * The panels and views. The autopilot is the featured card, with what Sereno does (`ok`) and the
 * limits it never crosses; the folder without memory shows the tree's badge instead of an icon.
 */
const PANEL_ENTRIES = [
  {
    id: 'autopilot',
    icon: 'sereno',
    tone: 'accent',
    featured: true,
    limits: [
      { ok: true, key: 'help.panel.autopilot.yes' },
      { ok: false, key: 'help.panel.autopilot.secrets' },
      { ok: false, key: 'help.panel.autopilot.destructive' },
      { ok: false, key: 'help.panel.autopilot.unsure' },
    ],
  },
  { id: 'inbox', icon: 'wait', tone: 'wait' },
  { id: 'leftOff', icon: 'panel' },
  { id: 'day', icon: 'sun' },
  { id: 'tracking', icon: 'work' },
  { id: 'filter', icon: 'filter' },
  { id: 'layout', icon: 'terminal' },
  { id: 'noMemory', icon: null, badgeKey: 'tree.noMemory' },
].map((entry) => ({ tone: null, featured: false, ...entry, titleKey: `help.panel.${entry.id}.title`, textKey: `help.panel.${entry.id}.text` }));

/**
 * The keyboard handlers the app has, as keycaps: `keys` are pressed together; a nested list is
 * either of its keys ("← o →").
 */
const KEY_ENTRIES = [
  { id: 'move', keys: ['Alt', 'Shift', ['←', '→']] },
  { id: 'tabs', keys: [['←', '→']] },
  { id: 'pages', keys: [['←', '→']] },
  { id: 'enter', keys: ['Enter'] },
  { id: 'fold', keys: [['←', '→']] },
  { id: 'tree', keys: [['↑', '↓']] },
  { id: 'rename', keys: ['F2'] },
  { id: 'menu', keys: [['↑', '↓']] },
  { id: 'save', keys: ['Ctrl', 'S'] },
  { id: 'escape', keys: ['Esc'] },
  { id: 'help', keys: ['?'] },
].map((entry) => ({ ...entry, textKey: `help.key.${entry.id}` }));

/** The guide's sections, in nav order: its name, its nav icon, the line over its list and the list. */
export const HELP_SECTIONS = [
  { id: 'states', key: 'help.nav.states', icon: 'work', ledeKey: 'help.states.lede', entries: STATE_ENTRIES },
  { id: 'icons', key: 'help.nav.icons', icon: 'mark', ledeKey: 'help.icons.lede', entries: ICON_ENTRIES },
  { id: 'panels', key: 'help.nav.panels', icon: 'panel', ledeKey: 'help.panels.lede', entries: PANEL_ENTRIES },
  { id: 'keys', key: 'help.nav.keys', icon: 'terminal', ledeKey: 'help.keys.lede', entries: KEY_ENTRIES },
];

/**
 * Whether a keydown opens the guide: "?" with no Ctrl, Meta or Alt (Shift makes the "?"), not
 * while composing or already handled, never while typing in a text field or a terminal (they keep
 * their "?"), and not over another dialog.
 */
export function opensGuide({ key, ctrlKey = false, metaKey = false, altKey = false, composing = false, defaultPrevented = false, typing = false, inTerminal = false, dialogOpen = false }) {
  return key === '?' && !ctrlKey && !metaKey && !altKey && !composing && !defaultPrevented && !typing && !inTerminal && !dialogOpen;
}
