// What each mode shows. gentle-deck (the full mode) keeps every
// gentle extra; plain hides the extras and names the configured agent. Both say "Mirador".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENTLE_EXTRAS, agentLabel, brandOf, helpSections, modeOf, showsExtra } from '../public/mode-model.js';
import { translate } from '../public/i18n.js';
import { HELP_SECTIONS } from '../public/features/help-model.js';

const EXTRAS = ['memory', 'night', 'mcp', 'gentleProcesses', 'improve'];

// No translate extra: memories are translated by the browser.
test('the gentle extras are memory, night, the Pi MCP editor, gentle-shell processes and "Mejorar con IA"', () => {
  assert.deepEqual([...GENTLE_EXTRAS], EXTRAS);
});

test('gentle-deck keeps every extra visible, as before modes, and the Mirador brand', () => {
  for (const config of [{ mode: 'gentle-deck', agentCommand: 'claude' }, { agentCommand: 'gentle-shell' }, null]) {
    assert.equal(modeOf(config), 'gentle-deck');
    for (const extra of EXTRAS) assert.equal(showsExtra(config, extra), true, `${JSON.stringify(config)} ${extra}`);
    assert.equal(brandOf(config), 'Mirador');
    assert.equal(agentLabel(config), 'gentle-shell');
  }
});

test('plain hides every gentle extra and brands the app Mirador', () => {
  const config = { mode: 'plain', agentCommand: 'gentle-shell' };
  assert.equal(modeOf(config), 'plain');
  for (const extra of EXTRAS) assert.equal(showsExtra(config, extra), false, extra);
  assert.equal(brandOf(config), 'Mirador');
});

test('plain names the configured agent by its program, for the row button and the empty state', () => {
  assert.equal(agentLabel({ mode: 'plain', agentCommand: 'claude' }), 'claude');
  assert.equal(agentLabel({ mode: 'plain', agentCommand: '  /usr/local/bin/opencode --model x ' }), 'opencode');
});

test('a feature name outside the extras always shows', () => {
  assert.equal(showsExtra({ mode: 'plain' }, 'files'), true);
});

// The login text and the credits name the app through {brand}; the guide leaves out night and memory.
const PLAIN = { mode: 'plain' };
/** gentle-deck, an unknown mode and no config yet (the login before GET /api/config). */
const AS_TODAY = [{ mode: 'gentle-deck' }, { mode: 'auto' }, { mode: 'nonsense' }, {}, null];

test('every mode names Mirador in the login text, before the config is read too', () => {
  const login = (language: string, config: unknown) => translate(language, 'auth.body', { brand: brandOf(config), command: 'mirador' });
  assert.equal(login('es', PLAIN), 'Mirador se reinició, esta ventana perdió su sesión o no se abrió con su lanzador. Ejecuta mirador para abrir una ventana nueva.');
  assert.equal(login('en', PLAIN), 'Mirador restarted, this window lost its session, or it was not opened by its launcher. Run mirador to open a fresh window.');
  for (const config of AS_TODAY) {
    assert.equal(login('es', config), 'Mirador se reinició, esta ventana perdió su sesión o no se abrió con su lanzador. Ejecuta mirador para abrir una ventana nueva.', JSON.stringify(config));
    assert.equal(login('en', config), 'Mirador restarted, this window lost its session, or it was not opened by its launcher. Run mirador to open a fresh window.', JSON.stringify(config));
  }
});

test('every mode titles the credits Mirador', () => {
  for (const language of ['es', 'en']) {
    assert.equal(translate(language, 'credits.title', { brand: brandOf(PLAIN) }), 'Mirador');
    for (const config of AS_TODAY) assert.equal(translate(language, 'credits.title', { brand: brandOf(config) }), 'Mirador', JSON.stringify(config));
  }
});

const entryIds = (sections: any[]) => sections.map((section) => [section.id, section.entries.map((entry: any) => entry.id ?? entry.state)]);

test('plain leaves the night, memory and MCP entries out of the help guide', () => {
  assert.deepEqual(entryIds(helpSections(PLAIN, HELP_SECTIONS)), [
    ['states', ['work', 'wait', 'done', 'sleep', 'err']],
    ['icons', ['git', 'rose', 'bash', 'delegate', 'files', 'filter', 'grip', 'more']],
    ['panels', ['inbox', 'tracking', 'filter', 'layout']],
    ['keys', ['move', 'tabs', 'enter', 'fold', 'tree', 'rename', 'menu', 'save', 'escape', 'help']],
  ]);
});

test('gentle-deck and unknown modes keep every help entry, and plain never changes the guide\'s data', () => {
  helpSections(PLAIN, HELP_SECTIONS);
  assert.deepEqual(HELP_SECTIONS.map((section: any) => section.entries.length), [5, 10, 8, 11]);
  for (const config of AS_TODAY) {
    assert.deepEqual(helpSections(config, HELP_SECTIONS), HELP_SECTIONS, JSON.stringify(config));
  }
});
