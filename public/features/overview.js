// Overview feature: what is going on in a workspace and where each folder left off.
// Selecting a workspace offers a "Summary" view: the chosen day across its folders, then
// one row per folder (most recent work first) with its last worked date and where it
// stopped. Selecting a folder offers a "Where it left off" view from its latest Engram
// session summary, read in three levels (public/leftoff-model.js): act (an agent of the
// folder waiting for an answer), read (the objective) and context (a small footer), with
// next steps and accomplished folded behind a one-line gist. Both are views of the summary
// panel, between "Te esperan" and "Día"; nothing here edits it.
// The workspace view opens with the workspace mission, the Markdown guide the night
// shift reads, and lets the user edit it. The mission and each row's next steps show their first
// lines, with "Ver más" when there is more (clipBlock).
import { api, el, errorText, getLanguage, select, setWorkspaces, state, t, workspaceById } from '/core.js';
import { confirmDialog, openDialog, showAlert } from '/dialog.js';
import { plural } from '/i18n.js';
import { icon } from '/icons.js';
import { CLIP_LINES, clipOverflows, clipToggle, leftOffLayout, pageCount, pageKey, pageOffset, pagerView, pickCall, sourceKey, turnPage, waitedFor } from '/leftoff-model.js';
import { renderInline, renderMarkdown } from '/markdown.js';
import { memoryLanguage } from '/memory-text.js';
import { activateTerminal, openTerminal, terminalList } from '/terminals.js';
import { REASONS } from '/features/inbox.js';
import * as panel from '/features/summary.js';

/* ---------- Dates, in the UI language and the configured time zone ---------- */

const formats = new Map();

/** One Intl.DateTimeFormat per locale and option set: building one costs far more than using it. */
function format(options, locale = getLanguage()) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = formats.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options);
    formats.set(key, found);
  }
  return found;
}

/** Engram stores UTC times as "YYYY-MM-DD HH:MM:SS[.fraction]" without a zone. */
function engramDate(value) {
  const [day, time = '00:00:00'] = value.split(/[ T]/);
  return new Date(`${day}T${time.split('.')[0]}Z`);
}

function shiftDay(day, days) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A local day (YYYY-MM-DD) as "today", "yesterday" or a short date. */
function dayLabel(day) {
  const today = state.config.today;
  if (day === today) return t('overview.today');
  if (day === shiftDay(today, -1)) return t('overview.yesterday');
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return format({ timeZone: 'UTC', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(new Date(`${day}T12:00:00Z`));
}

/** "today · 16:28" for an Engram time and its local day. */
function whenLabel(at, day) {
  const time = format({ timeZone: state.config.timeZone, hour: '2-digit', minute: '2-digit' }).format(engramDate(at));
  return `${dayLabel(day)} · ${time}`;
}

/** The local day (YYYY-MM-DD) of an Engram time in the configured time zone, as the server computes it. */
function dayOf(at) {
  // en-CA formats dates as YYYY-MM-DD.
  return format({ timeZone: state.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(engramDate(at));
}

/* ---------- Shared pieces ---------- */

function truncatedNotice(data) {
  return data.truncated ? el('p', { class: 'notice overview-warn', role: 'status' }, t('overview.truncated')) : null;
}

/** Engram did not answer, so what shows comes only from the local records (`engramUnavailable` of GET /api/overview and /api/overview/folder). */
function engramDownNotice(data) {
  return data.engramUnavailable ? el('p', { class: 'notice overview-warn', role: 'status' }, t('overview.engramDown')) : null;
}

function startButton(folder) {
  return el(
    'button',
    { type: 'button', class: 'btn', onclick: (e) => { e.stopPropagation(); openTerminal(folder, 'agent'); } },
    t('overview.startAgent'),
  );
}

/** What a folder without a readable memory says instead of where it left off. */
function missingMemory(row, folder) {
  if (row.beyondWindow) return [el('p', { class: 'notice' }, t('overview.beyondWindow'))];
  if (row.hasMemory) return [el('p', { class: 'notice' }, t('overview.noRecent'))];
  return [el('p', { class: 'notice' }, t('overview.noMemory')), el('div', { class: 'overview-actions' }, startButton(folder))];
}

function sinceLine(leftOff) {
  const { summary, memory } = leftOff;
  if (!memory || (summary && memory.at <= summary.at)) return null;
  return el('p', { class: 'overview-since' }, t(summary ? 'overview.since' : 'overview.latestMemory', { title: memory.title }));
}

let fieldId = 0;

/**
 * `content` cut to its first CLIP_LINES[kind] lines and faded at the foot, with "Ver más" / "Ver menos"
 * under it only when it overflows (public/leftoff-model.js clipToggle).
 * Measured clipped again whenever the box or its text changes size, open or not.
 */
function clipBlock(content, kind) {
  const id = `overview-clip-${++fieldId}`;
  const box = el('div', { id, class: `overview-clip ${kind}` }, content);
  box.style.setProperty('--clip-lines', String(CLIP_LINES[kind]));
  const label = el('span', {}, t('overview.clip.more'));
  let open = false;
  let overflows = false;
  // A folder row opens its folder on click: the toggle keeps its own click (Enter and Space click it too).
  const toggle = el(
    'button',
    { type: 'button', class: 'btn sm ghost overview-clip-toggle', 'aria-controls': id, 'aria-expanded': 'false', hidden: true, onclick: (e) => { e.stopPropagation(); open = !open; show(); } },
    label,
    icon('chev-down', { size: 'sm' }),
  );
  function show() {
    const view = clipToggle(open, overflows);
    toggle.hidden = view.hidden;
    toggle.setAttribute('aria-expanded', String(view.expanded));
    label.textContent = t(view.label);
    box.classList.toggle('open', view.expanded);
    box.classList.toggle('clipped', view.clipped);
  }
  // On the next frame, as the objective's pages: measuring inside the callback would report a loop.
  const resize = new ResizeObserver(() => requestAnimationFrame(measure));
  function measure() {
    // The panel replaces its body on every render: a box that left it stops watching.
    if (!box.isConnected) {
      resize.disconnect();
      return;
    }
    box.classList.remove('open');
    overflows = clipOverflows(box.scrollHeight, box.clientHeight);
    show();
  }
  // The box for its width, the text for its height while the box is capped.
  resize.observe(box);
  resize.observe(content);
  document.fonts?.ready.then(() => box.isConnected && measure());
  return [box, toggle];
}

/* ---------- Workspace mission ---------- */

const MAX_MISSION = 8000;

/** Edits the mission in a dialog and saves it with PATCH; a blank text clears it. */
async function editMission(workspace) {
  const id = `mission-${++fieldId}`;
  const input = el('textarea', {
    id,
    class: 'mission-text',
    rows: 14,
    maxlength: MAX_MISSION,
    spellcheck: 'true',
    placeholder: t('overview.missionPlaceholder'),
    'aria-describedby': `${id}-hint ${id}-error`,
  });
  input.value = workspace.mission ?? '';
  const error = el('p', { class: 'field-error', id: `${id}-error`, role: 'alert' });
  let updated = null;
  await openDialog({
    title: t('overview.missionTitle', { name: workspace.name }),
    className: 'mission-dialog',
    body: [
      el(
        'div',
        { class: 'field' },
        el('label', { for: id }, t('overview.missionLabel')),
        input,
        el('p', { class: 'hint', id: `${id}-hint` }, t('overview.missionHint', { max: MAX_MISSION })),
        error,
      ),
    ],
    initialFocus: input,
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('overview.missionSave'), value: 'save', kind: 'primary', busyLabel: t('overview.missionSaving') },
    ],
    onAction: async () => {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
      try {
        updated = await api('PATCH', `/api/workspaces/${encodeURIComponent(workspace.id)}`, { mission: input.value });
        return true;
      } catch (failure) {
        error.textContent = errorText(failure);
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return false;
      }
    },
  });
  if (updated) setWorkspaces(state.workspaces.map((w) => (w.id === updated.id ? updated : w)));
}

function missionCard(workspace) {
  const mission = workspace.mission?.trim() ? workspace.mission : '';
  const edit = () => editMission(workspace);
  return el(
    'section',
    { class: 'card overview-mission' },
    el(
      'div',
      { class: 'overview-mission-head' },
      el('h3', {}, t('overview.mission')),
      mission
        ? el('button', { type: 'button', class: 'btn', title: t('overview.missionEditHint', { name: workspace.name }), onclick: edit }, t('overview.missionEdit'))
        : null,
    ),
    mission
      ? clipBlock(renderMarkdown(mission), 'mission')
      : [el('p', { class: 'notice' }, t('overview.missionEmpty')), el('div', { class: 'overview-actions' }, el('button', { type: 'button', class: 'btn', onclick: edit }, t('overview.missionWrite')))],
  );
}

/* ---------- Workspace view ---------- */

function stat(count, key) {
  return el('span', { class: 'stat' }, el('strong', {}, String(count)), ` ${plural(getLanguage(), key, count)}`);
}

function summaryCard(data, ws) {
  const s = data.summary;
  const card = el(
    'section',
    { class: 'card overview-summary' },
    el('h3', {}, t('overview.dayTitle', { date: dayLabel(data.date) })),
    el(
      'div',
      { class: 'stats' },
      el('span', { class: 'stat' }, t('overview.activeFolders', { active: s.activeFolders, count: s.folders })),
      stat(s.memories, 'overview.memories'),
      stat(s.sessions, 'overview.sessions'),
    ),
  );
  if (!s.headlines.length) {
    const latest = data.rows.find((row) => row.lastAt);
    card.append(el('p', { class: 'notice' }, t('overview.quietDay')));
    if (latest) card.append(el('p', { class: 'notice' }, t('overview.latestWork', { folder: latest.name, when: whenLabel(latest.lastAt, latest.lastDay) })));
    return card;
  }
  card.append(
    el('h4', {}, t('overview.headlines')),
    el(
      'ul',
      { class: 'overview-headlines' },
      s.headlines.map((h) =>
        el(
          'li',
          {},
          el('span', { lang: memoryLanguage(h.title) }, h.title),
          h.rel
            ? el('button', { type: 'button', class: 'overview-link', translate: 'no', title: t('overview.openFolder', { folder: h.folder }), onclick: () => select({ ws, rel: h.rel }) }, h.folder)
            : el('span', { class: 'muted', translate: 'no' }, h.folder),
        ),
      ),
    ),
  );
  return card;
}

/** A goal as written: Markdown when it spans lines (lists, paragraphs), else inline text. */
function goalText(goal, textOptions) {
  return goal.includes('\n') ? renderMarkdown(goal, textOptions) : el('span', {}, renderInline(goal, textOptions));
}

/** renderMarkdown options for the session summaries shown, with one glossary across them. */
function summaryOptions(summaries) {
  return panel.memoryOptions(summaries.filter(Boolean).flatMap((s) => [s.goal, s.nextSteps, s.accomplished, s.excerpt]));
}

function rowView(row, ws, textOptions) {
  const folder = { ws, rel: row.rel };
  const isRoot = row.rel === '';
  const open = () => select(folder);
  const head = el(
    'div',
    { class: 'overview-row-head' },
    isRoot
      ? el('span', { class: 'overview-name', translate: 'no' }, row.name)
      : el('button', { type: 'button', class: 'overview-name', translate: 'no', title: t('overview.openFolder', { folder: row.name }), onclick: (e) => { e.stopPropagation(); open(); } }, row.name),
    isRoot ? el('span', { class: 'no-memory' }, t('overview.rootBadge')) : null,
    row.day.memories ? el('span', { class: 'overview-day', title: t('overview.dayCountHint') }, t('overview.dayCount', { count: row.day.memories })) : null,
    row.lastAt ? el('span', { class: 'overview-when' }, whenLabel(row.lastAt, row.lastDay)) : null,
  );
  const { summary, memory } = row.leftOff;
  const body = [];
  if (summary) {
    // Engram text is marked with its language for the browser's translator (panel.markMemory).
    if (summary.goal) body.push(panel.markMemory(el('p', { class: 'overview-goal' }, renderInline(summary.goal, textOptions))));
    if (summary.nextSteps) {
      body.push(el('div', { class: 'overview-next' }, el('span', { class: 'overview-label' }, t('overview.nextSteps')), clipBlock(panel.markMemory(renderMarkdown(summary.nextSteps, textOptions)), 'next')));
    }
    // A free-form summary has no sections: its text, clipped by the server.
    if (summary.excerpt) body.push(el('div', { class: 'overview-next' }, panel.markMemory(renderMarkdown(summary.excerpt, textOptions))));
    // A local record where Claude Code has not answered yet: the user's last message, as plain text.
    if (!summary.goal && !summary.nextSteps && !summary.excerpt && summary.lastUserMessage) {
      body.push(el('p', { class: 'overview-since' }, `${t('overview.lastUserMessage')}: `, summary.lastUserMessage));
    }
    body.push(sinceLine(row.leftOff));
  } else if (memory) {
    body.push(el('p', { class: 'overview-since' }, t('overview.latestMemory', { title: memory.title })));
  } else {
    body.push(...missingMemory(row, folder));
  }
  const item = el('li', { class: `overview-row${isRoot ? ' root' : ''}${row.hasMemory ? '' : ' empty'}` }, head, ...body.filter(Boolean));
  if (!isRoot) item.addEventListener('click', open);
  return item;
}

const workspaceView = {
  id: 'overview',
  label: 'overview.view.workspace',
  applies: (selection) => selection !== null && selection.rel === '',
  extra: 'memory',
  async render({ selection, date, setHeading }) {
    const workspace = workspaceById(selection.ws);
    // The crumb above the title names the workspace (public/features/summary.js).
    setHeading(t('overview.view.workspace'), workspace?.root ?? '');
    const data = await api('GET', `/api/overview?${new URLSearchParams({ ws: selection.ws, date })}`);
    const textOptions = summaryOptions(data.rows.map((row) => row.leftOff.summary));
    return [
      workspace ? missionCard(workspace) : null,
      truncatedNotice(data),
      engramDownNotice(data),
      summaryCard(data, selection.ws),
      el(
        'section',
        { class: 'overview-folders' },
        el('h3', {}, t('overview.folders')),
        data.rows.length
          ? el('ul', { class: 'overview-rows' }, data.rows.map((row) => rowView(row, selection.ws, textOptions)))
          : el('p', { class: 'notice' }, t('overview.noFolders')),
      ),
    ].filter(Boolean);
  },
};

/* ---------- A folder: where it left off ---------- */

/** gentle-shell's blocker label as the inbox words it (public/features/inbox.js). */
function waitingReason(item) {
  return REASONS[item.label] ? t(REASONS[item.label]) : item.label || t('inbox.reason.question');
}

/** The inbox clears the terminal's waiting mark (terminals.js markWaiting) once it is answered: the call goes with it. */
function dropWhenAnswered(block, terminalId) {
  const tab = document.querySelector(`.tab[data-terminal-id="${CSS.escape(terminalId)}"]`);
  if (!tab) return;
  const watch = new MutationObserver(() => {
    if (tab.dataset.waiting !== undefined) return;
    watch.disconnect();
    block.remove();
  });
  watch.observe(tab, { attributes: true, attributeFilter: ['data-waiting'] });
}

/** Act: the agent of this folder that waits for an answer, the only colored block of the panel. */
function callBlock(item) {
  const id = `leftoff-call-${++fieldId}`;
  const here = terminalList().some((info) => info.id === item.terminalId);
  const waited = waitedFor(item.since);
  const block = el(
    'section',
    { class: 'leftoff-call', 'aria-labelledby': id },
    el('p', { class: 'leftoff-call-kicker', id }, icon('wait'), t('overview.call.kicker', { waited: t(waited.key, { count: waited.count }) })),
    el('p', { class: 'leftoff-call-text' }, waitingReason(item)),
    // A guarded command's dialog names the command: it reads as code.
    item.detail ? el(item.kind === 'blocked' ? 'code' : 'p', { class: 'leftoff-call-detail' }, item.detail) : null,
    el(
      'div',
      { class: 'leftoff-call-actions' },
      here
        ? el('button', { type: 'button', class: 'btn sm primary', onclick: () => activateTerminal(item.terminalId) }, t('overview.call.go'))
        : el('span', { class: 'muted' }, t('inbox.elsewhere')),
    ),
  );
  if (here) dropWhenAnswered(block, item.terminalId);
  return block;
}

function gistText(gist) {
  if (!gist) return null;
  return gist.more ? t(`overview.gist.${gist.kind}More`, { count: gist.count }) : plural(getLanguage(), `overview.gist.${gist.kind}`, gist.count);
}

/** A long section folded behind its title and a one-line gist; native details/summary, so Enter and Space toggle it. */
function foldView(fold, text, textOptions) {
  const caret = icon('chev-right', { size: 'sm' });
  caret.classList.add('leftoff-caret');
  const gist = gistText(fold.gist);
  const node = el(
    'details',
    { class: `leftoff-fold ${fold.id}` },
    el('summary', {}, caret, el('span', { class: 'leftoff-fold-title' }, t(fold.title)), gist ? el('span', { class: 'leftoff-fold-gist' }, gist) : null),
    el('div', { class: 'leftoff-fold-body' }, pagedBox(panel.markMemory(renderMarkdown(text, textOptions)), t(fold.title), 'fold')),
  );
  node.open = fold.open;
  return node;
}

/**
 * Text in fixed-height pages: the objective
 * and every fold's body. A long one turns like a book with ‹ n / m ›, the arrow keys or
 * PageUp/PageDown while the box has focus, and never pushes what is below it down; a short one shows
 * no pager and its box sizes to its text. The count follows the box's size and its text
 * (public/leftoff-model.js pageCount). `kind` 'fold' gives taller pages (.fold-pages).
 */
function pagedBox(content, label, kind) {
  const id = `leftoff-pages-${++fieldId}`;
  const box = el('div', { id, class: 'leftoff-read leftoff-pages', role: 'region', 'aria-roledescription': t('overview.pages.role'), 'aria-label': label }, content);
  if (kind) box.classList.add(`${kind}-pages`);
  const count = el('span', { class: 'leftoff-page-n', 'aria-live': 'polite' });
  let page = 0;
  let total = 1;
  const turn = (step, label) =>
    el('button', { type: 'button', class: `btn sm ghost${step < 0 ? ' prev' : ''}`, 'aria-controls': id, 'aria-label': label, onclick: () => show(turnPage(page, step, total)) }, icon('chev-right'));
  // A fold's arrows name the fold, as its group does ("Página anterior de Hecho").
  const prev = turn(-1, kind ? t('overview.pages.prevOf', { label }) : t('overview.pages.prev'));
  const next = turn(1, kind ? t('overview.pages.nextOf', { label }) : t('overview.pages.next'));
  const pager = el('div', { class: 'leftoff-pager', role: 'group', 'aria-label': kind ? t('overview.pages.groupOf', { label }) : t('overview.pages.group'), hidden: true }, prev, count, next);
  const gap = () => parseFloat(getComputedStyle(box).columnGap) || 0;
  function show(target) {
    page = turnPage(target, 0, total);
    box.scrollLeft = pageOffset(page, box.clientWidth, gap());
    const view = pagerView(page, total);
    pager.hidden = view.hidden;
    box.classList.toggle('fits', view.hidden);
    // Only a paged box is a tab stop: the keys turn its pages.
    if (view.hidden) box.removeAttribute('tabindex');
    else box.tabIndex = 0;
    const at = { page: view.page, total: view.total };
    box.setAttribute('aria-label', view.hidden ? label : kind ? t('overview.pages.whereOf', { label, ...at }) : t('overview.pages.where', at));
    // The count is a live region: a resize that keeps the page must not announce it again.
    const where = t('overview.pages.count', { page: view.page, total: view.total });
    if (count.textContent !== where) count.textContent = where;
    // A button disabled under the focus would drop it to the page: the box keeps it, without the
    // scroll a plain focus() makes, which cancels the smooth turn just started.
    const focused = document.activeElement;
    prev.disabled = view.prevDisabled;
    next.disabled = view.nextDisabled;
    if ((focused === prev && prev.disabled) || (focused === next && next.disabled)) box.focus({ preventScroll: true });
  }
  // Measured on the next frame: sizing the box to its text inside the observer's own callback
  // would report a resize loop.
  const resize = new ResizeObserver(() => requestAnimationFrame(measure));
  const edit = new MutationObserver(() => measure());
  function measure() {
    // The panel replaces its body on every render: a box that left it stops watching.
    if (!box.isConnected) {
      resize.disconnect();
      edit.disconnect();
      return;
    }
    // Counted at the page height: a box sized to its text never overflows into a second page.
    box.classList.remove('fits');
    total = pageCount(box.scrollWidth, box.clientWidth, gap());
    show(page);
  }
  resize.observe(box);
  edit.observe(box, { childList: true, subtree: true, characterData: true });
  // The reading face can arrive after the first layout and change how much fits.
  document.fonts?.ready.then(() => box.isConnected && measure());
  box.addEventListener('keydown', (e) => {
    const step = pageKey(e.key);
    if (!step) return;
    e.preventDefault();
    show(turnPage(page, step, total));
  });
  return [box, pager];
}

/**
 * Forget, on a block from the local record: asks first (focus starts on Cancel, as the sleeping
 * agents' Olvidar), removes the record (DELETE /api/folder/left-off) and reloads the panel, which then
 * shows Engram's summary or the empty state.
 */
function forgetButton(selection) {
  const button = el('button', { type: 'button', class: 'btn sm ghost leftoff-forget', title: t('overview.forgetHint') }, t('overview.forget'));
  button.addEventListener('click', async () => {
    if (button.getAttribute('aria-busy') === 'true') return;
    const sure = await confirmDialog({ title: t('overview.forgetTitle'), message: t('overview.forgetConfirm'), confirmLabel: t('overview.forget'), cancelLabel: t('overview.cancel'), danger: true });
    if (!sure) return;
    button.setAttribute('aria-busy', 'true');
    try {
      await api('DELETE', `/api/folder/left-off?${new URLSearchParams({ ws: selection.ws, rel: selection.rel })}`);
      panel.refreshPanel();
    } catch (error) {
      showAlert(t('overview.forgetFailed', { error: errorText(error) }));
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
  return button;
}

function leftOffCard(data, selection) {
  const { row } = data;
  const { summary, memory } = row.leftOff;
  const layout = leftOffLayout(row);
  // The panel title already says "Where it left off" (the leftoff view below).
  const card = el('section', { class: 'overview-leftoff', 'aria-label': t('overview.leftOff') });
  if (layout.instead === 'latestMemory') card.append(el('p', {}, t('overview.latestMemory', { title: memory.title })));
  if (layout.instead === 'missing') card.append(...missingMemory(row, selection));
  const textOptions = summary ? summaryOptions([summary]) : null;
  // Read: the objective in the reading face, or a free-form summary's text.
  const read = {
    // The user's last message from the local record: plain text (el appends a text node), never Markdown.
    ask: () => el('div', { class: 'leftoff-ask' }, el('h4', { class: 'leftoff-eyebrow' }, t('overview.lastUserMessage')), el('p', { class: 'leftoff-read leftoff-ask-text' }, summary.lastUserMessage)),
    goal: () => el('div', { class: 'leftoff-focus' }, el('h4', { class: 'leftoff-eyebrow' }, t('overview.goal')), pagedBox(panel.markMemory(goalText(summary.goal, textOptions)), t('overview.goal'))),
    excerpt: () => el('div', { class: 'leftoff-read' }, panel.markMemory(renderMarkdown(summary.excerpt, textOptions))),
  };
  card.append(...layout.read.map((part) => read[part]()));
  if (layout.folds.length) card.append(el('div', { class: 'leftoff-folds' }, layout.folds.map((fold) => foldView(fold, summary[fold.field], textOptions))));
  // Context: when, and which summary this comes from, small and muted at the foot.
  const foot = [
    layout.foot.lastWorked ? el('span', {}, t('overview.lastWorked', { when: whenLabel(row.lastAt, row.lastDay) })) : null,
    layout.foot.source ? el('span', {}, t(sourceKey(summary), { when: whenLabel(summary.at, dayOf(summary.at)) })) : null,
    layout.foot.since ? el('span', { class: 'leftoff-since' }, t('overview.since', { title: memory.title })) : null,
    summary?.source === 'claude-code' ? forgetButton(selection) : null,
  ].filter(Boolean);
  if (foot.length) card.append(el('footer', { class: 'leftoff-foot' }, foot));
  return card;
}

async function leftOff({ selection, date }) {
  const query = new URLSearchParams({ ws: selection.ws, rel: selection.rel, date });
  // The inbox (GET /api/inbox) says whether an agent of this folder waits for an answer.
  const [folder, inbox] = await Promise.allSettled([api('GET', `/api/overview/folder?${query}`), api('GET', '/api/inbox')]);
  const waiting = inbox.status === 'fulfilled' ? pickCall(inbox.value.items, selection) : null;
  const call = waiting ? callBlock(waiting) : null;
  if (folder.status === 'rejected') {
    // An unreachable Engram still leaves the call to act.
    if (call && folder.reason?.status === 503) return [call];
    throw folder.reason;
  }
  return [call, truncatedNotice(folder.value), engramDownNotice(folder.value), leftOffCard(folder.value, selection)].filter(Boolean);
}

const isFolder = (selection) => selection !== null && selection.rel !== '';

/** "Dónde quedó" (artboard 03): the call, the objective, the folds and the foot, under the folder's Engram project. */
const leftOffView = {
  id: 'leftoff',
  label: 'overview.view.folder',
  applies: isFolder,
  extra: 'memory',
  async render({ selection, date, setHeading }) {
    setHeading(t('overview.leftOff'));
    // The project line joins the title when it arrives; without it the view still shows.
    panel.projectSubtitle(selection, date).then((line) => setHeading(t('overview.leftOff'), line), () => {});
    return leftOff({ selection, date });
  },
};

export async function init() {
  panel.registerPanelView(workspaceView);
  panel.registerPanelView(leftOffView);
}
