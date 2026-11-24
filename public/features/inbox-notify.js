// Browser notifications for the attention inbox (public/features/inbox.js), DOM-free so the tests
// drive it with a fake Notification API (test/inbox-notify.test.ts).
//
// Opt-in only: the permission is asked only from the inbox's own button (toggle), never on load.
// The choice is stored in localStorage as `mirador.inboxNotify` (core.js prefs, key NOTIFY_PREF):
// true once turned on with the permission granted, false once turned off or refused.
// One card, one tag, one notification:
// a card is a terminal's stay in the inbox with a blocker, a dialog or an error, from the first
// stream message that lists it that way to the first that does not. It notifies once, when it
// first shows up; a change while it stays (blocked → error → blocked, each with a new since, or
// another label) is the same card, and the same snapshot again (a reconnect, a re-render) is not
// new. When the card leaves (answered, cleared, its agent died, its terminal closed, or it became a
// finished turn), the notification this page showed for it is closed; a later wait is a new card
// and may notify again. After a reload the old notifications are not known and stay as they are.
// What already waits when the page opens, or while notifications are off, is taken as known and
// never notifies later. A burst (GROUP_AT or more new cards in one message) shows one notification
// for all of them, closed when the last of them leaves; what each says is inbox-notify-model.js.

import { cardNotification, GROUP_AT, groupNotification } from './inbox-notify-model.js';

/** The prefs key (localStorage `mirador.inboxNotify`). */
export const NOTIFY_PREF = 'inboxNotify';

/** One waiting episode: the terminal and when it started waiting (tests key what they saw by it; cards are keyed by terminal). */
export const episodeKey = (item) => `${item.terminalId}\u0000${item.since}`;

/** One card: the terminal's stay in the inbox with a blocker, a dialog or an error, whatever its since. */
const cardKey = (item) => item.terminalId;

/** Runs `step`, ignoring a throw: a notification the browser already dropped must not break the inbox. */
const quietly = (step) => {
  try {
    step();
  } catch {
    // Nothing to do: the notification is gone or never existed.
  }
};

/** Blockers, dialogs and errors notify; a finished turn waits for a review and does not. */
const notifies = (item) => item.kind !== 'finished';

/**
 * The notifier behind the inbox's notification button.
 * - `api`: the browser's Notification (`globalThis.Notification`), or null/undefined without one;
 * - `read()`/`write(value)`: the stored choice (prefs.read/write of NOTIFY_PREF);
 * - `show(item)`: shows one notification and returns it (anything truthy; one with `close()` is
 *   closed when its card leaves), or a falsy value when the browser threw.
 * Methods: `status()` → 'unsupported' | 'denied' | 'on' | 'off'; `toggle()` (from a click only)
 * → the new status; `receive(items, skip)` with each stream message → the items it notified,
 * `skip(item)` true for one the user is looking at (handled, never notified).
 * - `showGroup(items)` (optional): shows one notification for a burst of GROUP_AT or more new
 *   cards, as `show` does; without it every card gets its own.
 */
export function createInboxNotifier({ api, read, write, show, showGroup }) {
  let enabled = read() === true;
  let broken = false;
  /** Card keys in the last message; null until the first one (the baseline). */
  let known = null;
  /** Card key → the notification this page showed for it, closed when its last card leaves (a burst's stands for several). */
  const open = new Map();
  /** The last burst notification: a new burst replaces it in the browser, under the same tag. */
  let burst = null;
  const permission = () => (api ? api.permission : 'denied');

  const status = () => {
    if (!api || broken) return 'unsupported';
    if (permission() === 'denied') return 'denied';
    return enabled && permission() === 'granted' ? 'on' : 'off';
  };

  /** requestPermission as a promise; older browsers take a callback and return nothing. */
  const ask = () =>
    new Promise((resolve) => {
      const answer = api.requestPermission(resolve);
      if (answer && typeof answer.then === 'function') answer.then(resolve, () => resolve('default'));
    });

  return {
    status,
    async toggle() {
      if (status() === 'unsupported') return 'unsupported';
      if (status() === 'on') {
        enabled = false;
        write(false);
        return status();
      }
      if (permission() === 'denied') return 'denied';
      const granted = permission() === 'granted' || (await ask()) === 'granted';
      enabled = granted;
      write(granted);
      return status();
    },
    receive(items, skip = () => false) {
      const current = new Map(items.filter(notifies).map((item) => [cardKey(item), item]));
      // A card that left (answered, cleared, its agent died, its terminal closed, or now a finished
      // turn) takes its notification with it, also while notifications are off.
      for (const [key, notice] of open) {
        if (current.has(key)) continue;
        open.delete(key);
        if (![...open.values()].includes(notice)) quietly(() => notice.close());
      }
      const fresh = known ? [...current].filter(([key]) => !known.has(key)).map(([, item]) => item) : [];
      known = new Set(current.keys());
      if (status() !== 'on') return [];
      const due = fresh.filter((item) => !skip(item));
      if (showGroup && due.length >= GROUP_AT) {
        const notice = showGroup(due);
        if (!notice) {
          broken = true;
          return [];
        }
        // The browser replaced the last burst's notification: closing it now could close this one.
        for (const [key, shown] of open) if (shown === burst) open.delete(key);
        burst = notice;
        if (typeof notice.close === 'function') for (const item of due) open.set(cardKey(item), notice);
        return due;
      }
      const shown = [];
      for (const item of due) {
        const notice = show(item);
        if (!notice) {
          broken = true;
          break;
        }
        if (typeof notice.close === 'function') open.set(cardKey(item), notice);
        shown.push(item);
      }
      return shown;
    },
  };
}

/**
 * What one notification says (inbox-notify-model.js cardNotification): who waits and why, the
 * question and where; tagged by its card (the terminal and the time the card started, as it is
 * made when the card first waits), so a second window replaces the first one's notification
 * instead of adding another.
 */
export const notificationFor = (item, text) => cardNotification(item, text);

/**
 * Shows one card's notification with the browser's Notification class `Api` and returns it (a
 * throwing constructor is let through: the caller counts the browser as unsupported). A click
 * brings Mirador forward (`focus`), then `open(item)` selects the card's terminal when this window
 * still has it, then closes the notification. Each step may throw, for a notification whose card
 * already left or a window that cannot be focused; the click then does what it can and never throws.
 * Notifications are made once per card, when it first waits (createInboxNotifier), so the tag from
 * notificationFor is the card's: its terminal and the time the card started.
 */
export function showNotification(Api, item, text, { focus, open }) {
  const { title, options } = notificationFor(item, text);
  const notice = new Api(title, options);
  notice.onclick = () => {
    quietly(focus);
    quietly(() => open(item));
    quietly(() => notice.close());
  };
  return notice;
}

/**
 * Shows the notification for a burst of new cards (`entries` as `{ item, workspace }`,
 * inbox-notify-model.js groupNotification) and returns it; a throwing constructor is let through.
 * A click brings Mirador forward, then `openInbox()` shows the inbox, then closes the
 * notification; each step may throw and the click never does.
 */
export function showGroupNotification(Api, entries, text, { focus, openInbox }) {
  const { title, options } = groupNotification(entries, text);
  const notice = new Api(title, options);
  notice.onclick = () => {
    quietly(focus);
    quietly(openInbox);
    quietly(() => notice.close());
  };
  return notice;
}
