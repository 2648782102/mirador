// The inbox view's notification control and its notifications (public/features/inbox.js).
// The real inbox.js, inbox-notify.js and
// inbox-model.js run in Node on a small DOM stand-in, a fake Notification class and a fake inbox
// stream; '/core.js', '/terminals.js' and '/icons.js' are stand-ins (data: modules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS: Record<string, string> = {
  '/core.js': stub(`
    const C = globalThis.__inboxCore;
    export const api = (...a) => C.api(...a);
    export const el = (...a) => C.el(...a);
    export const emit = () => {};
    export const getLanguage = () => 'en';
    export const on = () => {};
    export const prefs = C.prefs;
    export const session = C.session;
    export const slot = () => C.slot();
    export const t = (key) => key;
    export const workspaceById = (id) => ({ id, name: id });
  `),
  '/terminals.js': stub(`
    const C = globalThis.__inboxCore;
    export const activateTerminal = (id) => C.activated.push(id);
    export const activeTerminalId = () => null;
    export const markWaiting = () => {};
    export const terminalList = () => C.terminals;
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
  createElement(tag: string) { return new FakeElement(tag); }
  addEventListener() {}
}

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
  options: { tag: string };
  closed = 0;
  onclick: null | (() => void) = null;
  constructor(title: string, options: { tag: string }) {
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
  api: async () => ({}),
  prefs: { read: (key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback), write: (key: string, value: unknown) => stored.set(key, value) },
  session: { token: null as string | null, expire() {} },
  /** The inbox slot of the current page. */
  host: null as FakeElement | null,
  slot: () => { core.host = doc.createElement('section'); core.host.parent = doc.body; return core.host; },
  terminals: [] as Array<{ id: string }>,
  activated: [] as string[],
};
const focused: string[] = [];
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
  assert.deepEqual(FakeNotification.made.map((n) => [n.options.tag, n.closed]), [[`mirador-inbox:t1:${T0}`, 0]], 'blocked → error → blocked: one notification, still open');

  const [notice] = FakeNotification.made;
  notice.onclick!();
  assert.deepEqual([focused, core.activated, notice.closed], [['window'], ['t1'], 1], 'the card is there: the click keeps its behaviour');

  feed!.send([card('t2', 'blocked', T2)]);
  await settle();
  const [, second] = FakeNotification.made;
  core.terminals = [];
  feed!.send([]); // answered and its terminal closed
  await settle();
  assert.equal(second.closed, 1, 'its card left: the notification is closed');
  second.close = () => { throw new Error('already closed'); };
  assert.doesNotThrow(() => second.onclick!());
  assert.deepEqual([focused, core.activated], [['window', 'window'], ['t1']], 'the stale click focuses Mirador and opens nothing');
});
