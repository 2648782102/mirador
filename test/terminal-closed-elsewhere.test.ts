// A terminal closed in another window leaves this one too: the server tells every socket attached
// to it ({t:'c'}, src/server.ts) and public/terminals.js drops it in the order its own × does,
// without asking the server to close it again. The real terminals.js runs in Node on a DOM
// stand-in, a fake xterm and a fake API, trimmed from test/tab-agent-icon.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
const XTERM = `data:text/javascript,${encodeURIComponent(`
export class Terminal {
  constructor() { this.cols = 80; this.rows = 24; this.options = {}; this.buffer = { active: { type: 'normal' } }; }
  loadAddon() {} open() {} onData() {} onResize() {} focus() {} reset() {} resize() {} dispose() {}
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
  offsetParent = null;
  localName: string;
  constructor(tag: string) { this.localName = tag.toLowerCase(); }
  get tagName() { return this.localName.toUpperCase(); }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
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
  addEventListener() {}
  removeEventListener() {}
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
    this.body.append(html('div', 'tabs'), panes, html('p', 'empty-hint'), html('div', 'filter-empty'), html('button', 'filter-empty-all'));
  }
  get children() { return [this.documentElement]; }
  get activeElement() { return this.body; }
  removeChild() {}
  createElement(tag: string) { return new FakeElement(tag); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag); }
  getElementById(id: string) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(selector: string) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  addEventListener() {}
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
  send() {}
  close() {}
  receive(message: unknown) { for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(message) }); }
}

Object.assign(globalThis, {
  window: { addEventListener() {} },
  location: { host: '127.0.0.1:4317', hash: '' },
  WebSocket: FakeSocket,
  ResizeObserver: class { observe() {} },
  requestAnimationFrame: () => 0,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
});
(globalThis as any).document = new FakeDocument();
const core = await import(new URL('core.js', publicDir).href);

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
  (globalThis as any).fetch = async (path: string, { method }: { method: string }) => {
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
  await terminals.initTerminals();
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
    nodes: (id: string) => doc.querySelectorAll(`[data-terminal-id="${id}"]`).length,
    active: () => doc.querySelectorAll('#panes .active').map((pane) => pane.getAttribute('data-terminal-id')),
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
  // One not on screen: it goes, the active one stays.
  page.socket('t-b').receive({ t: 'c' });
  assert.equal(page.nodes('t-b'), 0);
  assert.deepEqual(page.active(), ['t-c']);
  assert.deepEqual(page.lists.at(-1), ['t-c']);
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
