// Every literal i18n key the browser code calls resolves in both dictionaries, so a key
// removed by a redesign cannot linger in a feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MESSAGES } from '../public/i18n.js';

test('literal t(...) keys in public/*.js and public/features/*.js exist in en and es', () => {
  const dir = new URL('../public/', import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.js')), ...readdirSync(new URL('features/', dir)).map((f) => `features/${f}`)];
  const missing: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)) {
      for (const lang of ['en', 'es'] as const) if (!(match[1] in (MESSAGES as any)[lang])) missing.push(`${file}: ${match[1]} (${lang})`);
    }
  }
  assert.deepEqual(missing, []);
});
