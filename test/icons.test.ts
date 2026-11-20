// The SVG icon set (S2, design/mirador-theme/03-papel-y-tinta.html):
// one sprite in public/icons.js, copied from the artboard, holding exactly the icons the app uses
// plus the ones later tasks place; icon() builds a decorative or labelled <svg class="icon">.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SVG_NS, SYMBOLS, icon, injectSprite } from '../public/icons.js';
import { MESSAGES } from '../public/i18n.js';
import { nightView } from '../public/i18n/inbox.js';
import { moreButton, moreTools, rowTools } from '../public/workspace-tools.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
/** Placed by later tasks of the feature: none left (T3 placed the mark, sliders, moon and sun). */
const RESERVED_FOR_LATER: string[] = [];

type Shape = [string, Record<string, string>];
const symbols = SYMBOLS as Record<string, Shape[]>;
const markup = (shapes: Shape[]) => shapes.map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('');

/** Browser code that may name an icon: public/*.js, public/features/*.js, public/i18n/*.js and index.html. */
function sources(): Array<[string, string]> {
  const list = (dir: string) => readdirSync(new URL(dir, root)).filter((f) => f.endsWith('.js')).map((f) => `${dir}${f}`);
  return [...list('public/'), ...list('public/features/'), ...list('public/i18n/'), 'public/index.html']
    .filter((file) => file !== 'public/icons.js')
    .map((file) => [file, read(file)]);
}

/** Every icon name the app asks for: icon('x'), `icon: 'x'` fields, #i-x hrefs, and the models' icon fields. */
function usedNames(): Map<string, string> {
  const used = new Map<string, string>();
  for (const [file, text] of sources()) {
    for (const re of [/\bicon\(\s*'([a-z-]+)'/g, /\bicon:\s*'([a-z-]+)'/g, /#i-([a-z-]+)/g]) {
      for (const match of text.matchAll(re)) used.set(match[1], file);
    }
  }
  const workspace = { id: 'w', name: 'W', projects: ['a'] };
  for (const tool of [...rowTools(workspace), moreButton(workspace), ...moreTools(workspace)] as Array<{ icon: string | null }>) {
    if (tool.icon) used.set(tool.icon, 'public/workspace-tools.js');
  }
  for (const state of ['deciding', 'resolved', 'deferred']) {
    used.set(nightView({ state, flow: 'question', summary: 'x', rule: 'low-confidence' }, (key: string) => key)!.icon, 'public/i18n/inbox.js');
  }
  return used;
}

test('S2: every icon the app names exists in the sprite', () => {
  const missing = [...usedNames()].filter(([name]) => !(name in symbols)).map(([name, file]) => `${file}: ${name}`);
  assert.deepEqual(missing, []);
});

test('S2: the sprite holds no icon that nothing uses, apart from the ones reserved for later tasks', () => {
  const used = usedNames();
  assert.deepEqual(Object.keys(symbols).filter((name) => !used.has(name) && !RESERVED_FOR_LATER.includes(name)), []);
  for (const name of RESERVED_FOR_LATER) assert.ok(name in symbols, `${name} is reserved but missing`);
});

test('S2: each symbol is the artboard symbol of the same name, path for path', { skip: NO_DESIGN }, () => {
  const artboard = readArtboard('design/mirador-theme/03-papel-y-tinta.html');
  const drawn = new Map([...artboard.matchAll(/<symbol id="i-([a-z-]+)" viewBox="0 0 24 24">(.*?)<\/symbol>/g)].map((m) => [m[1], m[2]]));
  for (const [name, shapes] of Object.entries(symbols)) {
    assert.ok(drawn.has(name), `${name} is not in the artboard`);
    assert.equal(markup(shapes), drawn.get(name), name);
  }
});

test('S2: the sprite has no external references: only path, circle and rect with geometry and paint', () => {
  const tags = new Set(['path', 'circle', 'rect']);
  const attrs = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'stroke-width']);
  for (const [name, shapes] of Object.entries(symbols)) {
    for (const [tag, list] of shapes) {
      assert.ok(tags.has(tag), `${name}: <${tag}>`);
      for (const [key, value] of Object.entries(list)) {
        assert.ok(attrs.has(key), `${name}: ${key}`);
        assert.doesNotMatch(value, /url\(|:\/\/|^\/|#/i, `${name}: ${key}="${value}"`);
      }
    }
  }
});

/* A DOM stand-in: createElementNS, attributes, children and getElementById are all the module touches. */
class FakeNode {
  children: FakeNode[] = [];
  attributes = new Map<string, string>();
  namespaceURI: string;
  localName: string;
  constructor(namespaceURI: string, localName: string) {
    this.namespaceURI = namespaceURI;
    this.localName = localName;
  }
  setAttribute(key: string, value: unknown) { this.attributes.set(key, String(value)); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  prepend(...nodes: FakeNode[]) { this.children.unshift(...nodes); }
}
function fakeDocument() {
  const body = new FakeNode('http://www.w3.org/1999/xhtml', 'body');
  const find = (node: FakeNode, id: string): FakeNode | null =>
    node.getAttribute('id') === id ? node : node.children.reduce<FakeNode | null>((hit, child) => hit ?? find(child, id), null);
  return { body, createElementNS: (ns: string, tag: string) => new FakeNode(ns, tag), getElementById: (id: string) => find(body, id) };
}

test('S2: icon() is decorative by default: <svg class="icon" aria-hidden focusable=false> using #i-name', () => {
  (globalThis as any).document = fakeDocument();
  const svg = icon('check') as unknown as FakeNode;
  assert.equal(svg.namespaceURI, SVG_NS);
  assert.equal(svg.localName, 'svg');
  assert.equal(svg.getAttribute('class'), 'icon');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('focusable'), 'false');
  assert.equal(svg.getAttribute('role'), null);
  assert.equal(svg.children.length, 1);
  assert.equal(svg.children[0].namespaceURI, SVG_NS);
  assert.equal(svg.children[0].localName, 'use');
  assert.equal(svg.children[0].getAttribute('href'), '#i-check');
});

test('S2: icon() with a label is an image named by it; a size picks the small or medium token', () => {
  (globalThis as any).document = fakeDocument();
  const svg = icon('wait', { label: 'Esperándote <b>', size: 'sm' }) as unknown as FakeNode;
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Esperándote <b>');
  assert.equal(svg.getAttribute('aria-hidden'), null);
  assert.equal(svg.getAttribute('focusable'), 'false');
  assert.equal(svg.getAttribute('class'), 'icon icon-sm');
  assert.equal((icon('wait', { size: 'md' }) as unknown as FakeNode).getAttribute('class'), 'icon icon-md');
});

test('S2: icon() rejects a name the sprite lacks and an unknown size', () => {
  (globalThis as any).document = fakeDocument();
  assert.throws(() => icon('nope'), /unknown icon "nope"/);
  assert.throws(() => icon('check', { size: 'xl' }), /unknown icon size "xl"/);
});

test('S2: injectSprite adds one hidden sprite to the body, once, with every symbol', () => {
  const doc = fakeDocument();
  injectSprite(doc);
  injectSprite(doc);
  assert.equal(doc.body.children.length, 1);
  const sprite = doc.body.children[0];
  assert.equal(sprite.namespaceURI, SVG_NS);
  assert.equal(sprite.getAttribute('aria-hidden'), 'true');
  assert.equal(sprite.getAttribute('focusable'), 'false');
  assert.equal(sprite.getAttribute('width'), '0');
  assert.equal(sprite.getAttribute('height'), '0');
  assert.deepEqual(sprite.children.map((s) => [s.localName, s.getAttribute('id'), s.getAttribute('viewBox')]), Object.keys(symbols).map((name) => ['symbol', `i-${name}`, '0 0 24 24']));
  const check = sprite.children.find((s) => s.getAttribute('id') === 'i-check')!;
  assert.deepEqual(check.children.map((s) => [s.localName, s.getAttribute('d')]), [['path', 'M20 6L9 17l-5-5']]);
});

test('S2: index.html draws its icons from the sprite, decorative, with no glyph left on its buttons', () => {
  const page = read('public/index.html');
  const svgs = [...page.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(svgs.length >= 7, 'side hide, side rails, date nav and add use the sprite');
  for (const svg of svgs) assert.equal(svg, '<svg class="icon" aria-hidden="true" focusable="false">');
  assert.doesNotMatch(page, /[«»‹›]<\/(button|span)>/);
});

test('S2: no i18n string carries a decorative icon glyph; the UI draws the icon beside the text', () => {
  const glyphs = /[💤⏳▶]/u;
  const hits = (['en', 'es'] as const).flatMap((lang) =>
    Object.entries((MESSAGES as any)[lang] as Record<string, string>).filter(([, text]) => glyphs.test(text)).map(([key]) => `${lang}: ${key}`),
  );
  assert.deepEqual(hits, []);
});
