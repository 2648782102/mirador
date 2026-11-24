// The phone layout's stylesheet and wiring (#41, option A): public/styles/phone.css only acts under
// the narrow width or a coarse pointer, public/features/phone.js switches the views, and the inbox
// (public/features/inbox.js) reports its stream's state and opens a card's terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const phoneCss = read('public/styles/phone.css');
const inboxJs = read('public/features/inbox.js');
const phoneJs = read('public/features/phone.js');
const page = read('public/index.html');

/** The body of the `@media <query> {` block of `css`, braces matched. */
function media(css: string, query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `@media ${query}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error(`unclosed @media ${query}`);
}

/** Every `selector { declarations }` rule of a flat block, comments dropped: [selectors, declarations]. */
function rules(css: string): Array<[string[], Record<string, string>]> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
    m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
    Object.fromEntries(m[2].split(';').map((d) => d.split(':').map((s) => s.trim())).filter(([k]) => k).map(([k, ...v]) => [k, v.join(':')])),
  ]);
}

/** The declarations every rule naming `selector` sets, merged in order. */
function declared(css: string, selector: string): Record<string, string> {
  const found = rules(css).filter(([selectors]) => selectors.includes(selector));
  assert.ok(found.length, selector);
  return Object.assign({}, ...found.map(([, declarations]) => declarations));
}

/** `css` with its @media blocks taken out. */
function outsideMedia(css: string): string {
  let out = css;
  for (const query of ['(max-width: 600px)', '(pointer: coarse)']) out = out.replace(`@media ${query} {${media(css, query)}}`, '');
  return out;
}

const narrow = media(phoneCss, '(max-width: 600px)');
const coarse = media(phoneCss, '(pointer: coarse)');

test('S3: the inbox header sticks to the top of the inbox view while the cards scroll under it', () => {
  const head = declared(narrow, 'body[data-phone="inbox"] .phone-head');
  assert.equal(head.position, 'sticky');
  assert.equal(head.top, '0');
  assert.ok(head.background, 'opaque, so cards do not show through');
  // The panel is what scrolls in the inbox view, so the header sticks inside it.
  assert.equal(declared(narrow, 'body[data-phone="inbox"] #panel')['overflow-y'], 'auto');
});

test('S4: in the phone layout each card takes the full width, its "open file" under it, in a larger text', () => {
  assert.equal(declared(narrow, '.inbox-item')['flex-direction'], 'column');
  assert.equal(declared(narrow, '.inbox-item')['align-items'], 'stretch');
  assert.equal(declared(narrow, '.inbox-jump')['font-size'], 'var(--fs-read)');
  assert.equal(declared(narrow, '.inbox-reason')['font-size'], 'var(--fs-title)');
  assert.equal(declared(narrow, '.inbox-place')['font-size'], 'var(--fs-ui)');
  assert.equal(declared(narrow, '.inbox-meta')['font-size'], 'var(--fs-ui)');
});

test('S5: on a coarse pointer the card, "open file", the notification toggle and the segment buttons are at least 44×44 CSS px, spaced apart', () => {
  for (const selector of ['.inbox-jump', '.inbox-file', '.inbox-notify-toggle', '.segmented .btn']) {
    const sizes = declared(coarse, selector);
    assert.equal(sizes['min-height'], '44px', `${selector} height`);
    assert.equal(sizes['min-width'], '44px', `${selector} width`);
  }
  // Spaced: no shared edge between segment buttons, and gaps between cards and their file button.
  assert.equal(declared(coarse, '.segmented .btn + .btn')['margin-left'], '4px');
  assert.equal(declared(coarse, '.inbox-list').gap, '8px');
  assert.equal(declared(coarse, '.inbox-item').gap, '8px');
  assert.equal(declared(coarse, '.inbox-notify').gap, '8px');
});

test('#67 S2: in the terminal view a finger on the terminal never pans or bounces the page; the key bar still scrolls sideways', () => {
  for (const selector of ['body[data-phone="terminal"] .pane-body', 'body[data-phone="terminal"] .pane-body *']) {
    const terminal = declared(narrow, selector);
    assert.equal(terminal['touch-action'], 'none', `${selector}: terminals.js scrolls the history itself`);
    assert.equal(terminal['overscroll-behavior'], 'contain', selector);
  }
  assert.equal(declared(narrow, 'body[data-phone="terminal"] .phone-keys')['touch-action'], undefined, 'the key bar keeps its own panning');
  assert.equal(rules(narrow).some(([selectors, declarations]) => declarations['touch-action'] && selectors.some((s) => s.includes('phone-key'))), false);
});

test('S5: a coarse pointer only enlarges and spaces the controls; it never switches the layout', () => {
  for (const [selectors, declarations] of rules(coarse)) {
    for (const property of Object.keys(declarations)) {
      assert.match(property, /^(min-height|min-width|padding|gap|margin-left)$/, `${selectors.join(', ')} sets ${property}`);
    }
    assert.ok(selectors.every((selector) => !/data-phone/.test(selector)), 'no phone view in the coarse block');
  }
});

test('wide layout unchanged: outside its two @media blocks phone.css only hides the phone parts, and it loads last', () => {
  const rest = rules(outsideMedia(phoneCss));
  assert.ok(rest.length >= 1);
  for (const [selectors, declarations] of rest) {
    assert.deepEqual(declarations, { display: 'none' }, selectors.join(', '));
    assert.ok(selectors.every((selector) => selector.startsWith('.phone-')), selectors.join(', '));
  }
  const links = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(links.at(-1), '/styles/phone.css', 'after the stylesheets it overrides');
  // Each phone part in index.html carries a .phone- class, so the rules above hide it on a wide screen.
  for (const id of ['phone-to-inbox', 'phone-inbox-head', 'phone-inbox-foot', 'phone-term-head', 'phone-keys']) {
    assert.match(page, new RegExp(`class="[^"]*\\bphone-[a-z-]+[^"]*" id="${id}"|id="${id}"[^>]*class="[^"]*\\bphone-`), id);
  }
});

test('S3: the inbox reports its stream: "live" once it answers, "reconnecting" before each retry', () => {
  const follow = inboxJs.slice(inboxJs.indexOf('async function follow()'), inboxJs.indexOf('\n}\n', inboxJs.indexOf('async function follow()')));
  assert.match(follow, /delay = 1000;\n\s*setStream\('live'\);/);
  assert.match(follow, /setStream\('reconnecting'\);\n\s*await new Promise\(\(resolve\) => \{\n\s*const id = setTimeout\(resolve, delay\);/);
  assert.match(inboxJs, /emit\('inbox:stream', stream\)/);
  assert.match(phoneJs, /on\('inbox:stream', /);
});

test('S6: a card\'s click activates its terminal (focused only on the desktop) and tells the phone layout to open it', () => {
  assert.match(inboxJs, /onclick: \(\) => openCard\(item\.terminalId\)/);
  const open = inboxJs.slice(inboxJs.indexOf('function openCard('), inboxJs.indexOf('\n}\n', inboxJs.indexOf('function openCard(')));
  assert.match(open, /activateTerminal\(id, !phoneView\);/);
  assert.match(open, /emit\('inbox:open', id\);/);
  assert.match(phoneJs, /on\('inbox:open', /);
  // The key bar types through the terminal's own xterm, in its cursor mode.
  const terminalsJs = read('public/terminals.js');
  const type = terminalsJs.slice(terminalsJs.indexOf('export function typeKey('), terminalsJs.indexOf('\n}\n', terminalsJs.indexOf('export function typeKey(')));
  assert.match(type, /keyBytes\(key, \{ applicationCursor: record\.term\.modes\.applicationCursorKeysMode \}\)/);
  assert.match(type, /record\.term\.input\(bytes, true\)/);
});

test('S2, S9: the phone feature starts after the drawers, and every view switch goes through nextView', () => {
  const app = read('public/app.js');
  assert.match(app, /import \* as phone from '\/features\/phone\.js';/);
  const features = app.slice(app.indexOf('const FEATURES = ['));
  assert.ok(features.indexOf('  phone,') > features.indexOf('  drawers,'), 'after drawers');
  for (const action of ['start', 'resize', 'back', 'inbox', 'full', 'open', 'gone']) assert.match(phoneJs, new RegExp(`go\\('${action}'`), action);
  assert.match(phoneJs, /matchMedia\(PHONE_QUERY\)/, 'the same width as the stylesheet');
});

test('the inbox and terminal views cover Seguimiento: its view is hidden behind them, and the deck keeps it', () => {
  // Seguimiento hides main#layout ([hidden]) and shows section.app-view; the phone views show #layout
  // again (display: flex), so the tracking view must go or it stays under the inbox (#67).
  assert.match(page, /<section class="app-view" data-slot="tracking"/);
  for (const view of ['inbox', 'terminal']) {
    assert.equal(declared(narrow, `body[data-phone="${view}"] > .app-view`).display, 'none', view);
  }
  assert.ok(!rules(narrow).some(([selectors]) => selectors.some((s) => s.includes('"deck"') && s.includes('app-view'))), 'the deck shows Seguimiento as before');
});
