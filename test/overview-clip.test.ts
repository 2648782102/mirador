// The workspace mission clips to about five lines and each
// folder row's next steps to three, with "Ver más" / "Ver menos" only when the text overflows.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../public/i18n.js';
// Namespace import: a rule not built yet fails its own test, not the whole file.
import * as leftoffModel from '../public/leftoff-model.js';

const { CLIP_LINES, clipOverflows, clipToggle } = leftoffModel as any;

const read = (path: string) => readFileSync(path, 'utf8');
const overviewCss = read('public/styles/overview.css');
const overviewJs = read('public/features/overview.js');

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The body of the first top-level function named `name` in overview.js. */
function fn(name: string): string {
  const start = overviewJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} is missing`);
  return overviewJs.slice(start, overviewJs.indexOf('\n}\n', start));
}

test('S6: the mission clips to 5 lines and a folder row\'s next steps to 3', () => {
  assert.deepEqual(CLIP_LINES, { mission: 5, next: 3 });
});

test('S6: the text overflows only beyond a pixel of rounding', () => {
  assert.equal(clipOverflows(200, 98), true);
  assert.equal(clipOverflows(98, 98), false);
  assert.equal(clipOverflows(99, 98), false);
  // A box not laid out yet (hidden panel) never shows the toggle.
  assert.equal(clipOverflows(0, 0), false);
});

test('S6: the toggle shows only when the text overflows, and says what a press does', () => {
  assert.deepEqual(clipToggle(false, true), { hidden: false, expanded: false, clipped: true, label: 'overview.clip.more' });
  assert.deepEqual(clipToggle(true, true), { hidden: false, expanded: true, clipped: false, label: 'overview.clip.less' });
  // Short text: no toggle, no fade, whatever the toggle said before.
  assert.deepEqual(clipToggle(false, false), { hidden: true, expanded: false, clipped: false, label: 'overview.clip.more' });
  assert.deepEqual(clipToggle(true, false), { hidden: true, expanded: false, clipped: false, label: 'overview.clip.more' });
});

test('S6: "Ver más" and "Ver menos" in es and en', () => {
  assert.equal(MESSAGES.es['overview.clip.more'], 'Ver más');
  assert.equal(MESSAGES.es['overview.clip.less'], 'Ver menos');
  assert.equal(MESSAGES.en['overview.clip.more'], 'Show more');
  assert.equal(MESSAGES.en['overview.clip.less'], 'Show less');
});

test('S6: the mission card and each row\'s next steps go through the clip, nothing else is dropped', () => {
  const mission = fn('missionCard');
  assert.match(mission, /clipBlock\(renderMarkdown\(mission\), 'mission'\)/);
  // Editing and the empty-mission path stay.
  for (const needle of ["t('overview.missionEdit')", "t('overview.missionEmpty')", "t('overview.missionWrite')"]) assert.ok(mission.includes(needle), needle);
  const row = fn('rowView');
  assert.match(row, /clipBlock\(panel\.markMemory\(renderMarkdown\(summary\.nextSteps, textOptions\)\), 'next'\)/);
  for (const needle of ["'overview-goal'", "t('overview.nextSteps')", 'summary.excerpt', 'sinceLine(row.leftOff)', 'missingMemory(row, folder)', "t('overview.rootBadge')"]) {
    assert.ok(row.includes(needle), `rowView keeps ${needle}`);
  }
});

test('S6: the toggle is a real button with aria-expanded and aria-controls that never opens the folder', () => {
  const clip = fn('clipBlock');
  assert.match(clip, /el\(\s*'button',\s*\{ type: 'button', class: 'btn sm ghost overview-clip-toggle', 'aria-controls': id, 'aria-expanded': 'false', hidden: true/);
  // A row opens its folder on click: the toggle stops its click there (Enter and Space click a button too).
  assert.match(clip, /e\.stopPropagation\(\)/);
  assert.match(clip, /clipToggle\(/);
  assert.match(clip, /clipOverflows\(box\.scrollHeight, box\.clientHeight\)/);
  assert.match(clip, /toggle\.setAttribute\('aria-expanded', String\(view\.expanded\)\)/);
  assert.match(clip, /CLIP_LINES\[kind\]/);
  // Measured again when the box or its text changes size, and let go once the panel replaces it.
  assert.match(clip, /new ResizeObserver\(/);
  assert.match(clip, /if \(!box\.isConnected\)/);
  assert.ok(overviewJs.includes("from '/leftoff-model.js'"));
});

test('S6: the clip is a max-height in lines with a fade, open shows everything, and only motion is media-gated', () => {
  assert.equal(own(overviewCss, '.overview-clip')['max-height'], 'calc(var(--clip-lines, 3) * 1lh)');
  assert.equal(own(overviewCss, '.overview-clip')['overflow'], 'hidden');
  assert.equal(own(overviewCss, '.overview-clip.open')['max-height'], 'none');
  const fade = own(overviewCss, '.overview-clip.clipped');
  assert.match(fade['mask-image'], /linear-gradient\(to bottom, #000 calc\(100% - 1lh\), transparent\)/);
  assert.equal(fade['-webkit-mask-image'], fade['mask-image']);
  assert.equal(own(overviewCss, '.btn.overview-clip-toggle[hidden]').display, 'none');
  const motion = overviewCss.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/g)?.join('\n') ?? '';
  assert.match(motion, /\.overview-clip-toggle \.icon \{ transition: transform/);
  // Every transition of the clip lives inside the no-preference query.
  const outside = overviewCss.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
  assert.doesNotMatch(outside, /\.overview-clip[^{]*\{[^}]*transition/);
});
