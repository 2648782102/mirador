// UI copy in English and Spanish. Pure module: the browser and the tests import it.
// Each feature keeps its strings in public/i18n/<feature>.js; register it in DICTIONARIES.

import { BRAND } from './mode-model.js';
import core from './i18n/core.js';
import summary from './i18n/summary.js';
import terminals from './i18n/terminals.js';
import workspaces from './i18n/workspaces.js';
// Wave 2: each unit adds its import on the line under its own marker (docs/extending.md).
// W3 overview
import overview from './i18n/overview.js';

// W4 inbox
import inbox from './i18n/inbox.js';

// W5 editor
import files from './i18n/files.js';

// Tracking
import tracking from './i18n/tracking.js';

// Night
import night from './i18n/night.js';

// Resources
import resources from './i18n/resources.js';

// Launches
import launches from './i18n/launches.js';

// Sleeping agents
import sleeping from './i18n/sleeping.js';

// MCP per project
import mcp from './i18n/mcp.js';

// Settings sheet
import settings from './i18n/settings.js';

// Help guide
import help from './i18n/help.js';

// Credits
import credits from './i18n/credits.js';


export const LANGUAGES = ['en', 'es'];

export const DICTIONARIES = {
  core,
  workspaces,
  terminals,
  summary,
  // W3 overview
  overview,

  // W4 inbox
  inbox,

  // W5 editor
  files,

  // Tracking
  tracking,

  // Night
  night,

  // Resources
  resources,

  // Launches
  launches,

  // Sleeping agents
  sleeping,

  // MCP per project
  mcp,

  // Settings sheet
  settings,

  // Help guide
  help,

  // Credits
  credits,

};

/** Merges feature dictionaries into one table per language; a key owned by two features is a bug. */
export function mergeDictionaries(dictionaries) {
  const merged = Object.fromEntries(LANGUAGES.map((language) => [language, {}]));
  const owner = {};
  for (const [feature, dictionary] of Object.entries(dictionaries)) {
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(dictionary[language] ?? {})) {
        if (owner[`${language}:${key}`]) throw new Error(`i18n key ${key} is defined by ${owner[`${language}:${key}`]} and ${feature}`);
        owner[`${language}:${key}`] = feature;
        merged[language][key] = text;
      }
    }
  }
  return merged;
}

export const MESSAGES = mergeDictionaries(DICTIONARIES);

/**
 * The saved choice; with none, the browser's: Spanish when its first language (`navigator.languages[0]`,
 * else `navigator.language`) is es or es-* in any case, English for anything else or nothing.
 * `browser` is `navigator` or a stand-in with the same two fields.
 */
export function pickLanguage(saved, browser) {
  if (LANGUAGES.includes(saved)) return saved;
  const tag = String(browser?.languages?.[0] || browser?.language || '');
  return tag.split('-')[0].toLowerCase() === 'es' ? 'es' : 'en';
}

/** Fills `{name}` from `vars`; `{brand}`, the app's name, is BRAND (public/mode-model.js) unless `vars` sets it. */
export function translate(language, key, vars = {}) {
  const template = MESSAGES[language]?.[key] ?? MESSAGES.en[key] ?? key;
  const values = { brand: BRAND, ...vars };
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

export function plural(language, key, count) {
  return translate(language, `${key}.${count === 1 ? 'one' : 'other'}`, { count });
}
