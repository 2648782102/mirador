// Browser notifications for the attention inbox (public/features/inbox-notify.js), DOM-free: a
// fake Notification API stands in for the browser's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboxNotifier, episodeKey, NOTIFY_PREF, notificationFor, showNotification } from '../public/features/inbox-notify.js';

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

test('the notification says what the inbox card says, tagged by its episode', () => {
  const shown = notificationFor(item('t1', 'error', T0, { detail: 'Build failed' }), { reason: 'Stopped with an error', where: 'dev › api' });
  assert.deepEqual(shown, { title: 'Stopped with an error', options: { body: 'dev › api\nBuild failed', tag: `mirador-inbox:t1:${T0}`, requireInteraction: false } });
  assert.equal(notificationFor(item('t2', 'blocked', T1), { reason: 'Waiting for your answer', where: 'dev › api' }).options.body, 'dev › api');
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
  options: { tag: string; body: string };
  closed = 0;
  onclick: null | (() => void) = null;
  constructor(title: string, options: { tag: string; body: string }) {
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
      const { title, options } = notificationFor(shownItem, { reason: shownItem.kind, where: 'dev › api' });
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
  const notice = showNotification(FakeNotification, card, { reason: 'Waiting for your answer', where: 'dev › api' }, { focus, open });
  assert.equal(notice, FakeNotification.made[0]);
  const expected = notificationFor(card, { reason: 'Waiting for your answer', where: 'dev › api' });
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
    const notice = showNotification(FakeNotification, item('gone', 'error', T0), { reason: 'Stopped with an error', where: 'dev › api' }, { focus, open });
    notice.close = () => { throw new Error('already closed'); };
    assert.doesNotThrow(() => notice.onclick!(), JSON.stringify(options));
    assert.deepEqual(calls, ['focus', 'open gone'], JSON.stringify(options));
  }
});

test('showNotification lets a throwing constructor through, so the notifier counts the browser as unsupported', () => {
  class Throws { constructor() { throw new TypeError('Illegal constructor'); } }
  assert.throws(() => showNotification(Throws, item('t1', 'blocked', T0), { reason: 'r', where: 'w' }, page()), TypeError);
});
