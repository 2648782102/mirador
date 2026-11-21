// The Ajustes switch "El árbol sigue a la terminal" / "Tree follows the terminal": on by default, it
// lets a tab click or a press on another grid tile reveal the terminal's place in the sidebar tree
// (tree-reveal-model.js); off, those clicks leave the tree as it is. It is stored like every other
// per-window choice, through core.js prefs, as `mirador.treeFollows`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Loaded by URL, as test/tree-reveal-model.test.ts does: plain JS with no declaration file. The settings
// model is read whole, so a missing export fails its own test, not the file.
const { MESSAGES } = await import(new URL('../public/i18n.js', import.meta.url).href);
const settingsModel = await import(new URL('../public/settings-model.js', import.meta.url).href);
const { TREE_FOLLOWS_PREF, readTreeFollows, revealRequest, writeTreeFollows } = await import(new URL('../public/features/tree-reveal-model.js', import.meta.url).href);

const terminalsJs = readFileSync('public/terminals.js', 'utf8');
const settingsJs = readFileSync('public/features/settings.js', 'utf8');
const { SETTINGS_ROWS, treeFollowsSwitchView } = settingsModel as any;
const es = (MESSAGES as any).es as Record<string, string>;
const en = (MESSAGES as any).en as Record<string, string>;

/** core.js prefs over `storage` (a stand-in for localStorage): `mirador.<key>`, JSON, the fallback when absent or unreadable. */
function prefsOver(storage: Map<string, string>) {
  return {
    read(key: string, fallback: unknown) {
      try {
        const value = storage.get(`mirador.${key}`);
        return value === undefined ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    write(key: string, value: unknown) {
      storage.set(`mirador.${key}`, JSON.stringify(value));
    },
  };
}

/** The source of `function name(…) { … }` in `source`, up to the next top-level closing brace. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

const terminal = { id: 't1', workspaceId: 'web', rel: 'site/src' };
const place = { workspaceId: 'web', rel: 'site/src' };

test('S2 Setting: on by default — with nothing stored, a tab or tile click reveals the terminal\'s place', () => {
  const prefs = prefsOver(new Map());
  assert.equal(readTreeFollows(prefs), true);
  assert.deepEqual(revealRequest(terminal, prefs), place);
  assert.deepEqual(revealRequest({ id: 't2', workspaceId: 'web' }, prefs), { workspaceId: 'web', rel: '' }, 'a terminal at the workspace root');
  assert.equal(revealRequest(undefined, prefs), null, 'a terminal that is gone reveals nothing');
});

test('S2 Setting: switched off, no reveal runs — the tab click and the tile press both ask through revealRequest', () => {
  const prefs = prefsOver(new Map());
  writeTreeFollows(prefs, false);
  assert.equal(readTreeFollows(prefs), false);
  assert.equal(revealRequest(terminal, prefs), null);
  // Both clicks reach the one emitter, revealTerminal, and it emits only what revealRequest allows with core.js prefs.
  const reveal = fn(terminalsJs, 'revealTerminal');
  assert.match(reveal, /const place = revealRequest\(terminals\.get\(id\)\?\.info, prefs\);/);
  assert.match(reveal, /if \(place\) emit\('reveal', place\);/);
  assert.equal(terminalsJs.split("emit('reveal'").length - 1, 1, 'revealTerminal is the only emitter');
  assert.match(fn(terminalsJs, 'mountTerminal'), /\n  tab\.addEventListener\('click', \(\) => revealTerminal\(info\.id\)\);/);
  assert.match(fn(terminalsJs, 'pressTile'), /if \(switching\) revealTerminal\(id\);/);
  assert.match(terminalsJs, /^import \{ revealRequest \} from '\/features\/tree-reveal-model\.js';$/m);
});

test('S2 Setting: switched back on, the reveal runs again', () => {
  const prefs = prefsOver(new Map());
  writeTreeFollows(prefs, false);
  assert.equal(revealRequest(terminal, prefs), null);
  writeTreeFollows(prefs, true);
  assert.equal(readTreeFollows(prefs), true);
  assert.deepEqual(revealRequest(terminal, prefs), place);
});

test('S2 Setting: the choice persists through core.js prefs as mirador.treeFollows, and a reload reads it back', () => {
  assert.equal(TREE_FOLLOWS_PREF, 'treeFollows');
  const storage = new Map<string, string>();
  writeTreeFollows(prefsOver(storage), false);
  assert.deepEqual([...storage], [['mirador.treeFollows', 'false']]);
  // A new page over the same storage: still off.
  assert.equal(readTreeFollows(prefsOver(storage)), false);
  writeTreeFollows(prefsOver(storage), true);
  assert.deepEqual([...storage], [['mirador.treeFollows', 'true']]);
  assert.equal(readTreeFollows(prefsOver(storage)), true);
  // Anything but a stored false keeps the default, on.
  assert.equal(readTreeFollows(prefsOver(new Map([['mirador.treeFollows', '{broken']]))), true);
  assert.equal(readTreeFollows(prefsOver(new Map([['mirador.treeFollows', '"no"']]))), true);
});

test('S2 Setting: Ajustes shows it as a switch just before Help, named and explained in English and Spanish', () => {
  const index = SETTINGS_ROWS.findIndex((row: any) => row.id === 'treeFollows');
  assert.equal(index, SETTINGS_ROWS.length - 2, 'just before Help');
  const row = SETTINGS_ROWS[index] as any;
  assert.equal(row.control, 'switch');
  assert.equal(row.developmentOnly, undefined);
  assert.equal(en[row.key], 'Tree follows the terminal');
  assert.equal(es[row.key], 'El árbol sigue a la terminal');
  assert.ok(en[row.hintKey] && es[row.hintKey], 'a hint in both languages');
  assert.deepEqual(treeFollowsSwitchView(true), { checked: true, wordKey: 'settings.switch.on' });
  assert.deepEqual(treeFollowsSwitchView(false), { checked: false, wordKey: 'settings.switch.off' });
});

test('S2 Setting: the switch reads and writes the choice through core.js prefs and redraws after a press or a language change', () => {
  const control = fn(settingsJs, 'control');
  const branch = control.indexOf("if (row.id === 'treeFollows') return treeFollowsControl(row);");
  assert.ok(branch > 0 && branch < control.indexOf("nightWord = el('span'"), 'it branches before the night switch');
  const build = fn(settingsJs, 'treeFollowsControl');
  assert.match(build, /role: 'switch'/);
  assert.match(build, /'aria-labelledby': `settings-\$\{row\.id\}-label`/);
  assert.match(build, /onclick: \(\) => \{\n\s*writeTreeFollows\(prefs, !readTreeFollows\(prefs\)\);\n\s*renderTreeFollows\(\);\n\s*\}/);
  assert.match(fn(settingsJs, 'renderTreeFollows'), /const view = treeFollowsSwitchView\(readTreeFollows\(prefs\)\);/);
  assert.match(fn(settingsJs, 'mountSettings'), /renderTreeFollows\(\);/);
  assert.match(fn(settingsJs, 'init'), /on\('language', renderTreeFollows\);/);
  assert.match(settingsJs, /^import \{ readTreeFollows, writeTreeFollows \} from '\/features\/tree-reveal-model\.js';$/m);
});
