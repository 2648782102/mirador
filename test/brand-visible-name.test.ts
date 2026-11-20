// No visible
// string says "gentle-deck". The product is Mirador in every mode, and the mode that shows the Gentle
// extras reads "modo completo" / "full mode". Internal identifiers keep the name: the
// `mode` config value 'gentle-deck', CSS classes, file names, stored data and locators in
// comments. This test reads every source of visible text: the i18n dictionaries, public/*.html, the
// browser code outside i18n and the server's own strings (doctor lines, notifications, window titles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Browser modules load through a computed URL, so they add no declaration-file errors to the test/ typecheck baseline.
const publicModule = (path: string) => import(new URL(`../public/${path}`, import.meta.url).href);
const { DICTIONARIES, LANGUAGES, translate } = (await publicModule('i18n.js')) as any;
const { BRAND, brandOf } = (await publicModule('mode-model.js')) as any;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OLD_NAME = /gentle-deck/i;

/** Every file under `dir` (relative to the repo) whose name ends with one of `extensions`. */
function files(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...files(rel, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) out.push(rel);
  }
  return out.sort();
}

/**
 * A JS or TS line without its comments: a line that starts a comment (`//`, `/*`, `*`) is dropped,
 * and so is a trailing `//` comment after code or an inline block comment. URLs (`http://`) stay.
 */
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (/^(\/\/|\/\*|\*)/.test(trimmed)) return '';
  return line.replace(/\/\*.*?\*\//g, '').replace(/(^|[\s;,(){}])\/\/.*$/, '$1');
}

/**
 * The files whose code may hold the `mode` config value, as the quoted token 'gentle-deck' or
 * "gentle-deck" and nothing else: modeOf() in the browser, the config schema and its startup
 * warning (which names the valid values) and resolveMode() on the server.
 */
const MODE_VALUE_FILES = new Set(['public/mode-model.js', 'src/config.ts', 'src/mode.ts']);

/** `file:line: text` for each line of code under `dirs` that names gentle-deck outside the mode value. */
function codeHits(dirs: string[]): string[] {
  const hits: string[] = [];
  for (const file of dirs.flatMap((dir) => files(dir, ['.js', '.ts', '.mjs']))) {
    if (file.startsWith('public/i18n/')) continue; // the dictionaries have their own test below
    readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
      let code = codeOf(line);
      if (MODE_VALUE_FILES.has(file)) code = code.replace(/(['"])gentle-deck\1/g, '');
      if (OLD_NAME.test(code)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

test('no i18n string, in any dictionary or language, says gentle-deck, as written or translated', () => {
  const hits: string[] = [];
  for (const [feature, dictionary] of Object.entries(DICTIONARIES as Record<string, Record<string, Record<string, string>>>)) {
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(dictionary[language] ?? {})) {
        if (OLD_NAME.test(text) || OLD_NAME.test(translate(language, key))) hits.push(`${feature} ${language} ${key}: ${text}`);
      }
    }
  }
  assert.deepEqual(hits, [], `${hits.length} visible strings say gentle-deck:\n${hits.join('\n')}`);
});

test('a message that names the app says Mirador, also when the caller passes no brand', () => {
  for (const language of LANGUAGES) {
    assert.equal(translate(language, 'credits.title'), 'Mirador');
    assert.equal(translate(language, 'credits.title', { brand: brandOf({ mode: 'gentle-deck' }) }), 'Mirador');
    assert.match(translate(language, 'help.title'), /Mirador/);
  }
  assert.equal(translate('es', 'inbox.night.deciding'), 'Mirador está decidiendo…');
  assert.equal(translate('en', 'inbox.night.deciding'), 'Mirador is deciding…');
});

test('brandOf() is Mirador in every mode, before the config is read and with an unknown mode', () => {
  assert.equal(BRAND, 'Mirador', 'the one constant the name comes from');
  for (const config of [{ mode: 'gentle-deck' }, { mode: 'plain' }, { mode: 'auto' }, { mode: 'nonsense' }, {}, null, undefined]) {
    assert.equal(brandOf(config), 'Mirador', JSON.stringify(config));
  }
});

test('no page says gentle-deck in its title, its text or its readable attributes', () => {
  const hits: string[] = [];
  for (const file of files('public', ['.html'])) {
    const page = readFileSync(join(ROOT, file), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    const visible = [
      ...[...page.matchAll(/>([^<]+)</g)].map((m) => m[1]),
      ...[...page.matchAll(/\s(?:title|aria-label|alt|placeholder|content|value)="([^"]*)"/gi)].map((m) => m[1]),
    ];
    for (const text of visible) if (OLD_NAME.test(text)) hits.push(`${file}: ${text.trim()}`);
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('the browser code outside i18n names gentle-deck only as the mode config value', () => {
  const hits = codeHits(['public']);
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('no style sheet shows gentle-deck (a content: value would be visible)', () => {
  const hits: string[] = [];
  for (const file of files('public', ['.css'])) {
    const css = readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (OLD_NAME.test(css)) hits.push(file);
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('the server sends no gentle-deck text (doctor, notifications, window titles): only the mode config value', () => {
  const hits = codeHits(['src', 'bin']);
  assert.deepEqual(hits, [], hits.join('\n'));
});
