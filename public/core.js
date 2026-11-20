// Shared helpers for every UI feature: DOM building, translation, session, API calls,
// preferences, app state and a small event bus. Features import from here; see docs/extending.md.
import { LANGUAGES, pickLanguage, translate } from '/i18n.js';
import { THEMES, normalizeTheme } from '/theme-model.js';

export const $ = (selector) => document.querySelector(selector);

/** A stable DOM slot from index.html (`data-slot="<name>"`) where a feature mounts its UI. */
export function slot(name) {
  return document.querySelector(`[data-slot="${name}"]`);
}

/** Per-window conveniences in localStorage. Never use it for data that must persist. */
export const prefs = {
  read(key, fallback) {
    try {
      const value = localStorage.getItem(`mirador.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(`mirador.${key}`, JSON.stringify(value));
    } catch {
      // Storage can be unavailable; preferences are a convenience only.
    }
  },
};

/* ---------- Events ---------- */

const bus = new EventTarget();

/** Subscribes to an app event (see docs/extending.md for the list). Returns an unsubscribe function. */
export function on(type, listener) {
  const handler = (event) => listener(event.detail);
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/* ---------- Language ---------- */

// The choice saved under Ajustes / Settings, else the browser's language (pickLanguage).
let language = pickLanguage(prefs.read('lang', null), globalThis.navigator);

export const getLanguage = () => language;
export const t = (key, vars) => translate(language, key, vars);

/** Fills `{name}` placeholders with DOM nodes (e.g. <kbd>), keeping the rest as text. */
export function richText(key, nodes) {
  const parts = [];
  let last = 0;
  const template = t(key);
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    parts.push(template.slice(last, match.index), nodes[match[1]] ?? match[0]);
    last = match.index + match[0].length;
  }
  parts.push(template.slice(last));
  return parts;
}

/** Translates `data-i18n` (textContent), `data-i18n-title` and `data-i18n-label` (aria-label) under `root`. */
export function applyStaticText(root = document) {
  if (root === document) document.documentElement.lang = language;
  root.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((node) => { node.title = t(node.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-label]').forEach((node) => node.setAttribute('aria-label', t(node.dataset.i18nLabel)));
  root.querySelectorAll('button[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === language)));
}

/** Switches the UI language, remembers it and emits `language` so features re-render their text. */
export function setLanguage(next) {
  if (!LANGUAGES.includes(next) || next === language) return;
  language = next;
  prefs.write('lang', language);
  applyStaticText();
  emit('language', language);
}

/* ---------- Theme ---------- */

// public/theme-boot.js already set data-theme from the pref before the first paint; this keeps
// it normalized (an unknown value becomes light) and is the one place that changes it.
let theme = normalizeTheme(prefs.read('theme', null));
document.documentElement.dataset.theme = theme;

export const getTheme = () => theme;

/** Switches the theme (one of THEMES), remembers it and emits `theme` (public/terminals.js repaints xterm). */
export function setTheme(next) {
  if (!THEMES.includes(next) || next === theme) return;
  theme = next;
  prefs.write('theme', theme);
  document.documentElement.dataset.theme = theme;
  emit('theme', theme);
}

/* ---------- DOM ---------- */

/** Builds an element. Text children become text nodes; there is no way to pass HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (tag === 'code' || tag === 'pre' || tag === 'kbd') node.setAttribute('translate', 'no');
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
  return node;
}

/* ---------- Session and API ---------- */

// The session token lives in sessionStorage (scoped to this window and this port),
// never in a cookie, which every server on 127.0.0.1 would receive.
export const session = {
  token: null,
  load() {
    try {
      this.token = sessionStorage.getItem('mirador.token');
    } catch {
      // Without storage the token only lasts until the next reload.
    }
  },
  save(token) {
    this.token = token;
    try {
      sessionStorage.setItem('mirador.token', token);
    } catch {
      // See load().
    }
  },
  expire() {
    this.token = null;
    try {
      sessionStorage.removeItem('mirador.token');
    } catch {
      // See load().
    }
    $('#auth-overlay').hidden = false;
  },
};

/**
 * Takes the session public/launch-boot.js redeemed from the launch link as the page opened, else
 * the one this window already holds.
 */
export async function signIn() {
  const token = await window.miradorLaunch;
  if (token) return session.save(token);
  session.load();
}

/**
 * Calls the API with the session token. Resolves to the JSON body (null for 204);
 * rejects with an Error carrying `status` and the server's stable `code`.
 */
export async function api(method, path, body) {
  if (!session.token) {
    session.expire();
    throw new Error('unauthorized');
  }
  const headers = { authorization: `Bearer ${session.token}` };
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401) {
    session.expire();
    throw new Error('unauthorized');
  }
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { status: response.status, code: data.code });
  return data;
}

/** User-facing text for an API error: the translated `error.<code>` when there is one. */
export function errorText(error) {
  const key = error?.code ? `error.${error.code}` : null;
  return key && t(key) !== key ? t(key) : error?.message ?? String(error);
}

/* ---------- Tree row actions ---------- */

const rowActions = [];

/**
 * Adds a button to every workspace and folder row of the sidebar tree, after the
 * gentle-shell and bash buttons. `action` is { id, text(), icon?, title(folder, path), run(folder) }:
 * `folder` is { ws, rel } (rel '' for the workspace root) and `path` its absolute path.
 * Workspace rows are crowded, so they show `icon` (a sprite name from `/icons.js`, labelled by `title`) when given.
 * Register at module top level so the tree's first render shows it; a later call
 * emits `rowactions` and the tree renders again.
 */
export function registerRowAction(action) {
  if (rowActions.some((known) => known.id === action.id)) throw new Error(`row action ${action.id} is already registered`);
  rowActions.push(action);
  emit('rowactions', rowActionList());
}

export const rowActionList = () => rowActions.slice();

/* ---------- App state ---------- */

/**
 * Shared state. `config` comes from GET /api/config and `workspaces` from
 * GET /api/workspaces (kept current by the workspaces feature, which emits
 * `workspaces`). `selection` is the tree's selected folder, which the summary panel shows
 * when no terminal leads it (public/features/summary-model.js followPanel):
 * { ws, rel } with rel '' for the workspace root, or null for the activity overview.
 */
export const state = {
  config: null,
  workspaces: [],
  selection: prefs.read('selection', null),
};

export function workspaceById(id) {
  return state.workspaces.find((w) => w.id === id) ?? null;
}

/** Replaces the workspace list and emits `workspaces`. */
export function setWorkspaces(list) {
  state.workspaces = list;
  if (state.selection && !workspaceById(state.selection.ws)) select(null);
  emit('workspaces', list);
}

export const sameFolder = (a, b) => !!a && !!b && a.ws === b.ws && a.rel === b.rel;

/** Selects a folder ({ ws, rel }) or null for the overview, and emits `selection`. */
export function select(selection) {
  state.selection = selection ? { ws: selection.ws, rel: selection.rel ?? '' } : null;
  prefs.write('selection', state.selection);
  emit('selection', state.selection);
}
