// Pins T5 (S10 credits, S11 credits intro) to the approved
// artboard design/state-filter/01-chips-y-acordeon.html (.credits-dialog and its "Cinematic crawl"
// look): the brand opens the credits; the first time a crawl, the rose and its flash reveal the
// still credits, which stay; later opens are still. The phases live in a pure model.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SYMBOLS } from '../public/icons.js';
import { DICTIONARIES, LANGUAGES, MESSAGES, translate } from '../public/i18n.js';
// Namespace import: a model not built yet fails its own tests, not the whole file.
import * as creditsModel from '../public/features/credits-model.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const { INTRO_MS, creditsStep, CREDITS_TOOLS, CREDITS_THANKS, CREDITS_CONTACTS, ZURAI_LOGOS, ZURAI_SITE, CREDITS_SEEN_PREF } = creditsModel as any;

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const artboard = readArtboard('design/state-filter/01-chips-y-acordeon.html');
const creditsJs = read('public/features/credits.js');
const creditsCss = read('public/styles/credits.css');
const appJs = read('public/app.js');
const page = read('public/index.html');
const server = read('src/server.ts');
const es = (MESSAGES as any).es as Record<string, string>;
const en = (MESSAGES as any).en as Record<string, string>;

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/* ---------- S11: the intro's phases ---------- */

test('S11: the first open plays the crawl; once seen, or with reduced motion, the credits open still', () => {
  assert.deepEqual(creditsStep(null, 'open', { seen: false, reducedMotion: false }), { phase: 'crawl', ms: INTRO_MS.crawl, reveal: false, markSeen: false });
  assert.deepEqual(creditsStep(null, 'open', { seen: true, reducedMotion: false }), { phase: 'done', ms: null, reveal: false, markSeen: true });
  assert.deepEqual(creditsStep(null, 'open', { seen: false, reducedMotion: true }), { phase: 'done', ms: null, reveal: false, markSeen: true });
  assert.equal(CREDITS_SEEN_PREF, 'creditsSeen');
});

test('S11: the crawl (~20 s) gives way to the rose, then its flash, which reveals the still credits and marks them seen', () => {
  assert.equal(INTRO_MS.crawl, 20000);
  const crawl = creditsStep(null, 'open', {});
  const rose = creditsStep(crawl.phase, 'elapsed', {});
  const flash = creditsStep(rose.phase, 'elapsed', {});
  const done = creditsStep(flash.phase, 'elapsed', {});
  assert.deepEqual([crawl.phase, rose.phase, flash.phase, done.phase], ['crawl', 'rose', 'flash', 'done']);
  assert.deepEqual([rose.ms, flash.ms, done.ms], [INTRO_MS.rose, INTRO_MS.flash, null]);
  // The rose grows in 900 ms and its sparkle opens at 1 s, as the artboard's rose-in and flash delay.
  assert.equal(INTRO_MS.rose, 1000);
  assert.ok(INTRO_MS.flash > 0 && INTRO_MS.flash <= 1100, 'the flash ends inside its 1100 ms animation');
  assert.deepEqual([crawl.reveal, rose.reveal, flash.reveal, done.reveal], [false, false, false, true]);
  assert.deepEqual([crawl.markSeen, rose.markSeen, flash.markSeen, done.markSeen], [false, false, false, true]);
  // A late timer over the still credits changes nothing visible.
  assert.equal(creditsStep('done', 'elapsed', {}).phase, 'done');
  assert.equal(creditsStep('done', 'elapsed', {}).reveal, false);
});

test('S11: "Saltar" from any intro phase lands on the still credits, revealed and seen', () => {
  for (const phase of ['crawl', 'rose', 'flash']) {
    assert.deepEqual(creditsStep(phase, 'skip', {}), { phase: 'done', ms: null, reveal: true, markSeen: true }, phase);
  }
});

test('S11: "Repetir la animación" plays the crawl again, except with reduced motion', () => {
  assert.deepEqual(creditsStep('done', 'replay', { seen: true, reducedMotion: false }), { phase: 'crawl', ms: INTRO_MS.crawl, reveal: false, markSeen: false });
  assert.deepEqual(creditsStep('done', 'replay', { seen: true, reducedMotion: true }), { phase: 'done', ms: null, reveal: false, markSeen: true });
});

test('S11: closing mid-intro stops it without marking the credits seen', () => {
  for (const phase of ['crawl', 'rose', 'flash']) {
    assert.deepEqual(creditsStep(phase, 'close', {}), { phase: 'done', ms: null, reveal: false, markSeen: false }, phase);
  }
});

/* ---------- S10: the content ---------- */

const creditKeys = () => [
  ...CREDITS_TOOLS.flatMap((tool: any) => [tool.nameKey, tool.roleKey]),
  ...CREDITS_THANKS.flatMap((entry: any) => [entry.nameKey, entry.orgKey, entry.textKey]),
  ...[...creditsJs.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)].map((m) => m[1]),
  ...[...creditsJs.matchAll(/richText\(\s*'([a-zA-Z0-9.]+)'/g)].map((m) => m[1]),
  ...[...page.matchAll(/data-i18n(?:-label|-title)?="(credits\.[a-zA-Z0-9.]+)"/g)].map((m) => m[1]),
];

test('S10: every credits key exists in es and en, each one is used, and the copy never says Mirador', () => {
  assert.ok('credits' in DICTIONARIES, 'public/i18n/credits.js is registered');
  const keys = creditKeys();
  assert.ok(keys.length > 30, `${keys.length} keys`);
  for (const lang of LANGUAGES) {
    const missing = keys.filter((key) => !((MESSAGES as any)[lang] as Record<string, string>)[key]);
    assert.deepEqual(missing, [], lang);
  }
  const used = new Set(keys);
  const unused = Object.keys((DICTIONARIES as any).credits.es).filter((key) => !used.has(key));
  assert.deepEqual(unused, []);
  for (const lang of LANGUAGES) {
    for (const [key, text] of Object.entries((DICTIONARIES as any).credits[lang] as Record<string, string>)) assert.doesNotMatch(text, /Mirador/, `${lang} ${key}`);
  }
});

// S4 (L12, L13): the author created it; ZURAI is the author's company, not the maker.
// S3: the name is spelled only in the allowed places, so the expected one is package.json `author` without its URL.
test('S10, S4: "Creado por <author>" and the agents together on top, then the ZURAI block: "Fundador de ZURAI — zurai.cl", its pitch and mail', () => {
  const author = String(JSON.parse(read('package.json')).author).replace(/ \(https:\/\/github\.com\/mata-2p\)$/, '');
  assert.match(author, /^\S+ \S+$/u, 'package.json author is a first name and a surname, then the profile URL');
  assert.equal(es['credits.by.name'], author);
  assert.equal(en['credits.by.name'], author);
  const name = es['credits.by.name'];
  assert.equal(translate('es', 'credits.by.created', { name }), `Creado por ${author}`);
  assert.equal(translate('en', 'credits.by.created', { name }), `Created by ${author}`);
  assert.equal(translate('es', 'credits.by.founder', { site: ZURAI_SITE.text }), 'Fundador de ZURAI — zurai.cl');
  assert.equal(translate('en', 'credits.by.founder', { site: ZURAI_SITE.text }), 'Founder of ZURAI — zurai.cl');
  assert.equal(es['credits.by.agents'], 'Con agentes de código como compañeros de obra, que también ayudaron a escribirlo.');
  assert.equal(en['credits.by.agents'], 'With coding agents as fellow builders, who also helped write it.');
  // The name is the one {name}, in bold; zurai.cl is a link opening outside the app window.
  assert.match(creditsJs, /richText\('credits\.by\.created', \{ name: el\('b', \{\}, t\('credits\.by\.name'\)\) \}\)/);
  assert.deepEqual(ZURAI_SITE, { href: 'https://zurai.cl', text: 'zurai.cl' });
  assert.match(creditsJs, /richText\('credits\.by\.founder', \{ site: el\('a', \{ href: ZURAI_SITE\.href, target: '_blank', rel: 'noopener' \}, ZURAI_SITE\.text\) \}\)/);
  // L14 reorder: created, the agents, then ZURAI: the founder line with the logo beside it, the pitch, the mail.
  const byJs = creditsJs.slice(creditsJs.indexOf('function by()'), creditsJs.indexOf('function sections('));
  const order = ['credits.by.created', 'credits.by.agents', 'credits.by.founder', 'credits.maker.pitch', 'CREDITS_CONTACTS.flatMap'].map((needle) => byJs.indexOf(needle));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), `order ${order}`);
  // Two groups: the authorship pair on top, the ZURAI block below it, each in its own element.
  const classes = [...byJs.matchAll(/class: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(classes, ['credits-who', 'credits-authorship', 'credits-by', 'credits-agents', 'credits-zurai', 'credits-founder', 'maker-pitch', 'maker-links']);
  assert.match(byJs, /'div',\s*\{ class: 'credits-authorship' \},\s*el\('p', \{ class: 'credits-by' \}[^\n]*\n\s*el\('p', \{ class: 'credits-agents' \}, t\('credits\.by\.agents'\)\),\s*\)/);
  assert.match(byJs, /el\(\s*'p',\s*\{ class: 'credits-founder' \},\s*ZURAI_LOGOS\.map\(/);
  // A clear separation between the two groups, in the still credits and in the crawl.
  assert.ok(own(creditsCss, '.credits-zurai')['border-top'], 'the ZURAI block has a rule above it');
  assert.ok(own(creditsCss, '.credits-zurai')['padding-top'], 'and room under that rule');
  assert.ok(own(creditsCss, '.crawl-text .credits-zurai')['border-top-color'], 'the rule is neon in the crawl');
  // No "Hecho por": ZURAI is not presented as the maker.
  for (const dict of [es, en]) {
    assert.equal(dict['credits.maker.label'], undefined);
    assert.equal(dict['credits.by.text'], undefined);
  }
  assert.doesNotMatch(creditsJs, /maker\.label|maker-label|Hecho por/);
  assert.doesNotMatch(creditsCss, /maker-label/);
});

test('S10: the tagline and the section headings are the artboard ones', { skip: NO_DESIGN }, () => {
  assert.equal(es['credits.tagline'], artboard.match(/<h2 id="credits-title">gentle-deck<\/h2>\s*<p>([^<]+)<\/p>/)![1]);
  for (const [key, heading] of [['credits.by.heading', 'cr-by'], ['credits.tools.heading', 'cr-tools'], ['credits.thanks.heading', 'cr-thanks']]) {
    assert.equal(es[key], artboard.match(new RegExp(`<h3 id="${heading}">([^<]+)</h3>`))![1], key);
  }
});

test('S10: the tools are the artboard list, in order, each with its one-line role', { skip: NO_DESIGN }, () => {
  const drawn = [...artboard.matchAll(/<li><b>([^<]+)<\/b><span>([^<]+)<\/span><\/li>/g)].map((m) => [m[1], m[2]]);
  assert.equal(drawn.length, 7);
  assert.deepEqual(CREDITS_TOOLS.map((tool: any) => [es[tool.nameKey], es[tool.roleKey]]), drawn);
  assert.deepEqual(CREDITS_TOOLS.map((tool: any) => en[tool.nameKey]), ['Node.js and TypeScript', 'xterm.js', 'node-pty', 'ws', 'Engram', 'gentle-shell and Pi', 'Chromium app mode and systemd']);
});

test('S10: the thanks open with Alan Buscaglia (Gentleman Programming), highlighted, then Mario Zechner, the xterm.js team and Jesse Duffield (lazygit)', { skip: NO_DESIGN }, () => {
  const drawn = [...artboard.matchAll(/<li><p class="who"><b>([^<]+)<\/b><span class="org">([^<]+)<\/span><\/p><p>([^<]+)<\/p><\/li>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(CREDITS_THANKS.map((entry: any) => [es[entry.nameKey], es[entry.orgKey], es[entry.textKey]]), drawn);
  assert.equal(es[CREDITS_THANKS[0].nameKey], 'Alan Buscaglia');
  assert.equal(es[CREDITS_THANKS[0].orgKey], 'Gentleman Programming');
  assert.deepEqual(CREDITS_THANKS.map((entry: any) => !!entry.featured), [true, false, false, false]);
  assert.deepEqual(CREDITS_THANKS.map((entry: any) => en[entry.nameKey]), ['Alan Buscaglia', 'Mario Zechner', 'The xterm.js team', 'Jesse Duffield']);
  assert.equal(es['credits.thanks.lazygit.org'], 'lazygit');
  assert.equal(es['credits.foot'], artboard.match(/<p class="credits-foot">([^<]+)<\/p>/)![1]);
  // The highlight is the rose rail of the artboard.
  assert.deepEqual(own(creditsCss, '.credits-thanks li.featured'), { 'border-color': 'var(--rose)', 'box-shadow': 'inset 3px 0 0 var(--rose)' });
});

test('S10, S4: under the founder line, ZURAI\'s pitch and its mail, each link opening outside the app window', () => {
  assert.equal(es['credits.maker.pitch'], '¿Tienes un proyecto en mente? Hablemos.');
  assert.equal(en['credits.maker.pitch'], 'Have a project in mind? Let’s talk.');
  // zurai.cl is already the founder line's link (ZURAI_SITE).
  assert.deepEqual(CREDITS_CONTACTS, [{ href: 'mailto:contacto@zurai.cl', text: 'contacto@zurai.cl' }]);
  assert.match(creditsJs, /el\('a', \{ href: contact\.href, target: '_blank', rel: 'noopener' \}, contact\.text\)/);
});

test('S10, S4: the ZURAI logo is the official file, principal on light and negativo on dark and in the crawl, small: the manual\'s 100px minimum', () => {
  assert.deepEqual(ZURAI_LOGOS, [
    { src: '/brand/zurai-logo-principal.svg', tone: 'on-light' },
    { src: '/brand/zurai-logo-negativo.svg', tone: 'on-dark' },
  ]);
  assert.match(read('public/brand/zurai-logo-principal.svg'), /^<svg [^>]*viewBox="328\.87 136\.8 725\.91 249\.05"[\s\S]*fill="#0E0F1A"/);
  assert.match(read('public/brand/zurai-logo-negativo.svg'), /^<svg [^>]*viewBox="328\.87 136\.8 725\.91 249\.05"[\s\S]*fill="#F6F4EF"/);
  // public/ is served as is, and an .svg as an image.
  assert.match(server, /'\.svg': 'image\/svg\+xml'/);
  // Beside "Fundador de ZURAI", which already names it: decorative, so alt="".
  assert.match(creditsJs, /el\('img', \{ class: `zurai-logo \$\{logo\.tone\}`, src: logo\.src, alt: '', width: '100', height: '34' \}\)/);
  assert.equal(own(creditsCss, '.zurai-logo').width, '100px');
  assert.equal(own(creditsCss, '.zurai-logo.on-dark').display, 'none');
  assert.equal(own(creditsCss, ':root:is([data-theme="dark"], [data-theme="gentleman"]) .zurai-logo.on-light').display, 'none');
  assert.equal(own(creditsCss, ':root:is([data-theme="dark"], [data-theme="gentleman"]) .zurai-logo.on-dark').display, 'block');
  assert.equal(own(creditsCss, '.crawl-text .zurai-logo.on-light').display, 'none');
  assert.equal(own(creditsCss, '.crawl-text .zurai-logo.on-dark').display, 'block');
  // The manual allows no effects on the logo.
  assert.doesNotMatch(creditsCss, /zurai-logo[^{]*\{[^}]*filter/);
});

test('S10, S4 (L16): the ZURAI logo sits on its own line above the founder line, at its 100px', () => {
  // Chosen from the screenshots (L16): the stacked layout is the only one, no modifier.
  assert.doesNotMatch(creditsJs + creditsCss, /logo-own-line/);
  const founder = own(creditsCss, '.credits-founder');
  assert.equal(founder.display, 'flex');
  assert.equal(founder['flex-direction'], 'column');
  assert.equal(founder['align-items'], 'flex-start');
  // The logo comes first in the line, then the founder text.
  assert.match(creditsJs, /\{ class: 'credits-founder' \},\s*ZURAI_LOGOS\.map\([^\n]*\),\s*el\('span', \{\}, richText\('credits\.by\.founder'/);
  // In the crawl the column stays centered, like the rest of the crawl text; the logo keeps its 100px.
  assert.equal(own(creditsCss, '.crawl-text .credits-founder')['align-items'], 'center');
  assert.doesNotMatch(creditsCss, /credits-founder[^{]*\{[^}]*\bwidth/);
});

test('S10 (L16): the crawl gets only nodes from sections(), so it never prints "null"', () => {
  // replaceChildren() turns a null argument into the text "null"; the crawl spreads sections(false).
  assert.match(creditsJs, /crawlText\.replaceChildren\([\s\S]*?\.\.\.sections\(false\)/);
  const body = creditsJs.slice(creditsJs.indexOf('function sections('), creditsJs.indexOf('export function openCredits'));
  assert.ok(body.length > 0, 'sections() is in credits.js');
  assert.doesNotMatch(body, /:\s*null,?\s*\n\s*el\('p', \{ class: 'credits-foot' \}/, 'no null entry in the list sections() returns');
  assert.doesNotMatch(body, /\?\s*section\([\s\S]*?\)\s*:\s*null/, 'an absent section is left out, never null');
  // The fine print stays out of the crawl: the logos section only with ids.
  assert.match(body, /\.\.\.\(ids\s*\?\s*\[\s*section\(\s*'logos'/);
});

/* ---------- S10: the brand opens the credits ---------- */

test('S10: the topbar brand is a button with an accessible name that opens the credits dialog', () => {
  assert.doesNotMatch(page, /<div class="brand">/);
  assert.match(page, /<header class="topbar">[\s\S]*?<button type="button" class="brand" id="credits-open" translate="no" aria-haspopup="dialog" data-i18n-label="credits.open" data-i18n-title="credits.open"><svg class="icon" aria-hidden="true" focusable="false"><use href="#i-mark"\/><\/svg>Mirador<\/button>/);
  // The brand fills in from brandOf() (T10, L12): Mirador in every mode.
  assert.equal(translate('es', 'credits.open'), 'Créditos de Mirador');
  assert.equal(translate('en', 'credits.open'), 'Mirador credits');
  assert.match(page, /<link rel="stylesheet" href="\/styles\/credits\.css">/);
  assert.match(appJs, /import \* as credits from '\/features\/credits\.js';/);
  assert.match(appJs, /\n  credits,\n/);
  assert.match(creditsJs, /\$\('#credits-open'\)\.addEventListener\('click', \(\) => openCredits\(\)\)/);
  const brand = own(creditsCss, 'button.brand');
  for (const [name, value] of Object.entries({ border: '0', background: 'none', cursor: 'pointer', color: 'inherit' })) assert.equal(brand[name], value, name);
  assert.ok(own(creditsCss, 'button.brand:hover').background);
});

test('S10, S11: the credits use the shared modal, the rose symbol, the seen pref and reduced motion', () => {
  assert.match(creditsJs, /import \{ openDialog \} from '\/dialog\.js';/);
  assert.match(creditsJs, /openDialog\(\{/);
  assert.match(creditsJs, /className: 'credits-dialog'/);
  assert.match(creditsJs, /icon\('rose'\)/);
  assert.ok('rose' in (SYMBOLS as Record<string, unknown>));
  assert.match(creditsJs, /prefs\.read\(CREDITS_SEEN_PREF, false\)/);
  assert.match(creditsJs, /prefs\.write\(CREDITS_SEEN_PREF, true\)/);
  assert.match(creditsJs, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  // Closing mid-intro clears the pending phase timer.
  assert.match(creditsJs, /clearTimeout\(timer\)/);
  assert.match(creditsJs, /t\('credits\.skip'\)/);
  assert.match(creditsJs, /t\('credits\.replay'\)/);
  assert.equal(es['credits.skip'], 'Saltar');
  assert.equal(es['credits.replay'], 'Repetir la animación');
  // The stage is decoration: hidden from assistive technology and out of the tab order.
  assert.match(creditsJs, /class: 'credits-stage', 'aria-hidden': 'true', inert: true/);
});

test('S11: the crawl, the starry night, the rose, its flash and the reveal are the artboard keyframes, and reduced motion stills them', { skip: NO_DESIGN }, () => {
  for (const name of ['crawl', 'twinkle', 'rose-in', 'flash', 'reveal']) assert.match(creditsCss, new RegExp(`@keyframes ${name} \\{`), name);
  assert.match(creditsCss, /@keyframes crawl \{ from \{ transform: rotateX\(22deg\) translateY\(var\(--crawl-from, 600px\)\); \} to \{ transform: rotateX\(22deg\) translateY\(calc\(-100% - 60px\)\); \} \}/);
  assert.deepEqual(own(creditsCss, '.crawl'), own(artboard, '.crawl'));
  assert.equal(own(creditsCss, '.credits-dialog[data-phase="crawl"] .crawl-text').animation, 'crawl var(--crawl-ms, 20s) linear forwards');
  assert.equal(own(creditsCss, '.rose-big').color, 'var(--rose)');
  assert.equal(own(creditsCss, '.credits-stage')['--rose'], '#ff76c3');
  assert.match(creditsCss, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.credits-replay \{ display: none; \}/);
  assert.match(creditsCss, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.credits-stage::after \{ animation: none; \}/);
});
