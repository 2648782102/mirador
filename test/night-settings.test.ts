// Shift settings, folded: schedule, capacity, profile and Telegram
// are each a folded part whose summary carries its current value in one line; the "about" texts and
// the long hints sit behind a small "Cómo funciona" inside each part; errors and the save state stay
// outside the fold, and a new error opens its part. Pinned through night-model.js and the source of
// public/features/night.js, public/styles/night.css and public/i18n/night.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileSummary, queueSummary, scheduleSummary, telegramSummary } from '../public/features/night-model.js';
import { translate } from '../public/i18n.js';

const read = (path: string) => readFileSync(path, 'utf8');
const nightJs = read('public/features/night.js');
const nightCss = read('public/styles/night.css');
const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

/** The source of `function name(…)` in `source`, up to the next top-level function, doc comment or export. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `function ${name} is missing`);
  const end = source.slice(start + 1).search(/\n(?:async )?function |\n\/\*\*|\nexport |\nconst /);
  return end === -1 ? source.slice(start) : source.slice(start, start + 1 + end);
}

const view = (schedule: Record<string, unknown>) => ({ schedule: { enabled: true, days: [1, 2, 3, 4, 5], start: '23:00', end: '07:00', remindBeforeMinutes: 30, ...schedule } });

/* ---------- One-line values ---------- */

test('scheduleSummary: the nights as a range or a list, Monday first, then the hours; "Apagado" without a schedule', () => {
  assert.equal(scheduleSummary(view({}), 'es', es), 'Lun–Vie 23:00–07:00');
  assert.equal(scheduleSummary(view({}), 'en', en), 'Mon–Fri 23:00–07:00');
  assert.equal(scheduleSummary(view({ days: [0, 1, 2, 3, 4, 5, 6] }), 'es', es), 'Todas las noches 23:00–07:00');
  assert.equal(scheduleSummary(view({ days: [0, 1, 2, 3, 4, 5, 6] }), 'en', en), 'Every night 23:00–07:00');
  assert.equal(scheduleSummary(view({ days: [5, 3, 1], start: '22:00', end: '06:00' }), 'es', es), 'Lun, Mié, Vie 22:00–06:00');
  assert.equal(scheduleSummary(view({ days: [5, 6, 0] }), 'es', es), 'Vie–Dom 23:00–07:00', 'three nights in a row are a range');
  assert.equal(scheduleSummary(view({ days: [6, 0] }), 'en', en), 'Sat, Sun 23:00–07:00', 'two nights are listed');
  assert.equal(scheduleSummary(view({ enabled: false }), 'es', es), 'Apagado');
  assert.equal(scheduleSummary(view({ enabled: false }), 'en', en), 'Off');
  assert.equal(scheduleSummary(null, 'es', es), null);
  assert.equal(scheduleSummary({}, 'es', es), null);
});

test('queueSummary, profileSummary and telegramSummary: «5 a la vez», «Equilibrado», «Conectado» / «Sin configurar»', () => {
  assert.equal(queueSummary({ slots: 5, suggested: 5 }, es), '5 a la vez');
  assert.equal(queueSummary({ slots: 1, suggested: 5, custom: true }, en), '1 at once');
  assert.equal(queueSummary(null, es), null);
  assert.equal(queueSummary({ suggested: 5 }, es), null);
  assert.equal(profileSummary({ profile: 'equilibrado' }, es), 'Equilibrado');
  assert.equal(profileSummary({ profile: 'ahorro' }, en), 'Saver');
  assert.equal(profileSummary({ profile: 'turbo' }, es), null);
  assert.equal(profileSummary(null, es), null);
  assert.equal(telegramSummary({ configured: true, chatIdMasked: '••89' }, null, es), 'Conectado');
  assert.equal(telegramSummary({ configured: true }, null, en), 'Connected');
  assert.equal(telegramSummary({ configured: false }, null, es), 'Sin configurar');
  assert.equal(telegramSummary(null, 'boom', es), 'Desconocido', 'a failed read is unknown');
  assert.equal(telegramSummary(null, null, es), null, 'still loading');
});

/* ---------- Folded parts ---------- */

test('settingPart folds a part under its title and value, opens it by default only with an error, and a new error opens it again', () => {
  const part = fn(nightJs, 'settingPart');
  assert.match(part, /function settingPart\(key, title, value, error, \.\.\.children\)/);
  // Remembered as opened, so the part does not fold under him once the error is fixed.
  assert.match(part, /if \(error && !partErrors\.has\(key\)\) opened\.set\(key, true\);/);
  assert.match(part, /disclosure\(\s*key,\s*!!error,\s*\[el\('h3', \{ id: key \}, title\), value \? el\('span', \{ class: 'night-setting-value' \}, value\) : null\],\s*\{ class: 'night-setting' \},\s*\.\.\.children,?\s*\)/);
  assert.match(fn(nightJs, 'howItWorks'), /disclosure\(`\$\{key\}-how`, false, t\('night\.how'\), \{ class: 'night-how' \}, \.\.\.children\)/);
});

test('each part is a settingPart with its one-line value, its "Cómo funciona" first, and its error and save state outside the fold', () => {
  const parts: Array<[string, string, string, string, string]> = [
    ['renderSchedule', 'night-schedule', "t\\('night\\.schedule'\\)", 'scheduleSummary\\(schedule, getLanguage\\(\\), t\\)', 'scheduleNotice'],
    ['renderQueue', 'night-queue', "t\\('night\\.queue'\\)", 'queueSummary\\(queueSettings, t\\)', 'queueNotice'],
    ['renderProfile', 'night-profile', "t\\('night\\.profile'\\)", 'profileSummary\\(profile, t\\)', 'profileNotice'],
    ['renderTelegram', 'night-telegram', "t\\('night\\.telegram'\\)", 'telegramSummary\\(telegram, telegramError, t\\)', 'telegramNotice'],
  ];
  for (const [render, key, title, value, notice] of parts) {
    const source = fn(nightJs, render);
    assert.match(source, new RegExp(`settingPart\\(\\s*'${key}',\\s*${title},\\s*${value},`), `${render}: folded with its value`);
    assert.match(source, new RegExp(`settingPart\\([^]*?\\n\\s+howItWorks\\(\\s*'${key}'`), `${render}: "Cómo funciona" is the part's first child`);
    // The save state is a sibling after the fold, never inside it.
    assert.match(source, new RegExp(`\\n    \\),\\n[^]*el\\('p', \\{ class: \`night-notice\\$\\{${notice}\\?\\.tone === 'error' \\? ' error' : ''\\}\`, role: 'status' \\}, ${notice}\\?\\.text \\?\\? ''\\),\\n  \\);`), `${render}: the notice follows the fold`);
    assert.match(source, new RegExp(`${notice}\\?\\.tone === 'error'[^]*?settingPart\\(`), `${render}: an error notice opens the part`);
  }
  // The read errors sit after the fold too.
  assert.match(fn(nightJs, 'renderSchedule'), /\n    \),\n    scheduleError \? el\('p', \{ class: 'tracking-error', role: 'alert' \}/);
  assert.match(fn(nightJs, 'renderQueue'), /\n    \),\n    queueError \? el\('p', \{ class: 'tracking-error', role: 'alert' \}/);
  assert.match(fn(nightJs, 'renderProfile'), /\n    \),\n    profileError \? el\('p', \{ class: 'tracking-error', role: 'alert' \}/);
  assert.match(fn(nightJs, 'renderTelegram'), /\n    \),\n    telegramError \? el\('p', \{ class: 'tracking-error', role: 'alert' \}/);
  // Field errors open their part too.
  assert.match(fn(nightJs, 'renderSchedule'), /Object\.values\(sched\.errors\)\.some\(\(node\) => node\.textContent\)/);
  assert.match(fn(nightJs, 'renderQueue'), /queueForm\.error\.textContent/);
  assert.match(fn(nightJs, 'renderTelegram'), /tokenError\.textContent \|\| chatError\.textContent/);
});

test('the about texts and the long hints move behind "Cómo funciona"; nothing is dropped', () => {
  const schedule = fn(nightJs, 'renderSchedule');
  assert.match(schedule, /howItWorks\('night-schedule', el\('p', \{ class: 'hint' \}, t\('night\.schedule\.about'\)\)\)/);
  assert.match(schedule, /scheduleSummaryLine\(\)/, 'the next night stays in the open part');
  assert.match(fn(nightJs, 'renderQueue'), /howItWorks\('night-queue', el\('p', \{ class: 'hint' \}, t\('night\.queue\.about'\)\)\)/);
  const profile = fn(nightJs, 'renderProfile');
  assert.match(profile, /howItWorks\('night-profile', el\('p', \{ class: 'hint', id: 'night-profile-about' \}, t\('night\.profile\.about'\)\)\)/);
  // The table and its override hint fold under "Qué fija cada perfil", open by themselves when config.json overrides a row.
  assert.match(profile, /disclosure\(\s*'night-profile-table',\s*overridden,\s*t\('night\.profile\.table'\),\s*\{ class: 'night-profile-more' \},\s*profileTableNode\(table\),\s*overridden \? el\('p', \{ class: 'hint' \}, t\('night\.profile\.overrideHint'\)\) : null,?\s*\)/);
  assert.match(profile, /profileChoices\(table\)/);
  assert.match(profile, /budgetNode\(budgetMeter\(profile\?\.budget\)\)/);
  const telegramPart = fn(nightJs, 'renderTelegram');
  assert.match(telegramPart, /howItWorks\(\s*'night-telegram',\s*el\(\s*'ol',\s*\{ class: 'night-list night-help' \},\s*el\('li', \{\}, t\('night\.telegram\.help\.bot'\)\),\s*el\('li', \{\}, t\('night\.telegram\.help\.chat'\)\),\s*el\('li', \{\}, t\('night\.telegram\.help\.save'\)\),?\s*\),\s*el\('p', \{ class: 'hint' \}, t\('night\.telegram\.privacy'\)\),\s*answers\?\.hint === LONG_ANSWERS_HINT \? el\('p', \{ class: 'hint', id: 'night-tg-answers-hint' \}, t\(answers\.hint\)\) : null,?\s*\)/);
  assert.match(telegramPart, /configured \? el\('p', \{ class: 'muted' \}, t\('night\.telegram\.configured', \{ chat: telegram\.chatIdMasked \?\? '' \}\)\) : null/, 'the masked chat id stays in the open part');
  assert.doesNotMatch(telegramPart, /telegramOpen/, 'the part remembers its own fold');
  // The switch keeps its short "why disabled" hint inline; the long one is in "Cómo funciona".
  const answers = fn(nightJs, 'answersSwitch');
  assert.match(answers, /function answersSwitch\(view\)/);
  assert.match(answers, /'aria-describedby': 'night-tg-answers-hint'/);
  assert.match(answers, /view\.hint === LONG_ANSWERS_HINT \? null : el\('p', \{ class: 'hint', id: 'night-tg-answers-hint' \}, t\(view\.hint\)\)/);
  assert.match(nightJs, /const LONG_ANSWERS_HINT = 'night\.telegram\.answers\.hint';/);
});

test('the sheet opens with the four folded parts and the autopilot\'s about behind its own "Cómo funciona"', () => {
  const open = fn(nightJs, 'openSettings');
  assert.match(open, /disclosure\('night-settings-how', false, t\('night\.settings\.about'\), \{ class: 'night-how' \}, el\('p', \{ class: 'hint' \}, t\('night\.about'\)\)\)/);
  assert.match(open, /parts\.schedule, parts\.queue, parts\.profile, parts\.telegram\]/);
  assert.doesNotMatch(open, /el\('p', \{ class: 'muted' \}, t\('night\.about'\)\)/, 'the about paragraph is no longer in the open');
  assert.match(nightJs, /parts\.telegram = el\('section', \{ class: 'night-part night-telegram', 'aria-labelledby': 'night-telegram' \}\);/);
});

test('the new copy is in both languages, without voseo', () => {
  assert.equal(es('night.how'), 'Cómo funciona');
  assert.equal(en('night.how'), 'How it works');
  assert.equal(es('night.settings.about'), 'Cómo funciona el piloto automático');
  assert.equal(en('night.settings.about'), 'How the autopilot works');
  assert.equal(es('night.telegram.connected'), 'Conectado');
  assert.equal(en('night.telegram.connected'), 'Connected');
  assert.equal(es('night.settings.slots', { slots: 5 }), '5 a la vez');
  assert.equal(es('night.settings.off'), 'Apagado');
  assert.equal(es('night.settings.everyNight'), 'Todas las noches');
});

test('a folded part shows its title and value on one line; "Cómo funciona" is small and muted', () => {
  assert.match(nightCss, /\.night-setting > summary \{[^}]*min-height: 32px;/);
  assert.match(nightCss, /\.night-setting > summary h3 \{[^}]*margin: 0;/);
  assert.match(nightCss, /\.night-setting-value \{[^}]*margin-left: auto;[^}]*text-overflow: ellipsis;/);
  assert.match(nightCss, /\.night-how > summary[^{]*\{[^}]*font-size: var\(--fs-sm\);[^}]*color: var\(--muted\);/);
  assert.match(nightCss, /\.night-schedule,\n\.night-queue,\n\.night-profile,\n\.night-telegram \{ border-top: 1px solid var\(--border\); padding-top: 10px; \}/);
  for (const gone of ['.night-telegram > summary', '.night-telegram[open]', '.night-telegram-title']) assert.ok(!nightCss.includes(gone), `${gone} is gone`);
});
