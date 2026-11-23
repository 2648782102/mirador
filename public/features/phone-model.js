// Pure rules of the phone layout (#41, option A; public/features/phone.js wires them). No DOM and
// no core.js: the browser and the tests import it (test/phone-model.test.ts).
//
// Screen width alone picks the layout: under PHONE_MAX_WIDTH the page opens on the "Te esperan"
// inbox, full-screen, instead of the terminal deck. A phone view is one of:
// - 'inbox': the inbox over the whole screen, a sticky header with the count and the stream state;
// - 'deck': the full UI as a narrow window shows it (terminals, the sidebar and panel as drawers);
// - 'terminal': the terminal a card opened, full-screen, with the key bar under it.
// null is the desktop layout, which a wide window keeps exactly as before.

/** The widest viewport, in CSS px, that gets the phone layout; public/styles/phone.css uses the same query. */
export const PHONE_MAX_WIDTH = 600;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/** A viewport `width` (CSS px) that gets the phone layout. */
export const isNarrow = (width) => width <= PHONE_MAX_WIDTH;

/**
 * The phone view after `action`, with `narrow` whether the viewport is under the width now; a wide
 * viewport always answers null. Actions: 'start' (the page opens), 'resize' (the width changed),
 * 'back' (a view's back control: the terminal goes back to the inbox, the inbox to the deck),
 * 'inbox' (the deck's "Te esperan" button), 'full' (the inbox's link to the full UI), 'open' (a
 * card was tapped) and 'gone' (the open terminal closed).
 */
export function nextView(view, { action, narrow }) {
  if (!narrow) return null;
  switch (action) {
    case 'start':
      return 'inbox';
    case 'resize':
      return view ?? 'inbox';
    case 'back':
      return view === 'terminal' ? 'inbox' : 'deck';
    case 'inbox':
      return 'inbox';
    case 'full':
      return 'deck';
    case 'open':
      return 'terminal';
    case 'gone':
      return view === 'terminal' ? 'inbox' : view;
    default:
      return view;
  }
}

/**
 * Whether the active terminal can be on screen in `view`, so the inbox leaves its card out (the
 * desktop rule): not while the phone's inbox covers the deck.
 */
export const showsActiveTerminal = (view) => view !== 'inbox';

/**
 * The inbox header's text: the count of cards that need an answer (as "Te esperan (N)" counts) and
 * the stream's state, 'live' while GET /api/inbox/stream reads, anything else "reconnecting".
 * `t` is the translate function.
 */
export function inboxHeader(items, stream, t) {
  const count = Array.isArray(items) ? items.filter((item) => item.kind !== 'finished').length : 0;
  const live = stream === 'live';
  return { title: t('inbox.phone.title', { count }), state: t(live ? 'inbox.phone.live' : 'inbox.phone.reconnecting'), live };
}

/**
 * The key bar under a phone terminal: keys a soft keyboard makes hard to type. `key` is the
 * KeyboardEvent key, `caption` what the button shows, `labelKey` its spoken name. Digit keys come
 * only once each agent's menus are verified to take them (#41).
 */
export const KEY_BAR = [
  { key: 'Escape', caption: 'Esc', labelKey: 'term.keys.escape' },
  { key: 'Tab', caption: 'Tab', labelKey: 'term.keys.tab' },
  { key: 'ArrowLeft', caption: '←', labelKey: 'term.keys.left' },
  { key: 'ArrowUp', caption: '↑', labelKey: 'term.keys.up' },
  { key: 'ArrowDown', caption: '↓', labelKey: 'term.keys.down' },
  { key: 'ArrowRight', caption: '→', labelKey: 'term.keys.right' },
  { key: 'Enter', caption: 'Enter', labelKey: 'term.keys.enter' },
];

const ESC = '\x1b';
const PLAIN = { Enter: '\r', Escape: ESC, Tab: '\t' };
const ARROW = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

/**
 * The bytes a key of the bar sends, as xterm.js sends them for that key without modifiers
 * (src/common/input/Keyboard.ts): CR, ESC, HT, and the arrows as CSI A–D, or SS3 A–D while the
 * program set application cursor mode (DECCKM, xterm's `modes.applicationCursorKeysMode`). null for
 * a key the bar does not have.
 */
export function keyBytes(key, { applicationCursor = false } = {}) {
  if (Object.hasOwn(PLAIN, key)) return PLAIN[key];
  if (Object.hasOwn(ARROW, key)) return `${ESC}${applicationCursor ? 'O' : '['}${ARROW[key]}`;
  return null;
}
