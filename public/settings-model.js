// The settings sheet's rules: its rows, which option
// is pressed, the autopilot switch and the topbar chip, and when the sheet closes. Pure, so
// test/settings-model.test.ts imports it in Node; public/features/settings.js draws it.
import { LANGUAGES } from './i18n.js';
import { THEMES } from './theme-model.js';

/** One button per theme, in THEMES order; Gentleman is named in full for assistive technology. */
export const THEME_CHOICES = THEMES.map((value) =>
  value === 'gentleman' ? { value, key: `settings.theme.${value}`, labelKey: 'settings.theme.gentlemanLabel' } : { value, key: `settings.theme.${value}` },
);

/** The terminals layouts public/terminals.js knows (`data-layout`), with their existing strings. */
export const LAYOUT_CHOICES = [
  { value: 'tabs', key: 'layout.tabs' },
  { value: 'grid', key: 'layout.grid' },
];

/** One button per UI language (`data-lang`), named in its own language. */
export const LANGUAGE_CHOICES = LANGUAGES.map((value) => ({ value, text: value.toUpperCase() }));

/**
 * The sheet's rows, top to bottom. `control`
 * 'switch' is the only on/off setting; 'choices' rows press one of `choices`, marked with
 * `data-<attr>`. `developmentOnly` rows hide while Seguimiento shows (public/features/tracking.js).
 * `hintKey` is a line under the row's name; the autopilot's says Sereno keeps watch.
 * The 'button' row "Ayuda" opens the help guide with a
 * text button (`buttonKey`) that announces its key, `shortcut`, with no keycap.
 */
export const SETTINGS_ROWS = [
  { id: 'night', key: 'settings.night', hintKey: 'settings.nightHint', icon: 'sereno', control: 'switch' },
  { id: 'layout', key: 'settings.layout', icon: 'terminal', control: 'choices', groupKey: 'layout.group', attr: 'layout', choices: LAYOUT_CHOICES, developmentOnly: true },
  { id: 'theme', key: 'settings.theme', icon: 'sun', control: 'choices', groupKey: 'settings.theme', attr: 'theme-choice', choices: THEME_CHOICES },
  { id: 'language', key: 'settings.language', icon: null, control: 'choices', groupKey: 'lang.label', attr: 'lang', choices: LANGUAGE_CHOICES },
  { id: 'help', key: 'settings.help', icon: 'help', control: 'button', buttonKey: 'help.open', shortcut: 'Shift+?' },
];

/** [value, pressed] per choice: only the one equal to `current`. */
export function pressedChoices(choices, current) {
  return choices.map((choice) => [choice.value, choice.value === current]);
}

/**
 * The autopilot switch for `status` (GET /api/night, null until read) while `busy` saves:
 * checked while on, its visible word, and whether it can be pressed. It cannot before the
 * status is known, nor turn on while the night channel is unavailable. `chip`: the topbar
 * "Piloto automático" chip shows only while it is on.
 */
export function nightSwitchView(status, { busy = false } = {}) {
  const checked = !!status?.active;
  return {
    checked,
    disabled: busy || !status || (!status.available && !checked),
    busy,
    wordKey: busy ? 'night.switch.saving' : checked ? 'settings.switch.on' : 'settings.switch.off',
    chip: checked,
  };
}

/**
 * Whether `trigger` ('escape' or 'click') closes the sheet, and whether the focus goes back to
 * the "Ajustes" button: Esc always gives it back; a click outside only when the focus was in the
 * sheet (a click on another control keeps the focus there). A click in the sheet or on its
 * button, or anything inside a dialog the sheet opened, leaves it open. null: nothing to do.
 */
export function sheetCloses(trigger, { open = false, inSheet = false, onToggle = false, inDialog = false, focusInSheet = false } = {}) {
  if (!open || inDialog) return null;
  if (trigger === 'escape') return { refocus: true };
  if (trigger !== 'click' || inSheet || onToggle) return null;
  return { refocus: focusInSheet };
}
