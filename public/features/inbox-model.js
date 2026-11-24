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

/**
 * The parts of a card, in order, and whether its place names the workspace. The desktop shows the
 * place first and names the workspace only in "needs you" (`named`: "finished" is grouped by
 * workspace); the phone layout reads the reason first, then workspace › folder, then the wait,
 * every card naming its workspace. Parts: 'place', 'reason', 'detail', 'night' and 'meta' (the wait).
 */
export function cardLayout(phone, named) {
  return phone ? { parts: ['reason', 'place', 'meta', 'detail', 'night'], named: true } : { parts: ['place', 'reason', 'detail', 'night', 'meta'], named };
}

/**
 * The inbox stream's liveness (GET /api/inbox/stream, read by inbox.js follow()). The server writes
 * a `{}` heartbeat every 25 s (HEARTBEAT_MS, src/http/routes/inbox.ts), so a stream that reads
 * nothing for STREAM_SILENCE_MS is taken as dead, even though its socket is still open: on a phone,
 * the SSH tunnel can die while the browser is in the background, and the read then waits forever on
 * the local end. Two heartbeats plus 10 s: one heartbeat late or lost on a slow link is not a dead
 * stream; two missed in a row, with room for the time a phone takes to wake, is.
 */
export const STREAM_HEARTBEAT_MS = 25_000;
export const STREAM_SILENCE_MS = 2 * STREAM_HEARTBEAT_MS + 10_000;

/**
 * Whether the stream is not to be trusted at `now` (ms): nothing read for the bound since `since`
 * (when the try started or last read anything), or, given `hiddenAt`, the page was hidden that long.
 */
export function streamStale({ since, now, hiddenAt = null, bound = STREAM_SILENCE_MS }) {
  return now - since >= bound || (hiddenAt !== null && now - hiddenAt >= bound);
}

/**
 * Watches each try of the stream, with the clock and timers given (`now`, `setTimer`, `clearTimer`).
 * `open()` starts a try and returns the AbortSignal for its fetch; `alive()` marks anything read;
 * `close()` ends the try (aborting it, so nothing is left open). A try silent for the bound is
 * aborted by its timer, and the caller retries with its backoff. `hidden()` and `visible()` follow
 * the page: coming back after being hidden for the bound, or to a try silent for the bound (a phone
 * holds timers while it sleeps), aborts the try at once, and `retryNow()` then says to skip the
 * backoff. A fresh try survives any number of flips, so nothing loops while the page is hidden.
 */
export function streamWatch({ now, setTimer, clearTimer, bound = STREAM_SILENCE_MS }) {
  let controller = null;
  let since = 0;
  let timer = null;
  let hiddenAt = null;
  let urgent = false;
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const check = () => {
    timer = null;
    if (!controller) return;
    const at = now();
    if (streamStale({ since, now: at, bound })) controller.abort();
    else timer = setTimer(check, since + bound - at);
  };
  return {
    open() {
      this.close();
      controller = new AbortController();
      since = now();
      urgent = false;
      timer = setTimer(check, bound);
      return controller.signal;
    },
    alive() {
      since = now();
    },
    close() {
      stopTimer();
      controller?.abort();
      controller = null;
    },
    hidden() {
      hiddenAt ??= now();
    },
    visible() {
      const was = hiddenAt;
      hiddenAt = null;
      if (was === null || !controller || !streamStale({ since, now: now(), hiddenAt: was, bound })) return false;
      urgent = true;
      stopTimer();
      controller.abort();
      return true;
    },
    retryNow() {
      const skip = urgent;
      urgent = false;
      return skip;
    },
  };
}
