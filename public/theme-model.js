// Theme names. Each one but light has a
// `:root[data-theme="<name>"]` block in styles.css over the same token names.

export const THEMES = ['light', 'dark', 'gentleman'];
export const DEFAULT_THEME = 'light';

/** A known theme name as is; anything else (a stale pref, a typo, null) is the light default. */
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}
