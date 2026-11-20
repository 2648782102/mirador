// Each agent tab shows its agent's icon before its title (public/terminals.js, public/icons/agents.js):
// the rose for pi (gentle-shell), the Claude Code logo, and so on, so tabs tell apart without a
// click. The tab's tooltip and accessible name say the agent; bash tabs keep their look and git
// terminals stay out of the strip. The tabs are built by the real terminals.js, loaded in Node
// with a small DOM stand-in, a fake xterm and a fake API: the reload path (initTerminals reads
// GET /api/terminals), the open and wake path (showOpenedTerminals) and the server's replay.
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
// The browser paths of public/ ('/core.js', '/vendor/xterm.mjs') as Node files and the fake xterm.
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

/** One compound selector: tag, #id, .classes, [attr] and [attr="value"]. */
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
/** A selector of compounds joined by ' ' or ' > ', matched right to left. */
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
  listeners = new Map<string, Array<(event: unknown) => void>>();
  draggable = false;
  clientWidth = 0;
  offsetParent = null;
  localName: string;
  namespaceURI: string;
  constructor(namespaceURI: string, tag: string) {
    this.namespaceURI = namespaceURI;
    this.localName = tag.toLowerCase();
  }
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
  get id() { return this.getAttribute('id') ?? ''; }
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
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener() {}
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, width: 0 }; }
  contains(node: FakeElement | null): boolean { return node === this || this.children.some((c) => c.contains(node)); }
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
  documentElement = new FakeElement('http://www.w3.org/1999/xhtml', 'html');
  body = new FakeElement('http://www.w3.org/1999/xhtml', 'body');
  visibilityState = 'visible';
  constructor() {
    this.documentElement.parentNode = this;
    this.documentElement.append(this.body);
    const html = (tag: string, id: string) => {
      const node = new FakeElement('http://www.w3.org/1999/xhtml', tag);
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
  createElement(tag: string) { return new FakeElement('http://www.w3.org/1999/xhtml', tag); }
  createElementNS(ns: string, tag: string) { return new FakeElement(ns, tag); }
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

// core.js marks the page's theme when it loads; boot() gives each case a page of its own.
(globalThis as any).document = new FakeDocument();
const core = await import(new URL('core.js', publicDir).href);

const WORKSPACE = { id: 'dev', name: 'Dev', path: '/home/you/Dev' };
let boots = 0;

/**
 * Loads a fresh terminals.js on a fresh page under `config`, with GET /api/agents answering
 * `agents` and GET /api/terminals answering `running` (the tabs a reload restores), and runs its
 * initTerminals. Returns the module and the page.
 */
async function boot(config: object, agents: object[], running: object[] = []) {
  const doc = new FakeDocument();
  (globalThis as any).document = doc;
  const routes: Record<string, unknown> = { '/api/terminals': running, '/api/agents': { agents } };
  (globalThis as any).fetch = async (path: string) => ({ status: 200, ok: true, json: async () => structuredClone(routes[path] ?? null) });
  core.session.token = 'test-token';
  core.state.config = config;
  core.state.workspaces = [WORKSPACE];
  const terminals = await import(`${new URL('terminals.js', publicDir).href}?boot=${++boots}`);
  await terminals.initTerminals();
  return { terminals, doc };
}

const info = (id: string, kind: string, extra: object = {}) => ({
  id, kind, workspaceId: 'dev', rel: 'vigia', cwd: '/home/you/Dev/vigia', title: 'vigia', status: 'running', createdAt: '2026-11-10T12:00:00Z', ...extra,
});
const tab = (doc: FakeDocument, id: string) => doc.querySelector(`#tabs [data-terminal-id="${id}"]`)!;
/** The <use> href of the agent icon in a tab, or null when it shows none. */
const agentHref = (tabNode: FakeElement) => tabNode.querySelector('.agent-mark')?.querySelector('svg')?.querySelector('use')?.getAttribute('href') ?? null;
const agentSvg = (tabNode: FakeElement) => tabNode.querySelector('.agent-mark')!.querySelector('svg')!;

const OFFERED = [
  { id: 'pi', label: 'Pi (gentle-shell)', command: 'gentle-shell', configured: true, attention: 'bridge', resume: true },
  { id: 'claude-code', label: 'Claude Code', command: 'claude', configured: false, attention: 'hooks', resume: true },
  { id: 'opencode', label: 'opencode', command: 'opencode', configured: false, attention: 'plugin', resume: false },
];
const GENTLE_DECK = { mode: 'gentle-deck', agentCommand: 'gentle-shell' };

test('a chosen agent\'s tab shows its icon before the title, and its tooltip and name say which agent it is', async () => {
  const { terminals, doc } = await boot(GENTLE_DECK, OFFERED);
  terminals.showOpenedTerminals([info('t-claude', 'agent', { agent: 'claude-code' }), info('t-open', 'agent', { agent: 'opencode' })]);
  const claude = tab(doc, 't-claude');
  assert.equal(agentHref(claude), '#i-agent-claude-code');
  assert.equal(agentHref(tab(doc, 't-open')), '#i-agent-opencode');
  assert.ok(doc.getElementById('agent-icon-sprite'), 'the logos\' sprite is on the page');
  assert.equal(agentSvg(claude).getAttribute('aria-hidden'), 'true', 'the icon itself is decorative');
  // Glyph, agent, title and kind in the role=tab; the agent's name is read with the title.
  const item = claude.querySelector('[role="tab"]')!;
  assert.deepEqual(item.children.map((c) => c.className), ['term-mark', 'agent-mark', 'tab-title', 'kind']);
  assert.match(item.textContent, /^Claude Code\s*vigia$/);
  assert.ok(claude.title.split('\n').includes(core.t('term.agentTitle', { agent: 'Claude Code' })), claude.title);
  assert.notEqual(core.t('term.agentTitle', { agent: 'X' }), 'term.agentTitle');
});

test('a configured agent\'s tab shows the configured agent: the rose for pi (gentle-shell), also after a reload', async () => {
  // Restored by the reload's GET /api/terminals, without a chosen agent: the configured one.
  const { terminals, doc } = await boot(GENTLE_DECK, OFFERED, [info('t-pi', 'agent')]);
  const pi = tab(doc, 't-pi');
  assert.equal(agentHref(pi), '#i-rose');
  assert.equal(agentSvg(pi).getAttribute('class'), 'icon gs-rose', 'the rose keeps --rose');
  // The tree's agent button names it gentle-shell in gentle-deck (mode-model.js agentLabel).
  assert.ok(pi.title.split('\n').includes(core.t('term.agentTitle', { agent: 'gentle-shell' })), pi.title);
  // Opened from the tree the same way, it shows the same.
  terminals.showOpenedTerminals([info('t-pi-2', 'agent')]);
  assert.equal(agentHref(tab(doc, 't-pi-2')), '#i-rose');
});

test('the configured agent\'s icon follows its catalog id; one outside the catalog shows the rose, as the tree\'s button', async () => {
  const claudeConfigured = [{ ...OFFERED[1], configured: true }, { ...OFFERED[0], configured: false }];
  const plain = await boot({ mode: 'plain', agentCommand: 'claude' }, claudeConfigured, [info('t-conf', 'agent')]);
  const conf = tab(plain.doc, 't-conf');
  assert.equal(agentHref(conf), '#i-agent-claude-code');
  assert.ok(conf.title.split('\n').includes(core.t('term.agentTitle', { agent: 'claude' })), conf.title);
  const other = await boot({ mode: 'plain', agentCommand: 'hermes --fast' }, [{ id: null, label: 'hermes --fast', command: 'hermes --fast', configured: true, attention: 'none', resume: false }], [info('t-hermes', 'agent')]);
  const hermes = tab(other.doc, 't-hermes');
  assert.equal(agentHref(hermes), '#i-rose');
  assert.ok(hermes.title.split('\n').includes(core.t('term.agentTitle', { agent: 'hermes' })), hermes.title);
});

test('a bash tab shows no agent icon and a git terminal never becomes a tab', async () => {
  const { terminals, doc } = await boot(GENTLE_DECK, OFFERED, [info('t-git', 'git')]);
  terminals.showOpenedTerminals([info('t-bash', 'shell'), info('t-git-2', 'git')]);
  const bash = tab(doc, 't-bash');
  assert.equal(agentHref(bash), null);
  assert.equal(bash.querySelector('[role="tab"]')!.textContent, 'vigiabash');
  assert.ok(!bash.title.split('\n').some((line) => line.startsWith(core.t('term.agentTitle', { agent: '' }).trim())), bash.title);
  assert.equal(doc.querySelector('#tabs [data-terminal-id="t-git"]'), null);
  assert.equal(doc.querySelector('#tabs [data-terminal-id="t-git-2"]'), null);
});

test('the server\'s replay after a reconnect keeps the icon, and a sleeping agent woken again shows its own', async () => {
  const { terminals, doc } = await boot(GENTLE_DECK, OFFERED, [info('t-claude', 'agent', { agent: 'claude-code' })]);
  const socket = sockets.findLast((s) => s.url.endsWith('/t-claude'))!;
  const before = agentSvg(tab(doc, 't-claude'));
  socket.receive({ t: 's', info: info('t-claude', 'agent', { agent: 'claude-code', cols: 80, rows: 24 }), d: '' });
  assert.equal(agentHref(tab(doc, 't-claude')), '#i-agent-claude-code');
  assert.equal(agentSvg(tab(doc, 't-claude')), before, 'the same icon, not drawn again on every update');
  // Woken from "Dormidos" (features/sleeping.js), a terminal comes back through showOpenedTerminals.
  terminals.showOpenedTerminals([info('t-woken', 'agent', { agent: 'opencode' })]);
  assert.equal(agentHref(tab(doc, 't-woken')), '#i-agent-opencode');
});

test('kept: a tab still holds its state glyph, title and kind, its × beside it, and its first tooltip lines', async () => {
  const { terminals, doc } = await boot(GENTLE_DECK, OFFERED);
  terminals.showOpenedTerminals([info('t-claude', 'agent', { agent: 'claude-code' }), info('t-bash', 'shell')]);
  for (const id of ['t-claude', 't-bash']) {
    const node = tab(doc, id);
    assert.deepEqual(node.children.map((c) => [c.localName, c.className]), [['span', 'tab-item'], ['button', 'close']]);
    const item = node.children[0];
    assert.equal(item.getAttribute('role'), 'tab');
    assert.equal(item.getAttribute('aria-controls'), `term-pane-${id}`);
    // An agent shows its state's glyph (paintState); a shell has none.
    const glyphs = item.querySelector('.term-mark')!.children;
    assert.deepEqual(glyphs.map((g) => g.classList.contains('glyph')), id === 't-bash' ? [] : [true]);
    assert.equal(item.querySelector('.tab-title')!.textContent, 'vigia');
    assert.equal(node.children[1].getAttribute('aria-label'), core.t('term.close'));
    assert.equal(node.title.split('\n').slice(0, 3).join('\n'), 'vigia\nDev › vigia\n/home/you/Dev/vigia');
    assert.equal(node.title.split('\n').at(-1), core.t('term.reorderHint'));
  }
  assert.equal(tab(doc, 't-claude').querySelector('.kind')!.textContent, '');
  assert.equal(tab(doc, 't-bash').querySelector('.kind')!.textContent, 'bash');
  // The grid pane head is the artboard one, untouched (gentle-deck-theme-contract S4).
  const head = doc.querySelector('#term-pane-t-claude')!.querySelector('.pane-head')!;
  assert.deepEqual(head.children.map((c) => c.className.split(' ')[0]), ['icon', 'st', 'kind', 'pane-title', 'cwd', 'close']);
});

test('the empty state names each terminal button once in either language: one bash when the agent button is bash too', async () => {
  const offered = (command: string) => [{ id: null, label: command, command, configured: true, attention: 'none', resume: false }];
  const cases: Array<[object, object[], string[]]> = [
    [{ mode: 'plain', agentCommand: 'bash' }, offered('bash'), ['bash']],
    [{ mode: 'plain', agentCommand: 'claude' }, offered('claude'), ['claude', 'bash']],
    [GENTLE_DECK, OFFERED, ['gentle-shell', 'bash']],
  ];
  for (const [config, agents, buttons] of cases) {
    const { doc } = await boot(config, agents);
    for (const language of ['es', 'en']) {
      core.setLanguage(language);
      const hint = doc.getElementById('empty-hint')!;
      const where = `${JSON.stringify(config)} ${language}: ${hint.textContent}`;
      assert.deepEqual(hint.querySelectorAll('kbd').map((kbd) => kbd.textContent), buttons, where);
      for (const button of buttons) assert.equal(hint.textContent.split(button).length - 1, 1, where);
      assert.doesNotMatch(hint.textContent, /\{\w+\}|empty\./, where);
    }
  }
});
