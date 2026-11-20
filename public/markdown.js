// Minimal Markdown renderer for Engram memories. It builds DOM nodes with
// textContent only (never innerHTML): memory content can hold arbitrary text,
// and this page can type into shells, so markup injection must be impossible.
// Parsing rules live in /memory-text.js: field labels (What, Why…) become labelled
// blocks, long values become lists, paths become code and codes or terms get a tooltip.
import { glossaryEntries, headingKey, parseField, splitEnumeration, splitSentences, tokenize } from '/memory-text.js';

/**
 * Options: { label(key) → string, glossary } where `label` translates `field.what`,
 * `heading.goal`, `code.W`, `term.worktree` and `glossary`, and `glossary` comes from
 * buildGlossary over every memory shown. Without them labels stay as written and no
 * tooltip is added.
 */
function context(options = {}) {
  return { label: options.label ?? (() => null), glossary: options.glossary, seen: new Set() };
}

function segmentNodes(segments, ctx) {
  return segments.map((segment) => {
    if (segment.type === 'text') return document.createTextNode(segment.text);
    if (segment.type === 'code' || segment.type === 'strong') {
      const node = document.createElement(segment.type);
      if (segment.type === 'code') node.textContent = segment.text;
      else node.append(...segmentNodes(segment.children, ctx));
      return node;
    }
    const title = segment.definition ?? ctx.label(segment.key);
    if (!title) return document.createTextNode(segment.text);
    return termNode(segment.text, title);
  });
}

/**
 * A code or term with its explanation: the tooltip on hover, and a note beside it that a click,
 * a tap, Enter or Space shows and hides (Escape hides it), since a tooltip alone never opens on click.
 */
function termNode(text, title) {
  const abbr = document.createElement('abbr');
  abbr.className = 'mem-abbr';
  abbr.title = title;
  abbr.textContent = text;
  abbr.setAttribute('tabindex', '0');
  abbr.setAttribute('role', 'button');
  abbr.setAttribute('aria-expanded', 'false');
  const note = document.createElement('span');
  note.className = 'mem-abbr-note';
  note.textContent = title;
  note.hidden = true;
  const show = (open) => {
    note.hidden = !open;
    abbr.setAttribute('aria-expanded', String(open));
  };
  abbr.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    show(note.hidden);
  });
  abbr.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      show(note.hidden);
    } else if (event.key === 'Escape' && !note.hidden) {
      event.stopPropagation();
      show(false);
    }
  });
  const term = document.createElement('span');
  term.className = 'mem-term';
  term.append(abbr, note);
  return term;
}

function inline(text, ctx) {
  return segmentNodes(tokenize(text, ctx.glossary, ctx.seen), ctx);
}

function block(tag, text, ctx) {
  const node = document.createElement(tag);
  node.append(...inline(text, ctx));
  return node;
}

function bulletList(items, ctx) {
  const list = document.createElement('ul');
  list.className = 'mem-list';
  list.append(...items.map((item) => block('li', item, ctx)));
  return list;
}

/** A value as an intro and a list for an enumeration, a list for 2+ sentences, else a paragraph. */
function valueNodes(text, ctx) {
  const enumeration = splitEnumeration(text);
  if (enumeration) {
    return [
      enumeration.intro ? block('p', enumeration.intro, ctx) : null,
      bulletList(enumeration.items, ctx),
      ...(enumeration.rest ? valueNodes(enumeration.rest, ctx) : []),
    ].filter(Boolean);
  }
  const sentences = splitSentences(text);
  return sentences.length > 1 ? [bulletList(sentences, ctx)] : [block('p', text, ctx)];
}

/** Inline nodes (bold, code, paths, tooltips) for a short text such as a goal. */
export function renderInline(text, options) {
  return inline(String(text ?? ''), context(options));
}

// A list item: its indent, its marker (-, *, +, 1. or 1)) and its text, as leftoff-model.js counts them.
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** A list item with a leading [x] / [ ] task marker: a check or an open box, named for screen readers. */
function itemNode(text, ctx) {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (!task) return block('li', text, ctx);
  const done = task[1] !== ' ';
  const li = block('li', task[2], ctx);
  li.className = done ? 'mem-task is-done' : 'mem-task';
  const mark = document.createElement('span');
  mark.className = 'mem-check';
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', ctx.label(done ? 'task.done' : 'task.open') ?? (done ? 'Done' : 'Open'));
  mark.textContent = done ? '✓' : '○';
  li.prepend(mark);
  return li;
}

/**
 * Adds one list item to `list` ({ stack } of { indent, node } from the outermost list, or null to
 * start one in `host`): a deeper indent opens a list inside the last item, a shallower one closes
 * lists back to the one it belongs to, so sub-items show under their parent.
 */
function listItem(list, host, [, indentText, marker, text], ctx) {
  const indent = indentText.replace(/\t/g, '    ').length;
  const tag = /\d/.test(marker) ? 'ol' : 'ul';
  const stack = list?.stack ?? [];
  while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
  const top = stack[stack.length - 1];
  if (!top || (indent > top.indent && top.node.lastChild)) {
    const node = document.createElement(tag);
    (top ? top.node.lastChild : host).append(node);
    stack.push({ indent, node });
  }
  stack[stack.length - 1].node.append(itemNode(text, ctx));
  return { stack };
}

export function renderMarkdown(source, options) {
  const ctx = context(options);
  const root = document.createElement('div');
  root.className = 'md';
  let list = null;
  let code = null;
  // The value of the current field: its continuation lines go there until a blank line.
  let field = null;
  // Paragraphs under a known session summary heading are formatted like field values.
  let section = null;

  for (const line of String(source ?? '').split('\n')) {
    const host = field ?? root;
    if (line.trimStart().startsWith('```')) {
      if (code) {
        code = null;
      } else {
        code = document.createElement('pre');
        host.append(code);
      }
      list = null;
      continue;
    }
    if (code) {
      code.textContent += (code.textContent ? '\n' : '') + line;
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item) {
      list = listItem(list, host, item, ctx);
      continue;
    }
    list = null;
    if (!line.trim()) {
      field = null;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      field = null;
      section = headingKey(heading[1]);
      const title = section ? ctx.label(`heading.${section}`) : null;
      root.append(title ? Object.assign(document.createElement('h4'), { textContent: title }) : block('h4', heading[1], ctx));
      continue;
    }
    const parsed = parseField(line);
    if (parsed) {
      const label = document.createElement('span');
      label.className = 'mem-label';
      label.textContent = (parsed.key && ctx.label(`field.${parsed.key}`)) || parsed.label;
      field = document.createElement('div');
      field.className = 'mem-value';
      if (parsed.value) field.append(...valueNodes(parsed.value, ctx));
      const wrapper = document.createElement('div');
      wrapper.className = 'mem-field';
      wrapper.append(label, field);
      root.append(wrapper);
      continue;
    }
    if (field || section) host.append(...valueNodes(line, ctx));
    else root.append(block('p', line, ctx));
  }
  return root;
}

/** A collapsible list of the codes and terms of a glossary with their definitions, or null when it is empty. */
export function renderGlossary(options) {
  const ctx = context(options);
  const entries = options.glossary ? glossaryEntries(options.glossary) : [];
  const rows = entries.flatMap((entry) => {
    const definition = entry.definition ?? ctx.label(entry.key);
    if (!definition) return [];
    const term = document.createElement('dt');
    term.textContent = entry.text;
    const meaning = document.createElement('dd');
    meaning.textContent = definition;
    return [term, meaning];
  });
  if (!rows.length) return null;
  const details = document.createElement('details');
  details.className = 'card mem-glossary';
  const summary = document.createElement('summary');
  summary.textContent = ctx.label('glossary') ?? 'Glossary';
  const list = document.createElement('dl');
  list.append(...rows);
  details.append(summary, list);
  return details;
}
