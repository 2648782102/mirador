// The night policy: which questions Mirador may decide at all, before any model is asked.
// Decide gentle-shell questions at night and sensitive material stays pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestion, findSensitive, SENSITIVE_RULES } from '../src/night/policy.ts';
import type { NightQuestion, NightQuestionItem } from '../src/night/protocol.ts';

const item = (question: string, labels: string[] = ['Option A', 'Option B'], extra: Partial<NightQuestionItem> = {}): NightQuestionItem => ({
  question,
  header: '',
  options: labels.map((label) => ({ label, description: `Pick ${label}` })),
  multiSelect: false,
  ...extra,
});

const choice = (question: string, labels?: string[], extra: Partial<NightQuestion> = {}): NightQuestion => ({
  terminalId: 't1',
  toolCallId: 'call-1',
  tool: 'ask_user_choice',
  items: [item(question, labels)],
  allowCustomResponse: false,
  ...extra,
});

test('an ordinary closed choice may be decided while the night shift is active', () => {
  assert.deepEqual(checkQuestion(choice('Which test runner should the new module use?', ['node:test', 'vitest']), true), { allow: true });
  const questionnaire: NightQuestion = {
    terminalId: 't1', toolCallId: 'c', tool: 'ask_user_question', allowCustomResponse: false,
    items: [item('Name the helper?', ['parseLine', 'readLine'], { header: 'Naming' }), item('¿Agregamos la prueba ahora?', ['Sí', 'Después'])],
  };
  assert.deepEqual(checkQuestion(questionnaire, true), { allow: true });
});

test('each structural rule defers', () => {
  const ok = choice('Which layout?', ['Grid', 'List']);
  const cases: Array<[string, NightQuestion, boolean, string]> = [
    ['inactive', ok, false, 'inactive'],
    ['other tool', { ...ok, tool: 'bash' as NightQuestion['tool'] }, true, 'tool'],
    ['multiSelect', { ...ok, items: [item('Which layouts?', ['Grid', 'List'], { multiSelect: true })] }, true, 'multi-select'],
    ['custom response with no options', { ...ok, allowCustomResponse: true, items: [item('Describe the layout', [])] }, true, 'custom-only'],
    ['no items', { ...ok, items: [] }, true, 'item-count'],
    ['five items', { ...ok, tool: 'ask_user_question', items: Array.from({ length: 5 }, () => item('Which layout?')) }, true, 'item-count'],
    ['one option', { ...ok, items: [item('Which layout?', ['Grid'])] }, true, 'option-count'],
    ['five options', { ...ok, items: [item('Which layout?', ['A1', 'B2', 'C3', 'D4', 'E5'])] }, true, 'option-count'],
  ];
  for (const [name, question, active, rule] of cases) {
    const outcome = checkQuestion(question, active);
    assert.equal(outcome.allow, false, name);
    assert.equal(!outcome.allow && outcome.rule, rule, name);
    assert.ok(!outcome.allow && outcome.reason.length > 0, `${name} explains itself`);
  }
  // A custom response next to real options is still a closed choice.
  assert.deepEqual(checkQuestion({ ...ok, allowCustomResponse: true }, true), { allow: true });
});

test('sensitive material in English or Spanish defers, wherever it appears', () => {
  const samples: Array<[string, string]> = [
    ['Should I add the key to .env?', 'env-file'],
    ['¿Edito el archivo .env.local?', 'env-file'],
    ['Store the secret in the repo?', 'secrets'],
    ['¿Guardo el secreto en el repo?', 'secrets'],
    ['Rotate the API token now?', 'secrets'],
    ['Change the database password?', 'secrets'],
    ['¿Cambio la contraseña de la base?', 'secrets'],
    ['Use the new credentials file?', 'secrets'],
    ['¿Uso las credenciales nuevas?', 'secrets'],
    ['Generate a new private key?', 'secrets'],
    ['¿Genero una clave privada nueva?', 'secrets'],
    ['Renew the TLS certificate?', 'certificates'],
    ['¿Renuevo el certificado?', 'certificates'],
    ['Add my key to ~/.ssh/authorized_keys?', 'ssh'],
    ['Edit ~/.config/gh/hosts.yml?', 'config-secrets'],
    ['Run it with sudo?', 'permissions'],
    ['¿Le doy permisos de escritura?', 'permissions'],
    ['Grant consent for the review?', 'permissions'],
    ['¿Autorizo la revisión?', 'permissions'],
    ['Delete the old migrations folder?', 'destructive'],
    ['¿Borro la carpeta vieja?', 'destructive'],
    ['¿Elimino los archivos generados?', 'destructive'],
    ['Force-push the branch?', 'destructive'],
    ['Run git push --force?', 'destructive'],
    ['Deploy to production?', 'production'],
    ['¿Despliego a producción?', 'production'],
    ['Cut the release now?', 'production'],
    ['¿Publico la versión?', 'production'],
    ['Pay the invoice?', 'payments'],
    ['¿Hago el pago con la tarjeta?', 'payments'],
  ];
  for (const [text, topic] of samples) {
    assert.equal(findSensitive(text), topic, text);
    const inQuestion = checkQuestion(choice(text), true);
    assert.equal(!inQuestion.allow && inQuestion.rule, `sensitive:${topic}`, `question: ${text}`);
  }
  // In a header, a label or a description too.
  const where: NightQuestion[] = [
    { ...choice('Which one?'), items: [item('Which one?', ['A', 'B'], { header: 'Production' })] },
    choice('Which one?', ['Keep it', 'Delete it']),
    { ...choice('Which one?'), items: [{ question: 'Which one?', header: '', multiSelect: false, options: [{ label: 'A', description: 'writes the password' }, { label: 'B', description: 'safe' }] }] },
  ];
  for (const question of where) assert.equal(checkQuestion(question, true).allow, false, JSON.stringify(question.items));
});

test('accents, case and invisible characters do not hide sensitive words', () => {
  for (const text of ['PRODUCCIÓN', 'Contraseña', 'pass\u200bword', 'de\u00adlete the file', 'ＳＵＤＯ']) {
    assert.notEqual(findSensitive(text), null, JSON.stringify(text));
  }
});

test('ordinary words stay decidable', () => {
  for (const text of ['Which test runner?', 'Rename the helper to parseLine?', '¿Usamos una tabla o una lista?', 'Keep the monkey patch?', 'Split the module in two?', 'Add a summary section?']) {
    assert.equal(findSensitive(text), null, text);
  }
});

test('every sensitive rule is documented', () => {
  for (const rule of SENSITIVE_RULES) {
    assert.match(rule.id, /^[a-z-]+$/);
    assert.ok(rule.description.length > 10, rule.id);
  }
});
