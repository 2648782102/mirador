// The app's one icon set: the symbols of the design,
// 24×24, drawn with a 1.75 stroke, round caps and
// joins and currentColor (the .icon rule in styles.css), so each icon takes the color of its
// state or text. injectSprite() puts them in the page once; icon(name) returns an <svg> that
// uses one. Built with createElementNS only, never HTML. DOM-free until called, so
// test/icons.test.ts imports it in Node.

export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * name → the shapes of its <symbol>, as [tag, attributes], copied from the design. Only the
 * icons the app shows, plus mark, sliders and sun for the brand (and the credits) and the settings sheet, the
 * gentle-shell rose, Sereno's owl (a whole owl with ear tufts, big eyes and a beak, perched on the rose's
 * stem with its leaves and spark; option 2b), the state filter's funnel and the help guide's badge.
 */
export const SYMBOLS = {
  'chev-down': [['path', { d: 'M6 9l6 6 6-6' }]],
  'chev-right': [['path', { d: 'M9 6l6 6-6 6' }]],
  'chevs-left': [['path', { d: 'M11 17l-5-5 5-5M18 17l-5-5 5-5' }]],
  'chevs-right': [['path', { d: 'M13 17l5-5-5-5M6 17l5-5-5-5' }]],
  work: [['path', { d: 'M3 12h4l3-7 4 14 3-7h4' }]],
  wait: [['path', { d: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9z' }], ['path', { d: 'M10.3 20.5a2 2 0 0 0 3.4 0' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  sleep: [['path', { d: 'M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z' }], ['path', { d: 'M15 3h4l-4 4h4' }]],
  error: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M15 9l-6 6M9 9l6 6' }]],
  sun: [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]],
  close: [['path', { d: 'M18 6L6 18M6 6l12 12' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  more: [['circle', { cx: '5', cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '12', cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '19', cy: '12', r: '1.6', fill: 'currentColor', stroke: 'none' }]],
  grip: [['circle', { cx: '9', cy: '6', r: '1.4', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '15', cy: '6', r: '1.4', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '9', cy: '12', r: '1.4', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '15', cy: '12', r: '1.4', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '9', cy: '18', r: '1.4', fill: 'currentColor', stroke: 'none' }], ['circle', { cx: '15', cy: '18', r: '1.4', fill: 'currentColor', stroke: 'none' }]],
  terminal: [['path', { d: 'M4 17l6-5-6-5M12 19h8' }]],
  delegate: [['path', { d: 'M7 17L17 7M8 7h9v9' }]],
  pencil: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4' }]],
  files: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  plug: [['path', { d: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5' }]],
  mark: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '3' }], ['path', { d: 'M12 4v16M6.5 10l2 2-2 2' }], ['path', { d: 'M14.5 14h3', stroke: 'var(--accent)', 'stroke-width': '2.25' }]],
  sliders: [['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }], ['circle', { cx: '15', cy: '6', r: '2' }], ['circle', { cx: '9', cy: '12', r: '2' }], ['circle', { cx: '17', cy: '18', r: '2' }]],
  sidebar: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '3' }], ['path', { d: 'M9 4v16' }]],
  panel: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '3' }], ['path', { d: 'M15 4v16' }]],
  git: [['circle', { cx: '6', cy: '18', r: '2.5' }], ['circle', { cx: '18', cy: '6', r: '2.5' }], ['path', { d: 'M6 3v12.5M18 8.5A9 9 0 0 1 9 17.5' }]],
  rose: [['path', { d: 'M7 7c0 4 2 6.5 5 6.5s5-2.5 5-6.5 M7 7C5.6 6.6 4.6 5.6 4.4 4.4c2-.2 3.6.5 4.5 1.8 M17 7c1.4-.4 2.4-1.4 2.6-2.6-2-.2-3.6.5-4.5 1.8 M8.9 6.2C9.4 4.2 10.6 3 12 2.6c1.4.4 2.6 1.6 3.1 3.6 M15.1 6.2c-.2 2.4-1.5 4-3.4 4-1.9 0-3-1.5-2.8-3.1.2-1.5 1.6-2.4 2.9-2 1.1.3 1.6 1.5 1 2.4-.5.7-1.6.6-1.8-.2 M12 13.5c0 2.6-.4 5.2-1.8 7.9 M11.5 17.2c-1.6-1.9-3.9-2.4-6.2-1.4 1.5 1.9 3.8 2.4 6.2 1.4z M11.9 15.7c1.4-1.6 3.4-2 5.4-1.2-1.3 1.6-3.3 2-5.4 1.2z M20.4 10.2v2.4M19.2 11.4h2.4' }]],
  sereno: [['path', { d: 'M7.5 10.8V3.8l2.4 1.8c1.4-.6 2.8-.6 4.2 0l2.4-1.8v7c0 3.1-2 5.4-4.5 5.4s-4.5-2.3-4.5-5.4z M11.4 10.9l.6 1 .6-1 M10 13.6c.6.6 1.3.9 2 .9s1.4-.3 2-.9 M3 18c3.6-.9 7.8-1.2 12.4-1 2 .1 3.7.6 5.1 1.4 M17.6 17.1c.4-1.9 1.9-3 3.9-3-.2 1.9-1.8 3.1-3.9 3z M6.2 17.4c-1.1 1.5-2.8 2.1-4.6 1.6 1-1.4 2.7-2 4.6-1.6z M20.4 3.6v2.4M19.2 4.8h2.4' }], ['circle', { cx: '10.1', cy: '8.6', r: '1.6' }], ['circle', { cx: '13.9', cy: '8.6', r: '1.6' }]],
  filter: [['path', { d: 'M4 5h16l-6.2 7.4V18l-3.6 2v-7.6z' }]],
  help: [['path', { d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.7M12 17.2v.1' }]],
};

/** icon() sizes besides the default --icon (14px): --icon-sm 12px and --icon-md 16px. */
const SIZES = new Set(['sm', 'md']);
const SPRITE_ID = 'icon-sprite';

/** One SVG element `tag` with `attrs` (a var() value goes in its style); public/icons/agents.js builds with it too. */
export function shape(doc, tag, attrs) {
  const node = doc.createElementNS(SVG_NS, tag);
  const style = [];
  for (const [key, value] of Object.entries(attrs)) {
    // Presentation attributes do not resolve var(): a theme color goes in the style instead.
    if (value.startsWith('var(')) style.push(`${key}: ${value}`);
    else node.setAttribute(key, value);
  }
  if (style.length) node.setAttribute('style', style.join('; '));
  return node;
}

/** Adds the hidden sprite with every symbol at the start of the body; a second call does nothing. */
export function injectSprite(doc = document) {
  if (doc.getElementById(SPRITE_ID)) return;
  const sprite = shape(doc, 'svg', { id: SPRITE_ID, width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false' });
  sprite.setAttribute('style', 'position: absolute');
  for (const [name, shapes] of Object.entries(SYMBOLS)) {
    const symbol = shape(doc, 'symbol', { id: `i-${name}`, viewBox: '0 0 24 24' });
    symbol.append(...shapes.map(([tag, attrs]) => shape(doc, tag, attrs)));
    sprite.append(symbol);
  }
  doc.body.prepend(sprite);
}

/**
 * An <svg class="icon"> showing the sprite symbol `name`. Decorative (hidden from assistive
 * technology) unless `label` is given, which makes it an image with that name. `size` 'sm' or
 * 'md' picks --icon-sm or --icon-md instead of --icon.
 */
export function icon(name, options = {}) {
  if (!Object.hasOwn(SYMBOLS, name)) throw new Error(`unknown icon "${name}"`);
  return symbolIcon(`i-${name}`, options);
}

/**
 * icon() for any sprite symbol by its element id, e.g. an agent's in public/icons/agents.js, which
 * keeps its own sprite.
 */
export function symbolIcon(id, { size, label } = {}) {
  if (size !== undefined && !SIZES.has(size)) throw new Error(`unknown icon size "${size}"`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', size ? `icon icon-${size}` : 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}
