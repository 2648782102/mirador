// Applies the stored theme before the first paint: a classic script loaded in <head> before the
// stylesheets, since the CSP forbids inline scripts and app.js is a deferred module. It copies the
// `theme` pref (public/core.js prefs) as is; styles.css matches only known names, so anything else
// shows the light default until core.js normalizes it (public/theme-model.js).
try {
  const stored = JSON.parse(localStorage.getItem('mirador.theme'));
  if (typeof stored === 'string') document.documentElement.dataset.theme = stored;
} catch {
  // No storage or a broken value: the light default applies.
}
