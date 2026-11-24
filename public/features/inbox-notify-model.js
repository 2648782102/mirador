// What a browser notification of the attention inbox says (public/features/inbox-notify.js shows
// it). Pure, so the tests read every text and option (test/inbox-notify-model.test.ts).
// - One card: "{project} · {reason}"; the body is the question or detail (when there is one),
//   then "{agent} · {workspace › folder › …}". The project is the folder's last part, or the
//   workspace at its root.
// - A guarded command (GUARDED_LABEL): only "{project} · {reason}", with an empty body. The command
//   may carry a token, and the desktop's notification history keeps a notice after the card closes.
// - A burst (GROUP_AT or more new cards within the page's window, inbox-notify.js NOTIFY_WINDOW_MS):
//   "{n} agents are waiting for you", the projects in the body, under one tag, so a later burst replaces it.
// - Discreet mode: "An agent is waiting for you" (or the burst title), with no project, question
//   or path, for a shared screen.
// Cards that ask something (a blocker or a dialog) stay on screen until the user acts
// (`requireInteraction`), unless the user turned that off; an error never does.
// Text that comes from the agent or the disk is one line, without control or format characters, and cut.

/** localStorage keys (core.js prefs): notices that ask stay on screen (default on); discreet mode (default off). */
export const NOTIFY_STAY_PREF = 'inboxNotifyStay';
export const NOTIFY_DISCREET_PREF = 'inboxNotifyDiscreet';

/**
 * The Mirador mark at 192 px and its white-on-transparent badge at 96 px (Android's status bar),
 * served by Mirador itself (scripts/notify-icons.sh makes both from public/icon.svg). PNG, not the
 * SVG: Firefox on Linux shows no image for an SVG icon.
 */
const ICON = '/notify-icon.png';
const BADGE = '/notify-badge.png';

/** New cards within the page's window from which one notification stands for all of them. */
export const GROUP_AT = 3;
/** The burst notification's tag: one at a time, a later burst replaces it. */
export const GROUP_TAG = 'mirador-inbox:group';
/** gentle-shell's blocker label for a guarded command (inbox.js REASONS): its notice never shows the command. */
export const GUARDED_LABEL = 'Guarded command confirmation';
/** The longest line of agent text a notification shows. */
const TEXT_MAX = 120;

// Line breaks and other control characters, read as spaces.
const CONTROL = /[\p{Cc}\u2028\u2029]+/gu;
// Format characters (zero-width marks, bidirectional overrides and marks, the soft hyphen, tag
// characters, the BOM), dropped: they show nothing, or hide or reorder what does. The zero-width
// joiner stays, it builds emoji.
const FORMAT = /(?:(?!\u200D)[\p{Cf}\u{E0000}-\u{E007F}])+/gu;

/** One line of agent (or disk) text: control characters as spaces, format characters dropped, spaces collapsed, cut to `max` characters with "…". */
export function agentText(text, max = TEXT_MAX) {
  const line = String(text ?? '').replace(FORMAT, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** A blocker or a dialog asks something of the user; an error or a finished turn does not. */
export const asksYou = (item) => item.kind === 'blocked' || item.kind === 'prompt';

const folders = (item) => (item.rel ? String(item.rel).split('/').filter(Boolean) : []);
/** The folder's last part, or the workspace at its root. */
const projectOf = (item, workspace) => agentText(folders(item).at(-1) ?? workspace);
/** "workspace › folder › subfolder". */
const pathOf = (item, workspace) => [workspace, ...folders(item)].map((part) => agentText(part)).join(' › ');

/** The discreet or burst title: `text.waiting(count)`, or English when the caller gave none. */
const waitingTitle = (text, count) =>
  typeof text.waiting === 'function' ? text.waiting(count) : count === 1 ? 'An agent is waiting for you' : `${count} agents are waiting for you`;

/** What every notification carries: Mirador's images, the interface language and when the wait started. */
function common(text, since) {
  const options = { icon: ICON, badge: BADGE };
  if (text.lang) options.lang = text.lang;
  const time = Date.parse(since);
  if (Number.isFinite(time)) options.timestamp = time;
  return options;
}

/**
 * One card's notification, `{ title, options }`. `text`: `reason` (translated), `workspace` (its
 * name), `agent` (its name, or null when unknown), `lang`, `stay` (default true), `discreet`
 * (default false) and `waiting(count)`, the discreet title (English without it).
 */
export function cardNotification(item, text) {
  const tag = `mirador-inbox:${item.terminalId}:${item.since}`;
  const requireInteraction = text.stay !== false && asksYou(item);
  if (text.discreet) return { title: waitingTitle(text, 1), options: { body: '', tag, requireInteraction, ...common(text, item.since) } };
  const title = `${projectOf(item, text.workspace)} · ${agentText(text.reason)}`;
  if (item.label === GUARDED_LABEL) return { title, options: { body: '', tag, requireInteraction, ...common(text, item.since) } };
  const agent = agentText(text.agent);
  const where = pathOf(item, text.workspace);
  const lines = [agentText(item.detail), agent ? `${agent} · ${where}` : where].filter(Boolean);
  return {
    title,
    options: { body: lines.join('\n'), tag, requireInteraction, ...common(text, item.since) },
  };
}

/**
 * The notification for a burst of new cards, `entries` as `{ item, workspace }`: how many wait and
 * their projects (none in discreet mode), dated by the longest wait. `text`: `lang`, `stay`,
 * `discreet` and `waiting(count)`.
 */
export function groupNotification(entries, text) {
  const projects = [...new Set(entries.map(({ item, workspace }) => projectOf(item, workspace)))];
  const first = entries.map(({ item }) => item.since).sort()[0];
  return {
    title: waitingTitle(text, entries.length),
    options: {
      body: text.discreet ? '' : projects.join(', '),
      tag: GROUP_TAG,
      requireInteraction: text.stay !== false && entries.some(({ item }) => asksYou(item)),
      ...common(text, first),
    },
  };
}
