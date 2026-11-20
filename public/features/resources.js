// RAM and CPU of Mirador's agents, the machine's free memory and the gentle-shells running
// outside Mirador. One poller of GET /api/resources
// while the window is visible; each answer emits `resources`.
// - Development: every element with `data-terminal-id` (the tab, and the pane, whose head
//   takes the figures) gets a compact "RAM + swap · CPU" badge before its close button,
//   updated in place on each answer and on the `terminals` and `activate` events. An
//   element without the attribute is left alone.
// - The topbar's one figure (#topbar-memory) is Seguimiento's
//   free-memory line without its swap part, updated on each answer.
// - Seguimiento (public/features/tracking.js) shows the strip's memory line, a line per
//   agent card and the dock's "Usage" pane through the helpers below, all updated in place
//   so a poll never rebuilds what has the keyboard.
// - On macOS the answer carries `limits: { available: false }`: the pane says the limits are not
//   available there (no systemd scopes or cgroups) instead of showing an error.
// Rules and formatting live in resources-model.js.
import { $, api, el, emit, errorText, getLanguage, on, richText, state, t } from '/core.js';
import { LOW_MEMORY_SHARE, formatBytes, formatCpu, heaviestFirst, machineMemory, outsideTotal, usageOf } from '/features/resources-model.js';
import { icon } from '/icons.js';
import { showsExtra } from '/mode-model.js';

const POLL_MS = 10_000;
/** Agents the dock's "Usage" pane lists. */
const HEAVIEST = 8;

let snapshot = null;
let failure = null;
let timer = null;

/** The last GET /api/resources answer, or null until one arrives. */
export const resourceSnapshot = () => snapshot;

const entryOf = (id) => snapshot?.terminals?.find((entry) => entry.id === id);
const bytes = (value) => formatBytes(value, getLanguage());
const seconds = () => Math.round((snapshot?.cpuWindowMs ?? snapshot?.sampleMs ?? POLL_MS) / 1000);

/** "RAM 1,1 GB + 0,4 GB swap · CPU 3 %": the memory part, then the CPU part once two samples exist. */
function usageText(usage) {
  const memory = usage.swap ? t('resources.memorySwap', { memory: bytes(usage.memory), swap: bytes(usage.swap) }) : t('resources.memory', { memory: bytes(usage.memory) });
  const cpu = formatCpu(usage.cpu, getLanguage());
  return cpu === null ? memory : `${memory} · ${t('resources.cpu', { cpu })}`;
}

const usageTitle = (usage) => t('resources.usage.title', { usage: usageText(usage), seconds: seconds() });

/* ---------- Polling ---------- */

async function refresh() {
  try {
    snapshot = await api('GET', '/api/resources');
    failure = null;
  } catch (error) {
    // An older server without the route, or a failed read: the figures disappear.
    snapshot = null;
    failure = errorText(error);
  }
  decorateTerminals();
  fillTopbar();
  emit('resources', snapshot);
}

function fillTopbar() {
  const figure = $('#topbar-memory');
  if (figure) fillMemoryItem(figure, { topbar: true });
}

function start() {
  if (timer || document.visibilityState !== 'visible') return;
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/* ---------- Development: tabs and pane heads ---------- */

/** Puts or updates the badge of every `[data-terminal-id]` element; removes it while there is no figure. */
function decorateTerminals() {
  for (const node of document.querySelectorAll('[data-terminal-id]')) {
    const host = node.classList.contains('pane') ? node.querySelector(':scope > .pane-head') : node;
    if (!host) continue;
    let badge = host.querySelector(':scope > .res-badge');
    const usage = usageOf(entryOf(node.dataset.terminalId));
    if (!usage) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = el('span', { class: 'res-badge' });
      host.insertBefore(badge, host.querySelector(':scope > .close'));
    }
    const cpu = formatCpu(usage.cpu, getLanguage());
    badge.textContent = cpu === null ? t('resources.tab.noCpu', { total: bytes(usage.total) }) : t('resources.tab', { total: bytes(usage.total), cpu });
    badge.title = usageTitle(usage);
  }
}

/* ---------- Seguimiento: strip, cards and the "Usage" pane ---------- */

/**
 * Fills a memory item `node` (the strip's <li>, the topbar's <span>), warning below LOW_MEMORY_SHARE; hidden while unknown.
 * The `topbar` figure is the design's one figure: free memory without the swap part, its label
 * ("Memoria libre") in a .mem-label that hides under 960px (styles/settings.css).
 */
export function fillMemoryItem(node, { topbar = false } = {}) {
  const memory = machineMemory(snapshot?.machine);
  node.hidden = !memory;
  if (!memory) return node.replaceChildren();
  node.className = `res-memory${memory.low ? ' low' : ''}`;
  node.title = t('resources.strip.title', { percent: Math.round(LOW_MEMORY_SHARE * 100) });
  const [label, ...line] = richText(memory.low ? 'resources.strip.low' : 'resources.strip', { free: el('strong', {}, bytes(memory.available)), total: bytes(memory.total) });
  node.replaceChildren(
    memory.low ? icon('error') : '',
    topbar && typeof label === 'string' && label ? el('span', { class: 'mem-label' }, label) : label,
    ...line,
    topbar || memory.swapUsed === null ? '' : ` · ${t('resources.strip.swap', { swap: bytes(memory.swapUsed) })}`,
  );
}

/** An agent card's usage line; empty and hidden until the agent has figures. */
export function usageLine(id) {
  const line = el('span', { class: 'res-line', 'data-usage-id': id });
  fillUsageLine(line);
  return line;
}

function fillUsageLine(line) {
  const usage = usageOf(entryOf(line.dataset.usageId));
  line.hidden = !usage;
  line.textContent = usage ? usageText(usage) : '';
  line.title = usage ? usageTitle(usage) : '';
}

/** Updates in place every card usage line under `root`. */
export function refreshUsageLines(root) {
  root.querySelectorAll('[data-usage-id]').forEach(fillUsageLine);
}

/** The pane's persistent parts, built once inside its scroll region. */
let paneParts = null;

function paneSkeleton(body) {
  if (paneParts?.body === body) return paneParts;
  const outsideSummary = el('summary', { 'data-focus': 'usage-outside' });
  const outsideList = el('div', { class: 'res-outside-body' });
  paneParts = {
    body,
    status: el('div', { class: 'res-status' }),
    heaviestTitle: el('h4', { class: 'tracking-sub' }),
    heaviest: el('ol', { class: 'res-heaviest' }),
    server: el('p', { class: 'muted tracking-small' }),
    outside: el('details', { class: 'res-outside' }, outsideSummary, outsideList),
    outsideSummary,
    outsideList,
  };
  body.replaceChildren(paneParts.status, paneParts.heaviestTitle, paneParts.heaviest, paneParts.server, paneParts.outside);
  return paneParts;
}

/**
 * Fills the dock's "Usage" pane inside `body` (a persistent region): the heaviest agents
 * (`describe(id)` → { title, chip, here } or null for an unknown one; `pick(id)` jumps to
 * one this window shows), the server, and the gentle-shells outside Mirador in a closed <details>
 * that keeps its state and focus across polls.
 */
export function renderUsagePane(body, { describe, pick }) {
  const parts = paneSkeleton(body);
  const focused = body.contains(document.activeElement) ? document.activeElement.dataset?.focus : undefined;
  // macOS (GET /api/resources `limits`): no scopes or cgroups, so no limits and no per-agent figures; said once, not as an error.
  const noLimits = snapshot?.limits?.available === false;
  parts.status.replaceChildren(
    ...(snapshot ? [] : [el('p', { class: failure ? 'tracking-error' : 'muted' }, failure ? t('resources.unavailable', { error: failure }) : t('resources.loading'))]),
    ...(noLimits ? [el('p', { class: 'tracking-note' }, t('resources.limits.macos'))] : []),
  );
  const shown = !!snapshot;
  for (const node of [parts.heaviestTitle, parts.heaviest, parts.server, parts.outside]) node.hidden = !shown;
  if (!shown) return;

  parts.heaviestTitle.textContent = t('resources.heaviest');
  const heaviest = heaviestFirst(snapshot.terminals, HEAVIEST).filter((usage) => describe(usage.id));
  parts.heaviest.replaceChildren(
    ...(heaviest.length
      ? heaviest.map((usage) => {
          const { title, chip, here } = describe(usage.id);
          const cpu = formatCpu(usage.cpu, getLanguage());
          // The pane is narrow: the agent's name shows, its workspace › folder and the full figures go in the tooltip.
          const tip = [chip, usageTitle(usage), here ? t('tracking.jump') : t('inbox.elsewhere')].join('\n');
          return el(
            'li',
            {},
            el(
              'button',
              { type: 'button', class: 'res-agent', 'data-focus': `usage:${usage.id}`, disabled: !here, title: tip, onclick: () => pick(usage.id) },
              el('span', { class: 'res-agent-name' }, title),
              el('span', { class: 'res-figure' }, bytes(usage.total)),
              el('span', { class: 'res-cpu' }, cpu === null ? '' : t('resources.cpuShort', { cpu })),
            ),
          );
        })
      : [el('li', { class: 'tracking-empty' }, t('resources.heaviest.empty'))]),
  );

  const server = usageOf({ memory: snapshot.server?.rss, swap: snapshot.server?.swap });
  parts.server.hidden = !server;
  parts.server.textContent = server ? t('resources.server', { usage: usageText(server) }) : '';

  // Plain mode does not map gentle-shell processes (public/mode-model.js): the <details> stays hidden.
  const outside = showsExtra(state.config, 'gentleProcesses') ? outsideTotal(snapshot.outside) : null;
  parts.outside.hidden = !outside;
  if (outside) {
    const key = outside.count === 1 ? 'resources.outside.one' : 'resources.outside.other';
    parts.outsideSummary.textContent = outside.count ? t(key, { count: outside.count, total: bytes(outside.total) }) : t('resources.outside.none');
    const processes = snapshot.outside.processes ?? [];
    parts.outsideList.replaceChildren(
      el('p', { class: 'tracking-note' }, t('resources.outside.note')),
      el(
        'ul',
        { class: 'res-outside-list' },
        ...processes.map((p) =>
          el('li', {}, el('span', { class: 'res-cwd', title: p.cwd ?? '' }, p.cwd ?? t('resources.outside.noCwd')), el('span', { class: 'res-figure' }, bytes(p.memory + p.swap))),
        ),
      ),
      processes.length < outside.count ? el('p', { class: 'muted tracking-small' }, t('resources.outside.more', { shown: processes.length, count: outside.count })) : '',
    );
  }
  if (focused && !body.contains(document.activeElement)) body.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

export async function init() {
  on('terminals', decorateTerminals);
  on('activate', decorateTerminals);
  on('language', decorateTerminals);
  on('language', fillTopbar);
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? start() : stop()));
  start();
}
