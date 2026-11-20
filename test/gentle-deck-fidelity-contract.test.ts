// Pins the T6 corrections (blockers B1-B4 of L10, decision L11)
// to the artboard, design/mirador-theme/03-papel-y-tinta.html. Probes kept from the T5 verification.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../public/i18n.js';
// Namespace imports: a rule not built yet fails its own test, not the whole file.
import * as groupsModel from '../public/terminal-groups.js';
import * as panelModel from '../public/features/summary-model.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

const { gridTracks, groupTerminals } = groupsModel;
const { MIN_PANE_WIDTH, fitColumns } = groupsModel as any;
const { orderViews, viewParts, waitingCount } = panelModel as any;

const css = readFileSync('public/styles.css', 'utf8');
const settingsCss = readFileSync('public/styles/settings.css', 'utf8');
const trackingCss = readFileSync('public/styles/tracking.css', 'utf8');
const artboard = readArtboard('design/mirador-theme/03-papel-y-tinta.html');
const page = readFileSync('public/index.html', 'utf8');
const resourcesJs = readFileSync('public/features/resources.js', 'utf8');
const terminalsJs = readFileSync('public/terminals.js', 'utf8');

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** The text between the opening tag that contains `marker` and its matching close (same tag name). */
function element(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${marker} is missing`);
  const start = source.lastIndexOf('<', at);
  const tag = source.slice(start + 1).match(/^\w+/)![0];
  let depth = 0;
  for (const match of source.slice(start).matchAll(new RegExp(`<(/?)${tag}\\b`, 'g'))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return source.slice(start, start + match.index! + tag.length + 3);
  }
  throw new Error(`${marker} is not closed`);
}

test('S2: topbar 52px and 28px buttons; the tracking view no longer subtracts the old 44px topbar', { skip: NO_DESIGN }, () => {
  assert.equal(own(css, '.topbar').height, '52px');
  assert.equal(own(css, '.btn')['min-height'], own(artboard, '.btn')['min-height']);
  assert.equal(own(css, '.btn')['min-height'], '28px');
  assert.doesNotMatch(trackingCss, /calc\(100% - 44px\)/);
  // The flex column of the body sizes the view (styles.css), as it sizes #layout.
  assert.match(css, /\.layout, \.app-view \{ flex: 1 1 0; min-height: 0; \}/);
});

test('S2: drawer buttons keep 32px and the figure label hides under 960px (B2)', { skip: NO_DESIGN }, () => {
  const button = own(settingsCss, '.btn.icon-btn');
  assert.deepEqual([button.width, button['min-height'], button.flex], ['32px', '32px', 'none']);
  assert.match(page, /class="btn icon icon-btn side-show show-side"/);
  assert.match(page, /class="btn icon icon-btn side-show show-panel"/);
  // The artboard hides its "Memoria libre" label under 960px and keeps one figure.
  assert.match(artboard, /@media \(max-width: 959px\) \{[^@]*\.mem-label, \.group-hint \{ display: none; \}/);
  const under960 = settingsCss.slice(settingsCss.indexOf('@media (max-width: 959px)'));
  assert.match(under960, /\.topbar-figure \.mem-label \{ display: none; \}/);
  // The squeeze workaround of T4 is gone: the buttons no longer shrink, so nothing needs cutting.
  assert.doesNotMatch(settingsCss, /text-overflow: ellipsis/);
  // The topbar figure is free memory only, with its label in .mem-label; Seguimiento keeps the swap.
  assert.match(resourcesJs, /fillMemoryItem\(figure, \{ topbar: true \}\)/);
  assert.match(resourcesJs, /class: 'mem-label'/);
  assert.match(resourcesJs, /topbar \|\| memory\.swapUsed === null \? ''/);
});

test('S4: a pane head never pushes its close button out of the pane (B1)', { skip: NO_DESIGN }, () => {
  const title = own(css, '.pane-title');
  for (const [name, value] of Object.entries({ 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' })) assert.equal(title[name], value, `.pane-title ${name}`);
  assert.equal(own(css, '.pane-head .close').flex, 'none');
  // The place never overflows the head: it only takes the room left (zero basis).
  assert.deepEqual([own(css, '.pane-head .cwd').flex, own(css, '.pane-head .cwd')['min-width']], ['1 1 0', '0']);
  // The artboard: two terminals per row while each gets 300px.
  assert.match(artboard, /Two terminals per row while each gets 300px/);
  assert.equal(MIN_PANE_WIDTH, 300);
  const five = groupTerminals(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, workspaceId: 'dev', createdAt: id })), [{ id: 'dev', name: 'Dev' }]);
  // 1440x900 and 1280x800 leave the terminals about 760 and 670px: two columns, not three.
  assert.equal(gridTracks(five, [], 760).columns, 2);
  assert.equal(gridTracks(five, [], 670).columns, 2);
  assert.equal(gridTracks(five, [], 1150).columns, 3);
  for (let width = 641; width <= 2600; width += 7) {
    const { columns } = gridTracks(five, [], width);
    assert.ok((width - 20 - 8 * (columns - 1)) / columns >= MIN_PANE_WIDTH, `${width}px: ${columns} columns`);
    assert.equal(fitColumns(width) >= columns, true);
  }
  // The terminals module lays the grid out from the measured width of the terminals area.
  assert.match(terminalsJs, /gridTracks\(groups, collapsedGroups, panesWidth\)/);
});

test('S5: the panel head holds the crumb, title and view segment, not the date nav (B3)', { skip: NO_DESIGN }, () => {
  const head = element(page, '<div class="panel-head">');
  assert.match(head, /id="panel-crumb"/);
  assert.match(head, /id="panel-heading"/);
  assert.match(head, /data-slot="panel-views"/);
  assert.doesNotMatch(head, /date-nav|day-prev|day-input|day-today|show-all/);
  // The segment reads "Te esperan (N) | Dónde quedó | Día", as the artboard's.
  const segment = [...element(artboard, 'aria-label="Vistas del panel"').matchAll(/>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(segment, ['Te esperan (3)', 'Dónde quedó', 'Día']);
  assert.equal(MESSAGES.es['panel.view.inbox'].replace('{count}', '3'), segment[0]);
  assert.equal(MESSAGES.es['overview.view.folder'], segment[1]);
  assert.equal(MESSAGES.es['panel.view.daily'], segment[2]);
  assert.match(MESSAGES.en['panel.view.inbox'], /\{count\}/);
  const inbox = { id: 'inbox', applies: () => true };
  const daily = { id: 'daily', applies: () => true };
  const overview = { id: 'overview', applies: (s: { rel: string } | null) => s !== null && s.rel === '' };
  const leftoff = { id: 'leftoff', applies: (s: { rel: string } | null) => s !== null && s.rel !== '' };
  const ids = (views: Array<{ id: string }>) => views.map((v) => v.id);
  assert.deepEqual(ids(orderViews([overview, leftoff], { ws: 'dev', rel: 'web/zeta' }, { inbox, daily })), ['inbox', 'leftoff', 'daily']);
  assert.deepEqual(ids(orderViews([overview, leftoff], { ws: 'dev', rel: '' }, { inbox, daily })), ['inbox', 'overview', 'daily']);
  assert.deepEqual(ids(orderViews([overview, leftoff], null, { inbox, daily })), ['inbox', 'daily']);
  // N counts the agents that need an answer, not the finished turns, and, as the list below it,
  // not the terminal on screen (public/features/inbox.js inView).
  assert.equal(waitingCount([{ kind: 'blocked', terminalId: 'a' }, { kind: 'prompt', terminalId: 'b' }, { kind: 'finished', terminalId: 'c' }], null), 2);
  assert.equal(waitingCount([{ kind: 'blocked', terminalId: 'a' }, { kind: 'prompt', terminalId: 'b' }], 'a'), 1);
  assert.equal(waitingCount(undefined, null), 0);
});

test('B4: the sidebar starts at its Workspaces head, and the inbox slot lives in the panel', () => {
  const sidebar = element(page, '<aside class="sidebar" id="sidebar"');
  assert.doesNotMatch(sidebar, /data-slot="inbox"/);
  assert.match(sidebar, /^<aside[^>]*>\s*<div class="sidebar-head">/);
  const panel = element(page, '<aside class="panel" id="panel"');
  assert.match(panel, /<section class="inbox-slot" data-slot="inbox" hidden><\/section>/);
  assert.equal(viewParts('inbox').inbox, true);
  assert.equal(viewParts('inbox').body, false);
  for (const id of ['leftoff', 'overview', 'daily']) assert.deepEqual([viewParts(id).inbox, viewParts(id).body], [false, true], id);
  // An empty inbox says so in its view instead of leaving it blank.
  assert.ok(MESSAGES.es['inbox.empty'] && MESSAGES.en['inbox.empty']);
});

test('B3: the Día view holds the date nav, and only the Día view', () => {
  const panel = element(page, '<aside class="panel" id="panel"');
  const nav = element(panel, '<div class="date-nav" id="date-nav" hidden>');
  for (const id of ['day-prev', 'day-input', 'day-next', 'day-today', 'show-all']) assert.match(nav, new RegExp(`id="${id}"`));
  assert.ok(panel.indexOf('id="date-nav"') > panel.indexOf('<div class="panel-head">'));
  assert.equal(viewParts('daily').dateNav, true);
  for (const id of ['inbox', 'leftoff', 'overview']) assert.equal(viewParts(id).dateNav, false, id);
  assert.equal(own(css, '.date-nav[hidden], .inbox-slot[hidden], .panel-body[hidden]').display, 'none');
});
