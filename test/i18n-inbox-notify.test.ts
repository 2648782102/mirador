// The inbox's notification control and its waiting group are worded in English and Spanish,
// including the keys public/features/inbox.js builds from the notifier's status (not literal t() calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, plural, translate } from '../public/i18n.js';
import { cardNotification, groupNotification } from '../public/features/inbox-notify-model.js';

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
  'inbox.notify.options',
  'inbox.notify.stay',
  'inbox.notify.discreet',
  'inbox.notify.waiting.one',
  'inbox.notify.waiting.other',
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

test('the notifications read in the interface language: who waits, discreet mode and a burst', () => {
  const T0 = '2026-10-28T10:00:00.000Z';
  const card = { terminalId: 't1', workspaceId: 'dev', rel: 'web/mi-proyecto', kind: 'blocked', label: 'Choice awaiting input', detail: '¿Qué base de datos uso?', since: T0 };
  const words = (lang: 'en' | 'es', extra: Record<string, unknown> = {}) => ({ lang, waiting: (count: number) => plural(lang, 'inbox.notify.waiting', count), ...extra });
  const es = cardNotification(card, { reason: translate('es', 'inbox.reason.choice'), workspace: 'Dev', agent: 'Claude Code', ...words('es') });
  assert.deepEqual([es.title, es.options.body, es.options.lang], ['mi-proyecto · Necesita que elijas', '¿Qué base de datos uso?\nClaude Code · Dev › web › mi-proyecto', 'es']);
  const en = cardNotification(card, { reason: translate('en', 'inbox.reason.choice'), workspace: 'Dev', agent: 'Claude Code', ...words('en') });
  assert.equal(en.title, 'mi-proyecto · Needs you to choose');
  assert.deepEqual([cardNotification(card, { reason: '', workspace: 'Dev', ...words('es', { discreet: true }) }).title, cardNotification(card, { reason: '', workspace: 'Dev', ...words('en', { discreet: true }) }).title], ['Un agente te espera', 'An agent is waiting for you']);
  const burst = ['a', 'b', 'c'].map((rel) => ({ item: { ...card, rel }, workspace: 'Dev' }));
  assert.deepEqual([groupNotification(burst, words('es')).title, groupNotification(burst, words('en')).title], ['3 agentes te esperan', '3 agents are waiting for you']);
});
