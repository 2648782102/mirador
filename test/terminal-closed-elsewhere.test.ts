// A terminal closed in another window leaves this one too: the server tells every socket attached
// to it ({t:'c'}, src/server.ts) and public/terminals.js drops it in the order its own × does,
// without asking the server to close it again. The real terminals.js runs in Node on a DOM
// stand-in, a fake xterm and a fake API, trimmed from test/tab-agent-icon.test.ts. An agent put to
// sleep ({t:'c', reason:'sleep'}) leaves the same way, and features/sleeping.js says so for about 8 s.
// The same page also checks that typing or clicking in a terminal takes its size back from another
// window (a phone) that took it while this one kept the focus, and that a terminal opened in another
// window after this page loaded joins it as a tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
const XTERM = `data:text/javascript,${encodeURIComponent(`
export class Terminal {
  constructor() { this.cols = 80; this.rows = 24; this.options = {}; this.buffer = { active: { type: 'normal' } }; }
  loadAddon() {} open() {} onData() {} onResize() {} reset() {} resize() {} dispose() {}
  focus() { globalThis.xtermFocus = (globalThis.xtermFocus ?? 0) + 1; }
  write(data, done) { done?.(); }
}
export class FitAddon { fit() {} }
export class WebLinksAddon {}
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/vendor/')) return { url: XTERM, shortCircuit: true };
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/* ---------- A DOM stand-in: what terminals.js and the icons touch ---------- */

class FakeText {
  parentNode: FakeElement | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
  remove() { this.parentNode?.removeChild(this); }
}
type Child = FakeElement | FakeText;

/** One compound selector (tag, #id, .class, [attr], [attr="value"]); compounds join by ' ' or ' > '. */
function matchesCompound(node: FakeElement, compound: string): boolean {
  const parts = compound.match(/^[a-z]+|#[\w-]+|\.[\w-]+|\[[^\]]+\]/gi) ?? [];
  assert.equal(parts.join(''), compound, `unsupported selector part in "${compound}"`);
  return parts.every((part) => {
    if (part.startsWith('#')) return node.getAttribute('id') === part.slice(1);
    if (part.startsWith('.')) return node.classList.contains(part.slice(1));
    if (part.startsWith('[')) {
      const [, name, value] = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)!;
      return value === undefined ? node.hasAttribute(name) : node.getAttribute(name) === value;
    }
    return node.localName === part.toLowerCase();
  });
}
function matchesSelector(node: FakeElement, selector: string): boolean {
  const tokens = selector.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const test = (el: FakeElement | null, index: number): boolean => {
    if (!el || !matchesCompound(el, tokens[index])) return false;
    if (index === 0) return true;
    if (tokens[index - 1] === '>') return test(el.parentElement, index - 2);
    for (let up = el.parentElement; up; up = up.parentElement) if (test(up, index - 1)) return true;
    return false;
  };
  return test(node, tokens.length - 1);
}

class FakeElement {
  childNodes: Child[] = [];
  parentNode: FakeElement | FakeDocument | null = null;
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  draggable = false;
  clientWidth = 0;
  offsetParent: object | null = null;
  localName: string;
  constructor(tag: string) { this.localName = tag.toLowerCase(); }
  get tagName() { return this.localName.toUpperCase(); }
  get parentElement(): FakeElement | null { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get children() { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean { return this.parentNode instanceof FakeDocument || Boolean(this.parentElement?.isConnected); }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  toggleAttribute(name: string, force?: boolean) {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value: string) { this.setAttribute('class', value); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(value: string) { this.setAttribute('title', value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value: boolean) { this.toggleAttribute('hidden', Boolean(value)); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  set tabIndex(value: number) { this.setAttribute('tabindex', value); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]) => this.setAttribute('class', list.join(' '));
    return {
      contains: (name: string) => names().includes(name),
      add: (...add: string[]) => write([...new Set([...names(), ...add])]),
      remove: (...drop: string[]) => write(names().filter((n) => !drop.includes(n))),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !names().includes(name);
        write(on ? [...new Set([...names(), name])] : names().filter((n) => n !== name));
        return on;
      },
    };
  }
  get dataset(): Record<string, string | undefined> {
    const attr = (key: string) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_, key: string) => this.getAttribute(attr(key)) ?? undefined,
      set: (_, key: string, value) => { this.setAttribute(attr(key), value); return true; },
      deleteProperty: (_, key: string) => { this.removeAttribute(attr(key)); return true; },
    });
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(...(value ? [value] : [])); }
  private adopt(node: Child | string): Child {
    const child = typeof node === 'string' ? new FakeText(node) : node;
    child.remove();
    child.parentNode = this;
    return child;
  }
  append(...nodes: Array<Child | string>) { for (const node of nodes) this.childNodes.push(this.adopt(node)); }
  prepend(...nodes: Array<Child | string>) { this.childNodes.unshift(...nodes.map((n) => this.adopt(n))); }
  replaceChildren(...nodes: Array<Child | string>) {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...nodes);
  }
  insertBefore(node: FakeElement, ref: FakeElement | null) {
    const child = this.adopt(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    return node;
  }
  removeChild(child: Child) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    child.parentNode = null;
  }
  remove() { this.parentNode?.removeChild(this); }
  listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener() {}
  click() { for (const listener of this.listeners.get('click') ?? []) listener(); }
  /** Runs the listeners for `type`, as a real event reaching this element would. */
  fire(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, width: 0 }; }
  matches(selector: string) { return matchesSelector(this, selector); }
  closest(selector: string) {
    for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => node.children.forEach((child) => { if (child.matches(selector)) found.push(child); walk(child); });
    walk(this);
    return found;
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeDocument {
  documentElement = new FakeElement('html');
  body = new FakeElement('body');
  visibilityState = 'visible';
  constructor() {
    this.documentElement.parentNode = this;
    this.documentElement.append(this.body);
    const html = (tag: string, id: string) => {
      const node = new FakeElement(tag);
      node.setAttribute('id', id);
      return node;
    };
    const panes = html('div', 'panes');
    panes.append(html('div', 'empty-state'));
    const alerts = new FakeElement('div');
    alerts.setAttribute('data-slot', 'alerts');
    this.body.append(alerts, html('div', 'tabs'), panes, html('p', 'empty-hint'), html('div', 'filter-empty'), html('button', 'filter-empty-all'));
  }
  get children() { return [this.documentElement]; }
  get activeElement() { return this.body; }
  removeChild() {}
  createElement(tag: string) { return new FakeElement(tag); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag); }
  getElementById(id: string) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(selector: string) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  /** Listeners on the document, last boot last: `visibilitychange` reads the terminal list again. */
  listeners: Array<[string, () => void]> = [];
  addEventListener(type: string, listener: () => void) { this.listeners.push([type, listener]); }
}

/** The sockets terminals.js opened, to play the server's messages. */
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  /** The messages terminals.js sent, parsed. */
  sent: unknown[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() {}
  receive(message: unknown) { for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(message) }); }
}

Object.assign(globalThis, {
  window: {
    /** Listeners on window, last boot last: `focus` retakes the sizes. */
    listeners: [] as Array<[string, () => void]>,
    addEventListener(type: string, listener: () => void) { this.listeners.push([type, listener]); },
  },
  location: { host: '127.0.0.1:4317', hash: '' },
  WebSocket: FakeSocket,
  ResizeObserver: class { observe() {} },
  requestAnimationFrame: () => 0,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
});
(globalThis as any).document = new FakeDocument();
const core = await import(new URL('core.js', publicDir).href);
const { translate } = await import(new URL('i18n.js', publicDir).href);
// The line an agent put to sleep leaves: wired by features/sleeping.js init() itself, which first
// reads GET /api/terminals/sleeping (nothing sleeps here).
core.session.token = 'test-token';
(globalThis as any).fetch = async () => ({ status: 200, ok: true, json: async () => ({ agents: [] }) });
const sleeping = await import(new URL('features/sleeping.js', publicDir).href);
await sleeping.init();

let boots = 0;
const info = (id: string, status = 'running') => ({ id, kind: 'shell', workspaceId: 'dev', rel: '', cwd: '/home/you/Dev', title: id, status, createdAt: '2026-11-24T12:00:00Z' });

/**
 * A fresh terminals.js on a fresh page whose reload restores `running`. Records every API call
 * after the boot, the `terminals` events and the `activate` ones; DELETE answers when `answer()` runs.
 */
async function boot(running: object[]) {
  const doc = new FakeDocument();
  (globalThis as any).document = doc;
  const calls: string[] = [];
  let answer = () => {};
  let reads = 0;
  (globalThis as any).fetch = async (path: string, { method }: { method: string }) => {
    if (method === 'GET' && path === '/api/terminals') reads++;
    if (method === 'POST') calls.push(`${method} ${path}`);
    if (method === 'DELETE') {
      calls.push(`${method} ${path}`);
      await new Promise<void>((resolve) => (answer = resolve));
      return { status: 204, ok: true };
    }
    return { status: 200, ok: true, json: async () => structuredClone(path === '/api/terminals' ? running : { agents: [] }) };
  };
  core.session.token = 'test-token';
  core.state.config = { mode: 'plain', agentCommand: 'bash' };
  core.state.workspaces = [{ id: 'dev', name: 'Dev', path: '/home/you/Dev' }];
  const terminals = await import(`${new URL('terminals.js', publicDir).href}?boot=${++boots}`);
  // The `inbox` handler of this boot alone: the modules of earlier boots still listen on the bus.
  const inboxHandlers: Array<(event: Event) => void> = [];
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
    if (type === 'inbox') inboxHandlers.push(listener);
    return add.call(this, type, listener, options);
  };
  try {
    await terminals.initTerminals();
  } finally {
    EventTarget.prototype.addEventListener = add;
  }
  const lists: string[][] = [];
  const activated: string[] = [];
  const stops = [core.on('terminals', (list: Array<{ id: string }>) => lists.push(list.map((t) => t.id))), core.on('activate', (id: string) => activated.push(id))];
  return {
    terminals,
    calls,
    lists,
    activated,
    answer: () => answer(),
    stop: () => stops.forEach((s) => s()),
    socket: (id: string) => sockets.findLast((s) => s.url.endsWith(`/${id}`))!,
    /** How many times an xterm took the focus since the last call. */
    focused: () => {
      const count = (globalThis as any).xtermFocus ?? 0;
      (globalThis as any).xtermFocus = 0;
      return count;
    },
    nodes: (id: string) => doc.querySelectorAll(`[data-terminal-id="${id}"]`).length,
    active: () => doc.querySelectorAll('#panes .active').map((pane) => pane.getAttribute('data-terminal-id')),
    lines: () => doc.querySelectorAll('[data-slot="alerts"] .slept-line'),
    pane: (id: string) => doc.querySelector(`#panes [data-terminal-id="${id}"]`)!,
    /** How many times GET /api/terminals was read, the boot's own read included. */
    reads: () => reads,
    /** The page shows again (visibilitychange to visible). */
    shown: () => doc.listeners.filter(([type]) => type === 'visibilitychange').forEach(([, listener]) => listener()),
    ids: () => terminals.terminalList().map((t: { id: string }) => t.id),
    /** An inbox snapshot, to this boot's terminals.js only. */
    inbox: (items: unknown[]) => inboxHandlers.forEach((handler) => handler(new CustomEvent('inbox', { detail: items }))),
  };
}

test('a terminal closed in another window drops its tab and pane here, activates the next one and asks the server nothing', async () => {
  const page = await boot([info('t-a'), info('t-b'), info('t-c')]);
  page.terminals.activateTerminal('t-c');
  page.terminals.activateTerminal('t-a');
  page.activated.length = 0;
  page.socket('t-a').receive({ t: 'c' });
  assert.equal(page.nodes('t-a'), 0, 'its tab and pane are gone');
  assert.deepEqual(page.terminals.terminalList().map((t: { id: string }) => t.id), ['t-b', 't-c']);
  assert.deepEqual(page.active(), ['t-c'], 'the most recent terminal left is active, as after its own ×');
  assert.deepEqual(page.activated, ['t-c']);
  assert.deepEqual(page.lists, [['t-b', 't-c']], '`terminals` once, after the activation, without it');
  assert.deepEqual(page.calls, [], 'no DELETE back to the server');
  assert.deepEqual(page.lines(), [], 'closed by hand elsewhere: no line');
  // One not on screen: it goes, the active one stays.
  page.socket('t-b').receive({ t: 'c' });
  assert.equal(page.nodes('t-b'), 0);
  assert.deepEqual(page.active(), ['t-c']);
  assert.deepEqual(page.lists.at(-1), ['t-c']);
  page.stop();
});

test('S2/S4: a non-active terminal closed elsewhere or put to sleep never moves the activation, in any workspace', async () => {
  const page = await boot([info('t-a'), { ...info('t-b'), workspaceId: 'other' }, { ...info('t-d'), workspaceId: 'other' }]);
  core.state.workspaces = [{ id: 'dev', name: 'Dev', path: '/home/you/Dev' }, { id: 'other', name: 'Other', path: '/home/you/Other' }];
  page.terminals.activateTerminal('t-d');
  page.terminals.activateTerminal('t-a');
  page.activated.length = 0;
  page.socket('t-b').receive({ t: 'c', reason: 'sleep' });
  assert.deepEqual(page.active(), ['t-a'], 'the active terminal stays');
  assert.deepEqual(page.activated, [], 'no activate for a terminal the user did not pick');
  assert.deepEqual(page.lists.at(-1), ['t-a', 't-d']);
  page.stop();
});

test('a non-active terminal of the same workspace closed elsewhere leaves the active one in place and its focus alone', async () => {
  const page = await boot([info('t-a'), info('t-b'), info('t-c')]);
  page.terminals.activateTerminal('t-b');
  page.terminals.activateTerminal('t-a');
  page.activated.length = 0;
  page.focused();
  page.socket('t-c').receive({ t: 'c' });
  assert.equal(page.nodes('t-c'), 0, 'its tab and pane are gone');
  assert.deepEqual(page.active(), ['t-a'], 'the active terminal stays');
  assert.deepEqual(page.activated, [], 'no activate');
  assert.equal(page.focused(), 0, 'the active xterm is not focused again');
  assert.deepEqual(page.lists, [['t-a', 't-b']], '`terminals` once, without it');
  page.stop();
});

test('closed with this window\'s own ×: the close message arriving before or after the answer changes nothing', async () => {
  const page = await boot([info('t-a', 'exited'), info('t-b', 'exited'), info('t-c')]);
  page.terminals.activateTerminal('t-a');
  page.activated.length = 0;
  // The server tells the socket before it answers the DELETE.
  const closing = page.terminals.closeTerminal('t-a');
  page.socket('t-a').receive({ t: 'c' });
  page.answer();
  await closing;
  assert.deepEqual(page.calls, ['DELETE /api/terminals/t-a']);
  assert.equal(page.nodes('t-a'), 0);
  assert.deepEqual(page.lists, [['t-b', 't-c']], 'dropped once');
  assert.equal(page.activated.length, 1, 'the next one activated once');
  // A late message, after its own × finished: nothing happens.
  const before = { lists: page.lists.length, activated: page.activated.length };
  const late = page.terminals.closeTerminal('t-b');
  page.answer();
  await late;
  page.socket('t-b').receive({ t: 'c' });
  assert.deepEqual(page.lists.at(-1), ['t-c']);
  assert.deepEqual([page.lists.length, page.activated.length], [before.lists + 1, before.activated + 1]);
  // Even a late sleep message for a tab its own × closed says nothing.
  page.socket('t-b').receive({ t: 'c', reason: 'sleep' });
  assert.deepEqual(page.lines(), [], 'no line for this window\'s own ×');
  page.stop();
});

test('kept: an exit still marks the terminal exited and keeps its tab', async () => {
  const page = await boot([info('t-a'), info('t-b')]);
  page.socket('t-a').receive({ t: 'x', code: 0, info: info('t-a', 'exited') });
  assert.equal(page.nodes('t-a'), 2, 'tab and pane stay');
  assert.deepEqual(page.terminals.terminalList().map((t: { id: string; status: string }) => [t.id, t.status]), [['t-a', 'exited'], ['t-b', 'running']]);
  assert.deepEqual(page.calls, []);
  page.stop();
});

test('put to sleep: the tab leaves as when closed elsewhere, and one role=status line names it with Despertar for about 8 s; a newer one replaces it', async (t) => {
  const page = await boot([{ ...info('t-a'), kind: 'agent', rel: 'mi-proyecto' }, { ...info('t-b'), kind: 'agent' }, info('t-c')]);
  page.terminals.activateTerminal('t-a');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  page.socket('t-a').receive({ t: 'c', reason: 'sleep' });
  assert.equal(page.nodes('t-a'), 0, 'its tab and pane are gone');
  assert.deepEqual(page.lists, [['t-b', 't-c']]);
  assert.deepEqual(page.calls, []);
  const [line, ...more] = page.lines();
  assert.equal(more.length, 0);
  assert.equal(line.getAttribute('role'), 'status');
  assert.equal(line.closest('dialog'), null, 'not modal');
  assert.equal(line.textContent, core.t('sleeping.slept', { name: 'mi-proyecto' }) + core.t('sleeping.wake'));
  assert.equal(translate('es', 'sleeping.slept', { name: 'mi-proyecto' }), '«mi-proyecto» se durmió · está en Dormidos');
  assert.equal(line.querySelector('button')!.textContent, core.t('sleeping.wake'));
  t.mock.timers.tick(5000);
  // Another one sleeps: its line replaces the first, named as the sleeping dialog names it (no folder: the workspace).
  page.socket('t-b').receive({ t: 'c', reason: 'sleep' });
  const [second, ...others] = page.lines();
  assert.equal(others.length, 0, 'one line at a time');
  assert.equal(second.textContent, core.t('sleeping.slept', { name: 'Dev' }) + core.t('sleeping.wake'));
  t.mock.timers.tick(5000);
  assert.equal(page.lines().length, 1, 'the newer line keeps its own 8 s');
  t.mock.timers.tick(3000);
  assert.deepEqual(page.lines(), [], 'gone after about 8 s');
  page.stop();
});

test('Despertar on that line wakes the sleeping agent by its terminal id and the line goes', async (t) => {
  const page = await boot([{ ...info('t-a'), kind: 'agent', rel: 'mi-proyecto' }, info('t-b')]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  page.socket('t-a').receive({ t: 'c', reason: 'sleep' });
  page.lines()[0].querySelector('button')!.click();
  assert.deepEqual(page.lines(), []);
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(page.calls, ['POST /api/terminals/sleeping/t-a/wake']);
  page.stop();
});

test('typing or clicking in a shown terminal resends its size once, even unchanged, then waits 1 s; a hidden one sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const page = await boot([info('t-a'), info('t-b')]);
  const socket = page.socket('t-a');
  socket.readyState = FakeSocket.OPEN;
  page.socket('t-b').readyState = FakeSocket.OPEN;
  const pane = page.pane('t-a');
  pane.offsetParent = page.pane('t-a').parentElement;
  socket.sent.length = 0;
  pane.fire('keydown');
  assert.deepEqual(socket.sent, [{ t: 'r', c: 80, r: 24 }], 'the first key takes the size back');
  pane.fire('keydown');
  pane.fire('pointerdown');
  t.mock.timers.tick(999);
  pane.fire('keydown');
  assert.equal(socket.sent.length, 1, 'more input inside 1 s sends nothing more');
  t.mock.timers.tick(1);
  pane.fire('pointerdown');
  assert.deepEqual(socket.sent, [{ t: 'r', c: 80, r: 24 }, { t: 'r', c: 80, r: 24 }], 'a click after 1 s takes it again');
  // A pane not on screen has no size of its own: input reaching it sends nothing.
  const hidden = page.socket('t-b');
  hidden.sent.length = 0;
  page.pane('t-b').offsetParent = null;
  page.pane('t-b').fire('keydown');
  page.pane('t-b').fire('pointerdown');
  assert.deepEqual(hidden.sent, []);
  page.stop();
});

test('kept: the window taking the focus back resends the size of every shown terminal, even unchanged, and not of a hidden one', async () => {
  const page = await boot([info('t-a'), info('t-b')]);
  const [shown, hidden] = [page.socket('t-a'), page.socket('t-b')];
  shown.readyState = hidden.readyState = FakeSocket.OPEN;
  page.pane('t-a').offsetParent = page.pane('t-a').parentElement;
  page.pane('t-b').offsetParent = null;
  shown.sent.length = hidden.sent.length = 0;
  const focus = (globalThis as any).window.listeners.findLast(([type]: [string]) => type === 'focus')[1];
  focus();
  assert.deepEqual(shown.sent, [{ t: 'r', c: 80, r: 24 }]);
  assert.deepEqual(hidden.sent, []);
  page.stop();
});

const settled = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a terminal opened in another window after this page loaded joins as a tab when the inbox names it, with one read and no activation', async () => {
  const running = [info('t-a')];
  const page = await boot(running);
  page.terminals.activateTerminal('t-a');
  page.lists.length = page.activated.length = 0;
  const before = page.reads();
  running.push(info('t-new'), { ...info('t-git'), kind: 'git' });
  const items = [{ terminalId: 't-new' }, { terminalId: 't-git' }];
  page.inbox(items);
  page.inbox(items); // a second snapshot while the read is on its way
  await settled();
  assert.deepEqual(page.ids(), ['t-a', 't-new'], 'the new terminal is a tab; the git one is not');
  assert.equal(page.nodes('t-git'), 0);
  assert.deepEqual(page.active(), ['t-a'], 'the terminal on screen stays');
  assert.deepEqual(page.activated, []);
  assert.deepEqual(page.lists, [['t-a', 't-new']], '`terminals` once, with the new one');
  assert.equal(page.reads() - before, 1, 'one read for both snapshots');
  page.inbox(items);
  await settled();
  assert.equal(page.reads() - before, 1, 'later snapshots naming the git terminal read nothing more');
  page.stop();
});

test('the page shown again reads the list: a terminal with no card yet joins; one closed while the read was on its way does not come back', async () => {
  const running = [info('t-a'), info('t-b')];
  const page = await boot(running);
  page.terminals.activateTerminal('t-a');
  running.push(info('t-c'));
  page.shown();
  page.socket('t-b').receive({ t: 'c' }); // closed elsewhere; the answer on its way still lists it
  await settled();
  assert.deepEqual(page.ids(), ['t-a', 't-c']);
  assert.deepEqual(page.active(), ['t-a']);
  running.splice(1, 1); // the server forgot it too
  // Nothing new: the list is read and nothing changes.
  page.lists.length = 0;
  page.shown();
  await settled();
  assert.deepEqual(page.ids(), ['t-a', 't-c']);
  assert.deepEqual(page.lists, [], 'no `terminals` when nothing joined');
  page.stop();
});
