// "Where it left off" (public/features/overview.js) in three reading levels:
// act (an agent of the folder waiting for an answer),
// read (the objective) and context (when, and from which summary). Long sections fold
// behind a one-line gist taken from their own text; a long objective turns in pages.
// Pure: no DOM, no i18n lookups.

/** Plural keys (`.one`/`.other`) and "at least" keys the fold gists use. */
export const GIST_KEYS = [
  'overview.gist.pending.one',
  'overview.gist.pending.other',
  'overview.gist.pendingMore',
  'overview.gist.done.one',
  'overview.gist.done.other',
  'overview.gist.doneMore',
];

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/;

/**
 * Top-level list items of a Markdown section: { count, more }, or null when it has none
 * (free text gets no number). `more` when the server clipped the section
 * (src/memory/overview.ts clip() ends it with "…"), so `count` is a lower bound.
 */
export function listCount(markdown) {
  const indents = String(markdown ?? '')
    .split('\n')
    .map((line) => line.match(ITEM)?.[1].length)
    .filter((indent) => indent !== undefined);
  if (!indents.length) return null;
  const top = Math.min(...indents);
  return { count: indents.filter((indent) => indent === top).length, more: /…\s*$/.test(markdown) };
}

/** The gist of a fold: `kind` ('pending' or 'done') with its item count, or null. */
export function foldGist(markdown, kind) {
  const items = listCount(markdown);
  return items && { kind, ...items };
}

/**
 * The i18n key of the foot line that names where the summary comes from: Engram's session summary,
 * or the local record of Claude Code's hooks (src/memory/overview.ts LocalSource `from`).
 */
export function sourceKey(summary) {
  if (summary?.source !== 'claude-code') return 'overview.fromSummary';
  if (summary.from === 'compactSummary') return 'overview.fromClaudeCompact';
  if (summary.from === 'lastUserMessage') return 'overview.fromClaudePrompt';
  return 'overview.fromClaudeMessage';
}

/**
 * What the block shows for GET /api/overview/folder's `row`:
 * - read: 'ask' (the user's last message, from the local record), then 'goal' (the objective) or
 *   'excerpt' (a free-form summary's text);
 * - folds: next steps (open) and accomplished (closed, or open when nothing comes next);
 * - instead: 'latestMemory' or 'missing' when there is no session summary;
 * - foot: the context lines (last worked, the summary it comes from, a newer memory).
 */
export function leftOffLayout(row) {
  const { summary, memory } = row.leftOff;
  const foot = { lastWorked: Boolean(row.lastAt), source: Boolean(summary), since: Boolean(summary && memory && memory.at > summary.at) };
  if (!summary) return { read: [], folds: [], instead: memory ? 'latestMemory' : 'missing', foot };
  const read = summary.lastUserMessage ? ['ask'] : [];
  if (summary.goal) read.push('goal');
  if (summary.excerpt) read.push('excerpt');
  const folds = [];
  if (summary.nextSteps) folds.push({ id: 'next', field: 'nextSteps', title: 'overview.nextSteps', open: true, gist: foldGist(summary.nextSteps, 'pending') });
  if (summary.accomplished) {
    folds.push({ id: 'done', field: 'accomplished', title: 'overview.accomplished', open: !summary.nextSteps, gist: foldGist(summary.accomplished, 'done') });
  }
  return { read, folds, instead: null, foot };
}

/**
 * The call to act: of GET /api/inbox's items, the agent of the selected folder that has
 * waited longest for an answer (a finished turn is not a call), or null.
 */
export function pickCall(items, selection) {
  if (!selection || !Array.isArray(items)) return null;
  const waiting = items.filter((item) => item.kind !== 'finished' && item.workspaceId === selection.ws && item.rel === selection.rel);
  return waiting.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0] ?? null;
}

/** How long since `since`, as the inbox words it (public/features/inbox.js waited()): an i18n key and its count. */
export function waitedFor(since, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (!(minutes >= 1)) return { key: 'inbox.waited.now', count: 0 };
  return minutes < 60 ? { key: 'inbox.waited.minutes', count: minutes } : { key: 'inbox.waited.hours', count: Math.floor(minutes / 60) };
}

/* ---------- The objective in pages ---------- */
// A long objective reads like a book: a fixed-height box lays its text out in columns as wide
// as the box, `gap` apart, and scrolls sideways one column (a page) at a time.

/** How many pages the box holds, from its scroll and client widths; a hidden or short box is one page. */
export function pageCount(scrollWidth, clientWidth, gap = 0) {
  if (!(clientWidth > 0)) return 1;
  return Math.max(1, Math.round((scrollWidth + gap) / (clientWidth + gap)));
}

/** The page `step` pages away from `page` (0-based), kept within the `total` pages. */
export function turnPage(page, step, total) {
  const last = Math.max(1, total) - 1;
  return Math.max(0, Math.min(last, (Math.trunc(page) || 0) + step));
}

/** The scroll offset that shows `page`. */
export function pageOffset(page, clientWidth, gap = 0) {
  return page * (clientWidth + gap);
}

/** What the pager shows on `page` (0-based) of `total`: "n / m", which ends are disabled, and no pager for one page. */
export function pagerView(page, total) {
  return { page: page + 1, total, hidden: total < 2, prevDisabled: page <= 0, nextDisabled: page >= total - 1 };
}

const PAGE_KEYS = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 };

/** The pages a key turns while the box has focus: 1, -1, or 0 for any other key. */
export function pageKey(key) {
  return Object.hasOwn(PAGE_KEYS, key) ? PAGE_KEYS[key] : 0;
}

/* ---------- Clipped text with "Ver más" ---------- */
// The workspace mission and each folder row's next steps show their first lines, faded at the
// foot, and a button opens the rest; text that fits shows no button.

/** The lines each clipped text keeps while closed. */
export const CLIP_LINES = { mission: 5, next: 3 };

/** Whether a box clipped to `clientHeight` hides text, past a pixel of rounding; a box not laid out never does. */
export function clipOverflows(scrollHeight, clientHeight) {
  return scrollHeight - clientHeight > 1;
}

/** What the toggle shows: hidden when the text fits, otherwise its state and the i18n key of what a press does. */
export function clipToggle(open, overflows) {
  const expanded = Boolean(open && overflows);
  return { hidden: !overflows, expanded, clipped: Boolean(overflows && !open), label: expanded ? 'overview.clip.less' : 'overview.clip.more' };
}
