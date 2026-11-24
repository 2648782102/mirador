// Browser notifications for the attention inbox (public/features/inbox-notify.js), DOM-free: a
// fake Notification API stands in for the browser's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInboxNotifier, episodeKey, NOTIFY_PREF, NOTIFY_WINDOW_MS, notificationFor, showGroupNotification, showNotification } from '../public/features/inbox-notify.js';

const item = (terminalId: string, kind: string, since: string, extra: Record<string, unknown> = {}) => ({ terminalId, workspaceId: 'dev', rel: 'api', title: 'api', kind, label: 'Awaiting input', detail: null, since, activity: null, ...extra });
const T0 = '2026-10-28T10:00:00.000Z';
const T1 = '2026-10-28T10:05:00.000Z';

/** A browser's Notification API: its permission, and every requestPermission call. */
function fakeApi(permission: string, answer = 'granted') {
  const api = {
    permission,
    asked: 0,
    requestPermission() {
      api.asked++;
      api.permission = answer;
      return Promise.resolve(answer);
    },
  };
  return api;
}

/** A notifier on fake storage and a fake `show` that records what it shows. */
function setup(options: { api?: ReturnType<typeof fakeApi> | null; stored?: unknown; show?: (item: unknown) => boolean } = {}) {
  const store = new Map<string, unknown>();
  if (options.stored !== undefined) store.set(NOTIFY_PREF, options.stored);
  const shown: string[] = [];
  const api = options.api === undefined ? fakeApi('granted') : options.api;
  const notifier = createInboxNotifier({
    api,
    read: () => (store.has(NOTIFY_PREF) ? store.get(NOTIFY_PREF) : false),
    write: (value: unknown) => store.set(NOTIFY_PREF, value),
    show: options.show ?? ((shownItem: any) => { shown.push(episodeKey(shownItem)); return true; }),
  });
  return { notifier, shown, store, api };
}

test('a waiting or error item notifies once, the first time it appears; a reconnect or re-render with the same items does not', () => {
  const { notifier, shown } = setup({ stored: true });
  assert.deepEqual(notifier.receive([]), [], 'the first message only sets the baseline');
  const blocked = item('t1', 'blocked', T0);
  assert.deepEqual(notifier.receive([blocked]).map((i: any) => i.terminalId), ['t1']);
  assert.deepEqual(notifier.receive([blocked]), [], 'the same snapshot again (a re-render)');
  assert.deepEqual(notifier.receive([{ ...blocked, kind: 'prompt', label: 'Review consent' }]), [], 'the same wait, another label');
  // The stream reconnects: the server sends the whole snapshot again.
  assert.deepEqual(notifier.receive([blocked, item('t2', 'error', T1)]).map((i: any) => [i.terminalId, i.kind]), [['t2', 'error']]);
  assert.deepEqual(shown, [episodeKey(blocked), episodeKey(item('t2', 'error', T1))]);
});

test('a finished turn never notifies; an item that clears and waits again (a new since) notifies again', () => {
  const { notifier, shown } = setup({ stored: true });
  notifier.receive([]);
  assert.deepEqual(notifier.receive([item('t1', 'finished', T0, { label: 'Finished' })]), []);
  notifier.receive([item('t1', 'blocked', T0)]);
  notifier.receive([]);
  notifier.receive([item('t1', 'blocked', T1)]);
  assert.deepEqual(shown, [`t1\u0000${T0}`, `t1\u0000${T1}`]);
});

test('what was already waiting when the page opened does not notify; skipped items count as handled', () => {
  const { notifier, shown } = setup({ stored: true });
  notifier.receive([item('t1', 'blocked', T0)]);
  assert.deepEqual(notifier.receive([item('t1', 'blocked', T0), item('t2', 'blocked', T1)], (i: any) => i.terminalId === 't2'), [], 'he is looking at t2');
  assert.deepEqual(notifier.receive([item('t1', 'blocked', T0), item('t2', 'blocked', T1)]), [], 'switching away later does not notify it');
  assert.deepEqual(shown, []);
});

test('disabled, denied or unsupported never notifies, and new items seen meanwhile do not burst out when turned on', async () => {
  const off = setup();
  off.notifier.receive([]);
  assert.deepEqual(off.notifier.receive([item('t1', 'blocked', T0)]), []);
  assert.equal(off.notifier.status(), 'off');
  await off.notifier.toggle();
  assert.equal(off.notifier.status(), 'on');
  assert.deepEqual(off.notifier.receive([item('t1', 'blocked', T0)]), [], 'already known before it was turned on');
  assert.deepEqual(off.shown, []);

  const denied = setup({ stored: true, api: fakeApi('denied') });
  denied.notifier.receive([]);
  assert.deepEqual(denied.notifier.receive([item('t1', 'blocked', T0)]), []);
  assert.equal(denied.notifier.status(), 'denied');

  const missing = setup({ stored: true, api: null });
  missing.notifier.receive([]);
  assert.deepEqual(missing.notifier.receive([item('t1', 'blocked', T0)]), []);
  assert.equal(missing.notifier.status(), 'unsupported');
  assert.deepEqual(await missing.notifier.toggle(), 'unsupported', 'the control does nothing without the API');
  assert.deepEqual([denied.shown, missing.shown], [[], []]);
});

test('a browser that throws on new Notification counts as unsupported from then on', () => {
  const { notifier } = setup({ stored: true, show: () => false });
  notifier.receive([]);
  notifier.receive([item('t1', 'blocked', T0)]);
  assert.equal(notifier.status(), 'unsupported');
});

test('requestPermission is called only by the explicit toggle, never on load, status or receive; the choice is stored', async () => {
  const api = fakeApi('default', 'granted');
  const { notifier, store } = setup({ api });
  assert.equal(notifier.status(), 'off');
  notifier.receive([]);
  notifier.receive([item('t1', 'blocked', T0)]);
  assert.equal(api.asked, 0, 'loading, reading the status and receiving items never ask');
  assert.equal(await notifier.toggle(), 'on');
  assert.equal(api.asked, 1);
  assert.equal(store.get(NOTIFY_PREF), true);
  assert.equal(await notifier.toggle(), 'off', 'turning off asks nothing');
  assert.equal(api.asked, 1);
  assert.equal(store.get(NOTIFY_PREF), false);
  assert.equal(await notifier.toggle(), 'on', 'granted already: no second prompt');
  assert.equal(api.asked, 1);

  const refused = setup({ api: fakeApi('default', 'denied') });
  assert.equal(await refused.notifier.toggle(), 'denied');
  assert.equal(refused.store.get(NOTIFY_PREF), false, 'a refusal is not stored as on');
  const dismissed = setup({ api: fakeApi('default', 'default') });
  assert.equal(await dismissed.notifier.toggle(), 'off', 'the prompt closed without an answer');
  const blocked = setup({ api: fakeApi('denied') });
  assert.equal(await blocked.notifier.toggle(), 'denied');
  assert.equal(blocked.api!.asked, 0, 'a denied permission is not asked again');
});

test('a stored "on" with the permission reset to default reads as off until clicked', () => {
  const { notifier } = setup({ stored: true, api: fakeApi('default') });
  assert.equal(notifier.status(), 'off');
});

test('the notification says who waits (inbox-notify-model.js), tagged by its episode', () => {
  const shown = notificationFor(item('t1', 'error', T0, { detail: 'Build failed' }), { reason: 'Stopped with an error', workspace: 'dev', agent: 'Claude Code', lang: 'en' });
  assert.deepEqual(shown, {
    title: 'api · Stopped with an error',
    options: { body: 'Build failed\nClaude Code · dev › api', tag: `mirador-inbox:t1:${T0}`, requireInteraction: false, icon: '/notify-icon.png', badge: '/notify-badge.png', lang: 'en', timestamp: Date.parse(T0) },
  });
  const blocked = notificationFor(item('t2', 'blocked', T1), { reason: 'Waiting for your answer', workspace: 'dev' });
  assert.deepEqual([blocked.title, blocked.options.body, blocked.options.requireInteraction], ['api · Waiting for your answer', 'dev › api', true]);
});

/** A PNG's width and height, from its IHDR chunk, or null for anything else. */
function pngSize(path: string) {
  const bytes = readFileSync(new URL(path, import.meta.url));
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('the icon and the badge are PNGs of the mark under public/, served by Mirador itself', () => {
  const { options } = notificationFor(item('t1', 'blocked', T0), { reason: 'r', workspace: 'w' });
  assert.deepEqual([options.icon, options.badge], ['/notify-icon.png', '/notify-badge.png'], 'same-origin paths, never another host');
  assert.deepEqual(pngSize('../public/notify-icon.png'), [192, 192]);
  assert.deepEqual(pngSize('../public/notify-badge.png'), [96, 96]);
});

// A card is a terminal's stay
// in the inbox with a blocker, a dialog or an error; one card has one tag and one notification, and its
// notification closes when the card leaves.

const T2 = '2026-10-28T10:07:00.000Z';

/** A browser's Notification class: every notification made, its tag, and whether it was closed. */
class FakeNotification {
  static made: FakeNotification[] = [];
  static permission = 'granted';
  static requestPermission() { return Promise.resolve('granted'); }
  title: string;
  options: { tag: string; body: string; requireInteraction?: boolean };
  closed = 0;
  onclick: null | (() => void) = null;
  constructor(title: string, options: { tag: string; body: string; requireInteraction?: boolean }) {
    this.title = title;
    this.options = options;
    FakeNotification.made.push(this);
  }
  close() { this.closed++; }
}

/** A notifier that is on and shows real (fake-class) notifications, as inbox.js does; `baseline` is its first message. */
function shownBy(baseline: unknown[] = []) {
  FakeNotification.made = [];
  const notifier = createInboxNotifier({
    api: FakeNotification,
    read: () => true,
    write: () => {},
    show: (shownItem: any) => {
      const { title, options } = notificationFor(shownItem, { reason: shownItem.kind, workspace: 'dev' });
      return new FakeNotification(title, options);
    },
  });
  notifier.receive(baseline);
  return notifier;
}

test('one card, one tag, one notification: blocked → error → blocked on the same terminal notifies once', () => {
  const notifier = shownBy();
  assert.deepEqual(notifier.receive([item('t1', 'blocked', T0)]).map((i: any) => i.kind), ['blocked']);
  assert.deepEqual(notifier.receive([item('t1', 'error', T1, { label: 'Error', detail: 'Build failed' })]), [], 'the error has a new since, but it is the same card');
  assert.deepEqual(notifier.receive([item('t1', 'blocked', T2)]), [], 'and back to blocked: still the same card');
  assert.deepEqual(FakeNotification.made.map((n) => n.options.tag), [`mirador-inbox:t1:${T0}`], 'one notification, tagged by the card');
  assert.equal(FakeNotification.made[0].closed, 0, 'the card stayed: its notification stays');
});

test('a card that leaves closes its notification, whatever took it away; cards that stay keep theirs', () => {
  // Every way a card leaves reaches the notifier as one of two stream messages: the terminal is no
  // longer listed (answered or cleared by the agent or its hooks, the agent died, the terminal
  // closed), or it is listed as a finished turn (answered, and the agent ended its turn).
  const leaves: Array<[string, (rest: any[]) => any[]]> = [
    ['answered or cleared: no longer listed', (rest) => rest],
    ['answered, then the turn ended: a finished card', (rest) => [item('t1', 'finished', T2, { label: 'Finished' }), ...rest]],
  ];
  for (const [why, next] of leaves) {
    const notifier = shownBy();
    const stays = item('t2', 'error', T0, { label: 'Error' });
    notifier.receive([stays]);
    notifier.receive([item('t1', 'blocked', T1), stays]);
    const [forStays, forLeaves] = FakeNotification.made;
    notifier.receive([item('t1', 'blocked', T1), stays]); // the same snapshot again (a re-render, a reconnect)
    assert.deepEqual([forStays.closed, forLeaves.closed], [0, 0], `${why}: nothing left yet`);
    notifier.receive(next([stays]));
    assert.deepEqual([forStays.closed, forLeaves.closed], [0, 1], why);
    notifier.receive(next([stays]));
    assert.equal(forLeaves.closed, 1, `${why}: closed once`);
    notifier.receive([]);
    assert.equal(forStays.closed, 1, `${why}: the other card leaves later`);
  }
});

test('notifications turned off or refused later still close when their card leaves', async () => {
  const notifier = shownBy();
  notifier.receive([item('t1', 'blocked', T0)]);
  await notifier.toggle();
  assert.equal(notifier.status(), 'off');
  notifier.receive([]);
  assert.equal(FakeNotification.made[0].closed, 1);
});

test('a card that leaves and comes back later is a new wait: a new notification, and the old one stays closed', () => {
  const notifier = shownBy();
  notifier.receive([item('t1', 'blocked', T0)]);
  notifier.receive([]);
  notifier.receive([item('t1', 'blocked', T1)]);
  assert.deepEqual(FakeNotification.made.map((n) => [n.options.tag, n.closed]), [[`mirador-inbox:t1:${T0}`, 1], [`mirador-inbox:t1:${T1}`, 0]]);
});

test('after a reload the old notifications are not known: cards leaving close nothing and throw nothing', () => {
  const before = shownBy();
  before.receive([item('t1', 'blocked', T0)]);
  const old = FakeNotification.made[0];
  // The page reloads: a new module instance, whose first message has the card as already known.
  const after = shownBy([item('t1', 'blocked', T0)]);
  assert.doesNotThrow(() => after.receive([]));
  assert.deepEqual([old.closed, FakeNotification.made.length], [0, 0], 'the old one is left alone; nothing new is shown');
});

test('a notification whose close() throws does not stop the others from closing, nor the next notification', () => {
  const notifier = shownBy();
  notifier.receive([item('t1', 'blocked', T0), item('t2', 'blocked', T0)]);
  const [first, second] = FakeNotification.made;
  first.close = () => { throw new Error('gone'); };
  assert.doesNotThrow(() => notifier.receive([]));
  assert.equal(second.closed, 1);
  assert.deepEqual(notifier.receive([item('t3', 'blocked', T1)]).map((i: any) => i.terminalId), ['t3']);
  assert.equal(notifier.status(), 'on');
});

test('a `show` that returns true without a notification (no handle) still counts as shown', () => {
  const { notifier, shown } = setup({ stored: true });
  notifier.receive([]);
  notifier.receive([item('t1', 'blocked', T0)]);
  assert.doesNotThrow(() => notifier.receive([]));
  assert.deepEqual([shown.length, notifier.status()], [1, 'on']);
});

/** The page side of a click: focusing the window and opening the card's terminal, recorded. */
function page(options: { focusThrows?: boolean; openThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    focus: () => { calls.push('focus'); if (options.focusThrows) throw new Error('no window'); },
    open: (opened: any) => { calls.push(`open ${opened.terminalId}`); if (options.openThrows) throw new Error('no terminal'); },
  };
}

test('showNotification makes the notification notificationFor describes; a click focuses Mirador, opens the card and closes it', () => {
  FakeNotification.made = [];
  const card = item('t1', 'blocked', T0, { detail: 'npm publish' });
  const { calls, focus, open } = page();
  const notice = showNotification(FakeNotification, card, { reason: 'Waiting for your answer', workspace: 'dev' }, { focus, open });
  assert.equal(notice, FakeNotification.made[0]);
  const expected = notificationFor(card, { reason: 'Waiting for your answer', workspace: 'dev' });
  assert.deepEqual([notice.title, notice.options], [expected.title, expected.options]);
  notice.onclick!();
  assert.deepEqual(calls, ['focus', 'open t1']);
  assert.equal(notice.closed, 1);
});

test('a click on a stale notification focuses Mirador without throwing, whatever the window or the terminal does', () => {
  // Its card left (the notification was closed, but the click was already on its way) and its
  // terminal is gone: open() is where inbox.js finds no terminal and does nothing, or throws.
  for (const options of [{}, { openThrows: true }, { focusThrows: true }, { focusThrows: true, openThrows: true }]) {
    FakeNotification.made = [];
    const { calls, focus, open } = page(options);
    const notice = showNotification(FakeNotification, item('gone', 'error', T0), { reason: 'Stopped with an error', workspace: 'dev' }, { focus, open });
    notice.close = () => { throw new Error('already closed'); };
    assert.doesNotThrow(() => notice.onclick!(), JSON.stringify(options));
    assert.deepEqual(calls, ['focus', 'open gone'], JSON.stringify(options));
  }
});

test('showNotification lets a throwing constructor through, so the notifier counts the browser as unsupported', () => {
  class Throws { constructor() { throw new TypeError('Illegal constructor'); } }
  assert.throws(() => showNotification(Throws, item('t1', 'blocked', T0), { reason: 'r', workspace: 'w' }, page()), TypeError);
});

// Bursts: when one stream message brings GROUP_AT (3) or more new cards to notify, one notification
// stands for all of them, under one stable tag; fewer get one notification each, as before.

/** A notifier that is on, with `show` and `showGroup` recording what they make (fake-class notifications). */
function grouping() {
  FakeNotification.made = [];
  const singles: string[] = [];
  const groups: string[][] = [];
  const notifier = createInboxNotifier({
    api: FakeNotification,
    read: () => true,
    write: () => {},
    show: (shownItem: any) => {
      singles.push(shownItem.terminalId);
      return new FakeNotification(shownItem.terminalId, { tag: `mirador-inbox:${shownItem.terminalId}:${shownItem.since}`, body: '' });
    },
    showGroup: (list: any[]) => {
      groups.push(list.map((shownItem) => shownItem.terminalId));
      return new FakeNotification(`${list.length}`, { tag: 'mirador-inbox:group', body: '' });
    },
  });
  notifier.receive([]);
  return { notifier, singles, groups };
}

test('a burst: 2 new cards give 2 notifications, 3 give 1 for all of them', () => {
  const two = grouping();
  assert.deepEqual(two.notifier.receive([item('t1', 'blocked', T0), item('t2', 'error', T0)]).map((i: any) => i.terminalId), ['t1', 't2']);
  assert.deepEqual([two.singles, two.groups], [['t1', 't2'], []]);

  const three = grouping();
  const burst = [item('t1', 'blocked', T0), item('t2', 'prompt', T0), item('t3', 'error', T0)];
  assert.deepEqual(three.notifier.receive(burst).map((i: any) => i.terminalId), ['t1', 't2', 't3']);
  assert.deepEqual([three.singles, three.groups], [[], [['t1', 't2', 't3']]]);
  assert.deepEqual(three.notifier.receive(burst), [], 'the same snapshot again notifies nothing');
});

test('a burst counts only what notifies: finished turns, known cards and what the user looks at do not', () => {
  const { notifier, singles, groups } = grouping();
  notifier.receive([item('t0', 'blocked', T0)]);
  const message = [item('t0', 'blocked', T0), item('t1', 'blocked', T1), item('t2', 'blocked', T1), item('t3', 'finished', T1), item('t4', 'blocked', T1)];
  notifier.receive(message, (i: any) => i.terminalId === 't4');
  assert.deepEqual([singles, groups], [['t0', 't1', 't2'], []]);
});

test('the burst notification closes when the last of its cards leaves; a later burst replaces it under the same tag', () => {
  const { notifier, groups } = grouping();
  const [a, b, c] = ['t1', 't2', 't3'].map((id) => item(id, 'blocked', T0));
  notifier.receive([a, b, c]);
  const first = FakeNotification.made[0];
  notifier.receive([a, b]);
  assert.equal(first.closed, 0, 'two of its cards still wait');
  notifier.receive([a]);
  assert.equal(first.closed, 0);
  const [d, e, f] = ['t4', 't5', 't6'].map((id) => item(id, 'error', T1));
  notifier.receive([a, d, e, f]);
  const second = FakeNotification.made[1];
  assert.deepEqual([groups.length, second.options.tag, first.options.tag], [2, 'mirador-inbox:group', 'mirador-inbox:group']);
  notifier.receive([d, e, f]);
  assert.equal(first.closed, 0, 'the browser already replaced it: closing it could close its replacement');
  notifier.receive([]);
  assert.equal(second.closed, 1, 'its cards left: closed once');
});

test('without showGroup (callers before bursts) every new card still gets its own notification', () => {
  const { notifier, shown } = setup({ stored: true });
  notifier.receive([]);
  notifier.receive(['t1', 't2', 't3'].map((id) => item(id, 'blocked', T0)));
  assert.equal(shown.length, 3);
});

test('a burst the browser refuses counts as unsupported, like a single one', () => {
  const notifier = createInboxNotifier({ api: FakeNotification, read: () => true, write: () => {}, show: () => true, showGroup: () => null });
  notifier.receive([]);
  notifier.receive(['t1', 't2', 't3'].map((id) => item(id, 'blocked', T0)));
  assert.equal(notifier.status(), 'unsupported');
});

test('showGroupNotification: the burst text; a click focuses Mirador, opens the inbox and closes it, never throwing', () => {
  FakeNotification.made = [];
  const calls: string[] = [];
  const entries = ['t1', 't2', 't3'].map((id) => ({ item: item(id, 'blocked', T0), workspace: 'dev' }));
  const words = { lang: 'en', waiting: (count: number) => `${count} agents are waiting for you` };
  const notice = showGroupNotification(FakeNotification, entries, words, {
    focus: () => { calls.push('focus'); throw new Error('no window'); },
    openInbox: () => { calls.push('inbox'); },
  });
  assert.deepEqual([notice.title, notice.options.tag, notice.options.body], ['3 agents are waiting for you', 'mirador-inbox:group', 'api']);
  notice.close = () => { throw new Error('already closed'); };
  assert.doesNotThrow(() => notice.onclick!());
  assert.deepEqual(calls, ['focus', 'inbox']);
});

// The window: the server sends one stream message per change, so cards that start waiting at almost
// the same moment arrive one message each. The page collects new cards for NOTIFY_WINDOW_MS (1.5 s)
// from the first of them, then notifies: 1 or 2 one by one, GROUP_AT (3) or more as one burst.

/**
 * A notifier on the 1.5 s window whose timer the test runs (`tick()` ends the window), with `show`
 * and `showGroup` making fake-class notifications. `stored` is the saved choice.
 */
function windowed(options: { api?: ReturnType<typeof fakeApi>; stored?: boolean; show?: (item: any) => unknown; showGroup?: (items: any[]) => unknown } = {}) {
  FakeNotification.made = [];
  const api = options.api ?? fakeApi('granted');
  let stored = options.stored ?? true;
  const timers = new Map<number, () => void>();
  const started: number[] = [];
  let next = 0;
  const singles: string[] = [];
  const groups: string[][] = [];
  const counts = { refused: 0 };
  const notifier = createInboxNotifier({
    api,
    read: () => stored,
    write: (value: boolean) => { stored = value; },
    show: options.show ?? ((shownItem: any) => {
      singles.push(shownItem.terminalId);
      return new FakeNotification(shownItem.terminalId, { tag: `mirador-inbox:${shownItem.terminalId}:${shownItem.since}`, body: '' });
    }),
    showGroup: (list: any[]) => {
      groups.push(list.map((shownItem) => shownItem.terminalId));
      return options.showGroup ? options.showGroup(list) : new FakeNotification(`${list.length}`, { tag: 'mirador-inbox:group', body: '' });
    },
    windowMs: NOTIFY_WINDOW_MS,
    setTimer: (fn: () => void, ms: number) => { started.push(ms); timers.set(++next, fn); return next; },
    clearTimer: (id: number) => { timers.delete(id); },
    onRefused: () => { counts.refused++; },
  });
  notifier.receive([]);
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  return { notifier, api, singles, groups, timers, started, counts, tick };
}

const cards = (ids: string[], kind = 'blocked', since = T0) => ids.map((id) => item(id, kind, since));

test('the window is 1.5 s; without windowMs the notifier notifies at once (callers before the window)', () => {
  assert.equal(NOTIFY_WINDOW_MS, 1500);
  const { notifier, shown } = setup({ stored: true });
  notifier.receive([]);
  assert.deepEqual(notifier.receive(cards(['t1'])).map((i: any) => i.terminalId), ['t1']);
  assert.equal(shown.length, 1);
});

test('the window: 3 cards in 3 separate messages within 1.5 s give 1 group, shown when the window ends', () => {
  const { notifier, singles, groups, started, tick } = windowed();
  const [a, b, c] = cards(['t1', 't2', 't3']);
  assert.deepEqual(notifier.receive([a]), [], 'nothing is shown inside the window');
  assert.deepEqual(notifier.receive([a, b]), []);
  assert.deepEqual(notifier.receive([a, b, c]), []);
  assert.deepEqual([singles, groups, FakeNotification.made.length], [[], [], 0], 'nothing yet');
  assert.deepEqual(started, [1500], 'one window, from the first new card: it does not slide');
  tick();
  assert.deepEqual([singles, groups], [[], [['t1', 't2', 't3']]]);
  notifier.receive([a, b, c]);
  assert.deepEqual([started.length, groups.length], [1, 1], 'the same snapshot after the window starts nothing');
});

test('the window: 2 cards give 2 singles after the window; a later card opens a new window', () => {
  const { notifier, singles, groups, started, tick } = windowed();
  const [a, b, c] = cards(['t1', 't2', 't3']);
  notifier.receive([a]);
  notifier.receive([a, b]);
  assert.deepEqual(singles, []);
  tick();
  assert.deepEqual([singles, groups], [['t1', 't2'], []]);
  notifier.receive([a, b, c]);
  assert.deepEqual(singles, ['t1', 't2'], 'the third card waits for its own window');
  tick();
  assert.deepEqual([singles, groups, started], [['t1', 't2', 't3'], [], [1500, 1500]], 'a card after the window is not grouped with the earlier ones');
});

test('the window: a card that leaves inside it is never shown; an empty window ends with nothing', () => {
  const { notifier, singles, groups, timers, tick } = windowed();
  const [a, b, c] = cards(['t1', 't2', 't3']);
  notifier.receive([a, b, c]);
  notifier.receive([b, c]); // t1 answered at once
  tick();
  assert.deepEqual([singles, groups], [['t2', 't3'], []], 'two left: two singles, not a group');

  const again = windowed();
  again.notifier.receive(cards(['t4']));
  again.notifier.receive([]);
  assert.equal(again.timers.size, 0, 'nothing left to notify: the window is cancelled');
  again.tick();
  assert.deepEqual(again.singles, []);
  assert.equal(timers.size, 0);
});

/** The page's texts (English), by the card's kind. */
const words = (shownItem: any) => ({ reason: shownItem.kind === 'error' ? 'Stopped with an error' : 'Waiting for your answer', workspace: 'dev', lang: 'en', waiting: (count: number) => `${count} agents are waiting for you` });

/** A windowed notifier showing what the page shows: showNotification and showGroupNotification on the fake class. */
const realWindowed = () => windowed({
  show: (shownItem: any) => showNotification(FakeNotification, shownItem, words(shownItem), page()),
  showGroup: (list: any[]) => showGroupNotification(FakeNotification, list.map((shownItem) => ({ item: shownItem, workspace: 'dev' })), words(list[0]), { focus: () => {}, openInbox: () => {} }),
});

test('the window: a card shows as it is when the window ends, tagged by its start; the same snapshot does not queue it again', () => {
  const { notifier, tick } = realWindowed();
  notifier.receive([item('t1', 'error', T0, { label: 'Error', detail: 'Build failed' })]);
  notifier.receive([item('t1', 'blocked', T1, { detail: 'Deploy to production?' })]);
  notifier.receive([item('t1', 'blocked', T1, { detail: 'Deploy to production?' })]);
  tick();
  assert.deepEqual(FakeNotification.made.map((n) => [n.title, n.options.body, n.options.requireInteraction, n.options.tag]), [
    ['api · Waiting for your answer', 'Deploy to production?\ndev › api', true, `mirador-inbox:t1:${T0}`],
  ], 'one notification: blocked now, tagged by the card as it started');
});

test('the window: a dialog whose question changes inside it shows the new question', () => {
  const { notifier, tick } = realWindowed();
  notifier.receive([item('t1', 'prompt', T0, { detail: 'Pick a model' })]);
  notifier.receive([item('t1', 'prompt', T0, { detail: 'Pick a database' })]);
  tick();
  assert.deepEqual(FakeNotification.made.map((n) => n.options.body), ['Pick a database\ndev › api']);
});

test('a later burst keeps the earlier burst\'s waiting cards: it covers them, stays on screen for them, and closes with the last one', () => {
  const { notifier, groups, tick } = realWindowed();
  const [b1, b2, b3] = cards(['t1', 't2', 't3']);
  notifier.receive([b1, b2, b3]);
  tick();
  notifier.receive([b2, b3]); // t1 answered: it is not part of what comes next
  const [e4, e5, e6] = cards(['t4', 't5', 't6'], 'error', T1);
  notifier.receive([b2, b3, e4, e5, e6]);
  tick();
  const [first, second] = FakeNotification.made;
  assert.deepEqual(groups, [['t1', 't2', 't3'], ['t2', 't3', 't4', 't5', 't6']], 'the blocked cards still waiting, then the errors');
  assert.deepEqual([second.title, second.options.requireInteraction, second.options.tag], ['5 agents are waiting for you', true, 'mirador-inbox:group']);
  notifier.receive([b2, b3]);
  assert.deepEqual([first.closed, second.closed], [0, 0], 'the errors left; two blocked cards still wait');
  notifier.receive([b3]);
  assert.equal(second.closed, 0);
  notifier.receive([]);
  assert.deepEqual([first.closed, second.closed], [0, 1], 'closed once, with the last card; the replaced one is left alone');
});

test('the window: notifications turned off inside it show nothing, and what it held never notifies later', async () => {
  const { notifier, singles, groups, timers, tick } = windowed();
  notifier.receive(cards(['t1', 't2', 't3']));
  assert.equal(await notifier.toggle(), 'off');
  tick();
  assert.deepEqual([singles, groups, timers.size], [[], [], 0]);
  assert.equal(await notifier.toggle(), 'on');
  notifier.receive(cards(['t1', 't2', 't3']));
  tick();
  assert.deepEqual([singles, groups], [[], []], 'known before it was turned on again');
});

test('the window: notifications blocked in the browser before it ends show nothing; the window is dropped', () => {
  const { notifier, api, singles, groups, tick } = windowed();
  notifier.receive(cards(['t1', 't2']));
  api.permission = 'denied';
  tick();
  assert.equal(notifier.status(), 'denied');
  api.permission = 'granted';
  tick();
  notifier.receive(cards(['t1', 't2', 't3']));
  tick();
  assert.deepEqual([singles, groups], [['t3'], []], 'only the card that came after');
});

test('the window: a card the user opened before it ends is skipped; one in view when it arrived counts as handled', () => {
  const { notifier, singles, tick } = windowed();
  const [a, b, c] = cards(['t1', 't2', 't3']);
  notifier.receive([a, b]);
  notifier.receive([a, b], (i: any) => i.terminalId === 't1'); // he opened t1
  tick();
  assert.deepEqual(singles, ['t2']);
  notifier.receive([a, b, c], (i: any) => i.terminalId === 't3');
  notifier.receive([a, b, c]); // he switched away from t3 inside the window
  tick();
  assert.deepEqual(singles, ['t2'], 't3 was in view when it arrived');
});

test('the window: a browser that refuses the notification at the end counts as unsupported, and says so', () => {
  const { notifier, counts, tick } = windowed({ show: () => null });
  notifier.receive(cards(['t1']));
  assert.equal(notifier.status(), 'on');
  tick();
  assert.deepEqual([notifier.status(), counts.refused], ['unsupported', 1]);
  notifier.receive(cards(['t1', 't2']));
  tick();
  assert.equal(counts.refused, 1, 'nothing is shown, so nothing is refused again');
});

test('a burst arriving while singles are open leaves them; each closes with its own cards', () => {
  const { notifier, tick } = windowed();
  const [t1, t2, t3, t4, t5] = cards(['t1', 't2', 't3', 't4', 't5']);
  notifier.receive([t1, t2]);
  tick();
  notifier.receive([t1, t2, t3, t4, t5]);
  tick();
  const [s1, s2, group] = FakeNotification.made;
  assert.deepEqual([s1.title, s2.title, group.title], ['t1', 't2', '3']);
  notifier.receive([t2, t3, t4, t5]);
  assert.deepEqual([s1.closed, s2.closed, group.closed], [1, 0, 0], 't1 left: only its single closes');
  notifier.receive([t2, t5]);
  assert.deepEqual([s2.closed, group.closed], [0, 0], 'one of its cards still waits');
  notifier.receive([t2]);
  assert.deepEqual([s2.closed, group.closed], [0, 1], 'the last of its cards left');
  notifier.receive([]);
  assert.deepEqual([s1.closed, s2.closed, group.closed], [1, 1, 1]);
});

test('a burst never asks for permission and shows nothing while off', async () => {
  const { notifier, api, singles, groups, started, tick } = windowed({ api: fakeApi('default', 'granted'), stored: false });
  notifier.receive(cards(['t1', 't2', 't3']));
  tick();
  assert.deepEqual([singles, groups, started, api.asked], [[], [], [], 0], 'off: no window, nothing shown, nothing asked');
  assert.equal(await notifier.toggle(), 'on');
  assert.equal(api.asked, 1, 'the click asks, once');
  notifier.receive(cards(['t1', 't2', 't3']));
  tick();
  assert.deepEqual([singles, groups, api.asked], [[], [], 1], 'what arrived while off is known');
});
