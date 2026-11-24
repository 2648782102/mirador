// The inbox view's notification control and its notifications (public/features/inbox.js).
// The real inbox.js, inbox-notify.js and
// inbox-model.js run in Node on a small DOM stand-in, a fake Notification class and a fake inbox
// stream; '/core.js', '/terminals.js' and '/icons.js' are stand-ins (data: modules).
// The notifications wait for the page's 1.5 s window (inbox-notify.js NOTIFY_WINDOW_MS): the test
// holds those timers and ends the window itself (endWindow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { NOTIFY_WINDOW_MS } from '../public/features/inbox-notify.js';

const publicDir = new URL('../public/', import.meta.url);
const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS: Record<string, string> = {
  '/core.js': stub(`
    const C = globalThis.__inboxCore;
    export const api = (...a) => C.api(...a);
    export const el = (...a) => C.el(...a);
    export const emit = () => {};
    export const getLanguage = () => C.lang;
    export const on = (name, fn) => C.on(name, fn);
    export const prefs = C.prefs;
    export const session = C.session;
    export const slot = () => C.slot();
    export const t = (key) => key;
    export const workspaceById = (id) => ({ id, name: id === 'dev' ? 'Dev' : id });
  `),
  '/terminals.js': stub(`
    const C = globalThis.__inboxCore;
    export const activateTerminal = (id) => C.activated.push(id);
    export const activeTerminalId = () => C.active;
    export const markWaiting = () => {};
    export const terminalList = () => C.terminals;
    export const adoptTerminals = () => C.adopt();
  `),
  '/icons.js': stub('export const icon = () => null;'),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/* ---------- A DOM stand-in: what inbox.js touches ---------- */

class FakeElement {
  tagName: string;
  children: Array<FakeElement | string> = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  className = '';
  hidden = false;
  dataset: Record<string, string> = {};
  #disabled = false;
  constructor(tagName: string) { this.tagName = tagName; }
  get disabled() { return this.#disabled; }
  /** As Chromium does: disabling the focused control drops the keyboard focus to <body>. */
  set disabled(value: boolean) {
    this.#disabled = value;
    if (value && doc.activeElement === this) doc.activeElement = doc.body;
  }
  get textContent(): string { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(text: string) { this.children = [text]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  toggleAttribute(name: string, on: boolean) { if (on) this.attributes.set(name, ''); else this.attributes.delete(name); }
  addEventListener(type: string, fn: () => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click() { if (!this.#disabled) for (const fn of this.listeners.get('click') ?? []) fn(); }
  append(...nodes: Array<FakeElement | string>) { for (const node of nodes) { if (typeof node !== 'string') node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Array<FakeElement | string>) { this.children = []; this.append(...nodes); }
  after(node: FakeElement) { node.parent = this.parent; }
  contains(node: unknown): boolean { return node === this || this.children.some((c) => typeof c !== 'string' && c.contains(node)); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** Set for an element on screen (inbox.js shows the panel only when its "show" button is visible). */
  offsetParent: FakeElement | null = null;
  /** Hidden or disabled controls do not take the focus, as in a browser. */
  focus() {
    for (let node: FakeElement | null = this; node; node = node.parent) if (node.hidden) return;
    if (!this.#disabled) doc.activeElement = this;
  }
}

class FakeDocument {
  title = 'Mirador';
  visibilityState = 'visible';
  body = new FakeElement('body');
  activeElement: FakeElement = this.body;
  /** Elements the test puts on the page, by the selector or id inbox.js looks them up with. */
  found = new Map<string, FakeElement>();
  createElement(tag: string) { return new FakeElement(tag); }
  addEventListener() {}
  querySelector(selector: string) { return this.found.get(selector) ?? null; }
  getElementById(id: string) { return this.found.get(`#${id}`) ?? null; }
}

/** What inbox.js passes to new Notification (inbox-notify-model.js). */
type Options = { tag: string; body: string; requireInteraction: boolean; lang?: string; timestamp?: number; icon: string; badge: string };

/** The browser's Notification class: permission, a permission prompt answered by the test, and every notification made. */
class FakeNotification {
  static permission = 'default';
  static made: FakeNotification[] = [];
  static answer: (value: string) => void = () => {};
  static requestPermission() {
    return new Promise<string>((resolve) => {
      FakeNotification.answer = (value) => { FakeNotification.permission = value; resolve(value); };
    });
  }
  title: string;
  options: Options;
  closed = 0;
  onclick: null | (() => void) = null;
  constructor(title: string, options: Options) {
    this.title = title;
    this.options = options;
    FakeNotification.made.push(this);
  }
  close() { this.closed++; }
}

let doc = new FakeDocument();
const stored = new Map<string, unknown>();
const core = {
  el(tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value as () => unknown);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child as FakeElement | string);
    return node;
  },
  /** terminals.js adoptTerminals: reads the server's list; a test sets what it brings. */
  adopt: async () => {},
  api: async (_method: string, path: string) => (path === '/api/agents' ? { agents: [{ id: 'claude', label: 'Claude Code' }] } : {}),
  lang: 'en',
  /** The active terminal (terminals.js activeTerminalId). */
  active: null as string | null,
  /** core.js on(): the handlers inbox.js registers, by event. */
  handlers: new Map<string, (value: unknown) => unknown>(),
  on: (name: string, fn: (value: unknown) => unknown) => { core.handlers.set(name, fn); },
  prefs: { read: (key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback), write: (key: string, value: unknown) => stored.set(key, value) },
  session: { token: null as string | null, expire() {} },
  /** The inbox slot of the current page. */
  host: null as FakeElement | null,
  slot: () => { core.host = doc.createElement('section'); core.host.parent = doc.body; return core.host; },
  terminals: [] as Array<{ id: string; kind?: string; agent?: string }>,
  activated: [] as string[],
};
const focused: string[] = [];

/** The notification window's timers (setTimeout with NOTIFY_WINDOW_MS), held for the test; any other timer runs. */
const windows = new Map<object, () => void>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
(globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms !== NOTIFY_WINDOW_MS) return realSetTimeout(fn, ms, ...rest);
  const id = { unref() { return id; } };
  windows.set(id, fn);
  return id;
};
(globalThis as any).clearTimeout = (id: any) => (windows.delete(id) ? undefined : realClearTimeout(id));
/** Ends the open notification window: what it collected notifies now. */
function endWindow() {
  const due = [...windows.values()];
  windows.clear();
  for (const fn of due) fn();
}

Object.assign(globalThis, { __inboxCore: core, CSS: { escape: (s: string) => s }, window: { focus: () => focused.push('window') } });

/** The inbox stream inbox.js reads (GET /api/inbox/stream): `send(items)` writes one NDJSON message. */
function fakeStream() {
  let push!: (line: string) => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(line)); } });
  (globalThis as any).fetch = async () => new Response(body, { status: 200 });
  return { send: (items: unknown[]) => push(`${JSON.stringify({ items, nightNotes: [] })}\n`) };
}

let boots = 0;
/**
 * A fresh page with a fresh inbox.js: the browser's permission, the stored choice (prefs) and, with
 * `stream`, a session whose inbox stream the test writes. Returns the control and the stream.
 */
async function boot({ permission = 'default', on = false, stream = false } = {}) {
  doc = new FakeDocument();
  (globalThis as any).document = doc;
  FakeNotification.permission = permission;
  FakeNotification.made = [];
  (globalThis as any).Notification = FakeNotification;
  stored.clear();
  if (on) stored.set('inboxNotify', true);
  core.session.token = stream ? 'token' : null;
  core.terminals = [];
  core.activated = [];
  core.lang = 'en';
  core.active = null;
  core.handlers.clear();
  windows.clear();
  focused.length = 0;
  const feed = stream ? fakeStream() : null;
  const inbox = await import(`${new URL('features/inbox.js', publicDir).href}?boot=${++boots}`);
  // inbox.js keeps its "how long" texts current every 30 s; the test does not need that timer.
  const { setInterval: realInterval } = globalThis;
  (globalThis as any).setInterval = () => 0;
  try {
    await inbox.init();
  } finally {
    (globalThis as any).setInterval = realInterval;
  }
  return { feed };
}

/** The notification control: inbox.js puts it first in its slot (button, then status text). */
function control() {
  const bar = core.host!.children[0] as FakeElement;
  return { button: bar.children[0] as FakeElement, status: bar.children[1] as FakeElement };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const card = (terminalId: string, kind: string, since: string) => ({ terminalId, workspaceId: 'dev', rel: 'api', title: 'api', kind, label: kind === 'error' ? 'Error' : 'Awaiting input', detail: null, since, activity: null });
const T0 = '2026-11-12T10:00:00.000Z';
const T1 = '2026-11-12T10:03:00.000Z';
const T2 = '2026-11-12T10:04:00.000Z';

for (const [answer, ends, statusKey] of [
  ['granted', 'button', 'inbox.notify.status.on'],
  ['denied', 'status', 'inbox.notify.status.denied'],
  ['default', 'button', 'inbox.notify.status.off'],
] as const) {
  test(`keyboard: after the browser's answer (${answer}) the focus is on the ${ends === 'button' ? 'button' : 'status text'}, not lost to <body>`, async () => {
    await boot();
    const { button, status } = control();
    button.focus();
    button.click();
    assert.equal(button.disabled, true, 'the button waits for the answer');
    FakeNotification.answer(answer);
    await settle();
    assert.equal(status.textContent, statusKey);
    assert.equal(button.hidden, answer === 'denied', 'a refusal hides the button');
    assert.equal(doc.activeElement, ends === 'button' ? button : status);
  });
}

test('keyboard: turning notifications off keeps the focus on the button (it is disabled for a moment too)', async () => {
  await boot({ permission: 'granted', on: true });
  const { button, status } = control();
  assert.equal(status.textContent, 'inbox.notify.status.on');
  button.focus();
  button.click();
  await settle();
  assert.deepEqual([status.textContent, button.textContent, doc.activeElement === button], ['inbox.notify.status.off', 'inbox.notify.turnOn', true]);
});

test('keyboard: the browser has no Notification API: the control says so, the button is hidden, and nothing takes the focus', async () => {
  (globalThis as any).Notification = undefined;
  const page = new FakeDocument();
  (globalThis as any).document = page;
  doc = page;
  core.session.token = null;
  const inbox = await import(`${new URL('features/inbox.js', publicDir).href}?boot=${++boots}`);
  const { setInterval: realInterval } = globalThis;
  (globalThis as any).setInterval = () => 0;
  try { await inbox.init(); } finally { (globalThis as any).setInterval = realInterval; }
  const { button, status } = control();
  assert.deepEqual([button.hidden, status.textContent, doc.activeElement === doc.body], [true, 'inbox.notify.status.unsupported', true]);
});

test('keyboard: a click without the focus on the button (a mouse in Safari), or focus moved during the prompt, is left where it is', async () => {
  await boot();
  const { button } = control();
  button.click();
  FakeNotification.answer('denied');
  await settle();
  assert.equal(doc.activeElement, doc.body, 'the focus was never on the button: it is not moved');

  await boot();
  const again = control();
  const elsewhere = doc.createElement('button');
  elsewhere.parent = doc.body;
  again.button.focus();
  again.button.click();
  elsewhere.focus();
  FakeNotification.answer('granted');
  await settle();
  assert.equal(doc.activeElement, elsewhere, 'he moved on while the browser asked: the focus stays with him');
});

test('the view: one card, one notification, closed when the card leaves; a stale click focuses Mirador without error', async () => {
  const { feed } = await boot({ permission: 'granted', on: true, stream: true });
  core.terminals = [{ id: 't1' }];
  feed!.send([]);
  feed!.send([card('t1', 'blocked', T0)]);
  feed!.send([card('t1', 'error', T1)]);
  feed!.send([card('t1', 'blocked', T2)]);
  await settle();
  assert.equal(FakeNotification.made.length, 0, 'nothing before the window ends');
  endWindow();
  assert.deepEqual(FakeNotification.made.map((n) => [n.options.tag, n.closed]), [[`mirador-inbox:t1:${T0}`, 0]], 'blocked → error → blocked: one notification, still open');

  const [notice] = FakeNotification.made;
  notice.onclick!();
  assert.deepEqual([focused, core.activated, notice.closed], [['window'], ['t1'], 1], 'the card is there: the click keeps its behaviour');

  feed!.send([card('t2', 'blocked', T2)]);
  await settle();
  endWindow();
  const [, second] = FakeNotification.made;
  core.terminals = [];
  feed!.send([]); // answered and its terminal closed
  await settle();
  assert.equal(second.closed, 1, 'its card left: the notification is closed');
  second.close = () => { throw new Error('already closed'); };
  assert.doesNotThrow(() => second.onclick!());
  assert.deepEqual([focused, core.activated], [['window', 'window'], ['t1']], 'the stale click focuses Mirador and opens nothing');
});

// The wiring: what inbox.js passes to the notifications (inbox-notify-model.js words them).

const question = (terminalId: string, rel = 'web/mi-proyecto', since = T0) => ({ ...card(terminalId, 'blocked', since), rel, label: 'Choice awaiting input', detail: 'Which database should I use?' });

/** The two switches beside the button: notices that ask stay, and discreet mode (checkbox and text). */
function switches() {
  const options = (core.host!.children[0] as FakeElement).children[2] as FakeElement;
  const [stay, discreet] = options.children.map((label) => (label as FakeElement).children[0] as FakeElement & { checked?: boolean });
  /** The user ticks or clears a switch: the checkbox changes, then its change event. */
  const set = (box: FakeElement & { checked?: boolean }, value: boolean) => {
    box.checked = value;
    for (const fn of box.listeners.get('change') ?? []) fn();
  };
  return { stay, discreet, set };
}

/** A page with notifications on, the stream's baseline sent and terminal t1 an agent (Claude Code). */
async function live() {
  const { feed } = await boot({ permission: 'granted', on: true, stream: true });
  core.terminals = [{ id: 't1', kind: 'agent', agent: 'claude' }];
  feed!.send([]);
  await settle();
  return feed!;
}

test('the view: a card notification says who waits; it stays on screen, is not discreet and reads in the interface language by default', async () => {
  const feed = await live();
  const { stay, discreet } = switches();
  assert.deepEqual([stay.checked, discreet.checked], [true, false], 'the switches: stay on, discreet off');
  feed.send([question('t1')]);
  await settle();
  endWindow();
  const [notice] = FakeNotification.made;
  assert.deepEqual([notice.title, notice.options.body], ['mi-proyecto · inbox.reason.choice', 'Which database should I use?\nClaude Code · Dev › web › mi-proyecto']);
  assert.deepEqual(
    [notice.options.tag, notice.options.requireInteraction, notice.options.lang, notice.options.timestamp, notice.options.icon],
    [`mirador-inbox:t1:${T0}`, true, 'en', Date.parse(T0), '/notify-icon.png'],
  );

  feed.send([question('t1'), card('t2', 'error', T1)]);
  await settle();
  core.lang = 'es';
  endWindow();
  const [, error] = FakeNotification.made;
  assert.deepEqual([error.title, error.options.body, error.options.requireInteraction, error.options.lang], ['api · inbox.reason.error', 'Dev › api', false, 'es'], 'no terminal here: only the path; an error does not stay; the language at the end of the window');
});

test('the view: a guarded command notifies only its project and reason, never the command', async () => {
  const feed = await live();
  feed.send([{ ...question('t1'), label: 'Guarded command confirmation', detail: 'TOKEN=abc123 deploy' }]);
  await settle();
  endWindow();
  const [notice] = FakeNotification.made;
  assert.deepEqual([notice.title, notice.options.body, notice.options.requireInteraction], ['mi-proyecto · inbox.reason.guarded', '', true]);
  assert.doesNotMatch(JSON.stringify([notice.title, notice.options]), /abc123|deploy|Claude/);
});

test('the view: discreet mode, ticked inside the window, hides the project, question, path and agent; the choice is kept', async () => {
  const feed = await live();
  feed.send([question('t1')]);
  await settle();
  const { discreet } = switches();
  switches().set(discreet, true);
  assert.equal(stored.get('inboxNotifyDiscreet'), true);
  endWindow();
  const [notice] = FakeNotification.made;
  assert.deepEqual([notice.title, notice.options.body, notice.options.requireInteraction], ['An agent is waiting for you', '', true]);
  assert.doesNotMatch(JSON.stringify([notice.title, notice.options]), /mi-proyecto|database|Dev|web|Claude/);
  feed.send([question('t1')]); // a re-render reads the stored choice back
  await settle();
  assert.equal(switches().discreet.checked, true);
});

test('the view: the stay switch turned off makes a blocked card leave like any other; the choice is kept', async () => {
  const feed = await live();
  const { stay, set } = switches();
  set(stay, false);
  assert.equal(stored.get('inboxNotifyStay'), false);
  feed.send([question('t1')]);
  await settle();
  assert.equal(switches().stay.checked, false, 'the re-render reads it back');
  endWindow();
  assert.equal(FakeNotification.made[0].options.requireInteraction, false);
  set(stay, true);
  assert.equal(stored.get('inboxNotifyStay'), true);
});

test('the view: 3 cards in 3 stream messages within the window give one notification; its click opens the inbox (desktop)', async () => {
  const feed = await live();
  const showPanel = doc.createElement('button');
  showPanel.offsetParent = doc.body;
  const inboxView = doc.createElement('button');
  const clicks: string[] = [];
  showPanel.addEventListener('click', () => clicks.push('panel'));
  inboxView.addEventListener('click', () => clicks.push('inbox'));
  doc.found.set('.side-show[data-side="panel"]', showPanel);
  doc.found.set('[data-slot="panel-views"] [data-view="inbox"]', inboxView);
  const burst = [question('t1'), question('t2', 'api'), question('t3', '')];
  feed.send(burst.slice(0, 1));
  feed.send(burst.slice(0, 2));
  feed.send(burst);
  await settle();
  assert.equal(FakeNotification.made.length, 0, 'nothing before the window ends');
  endWindow();
  assert.equal(FakeNotification.made.length, 1);
  const [group] = FakeNotification.made;
  assert.deepEqual([group.title, group.options.body, group.options.tag, group.options.requireInteraction, group.options.lang], ['3 agents are waiting for you', 'mi-proyecto, api, Dev', 'mirador-inbox:group', true, 'en']);
  group.onclick!();
  assert.deepEqual([focused, clicks, core.activated, group.closed], [['window'], ['panel', 'inbox'], [], 1]);
});

test('the view: on the phone a burst reads in Spanish and its click opens the full-screen inbox', async () => {
  const feed = await live();
  const toInbox = doc.createElement('button');
  const clicks: string[] = [];
  toInbox.addEventListener('click', () => clicks.push('phone-to-inbox'));
  doc.found.set('#phone-to-inbox', toInbox);
  const inboxView = doc.createElement('button');
  inboxView.addEventListener('click', () => clicks.push('panel inbox'));
  doc.found.set('[data-slot="panel-views"] [data-view="inbox"]', inboxView);
  core.handlers.get('phone')!('deck');
  core.lang = 'es';
  feed.send([question('t1'), question('t2', 'api'), question('t3', 'docs')]);
  await settle();
  endWindow();
  const [group] = FakeNotification.made;
  assert.deepEqual([group.title, group.options.lang], ['3 agentes te esperan', 'es']);
  group.onclick!();
  assert.deepEqual(clicks, ['phone-to-inbox']);
});

test('the view: a card the user opens before the window ends, or notifications turned off inside it, show nothing', async () => {
  const feed = await live();
  feed.send([question('t1')]);
  await settle();
  core.active = 't1';
  endWindow();
  assert.equal(FakeNotification.made.length, 0, 'he is looking at it');

  const again = await live();
  again.send([question('t1')]);
  await settle();
  control().button.click();
  await settle();
  assert.equal(control().status.textContent, 'inbox.notify.status.off');
  endWindow();
  assert.equal(FakeNotification.made.length, 0, 'turned off inside the window');
});

test('the view: a browser that refuses the notification when the window ends: the control says notifications are not available', async () => {
  const feed = await live();
  feed.send([question('t1')]);
  await settle();
  (globalThis as any).Notification = class { constructor() { throw new TypeError('Illegal constructor'); } };
  endWindow();
  const { button, status } = control();
  assert.deepEqual([status.textContent, button.hidden], ['inbox.notify.status.unsupported', true]);
});

/** Every element under `node` whose class list holds `name`. */
const withClass = (node: FakeElement, name: string): FakeElement[] =>
  node.children.flatMap((child) => (typeof child === 'string' ? [] : [...(child.className.split(' ').includes(name) ? [child] : []), ...withClass(child, name)]));

test('a card whose terminal this window lacks reads the terminal list and opens it once it came; still absent, nothing opens', async () => {
  const { feed } = await boot({ stream: true });
  feed!.send([card('t9', 'blocked', T0)]);
  await settle();
  const [elsewhere] = withClass(core.host!, 'elsewhere');
  assert.ok(elsewhere, 'the card says its terminal is elsewhere');
  core.adopt = async () => { core.terminals = [{ id: 't9' }]; };
  elsewhere.click();
  await settle();
  assert.deepEqual(core.activated, ['t9'], 'read, then opened');
  core.terminals = [];
  feed!.send([card('t8', 'blocked', T1)]);
  await settle();
  core.adopt = async () => {};
  withClass(core.host!, 'elsewhere')[0].click();
  await settle();
  assert.deepEqual(core.activated, ['t9'], 'the list did not bring it: nothing opens');
  core.adopt = async () => {};
});
