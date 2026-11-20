// Pins the gentle-deck theme to its artboard,
// design/mirador-theme/03-papel-y-tinta.html. Probes kept from the independent verification.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LANGUAGES, MESSAGES } from '../public/i18n.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const css = readFileSync('public/styles.css', 'utf8');
const artboard = readArtboard('design/mirador-theme/03-papel-y-tinta.html');
const page = readFileSync('public/index.html', 'utf8');

/** The custom properties of the first `:root<selector> { … }` block in `source`. */
function tokens(source: string, selector: string): Record<string, string> {
  const body = source.match(new RegExp(`:root${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

test('S1/S6: the light, dark and gentleman tokens match the artboard', { skip: NO_DESIGN }, () => {
  const themes = [['', ''], ['\\[data-theme="dark"\\]', '\\[data-theme="oscuro"\\]'], ['\\[data-theme="gentleman"\\]', '\\[data-theme="gentleman"\\]']];
  for (const [app, art] of themes) {
    const expected = tokens(artboard, art);
    assert.ok(Object.keys(expected).length > 20, `artboard tokens for ${art || 'light'}`);
    const actual = tokens(css, app);
    // The artboard calls the UI size --fs-base; the app names it --fs-ui.
    for (const [name, value] of Object.entries(expected)) if (name !== '--fs-base') assert.equal(actual[name], value, name);
  }
});

test('S2: four type sizes, and serif only for the reading text', () => {
  for (const size of ['--fs-sm: 12px', '--fs-ui: 13px', '--fs-read: 15px', '--fs-title: 18px']) assert.match(css, new RegExp(size));
  const serif = [...readFileSync('public/styles/overview.css', 'utf8').matchAll(/^([^{\n]+)\{[^}]*--font-read/gm)].map((m) => m[1].trim());
  assert.deepEqual(serif, ['.leftoff-read']);
});

// The app is Mirador in every mode: the window says so, and no
// message writes the name out, since it comes through {brand} (public/mode-model.js BRAND).
test('S3: the window is Mirador, with no inline script, and no message writes the name out', () => {
  assert.match(page, /<title>Mirador<\/title>/);
  assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)/);
  for (const language of LANGUAGES) {
    for (const [key, value] of Object.entries(MESSAGES[language])) {
      if (typeof value === 'string') assert.doesNotMatch(value, /Mirador/, `${language} ${key}`);
    }
  }
});

test('S7: the page keeps 720x560 at least and 2560 wide at most, centered', () => {
  assert.match(css, /body \{ min-width: 720px; min-height: 560px; max-width: 2560px; margin: 0 auto; \}/);
});

test('no custom property refers to itself, which would make it invalid and drop the size it sets', () => {
  const sheets = ['public/styles.css', ...readdirSync('public/styles').map((name) => `public/styles/${name}`)];
  for (const sheet of sheets) {
    for (const [declaration, name] of readFileSync(sheet, 'utf8').matchAll(/(--[\w-]+)\s*:[^;}]*/g)) {
      assert.doesNotMatch(declaration, new RegExp(`var\\(${name}\\s*[,)]`), `${sheet}: ${declaration}`);
    }
  }
});

/** The declarations of the first rule whose selector is exactly `selector`, as `name: value` pairs. */
function rule(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const launches = readFileSync('public/styles/launches.css', 'utf8');
const sidebarCss = readFileSync('public/styles/workspaces.css', 'utf8');

test('S2 fidelity: the topbar is 52px high with 16px sides, as the artboard grid row', { skip: NO_DESIGN }, () => {
  assert.match(rule(artboard, '.app')['grid-template-rows'], /^52px /);
  assert.equal(rule(css, '.topbar').height, '52px');
  assert.equal(rule(css, '.topbar').padding, rule(artboard, '.topbar').padding);
});

test('S2 fidelity: the columns nobody resized take the artboard clamps; a saved width still wins inline', { skip: NO_DESIGN }, () => {
  const [, sidebar, panel] = rule(artboard, '.layout')['grid-template-columns'].match(/^(clamp\([^)]*\)) minmax\(0, 1fr\) (clamp\([^)]*\))$/)!;
  assert.equal(rule(css, '.layout')['--sidebar-w'], sidebar);
  assert.equal(rule(css, '.layout')['--panel-w'], panel);
  // Under 1280px the artboard narrows the tree; the folded side keeps the drawer width of its var() fallback.
  const narrow = artboard.match(/@media \(max-width: 1279px\) \{\s*\.layout \{ grid-template-columns: (clamp\([^)]*\)) minmax\(0, 1fr\); \}/)![1];
  assert.equal(rule(css, '.layout.drawer-panel')['--sidebar-w'], narrow);
  assert.equal(rule(css, '.layout.drawer-panel')['--panel-w'], 'initial');
  assert.equal(rule(css, '.layout.drawer-sidebar')['--sidebar-w'], 'initial');
  assert.match(readFileSync('public/columns.js', 'utf8'), /\$\('#layout'\)\.style\.setProperty\(column\.variable, `\$\{width\}px`\);/);
});

test('S2 fidelity: buttons, small and ghost buttons and the body type match the artboard', { skip: NO_DESIGN }, () => {
  for (const name of ['min-height', 'padding']) assert.equal(rule(css, '.btn')[name], rule(artboard, '.btn')[name], `.btn ${name}`);
  for (const name of ['min-height', 'padding', 'font-size']) assert.equal(rule(css, '.btn.sm')[name], rule(artboard, '.btn.sm')[name], `.btn.sm ${name}`);
  assert.deepEqual(rule(css, '.btn.ghost, .btn.side-hide'), rule(artboard, '.btn.ghost'));
  assert.equal(rule(css, '.segmented .btn')['min-height'], rule(artboard, '.seg .btn')['min-height']);
  assert.equal(rule(css, 'html, body').font, 'var(--fs-ui)/1.5 var(--font-ui)');
  assert.equal(rule(artboard, 'html, body').font, 'var(--fs-base)/1.5 var(--font-ui)');
  // The sidebar head's Agregar and hide buttons are the artboard's small buttons.
  assert.deepEqual(rule(sidebarCss, '.sidebar-head .btn'), { 'min-height': '24px', padding: '0 9px', 'font-size': 'var(--fs-sm)' });
});

test('S2 fidelity: the launch notice is the artboard paper pill, with a small ghost close button', { skip: NO_DESIGN }, () => {
  const notice = rule(artboard, '.notice');
  const bar = rule(launches, '.launch-bar');
  for (const name of ['display', 'align-items', 'gap', 'min-height', 'padding', 'border-radius', 'font-size', 'font-variant-numeric']) assert.equal(bar[name], notice[name], `.launch-bar ${name}`);
  assert.equal(bar.background, 'var(--paper)');
  assert.equal(bar.border, '1px solid var(--rule)');
  assert.match(readFileSync('public/features/launch-progress.js', 'utf8'), /class: 'btn icon sm ghost launch-dismiss'/);
});

const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');

test('S3 fidelity: the sidebar head and its title are the artboard ones: 15px, 600, not uppercase', { skip: NO_DESIGN }, () => {
  for (const name of ['display', 'align-items', 'gap', 'padding']) assert.equal(rule(sidebarCss, '.sidebar-head')[name], rule(artboard, '.side-head')[name], `.sidebar-head ${name}`);
  const title = rule(sidebarCss, '.sidebar-head h2');
  for (const name of ['flex', 'margin', 'font-size', 'font-weight']) assert.equal(title[name], rule(artboard, '.side-head h2')[name], `.sidebar-head h2 ${name}`);
  assert.equal(title['text-transform'], undefined);
  assert.equal(title['letter-spacing'], undefined);
  assert.equal(title.color, undefined, 'the title is ink, not muted');
});

test('S3 fidelity: rows are 30px pills with a 6px gap, 16px of indent per level and a 12px caret', { skip: NO_DESIGN }, () => {
  const row = rule(artboard, '.row');
  for (const name of ['height', 'gap', 'border-radius']) assert.equal(rule(css, '.row')[name], row[name], `.row ${name}`);
  const [, step, base] = row.padding.match(/calc\(var\(--depth, 0\) \* (\d+)px \+ (\d+)px\)/)!;
  assert.match(workspacesJs, new RegExp(`padding-left:\\$\\{depth \\* ${step} \\+ ${base}\\}px`));
  assert.equal(rule(css, '.caret').width, rule(artboard, '.caret').width);
  assert.equal(rule(css, '.row:hover').background, 'var(--hover)');
  // The selected row is paper in every theme: the kept --row-selected token says so, and no theme overrides it.
  assert.deepEqual(rule(css, '.row.selected'), { ...rule(artboard, '.row.selected'), background: 'var(--row-selected)' });
  assert.equal(rule(artboard, '.row.selected').background, 'var(--paper)');
  assert.equal(tokens(css, '')['--row-selected'], 'var(--paper)');
  for (const theme of ['dark', 'gentleman']) assert.equal(tokens(css, `\\[data-theme="${theme}"\\]`)['--row-selected'], undefined, theme);
  assert.deepEqual(rule(css, '.row.selected .name'), rule(artboard, '.row.selected .name'));
  assert.doesNotMatch(css, /\.row\.selected\s*\{[^}]*flex-wrap/, 'the selected row stays on one line');
  // The tree is a list of pills: no line between workspace groups.
  assert.doesNotMatch(sidebarCss, /\.ws \+ \.ws/);
});

test('S3 fidelity: a workspace head reads "Dev  7 carpetas": a 600 name and a plain count', { skip: NO_DESIGN }, () => {
  const head = rule(artboard, '.ws-title');
  assert.equal(rule(sidebarCss, '.ws-row').gap, head.gap);
  assert.equal(rule(sidebarCss, '.ws-row')['margin-top'], head['margin-top']);
  assert.equal(rule(sidebarCss, '.ws-row .name')['font-weight'], head['font-weight']);
  assert.deepEqual(rule(sidebarCss, '.ws-row .count'), { ...rule(artboard, '.ws-title .count'), flex: 'none' });
  assert.match(workspacesJs, /plural\(getLanguage\(\), 'ws\.folderCount', /);
  for (const language of LANGUAGES) for (const form of ['one', 'other']) assert.ok(MESSAGES[language][`ws.folderCount.${form}`], `${language} ws.folderCount.${form}`);
});

test('the repo mark is a button that opens lazygit in its folder, without selecting the row', () => {
  assert.match(workspacesJs, /class: 'repo-btn', title: t\('tree\.openGit', \{ path \}\), 'aria-label': t\('tree\.openGit', \{ path \}\), onclick: \(e\) => \{ e\.stopPropagation\(\); openGitPanel\(folder, node\.name\); \}/);
  assert.match(workspacesJs, /ondblclick: \(e\) => e\.stopPropagation\(\)/, 'a double click on it does not also start an agent');
  for (const language of LANGUAGES) assert.match(MESSAGES[language]['tree.openGit'], /lazygit.*\{path\}/, `${language} tree.openGit`);
});

test('S3 fidelity: the repo mark is the 12px git icon, and "sin memoria" is the artboard pill', { skip: NO_DESIGN }, () => {
  assert.deepEqual(rule(css, 'svg.icon.repo'), { '--icon': 'var(--icon-sm)', color: rule(artboard, '.repo').color });
  assert.match(workspacesJs, /icon\('git'\)/);
  assert.doesNotMatch(workspacesJs + css, /repo-dot/);
  const chip = rule(sidebarCss, '.no-memory');
  for (const name of ['font-size', 'color', 'border', 'border-radius', 'padding', 'line-height']) assert.equal(chip[name], rule(artboard, '.nomem')[name], `.no-memory ${name}`);
});

test('S3 fidelity: state glyphs and the state tokens are the artboard ones', { skip: NO_DESIGN }, () => {
  for (const state of ['work', 'wait', 'done', 'sleep', 'err']) assert.deepEqual(rule(css, `.s-${state}`), rule(artboard, `.s-${state}`), `.s-${state}`);
  assert.deepEqual(rule(css, 'svg.glyph'), rule(artboard, '.glyph'));
});

test('S3 fidelity: row actions are small ghost buttons 2px apart with 16px icons', { skip: NO_DESIGN }, () => {
  assert.equal(rule(css, '.row-actions').gap, rule(artboard, '.row-actions').gap);
  const small = rule(artboard, '.btn.sm');
  for (const name of ['min-height', 'padding', 'font-size']) assert.equal(rule(css, '.row-actions .btn')[name], small[name], `.row-actions .btn ${name}`);
  assert.equal(rule(css, '.row-actions .btn').background, 'transparent');
  assert.equal(rule(css, '.row-actions .btn')['border-color'], 'transparent');
  assert.doesNotMatch(css, /\.row-actions \.btn > svg\.icon \{ --icon: 14px; \}/);
});

test('S3 fidelity: the "Más" menu is the artboard menu: 180px, 6px padding, 10px radius, 30px items with 16px icons', { skip: NO_DESIGN }, () => {
  const menu = rule(sidebarCss, '.ws-more-menu');
  for (const name of ['top', 'right', 'min-width', 'padding', 'border-radius', 'box-shadow']) assert.equal(menu[name], rule(artboard, '.menu')[name], `.ws-more-menu ${name}`);
  assert.equal(menu.background, 'var(--paper)');
  assert.equal(menu.border, '1px solid var(--rule)');
  const item = rule(sidebarCss, '.ws-more-item');
  for (const name of ['display', 'align-items', 'gap', 'min-height', 'padding', 'border-radius']) assert.equal(item[name], rule(artboard, '.menu-item')[name], `.ws-more-item ${name}`);
  assert.equal(item['font-size'], undefined, 'items keep the 13px UI size');
  assert.deepEqual(rule(sidebarCss, '.ws-more-item > svg.icon'), rule(artboard, '.menu-item .mi-g'));
});

test('S3 fidelity: the "Estados" footer gave way to the state filter in the head (S3)', () => {
  for (const selector of ['.side-foot', '.legend', '.chipbtn']) assert.doesNotMatch(sidebarCss, new RegExp(`\\${selector}\\b`), selector);
  assert.doesNotMatch(page, /data-slot="states"/);
  assert.match(page, /<div class="state-filter" data-slot="state-filter"><\/div>/);
});

/** Like rule(), but the selector must start its line, so `.x` never finds a descendant rule such as `.a .x`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const groupsCss = readFileSync('public/styles/terminal-groups.css', 'utf8');
const terminalsJs = readFileSync('public/terminals.js', 'utf8');

test('S4 fidelity: a pane head is the artboard one: 38px, grip, state pill, 600 title, mono place and a 26px close', { skip: NO_DESIGN }, () => {
  const head = own(css, '.pane-head');
  for (const name of ['position', 'display', 'align-items', 'gap', 'min-height', 'padding', 'border-radius']) assert.equal(head[name], own(artboard, '.pane-head')[name], `.pane-head ${name}`);
  assert.equal(head['font-size'], undefined, 'the head keeps the 13px UI size');
  assert.deepEqual(own(css, '.pane-head > svg.grip'), own(artboard, '.grip'));
  assert.deepEqual(own(css, '.st'), own(artboard, '.st'));
  assert.deepEqual(own(css, '.st > svg.icon'), { '--icon': 'var(--icon-sm)' });
  // The artboard title, plus the ellipsis that keeps the close button in a narrow pane.
  assert.deepEqual(own(css, '.pane-title'), { ...own(artboard, '.pane-title'), 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis' });
  // The place takes the room left, so it never pushes the close button out.
  assert.deepEqual(own(css, '.pane-head .cwd'), { flex: '1 1 0', ...own(artboard, '.cwd') });
  assert.deepEqual(own(css, '.close'), own(artboard, '.close'));
  assert.deepEqual(own(css, '.close:hover'), own(artboard, '.close:hover'));
  // Grip, pill, title, place, then the figures resources.js puts before the close button.
  assert.match(terminalsJs, /el\('div', \{ class: 'pane-head' \}, grip\(\), el\('span', \{ class: 'st', hidden: true \}\), el\('span', \{ class: 'kind' \}\), el\('span', \{ class: 'pane-title' \}, info\.title\), el\('span', \{ class: 'cwd', title: info\.cwd \}, placeLabel\(info\)\), closeButton\(\)\)/);
  // The pill says the sidebar's word for the state, from the same derivation (pane-status-model.js).
  assert.match(terminalsJs, /import \{ paneStatus \} from '\/pane-status-model\.js';/);
  assert.match(terminalsJs, /t\(`states\.label\.\$\{state\}`\)/);
});

test('S4 fidelity: the figures are the artboard sans tabular figures, not mono', { skip: NO_DESIGN }, () => {
  const res = own(css, '.pane-head .res-badge, .tab .res-badge');
  assert.equal(res['font-family'], 'var(--font-ui)');
  for (const name of ['font-size', 'color', 'font-variant-numeric']) assert.equal(res[name], own(artboard, '.res')[name], `.res-badge ${name}`);
});

test('S4 fidelity: a waiting pane and an error pane take their state border, after the active one', { skip: NO_DESIGN }, () => {
  const waiting = '.panes[data-layout="grid"] .pane.waiting';
  const error = '.panes[data-layout="grid"] .pane.error';
  assert.deepEqual(own(css, waiting), own(artboard, '.pane.waiting'));
  assert.deepEqual(own(css, error), own(artboard, '.pane.error'));
  const active = css.indexOf('.panes[data-layout="grid"] .pane.active {');
  assert.ok(active > 0 && css.indexOf(`${waiting} {`) > active && css.indexOf(`${error} {`) > active, 'the state border wins over the active border, as in the artboard');
});

test('S4 fidelity: the well is the artboard one: 7px radius, 6px margins and 10x12 padding that fit leaves out', { skip: NO_DESIGN }, () => {
  const well = own(artboard, '.well');
  const body = own(css, '.pane-body');
  for (const name of ['padding', 'border-radius', 'background']) assert.equal(body[name], well[name], `.pane-body ${name}`);
  // FitAddon reads the computed width and height of the xterm's parent: the content box only while
  // box-sizing is content-box (the page sets border-box everywhere else).
  assert.equal(body['box-sizing'], 'content-box');
  assert.equal(own(css, '.panes[data-layout="grid"] .pane-body').margin, well.margin);
  assert.deepEqual(own(css, '.pane-body .xterm'), { height: '100%' });
});

test('S4 fidelity: the group chip is the artboard 28px pill: caret, name and "2 terminales"', { skip: NO_DESIGN }, () => {
  const chip = own(groupsCss, '.term-group-head');
  for (const name of ['display', 'align-items', 'gap', 'min-height', 'padding', 'background', 'border', 'border-radius', 'cursor']) assert.equal(chip[name], own(artboard, '.group-name')[name], `.term-group-head ${name}`);
  assert.equal(chip['font-size'], undefined, 'the chip keeps the 13px UI size');
  assert.deepEqual(own(groupsCss, '.term-group-head:hover'), own(artboard, '.group-name:hover'));
  assert.equal(own(groupsCss, '.term-group-name')['font-weight'], own(artboard, '.group-name b')['font-weight']);
  assert.deepEqual(own(groupsCss, '.term-group-count'), own(artboard, '.group-name .n'));
  assert.match(terminalsJs, /count\.textContent = plural\(getLanguage\(\), 'termGroup\.terminals', records\.length\);/);
  assert.deepEqual(own(groupsCss, '.pane-group-head'), { 'grid-column': '1 / -1', display: 'flex', 'align-items': 'center', gap: own(artboard, '.group-head').gap, 'min-width': '0' });
});

test('S4 fidelity: the reorder hint and the sleeping chip sit in the group head as in the artboard', { skip: NO_DESIGN }, () => {
  assert.deepEqual(own(groupsCss, '.term-group-hint'), own(artboard, '.group-hint'));
  assert.equal(MESSAGES.es['termGroup.reorderHint'], artboard.match(/<span class="group-hint">([^<]+)<\/span>/)![1]);
  assert.ok(MESSAGES.en['termGroup.reorderHint']);
  const chip = own(groupsCss, '.panes .pane-group-head > .sleep-entry');
  for (const name of ['gap', 'min-height', 'padding', 'border', 'border-radius', 'color', 'font-size']) assert.equal(chip[name], own(artboard, '.sleep-chip')[name], `.sleep-entry ${name}`);
});

test('S4 fidelity: tabs are the artboard tabs: the strip, 30px tabs, the dragged tab and the 3px drop bar', { skip: NO_DESIGN }, () => {
  const strip = own(css, '.tabs');
  for (const name of ['display', 'align-items', 'gap', 'padding', 'background']) assert.equal(strip[name], own(artboard, '.tabs-demo')[name], `.tabs ${name}`);
  assert.deepEqual(own(css, '.tab'), own(artboard, '.tab'));
  assert.deepEqual(own(css, '.tab[aria-selected="true"]'), own(artboard, '.tab[aria-selected="true"]'));
  assert.deepEqual(own(groupsCss, '.tab.dragging'), own(artboard, '.tab.dragging'));
  const bar = own(groupsCss, '.tab[data-drop]::before');
  const drop = own(artboard, '.tab-drop');
  for (const name of ['width', 'border-radius', 'background']) assert.equal(bar[name], drop[name], `drop bar ${name}`);
  assert.equal(bar.top, drop.margin.split(' ')[0]);
  // The tab shows its agent's state glyph at the artboard size (14px), not the 12px mark.
  assert.deepEqual(own(css, '.tab > .term-mark > svg.icon'), { '--icon': 'inherit' });
});

/** Every rule whose selector starts its line and is exactly `selector`, merged in source order (later wins). */
function merged(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodies = [...source.matchAll(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
  assert.ok(bodies.length, `rule ${selector} is missing`);
  return Object.assign({}, ...bodies.map((body) => Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))));
}
const overviewCss = readFileSync('public/styles/overview.css', 'utf8');
const overviewJs = readFileSync('public/features/overview.js', 'utf8');
/** The artboard's rules under 1280px and under 960px, where the columns fold into drawers. */
const artboardUnder1280 = artboard.slice(artboard.indexOf('@media (max-width: 1279px)'), artboard.indexOf('@media (max-width: 959px)'));
const artboardUnder960 = artboard.slice(artboard.indexOf('@media (max-width: 959px)'), artboard.indexOf('@media (max-height: 760px)'));

test('S5 fidelity: the panel head is the artboard one: a 12px crumb over the 18px title, then the view switch', { skip: NO_DESIGN }, () => {
  for (const name of ['display', 'gap', 'padding', 'border-bottom']) assert.equal(own(css, '.panel-head')[name], own(artboard, '.panel-head')[name], `.panel-head ${name}`);
  assert.deepEqual(own(css, '.crumb'), own(artboard, '.crumb'));
  assert.deepEqual(own(css, '.panel-title h2'), own(artboard, '.panel-title h2'));
  assert.match(css, /:root\[data-theme="gentleman"\] \.crumb \{ color: var\(--accent\); \}/);
  assert.match(page, /<div class="panel-title">\s*<p class="crumb" id="panel-crumb" translate="no"><\/p>\s*<h2 id="panel-heading"><\/h2>/);
  // The view switch sits in the head under the title, as the artboard's .seg, and the body follows the head.
  const head = page.indexOf('<div class="panel-head">');
  const views = page.indexOf('data-slot="panel-views"');
  const body = page.indexOf('<div class="panel-body" id="panel-body">');
  assert.ok(head > 0 && views > head && body > views && page.lastIndexOf('</div>', body) > views);
  assert.equal(own(css, '.panel-views')['justify-self'], 'start');
  // The hide button is the artboard's small ghost button.
  assert.deepEqual(own(css, '.btn.side-hide'), own(artboard, '.btn.sm'));
});

test('S5 fidelity: the panel body is the artboard column: 16px padding and 18px between its parts', { skip: NO_DESIGN }, () => {
  const body = merged(css, '.panel-body');
  const art = merged(artboard, '.panel-body');
  for (const name of ['min-height', 'padding', 'flex', 'display', 'flex-direction', 'gap', 'overflow']) assert.equal(body[name], art[name], `.panel-body ${name}`);
  assert.equal(own(overviewCss, '.overview-leftoff').gap, art.gap);
});

test('S5 fidelity: folds, their lists and the context foot match the artboard; the call button is small', { skip: NO_DESIGN }, () => {
  const list = own(artboard, '.fold-list');
  assert.equal(own(overviewCss, '.leftoff-fold-body').padding, list.padding);
  assert.deepEqual(own(overviewCss, '.leftoff-fold-body > .md > ul'), { margin: '0', 'padding-left': '0' });
  assert.deepEqual(own(overviewCss, '.leftoff-fold-body li + li'), own(artboard, '.fold-list li + li'));
  const foot = own(overviewCss, '.leftoff-foot');
  const art = own(artboard, '.panel-foot');
  for (const name of ['display', 'flex-wrap', 'align-items', 'gap', 'padding-top', 'font-size', 'color']) assert.equal(foot[name], art[name], `.leftoff-foot ${name}`);
  assert.match(overviewJs, /class: 'btn sm primary', onclick: \(\) => activateTerminal\(item\.terminalId\)/);
  // The title says "Dónde quedó" now: the card does not repeat it.
  assert.doesNotMatch(overviewJs, /el\('h3', \{\}, t\('overview\.leftOff'\)\)/);
});

test('S5 fidelity: under 1280px the panel is the artboard sheet over the terminals, opened from the topbar i-panel button', { skip: NO_DESIGN }, () => {
  const panel = own(artboardUnder1280, '.panel');
  const drawer = own(css, '.layout.drawer-panel > .panel');
  for (const name of ['position', 'z-index', 'right', 'bottom', 'box-shadow', 'transform', 'visibility']) assert.equal(drawer[name], panel[name], `panel drawer ${name}`);
  assert.equal(panel.width, 'min(400px, calc(100% - 64px))');
  assert.equal(drawer.width, 'min(var(--panel-w, 400px), calc(100% - 64px))');
  const open = own(css, '.layout[data-open="panel"] > .panel');
  const artOpen = own(artboardUnder1280, '.app[data-open="panel"] .panel');
  for (const name of ['transform', 'visibility']) assert.equal(open[name], artOpen[name], `open panel ${name}`);
  const scrim = own(css, '.layout[data-open] > .drawer-scrim');
  const artScrim = own(artboardUnder1280, '.app[data-open] .scrim');
  for (const name of ['display', 'position', 'z-index', 'background']) assert.equal(scrim[name], artScrim[name], `scrim ${name}`);
  assert.equal(own(css, '.layout.drawer-panel')['grid-template-columns'], 'var(--sidebar-w, 300px) minmax(0, 1fr)');
});

test('S5 fidelity: under 960px the sidebar is the artboard sheet too, opened from the topbar i-sidebar button', { skip: NO_DESIGN }, () => {
  const sidebar = own(artboardUnder960, '.sidebar');
  const drawer = own(css, '.layout.drawer-sidebar > .sidebar');
  for (const name of ['position', 'z-index', 'left', 'bottom', 'box-shadow', 'transform', 'visibility']) assert.equal(drawer[name], sidebar[name], `sidebar drawer ${name}`);
  assert.equal(sidebar.width, 'min(320px, calc(100% - 64px))');
  assert.equal(drawer.width, 'min(var(--sidebar-w, 320px), calc(100% - 64px))');
  const open = own(css, '.layout[data-open="sidebar"] > .sidebar');
  const artOpen = own(artboardUnder960, '.app[data-open="side"] .sidebar');
  for (const name of ['transform', 'visibility']) assert.equal(open[name], artOpen[name], `open sidebar ${name}`);
  assert.equal(own(css, '.layout.drawer-sidebar')['grid-template-columns'], 'minmax(0, 1fr)');
  // The slide is the artboard's transition, only when the user has not asked for less motion.
  const motion = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: no-preference)'));
  assert.match(motion, /\.layout\.drawer-sidebar > \.sidebar, \.layout\.drawer-panel > \.panel \{ transition: transform 0\.18s ease, visibility 0s 0\.18s; \}/);
  assert.match(motion, /\.layout\[data-open="sidebar"\] > \.sidebar, \.layout\[data-open="panel"\] > \.panel \{ transition: transform 0\.18s ease; \}/);
});

test('S5 fidelity: the drawer buttons are the artboard 32px icon buttons, the sidebar one before the brand', { skip: NO_DESIGN }, () => {
  const sideButton = page.indexOf('class="btn icon icon-btn side-show show-side"');
  const panelButton = page.indexOf('class="btn icon icon-btn side-show show-panel"');
  // The brand is the credits button.
  assert.ok(sideButton > 0 && sideButton < page.indexOf('<button type="button" class="brand"'));
  assert.ok(panelButton > page.indexOf('id="topbar-memory"') && panelButton < page.indexOf('<div class="settings">'));
  assert.match(page, /show-side" data-side="sidebar"[^>]*><svg class="icon" aria-hidden="true" focusable="false"><use href="#i-sidebar"\/><\/svg><\/button>/);
  assert.equal(MESSAGES.es['side.show.sidebar'], artboard.match(/class="btn icon-btn show-side"[^>]*aria-label="([^"]+)"/)![1]);
  assert.equal(MESSAGES.es['side.show.panel'], artboard.match(/class="btn icon-btn show-panel"[^>]*aria-label="([^"]+)"/)![1]);
  assert.equal(MESSAGES.es['side.hide.panel'], artboard.match(/aria-label="(Ocultar el panel)"/)![1]);
  for (const key of ['side.show.sidebar', 'side.show.panel', 'side.hide.panel']) assert.ok(MESSAGES.en[key], key);
});
