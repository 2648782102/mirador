// Pure shaping of the attention inbox view (public/features/inbox.js): which group each card
// and night note goes in, and in what order. No DOM and no core.js: the browser and the tests
// import it (test/inbox-model.test.ts).
//
// Order: the server already sends items and night notes sorted by the one ordering function,
// AttentionStore's sortItems (src/attention/store.ts): answers and errors before finished turns,
// the longest wait first. The "answer" group keeps that order as it arrives instead of sorting
// again, so what waits longest is always on top whatever its workspace or folder.

/** A card that waits for the user: a blocker, a dialog or an error (anything but a finished turn). */
export const answers = (item) => item.kind !== 'finished';

/**
 * The view's groups, empty ones left out:
 * - `answer`: blocked, prompt and error cards in the order received (longest wait first), then the
 *   night notes of that group, also as received; `count` counts the cards only.
 * - `review`: finished cards and their night notes by workspace (first seen first), then by
 *   folder and wait, as the inbox always grouped them; `count` counts the cards only.
 * `hidden(item)` leaves an item out (the terminal the user is looking at). Entries are
 * `{ item, note }`, `note` true for a night note.
 */
export function inboxGroups(items, notes, hidden = () => false) {
  const cards = items.filter((item) => !hidden(item)).map((item) => ({ item, note: false }));
  const extra = notes.filter((item) => !hidden(item)).map((item) => ({ item, note: true }));
  const listed = [...cards, ...extra];
  const groups = [];
  const waiting = listed.filter(({ item }) => answers(item));
  if (waiting.length) groups.push({ key: 'answer', entries: waiting, count: waiting.filter(({ note }) => !note).length });
  const review = listed.filter(({ item }) => !answers(item));
  if (review.length) {
    const byWorkspace = new Map();
    for (const entry of review) byWorkspace.set(entry.item.workspaceId, [...(byWorkspace.get(entry.item.workspaceId) ?? []), entry]);
    const workspaces = [...byWorkspace].map(([workspaceId, entries]) => [workspaceId, entries.sort((a, b) => a.item.rel.localeCompare(b.item.rel) || a.item.since.localeCompare(b.item.since))]);
    groups.push({ key: 'review', workspaces, count: review.filter(({ note }) => !note).length });
  }
  return groups;
}

/** How long since `since` (ISO) at `now` (ms), as an i18n key and its values: now, minutes, then hours. */
export function waitLabel(since, now) {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (!(minutes >= 1)) return { key: 'inbox.waited.now', vars: undefined };
  return minutes < 60 ? { key: 'inbox.waited.minutes', vars: { count: minutes } } : { key: 'inbox.waited.hours', vars: { count: Math.floor(minutes / 60) } };
}
