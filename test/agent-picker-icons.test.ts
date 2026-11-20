// Each agent in a row's ▾ menu shows its own icon
// (public/icons/agents.js). Pi keeps the rose; claude-code, opencode, gemini-cli and kimi show their
// Simple Icons logo (CC0 path data), filled in currentColor; antigravity and codex, which have no
// openly licensed logo, show a neutral monogram drawn in the icon set's stroke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS } from '../src/agents/catalog.ts';
import { SVG_NS } from '../public/icons.js';
import { AGENT_LOGOS, AGENT_MONOGRAMS, agentGlyph, agentIcon, injectAgentSprite } from '../public/icons/agents.js';

test('every catalog agent maps to an icon: the rose, its logo or its monogram', () => {
  assert.deepEqual(Object.fromEntries(AGENTS.map((agent) => [agent.id, agentGlyph(agent.id).kind])), {
    pi: 'rose',
    'claude-code': 'logo',
    opencode: 'logo',
    antigravity: 'monogram',
    codex: 'monogram',
    'gemini-cli': 'logo',
    kimi: 'logo',
  });
  assert.equal(agentGlyph('hermes').kind, 'generic', 'an id outside the catalog gets the plain terminal icon');
  assert.equal(agentGlyph(null).kind, 'generic');
});

test('the logos are the Simple Icons 16.37.0 shapes, one filled path in currentColor', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(AGENT_LOGOS).map(([id, logo]: [string, any]) => [id, [logo.title, logo.slug]])), {
    'claude-code': ['Claude Code', 'claudecode'],
    opencode: ['OpenCode', 'opencode'],
    'gemini-cli': ['Google Gemini', 'googlegemini'],
    kimi: ['Kimi', 'kimi'],
  });
  // Copied from https://cdn.jsdelivr.net/npm/simple-icons@16.37.0/icons/opencode.svg.
  assert.equal((AGENT_LOGOS as any).opencode.d, 'M22 24H2V0h20zM17 4.8H7v14.4h10z');
  for (const id of Object.keys(AGENT_LOGOS)) {
    const glyph = agentGlyph(id) as any;
    assert.equal(glyph.symbol, `agent-${id}`);
    assert.deepEqual(glyph.shapes, [['path', { d: (AGENT_LOGOS as any)[id].d, fill: 'currentColor', stroke: 'none' }]], id);
    assert.match((AGENT_LOGOS as any)[id].d, /^M[\d.\s\-MmLlHhVvCcSsQqTtAaZz,]+$/, `${id}: path data only`);
  }
});

test('a monogram is the agent\'s initial in a rounded frame, in the icon set\'s stroke', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(AGENT_MONOGRAMS).map(([id, mark]: [string, any]) => [id, mark.letter])), { antigravity: 'A', codex: 'C' });
  for (const id of Object.keys(AGENT_MONOGRAMS)) {
    const glyph = agentGlyph(id) as any;
    assert.equal(glyph.symbol, `agent-${id}`);
    assert.equal(glyph.viewBox, '0 0 24 24');
    assert.deepEqual(glyph.shapes[0], ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '4' }]);
    assert.equal(glyph.shapes.length, 2);
    assert.equal(glyph.shapes[1][0], 'path');
    assert.equal('fill' in glyph.shapes[1][1], false, 'stroked like the other icons');
  }
});

/* A DOM stand-in: what icons.js and icons/agents.js touch. */
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
  get classList() {
    return { add: (name: string) => this.setAttribute('class', `${this.getAttribute('class') ?? ''} ${name}`.trim()) };
  }
}
function fakeDocument() {
  const body = new FakeNode('http://www.w3.org/1999/xhtml', 'body');
  const find = (node: FakeNode, id: string): FakeNode | null =>
    node.getAttribute('id') === id ? node : node.children.reduce<FakeNode | null>((hit, child) => hit ?? find(child, id), null);
  return { body, createElementNS: (ns: string, tag: string) => new FakeNode(ns, tag), getElementById: (id: string) => find(body, id) };
}
const href = (svg: FakeNode) => svg.children[0].getAttribute('href');

test('agentIcon: decorative icons; pi\'s rose in --rose, the others from a sprite of their own, added once', () => {
  const doc = fakeDocument();
  (globalThis as any).document = doc;
  const rose = agentIcon('pi') as unknown as FakeNode;
  assert.equal(href(rose), '#i-rose');
  assert.equal(rose.getAttribute('class'), 'icon gs-rose');
  assert.equal(doc.body.children.length, 0, 'the rose needs no agent sprite');
  const claude = agentIcon('claude-code') as unknown as FakeNode;
  assert.equal(claude.namespaceURI, SVG_NS);
  assert.equal(claude.getAttribute('class'), 'icon');
  assert.equal(claude.getAttribute('aria-hidden'), 'true');
  assert.equal(claude.getAttribute('focusable'), 'false');
  assert.equal(href(claude), '#i-agent-claude-code');
  assert.equal(href(agentIcon('codex') as unknown as FakeNode), '#i-agent-codex');
  assert.equal(href(agentIcon('hermes') as unknown as FakeNode), '#i-terminal');
  injectAgentSprite(doc);
  assert.equal(doc.body.children.length, 1, 'one agent sprite, however many icons');
  const sprite = doc.body.children[0];
  assert.equal(sprite.getAttribute('id'), 'agent-icon-sprite');
  assert.equal(sprite.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(sprite.children.map((s) => s.getAttribute('id')), ['i-agent-claude-code', 'i-agent-opencode', 'i-agent-gemini-cli', 'i-agent-kimi', 'i-agent-antigravity', 'i-agent-codex']);
  const kimi = sprite.children.find((s) => s.getAttribute('id') === 'i-agent-kimi')!;
  assert.equal(kimi.children[0].getAttribute('fill'), 'currentColor');
  assert.equal(kimi.children[0].getAttribute('d'), (AGENT_LOGOS as any).kimi.d);
});
