// Pins T4 (S9 the help guide) to the approved artboard
// design/state-filter/01-chips-y-acordeon.html (.help-dialog): an Ajustes row "Ayuda" with a text
// button "Abrir la guía", the "?" key outside text fields and terminals, and a modal with a left nav
// whose counts come from the guide's data.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SYMBOLS } from '../public/icons.js';
import { DICTIONARIES, LANGUAGES, MESSAGES, translate } from '../public/i18n.js';
import { SETTINGS_ROWS } from '../public/settings-model.js';
import { STATES } from '../public/features/sidebar-status-model.js';
// Namespace import: a model not built yet fails its own tests, not the whole file.
import * as helpModel from '../public/features/help-model.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const { HELP_SECTIONS, opensGuide } = helpModel as any;

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const artboard = readArtboard('design/state-filter/01-chips-y-acordeon.html');
const sprite = readArtboard('design/mirador-theme/03-papel-y-tinta.html');
const helpJs = read('public/features/help.js');
const helpCss = read('public/styles/help.css');
const settingsJs = read('public/features/settings.js');
const appJs = read('public/app.js');
const page = read('public/index.html');
const es = (MESSAGES as any).es as Record<string, string>;
const en = (MESSAGES as any).en as Record<string, string>;

type Shape = [string, Record<string, string>];
const symbols = SYMBOLS as Record<string, Shape[]>;
const markup = (shapes: Shape[]) => shapes.map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('');
const drawn = (source: string) => new Map([...source.matchAll(/<symbol id="i-([a-z-]+)" viewBox="0 0 24 24">(.*?)<\/symbol>/g)].map((m) => [m[1], m[2]]));

/** Every value of a field named `field`, or matching `field` when it is a RegExp, anywhere in `value`. */
function collect(value: unknown, field: RegExp, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach((item) => collect(item, field, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (field.test(key)) out.push(inner);
      else collect(inner, field, out);
    }
  }
  return out;
}

const section = (id: string) => (HELP_SECTIONS as any[]).find((s) => s.id === id);

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/* ---------- The guide's content ---------- */

test('S9: the nav has Estados, Íconos, Paneles and Atajos, each counting the entries the real app has', () => {
  assert.deepEqual(HELP_SECTIONS.map((s: any) => s.id), ['states', 'icons', 'panels', 'keys']);
  assert.deepEqual(HELP_SECTIONS.map((s: any) => es[s.key]), ['Estados', 'Íconos', 'Paneles', 'Atajos']);
  assert.deepEqual(HELP_SECTIONS.map((s: any) => en[s.key]), ['States', 'Icons', 'Panels', 'Shortcuts']);
  assert.deepEqual(HELP_SECTIONS.map((s: any) => s.entries.length), [5, 10, 8, 11]);
  // The nav icons of the artboard.
  assert.deepEqual(HELP_SECTIONS.map((s: any) => s.icon), ['work', 'mark', 'panel', 'terminal']);
});

test('S9: the states are the five the state filter names, in its order, each with what it means and what you do', () => {
  const states = section('states').entries;
  assert.deepEqual(states.map((e: any) => e.state), STATES);
  assert.deepEqual(states.map((e: any) => es[e.nameKey]), ['Trabajando', 'Esperándote', 'Terminó', 'Dormidos', 'Error']);
  assert.deepEqual(states.map((e: any) => e.icon), ['work', 'wait', 'check', 'sleep', 'error']);
  for (const entry of states) {
    assert.ok(es[entry.whatKey] && es[entry.doKey], entry.state);
  }
  assert.equal(es['help.state.doLabel'], 'Qué haces');
});

test('S9: the icon tiles are the row and pane buttons the app shows, in the artboard order', () => {
  const icons = section('icons').entries;
  assert.deepEqual(icons.map((e: any) => e.icon), ['git', 'rose', 'terminal', 'delegate', 'files', 'plug', 'filter', 'grip', 'more', 'sereno']);
  assert.deepEqual(icons.map((e: any) => es[e.titleKey]), ['Repositorio git', 'gentle-shell', 'bash', 'Delegar', 'Archivos', 'Servidores MCP', 'Filtrar', 'Arrastrar', 'Más acciones', 'Sereno']);
  assert.equal(icons.find((e: any) => e.icon === 'rose').tone, 'rose');
  assert.equal(icons.find((e: any) => e.icon === 'sereno').tone, 'accent');
});

test('S8, S9: Piloto automático is the featured panel: Sereno does it, with one thing it does and the limits it never crosses', () => {
  const panels = section('panels').entries;
  assert.equal(panels[0].id, 'autopilot');
  assert.equal(panels[0].featured, true);
  assert.equal(panels[0].icon, 'sereno');
  assert.equal(es[panels[0].titleKey], 'Piloto automático');
  assert.match(translate('es', panels[0].textKey), /^Sereno, el agente de Mirador, toma el turno mientras no estás/);
  assert.deepEqual(panels[0].limits.map((l: any) => l.ok), [true, false, false, false]);
  assert.match(es[panels[0].limits[1].key], /secretos, archivos \.env, tokens/);
  assert.equal(panels.filter((p: any) => p.featured).length, 1);
  assert.deepEqual(panels.map((p: any) => es[p.titleKey]), ['Piloto automático', 'Te esperan', 'Dónde quedó', 'Día', 'Seguimiento', 'Filtro por estado', 'Pestañas y cuadrícula', 'Carpeta sin memoria']);
  // The folder badge reads as in the tree.
  assert.equal(panels.at(-1).badgeKey, 'tree.noMemory');
});

test('S9: the shortcuts are the keyboard handlers the code has, "?" included, drawn as keycaps', () => {
  const keys = section('keys').entries;
  assert.deepEqual(keys.map((e: any) => e.keys), [
    ['Alt', 'Shift', ['←', '→']],
    [['←', '→']],
    [['←', '→']],
    ['Enter'],
    [['←', '→']],
    [['↑', '↓']],
    ['F2'],
    [['↑', '↓']],
    ['Ctrl', 'S'],
    ['Esc'],
    ['?'],
  ]);
  assert.equal(es[keys.at(-1).textKey], 'Abre esta guía.');
  assert.equal(es['help.keys.or'], 'o');
});

test('S9: every icon the guide names is in the app sprite; the help badge is the artboard drawing in both sprites', { skip: NO_DESIGN }, () => {
  const names = new Set(collect(HELP_SECTIONS, /^icon$/).filter((n) => n !== null) as string[]);
  assert.ok(names.size >= 14, 'the guide names its icons');
  for (const name of names) assert.ok(name in symbols, `${name} is not in SYMBOLS`);
  assert.ok('help' in symbols, 'help is not in SYMBOLS');
  assert.equal(markup(symbols.help), drawn(artboard).get('help'));
  assert.equal(drawn(sprite).get('help'), drawn(artboard).get('help'));
});

test('S9: every key the guide uses exists in es and en, its copy uses "tú" and never says Mirador', () => {
  assert.ok('help' in DICTIONARIES, 'public/i18n/help.js is registered');
  const keys = [
    ...(collect(HELP_SECTIONS, /Key$/) as string[]),
    ...(collect(HELP_SECTIONS.map((s: any) => s.entries.flatMap((e: any) => e.limits ?? [])), /^key$/) as string[]),
    ...HELP_SECTIONS.map((s: any) => s.key),
    ...[...helpJs.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)].map((m) => m[1]),
  ];
  assert.ok(keys.length > 60, `${keys.length} keys`);
  for (const lang of LANGUAGES) {
    const missing = keys.filter((key) => !((MESSAGES as any)[lang] as Record<string, string>)[key]);
    assert.deepEqual(missing, [], lang);
  }
  for (const lang of LANGUAGES) {
    for (const [key, text] of Object.entries((DICTIONARIES as any).help[lang] as Record<string, string>)) assert.doesNotMatch(text, /Mirador/, `${lang} ${key}`);
  }
  assert.equal(es['help.open'], 'Abrir la guía');
  assert.equal(en['help.open'], 'Open the guide');
  // The name comes through {brand}, so no help string writes it out.
  assert.equal(es['help.title'], 'Guía de {brand}');
  assert.equal(translate('es', 'help.title'), 'Guía de Mirador');
  assert.doesNotMatch(Object.values((DICTIONARIES as any).help.es).join(' '), /\busted\b/i);
});

/* ---------- The "?" key ---------- */

test('S9: "?" opens the guide only outside text fields and terminals, with no other dialog open', () => {
  const base = { key: '?', ctrlKey: false, metaKey: false, altKey: false, composing: false, defaultPrevented: false, typing: false, inTerminal: false, dialogOpen: false };
  assert.equal(opensGuide(base), true);
  assert.equal(opensGuide({ ...base, typing: true }), false, 'an input, a textarea or a contenteditable keeps its "?"');
  assert.equal(opensGuide({ ...base, inTerminal: true }), false, 'a terminal keeps its "?"');
  assert.equal(opensGuide({ ...base, dialogOpen: true }), false, 'not over another dialog');
  assert.equal(opensGuide({ ...base, ctrlKey: true }), false);
  assert.equal(opensGuide({ ...base, metaKey: true }), false);
  assert.equal(opensGuide({ ...base, altKey: true }), false);
  assert.equal(opensGuide({ ...base, composing: true }), false);
  assert.equal(opensGuide({ ...base, defaultPrevented: true }), false);
  assert.equal(opensGuide({ ...base, key: '/' }), false);
});

test('S9: the key guard reads text fields, contenteditable and xterm ancestors from the event target', () => {
  assert.match(helpJs, /isContentEditable/);
  assert.match(helpJs, /INPUT\|TEXTAREA\|SELECT/);
  assert.match(helpJs, /closest\?\.\('\.xterm'\)/);
  assert.match(helpJs, /dialog\[open\]/);
  assert.match(helpJs, /document\.addEventListener\('keydown'/);
});

/* ---------- The dialog and its wiring ---------- */

test('S9: the guide uses the shared dialog helper (focus trap, Escape, focus back), draws icons with icon() and no new SVG', () => {
  assert.match(helpJs, /import \{ openDialog \} from '\/dialog\.js';/);
  assert.match(helpJs, /openDialog\(\{/);
  assert.match(helpJs, /className: 'help-dialog'/);
  assert.doesNotMatch(helpJs, /showModal|el\('dialog'|createElement\('dialog'\)/);
  assert.match(helpJs, /import \{ icon \} from '\/icons\.js';/);
  assert.doesNotMatch(helpJs, /createElementNS|<path|<svg/);
  // Nav buttons say which section shows; counts come from the data.
  assert.match(helpJs, /'aria-pressed'/);
  assert.match(helpJs, /section\.entries\.length/);
});

test('S9: the Ajustes row "Ayuda" is last, with a text button "Abrir la guía" announcing Shift+? and no "?" keycap', () => {
  const row = SETTINGS_ROWS.at(-1) as any;
  assert.equal(row.id, 'help');
  assert.equal(es[row.key], 'Ayuda');
  assert.equal(en[row.key], 'Help');
  assert.equal(row.icon, 'help');
  assert.equal(row.control, 'button');
  assert.equal(row.buttonKey, 'help.open');
  assert.equal(row.shortcut, 'Shift+?');
  assert.match(settingsJs, /'aria-keyshortcuts': row\.shortcut/);
  assert.match(settingsJs, /class: 'btn sm'/);
  assert.match(settingsJs, /onclick: \(\) => openGuide\(\)/);
  assert.doesNotMatch(settingsJs, /el\('kbd'/);
});

test('S9: the feature is wired like the others: module, stylesheet and dictionary', () => {
  assert.match(appJs, /import \* as help from '\/features\/help\.js';/);
  assert.match(appJs, /\n\s+help,\n/);
  assert.match(page, /<link rel="stylesheet" href="\/styles\/help\.css">/);
});

test('S6, S9: the guide stays inside the window: fixed box, its body scrolls, tiles and keys never force a width', () => {
  assert.equal(own(helpCss, '.dialog.help-dialog').width, 'min(860px, calc(100vw - 32px))');
  assert.equal(own(helpCss, '.dialog.help-dialog').height, 'min(640px, calc(100vh - 48px))');
  assert.equal(own(helpCss, '.help-dialog[open]').display, 'flex');
  assert.equal(own(helpCss, '.help-body')['overflow'], 'auto');
  assert.equal(own(helpCss, '.help-body')['min-height'], '0');
  assert.equal(own(helpCss, '.h-tiles')['grid-template-columns'], 'repeat(auto-fill, minmax(min(250px, 100%), 1fr))');
  assert.match(own(helpCss, '.h-key')['grid-template-columns'], /minmax\(0, 1fr\)$/);
  assert.equal(own(helpCss, '.h-state')['border-left'], '3px solid var(--s)');
  assert.equal(own(helpCss, '.h-panel.featured')['border-color'], 'var(--accent)');
});

/* ---------- Preserved ---------- */

test('S4 (theme feature) preserved: the four existing Ajustes rows keep their ids, order, names, icons and controls', () => {
  assert.deepEqual(SETTINGS_ROWS.slice(0, 4).map((row: any) => [row.id, es[row.key], row.icon, row.control]), [
    ['night', 'Piloto automático', 'sereno', 'switch'],
    ['layout', 'Terminales', 'terminal', 'choices'],
    ['theme', 'Tema', 'sun', 'choices'],
    ['language', 'Idioma', null, 'choices'],
  ]);
  for (const row of SETTINGS_ROWS.slice(0, 4) as any[]) assert.equal(row.shortcut, undefined, row.id);
});
