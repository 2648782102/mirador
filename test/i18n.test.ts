import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTIONARIES, LANGUAGES, MESSAGES, mergeDictionaries, pickLanguage, plural, translate } from '../public/i18n.js';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('English and Spanish define the same keys with the same placeholders', () => {
  assert.deepEqual(LANGUAGES, ['en', 'es']);
  assert.deepEqual(Object.keys(MESSAGES.es).sort(), Object.keys(MESSAGES.en).sort());
  for (const [key, english] of Object.entries(MESSAGES.en)) {
    assert.deepEqual(placeholders(MESSAGES.es[key]), placeholders(english), key);
  }
});

test('every feature dictionary has the same keys and placeholders in both languages', () => {
  assert.ok(Object.keys(DICTIONARIES).length > 1, 'dictionaries are split per feature');
  for (const [feature, dictionary] of Object.entries(DICTIONARIES) as Array<[string, any]>) {
    assert.deepEqual(Object.keys(dictionary).sort(), [...LANGUAGES].sort(), feature);
    assert.deepEqual(Object.keys(dictionary.es).sort(), Object.keys(dictionary.en).sort(), feature);
    for (const [key, english] of Object.entries(dictionary.en) as Array<[string, string]>) {
      assert.deepEqual(placeholders(dictionary.es[key]), placeholders(english), `${feature}: ${key}`);
    }
  }
});

test('the merged messages hold every feature key, and a key defined by two features is refused', () => {
  for (const dictionary of Object.values(DICTIONARIES) as any[]) {
    for (const key of Object.keys(dictionary.en)) assert.equal(MESSAGES.en[key], dictionary.en[key], key);
  }
  assert.throws(
    () => mergeDictionaries({ a: { en: { 'x.y': 'A' }, es: { 'x.y': 'A' } }, b: { en: { 'x.y': 'B' }, es: { 'x.y': 'B' } } }),
    /x\.y.*a.*b/,
  );
});

// The browser stand-in: `languages` and `language`, as navigator has them.
const browser = (languages?: string[], language?: string) => ({ languages, language });

test('pickLanguage without a saved choice: Spanish when the browser\'s first language is es-*, in any case', () => {
  for (const tag of ['es', 'es-CL', 'es-419', 'ES-es']) {
    assert.equal(pickLanguage(null, browser([tag, 'en-US'], tag)), 'es', tag);
  }
});

test('pickLanguage without a saved choice: English for any other browser language, only the first one counting', () => {
  for (const tag of ['en-US', 'pt-BR', 'en', 'est', 'eu']) {
    assert.equal(pickLanguage(null, browser([tag, 'es-CL'], tag)), 'en', tag);
  }
});

test('pickLanguage reads navigator.language when navigator.languages is empty', () => {
  assert.equal(pickLanguage(null, browser([], 'es-MX')), 'es');
  assert.equal(pickLanguage(null, browser([], 'en-GB')), 'en');
});

test('pickLanguage gives English when the browser says nothing', () => {
  assert.equal(pickLanguage(null, undefined), 'en');
  assert.equal(pickLanguage(null, browser()), 'en');
  assert.equal(pickLanguage(null, browser([], '')), 'en');
  assert.equal(pickLanguage(undefined, browser([], undefined)), 'en');
});

test('pickLanguage: a saved choice wins over the browser, and an unknown saved value does not count', () => {
  assert.equal(pickLanguage('es', browser(['en-US'], 'en-US')), 'es');
  assert.equal(pickLanguage('en', browser(['es-CL'], 'es-CL')), 'en');
  assert.equal(pickLanguage('de', browser(['es-CL'], 'es-CL')), 'es');
  assert.equal(pickLanguage('de', browser(['en-US'], 'en-US')), 'en');
});

test('translate fills placeholders and falls back to English, then to the key', () => {
  assert.equal(translate('es', 'term.openFailed', { error: 'boom' }), 'No se pudo abrir la terminal: boom');
  assert.equal(translate('en', 'term.openFailed', { error: 'boom' }), 'Could not open the terminal: boom');
  assert.equal(translate('xx', 'day.today'), 'Today');
  assert.equal(translate('es', 'missing.key'), 'missing.key');
});

test('plural picks the singular only for one', () => {
  assert.equal(plural('es', 'stat.memories', 1), 'memoria');
  assert.equal(plural('es', 'stat.memories', 0), 'memorias');
  assert.equal(plural('en', 'stat.memories', 2), 'memories');
});
