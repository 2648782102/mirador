// Each gentle extra's entry point asks public/mode-model.js
// before it mounts or calls its route, and the brand follows the mode. In gentle-deck every
// check is true, so the page draws exactly as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../public/i18n.js';

const source = (path: string) => readFileSync(path, 'utf8');
const appJs = source('public/app.js');
const summaryJs = source('public/features/summary.js');
const overviewJs = source('public/features/overview.js');
const workspacesJs = source('public/features/workspaces.js');
const mcpJs = source('public/features/mcp.js');
const settingsJs = source('public/features/settings.js');
const trackingJs = source('public/features/tracking.js');
const resourcesJs = source('public/features/resources.js');
const terminalsJs = source('public/terminals.js');
const creditsJs = source('public/features/credits.js');
const helpJs = source('public/features/help.js');
const trackingCss = source('public/styles/tracking.css');

/** The source of `function name(…) { … }`, up to the next top-level closing brace. */
function fn(text: string, name: string): string {
  const start = text.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  return text.slice(start, text.indexOf('\n}\n', start) + 2);
}

/** The source of `const name = { … };`. */
function object(text: string, name: string): string {
  const start = text.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `const ${name}`);
  return text.slice(start, text.indexOf('\n};\n', start) + 3);
}

test('every feature reads the mode from the same model', () => {
  for (const [name, text] of Object.entries({ appJs, summaryJs, workspacesJs, settingsJs, trackingJs, resourcesJs, terminalsJs, creditsJs, helpJs })) {
    assert.match(text, /^import \{[^}]*\b(showsExtra|brandOf|agentLabel|helpSections)\b[^}]*\} from '\/mode-model\.js';$/m, name);
  }
});

test('the brand: the page title and the topbar brand take brandOf() once the config is read', () => {
  assert.match(fn(appJs, 'start'), /state\.config = boot\.config;\n\s*applyBrand\(\);/);
  const brand = fn(appJs, 'applyBrand');
  assert.match(brand, /document\.title = brandOf\(state\.config\);/);
  assert.match(brand, /\$\('#credits-open'\)\.lastChild\.textContent = brandOf\(state\.config\);/);
  assert.match(fn(terminalsJs, 'applyText'), /agent: el\('kbd', \{\}, agentLabel\(state\.config\)\)/);
});

test('memory: the panel offers only the views whose extra shows; Día, Resumen and Dónde quedó need memory', () => {
  assert.match(fn(summaryJs, 'renderPanel'), /const applicable = orderViews\(views, selection, \{ inbox: inboxView, daily: dailyView \}\)\.filter\(\(view\) => showsExtra\(state\.config, view\.extra\)\);/);
  assert.match(object(summaryJs, 'dailyView'), /\n  extra: 'memory',\n/);
  assert.match(summaryJs, /^const inboxView = \{ id: 'inbox', label: 'panel\.view\.inbox', applies: \(\) => true \};$/m, '"Te esperan" needs no extra');
  assert.match(object(overviewJs, 'workspaceView'), /\n  extra: 'memory',\n/);
  assert.match(object(overviewJs, 'leftOffView'), /\n  extra: 'memory',\n/);
});

test('memory: the tree\'s "sin memoria" tag shows only with memory', () => {
  assert.match(fn(workspacesJs, 'noMemoryBadge'), /return node\.hasMemory === false && showsExtra\(state\.config, 'memory'\) \?/);
});

test('translate: no extra translates memories; an opened memory is the same in every mode, for the browser to translate (S3)', () => {
  assert.doesNotMatch(summaryJs, /showsExtra\(state\.config, 'translate'\)/);
  assert.match(fn(summaryJs, 'itemView'), /details\.append\(markMemory\(el\('div', \{ class: 'memory-body' \}, renderMarkdown\(item\.content, memory\)\)\)\);/);
});

test('mcp: the row action carries its extra and the tree leaves it out when it does not show', () => {
  assert.match(mcpJs, /registerRowAction\(\{\n  id: 'mcp',\n[\s\S]*?\n  extra: 'mcp',\n[\s\S]*?\n\}\);/);
  assert.match(fn(workspacesJs, 'featureButtons'), /rowActionList\(\)\.filter\(\(action\) => !\(compact && action\.folderOnly\) && showsExtra\(state\.config, action\.extra\)\)/);
});

test('night: the settings row hides and GET /api/night is never polled without the extra', () => {
  const init = fn(settingsJs, 'init');
  const gate = init.indexOf("if (!showsExtra(state.config, 'night')) {");
  assert.ok(gate > 0, 'the night gate');
  assert.match(init.slice(gate), /^if \(!showsExtra\(state\.config, 'night'\)\) \{\n\s*nightSwitch\.closest\('\.set-row'\)\.hidden = true;\n\s*return;\n\s*\}/);
  assert.ok(init.indexOf('startPolling();') > gate, 'polling starts after the gate');
  assert.ok(init.indexOf("addEventListener('visibilitychange'") > gate, 'and so does its visibility restart');
});

test('night and memory in Seguimiento: no night parts, no activity read and no memory panes without them', () => {
  const refresh = fn(trackingJs, 'refresh');
  assert.match(refresh, /if \(showsExtra\(state\.config, 'night'\)\) refreshNight\(\);/);
  assert.match(refresh, /showsExtra\(state\.config, 'memory'\) \? api\('GET', `\/api\/activity\?date=\$\{encodeURIComponent\(state\.config\.today\)\}`\) : NO_ACTIVITY,/);
  const build = fn(trackingJs, 'build');
  assert.match(build, /const night = showsExtra\(state\.config, 'night'\) \? nightParts\(\) : \{\};/);
  assert.match(build, /const memory = showsExtra\(state\.config, 'memory'\);/);
  assert.match(build, /charts\.section, memory \? projects\.section : null, offLane\.section, usage\.section, memory \? healthPane\.section : null\)/);
  assert.match(fn(trackingJs, 'renderDock'), /showsExtra\(state\.config, 'memory'\) \? \[hoursChart\(\), statesChart\(model\), projectsChart\(model\)\] : \[statesChart\(model\)\]/);
  assert.match(trackingCss, /@media \(min-width: 901px\) \{\n  \.tracking-dock-panes\.plain \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}\n\}/);
});

test('gentleProcesses: the usage pane leaves out the gentle-shells outside Mirador without the extra', () => {
  assert.match(fn(resourcesJs, 'renderUsagePane'), /const outside = showsExtra\(state\.config, 'gentleProcesses'\) \? outsideTotal\(snapshot\.outside\) : null;/);
});

test('agent button: a row\'s agent button is labelled with agentLabel(), gentle-shell in gentle-deck', () => {
  const agent = fn(workspacesJs, 'terminalButtons').split('\n').find((line) => line.includes("openTerminal(folder, 'agent')"));
  assert.match(agent ?? '', /el\('span', \{ class: 'tool-label' \}, agentLabel\(state\.config\)\)/);
});

test('delegate dialog: no memory proposal, no "Mejorar con IA" and no sensitive check without their extras', () => {
  assert.match(fn(workspacesJs, 'sensitiveTopic'), /if \(!showsExtra\(state\.config, 'night'\)\) return null;/);
  assert.match(workspacesJs, /if \(instruction === null && showsExtra\(state\.config, 'memory'\)\) propose\(\);/);
  assert.match(workspacesJs, /el\('div', \{ class: 'proposal-bar' \}, proposal, showsExtra\(state\.config, 'improve'\) \? improve\.node : null\)/);
});

test('login: the session text names the app with brandOf(), and the brand fills it again once the config is read', () => {
  assert.match(fn(appJs, 'applyShellText'), /richText\('auth\.body', \{ brand: brandOf\(state\.config\), command: el\('code', \{\}, 'mirador'\) \}\)/);
  assert.match(fn(appJs, 'applyBrand'), /\n  applyShellText\(\);\n/);
});

test('credits button: its tooltip and accessible name name the app with brandOf() after the static text', () => {
  const body = fn(appJs, 'applyShellText');
  assert.match(body, /applyStaticText\(\);\n  const creditsLabel = t\('credits\.open', \{ brand: brandOf\(state\.config\) \}\);\n  \$\('#credits-open'\)\.setAttribute\('aria-label', creditsLabel\);\n  \$\('#credits-open'\)\.title = creditsLabel;/);
  for (const lang of ['en', 'es']) assert.match((MESSAGES as any)[lang]['credits.open'], /\{brand\}/, lang);
});

test('credits: the dialog heading and the crawl title name the app with brandOf()', () => {
  const titles = [...creditsJs.matchAll(/t\('credits\.title'[^\n]*?\}\)/g)].map((m) => m[0]);
  assert.deepEqual(titles, ["t('credits.title', { brand: brandOf(state.config) })", "t('credits.title', { brand: brandOf(state.config) })"]);
});

test('help: the guide draws the sections helpSections() keeps for the mode', () => {
  const guide = fn(helpJs, 'openGuide');
  assert.match(guide, /^function openGuide\(\) \{\n  const sections = helpSections\(state\.config, HELP_SECTIONS\);\n/);
  assert.equal(guide.split('HELP_SECTIONS').length, 2, 'the views and the nav tabs draw `sections`, never all of HELP_SECTIONS');
});
