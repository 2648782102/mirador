// Summary panel feature: hosts panel views for the folder of the active terminal, or the tree's
// selection (summary-model.js followPanel), behind the design's
// segment "Te esperan (N) | Dónde quedó | Día". The
// built-in "inbox" view shows the attention inbox (public/features/inbox.js fills its slot) and
// the built-in "daily" view, last, the date nav over the daily Engram summary of that folder,
// or the activity across projects when there is none. Other features add views with
// registerPanelView; they sit between the two.
import { $, api, el, errorText, getLanguage, on, prefs, select, slot, state, t, workspaceById } from '/core.js';
import { renderGlossary, renderMarkdown } from '/markdown.js';
import { buildGlossary, memoryLanguage } from '/memory-text.js';
import { displayTitle } from '/memory-health-model.js';
import { plural } from '/i18n.js';
import { showsExtra } from '/mode-model.js';
import { wireSide } from '/columns.js';
import { activePlace, activeTerminalId } from '/terminals.js';
import { chosenViewsFrom, fillPanel, followPanel, orderViews, pickView, segmentLabel, selectionCrumb, selectionKind, storedViews, viewParts, waitingCount } from '/features/summary-model.js';

let date = null;
let panelRequest = 0;
let started = false;
// Agents that need an answer, for "Te esperan (N)" (the `inbox` event).
let waiting = 0;
// The folder the panel shows (panel.place): the active terminal's, else the tree's selection. The
// events that can move it are settled once per turn, after every listener ran (follow, settle).
let panel = followPanel(null, placeNow(false));
let following = false;
let selectedSince = false;
let redrawSince = false;
// The chosen view is remembered per kind of selection (summary-model.js); the old single
// 'panelView' preference is migrated into 'panelViews' once and then removed.
const { views: chosenViews, save, dropLegacy } = chosenViewsFrom(prefs.read('panelViews', null), prefs.read('panelView', null));
if (save) prefs.write('panelViews', storedViews(chosenViews));
if (dropLegacy) {
  try {
    // prefs has no remove; same key as prefs.read('panelView').
    localStorage.removeItem('mirador.panelView');
  } catch {
    // Storage can be unavailable; preferences are a convenience only.
  }
}
const views = [];
const sections = [];

/**
 * Adds a view to the panel. `view` = { id, label (i18n key), applies(selection) → boolean,
 * render({ selection, date, setHeading(title, subtitle) }) → Promise<Node[]>, extra? }. `extra`
 * names the gentle extra it needs (public/mode-model.js): plain mode leaves the view out.
 * `selection` is { ws, rel } (rel '' = the workspace itself) or null. The segment in the panel
 * head offers "Te esperan (N)", then the views that apply in registration order, then "Día".
 */
export function registerPanelView(view) {
  views.push(view);
  if (started) renderPanel();
}

/**
 * Adds a block above the panel body for matching selections, whichever view shows.
 * `section` = { id, applies(selection), render({ selection, date }) → Promise<Node[]> };
 * a section that fails is left out so the view below still shows.
 */
export function registerPanelSection(section) {
  sections.push(section);
  if (started) renderPanel();
}

/** Re-renders the panel, e.g. after a view's data changed. */
export function refreshPanel() {
  renderPanel();
}

function parseEngramTime(value) {
  const [day, time = '00:00:00'] = value.split(/[ T]/);
  return new Date(`${day}T${time.split('.')[0]}Z`);
}

function timeOf(value) {
  return parseEngramTime(value).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
}

function shiftDay(day, days) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function setDate(next) {
  date = next;
  $('#day-input').value = next;
  $('#day-next').disabled = next >= state.config.today;
  renderPanel();
}

/** A segment button's text: "Te esperan (N)" counts the agents that need an answer. */
const viewLabel = (view) => (view.id === inboxView.id ? t(view.label, { count: waiting }) : t(view.label));

/**
 * A segment button's content: the label, which shortens with "…" when the panel is narrow, and its
 * count, which never does (styles.css .panel-views); the title shows the whole text.
 */
function labelParts(button, view) {
  const text = viewLabel(view);
  const { label, count } = segmentLabel(text);
  button.title = text;
  button.replaceChildren(...[el('span', { class: 'lbl' }, label), count && el('span', { class: 'n' }, count)].filter(Boolean));
}

function viewSwitch(applicable, current) {
  const host = slot('panel-views');
  // Rebuilding the buttons must not drop the keyboard of someone switching views.
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.view : undefined;
  host.hidden = applicable.length < 2;
  host.replaceChildren(
    ...applicable.map((view) => {
      const button = el('button', {
        type: 'button',
        class: 'btn',
        'data-view': view.id,
        'aria-pressed': String(view === current),
        onclick: () => {
          chosenViews[selectionKind(panel.place)] = view.id;
          prefs.write('panelViews', storedViews(chosenViews));
          renderPanel();
        },
      });
      labelParts(button, view);
      return button;
    }),
  );
  // Without scrolling: a plain focus() would scroll the panel sideways once a child is wider than it.
  if (focused) host.querySelector(`[data-view="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

/**
 * Updates "Te esperan (N)" in place: an inbox change never reloads the view on screen. The inbox
 * emits again whenever the terminal on screen changes (activate, visibility), so N follows its list.
 */
function countWaiting(items) {
  waiting = waitingCount(items, document.visibilityState === 'visible' ? activeTerminalId() : null);
  const button = slot('panel-views').querySelector(`[data-view="${inboxView.id}"]`);
  if (button) labelParts(button, inboxView);
}

/** What followPanel reads now: the active terminal, if any, and the tree's selection. */
function placeNow(selected) {
  const active = activePlace();
  return { selected, activeId: active ? activeTerminalId() : null, active, selection: state.selection };
}

/**
 * Notes an event that can move the panel: a selection (`selected`), an activation or a change of the
 * terminals. A workspace row enters its last terminal while its selection is emitted, so the panel
 * decides once both are in (settle). `redraw` renders even when the place stays (the workspaces).
 */
function follow(selected, redraw = false) {
  selectedSince ||= selected;
  redrawSince ||= redraw;
  if (following) return;
  following = true;
  queueMicrotask(settle);
}

/** Moves the panel to its place (followPanel), never touching the tree selection, and renders it only when it moved. */
function settle() {
  following = false;
  const redraw = redrawSince;
  panel = followPanel(panel, placeNow(selectedSince));
  selectedSince = false;
  redrawSince = false;
  if (panel.render || redraw) renderPanel();
}

async function renderPanel() {
  const request = ++panelRequest;
  const body = $('#panel-body');
  const selection = panel.place;
  const applicable = orderViews(views, selection, { inbox: inboxView, daily: dailyView }).filter((view) => showsExtra(state.config, view.extra));
  const view = pickView(applicable, chosenViews, selectionKind(selection));
  viewSwitch(applicable, view);
  // The view shows its parts: the inbox cards, or the body, under the date nav in "Día".
  const parts = viewParts(view.id);
  $('#date-nav').hidden = !parts.dateNav;
  slot('inbox').hidden = !parts.inbox;
  body.hidden = !parts.body;
  $('#show-all').hidden = selection === null;
  // The crumb names where the selection is; the title below it names what the view shows.
  $('#panel-crumb').textContent = selectionCrumb(selection, selection && workspaceById(selection.ws)?.name);
  const setHeading = (title, subtitle = '') => {
    if (request !== panelRequest) return;
    $('#panel-heading').textContent = title;
    $('#panel-subtitle').textContent = subtitle;
  };
  if (!parts.body) {
    // The inbox keeps its own cards up to date (public/features/inbox.js).
    setHeading(t('panel.inbox.title'));
    body.replaceChildren();
    return;
  }
  body.replaceChildren(el('p', { class: 'notice' }, t('common.loading')));
  try {
    // The view shows as soon as it is ready; the sections above it join when they resolve.
    await fillPanel(
      view.render({ selection, date, setHeading }),
      sections.filter((s) => s.applies(selection)).map((s) => s.render({ selection, date })),
      {
        show: (nodes) => request === panelRequest && body.replaceChildren(...nodes),
        insert: (nodes, before) => request === panelRequest && (before ? before.before(...nodes) : body.append(...nodes)),
      },
    );
  } catch (error) {
    if (request !== panelRequest) return;
    body.replaceChildren(el('p', { class: 'notice error' }, error.status === 503 ? t('error.engramDown') : errorText(error)));
  }
}

/**
 * renderMarkdown options for memories shown together: labels in the UI language and one
 * glossary from all of them, so a code defined in one memory explains it in another.
 */
export function memoryOptions(texts) {
  return { label: (key) => t(`memory.${key}`), glossary: buildGlossary(texts.filter(Boolean)) };
}

/** Title for a selection: the workspace name for its root, else the folder name. */
export function selectionTitle(selection) {
  if (!selection) return t('panel.activity');
  return selection.rel ? selection.rel.split('/').pop() : workspaceById(selection.ws)?.name ?? selection.ws;
}

/** The line under the title: the Engram project the folder logs to, the projects it holds, else its path. */
function projectLine(data) {
  if (data.project) return t('summary.project', { project: data.project.project, source: data.project.source });
  if (data.group?.projects.length) return t('summary.holds', { count: data.group.projects.length, projects: data.group.projects.join(', ') });
  return data.cwd;
}

/** The project line of a folder (GET /api/summary), for a view that shows it under its own title. */
export async function projectSubtitle(selection, day) {
  const query = new URLSearchParams({ ws: selection.ws, rel: selection.rel, date: day });
  return projectLine(await api('GET', `/api/summary?${query}`));
}

/** "Te esperan (N)": the inbox cards, first in the segment. */
const inboxView = { id: 'inbox', label: 'panel.view.inbox', applies: () => true };

const dailyView = {
  id: 'daily',
  label: 'panel.view.daily',
  applies: () => true,
  extra: 'memory',
  async render({ selection, date: day, setHeading }) {
    if (selection === null) {
      setHeading(t('panel.activity'), t('panel.activityHint'));
      return activityView(await api('GET', `/api/activity?date=${day}`));
    }
    // "Día": the chosen day of the folder or workspace. The crumb above already names the place.
    const title = t('panel.view.daily');
    setHeading(title);
    const query = new URLSearchParams({ ws: selection.ws, rel: selection.rel, date: day });
    const data = await api('GET', `/api/summary?${query}`);
    setHeading(title, projectLine(data));
    return summaryView(data);
  },
};

function activityView(data) {
  if (!data.projects.length) return [el('p', { class: 'notice' }, t('activity.empty'))];
  return [
    el(
      'ul',
      { class: 'project-list' },
      data.projects.map((p) =>
        el(
          'li',
          {},
          el('div', { class: 'head' }, el('span', { translate: 'no' }, p.project), el('span', { class: 'muted' }, t('activity.meta', { count: p.count, time: timeOf(p.lastAt) }))),
          el('ul', { class: 'titles' }, p.titles.slice(0, 4).map((title) => (String(title ?? '').trim() ? el('li', { lang: memoryLanguage(title) }, title) : el('li', {}, untitledView(null))))),
        ),
      ),
    ),
  ];
}

/**
 * Marks `node`, which holds Engram memory text, for the browser's own translator: it carries the
 * language the memory is written in (memoryLanguage: Spanish or English), so Brave or Chrome offer to
 * translate it only when it is not the reader's; its code and paths (`code`, `pre`) carry
 * translate="no", and its field labels and term notes keep the UI's language. Nothing is sent
 * anywhere. Returns `node`.
 */
export function markMemory(node) {
  const own = [...node.querySelectorAll('.mem-label, .mem-abbr-note')];
  const code = [...node.querySelectorAll('code, pre')];
  node.setAttribute('lang', memoryLanguage(node.textContent, [...own, ...code].map((part) => part.textContent)));
  for (const part of code) part.setAttribute('translate', 'no');
  for (const part of own) part.setAttribute('lang', document.documentElement.lang);
  return node;
}

/** An untitled memory: its first line (or "Untitled memory") in muted italics, never an empty row. */
function untitledView(text) {
  return el('em', { class: 'muted', title: t('item.untitledHint') }, text ?? t('item.untitled'));
}

function itemView(item, memory) {
  const shown = displayTitle(item.title, item.content);
  const details = el(
    'details',
    { class: 'item' },
    el(
      'summary',
      {},
      el('time', {}, timeOf(item.at)),
      shown.fallback ? untitledView(shown.text) : el('span', { lang: memoryLanguage(item.title) }, item.title),
      item.updated ? el('span', { class: 'badge' }, t('item.updated')) : null,
    ),
  );
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('.memory-body')) return;
    // The browser translates it when asked: Mirador sends memory text nowhere.
    details.append(markMemory(el('div', { class: 'memory-body' }, renderMarkdown(item.content, memory))));
  });
  return el('li', {}, details);
}

function groupView(group) {
  if (!group?.projects.length) return [el('p', { class: 'notice' }, t('group.noProject'))];
  const quiet = group.projects.filter((name) => !group.overview.some((p) => p.project === name));
  return [
    ...(group.overview.length ? activityView({ projects: group.overview }) : [el('p', { class: 'notice' }, t('group.noneActive'))]),
    quiet.length && group.overview.length ? el('p', { class: 'notice' }, t('group.quiet', { projects: quiet.join(', ') })) : null,
  ].filter(Boolean);
}

/** Known Engram types are translated; unknown ones keep the server's label. */
function typeLabel(group) {
  const key = `type.${group.type}`;
  return t(key) === key ? group.label : t(key);
}

function stat(count, key) {
  return el('span', { class: 'stat' }, el('strong', {}, String(count)), ` ${plural(getLanguage(), key, count)}`);
}

function summaryView(data) {
  if (!data.project) return groupView(data.group);
  const s = data.summary;
  const views = [
    el('div', { class: 'stats' }, stat(s.total, 'stat.memories'), stat(s.sessionCount, 'stat.sessions'), stat(s.sessionSummaries, 'stat.summaries')),
  ];
  if (!s.total && !s.sessionCount) {
    views.push(el('p', { class: 'notice' }, t('summary.empty')));
    return views;
  }
  const memory = memoryOptions([s.latestSummary?.content, ...s.groups.flatMap((group) => group.items.map((item) => item.content))]);
  if (s.latestSummary) {
    views.push(el('section', { class: 'card' }, el('h3', {}, t('summary.latest', { time: timeOf(s.latestSummary.at) })), markMemory(renderMarkdown(s.latestSummary.content, memory))));
  }
  for (const group of s.groups) {
    views.push(el('section', { class: 'group' }, el('h3', {}, `${typeLabel(group)} (${group.items.length})`), el('ul', {}, group.items.map((item) => itemView(item, memory)))));
  }
  const glossary = renderGlossary(memory);
  if (glossary) views.push(glossary);
  return views;
}

/** The panel hides from its own hide button and comes back from its topbar button (columns.js wireSide). */
function wirePanelToggle() {
  wireSide('panel');
}

export async function init() {
  wirePanelToggle();
  $('#day-prev').addEventListener('click', () => setDate(shiftDay(date, -1)));
  $('#day-next').addEventListener('click', () => setDate(shiftDay(date, 1)));
  $('#day-today').addEventListener('click', () => setDate(state.config.today));
  $('#day-input').addEventListener('change', (e) => e.target.value && setDate(e.target.value));
  $('#show-all').addEventListener('click', () => select(null));
  on('selection', () => follow(true));
  // The panel follows the active tab or grid pane, and goes back to the selection with no terminal.
  on('activate', () => follow(false));
  on('terminals', () => follow(false));
  on('language', renderPanel);
  on('workspaces', () => follow(false, true));
  on('inbox', countWaiting);
  started = true;
  panel = followPanel(null, placeNow(false));
  setDate(state.config.today);
}
