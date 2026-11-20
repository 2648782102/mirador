// "Dónde quedó" reads its summary as written: sub-items under their parent, task markers as a check or
// an open box, and codes or terms whose explanation a click, a tap or the keyboard shows beside them
// (public/markdown.js). The server sends the goal and folds whole (test/overview-api.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/* ---------- A DOM stand-in: what markdown.js touches ---------- */

class FakeText {
  parentNode: FakeElement | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
}

type Listener = (event: FakeEvent) => void;
interface FakeEvent { key?: string; prevented?: boolean; preventDefault(): void; stopPropagation(): void }

class FakeElement {
  children: Array<FakeElement | FakeText> = [];
  parentNode: FakeElement | null = null;
  className = '';
  title = '';
  hidden = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  set textContent(text: string) { this.children = []; if (text) this.append(new FakeText(text)); }
  append(...nodes: Array<FakeElement | FakeText | string>) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  prepend(node: FakeElement) { node.parentNode = this; this.children.unshift(node); }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string, key?: string) {
    const event: FakeEvent = { key, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  all(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tagName === tag ? [c] : []), ...c.all(tag)] : []));
  }
}

(globalThis as any).document = { createElement: (tag: string) => new FakeElement(tag), createTextNode: (text: string) => new FakeText(text) };
const { renderInline, renderMarkdown } = await import(new URL('markdown.js', publicDir).href);
const labels: Record<string, string> = { 'task.done': 'Hecho', 'task.open': 'Pendiente', 'term.worktree': 'A second checkout of the same repository.' };
const options = { label: (key: string) => labels[key] ?? null };

const ownItems = (list: FakeElement) => list.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === 'li');
const ownText = (li: FakeElement) => li.children.filter((c) => !(c instanceof FakeElement && (c.tagName === 'ul' || c.tagName === 'ol'))).map((c) => c.textContent).join('');

test('sub-items show under their parent item, not as siblings', () => {
  const root = renderMarkdown('- Answer the worker:\n  - Q1 A keeps the cap.\n  - Q2 A widens the surfaces.\n- Run the suite.', options);
  const [outer] = root.children as FakeElement[];
  assert.equal(outer.tagName, 'ul');
  assert.deepEqual(ownItems(outer).map(ownText), ['Answer the worker:', 'Run the suite.']);
  const nested = ownItems(outer)[0].children.find((c): c is FakeElement => c instanceof FakeElement && c.tagName === 'ul');
  assert.ok(nested, 'the first item holds its sub-list');
  assert.deepEqual(ownItems(nested).map(ownText), ['Q1 A keeps the cap.', 'Q2 A widens the surfaces.']);
});

test('numbered items become an ordered list, and + or 1) markers are items too (as leftoff-model.js counts them)', () => {
  const root = renderMarkdown('1. First\n2) Second\n   + inner', options);
  const [list] = root.children as FakeElement[];
  assert.equal(list.tagName, 'ol');
  assert.deepEqual(ownItems(list).map(ownText), ['First', 'Second']);
  assert.deepEqual(ownItems(list)[1].all('li').map(ownText), ['inner']);
});

test('a flat list stays one list (existing behaviour)', () => {
  const root = renderMarkdown('- a\n- b\n* c', options);
  assert.equal(root.children.length, 1);
  assert.deepEqual(ownItems(root.children[0] as FakeElement).map(ownText), ['a', 'b', 'c']);
});

test('[x] and [ ] render as a named check or open box, never as raw brackets', () => {
  const root = renderMarkdown('- [x] Merged the PR\n- [ ] Write the docs\n- plain', options);
  const [done, open, plain] = ownItems(root.children[0] as FakeElement);
  assert.doesNotMatch(root.textContent, /\[x\]|\[ \]/);
  for (const [li, label, cls] of [[done, 'Hecho', 'mem-task is-done'], [open, 'Pendiente', 'mem-task']] as const) {
    const mark = li.children[0] as FakeElement;
    assert.equal(li.className, cls);
    assert.deepEqual([mark.className, mark.getAttribute('role'), mark.getAttribute('aria-label')], ['mem-check', 'img', label]);
  }
  assert.equal(ownText(done).slice(1), 'Merged the PR');
  assert.equal(plain.className, '');
});

test('a term opens its explanation on click, Enter or Space, and Escape closes it', () => {
  const nodes = renderInline('Use a worktree here.', options) as Array<FakeElement | FakeText>;
  const term = nodes.find((n): n is FakeElement => n instanceof FakeElement)!;
  const [abbr, note] = term.children as FakeElement[];
  assert.deepEqual([term.className, abbr.tagName, abbr.textContent, abbr.title], ['mem-term', 'abbr', 'worktree', labels['term.worktree']]);
  assert.deepEqual([abbr.getAttribute('tabindex'), abbr.getAttribute('role'), abbr.getAttribute('aria-expanded')], ['0', 'button', 'false']);
  assert.deepEqual([note.className, note.textContent, note.hidden], ['mem-abbr-note', labels['term.worktree'], true]);
  abbr.fire('click');
  assert.deepEqual([note.hidden, abbr.getAttribute('aria-expanded')], [false, 'true']);
  abbr.fire('click');
  assert.equal(note.hidden, true);
  assert.equal(abbr.fire('keydown', 'Enter').prevented, true);
  assert.equal(note.hidden, false);
  abbr.fire('keydown', 'Escape');
  assert.deepEqual([note.hidden, abbr.getAttribute('aria-expanded')], [true, 'false']);
  abbr.fire('keydown', ' ');
  assert.equal(note.hidden, false);
});

test('a word with no explanation is plain text: no dotted term (existing behaviour)', () => {
  const nodes = renderInline('Use a worktree here.', { label: () => null }) as Array<FakeElement | FakeText>;
  assert.ok(nodes.every((n) => n instanceof FakeText));
});

test('the goal renders as Markdown when it spans lines, and terms look clickable', () => {
  const overview = readFileSync(new URL('features/overview.js', publicDir), 'utf8');
  assert.match(overview, /goal\.includes\('\\n'\) \? renderMarkdown\(goal, textOptions\) : el\('span', \{\}, renderInline\(goal, textOptions\)\)/);
  assert.match(overview, /pagedBox\(panel\.markMemory\(goalText\(summary\.goal, textOptions\)\), t\('overview\.goal'\)\)/);
  const css = readFileSync(new URL('styles/overview.css', publicDir), 'utf8');
  assert.match(css, /abbr\.mem-abbr \{[^}]*cursor: pointer;/);
  assert.match(css, /\.mem-abbr-note\[hidden\] \{ display: none; \}/);
});
