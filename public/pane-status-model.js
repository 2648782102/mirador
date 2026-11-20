// What a terminal's tab and pane head show of its agent (.st, .pane.waiting, .pane.error, .tab .glyph).
// The state is the sidebar's (features/sidebar-status-model.js terminalState, itself the tracking
// view's agentState), so tabs, panes and the sidebar always agree. No DOM: terminals.js draws it
// and test/pane-status-model.test.ts runs it in Node.
import { ICONS, terminalState } from './features/sidebar-status-model.js';

/** The pane border a state takes; the other states keep the plain border. */
const BORDERS = { wait: 'waiting', err: 'error' };

/**
 * For `terminal` (TerminalInfo) and its inbox item (or undefined): its `state` ('work', 'wait',
 * 'done', 'err' or null), the sprite `icon` of that state, the pane's `border` class ('waiting',
 * 'error' or null) and `kind`, the word a shell ('bash') or a git terminal ('lazygit') shows where an
 * agent shows its state.
 */
export function paneStatus(terminal, item) {
  const state = terminalState(terminal, item);
  return { state, icon: state ? ICONS[state] : null, border: BORDERS[state] ?? null, kind: terminal.kind === 'agent' ? null : terminal.kind === 'git' ? 'lazygit' : 'bash' };
}
