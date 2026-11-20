// What each mode shows. GET /api/config's `mode` is already
// resolved: 'gentle-deck' (the full mode) shows the Gentle ecosystem extras; 'plain' hides them.
// Both say "Mirador". Each feature asks showsExtra() where its entry point mounts (a view, a row
// action, a settings row), so plain never calls their routes. Pure, so test/mode-model.test.ts
// imports it in Node.

/**
 * The extras plain mode hides: Engram memory views, the night shift, the Pi MCP editor, the
 * gentle-shells running outside Mirador and "Mejorar con IA" (a pi run). Memories are translated
 * by the browser's own translator, so there is no translate extra.
 */
export const GENTLE_EXTRAS = Object.freeze(['memory', 'night', 'mcp', 'gentleProcesses', 'improve']);

/** 'plain' only when the config says so; anything else (an older server too) is gentle-deck, as before modes. */
export function modeOf(config) {
  return config?.mode === 'plain' ? 'plain' : 'gentle-deck';
}

/** Whether `extra` shows under `config`: every extra in gentle-deck, none of GENTLE_EXTRAS in plain. */
export function showsExtra(config, extra) {
  return modeOf(config) === 'gentle-deck' || !GENTLE_EXTRAS.includes(extra);
}

/**
 * The app's visible name, the one place it comes from: the
 * page title, the topbar brand and every i18n message's `{brand}` (public/i18n.js fills it). A name,
 * so it is never translated. The mode config value 'gentle-deck' is internal and keeps its name.
 */
export const BRAND = 'Mirador';

/** The app's name under `config`: Mirador in every mode, before the config is read too. */
export function brandOf(config) {
  return BRAND;
}

/**
 * The agent a row's agent button and the empty state name: gentle-shell in gentle-deck, and in
 * plain the program of the configured `agentCommand` (its first word, without its directory).
 */
export function agentLabel(config) {
  if (modeOf(config) === 'gentle-deck') return 'gentle-shell';
  const command = String(config?.agentCommand ?? '').trim();
  return command.split(/\s+/)[0].split('/').pop() || command;
}

/**
 * The empty state's hint (public/terminals.js): it names the agent button and the bash one, or only
 * bash when the agent button is bash too (plain mode with `"agentCommand": "bash"`).
 */
export function emptyHintKey(config) {
  return agentLabel(config) === 'bash' ? 'empty.hintShell' : 'empty.hint';
}

/**
 * The help guide's entries (public/features/help-model.js) that explain a gentle extra, by
 * `<section>.<entry>`: Sereno and the autopilot are the night shift; the MCP icon opens the MCP
 * editor; "Dónde quedó", "Día", the folder without memory and turning a long goal's pages read the
 * folder's memory.
 */
const HELP_ENTRY_EXTRAS = Object.freeze({
  'icons.sereno': 'night',
  'icons.mcp': 'mcp',
  'panels.autopilot': 'night',
  'panels.leftOff': 'memory',
  'panels.day': 'memory',
  'panels.noMemory': 'memory',
  'keys.pages': 'memory',
});

/** The guide's sections with only the entries `config` shows: all of them in gentle-deck. The data stays as it is. */
export function helpSections(config, sections) {
  return sections.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => showsExtra(config, HELP_ENTRY_EXTRAS[`${section.id}.${entry.id ?? entry.state}`])),
  }));
}
