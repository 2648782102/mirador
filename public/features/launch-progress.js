// Launch notice while gentle-deck opens agents. A pill
// at the top of the terminals sheet in Desarrollo and under the top bar in Seguimiento, which hides
// that sheet. It says how far the restore or a batch got,
// what it waits for and the free memory; it disables what would start one more pi, offers Pausar,
// and ends with the result (dismissable), naming where the agents it left asleep are when the
// sleeping list (sleeping.js) holds exactly those. It reads GET /api/terminals/launches once at start, on the `launches` event (a
// batch answered with a batchId) and when the window shows again, then every POLL_MS only while
// a run is active. The free memory outside a memory wait is the resources poller's (resources.js).
// - Blocking: while a run is active every element with data-launch-block gets aria-disabled and
//   the reason as tooltip, and a capture listener drops its clicks; the feature's own handlers
//   and `disabled` stay as they are. Anything else that opens an agent (a row's double click or
//   Enter) gets the server's 409 launches_running. The server holds the Claude calls itself.
// - workspaces.js emits `launches` after a batch answered with a batchId (it goes on in the server).
// - Agents the server opens meanwhile (the restore) appear as tabs without taking the active
//   terminal or the focus. Nodes are built once and updated in place: a poll never moves focus.
// Rules and text live in launch-progress-model.js.
import { $, api, el, errorText, getLanguage, on, prefs, slot, t, workspaceById } from '/core.js';
import { showAlert } from '/dialog.js';
import { icon } from '/icons.js';
import { POLL_MS, barText, launchBar, runLabel } from '/features/launch-progress-model.js';
import { formatBytes, machineMemory } from '/features/resources-model.js';
import { resourceSnapshot } from '/features/resources.js';
import { sleepingAgents } from '/features/sleeping.js';
import { activateTerminal, activeTerminalId, refitAll, showOpenedTerminals, terminalList } from '/terminals.js';

/** Dismissed results remembered by this window. */
const DISMISSED_KEEP = 40;

let status = null;
let active = false;
let timer = null;
let polling = null;
let pausing = false;
let parts = null;
let liveKey = '';
let observer = null;
/** Runs this window saw running: their result shows even when nothing went wrong. */
const seen = new Set();
const dismissed = new Set(prefs.read('launches.dismissed', []));
/** Each run's opened count at the last read, to notice agents the server opened since. */
const openedBefore = new Map();

const nameOf = (folder) => folder.rel || workspaceById(folder.workspaceId)?.name || folder.workspaceId;
const bytes = (value) => formatBytes(value, getLanguage());
const view = () => launchBar(status, { memAvailable: machineMemory(resourceSnapshot()?.machine)?.available ?? null, seen, dismissed, sleepingAgents: sleepingAgents() });

/* ---------- The notice ---------- */

function bar() {
  if (parts) return parts;
  // The working icon leads the line while agents open (styles/launches.css hides it afterwards).
  const working = icon('work');
  working.classList.add('launch-icon');
  const text = el('span', { class: 'launch-text' });
  const pause = el('button', { type: 'button', class: 'btn sm launch-pause', onclick: pauseAll });
  const dismiss = el('button', { type: 'button', class: 'btn icon sm ghost launch-dismiss', onclick: dismissResult }, icon('close'));
  // Screen readers hear the phase and the result, not every second of a countdown.
  const live = el('span', { class: 'launch-live', role: 'status' });
  const node = el('div', { class: 'launch-bar', role: 'region', hidden: true }, working, text, pause, dismiss, live);
  parts = { node, text, pause, dismiss, live };
  place();
  return parts;
}

/** Puts the notice in the view on screen: the terminals sheet, or under the top bar while #layout is hidden. */
function place() {
  const { node } = bar();
  const host = $('#layout').hidden ? slot('launches') : $('.workspace');
  if (node.parentElement === host) return;
  host.prepend(node);
  // The terminals lose or regain the notice's height.
  if (!node.hidden) refitAll();
}

function render() {
  const shown = view();
  const { node, text, pause, dismiss, live } = bar();
  if (node.hidden === !!shown) {
    node.hidden = !shown;
    // The terminals lose or regain the notice's height.
    refitAll();
  }
  if (!shown) return;
  const running = shown.phase === 'running';
  const line = barText(shown, { t, bytes, nameOf });
  node.dataset.phase = shown.phase;
  node.setAttribute('aria-label', t('launch.label'));
  text.textContent = line;
  text.title = line;
  const focusedPause = document.activeElement === pause;
  pause.hidden = !running;
  pause.textContent = t(pausing ? 'launch.pausing' : 'launch.pause');
  pause.title = t('launch.pauseTitle');
  // aria-disabled, not disabled: a disabled button would drop the keyboard focus.
  if (pausing) pause.setAttribute('aria-disabled', 'true');
  else pause.removeAttribute('aria-disabled');
  dismiss.hidden = running;
  dismiss.title = t('launch.dismiss');
  dismiss.setAttribute('aria-label', t('launch.dismiss'));
  if (focusedPause && !running) dismiss.focus({ preventScroll: true });
  const key = running ? 'running' : line;
  if (key !== liveKey) {
    liveKey = key;
    live.textContent = running ? t(runLabel(shown), { done: shown.done, total: shown.total }) : line;
  }
}

/* ---------- Polling ---------- */

function poll() {
  polling ??= read().finally(() => (polling = null));
  return polling;
}

async function read() {
  clearTimeout(timer);
  timer = null;
  try {
    status = await api('GET', '/api/terminals/launches');
  } catch {
    // An older server or a restart: no bar and nothing disabled.
    status = null;
  }
  for (const run of status?.runs ?? []) if (run.state === 'running') seen.add(run.id);
  setActive(!!status?.active);
  await showNewAgents();
  render();
  if (active && document.visibilityState === 'visible') timer = setTimeout(poll, POLL_MS);
}

/** Shows as tabs the agents the server opened since the last read, keeping the active terminal and the focus. */
async function showNewAgents() {
  const runs = status?.runs ?? [];
  const grew = runs.some((run) => run.opened > (openedBefore.get(run.id) ?? 0));
  openedBefore.clear();
  for (const run of runs) openedBefore.set(run.id, run.opened);
  if (!grew) return;
  let infos;
  try {
    infos = await api('GET', '/api/terminals');
  } catch {
    return; // They show at the next read.
  }
  const known = new Set(terminalList().map((info) => info.id));
  const fresh = infos.filter((info) => !known.has(info.id));
  if (!fresh.length) return;
  const focused = document.activeElement;
  const current = activeTerminalId();
  showOpenedTerminals(fresh);
  if (current) activateTerminal(current, false);
  if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected) focused.focus({ preventScroll: true });
}

/* ---------- What waits while agents open ---------- */

function block(node) {
  if (node.dataset.launchTitle === undefined) node.dataset.launchTitle = node.getAttribute('title') ?? '';
  node.setAttribute('aria-disabled', 'true');
  node.title = t('launch.blocked');
}

function unblock(node) {
  node.removeAttribute('aria-disabled');
  if (node.dataset.launchTitle) node.title = node.dataset.launchTitle;
  else node.removeAttribute('title');
  delete node.dataset.launchTitle;
}

function blockUnder(root) {
  if (root.matches?.('[data-launch-block]')) block(root);
  root.querySelectorAll?.('[data-launch-block]').forEach(block);
}

function setActive(next) {
  if (next === active) return;
  active = next;
  document.body.classList.toggle('launching', active);
  if (active) {
    blockUnder(document);
    // Rows and cards rebuilt while agents open come back disabled too.
    observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((added) => added.nodeType === 1 && blockUnder(added))));
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    observer?.disconnect();
    observer = null;
    pausing = false;
    document.querySelectorAll('[data-launch-block][aria-disabled]').forEach(unblock);
  }
}

function dropBlocked(event) {
  if (!active || !event.target.closest?.('[data-launch-block]')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/* ---------- Pausar and the result ---------- */

/** Pausar: every running run starts nothing more; the agents already open stay. */
async function pauseAll() {
  if (pausing || !active) return;
  const ids = (status?.runs ?? []).filter((run) => run.state === 'running').map((run) => run.id);
  pausing = true;
  render();
  let failure = null;
  for (const id of ids) {
    try {
      await api('POST', `/api/terminals/launches/${encodeURIComponent(id)}/cancel`);
    } catch (error) {
      // 404: that run ended meanwhile, which is what Pausar asked for.
      if (error.status !== 404) failure = error;
    }
  }
  if (failure) {
    pausing = false;
    showAlert(t('launch.pauseFailed', { error: errorText(failure) }));
  }
  await poll();
}

function dismissResult() {
  for (const id of view()?.runIds ?? []) dismissed.add(id);
  prefs.write('launches.dismissed', [...dismissed].slice(-DISMISSED_KEEP));
  const hadFocus = parts.node.contains(document.activeElement);
  render();
  const current = activeTerminalId();
  if (hadFocus && current) activateTerminal(current);
}

export async function init() {
  bar();
  // Seguimiento hides #layout (tracking.js); the notice follows the view.
  new MutationObserver(place).observe($('#layout'), { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('click', dropBlocked, true);
  document.addEventListener('dblclick', dropBlocked, true);
  on('launches', poll);
  on('resources', () => status && render());
  on('workspaces', () => status && render());
  on('sleeping', () => status && render());
  on('language', () => {
    if (active) blockUnder(document);
    render();
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());
  poll();
}
