// The settings sheet: its rows, which theme, layout
// and language is pressed, the night shift switch's word and state, the topbar chip, and when
// the sheet closes and gives the focus back to the "Ajustes" button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGE_CHOICES,
  LAYOUT_CHOICES,
  SETTINGS_ROWS,
  THEME_CHOICES,
  nightSwitchView,
  pressedChoices,
  SIGN_OUT_OTHERS,
  sheetCloses,
  signOutResult,
} from '../public/settings-model.js';
import { LANGUAGES, MESSAGES, translate } from '../public/i18n.js';
import { THEMES } from '../public/theme-model.js';
import { SYMBOLS } from '../public/icons.js';
import { showsTabsBar } from '../public/terminal-groups.js';

const es = (MESSAGES as any).es as Record<string, string>;
const en = (MESSAGES as any).en as Record<string, string>;

test('S4: the sheet has six rows: night shift, terminals, theme, language (the artboard order), then tree follows the terminal and help (gentle-deck-state-filter S9)', () => {
  assert.deepEqual(SETTINGS_ROWS.map((row) => row.id), ['night', 'layout', 'theme', 'language', 'treeFollows', 'help']);
  assert.deepEqual(SETTINGS_ROWS.map((row) => es[row.key]), ['Piloto automático', 'Terminales', 'Tema', 'Idioma', 'El árbol sigue a la terminal', 'Ayuda']);
  assert.deepEqual(SETTINGS_ROWS.map((row) => row.icon), ['sereno', 'terminal', 'sun', null, 'sidebar', 'help']);
  for (const row of SETTINGS_ROWS) if (row.icon) assert.ok(row.icon in SYMBOLS, row.icon);
});

test('S4, S5: the night shift and tree follows the terminal are the two switches; the other rows pick between named options', () => {
  assert.deepEqual(SETTINGS_ROWS.map((row) => row.control), ['switch', 'choices', 'choices', 'choices', 'switch', 'button']);
});

test('S4: only the terminals row belongs to Development (Seguimiento hides it, as it hid the old Tabs/Grid switch)', () => {
  assert.deepEqual(SETTINGS_ROWS.filter((row) => row.developmentOnly).map((row) => row.id), ['layout']);
});

test('S6: the theme row offers every theme, in order, as Claro, Oscuro and Gentleman; Gentleman reads as Gentleman Sexy', () => {
  assert.deepEqual(THEME_CHOICES.map((choice) => choice.value), THEMES);
  assert.deepEqual(THEME_CHOICES.map((choice) => es[choice.key]), ['Claro', 'Oscuro', 'Gentleman']);
  assert.deepEqual(THEME_CHOICES.map((choice) => en[choice.key]), ['Light', 'Dark', 'Gentleman']);
  assert.equal(es[THEME_CHOICES[2].labelKey!], 'Gentleman Sexy');
  assert.equal(THEME_CHOICES[0].labelKey, undefined);
});

test('S4: the moved layout row keeps the Tabs/Grid values and keys terminals.js and its strings already use', () => {
  assert.deepEqual(LAYOUT_CHOICES.map((choice) => choice.value), ['tabs', 'grid']);
  assert.deepEqual(LAYOUT_CHOICES.map((choice) => es[choice.key]), ['Pestañas', 'Cuadrícula']);
  // Previous behavior kept: tabs shows the tabs bar, grid does not.
  assert.deepEqual(LAYOUT_CHOICES.map((choice) => showsTabsBar(choice.value)), [true, false]);
});

test('S4: the moved language row keeps one button per language, EN then ES, named in its own language', () => {
  assert.deepEqual(LANGUAGE_CHOICES.map((choice) => choice.value), LANGUAGES);
  assert.deepEqual(LANGUAGE_CHOICES.map((choice) => choice.text), ['EN', 'ES']);
});

test('S4, S6: exactly the current option is pressed; an unknown current presses none', () => {
  assert.deepEqual(pressedChoices(THEME_CHOICES, 'dark'), [['light', false], ['dark', true], ['gentleman', false]]);
  assert.deepEqual(pressedChoices(LAYOUT_CHOICES, 'grid'), [['tabs', false], ['grid', true]]);
  assert.deepEqual(pressedChoices(LANGUAGE_CHOICES, 'es'), [['en', false], ['es', true]]);
  assert.deepEqual(pressedChoices(THEME_CHOICES, 'solarized'), [['light', false], ['dark', false], ['gentleman', false]]);
});

test('S5: the switch says Apagado or Encendido and is checked only while the night shift is on; the chip shows only then', () => {
  const off = nightSwitchView({ available: true, active: false });
  assert.deepEqual(off, { checked: false, disabled: false, busy: false, wordKey: 'settings.switch.off', chip: false });
  const on = nightSwitchView({ available: true, active: true });
  assert.deepEqual(on, { checked: true, disabled: false, busy: false, wordKey: 'settings.switch.on', chip: true });
  assert.equal(es[off.wordKey], 'Apagado');
  assert.equal(es[on.wordKey], 'Encendido');
  assert.equal(en[off.wordKey], 'Off');
  assert.equal(en[on.wordKey], 'On');
});

test('S5: while it saves the switch says so and cannot be pressed again; the chip follows the last known state', () => {
  const view = nightSwitchView({ available: true, active: true }, { busy: true });
  assert.deepEqual(view, { checked: true, disabled: true, busy: true, wordKey: 'night.switch.saving', chip: true });
  assert.equal(es[view.wordKey], 'Guardando…');
});

test('S5: the previous disabled rule holds: no status yet, or a channel that is unavailable while off', () => {
  // Status not read yet: off, disabled, no chip.
  assert.deepEqual(nightSwitchView(null), { checked: false, disabled: true, busy: false, wordKey: 'settings.switch.off', chip: false });
  assert.equal(nightSwitchView({ available: false, active: false }).disabled, true);
  // On while the channel dropped: it can still be turned off.
  assert.equal(nightSwitchView({ available: false, active: true }).disabled, false);
});

test('S4: Esc closes the open sheet and gives the focus back to the button', () => {
  assert.deepEqual(sheetCloses('escape', { open: true }), { refocus: true });
  assert.equal(sheetCloses('escape', { open: false }), null);
});

test('S4: a click outside closes it; the focus goes back to the button only when it was inside the sheet', () => {
  assert.deepEqual(sheetCloses('click', { open: true, focusInSheet: true }), { refocus: true });
  // The click landed on another control, which has the focus now: it keeps it.
  assert.deepEqual(sheetCloses('click', { open: true, focusInSheet: false }), { refocus: false });
});

test('S4: a click inside the sheet or on its button does not close it from outside (the button toggles it itself)', () => {
  assert.equal(sheetCloses('click', { open: true, inSheet: true }), null);
  assert.equal(sheetCloses('click', { open: true, onToggle: true }), null);
  assert.equal(sheetCloses('click', { open: false }), null);
});

test('S5: a dialog the sheet opened (turning the night shift on asks until when) keeps the sheet open under it', () => {
  assert.equal(sheetCloses('escape', { open: true, inDialog: true }), null);
  assert.equal(sheetCloses('click', { open: true, inDialog: true, focusInSheet: true }), null);
});

test('phone S8: "Sign out the other windows" sits under the rows, not among them, and asks before it clears anything', () => {
  assert.equal(SETTINGS_ROWS.some((row: { id: string }) => row.id === 'signOut'), false, 'the six rows stay as they are');
  assert.deepEqual(
    [SIGN_OUT_OTHERS.key, SIGN_OUT_OTHERS.hintKey, SIGN_OUT_OTHERS.buttonKey].map((key) => [en[key], es[key]]),
    [
      ['Other windows', 'Otras ventanas'],
      ['Signs out a lost phone or any other window; this one stays.', 'Cierra la sesión de un teléfono perdido o de otra ventana; esta sigue abierta.'],
      ['Sign out the other windows', 'Cerrar sesión en las demás ventanas'],
    ],
  );
  const { title, message, confirmLabel } = SIGN_OUT_OTHERS.confirm;
  assert.deepEqual([title, message, confirmLabel].map((key) => [en[key], es[key]]), [
    ['Sign out the other windows?', '¿Cerrar sesión en las demás ventanas?'],
    [
      'Every other window and phone with {brand} open loses access at once, and its terminals disconnect. This window stays signed in. To sign in again, they need a new link (mirador link on the host).',
      'Todas las demás ventanas y teléfonos con {brand} abierto pierden el acceso al momento y sus terminales se desconectan. Esta ventana sigue con su sesión. Para volver a entrar necesitan un enlace nuevo (mirador link en el equipo).',
    ],
    ['Sign out', 'Cerrar sesión'],
  ]);
});

test('phone S8: the result line says how many windows were signed out, in English and Spanish', () => {
  const said = (cleared: number) => {
    const { key, vars } = signOutResult(cleared);
    return [translate('en', key, vars), translate('es', key, vars)];
  };
  assert.deepEqual(said(0), ['No other window was signed in.', 'No había otra ventana con sesión.']);
  assert.deepEqual(said(1), ['Signed out 1 other window.', 'Se cerró la sesión de 1 ventana más.']);
  assert.deepEqual(said(3), ['Signed out 3 other windows.', 'Se cerró la sesión de 3 ventanas más.']);
});
