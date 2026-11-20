// The language the interface starts in (public/core.js): the one saved under Ajustes / Settings,
// or, with none saved, the browser's (Spanish for es-*, English otherwise). The real core.js is
// loaded in Node with a fake navigator and localStorage; each case loads a fresh copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
// The browser paths of public/ ('/i18n.js') as Node files.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

let loads = 0;

/** core.js's language on a page whose browser lists `languages` and whose storage holds `saved` (none when undefined). */
async function startLanguage(languages: string[], saved?: string): Promise<{ language: string; html: string }> {
  const stored: Record<string, string> = saved === undefined ? {} : { 'mirador.lang': JSON.stringify(saved) };
  const html = { lang: '', dataset: {} as Record<string, string> };
  Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => stored[key] ?? null, setItem() {} },
    document: { documentElement: html, querySelectorAll: () => [] },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { languages, language: languages[0] ?? '' }, configurable: true });
  const core = await import(`${new URL('core.js', publicDir).href}?load=${++loads}`);
  core.applyStaticText();
  return { language: core.getLanguage(), html: html.lang };
}

test('with no saved choice, a Spanish browser starts the interface in Spanish', async () => {
  assert.deepEqual(await startLanguage(['es-CL', 'en']), { language: 'es', html: 'es' });
});

test('with no saved choice, any other browser starts it in English', async () => {
  assert.deepEqual(await startLanguage(['en-US', 'es']), { language: 'en', html: 'en' });
  assert.deepEqual(await startLanguage(['pt-BR']), { language: 'en', html: 'en' });
});

test('a saved choice wins over the browser', async () => {
  assert.deepEqual(await startLanguage(['en-US'], 'es'), { language: 'es', html: 'es' });
  assert.deepEqual(await startLanguage(['es-CL'], 'en'), { language: 'en', html: 'en' });
});
