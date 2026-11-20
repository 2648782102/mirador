// The inbox's notification control and its waiting group are worded in English and Spanish,
// including the keys public/features/inbox.js builds from the notifier's status (not literal t() calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES } from '../public/i18n.js';

const KEYS = [
  'inbox.answer',
  'inbox.answerOrder',
  'inbox.notify.label',
  'inbox.notify.turnOn',
  'inbox.notify.turnOff',
  'inbox.notify.asking',
  'inbox.notify.status.on',
  'inbox.notify.status.off',
  'inbox.notify.status.denied',
  'inbox.notify.status.unsupported',
];

test('the notification control and the waiting group have English and Spanish text', () => {
  for (const key of KEYS) {
    for (const lang of ['en', 'es'] as const) {
      const text = (MESSAGES as Record<string, Record<string, string>>)[lang][key];
      assert.equal(typeof text, 'string', `${key} (${lang})`);
      assert.notEqual(text.trim(), '', `${key} (${lang})`);
    }
    assert.notEqual(MESSAGES.es[key], MESSAGES.en[key], `${key} is translated`);
  }
  assert.match(MESSAGES.en['inbox.notify.status.denied'], /blocked by the browser/i);
  assert.match(MESSAGES.en['inbox.notify.status.unsupported'], /not available/i);
  assert.match(MESSAGES.es['inbox.notify.status.denied'], /bloqueados por el navegador/i);
  assert.match(MESSAGES.es['inbox.notify.status.unsupported'], /no disponibles/i);
  assert.match(MESSAGES.en['inbox.answerOrder'], /longest wait first/i);
});
