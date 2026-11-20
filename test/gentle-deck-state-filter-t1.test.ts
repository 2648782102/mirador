// Pins T1 (S7 gentle-shell rose, S8 Sereno) to the approved
// artboard design/state-filter/01-chips-y-acordeon.html.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SYMBOLS } from '../public/icons.js';
import { LANGUAGES, MESSAGES } from '../public/i18n.js';
import { SETTINGS_ROWS } from '../public/settings-model.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const artboard = readArtboard('design/state-filter/01-chips-y-acordeon.html');
const sprite = readArtboard('design/mirador-theme/03-papel-y-tinta.html');
const css = read('public/styles.css');
const workspacesCss = read('public/styles/workspaces.css');
const settingsCss = read('public/styles/settings.css');
const workspacesJs = read('public/features/workspaces.js');
const settingsJs = read('public/features/settings.js');
const nightJs = read('public/features/night.js');
const page = read('public/index.html');
const es = (MESSAGES as any).es as Record<string, string>;
const en = (MESSAGES as any).en as Record<string, string>;

type Shape = [string, Record<string, string>];
const symbols = SYMBOLS as Record<string, Shape[]>;
const markup = (shapes: Shape[]) => shapes.map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('');
const drawn = (source: string) => new Map([...source.matchAll(/<symbol id="i-([a-z-]+)" viewBox="0 0 24 24">(.*?)<\/symbol>/g)].map((m) => [m[1], m[2]]));

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The custom properties of the first `:root<selector> { … }` block in `source`. */
function tokens(source: string, selector: string): Record<string, string> {
  const body = source.match(new RegExp(`:root${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The body of the top-level function `name` in `source`, up to the next top-level declaration. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} is missing`);
  const end = source.slice(start + 1).search(/\n(?:async )?function |\n\/\*\*|\nexport /);
  return end === -1 ? source.slice(start) : source.slice(start, start + 1 + end);
}

test('S7, S8: rose and sereno are the artboard drawings, path for path, in the app sprite and in the 03 sprite', { skip: NO_DESIGN }, () => {
  const approved = drawn(artboard);
  const theme = drawn(sprite);
  for (const name of ['rose', 'sereno']) {
    assert.ok(approved.has(name), `${name} is not in the approved artboard`);
    assert.ok(name in symbols, `${name} is not in SYMBOLS`);
    assert.equal(markup(symbols[name]), approved.get(name), `SYMBOLS.${name}`);
    assert.equal(theme.get(name), approved.get(name), `03 sprite ${name}`);
  }
});

test('S8: the owl replaced the moon, so the moon left the app sprite', () => {
  assert.equal('moon' in symbols, false);
});

test('S7: --rose is #c81e6f in claro and #ff76c3 in oscuro and gentleman', () => {
  assert.equal(tokens(css, '')['--rose'], '#c81e6f');
  assert.equal(tokens(css, '\\[data-theme="dark"\\]')['--rose'], '#ff76c3');
  assert.equal(tokens(css, '\\[data-theme="gentleman"\\]')['--rose'], '#ff76c3');
  // svg.icon.gs-rose comes after the "Más" item's icon color, so the rose stays pink there too.
  assert.deepEqual(own(workspacesCss, 'svg.icon.gs-rose'), { color: 'var(--rose)' });
  assert.ok(workspacesCss.indexOf('svg.icon.gs-rose') > workspacesCss.indexOf('.ws-more-item > svg.icon'));
});

test('S7: the gentle-shell row button shows the rose before its label, which is its accessible name', () => {
  const buttons = fn(workspacesJs, 'terminalButtons');
  const agent = buttons.split('\n').find((line) => line.includes("openTerminal(folder, 'agent')"));
  assert.ok(agent, 'the gentle-shell button is missing');
  assert.match(agent, /class: 'btn gs-btn'/);
  assert.match(agent, /roseIcon\(\)/);
  // Its label is agentLabel(), which is 'gentle-shell' in gentle-deck (test/mode-model.test.ts).
  assert.match(agent, /el\('span', \{ class: 'tool-label' \}, agentLabel\(state\.config\)\)/);
  assert.doesNotMatch(agent, /'aria-label'/, 'the visible label stays the name');
  const rose = fn(workspacesJs, 'roseIcon');
  assert.match(rose, /icon\('rose'\)/);
  assert.match(rose, /classList\.add\('gs-rose'\)/);
});

test('S6, S7: a tight row collapses gentle-shell to the rose; the label hides only visually', () => {
  const label = own(workspacesCss, '.row.tight .gs-btn > .tool-label');
  assert.equal(label.clip, 'rect(0 0 0 0)');
  assert.equal(label.position, 'absolute');
  assert.equal(label.display, undefined, 'display: none would drop the accessible name');
  assert.deepEqual(own(workspacesCss, '.row.tight .gs-btn'), { width: '24px', padding: '0', 'justify-content': 'center' });
  // fitRow measures with the label shown; only when the actions do not all fit does it collapse
  // gentle-shell, measure again, and move to "Más" only what still does not fit.
  const fit = fn(workspacesJs, 'fitRow');
  assert.match(fit, /row\.classList\.remove\('tight'\)/);
  assert.match(fit, /row\.classList\.add\('tight'\)/);
  assert.ok(fit.indexOf("classList.remove('tight')") < fit.indexOf("classList.add('tight')"));
  assert.equal(fit.match(/inlineActionCount\(/g)?.length, 1, 'one counting rule, run per measure');
});

test('S7 preserved: an action that leaves the row keeps its icon and short text in "Más"', () => {
  const item = fn(workspacesJs, 'overflowItem');
  assert.match(item, /const sourceIcon = source\.querySelector\('svg\.icon'\);/);
  assert.match(item, /source\.querySelector\('\.tool-label'\)\?\.textContent \?\? source\.dataset\.label \?\? source\.textContent/);
  assert.match(item, /sourceIcon \? sourceIcon\.cloneNode\(true\) : source\.dataset\.icon \? icon\(source\.dataset\.icon\) : null/);
  // The rule that picks what stays inline is still the shared model.
  assert.match(workspacesJs, /import \{ NAME_MIN_PX, inlineActionCount, nameMinimum, showsMore \} from '\/features\/row-actions-model\.js';/);
});

test('S8: Sereno is the agent you delegate to, in es and en', () => {
  assert.deepEqual([es['delegate.menu'], es['delegate.title'], es['delegate.submit'], es['delegate.marked']], ['Delegar a Sereno', 'Delegar a Sereno', 'Delegar a Sereno', 'Delegar a Sereno ({count})']);
  assert.deepEqual([en['delegate.menu'], en['delegate.title'], en['delegate.submit'], en['delegate.marked']], ['Delegate to Sereno', 'Delegate to Sereno', 'Delegate to Sereno', 'Delegate to Sereno ({count})']);
  for (const language of LANGUAGES) {
    for (const [key, value] of Object.entries((MESSAGES as any)[language] as Record<string, string>)) {
      assert.doesNotMatch(value, /Delegar a (gentle-deck|Mirador)|Delegate to (gentle-deck|Mirador)/, `${language} ${key}`);
    }
  }
});

test('S8: the autopilot keeps its name; Sereno keeps watch and answers for you', () => {
  assert.equal(es['settings.night'], 'Piloto automático');
  assert.equal(es['settings.nightHint'], 'Sereno cuida mientras no estás.');
  assert.equal(en['settings.nightHint'], 'Sereno keeps watch while you’re away.');
  assert.equal(es['night.sereno'], 'Sereno responde por ti mientras no estás');
  assert.equal(en['night.sereno'], 'Sereno answers for you while you’re away');
});

test('S8: the Ajustes autopilot row shows the owl and the Sereno hint', { skip: NO_DESIGN }, () => {
  const night = SETTINGS_ROWS.find((row: any) => row.id === 'night') as any;
  assert.equal(night.icon, 'sereno');
  assert.equal(night.hintKey, 'settings.nightHint');
  assert.match(settingsJs, /class: 'set-hint', 'data-i18n': row\.hintKey/);
  assert.match(settingsJs, /class: 'set-text'/);
  assert.deepEqual(own(settingsCss, '.set-text'), own(artboard, '.set-text'));
  assert.deepEqual(own(settingsCss, '.set-hint'), own(artboard, '.set-hint'));
});

test('S8: the topbar chip and the Seguimiento strip show the owl and say Sereno answers for you', { skip: NO_DESIGN }, () => {
  // The chip's owl takes the chip's color, as in the artboard (.night-chip .sereno-ic { color: inherit }),
  // and index.html keeps its plain decorative icons (test/icons.test.ts).
  assert.match(page, /<span class="night-chip" id="night-chip" data-i18n-title="night\.sereno" hidden><svg class="icon" aria-hidden="true" focusable="false"><use href="#i-sereno"\/><\/svg>/);
  assert.equal(own(artboard, '.night-chip .sereno-ic').color, 'inherit');
  assert.doesNotMatch(page, /#i-moon/);
  const head = fn(nightJs, 'renderHead');
  assert.match(head, /class: 'night-strip-label', title: t\('night\.sereno'\) \}, serenoIcon\(\), t\('night\.title'\)\)/);
  assert.match(fn(nightJs, 'serenoIcon'), /icon\('sereno'\)[\s\S]*classList\.add\('sereno-ic'\)/);
  assert.deepEqual(own(css, '.sereno-ic'), { color: 'var(--accent)' });
});
