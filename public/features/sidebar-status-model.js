// Pure rules behind the sidebar's state glyphs and its state filter:
// the five agent states, read only from what the
// window already has. The terminals (terminals.js terminalList), the inbox items (the `inbox` event
// of features/inbox.js) and the sleeping agents (features/sleeping.js). A folder with no agent
// behind it shows nothing. No DOM: features/workspaces.js draws it and
// test/sidebar-status-model.test.ts runs it in Node.
import { agentState } from './tracking-model.js';

/** The five states, in the order the state filter lists them. */
export const STATES = ['work', 'wait', 'done', 'sleep', 'err'];
/** Each state's sprite symbol (public/icons.js). */
export const ICONS = { work: 'work', wait: 'wait', done: 'check', sleep: 'sleep', err: 'error' };
/** A row shows one glyph: the one of its most urgent agent, first in this list. */
const URGENCY = ['wait', 'err', 'done', 'work', 'sleep'];
const FROM_TRACKING = { working: 'work', waiting: 'wait', finished: 'done', error: 'err' };

/** The key of a folder row: its workspace id and its path in it ('' for the workspace root). */
export const folderKey = (workspaceId, rel) => JSON.stringify([workspaceId, rel ?? '']);

/**
 * The state of one terminal, as the tracking view reads it (tracking-model.js agentState): an
 * agent works while it runs and the inbox says nothing, waits or is done as its inbox item says, and
 * is an error while its inbox item says its program stopped with an error (OSC 7501 `state=error`).
 * An ended agent is an error only when it did not end cleanly (non-zero code, a signal, out of
 * memory). A shell has no state; neither has an agent that exited with code 0.
 */
export function terminalState(terminal, item) {
  if (terminal.kind !== 'agent') return null;
  const state = agentState(terminal, item);
  if (state !== 'exited') return FROM_TRACKING[state];
  return terminal.oomKilled || terminal.exitSignal || (terminal.exitCode ?? 0) !== 0 ? 'err' : null;
}

/**
 * The sidebar's states. `terminals`: TerminalInfo[]; `items`: inbox AttentionItem[] (items of
 * terminals not in `terminals` are ignored); `sleeping`: the sleeping agents ({ workspaceId, rel }).
 * Returns `agents` (one { workspaceId, rel, state } per agent with a state), and from them
 * `folders` (folderKey → the row's state) and `counts` (agents per state), so the filter menu, the
 * tree it filters and the glyphs read the same data.
 */
export function sidebarStatus({ terminals = [], items = [], sleeping = [] } = {}) {
  const itemOf = new Map(items.map((item) => [item.terminalId, item]));
  const agents = [];
  for (const terminal of terminals) {
    const state = terminalState(terminal, itemOf.get(terminal.id));
    if (state) agents.push({ workspaceId: terminal.workspaceId, rel: terminal.rel ?? '', state });
  }
  for (const agent of sleeping) agents.push({ workspaceId: agent.workspaceId, rel: agent.rel ?? '', state: 'sleep' });
  const folders = new Map();
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const { workspaceId, rel, state } of agents) {
    counts[state] += 1;
    const key = folderKey(workspaceId, rel);
    const current = folders.get(key);
    if (!current || URGENCY.indexOf(state) < URGENCY.indexOf(current)) folders.set(key, state);
  }
  return { agents, folders, counts };
}
