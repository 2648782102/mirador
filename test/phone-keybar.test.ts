// The phone key bar types into the terminal on screen, never another one (#65). The real public/features/phone.js runs in Node on a small DOM stand-in,
// with the real core.js (event bus, el, t) and phone-model.js. terminals.js, the drawers and the
// inbox are stand-ins: the terminals one keeps what the real one does that the phone reads, one
// active terminal whose pane alone has `.pane.active` (activateTerminal, which emits `activate`
// only for a terminal that exists), typeKey, which sends a key's bytes to a live terminal only, and
// closeTerminal's order: drop the terminal, activate the next one, then emit `terminals` (L3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
type PhoneModel = { KEY_BAR: Array<{ key: string }>; keyBytes: (key: string, mode?: { applicationCursor: boolean }) => string | null };
const { KEY_BAR, keyBytes }: PhoneModel = await import(new URL('features/phone-model.js', publicDir).href);

/** Each boot loads its own core.js and phone.js (a fresh event bus and module state). */
let boots = 0;
const STUBS: Record<string, string> = {
  '/terminals.js': `const fake = () => globalThis.__phoneKeybar;
export const terminalList = () => fake().list();
export const activeTerminalId = () => fake().activeId();
export const activateTerminal = (id) => fake().activate(id);
export const typeKey = (id, key) => fake().typeKey(id, key);
export const refitAll = () => {};`,
  '/features/drawers.js': 'export const closeDrawer = () => {};',
  '/features/inbox.js': `export const inboxStream = () => 'live';`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('/') || !context.parentURL?.startsWith(publicDir.href)) return next(specifier, context);
    if (Object.hasOwn(STUBS, specifier)) return { url: `data:text/javascript,${encodeURIComponent(`${STUBS[specifier]}\n// boot ${boots}`)}`, shortCircuit: true };
    return { url: `${new URL(specifier.slice(1), publicDir).href}?boot=${boots}`, shortCircuit: true };
  },
});

/* ---------- A DOM stand-in: what phone.js, core.js el() and icons.js touch ---------- */

class FakeText {
  parentNode: FakeElement | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
  remove() { this.parentNode?.removeChild(this); }
}
type Child = FakeElement | FakeText;

class FakeElement {
  childNodes: Child[] = [];
  parentNode: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: unknown) => void>>();
  localName: string;
  constructor(localName: string) { this.localName = localName; }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value: string) { this.setAttribute('class', value); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => names().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !names().includes(name);
        this.className = (on ? [...new Set([...names(), name])] : names().filter((n) => n !== name)).join(' ');
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
  get children() { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); }
  get lastChild(): Child | null { return this.childNodes.at(-1) ?? null; }
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
  removeChild(child: Child) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    child.parentNode = null;
  }
  remove() { this.parentNode?.removeChild(this); }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener({ type, preventDefault() {} }); }
  focus() {}
  /** Every element under this one, depth first. */
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
}

class FakeDocument {
  documentElement = new FakeElement('html');
  body = new FakeElement('body');
  constructor() {
    this.documentElement.append(this.body);
    for (const id of ['phone-inbox-head', 'phone-inbox-foot', 'phone-to-inbox', 'phone-term-head', 'phone-keys', 'panes']) {
      const node = new FakeElement(id === 'phone-to-inbox' ? 'button' : 'div');
      node.setAttribute('id', id);
      this.body.append(node);
    }
  }
  createElement(tag: string) { return new FakeElement(tag); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag); }
  getElementById(id: string) { return this.documentElement.descendants().find((node) => node.getAttribute('id') === id) ?? null; }
  querySelector(selector: string) {
    assert.match(selector, /^#[\w-]+$/, `unsupported selector "${selector}"`);
    return this.getElementById(selector.slice(1));
  }
}

/* ---------- The page: phone.js on a narrow screen, with terminals ---------- */

type Info = { id: string; title: string; workspaceId: string; rel: string };
const ALPHA: Info = { id: 't-alpha', title: 'alpha', workspaceId: 'dev', rel: 'api/v2' };
const BETA: Info = { id: 't-beta', title: 'beta', workspaceId: 'dev', rel: '' };

/** Loads a fresh phone.js on a fresh narrow page with the terminals `infos`, each with its pane. */
async function boot(infos: Info[]) {
  boots += 1;
  const doc = new FakeDocument();
  Object.assign(globalThis, {
    document: doc,
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }) },
  });
  const core = await import(`${new URL('core.js', publicDir).href}?boot=${boots}`);
  core.state.workspaces = [{ id: 'dev', name: 'Dev', path: '/home/you/Dev' }];
  const live = new Map(infos.map((info) => [info.id, info]));
  const panes = doc.getElementById('panes')!;
  for (const info of infos) {
    const pane = new FakeElement('div');
    pane.className = 'pane';
    pane.setAttribute('data-terminal-id', info.id);
    panes.append(pane);
  }
  let activeId: string | null = null;
  /** terminals.js activations: each terminal's last activation, for the one a close activates next. */
  const activations = new Map<string, number>();
  let activationSeq = 0;
  /** What each terminal received from the key bar, in order. */
  const received: Array<{ id: string; bytes: string }> = [];
  const terminals = {
    list: () => [...live.values()],
    activeId: () => activeId,
    // terminals.js activateTerminal: the one active pane; `activate` only for a terminal that exists.
    activate(id: string) {
      activeId = id;
      if (live.has(id)) activations.set(id, ++activationSeq);
      for (const pane of panes.children) pane.classList.toggle('active', pane.getAttribute('data-terminal-id') === id);
      if (live.has(id)) core.emit('activate', id);
    },
    // terminals.js closeTerminal: drop it and its pane, activate the most recent one left, and only
    // then emit `terminals` without the closed one.
    close(id: string) {
      if (!live.delete(id)) return;
      activations.delete(id);
      panes.children.find((pane) => pane.getAttribute('data-terminal-id') === id)?.remove();
      let next: Info | null = null;
      for (const info of live.values()) if (!next || (activations.get(info.id) ?? -1) > (activations.get(next.id) ?? -1)) next = info;
      if (next) terminals.activate(next.id);
      core.emit('terminals', [...live.values()]);
    },
    // terminals.js typeKey: false, and nothing sent, for a terminal that is not there.
    typeKey(id: string, key: string) {
      const bytes = live.has(id) ? keyBytes(key) : null;
      if (!bytes) return false;
      received.push({ id, bytes });
      return true;
    },
  };
  (globalThis as any).__phoneKeybar = terminals;
  const phone = await import(`${new URL('features/phone.js', publicDir).href}?boot=${boots}`);
  await phone.init();
  return {
    doc,
    received,
    /** A tap on an inbox card: features/inbox.js openCard. */
    openCard(id: string) {
      terminals.activate(id);
      core.emit('inbox:open', id);
    },
    /** Something else shows another terminal: a notification click (features/inbox.js), an `activate`. */
    activate: (id: string) => terminals.activate(id),
    /** Its tab's close control (terminals.js closeTerminal). */
    close: (id: string) => terminals.close(id),
    /** A press on the key bar's `key`, as a finger does it. */
    press(key: string) {
      const button = doc.getElementById('phone-keys')!.children.find((node) => node.getAttribute('data-key') === key);
      assert.ok(button, `the key bar has ${key}`);
      button.dispatch('mousedown');
      button.dispatch('click');
    },
    view: () => doc.body.getAttribute('data-phone'),
    header: () => doc.getElementById('phone-term-title')!.textContent,
    onScreen: () => panes.children.filter((pane) => pane.classList.contains('active')).map((pane) => pane.getAttribute('data-terminal-id')),
  };
}

test('S1: a card opens its terminal and the key bar types into it; the header names it', async () => {
  const page = await boot([ALPHA, BETA]);
  assert.equal(page.view(), 'inbox');
  page.openCard(ALPHA.id);
  assert.equal(page.view(), 'terminal');
  assert.deepEqual(page.onScreen(), [ALPHA.id]);
  assert.equal(page.header(), 'alpha · Dev › api › v2');
  page.press('Enter');
  page.press('ArrowUp');
  assert.deepEqual(page.received, [{ id: ALPHA.id, bytes: '\r' }, { id: ALPHA.id, bytes: '\x1b[A' }]);
});

test('S1: another terminal activated while the phone terminal view is open takes the next key and the header', async () => {
  const page = await boot([ALPHA, BETA]);
  page.openCard(ALPHA.id);
  // A notification click (or any `activate`) shows beta, the view stays open.
  page.activate(BETA.id);
  assert.equal(page.view(), 'terminal');
  assert.deepEqual(page.onScreen(), [BETA.id]);
  assert.equal(page.header(), 'beta · Dev');
  page.press('Escape');
  assert.deepEqual(page.received, [{ id: BETA.id, bytes: '\x1b' }], 'the key reaches the terminal on screen, never alpha');
  // And back: every key follows the pane on screen.
  page.activate(ALPHA.id);
  assert.equal(page.header(), 'alpha · Dev › api › v2');
  page.press('Tab');
  assert.deepEqual(page.received.at(-1), { id: ALPHA.id, bytes: '\t' });
});

test('S1: with no terminal on screen the keys send nothing, not even to the card\'s terminal', async () => {
  const page = await boot([ALPHA, BETA]);
  page.openCard(ALPHA.id);
  // Activated, but not there (e.g. it is already gone): no pane is on screen, alpha still lives.
  page.activate('t-gone');
  assert.deepEqual(page.onScreen(), []);
  for (const { key } of KEY_BAR) page.press(key);
  assert.deepEqual(page.received, []);

  // A card whose terminal is gone opens the view with nothing on screen: the keys do nothing.
  const stale = await boot([ALPHA]);
  stale.openCard('t-gone');
  assert.deepEqual(stale.onScreen(), []);
  assert.equal(stale.header(), '', 'the header names no terminal either');
  for (const { key } of KEY_BAR) stale.press(key);
  assert.deepEqual(stale.received, []);
});

test('S1/L3: closing the terminal on screen goes back to the inbox, though the next one becomes active; no key reaches it', async () => {
  const page = await boot([ALPHA, BETA]);
  page.openCard(ALPHA.id);
  page.close(ALPHA.id);
  assert.deepEqual(page.onScreen(), [BETA.id], 'closeTerminal activated the next terminal');
  assert.equal(page.view(), 'inbox', 'the view went back to the inbox, as before');
  assert.equal(page.header(), '', 'the terminal header names nothing');
  for (const { key } of KEY_BAR) page.press(key);
  assert.deepEqual(page.received, [], 'no key reaches the terminal activated in its place');
});

test('S1/L3: a terminal activated with the view open takes the keys; closing it then goes back to the inbox', async () => {
  const page = await boot([ALPHA, BETA]);
  page.openCard(ALPHA.id);
  page.activate(BETA.id);
  assert.equal(page.view(), 'terminal');
  assert.equal(page.header(), 'beta · Dev');
  page.press('Enter');
  assert.deepEqual(page.received, [{ id: BETA.id, bytes: '\r' }]);
  // Beta is now the one on screen: its close sends the view back, though alpha becomes active.
  page.close(BETA.id);
  assert.deepEqual(page.onScreen(), [ALPHA.id]);
  assert.equal(page.view(), 'inbox');
  page.press('Enter');
  assert.deepEqual(page.received, [{ id: BETA.id, bytes: '\r' }], 'nothing reached alpha');
});

test('S1/L3: closing a terminal that is not on screen leaves the view on the one shown', async () => {
  const page = await boot([ALPHA, BETA]);
  page.openCard(BETA.id);
  page.activate(ALPHA.id);
  page.close(BETA.id);
  assert.equal(page.view(), 'terminal');
  assert.deepEqual(page.onScreen(), [ALPHA.id]);
  assert.equal(page.header(), 'alpha · Dev › api › v2');
  page.press('Tab');
  assert.deepEqual(page.received, [{ id: ALPHA.id, bytes: '\t' }]);
});
