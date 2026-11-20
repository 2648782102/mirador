// The help guide (.help-dialog): what each state, icon, panel and
// shortcut means. Ajustes' "Ayuda" row (public/features/settings.js) and the "?" key open it.
// - The modal is the shared one (public/dialog.js): the page behind is inert, Escape closes it and
//   the focus goes back to what opened it.
// - A left nav picks one section; its counts are the entries of help-model.js, which also holds
//   the "?" rule (never while typing in a field or a terminal, nor over another dialog).
// - Plain mode leaves out the entries about night and memory (public/mode-model.js), so its
//   counts are the entries it draws.
import { el, state, t } from '/core.js';
import { openDialog } from '/dialog.js';
import { icon } from '/icons.js';
import { HELP_SECTIONS, opensGuide } from '/features/help-model.js';
import { helpSections } from '/mode-model.js';

/** An entry's icon in its rounded tile, colored like the button it explains. */
function iconTile(entry) {
  return el('span', { class: entry.tone ? `h-ic ${entry.tone}` : 'h-ic' }, icon(entry.icon));
}

/** A state card: its chip with a colored rail, what it means and "Qué haces". */
function stateCard(entry) {
  return el(
    'li',
    { class: `h-state s-${entry.state}` },
    el('span', { class: `st s-${entry.state}` }, icon(entry.icon), t(entry.nameKey)),
    el('p', { class: 'h-what' }, t(entry.whatKey)),
    el('p', { class: 'h-do' }, el('span', { class: 'h-do-label' }, t('help.state.doLabel')), t(entry.doKey)),
  );
}

function iconCard(entry) {
  return el('li', { class: 'h-tile' }, iconTile(entry), el('span', { class: 'h-tile-text' }, el('b', {}, t(entry.titleKey)), el('span', {}, t(entry.textKey))));
}

/** A panel card; the featured one (the autopilot) lists what Sereno does (✓) and never does (×). */
function panelCard(entry) {
  const limits = entry.limits
    ? el('ul', { class: 'h-limits' }, entry.limits.map((limit) => el('li', { class: limit.ok ? 'yes' : 'no' }, icon(limit.ok ? 'check' : 'close'), t(limit.key))))
    : null;
  return el(
    'li',
    { class: entry.featured ? 'h-panel featured' : 'h-panel' },
    entry.badgeKey ? el('span', { class: 'no-memory' }, t(entry.badgeKey)) : iconTile(entry),
    el('div', {}, el('h3', {}, t(entry.titleKey)), el('p', {}, t(entry.textKey)), limits),
  );
}

/** Keycaps: keys pressed together joined by "+", either of a nested list joined by "o". */
function keycaps(keys) {
  const parts = [];
  keys.forEach((key, i) => {
    if (i) parts.push(el('span', { class: 'plus' }, '+'));
    [key].flat().forEach((alternative, j) => {
      if (j) parts.push(el('span', { class: 'plus' }, t('help.keys.or')));
      parts.push(el('kbd', {}, alternative));
    });
  });
  return el('span', { class: 'keys' }, parts);
}

function keyCard(entry) {
  return el('li', { class: 'h-key' }, keycaps(entry.keys), el('span', {}, t(entry.textKey)));
}

const LISTS = {
  states: ['h-states', stateCard],
  icons: ['h-tiles', iconCard],
  panels: ['h-panels', panelCard],
  keys: ['h-keys', keyCard],
};

/** Opens the guide on "Estados", with the focus on its nav button. */
export function openGuide() {
  const sections = helpSections(state.config, HELP_SECTIONS);
  const views = sections.map((section, i) => {
    const [listClass, card] = LISTS[section.id];
    return el(
      'section',
      { id: `help-${section.id}`, 'data-help': section.id, 'aria-label': t(section.key), hidden: i > 0 },
      el('p', { class: 'h-lede' }, t(section.ledeKey)),
      el('ul', { class: listClass }, section.entries.map(card)),
    );
  });
  const body = el('div', { class: 'help-body' }, views);
  const tabs = sections.map((section, i) =>
    el(
      'button',
      { type: 'button', class: 'h-nav-btn', 'aria-pressed': String(i === 0), 'aria-controls': `help-${section.id}`, 'data-help-view': section.id, onclick: () => show(section.id) },
      icon(section.icon),
      el('span', {}, t(section.key)),
      el('span', { class: 'n' }, String(section.entries.length)),
    ),
  );
  const show = (id) => {
    tabs.forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.helpView === id)));
    views.forEach((view) => { view.hidden = view.dataset.help !== id; });
    body.scrollTop = 0;
  };
  return openDialog({
    title: [el('span', { class: 'help-badge' }, icon('help')), t('help.title')],
    body: [
      el('p', { class: 'help-intro' }, t('help.intro')),
      el('div', { class: 'help-main' }, el('div', { class: 'h-nav', role: 'group', 'aria-label': t('help.nav') }, tabs), body),
    ],
    actions: [],
    close: t('help.close'),
    initialFocus: tabs[0],
    className: 'help-dialog',
  });
}

/** Whether the focus is where "?" is text: a field, a contenteditable or a terminal. */
function typingIn(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export async function init() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const opens = opensGuide({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      composing: event.isComposing,
      defaultPrevented: event.defaultPrevented,
      typing: typingIn(target),
      inTerminal: !!target.closest?.('.xterm'),
      dialogOpen: !!document.querySelector('dialog[open]'),
    });
    if (!opens) return;
    event.preventDefault();
    openGuide();
  });
}
