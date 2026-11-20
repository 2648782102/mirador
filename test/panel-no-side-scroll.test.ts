// The right panel never scrolls sideways. A box with `overflow: hidden` can still be scrolled by
// script, and a focus() without preventScroll scrolls every such ancestor to show what it focuses:
// once any child is wider than the panel, rebuilding the view switch and refocusing its button
// pushed the whole panel (head, date row, chips, cards) off its left edge. The panel clips instead
// (`overflow: clip` cannot be scrolled at all) and its focus calls pass `{ preventScroll: true }`.
// The behaviour part runs the real public/features/summary.js in Node on a small DOM stand-in;
// '/core.js' and its other browser imports are stand-ins (data: modules), as in
// test/inbox-view-notify.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('public/styles.css');

/** Every rule of `source` as [selector, declarations], comments dropped, at-rule heads skipped. */
function rules(source: string): Array<[string, Record<string, string>]> {
  const plain = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
    m[1].trim(),
    Object.fromEntries([...m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].map((d) => [d[1], d[2].trim()])),
  ]);
}

/** The rules whose selector list holds a selector that ends on the panel itself (`.panel`, `… > .panel`). */
const panelRules = rules(css).filter(([selector]) => selector.split(',').some((part) => /\.panel$/.test(part.trim())));

test('the right panel clips its content: it cannot be scrolled sideways, in the columns or as a drawer', () => {
  const own = panelRules.find(([selector]) => selector === '.panel');
  assert.ok(own, 'rule .panel is missing');
  assert.equal(own[1].overflow, 'clip');
  // The drawer under 1280px (.layout.drawer-panel > .panel) and the open drawer keep the clip.
  assert.ok(panelRules.some(([selector]) => selector === '.layout.drawer-panel > .panel'), 'the drawer rule is still there');
  for (const [selector, declarations] of panelRules) {
    for (const name of ['overflow', 'overflow-x', 'overflow-inline']) {
      if (declarations[name] !== undefined) assert.equal(declarations[name], 'clip', `${selector} ${name}`);
    }
  }
  // Its body is what scrolls, up and down.
  assert.equal(rules(css).find(([selector]) => selector === '.panel-body')?.[1].overflow, 'auto');
});

/** Each `.focus(…)` call of `source`: what it is called on and its argument text. */
function focusCalls(source: string): Array<{ on: string; args: string; line: number }> {
  return [...source.matchAll(/([\w$.\])?]*)\.focus\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => ({
    on: m[1],
    args: m[2].trim(),
    line: source.slice(0, m.index).split('\n').length,
  }));
}

// The modules that render inside the right panel: the view switch and "Día" (summary.js), the inbox
// cards (inbox.js), the workspace summary and "Dónde quedó" (overview.js), plain mode's "Where it
// left off" (plain-left-off.js) and "Changes" (changes-panel.js).
const PANEL_MODULES = ['summary.js', 'inbox.js', 'overview.js', 'plain-left-off.js', 'changes-panel.js'].map((name) => `public/features/${name}`);
// Not inside the panel: the browser window (a notification click) and the mission dialog's field,
// which lives in the modal, not in the panel.
const OUTSIDE = new Set(['public/features/inbox.js window', 'public/features/overview.js input']);

test('every focus() call of the panel views passes { preventScroll: true }', () => {
  let checked = 0;
  for (const path of PANEL_MODULES) {
    for (const call of focusCalls(read(path))) {
      if (OUTSIDE.has(`${path} ${call.on}`)) continue;
      checked++;
      assert.equal(call.args, '{ preventScroll: true }', `${path}:${call.line} ${call.on}.focus(${call.args})`);
    }
    assert.doesNotMatch(read(path), /scrollIntoView/, `${path} scrolls something into view`);
  }
  // The view switch, the inbox cards, the inbox notification control and the pager box.
  assert.ok(checked >= 4, `only ${checked} focus calls found`);
});

test('focus that goes back to where it was, which can be a panel control, does not scroll either', () => {
  // A dialog opened from the panel (the mission dialog) gives the keyboard back to its opener.
  assert.match(read('public/dialog.js'), /if \(opener instanceof HTMLElement && opener\.isConnected\) opener\.focus\(\{ preventScroll: true \}\);/);
  // The file viewer opened from an inbox card does the same, falling back to the opener's row.
  const files = read('public/features/files.js');
  assert.match(files, /opener\.focus\(\{ preventScroll: true \}\);\n\s*\/\/ [^\n]*\n\s*if \(document\.activeElement !== opener\) opener\.closest\('\[tabindex\]'\)\?\.focus\(\{ preventScroll: true \}\);/);
  // A batch that goes on opening agents puts the keyboard back where it was.
  assert.match(read('public/features/workspaces.js'), /if \(focused instanceof HTMLElement && focused !== document\.body\) focused\.focus\(\{ preventScroll: true \}\);/);
});

/* ---------- The view switch, live: public/features/summary.js on a DOM stand-in ---------- */

const publicDir = new URL('../public/', import.meta.url);
const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS: Record<string, string> = {
  '/core.js': stub(`
    const C = globalThis.__panelCore;
    export const $ = (selector) => C.byId(selector.slice(1));
    export const api = async (method, url) => C.api(method, url);
    export const el = (...a) => C.el(...a);
    export const errorText = (error) => String(error);
    export const getLanguage = () => 'en';
    export const on = () => {};
    export const prefs = C.prefs;
    export const select = () => {};
    export const slot = (name) => C.slot(name);
    export const state = C.state;
    export const t = (key) => key;
    export const workspaceById = (id) => ({ id, name: id });
  `),
  '/markdown.js': stub('export const renderGlossary = () => null; export const renderMarkdown = () => null;'),
  '/memory-text.js': stub("export const buildGlossary = () => ({}); export const memoryLanguage = () => 'en';"),
  '/memory-health-model.js': stub('export const displayTitle = (title) => ({ text: title, fallback: false });'),
  '/i18n.js': stub('export const plural = (language, key) => key;'),
  '/mode-model.js': stub('export const showsExtra = () => true;'),
  '/columns.js': stub('export const wireSide = () => {};'),
  '/terminals.js': stub('export const activePlace = () => null; export const activeTerminalId = () => null;'),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

class FakeElement {
  tagName: string;
  children: Array<FakeElement | string> = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  dataset: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  title = '';
  value = '';
  /** How far a child sticks out of this box to its right, in px; 0: nothing does. */
  overflowBy = 0;
  scrollLeft = 0;
  /** The options of each focus() call made on this element. */
  focusCalls: unknown[] = [];
  constructor(tagName: string) { this.tagName = tagName; }
  get textContent(): string { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(text: string) { this.children = [text]; }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, fn: () => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click() { if (!this.disabled) for (const fn of this.listeners.get('click') ?? []) fn(); }
  append(...nodes: Array<FakeElement | string>) { for (const node of nodes) { if (typeof node !== 'string') node.parent = this; this.children.push(node); } }
  before() {}
  replaceChildren(...nodes: Array<FakeElement | string>) {
    for (const child of this.children) if (typeof child !== 'string') child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  contains(node: unknown): boolean { return node === this || this.children.some((c) => typeof c !== 'string' && c.contains(node)); }
  get isConnected(): boolean { return this.parent !== null && (this.parent === doc.body || this.parent.isConnected); }
  descendants(): FakeElement[] { return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.descendants()])); }
  /** Only `[data-view="…"]`, the one selector summary.js asks a slot for. */
  querySelector(selector: string) {
    const view = selector.match(/^\[data-view="(.*)"\]$/)?.[1];
    assert.ok(view !== undefined, `unexpected selector ${selector}`);
    return this.descendants().find((node) => node.dataset.view === view) ?? null;
  }
  /**
   * As a browser does: without preventScroll, every ancestor box something sticks out of is scrolled
   * to show the focused element, a box with `overflow: hidden` too (this stand-in takes the panel as
   * one, whatever styles.css says, so this checks the script on its own).
   */
  focus(options?: { preventScroll?: boolean }) {
    this.focusCalls.push(options);
    if (!this.isConnected || this.hidden || this.disabled) return;
    doc.activeElement = this;
    if (options?.preventScroll) return;
    for (let box = this.parent; box; box = box.parent) if (box.overflowBy > 0) box.scrollLeft = box.overflowBy;
  }
}

class FakeDocument {
  visibilityState = 'visible';
  body = new FakeElement('body');
  documentElement = { lang: 'en' };
  activeElement: FakeElement = this.body;
}

let doc = new FakeDocument();
const ids = new Map<string, FakeElement>();
const slots = new Map<string, FakeElement>();
const stored = new Map<string, unknown>();
const core = {
  byId: (id: string) => {
    const node = ids.get(id);
    assert.ok(node, `#${id} is not on the page`);
    return node;
  },
  slot: (name: string) => {
    const node = slots.get(name);
    assert.ok(node, `slot ${name} is not on the page`);
    return node;
  },
  el(tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) {
    const node = new FakeElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value as () => unknown);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child as FakeElement | string);
    return node;
  },
  api: async (_method: string, url: string) => {
    assert.match(url, /^\/api\/activity\?date=/);
    return { projects: [] };
  },
  prefs: { read: (key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback), write: (key: string, value: unknown) => stored.set(key, value) },
  state: { selection: null, config: { today: '2026-11-19' } },
};
Object.assign(globalThis, { __panelCore: core, CSS: { escape: (s: string) => s } });

/** The right panel of public/index.html, as far as summary.js reaches: head, view switch, date row, inbox slot, body. */
function page() {
  doc = new FakeDocument();
  (globalThis as any).document = doc;
  ids.clear();
  slots.clear();
  stored.clear();
  const panel = new FakeElement('aside');
  panel.parent = doc.body;
  const part = (tag: string, id?: string) => {
    const node = new FakeElement(tag);
    if (id) ids.set(id, node);
    return node;
  };
  const views = part('div');
  slots.set('panel-views', views);
  const inbox = part('section');
  slots.set('inbox', inbox);
  const dateNav = part('div', 'date-nav');
  dateNav.append(...['day-prev', 'day-input', 'day-next', 'day-today', 'show-all'].map((id) => part(id === 'day-input' ? 'input' : 'button', id)));
  const head = part('div');
  head.append(part('p', 'panel-crumb'), part('h2', 'panel-heading'), part('p', 'panel-subtitle'), views);
  panel.append(head, dateNav, inbox, part('div', 'panel-body'));
  // A child wider than the panel (the date row at 1895px, say): the panel has 120px to scroll.
  panel.overflowBy = 120;
  return panel;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('switching views from the keyboard keeps the focus on the chosen view and never scrolls the panel', async () => {
  const panel = page();
  const summary = await import(new URL('features/summary.js', publicDir).href);
  // A third view, so the switch has a middle part, as a workspace's summary does.
  summary.registerPanelView({ id: 'notes', label: 'notes', applies: () => true, render: async () => [] });
  await summary.init();
  await settle();
  const button = (view: string) => slots.get('panel-views')!.querySelector(`[data-view="${view}"]`)!;
  assert.deepEqual(slots.get('panel-views')!.children.map((c) => (c as FakeElement).dataset.view), ['inbox', 'notes', 'daily']);
  assert.equal(button('daily').getAttribute('aria-pressed'), 'true', 'nothing selected opens on "Día"');

  for (const view of ['notes', 'daily', 'inbox', 'notes', 'daily']) {
    const before = button(view);
    // The user tabs to the part and presses it.
    doc.activeElement = before;
    before.click();
    await settle();
    const after = button(view);
    assert.notEqual(after, before, 'the switch was rebuilt');
    assert.equal(doc.activeElement, after, `the keyboard stays on ${view}`);
    assert.equal(panel.scrollLeft, 0, `after switching to ${view} the panel is not scrolled sideways`);
    assert.deepEqual(after.focusCalls, [{ preventScroll: true }], `${view} is refocused without scrolling`);
    assert.equal(after.getAttribute('aria-pressed'), 'true');
    assert.equal((stored.get('panelViews') as Record<string, string>).none, view, 'the choice is remembered');
    // Each view shows its own parts: the date row only in "Día", the inbox cards only in "Te esperan".
    assert.deepEqual([ids.get('date-nav')!.hidden, slots.get('inbox')!.hidden, ids.get('panel-body')!.hidden], [view !== 'daily', view !== 'inbox', view === 'inbox']);
  }
});

test('a view switch rebuilt without the keyboard on it takes no focus and scrolls nothing', async () => {
  const panel = page();
  const summary = await import(`${new URL('features/summary.js', publicDir).href}?again`);
  await summary.init();
  await settle();
  // A click that leaves the keyboard elsewhere (Safari does not focus a clicked button).
  slots.get('panel-views')!.querySelector('[data-view="inbox"]')!.click();
  await settle();
  const shown = slots.get('panel-views')!.descendants();
  assert.equal(doc.activeElement, doc.body);
  assert.ok(shown.every((node) => node.focusCalls.length === 0), 'nothing was focused');
  assert.equal(panel.scrollLeft, 0);
});
