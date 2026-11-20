// Inline SVG charts for the tracking view (public/features/tracking.js), built with
// DOM nodes: no library and no innerHTML. Callers pass translated text and the
// shapes of public/charts-model.js; each SVG is role="img" with an aria-label that
// says in words what it draws. Colors come from the CSS variables in tracking.css.
import { el } from '/core.js';

const NS = 'http://www.w3.org/2000/svg';
const ROW = 22;
const LABEL_CHARS = 22;

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const percent = (fraction) => `${(fraction * 100).toFixed(2)}%`;
const shorten = (text) => (text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text);

/**
 * One horizontal stacked bar and its legend.
 * `slices`: [{ key, share, offset, legend }] (share and offset as fractions; `key`
 * picks the color through data-key; `legend` is the visible text of that slice).
 */
export function stackedBar({ label, slices }) {
  return el(
    'div',
    { class: 'chart' },
    svg(
      'svg',
      { class: 'chart-stack', role: 'img', 'aria-label': label, width: '100%', height: 14 },
      svg('rect', { class: 'chart-track', x: 0, y: 0, width: '100%', height: 14, rx: 4 }),
      ...slices
        .filter((slice) => slice.share > 0)
        .map((slice) => svg('rect', { class: 'chart-fill', 'data-key': slice.key, x: percent(slice.offset), y: 0, width: percent(slice.share), height: 14 })),
    ),
    el(
      'ul',
      { class: 'chart-legend' },
      ...slices.map((slice) => el('li', {}, el('span', { class: 'chart-swatch', 'data-key': slice.key, 'aria-hidden': 'true' }), slice.legend)),
    ),
  );
}

/**
 * Horizontal bars, one row each: name, bar and value.
 * `rows`: [{ name, share, value, muted }] (`share` relative to the longest bar;
 * `muted` draws the bar in the secondary color, as for "others").
 */
export function barChart({ label, rows }) {
  const height = rows.length * ROW;
  return el(
    'div',
    { class: 'chart' },
    svg(
      'svg',
      { class: 'chart-bars', role: 'img', 'aria-label': label, width: '100%', height },
      ...rows.map((row, index) => {
        const y = index * ROW;
        return svg(
          'g',
          {},
          svg('text', { class: 'chart-label', x: 0, y: y + 15 }, svg('title', {}, row.name), shorten(row.name)),
          svg('rect', { class: 'chart-track', x: '42%', y: y + 5, width: '46%', height: 12, rx: 3 }),
          row.share > 0 ? svg('rect', { class: `chart-bar${row.muted ? ' muted' : ''}`, x: '42%', y: y + 5, width: percent(row.share * 0.46), height: 12, rx: 3 }) : null,
          svg('text', { class: 'chart-value', x: '100%', y: y + 15, 'text-anchor': 'end' }, String(row.value)),
        );
      }),
    ),
  );
}

/**
 * Vertical columns, one per slot (the 24 hours of a day), with tick labels below.
 * `columns`: [{ share, title, peak }] (`share` relative to the tallest column;
 * `title` is the tooltip text; `peak` draws it in the warm color);
 * `ticks`: [{ index, text }] (labels under some columns).
 */
export function columnChart({ label, columns, ticks = [] }) {
  const PLOT = 64;
  const slot = 100 / columns.length;
  const middle = (index) => `${(index + 0.5) * slot}%`;
  return el(
    'div',
    { class: 'chart' },
    svg(
      'svg',
      { class: 'chart-columns', role: 'img', 'aria-label': label, width: '100%', height: PLOT + 18 },
      svg('line', { class: 'chart-axis', x1: 0, x2: '100%', y1: PLOT + 0.5, y2: PLOT + 0.5 }),
      ...columns.map((column, index) => {
        const height = Math.max(column.share > 0 ? 2 : 0, Math.round(column.share * PLOT));
        return svg(
          'g',
          {},
          svg('title', {}, column.title),
          // A full-height transparent hit area, so the tooltip works on empty hours too.
          svg('rect', { class: 'chart-hit', x: percent((index * slot) / 100), y: 0, width: percent(slot / 100), height: PLOT }),
          height ? svg('rect', { class: `chart-column${column.peak ? ' peak' : ''}`, x: percent((index * slot + slot * 0.15) / 100), y: PLOT - height, width: percent((slot * 0.7) / 100), height, rx: 2 }) : null,
        );
      }),
      ...ticks.map((tick) => svg('text', { class: 'chart-value', x: middle(tick.index), y: PLOT + 14, 'text-anchor': 'middle' }, tick.text)),
    ),
  );
}
