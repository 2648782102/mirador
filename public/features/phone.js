// Phone layout (#41, option A; docs/attention.md "On a phone"). Under 600px wide (phone-model.js
// PHONE_QUERY: the width alone, never the pointer) the page opens on the "Te esperan" inbox as a
// full-screen view instead of the terminal deck: a sticky header with the count, the stream's state
// (live or reconnecting) and a back control to the deck, the inbox's own cards under it, and a link
// to the full UI. A card opens its terminal full-screen in the existing xterm, with a key bar
// (Enter, Esc, the arrows, Tab) that types what a keyboard types (terminals.js typeKey) and a back
// control to the inbox. The view is <body data-phone="inbox|deck|terminal">, absent on a wide
// screen, which keeps the desktop layout as it was; public/styles/phone.css draws each view.
import { $, el, emit, on, t, workspaceById } from '/core.js';
import { icon } from '/icons.js';
import { closeDrawer } from '/features/drawers.js';
import { inboxStream } from '/features/inbox.js';
import { KEY_BAR, PHONE_QUERY, inboxHeader, nextView, screenTerminal, shownClosed } from '/features/phone-model.js';
import { activeTerminalId, refitAll, terminalList, typeKey } from '/terminals.js';

let media = null;
let view = null;
/** The inbox items (the `inbox` event) and the stream's state (the `inbox:stream` event). */
let items = [];
let stream = 'reconnecting';
/** The nodes whose text follows the language, the count and the stream. */
let ui = null;

/** A back control's arrow: the sprite's one chevron, mirrored (styles/phone.css). */
const backIcon = () => icon('chev-right');

/**
 * The terminal on screen in the terminal view, which its header names and the key bar types into:
 * the active one, whatever activated it (phone-model.js screenTerminal), or null.
 */
const shownId = () => screenTerminal(view, activeTerminalId(), terminalList());

/**
 * What shownId answered when the terminal view opened or another terminal was activated in it. Not
 * what is on screen (shownId says that): only how its close is told from an activation, since
 * closeTerminal activates the next terminal before the list drops the closed one (L3).
 */
let lastShown = null;

/**
 * Moves to the phone view `action` leads to (phone-model.js nextView); `focus` is where the
 * keyboard goes once it shows, for a switch the user asked for (a hidden control drops it).
 */
function go(action, { focus = null } = {}) {
  const next = nextView(view, { action, narrow: media.matches });
  if (next === view) return;
  view = next;
  if (view) document.body.dataset.phone = view;
  else delete document.body.dataset.phone;
  // The inbox and the terminal cover the page: no drawer stays open (and inert) behind them.
  if (view === 'inbox' || view === 'terminal') closeDrawer();
  if (view !== 'terminal') lastShown = null;
  paint();
  emit('phone', view);
  refitAll();
  if (focus) $(focus)?.focus({ preventScroll: true });
}

function build() {
  const inboxBack = el('button', { type: 'button', class: 'btn phone-back', id: 'phone-inbox-back', onclick: () => go('back', { focus: '#phone-to-inbox' }) }, backIcon(), el('span', {}));
  const title = el('h2', { class: 'phone-title', id: 'phone-inbox-title', tabindex: '-1' });
  const state = el('span', { class: 'phone-stream', role: 'status' }, el('span', { class: 'phone-dot', 'aria-hidden': 'true' }), el('span', {}));
  $('#phone-inbox-head').replaceChildren(inboxBack, title, state);

  const full = el('button', { type: 'button', class: 'btn phone-full', id: 'phone-full', 'aria-describedby': 'phone-full-hint', onclick: () => go('full', { focus: '#phone-to-inbox' }) });
  const fullHint = el('p', { class: 'phone-full-hint', id: 'phone-full-hint' });
  $('#phone-inbox-foot').replaceChildren(full, fullHint);

  const toInbox = $('#phone-to-inbox');
  toInbox.addEventListener('click', () => go('inbox', { focus: '#phone-inbox-title' }));

  const termBack = el('button', { type: 'button', class: 'btn phone-back', id: 'phone-term-back', onclick: () => go('back', { focus: '#phone-inbox-title' }) }, backIcon(), el('span', {}));
  const termTitle = el('span', { class: 'phone-term-title', id: 'phone-term-title', tabindex: '-1', translate: 'no' });
  $('#phone-term-head').replaceChildren(termBack, termTitle);

  // A press on a key keeps the focus where it is (mousedown), so an open soft keyboard stays open
  // and a closed one is not raised; the click types the key.
  const keys = KEY_BAR.map(({ key, caption, labelKey }) =>
    el('button', { type: 'button', class: 'btn phone-key', 'data-key': key, 'data-label': labelKey, translate: 'no', onmousedown: (event) => event.preventDefault(), onclick: () => typeOnScreen(key) }, caption),
  );
  $('#phone-keys').replaceChildren(...keys);

  ui = { inboxBack, title, state, full, fullHint, toInbox, termBack, termTitle, keys };
}

/** Types `key` into the terminal on screen; with none, nothing. */
function typeOnScreen(key) {
  const id = shownId();
  if (id) typeKey(id, key);
}

/** "title · workspace › folder" of the terminal on screen, or nothing without one. */
function terminalLabel() {
  const id = shownId();
  const info = id && terminalList().find((terminal) => terminal.id === id);
  if (!info) return '';
  const workspace = workspaceById(info.workspaceId)?.name ?? info.workspaceId;
  return `${info.title} · ${info.rel ? `${workspace} › ${info.rel.split('/').join(' › ')}` : workspace}`;
}

function paint() {
  if (!ui) return;
  const header = inboxHeader(items, stream, t);
  ui.inboxBack.lastChild.textContent = t('inbox.phone.toDeck');
  ui.inboxBack.setAttribute('aria-label', t('inbox.phone.toDeckLabel'));
  ui.title.textContent = header.title;
  ui.state.classList.toggle('live', header.live);
  ui.state.lastChild.textContent = header.state;
  ui.full.textContent = t('inbox.phone.full');
  ui.fullHint.textContent = t('inbox.phone.fullHint');
  ui.toInbox.textContent = header.title;
  ui.termBack.lastChild.textContent = t('inbox.phone.toInbox');
  ui.termBack.setAttribute('aria-label', t('inbox.phone.toInboxLabel'));
  ui.termTitle.textContent = terminalLabel();
  for (const key of ui.keys) key.setAttribute('aria-label', t(key.dataset.label));
}

export async function init() {
  build();
  stream = inboxStream();
  on('inbox', (list) => {
    items = Array.isArray(list) ? list : [];
    paint();
  });
  on('inbox:stream', (next) => {
    stream = next;
    paint();
  });
  // A card was tapped (features/inbox.js openCard, which activated its terminal): it, full-screen.
  on('inbox:open', () => {
    go('open', { focus: '#phone-term-title' });
    lastShown = shownId();
    paint();
  });
  // Another terminal came on screen (a notification click, any `activate`): the header and the keys
  // follow it. Unless the one shown was closed and this is the next one closeTerminal activated:
  // back to the inbox (L3).
  on('activate', () => {
    if (view === 'terminal' && shownClosed(lastShown, terminalList())) return go('gone', { focus: '#phone-inbox-title' });
    lastShown = shownId();
    paint();
  });
  // The terminal on screen closed (here or in another window): back to the inbox.
  on('terminals', () => {
    if (view === 'terminal' && !shownId()) go('gone', { focus: '#phone-inbox-title' });
    else paint();
  });
  on('language', paint);
  on('workspaces', paint);
  media = window.matchMedia(PHONE_QUERY);
  media.addEventListener('change', () => go('resize'));
  go('start');
}
