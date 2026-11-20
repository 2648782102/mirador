// Night shift, shown as the "Piloto automático"
// (one autopilot, the night shift is its schedule), in the
// Seguimiento view (public/features/tracking.js), as persistent parts the view places once:
// - `head`, in the view's strip: its state (who switched it on, since and until),
//   the jornada's Claude calls (a count only while on by hand: no cap) and
//   two buttons that open "Before bed" (what each agent has left and the execution notes
//   the user leaves them) and the shift settings (schedule, resource profile with the
//   budget meter, Telegram bot and «Responder desde Telegram») in a dialog, each a folded
//   part with its value in one line and its about text behind "Cómo funciona";
// - `banner`: the bedtime reminder;
// - `report`: the "What Mirador did" lane, with the user's Right / Wrong feedback (what the judge
//   and the decider learn from), its rows grouped by type (Mirador's decisions, the user's notes
//   for Mirador) under a filter remembered per window (all, not answered, no note); a row shows
//   its summary, verdict and time, and its reason, confidence and judge note open on demand.
// What waits for the user (GET /api/night → pending) is read here and drawn by the view's
// "Needs you" lane (nightPending(), event `night`).
// Every part and form is built once and only redrawn in place, also while its dialog is
// closed, so a half-typed form or the keyboard focus survive the polling (every 10-30 s,
// per resource profile). Data shaping lives in night-model.js; this module fetches and renders.
// "Before bed" also proposes a note per open agent from its project's Next Steps
// (proposals-model.js), written into that agent's one note box:
// the user edits it or not and leaves it with that agent's "Dejar la
// nota". The box has a "Mejorar con IA" button (improveControls in workspaces.js) that asks
// Claude for a better note from that agent's folder. Each agent is a folded row (open by itself
// only while it waits for the user); the intro, the capacity and the tabs' explanation sit behind an ⓘ,
// and the notes of closed agents stay folded, one line each.
// "Before bed" splits the agents in "Pendientes" and "Con nota"
// (bedtimeTabs), and asks for the proposals again at every opening, each dated from its summary
// and warned when work or a note came after it (proposalFreshness).
// The night queue: the strip says how many agents work of N and how many wait, "Before bed"
// gives the recommendation for this machine and where each note stands in the queue, and the shift
// settings let the user change N (GET/PUT /api/night/queue).
// The on/off switch lives in the topbar's settings sheet (public/features/settings.js)
// in both views: it reads the state with nightSwitchState()
// and readNightStatus() and turns it on or off with toggleNight() (turning it on by hand asks
// until when: a time or until the user turns it off).
import { api, el, emit, errorText, getLanguage, on, prefs, state, t, workspaceById } from '/core.js';
import { plural } from '/i18n.js';
import { icon } from '/icons.js';
import { confirmDialog, openDialog } from '/dialog.js';
import {
  BEDTIME_TABS,
  NOTE_MAX_CHARS,
  REPORT_FILTERS,
  WEEK_ORDER,
  autopilotState,
  bedtimeRow,
  bedtimeTab,
  bedtimeTabs,
  bedtimeView,
  budgetMeter,
  checkNote,
  checkScheduleForm,
  checkSlots,
  defaultUntil,
  firstLine,
  manualOnBody,
  notePlan,
  noteQueueText,
  profileSummary,
  profileTable,
  profileValue,
  queueAdvice,
  queueLine,
  queueSummary,
  reportCalls,
  reportDetails,
  reportFilter,
  reportRows,
  reportSummary,
  reportView,
  scheduleForm,
  scheduleSummary,
  redrawNodes,
  stripCalls,
  telegramAnswersView,
  telegramSummary,
} from '/features/night-model.js';
import { bedtimeProposals, bedtimeSources, proposalAsks, proposalFreshness, proposalQuery, refreshedProposal } from '/features/proposals-model.js';
import { improveControls } from '/features/workspaces.js';

const NOTE_MAX = 500;

let built = false;
let exposed = null;
let sheetOpen = false;
const parts = {};

let status = null;
let statusError = null;
let switching = false;
let switchError = null;

let records = null;
let summary = null;
let fromLog = false;
let reportError = null;
let reportShown = reportFilter(prefs.read('nightReportFilter', 'all'));
const sending = new Set();
let feedbackNotice = null;

let telegram = null;
let telegramError = null;
let telegramBusy = null;
let telegramNotice = null;
/** GET /api/night/telegram/answers, or null (no bot, or a server without the setting). */
let telegramAnswers = null;
let tokenInput;
let chatInput;
let tokenError;
let chatError;

let schedule = null;
let scheduleError = null;
let scheduleBusy = false;
let scheduleNotice = null;
let scheduleDirty = false;
let scheduleStale = false;
const sched = {};

let reminder = null;
let notes = null;
let bedtimeError = null;
let bedtimeNotice = null;
let bedtimeStale = false;
const drafts = new Map();
const removing = new Set();
// Whether each folded part (an agent's row, the ⓘ, the closed agents' notes) is open, by its key,
// once the user toggled it: the polling rebuilds them without closing what they opened.
const opened = new Map();
// The shift settings' parts that show an error now, by key: a new error opens its part.
const partErrors = new Set();
// Where the proposed text in each open agent's note box comes from, by terminal id: kept across
// polls and closings until the note is left; `proposed`: the agents asked about since the dialog
// opened (every opening asks them all again).
const proposals = new Map();
const proposed = new Set();
let proposing = false;
let askAgain = false;
// "Pendientes" or "Con nota", remembered per window; `bedtimeTabsNode` is built once.
let bedtimeShown = bedtimeTab(prefs.read('nightBedtimeTab', 'pending'));
let bedtimeTabsNode;
let bedtimeOpen = false;

// The night queue's settings (GET /api/night/queue), its form (built once) and where each note stands.
let queueSettings = null;
let queueError = null;
let queueBusy = false;
let queueNotice = null;
let queueDirty = false;
let queueStale = false;
const queueForm = {};
let notePlans = new Map();

let profile = null;
let profileError = null;
let profileBusy = null;
let profileNotice = null;

let loading = false;

const count = (key, n) => plural(getLanguage(), key, n);

/** Day and time of an ISO instant in the configured time zone. */
function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(getLanguage(), { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: state.config.timeZone });
}

function place(workspaceId, folders) {
  const name = workspaceId ? workspaceById(workspaceId)?.name ?? workspaceId : t('night.place.unknown');
  return [name, ...(folders.length ? folders : [t('inbox.root')])].join(' › ');
}

/** Replaces a part's content, keeping the focus on the control that had it (by data-night-focus). */
function redraw(part, ...nodes) {
  const focused = part.contains(document.activeElement) ? document.activeElement.dataset?.nightFocus : undefined;
  part.replaceChildren(...redrawNodes(nodes));
  if (focused) part.querySelector(`[data-night-focus="${CSS.escape(focused)}"]`)?.focus();
}

/* ---------- Data ---------- */

/** GET /api/night into `status`; a failed read keeps the last status and sets `statusError`. */
async function loadStatus() {
  try {
    status = await api('GET', '/api/night');
    statusError = null;
  } catch (error) {
    statusError = errorText(error);
  }
}

/**
 * Reads only the status (GET /api/night) and emits `night`: the settings sheet's switch and
 * the topbar chip follow it in Development too, where refreshNight() does not run.
 */
export async function readNightStatus() {
  await loadStatus();
  if (built) renderHead();
  emit('night');
}

/** Reads the status, then the report since the last activation (the log when the report is missing). */
export async function refreshNight() {
  if (!built || loading) return;
  loading = true;
  let telegramRead = false;
  try {
    await loadStatus();
    await loadReport();
    await loadSchedule();
    await loadQueue();
    await loadBedtime();
    // Agents opened while "Before bed" is on screen get their proposal too.
    if (bedtimeOpen) loadProposals();
    await loadProfile();
    // Until it answers (or while this server has no Telegram routes) every poll asks again.
    if (telegram === null) {
      await loadTelegram();
      telegramRead = true;
    }
  } finally {
    loading = false;
  }
  renderHead();
  renderBanner();
  renderReport();
  renderBedtime();
  renderSchedule();
  renderQueue();
  renderProfile();
  // The Telegram form redraws only when its own state changed, never in the middle of typing.
  if (telegramRead) renderTelegram();
  emit('night');
}

async function loadReport() {
  const query = status?.since ? `?since=${encodeURIComponent(status.since)}` : '';
  try {
    const answer = await api('GET', `/api/night/report${query}`);
    records = answer.records ?? [];
    summary = answer.summary ?? null;
    fromLog = false;
    reportError = null;
  } catch (error) {
    if (error.status !== 404) {
      reportError = errorText(error);
      return;
    }
    // The judge's report is not installed yet: the decision log has the same records, without verdicts.
    try {
      records = (await api('GET', `/api/night/log${query}`)).records ?? [];
      summary = null;
      fromLog = true;
      reportError = null;
    } catch (logError) {
      reportError = errorText(logError);
    }
  }
}

/** A server without the routes answers 404: the section says so instead of failing. */
const missing = (error) => (error.status === 404 ? t('night.n5.missing') : errorText(error));

async function loadSchedule() {
  try {
    schedule = await api('GET', '/api/night/schedule');
    scheduleError = null;
  } catch (error) {
    scheduleError = missing(error);
  }
}

async function loadQueue() {
  try {
    queueSettings = await api('GET', '/api/night/queue');
    queueError = null;
  } catch (error) {
    queueError = missing(error);
  }
}

/** A moment after a note is left while on: the queue (GET /api/night) knows where it stands by then. */
function refreshQueueSoon() {
  setTimeout(async () => {
    try {
      status = await api('GET', '/api/night');
      statusError = null;
    } catch {
      return;
    }
    await loadBedtime();
    renderHead();
    renderBedtime();
    emit('night');
  }, 1500);
}

async function loadBedtime() {
  try {
    [reminder, notes] = await Promise.all([api('GET', '/api/night/reminder'), api('GET', '/api/night/notes').then((answer) => answer.notes ?? [])]);
    bedtimeError = null;
  } catch (error) {
    bedtimeError = missing(error);
  }
}

/** GET /api/profile: the resource profile, its values and the budget; a server without it answers 404. */
async function loadProfile() {
  try {
    profile = await api('GET', '/api/profile');
    profileError = null;
    // A switch made in another window reaches the tracking view's refresh too.
    emit('profile', profile);
  } catch (error) {
    profileError = missing(error);
  }
}

async function loadTelegram() {
  try {
    telegram = await api('GET', '/api/night/telegram');
    telegramError = null;
  } catch (error) {
    telegramError = error.status === 404 ? t('night.telegram.missing') : errorText(error);
  }
  telegramAnswers = telegram?.configured ? await api('GET', '/api/night/telegram/answers').catch(() => null) : null;
}

/* ---------- Switch ---------- */

function explanation() {
  const list = (keys) => el('ul', { class: 'night-list' }, ...keys.map((key) => el('li', {}, t(key))));
  return [
    el('p', {}, t('night.confirm.intro')),
    list(['night.confirm.does.questions', 'night.confirm.does.followUps']),
    el('p', {}, t('night.confirm.never')),
    list(['night.confirm.never.secrets', 'night.confirm.never.destructive', 'night.confirm.never.consent', 'night.confirm.never.unsure']),
    el('p', {}, t('night.confirm.log')),
  ];
}

/**
 * "Until when?" for a manual on: until the user turns it off (the default) or until a local
 * time (today when still ahead, else tomorrow). `read()` gives the PUT body, or shows the
 * error next to the time field, focuses it and gives null.
 */
function untilChoice() {
  const off = el('input', { type: 'radio', name: 'night-until', id: 'night-until-off', value: 'off', checked: true });
  const at = el('input', { type: 'radio', name: 'night-until', id: 'night-until-time', value: 'time' });
  const time = el('input', {
    type: 'time',
    id: 'night-until-at',
    value: defaultUntil(Date.now(), state.config.timeZone),
    'aria-label': t('night.until.timeLabel'),
    'aria-describedby': 'night-until-hint night-until-error',
  });
  const error = el('p', { class: 'field-error', id: 'night-until-error', role: 'alert' });
  const node = el(
    'fieldset',
    { class: 'night-until' },
    el('legend', {}, t('night.until.legend')),
    el('span', { class: 'night-day' }, off, el('label', { for: off.id }, t('night.until.off'))),
    el('span', { class: 'night-day' }, at, el('label', { for: at.id }, t('night.until.at')), time),
    el('p', { class: 'hint', id: 'night-until-hint' }, t('night.until.hint')),
    error,
  );
  const read = (focus = true) => {
    const chosen = manualOnBody(at.checked ? 'time' : 'off', time.value);
    fieldError(time, error, chosen.error ? t(chosen.error) : null);
    if (chosen.error && focus) time.focus();
    return chosen.body ?? null;
  };
  // Typing a time chooses it; a time that shows an error is checked again as it changes.
  time.addEventListener('focus', () => { at.checked = true; });
  time.addEventListener('input', () => {
    at.checked = true;
    if (error.textContent) read(false);
  });
  off.addEventListener('change', () => read(false));
  return { node, read };
}

async function toggle() {
  if (switching || !status) return;
  const next = !status.active;
  let body = { active: false };
  if (next) {
    const choice = untilChoice();
    const value = await openDialog({
      title: t('night.confirm.title'),
      body: [...explanation(), choice.node],
      actions: [
        { label: t('common.cancel'), value: null },
        { label: t('night.confirm.go'), value: 'on', kind: 'primary' },
      ],
      initialFocus: 'cancel',
      // A time that is not HH:MM keeps the dialog open with its error.
      onAction: () => {
        const chosen = choice.read();
        if (!chosen) return false;
        body = chosen;
        return true;
      },
      className: 'night-dialog',
    });
    if (value !== 'on') return;
  }
  switching = true;
  switchError = null;
  renderHead();
  // The settings sheet's switch says it is saving.
  emit('night');
  try {
    status = await api('PUT', '/api/night', body);
    statusError = null;
  } catch (error) {
    switchError = t(next ? 'night.switch.failedOn' : 'night.switch.failedOff', { error: errorText(error) });
  } finally {
    switching = false;
  }
  renderAll();
  emit('night');
  if (next && status?.active) {
    loadReport().then(renderReport);
    // Turning it on delivers the execution notes: their state changes in a moment.
    setTimeout(() => loadBedtime().then(renderBedtime), 1500);
  }
}

function stateLine() {
  if (statusError) return el('p', { class: 'tracking-error', role: 'alert', id: 'night-state' }, t('night.failed.status', { error: statusError }));
  if (!status) return el('p', { class: 'muted', id: 'night-state' }, t('tracking.loading'));
  if (!status.available) return el('p', { class: 'night-unavailable', id: 'night-state' }, t('night.unavailable'));
  // In the strip this line may be cut short: its title keeps the whole text.
  if (!status.active) return el('p', { class: 'muted', id: 'night-state', title: t('night.state.off') }, t('night.state.off'));
  const agents = status.connectedTerminals?.length ?? 0;
  const on = autopilotState(status);
  const text = `${t(on.key, { time: on.since ? when(on.since) : '', until: on.until ? when(on.until) : '' })} · ${count('night.state.agents', agents)}`;
  return el('p', { class: 'night-on', id: 'night-state', title: text }, text);
}

/** The night queue while the autopilot is on: "Trabajando 5 de 5 · 3 en cola". */
function queueStrip() {
  const text = status?.active ? queueLine(status.queue, t) : null;
  if (!text) return null;
  return el('p', { class: `night-queue-line${status.queue.queued ? ' waiting' : ''}`, id: 'night-queue-line', title: t('night.queue.stripHint', { slots: status.queue.slots }) }, text);
}

/** The jornada's Claude calls for the strip: on by hand a count only (no cap), otherwise the same meter as the settings. */
function stripBudget() {
  const calls = stripCalls(profile?.budget, status);
  if (!calls) return null;
  if (calls.uncapped) return el('div', { class: 'night-strip-budget' }, el('span', { title: t('night.budget.uncappedHint') }, count('night.budget.calls', calls.used)));
  const row = { key: 'night', ...calls };
  return el('div', { class: `night-strip-budget ${row.tone}` }, el('span', {}, t('night.budget.nightShort', { used: row.used, limit: row.limit })), meterNode(row));
}

/** Sereno's owl, in the accent color: the agent behind the autopilot. */
function serenoIcon() {
  const owl = icon('sereno');
  owl.classList.add('sereno-ic');
  return owl;
}

/** The strip's head. Its on/off switch moved to the settings sheet (toggleNight()); the state stays here. */
function renderHead() {
  redraw(
    parts.head,
    el('h2', { id: 'night-title', class: 'night-strip-label', title: t('night.sereno') }, serenoIcon(), t('night.title')),
    stateLine(),
    queueStrip(),
    stripBudget(),
    el('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'data-night-focus': 'open-bedtime', onclick: openBedtime }, t('night.bedtime')),
    el('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'data-night-focus': 'open-settings', onclick: openSettings }, t('night.settings')),
    switchError ? el('p', { class: 'tracking-error night-strip-error', role: 'alert' }, switchError) : null,
  );
}

/* ---------- Dialogs: "Before bed" and the shift settings ---------- */

/** Opens a dialog around persistent parts; closing it keeps them (and what is typed in them) for the next time. */
async function openSheet(title, body, focusKey) {
  if (sheetOpen) return;
  sheetOpen = true;
  try {
    await openDialog({ title, body, actions: [], close: t('night.sheet.close'), className: 'night-dialog night-sheet' });
  } finally {
    sheetOpen = false;
  }
  // A refresh while the dialog was open may have replaced the button it returns the focus to.
  if (!parts.head.contains(document.activeElement)) parts.head.querySelector(`[data-night-focus="${focusKey}"]`)?.focus();
}

async function openBedtime() {
  renderBedtime();
  // Every opening asks again, so no proposal comes from an older look at the memory.
  proposed.clear();
  loadProposals();
  bedtimeOpen = true;
  try {
    await openSheet(t('night.bedtime'), [parts.bedtime], 'open-bedtime');
  } finally {
    bedtimeOpen = false;
  }
}

/** The shift settings: four folded parts, each with its value in one line, under the autopilot's "Cómo funciona". */
function openSettings() {
  const about = disclosure('night-settings-how', false, t('night.settings.about'), { class: 'night-how' }, el('p', { class: 'hint' }, t('night.about')));
  return openSheet(t('night.settings'), [about, parts.schedule, parts.queue, parts.profile, parts.telegram], 'open-settings');
}

/* ---------- Waiting for you (drawn by the tracking view's "Needs you" lane) ---------- */

/* ---------- The settings sheet's switch (public/features/settings.js) ---------- */

/** What the switch shows: `status` (null until GET /api/night answers), whether it is saving, and the last switch error. */
export function nightSwitchState() {
  return { status, switching, error: switchError };
}

/** Turns the autopilot on (asking until when) or off, as the strip's switch did; builds the parts it redraws first. */
export function toggleNight() {
  nightParts();
  return toggle();
}

/** What the night shift left for the user: `pending` is null until GET /api/night answers; `error` when its last read failed. */
export function nightPending() {
  return { pending: status?.pending ?? null, error: statusError };
}

/* ---------- What Mirador did ---------- */

async function sendFeedback(row, verdict, note) {
  await api('POST', '/api/night/feedback', note ? { recordId: row.id, verdict, note } : { recordId: row.id, verdict });
  const record = records?.find((r) => r.id === row.id);
  if (record) record.feedback = { verdict, note: note ?? '', time: new Date().toISOString() };
  feedbackNotice = { tone: 'ok', text: t(verdict === 'right' ? 'night.feedback.savedRight' : 'night.feedback.savedWrong') };
}

async function markRight(row) {
  if (sending.has(row.id)) return;
  sending.add(row.id);
  feedbackNotice = null;
  renderReport();
  try {
    await sendFeedback(row, 'right');
  } catch (error) {
    feedbackNotice = { tone: 'error', text: t('night.feedback.failed', { error: errorText(error) }) };
  } finally {
    sending.delete(row.id);
  }
  renderReport();
  // The busy button could not keep the focus; under a filter the answered row may be gone too.
  if (document.activeElement === document.body) refocusReport(`right-${row.id}`);
}

/** Focuses the report control `key`, or the lane's list when a filter hid it. */
function refocusReport(key) {
  (parts.report.querySelector(`[data-night-focus="${CSS.escape(key)}"]`) ?? parts.reportBody).focus();
}

async function markWrong(row) {
  if (sending.has(row.id)) return;
  const noteId = `night-note-${row.id}`;
  const hintId = `${noteId}-hint`;
  const errorId = `${noteId}-error`;
  const note = el('textarea', { id: noteId, class: 'night-note', rows: '4', maxlength: String(NOTE_MAX), 'aria-describedby': `${hintId} ${errorId}` }, row.feedback?.verdict === 'wrong' ? row.feedback.note : '');
  const failure = el('p', { class: 'field-error', id: errorId, role: 'alert' });
  sending.add(row.id);
  renderReport();
  try {
    await openDialog({
      title: t('night.feedback.wrongTitle'),
      body: [
        el('p', {}, t('night.feedback.wrongIntro')),
        el(
          'div',
          { class: 'field' },
          el('label', { for: noteId }, t('night.feedback.note')),
          note,
          el('p', { class: 'hint', id: hintId }, t('night.feedback.noteHint', { max: NOTE_MAX })),
          failure,
        ),
      ],
      actions: [
        { label: t('common.cancel'), value: null },
        { label: t('night.feedback.saveWrong'), value: 'save', kind: 'primary', busyLabel: t('night.feedback.saving') },
      ],
      initialFocus: note,
      onAction: async () => {
        failure.textContent = '';
        try {
          await sendFeedback(row, 'wrong', note.value.trim().slice(0, NOTE_MAX));
          return true;
        } catch (error) {
          failure.textContent = t('night.feedback.failed', { error: errorText(error) });
          return false;
        }
      },
    });
  } finally {
    sending.delete(row.id);
  }
  renderReport();
  // A refresh while the dialog was open may have replaced the button it returns the focus to.
  if (!parts.report.contains(document.activeElement)) refocusReport(`wrong-${row.id}`);
}

function outcomeLine(row) {
  if (row.outcome === 'decided' && row.choices?.length) return el('p', { class: 'night-choice' }, t('night.report.chose', { choice: row.choices.join(' · ') }));
  if (row.outcome === 'followed-up' && row.message) {
    return el(
      'div',
      { class: 'night-choice' },
      el('p', {}, t(row.type === 'note' ? 'night.report.noteSent' : 'night.report.sent')),
      el('blockquote', { class: 'night-message' }, row.message),
      row.delivered === false ? el('p', { class: 'night-warn' }, t('night.report.notDelivered')) : null,
    );
  }
  if (row.outcome === 'deferred') return el('p', { class: 'night-left' }, t('night.report.deferred'), row.rule ? el('code', { title: t('night.rule') }, row.rule) : null);
  if (row.outcome === 'dropped') return el('p', { class: 'night-left' }, t('night.report.dropped'));
  return null;
}

/** One of a report row's details (reportDetails), drawn inside the row's fold. */
function reportDetail(row, key) {
  if (key === 'outcome') return outcomeLine(row);
  if (key === 'reason') return el('p', { class: 'night-reason' }, t('night.report.reason', { reason: row.reason }));
  if (key === 'confidence') return el('p', { class: 'muted tracking-small' }, t('night.report.confidence', { percent: row.confidence }));
  return el('p', { class: 'night-judge' }, t('night.report.judgeNote', { note: row.verdict.note }));
}

/**
 * A report row: its tag and place chips, the verdict, the time and the
 * summary; what it did, the reason, the confidence and the judge's note open on demand in its fold.
 * The verdict the user gave and their Right / Wrong stay in the open.
 */
function reportItem(row) {
  const busy = sending.has(row.id);
  const verdict = row.verdict;
  const details = reportDetails(row);
  const where = place(row.workspaceId, row.folders);
  return el(
    'li',
    { class: 'night-item' },
    el(
      'div',
      { class: 'night-item-head' },
      el('span', { class: 'night-tag' }, t(row.type === 'question' ? 'night.type.question' : row.type !== 'note' ? 'night.type.followUp' : row.from === 'mirador' ? 'night.type.miradorNote' : 'night.type.note')),
      el('span', { class: 'night-place', title: where }, where),
      verdict
        ? el('span', { class: `night-verdict ${verdict.tone}`, title: verdict.note || undefined }, t(`night.verdict.${verdict.verdict}`))
        : null,
      el('span', { class: 'night-time' }, when(row.time)),
    ),
    el(
      'p',
      { class: 'night-summary' },
      row.type === 'question' ? row.question ?? t('night.pending.noSummary') : row.type === 'note' ? t(row.from === 'mirador' ? 'night.report.miradorNote' : 'night.report.note') : t('night.report.followUp'),
      row.moreQuestions ? el('span', { class: 'muted' }, ` ${count('night.report.more', row.moreQuestions)}`) : null,
    ),
    details.length
      ? disclosure(`report-${row.id}`, false, t('night.report.details'), { class: 'night-report-more' }, ...details.map((key) => reportDetail(row, key)))
      : null,
    row.feedback
      ? el('p', { class: 'muted tracking-small' }, t(row.feedback.verdict === 'right' ? 'night.feedback.markedRight' : 'night.feedback.markedWrong'), row.feedback.note ? ` — ${row.feedback.note}` : '')
      : null,
    // A note is the user's own instruction, or Mirador's sleep note: there is no decision of Mirador to judge.
    row.type === 'note' ? null : el(
      'div',
      { class: 'night-actions', role: 'group', 'aria-label': t('night.feedback.group') },
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          'aria-pressed': String(row.feedback?.verdict === 'right'),
          'aria-busy': busy ? 'true' : undefined,
          'data-night-focus': `right-${row.id}`,
          disabled: busy,
          onclick: () => markRight(row),
        },
        t('night.feedback.right'),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          'aria-pressed': String(row.feedback?.verdict === 'wrong'),
          'data-night-focus': `wrong-${row.id}`,
          disabled: busy,
          onclick: () => markWrong(row),
        },
        t('night.feedback.wrong'),
      ),
    ),
  );
}

function setReportFilter(key) {
  reportShown = reportFilter(key);
  prefs.write('nightReportFilter', reportShown);
  renderReport();
}

const filterLabel = (key) =>
  ({ all: t('night.report.filter.all'), unanswered: t('night.report.filter.unanswered'), noNote: t('night.report.filter.noNote') })[key];
const groupLabel = (key) => (key === 'notes' ? t('night.report.group.notes') : t('night.report.group.decisions'));
const filterEmpty = (key) => (key === 'noNote' ? t('night.report.filter.noNoteEmpty') : t('night.report.filter.unansweredEmpty'));

/** The filter row above the list: one pressed button per filter, with its count; hidden while there is nothing to filter. */
function renderReportFilter(view) {
  parts.reportFilter.hidden = !view;
  parts.reportFilter.setAttribute('aria-label', t('night.report.filter'));
  redraw(
    parts.reportFilter,
    view
      ? REPORT_FILTERS.map((key) =>
          el(
            'button',
            {
              type: 'button',
              class: 'btn',
              'aria-pressed': String(view.filter === key),
              'data-night-focus': `filter-${key}`,
              title: key === 'noNote' ? t('night.report.filter.noNoteHint') : undefined,
              onclick: () => setReportFilter(key),
            },
            filterLabel(key),
            el('span', { class: 'night-filter-count' }, String(view.counts[key])),
          ),
        )
      : [],
  );
}

function renderReport() {
  const body = [];
  let view = null;
  if (reportError) body.push(el('p', { class: 'tracking-error', role: 'alert' }, t('night.failed.report', { error: reportError })));
  if (fromLog) body.push(el('p', { class: 'muted tracking-small' }, t('night.report.fromLog')));
  if (records === null) {
    if (!reportError) body.push(el('p', { class: 'muted' }, t('tracking.loading')));
  } else {
    const numbers = reportSummary(summary, records);
    const calls = reportCalls(summary);
    if (numbers.length || calls) {
      body.push(
        el(
          'ul',
          { class: 'night-stats', 'aria-label': t('night.report.summary') },
          ...numbers.map((n) => el('li', { 'data-key': n.key }, el('strong', {}, String(n.count)), ` ${count(`night.summary.${n.key}`, n.count)}`)),
          calls ? el('li', { 'data-key': 'calls' }, t('night.report.calls', { used: calls.used, limit: calls.limit })) : null,
        ),
      );
    }
    const rows = reportRows(records);
    if (!rows.length) body.push(el('p', { class: 'tracking-empty' }, t('night.report.empty')));
    else {
      view = reportView(rows, reportShown);
      if (!view.groups.length) body.push(el('p', { class: 'tracking-empty' }, filterEmpty(view.filter)));
      for (const group of view.groups) {
        body.push(
          el('h3', { class: 'tracking-sub night-report-group' }, groupLabel(group.key), el('span', { class: 'tracking-count plain' }, String(group.rows.length))),
          el('ul', { class: 'night-items' }, ...group.rows.map(reportItem)),
        );
      }
    }
  }
  renderReportFilter(view);
  // Polite and with its height reserved: the answer to Right / Wrong appears without moving the list.
  body.push(el('p', { class: `night-notice${feedbackNotice?.tone === 'error' ? ' error' : ''}`, role: 'status' }, feedbackNotice?.text ?? ''));
  const period = status?.since ? t('night.report.since', { time: when(status.since) }) : t('night.report.last24');
  redraw(
    parts.reportHead,
    el('h2', { id: 'night-report' }, t('night.report')),
    records === null ? null : el('span', { class: 'tracking-count plain' }, String(records.length)),
  );
  // The scroll region itself stays: only its content changes, so its scroll position and focus hold.
  parts.reportBody.setAttribute('aria-label', t('tracking.lane.region', { lane: t('night.report') }));
  redraw(parts.reportBody, el('p', { class: 'muted tracking-small' }, period), ...body);
}

/* ---------- Bedtime banner ---------- */

function renderBanner() {
  const due = !!schedule?.reminderDue && !!schedule.next;
  // The live region stays in place, so the banner is announced when it appears.
  redraw(
    parts.banner,
    due
      ? el(
          'div',
          { class: 'night-banner' },
          el('p', {}, el('strong', {}, t('night.banner.title')), ' ', t('night.banner.body', { start: when(schedule.next.start), end: when(schedule.next.end) })),
          el('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'data-night-focus': 'banner', onclick: openBedtime }, t('night.banner.go')),
        )
      : null,
  );
}

/* ---------- Before bed: what each agent has left, and execution notes ---------- */

/** The pending reasons the server gives (src/night/service.ts), in the panel's language. */
const NOTE_REASONS = {
  'the terminal is closed': 'night.notes.reason.closed',
  'not an agent terminal of this workspace': 'night.notes.reason.other',
  "the agent's bridge is not connected": 'night.notes.reason.notConnected',
  'no agent terminal of this workspace is connected': 'night.notes.reason.noneConnected',
  'no agent terminal of this workspace is open': 'night.notes.reason.noneOpen',
  'the night socket is not available': 'night.notes.reason.unavailable',
};

const reasonText = (reason) => (NOTE_REASONS[reason] ? t(NOTE_REASONS[reason]) : reason);

/** The textarea of one note target, built once so a refresh never loses what is being written. */
function draftFor(key) {
  let draft = drafts.get(key);
  if (!draft) {
    const id = `night-draft-${key.replace(/[^\w-]/g, '_')}`;
    const error = el('p', { class: 'field-error', id: `${id}-error` });
    const warn = el('p', { class: 'night-warn', id: `${id}-warn`, role: 'status' });
    const input = el('textarea', { id, class: 'night-note', rows: '3', 'data-night-focus': `draft-${key}`, 'aria-describedby': `${id}-source ${id}-warn ${id}-hint ${id}-error` });
    draft = { id, input, error, warn, busy: false };
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true' && !checkNote(input.value).error) {
        input.setAttribute('aria-invalid', 'false');
        error.textContent = '';
      }
    });
    input.addEventListener('blur', () => warnDraft(draft));
    drafts.set(key, draft);
  }
  return draft;
}

async function saveNote(key, workspaceId, terminalId) {
  const draft = draftFor(key);
  if (draft.busy) return;
  const checked = checkNote(draft.input.value);
  if (checked.error) {
    draft.input.setAttribute('aria-invalid', 'true');
    draft.error.textContent = t(checked.error, { max: NOTE_MAX_CHARS });
    draft.input.focus();
    return;
  }
  draft.busy = true;
  bedtimeNotice = null;
  renderBedtime(true);
  try {
    await api('POST', '/api/night/notes', terminalId ? { workspaceId, terminalId, text: checked.text } : { workspaceId, text: checked.text });
    draft.input.value = '';
    draft.input.setAttribute('aria-invalid', 'false');
    draft.error.textContent = '';
    draft.warn.textContent = '';
    // The proposal was left with it: a later one fills the empty box again.
    if (terminalId) proposals.delete(terminalId);
    bedtimeNotice = { tone: 'ok', text: t(status?.active ? 'night.notes.savedNow' : 'night.notes.saved') };
    await loadBedtime();
    if (status?.active) refreshQueueSoon();
  } catch (error) {
    // What was written stays in the textarea.
    draft.input.setAttribute('aria-invalid', 'true');
    draft.error.textContent = t('night.notes.failed', { error: errorText(error) });
  } finally {
    draft.busy = false;
  }
  renderBedtime(true);
  // A note for an agent moves it to "Con nota", and its form with it.
  keepBedtimeFocus();
}

async function removeNote(note) {
  if (removing.has(note.id)) return;
  const confirmed = await confirmDialog({
    title: t('night.notes.removeTitle'),
    message: t('night.notes.removeBody'),
    confirmLabel: t('night.notes.removeConfirm'),
    cancelLabel: t('common.cancel'),
    danger: true,
  });
  if (!confirmed) return;
  removing.add(note.id);
  bedtimeNotice = null;
  renderBedtime(true);
  try {
    await api('DELETE', `/api/night/notes/${encodeURIComponent(note.id)}`);
    bedtimeNotice = { tone: 'ok', text: t('night.notes.removed') };
    await loadBedtime();
  } catch (error) {
    bedtimeNotice = { tone: 'error', text: t('night.notes.removeFailed', { error: errorText(error) }) };
  } finally {
    removing.delete(note.id);
  }
  renderBedtime(true);
  // Removing an agent's last note for tonight moves it back to "Pendientes".
  keepBedtimeFocus();
}

/**
 * One saved note: its text, when it was left, where it stands and its remove button. `short` (the
 * notes of closed agents) folds all but the remove button under the note's first line.
 */
function noteItem(note, short = false) {
  const state = note.delivered
    ? el('p', { class: 'night-note-state ok' }, t('night.notes.delivered', { time: when(note.deliveredAt) }), ' · ', count('night.notes.reached', note.deliveredTo?.length ?? 0))
    : el('p', { class: 'night-note-state' }, note.pendingReason ? t('night.notes.notDelivered', { reason: reasonText(note.pendingReason) }) : t('night.notes.waiting'));
  const queued = note.delivered ? null : noteQueueText(notePlans.get(note.id), !!status?.active, t);
  const details = [
    el('p', { class: 'night-note-text' }, note.text),
    el('p', { class: 'muted tracking-small' }, t('night.notes.leftAt', { time: when(note.createdAt) })),
    // While on, a queued note says where it waits instead of an older reason.
    queued && status?.active ? null : state,
    queued ? el('p', { class: 'night-note-queue' }, queued) : null,
    note.sensitive ? el('p', { class: 'night-warn' }, t('night.notes.sensitive', { topic: note.sensitive })) : null,
  ];
  const remove = el(
    'button',
    { type: 'button', class: 'btn', 'data-night-focus': `remove-${note.id}`, disabled: removing.has(note.id), 'aria-busy': removing.has(note.id) ? 'true' : undefined, onclick: () => removeNote(note) },
    t(note.delivered ? 'night.notes.forget' : 'night.notes.remove'),
  );
  const head = firstLine(note.text);
  return el(
    'li',
    { class: 'night-note-item' },
    short ? disclosure(`note-${note.id}`, false, el('span', { class: 'night-note-line' }, head.more ? `${head.line}…` : head.line), { class: 'night-note-fold' }, details) : details,
    remove,
  );
}

/* ---------- Before bed: Mirador's proposed notes from memory ---------- */

/** The sensitive topic `text` mentions (POST /api/night/sensitive), or null; null too when the check fails. */
async function sensitiveTopic(text) {
  try {
    return (await api('POST', '/api/night/sensitive', { text })).topic ?? null;
  } catch {
    return null;
  }
}

/** Shows the draft's sensitive warning for its text as it is now, like the one a saved note gets. */
async function warnDraft(draft) {
  const text = draft.input.value.trim();
  const topic = text ? await sensitiveTopic(text) : null;
  if (draft.input.value.trim() === text) draft.warn.textContent = topic ? t('night.notes.sensitive', { topic }) : '';
}

/**
 * What an agent's note box gets with its first proposal: where the proposed text comes from
 * (`original`, the text Mirador last put there; its `source`; a `newerSource` kept from the user's
 * edited text), the place for its warnings and its "Mejorar con IA", which writes into the same box.
 */
function attachProposal(draft, { workspaceId, rel }) {
  const proposal = { original: '', source: null, newerSource: null, origin: el('div', { class: 'night-proposal-source', id: `${draft.id}-source` }) };
  proposal.improve = improveControls({
    read: () => draft.input.value,
    write: (value) => {
      draft.input.value = value;
      if (draft.input.getAttribute('aria-invalid') === 'true' && !checkNote(value).error) {
        draft.input.setAttribute('aria-invalid', 'false');
        draft.error.textContent = '';
      }
      // Claude's version gets its sensitive warning at once, like the prefilled text.
      warnDraft(draft);
    },
    ws: workspaceId,
    rel,
  });
  return proposal;
}

/**
 * Why the proposal may be outdated, in the panel's language and time zone; its source and
 * date go in the box's label. Gives proposalFreshness's answer, or null without a known summary.
 */
function describeSource(proposal) {
  const fresh = proposalFreshness(proposal.source, Date.now(), state.config.timeZone, getLanguage());
  const newer = proposal.newerSource ? proposalFreshness({ summaryAt: proposal.newerSource }, Date.now(), state.config.timeZone, getLanguage()) : null;
  proposal.origin.replaceChildren(
    ...redrawNodes([
      fresh?.newerMemory ? el('p', { class: 'night-warn' }, t('night.proposal.newerMemory', { time: fresh.newerMemory })) : null,
      fresh?.sentAfter ? el('p', { class: 'night-warn' }, t('night.proposal.sentAfter', { time: fresh.sentAfter })) : null,
      newer ? el('p', { class: 'night-left' }, t('night.proposal.newerSource', { when: newer.when })) : null,
    ]),
  );
  return fresh;
}

/** The terminal ids of the open agents that already have a note for tonight. */
function notedAgents() {
  if (!reminder || !notes) return new Set();
  const { noted } = bedtimeTabs(bedtimeView(reminder, notes, []), status);
  return new Set(noted.flatMap((entry) => entry.agents.map((agent) => agent.terminalId)));
}

/**
 * Asks GET /api/proposals about the open agents without a note not asked since the dialog opened
 * and writes each proposal into its agent's note box while that box is empty or still holds
 * Mirador's text (refreshedProposal: a text the user typed or edited is never replaced). A call made
 * while one runs asks again after it.
 */
async function loadProposals() {
  if (!reminder) return;
  if (proposing) {
    askAgain = true;
    return;
  }
  const asks = proposalAsks(reminder, new Set([...proposed, ...notedAgents()]));
  if (!asks.length) return;
  proposing = true;
  askAgain = false;
  const asked = reminder;
  const answers = [];
  try {
    for (const ask of asks) {
      try {
        answers.push(await api('GET', `/api/proposals?${proposalQuery(ask.ws, ask.rels)}`));
      } catch {
        // That workspace proposes nothing this time; the next opening asks again.
      }
    }
  } finally {
    proposing = false;
  }
  const answered = new Set(answers.map((answer) => answer.ws));
  for (const workspace of asked.workspaces ?? []) {
    if (answered.has(workspace.workspaceId)) for (const agent of workspace.agents ?? []) proposed.add(agent.terminalId);
  }
  const sources = bedtimeSources(asked, answers);
  for (const proposal of bedtimeProposals(asked, answers, t('tracking.adopt.lead'), NOTE_MAX_CHARS)) {
    const source = sources.get(proposal.terminalId) ?? null;
    const draft = draftFor(`t:${proposal.terminalId}`);
    // A note being left keeps the text it is sending.
    if (draft.busy) continue;
    const shown = proposals.get(proposal.terminalId);
    const next = refreshedProposal({ text: draft.input.value, original: shown?.original ?? '', source: shown?.source ?? null }, { text: proposal.text, source });
    if (next.text !== draft.input.value) {
      draft.input.value = next.text;
      warnDraft(draft);
    }
    proposals.set(proposal.terminalId, Object.assign(shown ?? attachProposal(draft, proposal), { original: next.original, source: next.source, newerSource: next.newerSource }));
  }
  renderBedtime();
  if (askAgain) loadProposals();
}

/** After a save moved its agent to "Con nota", the focus goes to the "Pendientes" tab rather than to nowhere. */
function keepBedtimeFocus() {
  if (bedtimeOpen && (document.activeElement === document.body || !document.activeElement?.isConnected)) {
    bedtimeTabsNode.querySelector('[data-night-focus="bedtime-tab-pending"]')?.focus();
  }
}

/* ---------- Before bed: the sheet (folded rows, one note box per agent) ---------- */

/**
 * A native fold, rebuilt by every render: open as the user last left it (by `key`), else as `open`
 * says (so a row that stops waiting for the user folds again unless they opened it). Its summary carries
 * `key` so a redraw gives it back the focus, and `attrs.label` as its name when given.
 */
function disclosure(key, open, summary, { label, ...attrs } = {}, ...children) {
  return el(
    'details',
    {
      ...attrs,
      class: ['night-fold', attrs.class].filter(Boolean).join(' '),
      open: (opened.get(key) ?? open) || undefined,
      // A details built open fires a toggle too: only a change from the default is the user's choice.
      ontoggle: (event) => (opened.has(key) || event.target.open !== open) && opened.set(key, event.target.open),
    },
    el('summary', { 'data-night-focus': key, 'aria-label': label }, icon('chev-right'), summary),
    ...children,
  );
}

function noteList(list, short = false) {
  return list.length ? el('ul', { class: 'night-note-list', 'aria-label': t('night.notes.list') }, ...list.map((note) => noteItem(note, short))) : null;
}

/** A note box and its "Dejar la nota"; an agent's box with a proposal also shows its warnings and "Mejorar con IA". */
function noteForm(key, label, workspaceId, terminalId) {
  const draft = draftFor(key);
  const proposal = terminalId ? proposals.get(terminalId) : null;
  return el(
    'div',
    { class: 'field night-draft' },
    el('label', { for: draft.id }, label),
    proposal?.origin ?? null,
    proposal?.improve.node ?? null,
    draft.input,
    draft.warn,
    el('p', { class: 'hint', id: `${draft.id}-hint` }, t('night.notes.hint', { max: NOTE_MAX_CHARS })),
    draft.error,
    el(
      'button',
      { type: 'button', class: 'btn', 'data-night-focus': `save-${key}`, disabled: draft.busy, 'aria-busy': draft.busy ? 'true' : undefined, onclick: () => saveNote(key, workspaceId, terminalId) },
      draft.busy ? t('night.notes.saving') : t('night.notes.save'),
    ),
  );
}

/** An agent row's summary: its state chip, its path and its short status ("propuesta lista", "nota dejada", "sin nota"). */
function rowSummary(agent, status) {
  return [
    el('span', { class: `night-tag night-state-${agent.state}` }, t(`night.bedtime.state.${agent.state}`)),
    el('span', { class: 'night-place' }, agent.folders.length ? agent.folders.join(' › ') : t('inbox.root')),
    el('span', { class: `night-row-status ${status}` }, t(`night.bedtime.status.${status}`)),
  ];
}

/** An agent under "Pendientes": a folded row with what it has left and its one note box. */
function agentItem(agent, workspaceId, workspaceName) {
  const where = agent.folders.length ? agent.folders.join(' › ') : t('inbox.root');
  const draft = draftFor(`t:${agent.terminalId}`);
  const proposal = proposals.get(agent.terminalId);
  const fresh = proposal ? describeSource(proposal) : null;
  const row = bedtimeRow(agent, { proposed: !!fresh && !!draft.input.value.trim() });
  const label = fresh ? t('night.proposal.label', { when: fresh.when }) : t('night.bedtime.agentNote', { place: `${workspaceName} › ${where}` });
  return el(
    'li',
    { class: 'night-item' },
    disclosure(
      `agent-${agent.terminalId}`,
      row.open,
      rowSummary(agent, row.status),
      { class: 'night-agent' },
      agent.activity ? el('p', { class: 'night-summary' }, agent.activity) : null,
      agent.waitingFor ? el('p', { class: 'night-left' }, t('night.bedtime.waitingFor', { what: agent.waitingFor })) : null,
      agent.closingQuestion ? el('div', {}, el('p', { class: 'muted tracking-small' }, t('night.bedtime.asks')), el('blockquote', { class: 'night-message' }, agent.closingQuestion)) : null,
      agent.connected ? null : el('p', { class: 'night-warn' }, t('night.bedtime.notConnected')),
      noteList(agent.notes),
      noteForm(`t:${agent.terminalId}`, label, workspaceId, agent.terminalId),
    ),
  );
}

/** An agent under "Con nota": a folded row with its notes for tonight, each with its time and its remove button. */
function notedItem(agent) {
  const row = bedtimeRow(agent, { noted: true });
  return el('li', { class: 'night-item' }, disclosure(`agent-${agent.terminalId}`, row.open, rowSummary(agent, row.status), { class: 'night-agent' }, noteList(agent.tonight)));
}

function notedBlock(entry) {
  const name = entry.name ?? workspaceById(entry.workspaceId)?.name ?? entry.workspaceId;
  return el('div', { class: 'night-group' }, el('h4', {}, name), el('ul', { class: 'night-items' }, ...entry.agents.map(notedItem)));
}

function setBedtimeTab(key) {
  bedtimeShown = bedtimeTab(key);
  prefs.write('nightBedtimeTab', bedtimeShown);
  renderBedtime(true);
}

/** "Pendientes (N)" and "Con nota (N)": one pressed button each, redrawn in the persistent group. */
function renderBedtimeTabs(counts) {
  bedtimeTabsNode.setAttribute('aria-label', t('night.bedtime.tabs'));
  redraw(
    bedtimeTabsNode,
    BEDTIME_TABS.map((key) =>
      el(
        'button',
        { type: 'button', class: 'btn', 'aria-pressed': String(bedtimeShown === key), 'data-night-focus': `bedtime-tab-${key}`, onclick: () => setBedtimeTab(key) },
        t(`night.bedtime.tab.${key}`, { count: counts[key] }),
      ),
    ),
  );
}

/** The ⓘ next to the tabs (an "i" drawn in a circle, so it reads in every font): what the sheet is for, the capacity advice for this machine and, with the tabs, what moves an agent. */
function bedtimeAbout(withTabs) {
  const advice = queueAdvice(queueSettings, t);
  return disclosure(
    'bedtime-about',
    false,
    [el('span', { class: 'night-about-mark', 'aria-hidden': 'true', title: t('night.bedtime.about') }, 'i'), el('span', { class: 'night-sr' }, t('night.bedtime.about'))],
    { class: 'night-about', label: t('night.bedtime.about') },
    el(
      'div',
      { class: 'night-about-body' },
      el('p', {}, t('night.bedtime.intro')),
      advice ? el('p', {}, el('strong', {}, advice), ' ', t('night.queue.adviceHint')) : null,
      withTabs ? el('p', {}, t('night.bedtime.tabsHint')) : null,
    ),
  );
}

function workspaceBlock(entry) {
  const name = entry.name ?? workspaceById(entry.workspaceId)?.name ?? entry.workspaceId;
  return el(
    'div',
    { class: 'night-group' },
    el('h4', {}, name, entry.needsYou ? el('span', { class: 'night-count' }, count('night.bedtime.needsYou', entry.needsYou)) : null),
    entry.hasMission === false ? el('p', { class: 'night-warn' }, t('night.bedtime.noMission')) : null,
    entry.hasMission === null ? el('p', { class: 'muted tracking-small' }, t('night.bedtime.noAgents')) : null,
    entry.agents.length
      ? el('ul', { class: 'night-items' }, ...entry.agents.map((agent) => agentItem(agent, entry.workspaceId, name)))
      : null,
    noteList(entry.notes),
    entry.hasMission === null ? null : noteForm(`w:${entry.workspaceId}`, t('night.bedtime.workspaceNote', { name }), entry.workspaceId, null),
    entry.otherNotes.length
      ? disclosure(`closed-${entry.workspaceId}`, false, t('night.bedtime.closedNotes', { count: entry.otherNotes.length }), { class: 'night-closed' }, noteList(entry.otherNotes, true))
      : null,
  );
}

/** `force`: also while a note is being written (after its own save or removal). */
function renderBedtime(force = false) {
  // A refresh never pulls the textarea from under the keyboard: it waits for the focus to leave.
  if (!force && parts.bedtime.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') {
    bedtimeStale = true;
    return;
  }
  bedtimeStale = false;
  const body = [];
  if (bedtimeError) body.push(el('p', { class: 'tracking-error', role: 'alert' }, t('night.failed.bedtime', { error: bedtimeError })));
  else if (reminder === null || notes === null) body.push(el('p', { class: 'muted' }, t('tracking.loading')));
  else {
    const entries = bedtimeView(reminder, notes, state.workspaces.map((w) => w.id));
    const tabs = bedtimeTabs(entries, status);
    notePlans = notePlan(reminder, notes, status?.active ? status.queue : queueSettings, !!status?.active);
    // Proposals of agents that closed meanwhile are dropped with their rows.
    const open = new Set(entries.flatMap((entry) => entry.agents.map((agent) => agent.terminalId)));
    for (const id of proposals.keys()) if (!open.has(id)) proposals.delete(id);
    if (reminder.waiting) body.push(el('p', { class: 'night-left' }, count('night.bedtime.waiting', reminder.waiting)));
    if (entries.length) renderBedtimeTabs(tabs.counts);
    body.push(el('div', { class: 'night-bedtime-bar' }, entries.length ? bedtimeTabsNode : null, bedtimeAbout(entries.length > 0)));
    if (!entries.length) body.push(el('p', { class: 'tracking-empty' }, t('night.bedtime.empty')));
    else if (bedtimeShown === 'noted') {
      body.push(tabs.noted.length ? el('div', { class: 'night-bedtime-list' }, ...tabs.noted.map(notedBlock)) : el('p', { class: 'tracking-empty' }, t('night.bedtime.notedEmpty')));
    } else {
      if (!tabs.counts.pending && tabs.counts.noted) body.push(el('p', { class: 'tracking-empty' }, t('night.bedtime.pendingEmpty')));
      body.push(el('div', { class: 'night-bedtime-list' }, ...tabs.pending.map(workspaceBlock)));
    }
  }
  body.push(el('p', { class: `night-notice${bedtimeNotice?.tone === 'error' ? ' error' : ''}`, role: 'status' }, bedtimeNotice?.text ?? ''));
  // The dialog that shows it carries the title.
  redraw(parts.bedtime, ...body);
  // Inputs are moved, not rebuilt: their labels follow the language.
  for (const draft of drafts.values()) draft.input.placeholder = t('night.notes.example');
  for (const proposal of proposals.values()) proposal.improve.relabel();
}

/* ---------- Shift settings: folded parts ---------- */

/**
 * One part of the shift settings: a fold whose summary carries its title and its current value in
 * one line. It starts open only with an error, and a new error opens it again, also after the user
 * folded it (they may fold it once more). Its read error and its save state go after it, never inside.
 */
function settingPart(key, title, value, error, ...children) {
  if (error && !partErrors.has(key)) opened.set(key, true);
  if (error) partErrors.add(key);
  else partErrors.delete(key);
  return disclosure(
    key,
    !!error,
    [el('h3', { id: key }, title), value ? el('span', { class: 'night-setting-value' }, value) : null],
    { class: 'night-setting' },
    ...children,
  );
}

/** A part's small "Cómo funciona": its about text and its long hints, folded. */
function howItWorks(key, ...children) {
  return disclosure(`${key}-how`, false, t('night.how'), { class: 'night-how' }, ...children);
}

/* ---------- Schedule ---------- */

/** Day names in the panel's language (2026-01-04 was a Sunday). */
const dayName = (day) => new Intl.DateTimeFormat(getLanguage(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)));

function buildScheduleForm() {
  const touch = () => {
    scheduleDirty = true;
  };
  sched.enabled = el('input', { type: 'checkbox', id: 'night-sched-enabled', 'data-night-focus': 'sched-enabled' });
  sched.days = new Map(WEEK_ORDER.map((day) => [day, el('input', { type: 'checkbox', id: `night-sched-day-${day}`, value: String(day), 'data-night-focus': `sched-day-${day}` })]));
  sched.start = el('input', { type: 'time', id: 'night-sched-start', required: true, 'data-night-focus': 'sched-start', 'aria-describedby': 'night-sched-zone night-sched-start-error' });
  sched.end = el('input', { type: 'time', id: 'night-sched-end', required: true, 'data-night-focus': 'sched-end', 'aria-describedby': 'night-sched-end-hint night-sched-end-error' });
  sched.remind = el('input', { type: 'number', id: 'night-sched-remind', min: '0', max: '240', step: '5', inputmode: 'numeric', 'data-night-focus': 'sched-remind', 'aria-describedby': 'night-sched-remind-hint night-sched-remind-error' });
  sched.errors = Object.fromEntries(['days', 'start', 'end', 'remind'].map((field) => [field, el('p', { class: 'field-error', id: `night-sched-${field}-error` })]));
  for (const input of [sched.enabled, ...sched.days.values(), sched.start, sched.end, sched.remind]) {
    input.addEventListener('input', touch);
    input.addEventListener('change', touch);
  }
}

function scheduleValues() {
  return {
    enabled: sched.enabled.checked,
    days: [...sched.days].filter(([, box]) => box.checked).map(([day]) => day),
    start: sched.start.value,
    end: sched.end.value,
    remind: sched.remind.value,
  };
}

function fillSchedule(saved) {
  const values = scheduleForm(saved);
  sched.enabled.checked = values.enabled;
  for (const [day, box] of sched.days) box.checked = values.days.includes(day);
  sched.start.value = values.start;
  sched.end.value = values.end;
  sched.remind.value = values.remind;
  scheduleDirty = false;
}

function showScheduleErrors(errors) {
  const targets = { days: sched.days.get(WEEK_ORDER[0]), start: sched.start, end: sched.end, remind: sched.remind };
  for (const field of Object.keys(sched.errors)) {
    sched.errors[field].textContent = errors[field] ? t(errors[field]) : '';
    if (field !== 'days') targets[field].setAttribute('aria-invalid', errors[field] ? 'true' : 'false');
  }
  const first = Object.keys(targets).find((field) => errors[field]);
  if (first) targets[first].focus();
}

async function saveSchedule() {
  if (scheduleBusy) return;
  const { schedule: body, errors } = checkScheduleForm(scheduleValues());
  showScheduleErrors(errors);
  if (!body) return;
  scheduleBusy = true;
  scheduleNotice = null;
  renderSchedule(true);
  try {
    schedule = await api('PUT', '/api/night/schedule', body);
    scheduleError = null;
    fillSchedule(schedule.schedule);
    scheduleNotice = { tone: 'ok', text: t(body.enabled ? 'night.schedule.saved' : 'night.schedule.savedOff') };
    // Saving inside the window turns the night shift on: the switch shows it.
    status = await api('GET', '/api/night').catch(() => status);
  } catch (error) {
    // The form keeps what was chosen.
    scheduleNotice = { tone: 'error', text: t('night.schedule.failed', { error: errorText(error) }) };
  } finally {
    scheduleBusy = false;
  }
  renderHead();
  renderBanner();
  renderSchedule(true);
  emit('night');
}

function scheduleSummaryLine() {
  if (!schedule) return null;
  if (!schedule.schedule.enabled) return el('p', { class: 'muted' }, t('night.schedule.off'));
  const bits = [];
  if (schedule.current) bits.push(t('night.schedule.now', { end: when(schedule.current.end) }));
  if (schedule.offUntil) bits.push(t('night.schedule.offUntil', { time: when(schedule.offUntil) }));
  if (schedule.next) {
    bits.push(t('night.schedule.next', { start: when(schedule.next.start), end: when(schedule.next.end) }));
    if (schedule.next.remindAt) bits.push(t('night.schedule.remindAt', { time: when(schedule.next.remindAt) }));
  }
  return el('p', { class: 'night-on' }, bits.join(' · '));
}

/** `force`: also while one of its inputs has the focus (after a save). */
function renderSchedule(force = false) {
  if (!sched.enabled) buildScheduleForm();
  // Building the form moves its inputs out of the page, which drops the focus (and the caret)
  // before redraw() can see it: a refresh waits for the focus to leave them.
  const focused = parts.schedule.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
  if (focused && !force) {
    scheduleStale = true;
    return;
  }
  scheduleStale = false;
  if (schedule && !scheduleDirty && !scheduleBusy) fillSchedule(schedule.schedule);
  const field = (input, label, hint, error, hintId) =>
    el('div', { class: 'field' }, el('label', { for: input.id }, label), input, hint ? el('p', { class: 'hint', id: hintId }, hint) : null, error);
  const error = scheduleError || scheduleNotice?.tone === 'error' || Object.values(sched.errors).some((node) => node.textContent);
  redraw(
    parts.schedule,
    settingPart(
      'night-schedule',
      t('night.schedule'),
      scheduleSummary(schedule, getLanguage(), t),
      error,
      howItWorks('night-schedule', el('p', { class: 'hint' }, t('night.schedule.about'))),
      scheduleSummaryLine(),
      scheduleError && !schedule
        ? null
        : el(
            'form',
            {
              class: 'night-schedule-form',
              novalidate: true,
              onsubmit: (event) => {
                event.preventDefault();
                saveSchedule();
              },
            },
            el('div', { class: 'field night-check' }, sched.enabled, el('label', { for: sched.enabled.id }, t('night.schedule.enabled'))),
            el(
              'fieldset',
              { class: 'night-days', 'aria-describedby': 'night-sched-days-error' },
              el('legend', {}, t('night.schedule.days')),
              ...WEEK_ORDER.map((day) => el('span', { class: 'night-day' }, sched.days.get(day), el('label', { for: sched.days.get(day).id }, dayName(day)))),
              sched.errors.days,
            ),
            el(
              'div',
              { class: 'night-times' },
              field(sched.start, t('night.schedule.start'), null, sched.errors.start),
              field(sched.end, t('night.schedule.end'), t('night.schedule.endHint'), sched.errors.end, 'night-sched-end-hint'),
              field(sched.remind, t('night.schedule.remind'), t('night.schedule.remindHint'), sched.errors.remind, 'night-sched-remind-hint'),
            ),
            el('p', { class: 'hint', id: 'night-sched-zone' }, t('night.schedule.zone', { zone: schedule?.timeZone ?? state.config.timeZone })),
            el(
              'div',
              { class: 'night-actions' },
              el('button', { type: 'submit', class: 'btn primary', 'data-night-focus': 'sched-save', disabled: scheduleBusy, 'aria-busy': scheduleBusy ? 'true' : undefined }, scheduleBusy ? t('night.schedule.saving') : t('night.schedule.save')),
            ),
          ),
    ),
    scheduleError ? el('p', { class: 'tracking-error', role: 'alert' }, t('night.failed.schedule', { error: scheduleError })) : null,
    el('p', { class: `night-notice${scheduleNotice?.tone === 'error' ? ' error' : ''}`, role: 'status' }, scheduleNotice?.text ?? ''),
  );
  if (focused?.isConnected && document.activeElement !== focused) focused.focus();
}

/* ---------- The night queue's N ---------- */

function buildQueueForm() {
  queueForm.input = el('input', { type: 'number', id: 'night-queue-slots', min: '1', max: '50', step: '1', inputmode: 'numeric', 'data-night-focus': 'queue-slots', 'aria-describedby': 'night-queue-hint night-queue-error' });
  queueForm.error = el('p', { class: 'field-error', id: 'night-queue-error' });
  queueForm.input.addEventListener('input', () => {
    queueDirty = true;
    // A number that shows an error is checked again as it changes.
    if (queueForm.input.getAttribute('aria-invalid') === 'true' && !checkSlots(queueForm.input.value).error) {
      queueForm.input.setAttribute('aria-invalid', 'false');
      queueForm.error.textContent = '';
    }
  });
}

/** Saves N (`slots`), or goes back to the suggested one (null). */
async function saveSlots(slots) {
  if (queueBusy) return;
  queueBusy = true;
  queueNotice = null;
  renderQueue(true);
  try {
    queueSettings = await api('PUT', '/api/night/queue', { slots });
    queueError = null;
    queueDirty = false;
    queueNotice = { tone: 'ok', text: t('night.queue.saved', { slots: queueSettings.slots }) };
    if (status?.active) status = await api('GET', '/api/night').catch(() => status);
  } catch (error) {
    // The number typed stays in the field.
    queueNotice = { tone: 'error', text: t('night.queue.failed', { error: errorText(error) }) };
  } finally {
    queueBusy = false;
  }
  renderQueue(true);
  renderHead();
  renderBedtime();
}

function submitSlots() {
  const checked = checkSlots(queueForm.input.value);
  queueForm.input.setAttribute('aria-invalid', checked.error ? 'true' : 'false');
  queueForm.error.textContent = checked.error ? t(checked.error) : '';
  if (checked.error) return queueForm.input.focus();
  return saveSlots(checked.slots);
}

/** `force`: also while its input has the focus (after a save). */
function renderQueue(force = false) {
  if (!parts.queue) return;
  if (!queueForm.input) buildQueueForm();
  const focused = document.activeElement === queueForm.input;
  if (focused && !force) {
    queueStale = true;
    return;
  }
  queueStale = false;
  if (queueSettings && !queueDirty && !queueBusy) queueForm.input.value = String(queueSettings.slots);
  const advice = queueAdvice(queueSettings, t);
  const error = queueError || queueNotice?.tone === 'error' || queueForm.error.textContent;
  redraw(
    parts.queue,
    settingPart(
      'night-queue',
      t('night.queue'),
      queueSummary(queueSettings, t),
      error,
      howItWorks('night-queue', el('p', { class: 'hint' }, t('night.queue.about'))),
      advice ? el('p', { class: 'night-on' }, advice) : null,
      queueError && !queueSettings
        ? null
        : el(
            'form',
            {
              class: 'night-queue-form',
              novalidate: true,
              onsubmit: (event) => {
                event.preventDefault();
                submitSlots();
              },
            },
            el(
              'div',
              { class: 'field' },
              el('label', { for: queueForm.input.id }, t('night.queue.label')),
              queueForm.input,
              el('p', { class: 'hint', id: 'night-queue-hint' }, t('night.queue.hint', { suggested: queueSettings?.suggested ?? '' })),
              queueForm.error,
            ),
            el(
              'div',
              { class: 'night-actions' },
              el('button', { type: 'submit', class: 'btn primary', 'data-night-focus': 'queue-save', disabled: queueBusy, 'aria-busy': queueBusy ? 'true' : undefined }, queueBusy ? t('night.queue.saving') : t('night.queue.save')),
              queueSettings?.custom
                ? el('button', { type: 'button', class: 'btn', 'data-night-focus': 'queue-suggested', disabled: queueBusy, onclick: () => saveSlots(null) }, t('night.queue.useSuggested', { suggested: queueSettings.suggested }))
                : null,
            ),
          ),
    ),
    queueError ? el('p', { class: 'tracking-error', role: 'alert' }, t('night.failed.queue', { error: queueError })) : null,
    el('p', { class: `night-notice${queueNotice?.tone === 'error' ? ' error' : ''}`, role: 'status' }, queueNotice?.text ?? ''),
  );
  if (focused && queueForm.input.isConnected && document.activeElement !== queueForm.input) queueForm.input.focus();
}

/* ---------- Resource profile and budget ---------- */

async function chooseProfile(name) {
  if (profileBusy || !profile || name === profile.profile) return;
  profileBusy = name;
  profileNotice = null;
  renderProfile();
  try {
    profile = await api('PUT', '/api/profile', { profile: name });
    profileError = null;
    profileNotice = { tone: 'ok', text: t('night.profile.saved', { name: t(`night.profile.name.${profile.profile}`) }) };
    // The tracking view follows the new refresh interval.
    emit('profile', profile);
  } catch (error) {
    profileNotice = { tone: 'error', text: t('night.profile.failed', { error: errorText(error) }) };
  } finally {
    profileBusy = null;
  }
  renderProfile();
  renderHead();
}

function valueText(key, value) {
  const shown = profileValue(key, value);
  return shown.key ? t(shown.key) : shown.text;
}

function profileChoices(table) {
  return el(
    'fieldset',
    // Never disabled while saving, so the keyboard focus stays on the option just chosen.
    { class: 'night-profile-choices', 'aria-describedby': 'night-profile-about', 'aria-busy': profileBusy ? 'true' : undefined },
    el('legend', { class: 'night-sr' }, t('night.profile')),
    ...table.columns.map((name) => {
      const id = `night-profile-${name}`;
      return el(
        'span',
        { class: 'night-profile-choice' },
        el('input', {
          type: 'radio',
          id,
          name: 'night-profile',
          value: name,
          checked: (profileBusy ?? table.selected) === name || undefined,
          'data-night-focus': id,
          onchange: () => chooseProfile(name),
        }),
        el('label', { for: id }, t(`night.profile.name.${name}`), el('span', { class: 'muted' }, ` — ${t(`night.profile.blurb.${name}`)}`)),
      );
    }),
  );
}

function profileTableNode(table) {
  return el(
    'table',
    { class: 'night-profile-table' },
    el('caption', { class: 'night-sr' }, t('night.profile.table')),
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col' }, t('night.profile.knob')),
        ...table.columns.map((name) => el('th', { scope: 'col', class: name === table.selected ? 'selected' : undefined, 'aria-current': name === table.selected ? 'true' : undefined }, t(`night.profile.name.${name}`))),
      ),
    ),
    el(
      'tbody',
      {},
      ...table.rows.map((row) =>
        el(
          'tr',
          { class: row.overridden ? 'overridden' : undefined },
          el(
            'th',
            { scope: 'row' },
            t(`night.profile.knob.${row.key}`),
            row.overridden ? el('span', { class: 'night-profile-override' }, t('night.profile.override', { value: valueText(row.key, row.effective) })) : null,
          ),
          ...row.values.map((value, i) => el('td', { class: table.columns[i] === table.selected ? 'selected' : undefined }, valueText(row.key, value))),
        ),
      ),
    ),
  );
}

/** The native meter of one budget row (green until 80 %), labelled with the full sentence. */
function meterNode(row) {
  const max = Math.max(row.limit, 1);
  const label = t(`night.budget.${row.key}`, { used: row.used, limit: row.limit });
  return el('meter', { min: '0', max: String(max), low: String(max * 0.8), high: String(max * 0.99), optimum: '0', value: String(Math.min(row.used, max)), 'aria-label': label });
}

function budgetNode(rows) {
  if (!rows.length) return null;
  return el(
    'ul',
    { class: 'night-budget', 'aria-label': t('night.budget') },
    ...rows.map((row) =>
      el(
        'li',
        { class: `night-budget-row ${row.tone}` },
        el('span', {}, t(`night.budget.${row.key}`, { used: row.used, limit: row.limit })),
        meterNode(row),
        row.tone === 'danger' ? el('span', { class: 'night-budget-out' }, t(`night.budget.out.${row.key}`)) : null,
      ),
    ),
  );
}

function renderProfile() {
  if (!parts.profile) return;
  const table = profileTable(profile);
  // A row that config.json overrides opens the table by itself: what runs is not what the profile says.
  const overridden = !!table?.rows.some((row) => row.overridden);
  const error = profileError || profileNotice?.tone === 'error';
  redraw(
    parts.profile,
    settingPart(
      'night-profile',
      t('night.profile'),
      profileSummary(profile, t),
      error,
      howItWorks('night-profile', el('p', { class: 'hint', id: 'night-profile-about' }, t('night.profile.about'))),
      !table ? (profileError ? null : el('p', { class: 'muted' }, t('tracking.loading'))) : profileChoices(table),
      table
        ? disclosure(
            'night-profile-table',
            overridden,
            t('night.profile.table'),
            { class: 'night-profile-more' },
            profileTableNode(table),
            overridden ? el('p', { class: 'hint' }, t('night.profile.overrideHint')) : null,
          )
        : null,
      budgetNode(budgetMeter(profile?.budget)),
    ),
    profileError ? el('p', { class: 'tracking-error', role: 'alert' }, t('night.failed.profile', { error: profileError })) : null,
    el('p', { class: `night-notice${profileNotice?.tone === 'error' ? ' error' : ''}`, role: 'status' }, profileNotice?.text ?? ''),
  );
}

/* ---------- Telegram ---------- */

function fieldError(input, error, text) {
  input.setAttribute('aria-invalid', text ? 'true' : 'false');
  error.textContent = text ?? '';
}

async function telegramAction(kind, run) {
  if (telegramBusy) return;
  telegramBusy = kind;
  telegramNotice = null;
  renderTelegram();
  try {
    telegramNotice = { tone: 'ok', text: await run() };
  } catch (error) {
    telegramNotice = { tone: 'error', text: t(`night.telegram.failed.${kind}`, { error: errorText(error) }) };
  } finally {
    telegramBusy = null;
  }
  renderTelegram();
}

function saveTelegram() {
  const botToken = tokenInput.value.trim();
  const chatId = chatInput.value.trim();
  fieldError(tokenInput, tokenError, botToken ? null : t('night.telegram.tokenNeeded'));
  fieldError(chatInput, chatError, chatId ? null : t('night.telegram.chatNeeded'));
  if (!botToken) return tokenInput.focus();
  if (!chatId) return chatInput.focus();
  // The token leaves the page with this request and is never kept or shown again.
  tokenInput.value = '';
  return telegramAction('save', async () => {
    await api('PUT', '/api/night/telegram', { botToken, chatId });
    chatInput.value = '';
    await loadTelegram();
    return t('night.telegram.saved');
  });
}

function testTelegram() {
  return telegramAction('test', async () => {
    await api('POST', '/api/night/telegram/test');
    return t('night.telegram.tested');
  });
}

async function removeTelegram() {
  const confirmed = await confirmDialog({
    title: t('night.telegram.removeTitle'),
    message: t('night.telegram.removeBody'),
    confirmLabel: t('night.telegram.removeConfirm'),
    cancelLabel: t('common.cancel'),
    danger: true,
  });
  if (!confirmed) return;
  await telegramAction('remove', async () => {
    await api('DELETE', '/api/night/telegram');
    await loadTelegram();
    return t('night.telegram.removed');
  });
}

function toggleAnswers(enabled) {
  return telegramAction('answers', async () => {
    await api('PUT', '/api/night/telegram/answers', { enabled });
    await loadTelegram();
    return enabled ? t('night.telegram.answers.savedOn') : t('night.telegram.answers.savedOff');
  });
}

/** The switch's usual hint, long enough to sit in the part's "Cómo funciona"; why it is disabled stays under it. */
const LONG_ANSWERS_HINT = 'night.telegram.answers.hint';

/** The «Responder desde Telegram» switch for `view` (telegramAnswersView). */
function answersSwitch(view) {
  return el(
    'div',
    { class: 'field night-telegram-answers' },
    el(
      'button',
      {
        type: 'button',
        class: `night-switch${view.checked ? ' on' : ''}`,
        role: 'switch',
        'aria-checked': String(view.checked),
        'aria-labelledby': 'night-tg-answers',
        'aria-describedby': 'night-tg-answers-hint',
        'aria-busy': telegramBusy === 'answers' ? 'true' : undefined,
        'data-night-focus': 'tg-answers',
        disabled: view.disabled || !!telegramBusy,
        onclick: () => toggleAnswers(!view.checked),
      },
      el('span', { class: 'night-switch-track', 'aria-hidden': 'true' }, el('span', { class: 'night-switch-thumb' })),
      el('span', { id: 'night-tg-answers' }, t('night.telegram.answers')),
    ),
    view.hint === LONG_ANSWERS_HINT ? null : el('p', { class: 'hint', id: 'night-tg-answers-hint' }, t(view.hint)),
  );
}

function telegramField(id, label, input, hint, error) {
  return el('div', { class: 'field' }, el('label', { for: id }, label), input, hint ? el('p', { class: 'hint', id: `${id}-hint` }, hint) : null, error);
}

function renderTelegram() {
  if (!tokenInput) {
    // Built once: a language change or a refresh keeps what is being typed.
    tokenError = el('p', { class: 'field-error', id: 'night-token-error' });
    chatError = el('p', { class: 'field-error', id: 'night-chat-error' });
    tokenInput = el('input', { id: 'night-token', 'data-night-focus': 'tg-token', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'night-token-hint night-token-error' });
    chatInput = el('input', { id: 'night-chat', 'data-night-focus': 'tg-chat', type: 'text', autocomplete: 'off', spellcheck: 'false', inputmode: 'numeric', 'aria-describedby': 'night-chat-hint night-chat-error' });
    tokenInput.addEventListener('input', () => tokenInput.getAttribute('aria-invalid') === 'true' && tokenInput.value.trim() && fieldError(tokenInput, tokenError, null));
    chatInput.addEventListener('input', () => chatInput.getAttribute('aria-invalid') === 'true' && chatInput.value.trim() && fieldError(chatInput, chatError, null));
  }
  const configured = !!telegram?.configured;
  const answers = telegramError ? null : telegramAnswersView(telegram, telegramAnswers);
  const busy = (kind) => ({ disabled: !!telegramBusy, 'aria-busy': telegramBusy === kind ? 'true' : undefined });
  const error = telegramError || telegramNotice?.tone === 'error' || tokenError.textContent || chatError.textContent;
  redraw(
    parts.telegram,
    settingPart(
      'night-telegram',
      t('night.telegram'),
      telegramSummary(telegram, telegramError, t),
      error,
      howItWorks(
        'night-telegram',
        el(
          'ol',
          { class: 'night-list night-help' },
          el('li', {}, t('night.telegram.help.bot')),
          el('li', {}, t('night.telegram.help.chat')),
          el('li', {}, t('night.telegram.help.save')),
        ),
        el('p', { class: 'hint' }, t('night.telegram.privacy')),
        answers?.hint === LONG_ANSWERS_HINT ? el('p', { class: 'hint', id: 'night-tg-answers-hint' }, t(answers.hint)) : null,
      ),
      configured ? el('p', { class: 'muted' }, t('night.telegram.configured', { chat: telegram.chatIdMasked ?? '' })) : null,
      answers ? answersSwitch(answers) : null,
      telegramError ? null : el(
        'form',
        {
          class: 'night-telegram-form',
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault();
            saveTelegram();
          },
        },
        telegramField('night-token', t(configured ? 'night.telegram.tokenNew' : 'night.telegram.token'), tokenInput, t('night.telegram.tokenHint'), tokenError),
        telegramField('night-chat', t('night.telegram.chat'), chatInput, t('night.telegram.chatHint'), chatError),
        el(
          'div',
          { class: 'night-actions' },
          el('button', { type: 'submit', class: 'btn primary', 'data-night-focus': 'tg-save', ...busy('save') }, telegramBusy === 'save' ? t('night.telegram.saving') : t('night.telegram.save')),
          configured
            ? el('button', { type: 'button', class: 'btn', 'data-night-focus': 'tg-test', onclick: testTelegram, ...busy('test') }, telegramBusy === 'test' ? t('night.telegram.testing') : t('night.telegram.test'))
            : null,
          configured
            ? el('button', { type: 'button', class: 'btn', 'data-night-focus': 'tg-remove', onclick: removeTelegram, ...busy('remove') }, t('night.telegram.remove'))
            : null,
        ),
      ),
    ),
    telegramError ? el('p', { class: 'tracking-error', role: 'alert' }, telegramError) : null,
    el('p', { class: `night-notice${telegramNotice?.tone === 'error' ? ' error' : ''}`, role: 'status' }, telegramNotice?.text ?? ''),
  );
  tokenInput.placeholder = t('night.telegram.tokenExample');
  chatInput.placeholder = t('night.telegram.chatExample');
}

/* ---------- Mount ---------- */

function renderAll() {
  if (!built) return;
  renderHead();
  renderBanner();
  renderReport();
  renderBedtime();
  renderSchedule();
  renderQueue();
  renderProfile();
  renderTelegram();
}

/**
 * The night shift's parts, built once: `head` (the strip's state, queue, budget and
 * dialog buttons), `banner` (the bedtime reminder) and `report` (the "What Mirador did"
 * lane). Call refreshNight() to poll them.
 */
export function nightParts() {
  if (built) return exposed;
  built = true;
  parts.head = el('section', { class: 'night-strip', 'aria-labelledby': 'night-title' });
  parts.reportHead = el('div', { class: 'tracking-lane-head' });
  parts.reportBody = el('div', { class: 'tracking-lane-body tracking-scroll', tabindex: '0', role: 'region' });
  // The filter sits between the head and the list, so it stays in view while the list scrolls.
  parts.reportFilter = el('div', { class: 'segmented night-filter', role: 'group' });
  parts.report = el('section', { class: 'tracking-lane night-lane', 'aria-labelledby': 'night-report' }, parts.reportHead, parts.reportFilter, parts.reportBody);
  parts.telegram = el('section', { class: 'night-part night-telegram', 'aria-labelledby': 'night-telegram' });
  // Polite and always present: the bedtime banner is announced when its time comes.
  parts.banner = el('div', { class: 'night-banner-slot', role: 'status' });
  parts.bedtime = el('div', { class: 'night-part night-bedtime' });
  bedtimeTabsNode = el('div', { class: 'segmented night-bedtime-tabs', role: 'group' });
  parts.schedule = el('section', { class: 'night-part night-schedule', 'aria-labelledby': 'night-schedule' });
  parts.queue = el('section', { class: 'night-part night-queue', 'aria-labelledby': 'night-queue' });
  parts.profile = el('section', { class: 'night-part night-profile', 'aria-labelledby': 'night-profile' });
  // A refresh that waited for the note being written happens when the focus leaves it.
  parts.bedtime.addEventListener('focusout', () => setTimeout(() => bedtimeStale && renderBedtime(), 0));
  parts.schedule.addEventListener('focusout', () => setTimeout(() => scheduleStale && renderSchedule(), 0));
  parts.queue.addEventListener('focusout', () => setTimeout(() => queueStale && renderQueue(), 0));
  on('language', renderAll);
  on('workspaces', () => {
    renderReport();
    renderBedtime();
  });
  renderAll();
  exposed = { head: parts.head, banner: parts.banner, report: parts.report };
  return exposed;
}
