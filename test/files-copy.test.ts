// The file editor's copy: every error code the API answers has a message in both languages,
// and messages say what happened and what to do instead of blaming the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILE_ERROR_CODES } from '../src/files/folder-files.ts';
import files from '../public/i18n/files.js';

test('every file error code the API answers is translated in English and Spanish', () => {
  for (const code of FILE_ERROR_CODES) {
    assert.ok(files.en[`error.${code}`], `en: error.${code}`);
    assert.ok(files.es[`error.${code}`], `es: error.${code}`);
  }
});

test('file editor messages never just call the input invalid or wrong', () => {
  for (const [language, dictionary] of Object.entries(files) as Array<[string, Record<string, string>]>) {
    for (const [key, text] of Object.entries(dictionary)) {
      assert.doesNotMatch(text, /\b(invalid|incorrect|wrong|inválid|incorrect|error)\w*/i, `${language}: ${key}`);
    }
  }
});
