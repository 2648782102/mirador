// Pure data shaping for the night shift panel (public/features/night.js): the
// records of GET /api/night/report (or of GET /api/night/log while the report is
// missing) become rows the panel draws;
// the schedule form, execution notes and the bedtime view are checked and
// joined here too. No DOM and no core.js: the browser and the tests import it.

/** The judge's verdicts and the tone (CSS color) of their badge. */
export const VERDICT_TONES = { ok: 'ok', doubtful: 'warn', wrong: 'danger' };

/** Outcomes of a night record (src/night/log.ts). */
const OUTCOMES = ['decided', 'followed-up', 'deferred', 'dropped'];

/** The user's own verdicts, sent to POST /api/night/feedback. */
const FEEDBACK = ['right', 'wrong'];

/** Report summary numbers, in the order the panel shows them. */
const SUMMARY_KEYS = ['decided', 'followUps', 'deferred', 'doubtful', 'wrong'];

const folders = (rel) => String(rel ?? '').split('/').filter(Boolean);
const newestFirst = (a, b) => String(b.time).localeCompare(String(a.time));

/** The badge of the judge's `judgment` ({ verdict, note }), or null when absent, null or unknown. */
export function verdictBadge(judgment) {
  const tone = VERDICT_TONES[judgment?.verdict];
  return tone ? { verdict: judgment.verdict, tone, note: typeof judgment.note === 'string' ? judgment.note : '' } : null;
}

/** A confidence of 0-1 as a whole percentage, or null. */
function percent(confidence) {
  return typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? Math.round(confidence * 100) : null;
}

/**
 * One night record as a report row. `type` is 'question' for an intercepted
 * question, 'note' for an execution note the user left (its text in `message`), and
 * 'follow-up' for any other kind (a delegated or finished agent). `from` is who wrote a note:
 * 'mirador' for the note Mirador sends before it puts an idle agent to sleep, else 'user' (also
 * for an old record whose `from` holds a legacy value);
 * null for any other type.
 * `question` is the first question (its header when the text is empty);
 * `choices` are the labels Mirador picked and `message` what it sent the agent.
 */
export function reportRow(record) {
  const isQuestion = record.kind === 'question';
  const isNote = record.kind === 'note';
  const items = record.question?.items ?? [];
  const first = items[0];
  const outcome = OUTCOMES.includes(record.outcome) ? record.outcome : null;
  const decision = record.decision ?? null;
  const followUp = record.followUp ?? null;
  const left = outcome === 'deferred' || outcome === 'dropped';
  const ownReason = decision?.reason ?? followUp?.reason ?? null;
  const reason = left ? record.deferral?.reason ?? ownReason ?? record.policy?.reason ?? record.error ?? null : ownReason;
  const feedback = FEEDBACK.includes(record.feedback?.verdict) ? { verdict: record.feedback.verdict, note: record.feedback.note ?? '' } : null;
  return {
    id: record.id,
    time: record.time,
    terminalId: record.terminalId,
    workspaceId: record.workspaceId ?? null,
    folders: folders(record.rel),
    type: isQuestion ? 'question' : isNote ? 'note' : 'follow-up',
    from: isNote ? (record.note?.from === 'mirador' ? 'mirador' : 'user') : null,
    question: isQuestion && first ? first.question || first.header || null : null,
    moreQuestions: isQuestion ? Math.max(0, items.length - 1) : 0,
    outcome,
    choices: decision?.action === 'answer' && Array.isArray(decision.choices) ? decision.choices.map((choice) => choice.label) : null,
    message: isNote ? record.note?.text ?? null : followUp?.action === 'follow-up' ? followUp.message ?? null : null,
    delivered: record.delivered ?? null,
    reason,
    rule: left ? record.deferral?.rule ?? record.policy?.rule ?? null : null,
    confidence: percent(decision?.confidence ?? followUp?.confidence),
    verdict: verdictBadge(record.judgment),
    feedback,
    error: record.error ?? null,
  };
}

/** Every record as a report row, newest first. */
export function reportRows(records) {
  return (Array.isArray(records) ? records : []).map(reportRow).sort(newestFirst);
}

/**
 * What a report row (reportRow) folds away, in the order its fold shows them:
 * 'outcome' (what Mirador chose, sent or left), 'reason', 'confidence' and 'judge' (the judge's
 * note). Empty when there is nothing to open; the row itself keeps the summary, the verdict and the time.
 */
export function reportDetails(row) {
  const did =
    (row?.outcome === 'decided' && row.choices?.length) || (row?.outcome === 'followed-up' && row.message) || row?.outcome === 'deferred' || row?.outcome === 'dropped';
  return [
    did ? 'outcome' : null,
    row?.reason ? 'reason' : null,
    typeof row?.confidence === 'number' ? 'confidence' : null,
    row?.verdict?.note ? 'judge' : null,
  ].filter(Boolean);
}

/**
 * The report's numbers as [{ key, count }] in a fixed order. From the server's
 * `summary` when there is one (a missing number is hidden); otherwise counted
 * from the records, with the judge's numbers only when some record was judged.
 */
export function reportSummary(summary, records) {
  if (summary && typeof summary === 'object') {
    return SUMMARY_KEYS.filter((key) => Number.isInteger(summary[key])).map((key) => ({ key, count: summary[key] }));
  }
  const list = Array.isArray(records) ? records : [];
  const counted = {
    decided: list.filter((record) => record.outcome === 'decided').length,
    followUps: list.filter((record) => record.outcome === 'followed-up' && record.kind !== 'note').length,
    deferred: list.filter((record) => record.outcome === 'deferred' || record.outcome === 'dropped').length,
    doubtful: list.filter((record) => record.judgment?.verdict === 'doubtful').length,
    wrong: list.filter((record) => record.judgment?.verdict === 'wrong').length,
  };
  const judged = list.some((record) => verdictBadge(record.judgment));
  return SUMMARY_KEYS.filter((key) => judged || (key !== 'doubtful' && key !== 'wrong')).map((key) => ({ key, count: counted[key] }));
}

/* ---------- Groups and filters of the report ---------- */

/** The report's filters, in the order the lane shows them: "All" first, the default. */
export const REPORT_FILTERS = ['all', 'unanswered', 'noNote'];

/** Only Mirador's own decisions and follow-ups take the user's Right / Wrong (and its note); their notes do not. */
const reviewable = (row) => row.type !== 'note';
const FILTER_RULES = {
  all: () => true,
  unanswered: (row) => reviewable(row) && !row.feedback,
  // Right needs no note, so a decision marked Right is not missing one.
  noNote: (row) => reviewable(row) && row.feedback?.verdict !== 'right' && !row.feedback?.note?.trim(),
};

/** The filter remembered for this window when it is known; otherwise "All". */
export function reportFilter(saved) {
  return REPORT_FILTERS.includes(saved) ? saved : 'all';
}

/**
 * The report `rows` under `filter`: the count of every filter, and the rows that pass it
 * grouped by type, Mirador's decisions first and the user's notes for Mirador after, each in
 * the rows' order. A group with no rows is left out.
 */
export function reportView(rows, filter) {
  const chosen = reportFilter(filter);
  const list = Array.isArray(rows) ? rows : [];
  const counts = Object.fromEntries(REPORT_FILTERS.map((key) => [key, list.filter(FILTER_RULES[key]).length]));
  const shown = list.filter(FILTER_RULES[chosen]);
  const groups = [
    { key: 'decisions', rows: shown.filter(reviewable) },
    { key: 'notes', rows: shown.filter((row) => !reviewable(row)) },
  ].filter((group) => group.rows.length);
  return { filter: chosen, counts, groups };
}

/* ---------- Schedule ---------- */

/** Days of the week as the form lists them, Monday first (0 = Sunday, as the server counts). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_REMIND = 240;
/** The server's DEFAULT_SCHEDULE (src/night/schedule.ts). */
const DEFAULT_SCHEDULE = { enabled: false, days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', remindBeforeMinutes: 30 };

/** The form values for a saved schedule (GET /api/night/schedule → schedule), or for the default. */
export function scheduleForm(schedule) {
  const s = schedule && typeof schedule === 'object' ? schedule : DEFAULT_SCHEDULE;
  return { enabled: !!s.enabled, days: Array.isArray(s.days) ? [...s.days] : [...DEFAULT_SCHEDULE.days], start: s.start ?? DEFAULT_SCHEDULE.start, end: s.end ?? DEFAULT_SCHEDULE.end, remind: String(s.remindBeforeMinutes ?? DEFAULT_SCHEDULE.remindBeforeMinutes) };
}

/**
 * The PUT /api/night/schedule body for the form `values`, or null with `errors`
 * ({ field: i18n key }) for each field to fix. An empty reminder means none (0).
 */
export function checkScheduleForm(values) {
  const errors = {};
  const days = [...new Set((values.days ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  if (values.enabled && days.length === 0) errors.days = 'night.schedule.error.days';
  const start = String(values.start ?? '').trim();
  const end = String(values.end ?? '').trim();
  if (!TIME.test(start)) errors.start = 'night.schedule.error.time';
  if (!TIME.test(end)) errors.end = 'night.schedule.error.time';
  else if (start === end) errors.end = 'night.schedule.error.same';
  const remindText = String(values.remind ?? '').trim();
  const remind = remindText === '' ? 0 : Number(remindText);
  if (!/^\d*$/.test(remindText) || !Number.isInteger(remind) || remind < 0 || remind > MAX_REMIND) errors.remind = 'night.schedule.error.remind';
  if (Object.keys(errors).length) return { schedule: null, errors };
  return { schedule: { enabled: !!values.enabled, days, start, end, remindBeforeMinutes: remind }, errors };
}

/* ---------- The shift settings' one-line values ---------- */

/** A day's short name in `lang`, capitalized ("Lun", "Mon"); 2026-01-04 was a Sunday. */
function shortDay(lang, day) {
  const name = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)));
  return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
}

/**
 * The schedule folded to one line (GET /api/night/schedule): "Lun–Vie 23:00–07:00", Monday first,
 * three nights in a row or more as a range; "Apagado" without a schedule; null until it is read.
 * `t` is the translate function.
 */
export function scheduleSummary(view, lang, t) {
  const s = view?.schedule;
  if (!s || typeof s !== 'object') return null;
  if (!s.enabled) return t('night.settings.off');
  const days = WEEK_ORDER.filter((day) => Array.isArray(s.days) && s.days.includes(day));
  const runs = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && WEEK_ORDER.indexOf(day) === WEEK_ORDER.indexOf(run.at(-1)) + 1) run.push(day);
    else runs.push([day]);
  }
  const nights = days.length === WEEK_ORDER.length
    ? t('night.settings.everyNight')
    : runs.flatMap((run) => (run.length >= 3 ? [`${shortDay(lang, run[0])}–${shortDay(lang, run.at(-1))}`] : run.map((day) => shortDay(lang, day)))).join(', ');
  return [nights, `${s.start}–${s.end}`].filter(Boolean).join(' ');
}

/** The night queue's N folded to one line (GET /api/night/queue): "5 a la vez"; null until it is read. */
export function queueSummary(settings, t) {
  return settings && isCount(settings.slots) ? t('night.settings.slots', { slots: settings.slots }) : null;
}

/** The resource profile folded to its name (GET /api/profile): "Equilibrado"; null while unknown. */
export function profileSummary(view, t) {
  return PROFILE_ORDER.includes(view?.profile) ? t(`night.profile.name.${view.profile}`) : null;
}

/** The Telegram bot folded to one word: "Conectado", "Sin configurar", "Desconocido" when its read failed; null while loading. */
export function telegramSummary(telegram, error, t) {
  if (error) return t('night.telegram.unknown');
  if (!telegram) return null;
  return t(telegram.configured ? 'night.telegram.connected' : 'night.telegram.notConfigured');
}

/* ---------- Execution notes and the bedtime view ---------- */

export const NOTE_MAX_CHARS = 2000;

/** The note to send for the textarea's `text`, its length in characters, and the i18n key of its problem (or null). */
export function checkNote(text) {
  const trimmed = String(text ?? '').trim();
  const length = Array.from(trimmed).length;
  return { text: trimmed, error: length === 0 ? 'night.notes.error.empty' : length > NOTE_MAX_CHARS ? 'night.notes.error.long' : null, length };
}

const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));

/** A reminder agent that waits for the user: blocked, asking, or stopped with an error (docs/attention.md). */
const needsYou = (agent) => agent?.state === 'blocked' || agent?.state === 'prompt' || agent?.state === 'error';

/**
 * The "Before bed" list: one entry per workspace of the reminder (GET /api/night/reminder),
 * in sidebar order, each agent with its notes, plus the workspace notes and the notes of
 * terminals that are no longer listed (`otherNotes`). Notes of workspaces the reminder does
 * not list come last as their own entries (name and mission unknown: null).
 */
export function bedtimeView(reminder, notes, workspaceOrder = []) {
  const list = (Array.isArray(notes) ? notes : []).slice().sort(byCreated);
  const entries = new Map();
  for (const workspace of Array.isArray(reminder?.workspaces) ? reminder.workspaces : []) {
    const agents = (workspace.agents ?? []).map((agent) => ({ ...agent, folders: folders(agent.rel), notes: [] }));
    entries.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      name: workspace.name ?? null,
      hasMission: !!workspace.hasMission,
      agents,
      notes: [],
      otherNotes: [],
      needsYou: agents.filter(needsYou).length,
    });
  }
  for (const note of list) {
    let entry = entries.get(note.workspaceId);
    if (!entry) {
      entry = { workspaceId: note.workspaceId, name: null, hasMission: null, agents: [], notes: [], otherNotes: [], needsYou: 0 };
      entries.set(note.workspaceId, entry);
    }
    if (!note.terminalId) entry.notes.push(note);
    else (entry.agents.find((agent) => agent.terminalId === note.terminalId)?.notes ?? entry.otherNotes).push(note);
  }
  const rank = (entry) => (entry.name === null && entry.hasMission === null ? Infinity : workspaceOrder.includes(entry.workspaceId) ? workspaceOrder.indexOf(entry.workspaceId) : workspaceOrder.length);
  return [...entries.values()].sort((a, b) => rank(a) - rank(b) || String(a.workspaceId).localeCompare(String(b.workspaceId)));
}

/* ---------- "Antes de dormir": who still lacks a note ---------- */

/** The dialog's tabs: the agents without a note for tonight first (the default), then those with one. */
export const BEDTIME_TABS = ['pending', 'noted'];

/** The tab remembered for this window when it is known; otherwise "Pendientes". */
export function bedtimeTab(saved) {
  return BEDTIME_TABS.includes(saved) ? saved : 'pending';
}

/**
 * A note for tonight: one not delivered yet, or, while the autopilot is on (GET /api/night),
 * one delivered since it turned on (`status.since`). Earlier deliveries were for another night.
 */
const forTonight = (note, status) =>
  !note.delivered || (!!status?.active && Date.parse(note.deliveredAt ?? '') >= Date.parse(status.since ?? ''));

/**
 * The bedtime view's `entries` (bedtimeView) split in two tabs. `pending`: every entry with only
 * its agents without a note of their own for tonight (the entry stays for its workspace notes and
 * form). `noted`: the entries with agents that have one, each agent with those notes in `tonight`.
 * A workspace note moves no agent. `counts` are agents.
 */
export function bedtimeTabs(entries, status) {
  const list = Array.isArray(entries) ? entries : [];
  const noted = [];
  const pending = list.map((entry) => {
    const split = entry.agents.map((agent) => ({ ...agent, tonight: agent.notes.filter((note) => forTonight(note, status)) }));
    const withNote = split.filter((agent) => agent.tonight.length);
    if (withNote.length) noted.push({ ...entry, agents: withNote });
    return { ...entry, agents: entry.agents.filter((agent) => !withNote.some((other) => other.terminalId === agent.terminalId)) };
  });
  const agents = (tab) => tab.reduce((sum, entry) => sum + entry.agents.length, 0);
  return { counts: { pending: agents(pending), noted: agents(noted) }, pending, noted };
}

/* ---------- "Antes de dormir", one note per agent ---------- */

/**
 * One agent's compact row: its short `status` ('noted' with a note left for tonight, 'proposal'
 * with Mirador's proposal in its box, else 'none') and whether it starts `open` (only an agent
 * waiting for the user, as needsYou counts them).
 */
export function bedtimeRow(agent, { noted = false, proposed = false } = {}) {
  return { status: noted ? 'noted' : proposed ? 'proposal' : 'none', open: needsYou(agent) };
}

/** A folded note's first line (after leading blank lines) and whether more text follows it. */
export function firstLine(text) {
  const lines = String(text ?? '').trim().split('\n');
  return { line: lines[0].trim(), more: lines.length > 1 };
}

/* ---------- The night queue ---------- */

const GIB = 1024 ** 3;
/** The user's N, as PUT /api/night/queue accepts it (src/night/night-queue.ts). */
export const MIN_SLOTS = 1;
export const MAX_SLOTS = 50;

const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * The strip's line for the night queue (GET /api/night → queue, only while the autopilot is on):
 * "Trabajando 5 de 5 · 3 en cola", plus the memory wait; null without a queue. `t` is the translate function.
 */
export function queueLine(queue, t) {
  if (!queue || !isCount(queue.slots) || !isCount(queue.working)) return null;
  const parts = [t('night.queue.working', { working: queue.working, slots: queue.slots })];
  if (isCount(queue.queued) && queue.queued > 0) parts.push(t('night.queue.queued', { count: queue.queued }));
  if (queue.memoryWait === true) parts.push(t('night.queue.memoryWait'));
  return parts.join(' · ');
}

/**
 * The recommendation for this machine (GET /api/night/queue): "Para tus 24 GB: hasta 5 agentes
 * trabajando a la vez" (MemTotal rounded up to whole GB, as the machine is sold), plus the N the user
 * chose when they set one; null without settings.
 */
export function queueAdvice(settings, t) {
  if (!settings || !isCount(settings.suggested)) return null;
  const n = settings.suggested;
  const agents = t(n === 1 ? 'night.queue.agents.one' : 'night.queue.agents.other', { count: n });
  const known = typeof settings.memTotal === 'number' && settings.memTotal > 0;
  const advice = known ? t('night.queue.advice', { gb: Math.ceil(settings.memTotal / GIB), agents }) : t('night.queue.adviceUnknown', { agents });
  return settings.custom && isCount(settings.slots) ? `${advice} · ${t('night.queue.chosen', { slots: settings.slots })}` : advice;
}

/**
 * Where each pending note of an open agent stands in the night queue, by note id. While the autopilot
 * is on (`active`), `queue` is GET /api/night's: a note whose agent has a note entry gets its place
 * ({ state: 'queued', position }). While off, `queue` is GET /api/night/queue's and the plan is what
 * the next activation would do with N = `queue.slots`: an agent working already gets it at once
 * ('working'), the first ones without a slot take the free ones ('now'), the rest wait in the
 * order the notes were left ('queued' with its place). Workspace notes are not planned.
 */
export function notePlan(reminder, notes, queue, active) {
  const plan = new Map();
  if (!queue) return plan;
  const pending = (Array.isArray(notes) ? notes : []).filter((note) => !note.delivered && note.terminalId).sort(byCreated);
  if (active) {
    const items = Array.isArray(queue.items) ? queue.items : [];
    for (const note of pending) {
      const index = items.findIndex((item) => item.terminalId === note.terminalId && item.kind === 'note');
      if (index >= 0) plan.set(note.id, { state: 'queued', position: index + 1 });
    }
    return plan;
  }
  if (!isCount(queue.slots)) return plan;
  const states = new Map();
  for (const workspace of Array.isArray(reminder?.workspaces) ? reminder.workspaces : []) for (const agent of workspace.agents ?? []) states.set(agent.terminalId, agent.state);
  let free = queue.slots - [...states.values()].filter((state) => state === 'working').length;
  let position = 0;
  const byTerminal = new Map();
  for (const note of pending) {
    if (!states.has(note.terminalId)) continue;
    let entry = byTerminal.get(note.terminalId);
    if (!entry) {
      if (states.get(note.terminalId) === 'working') entry = { state: 'working' };
      else if (free > 0) {
        free -= 1;
        entry = { state: 'now' };
      } else entry = { state: 'queued', position: ++position };
      byTerminal.set(note.terminalId, entry);
    }
    plan.set(note.id, { ...entry });
  }
  return plan;
}

/** The line a note's plan (notePlan) shows under it, or null. */
export function noteQueueText(entry, active, t) {
  if (!entry) return null;
  if (active) return entry.state === 'queued' ? t('night.queue.note.queued', { position: entry.position }) : null;
  if (entry.state === 'queued') return t('night.queue.note.plannedQueued', { position: entry.position });
  if (entry.state === 'now') return t('night.queue.note.plannedNow');
  if (entry.state === 'working') return t('night.queue.note.plannedWorking');
  return null;
}

/** The N typed in the shift settings: { slots } for a whole number 1-50, else { error } as an i18n key. */
export function checkSlots(value) {
  const text = String(value ?? '').trim();
  if (!text) return { slots: null, error: 'night.queue.error.empty' };
  const slots = /^\d+$/.test(text) ? Number(text) : NaN;
  return slots >= MIN_SLOTS && slots <= MAX_SLOTS ? { slots, error: null } : { slots: null, error: 'night.queue.error.range' };
}

/* ---------- Resource profiles and the budget meter ---------- */

/** Profiles as the selector lists them, cheapest first (GET /api/profile → profiles). */
export const PROFILE_ORDER = ['ahorro', 'equilibrado', 'potencia'];

/** The knobs a profile sets, in the order the table shows them. */
export const PROFILE_KEYS = ['nightBudget', 'improveBudget', 'nightModel', 'judgeMode', 'maxConcurrent', 'engramCacheMs', 'trackingRefreshMs'];

/** The tracking view's refresh when the profile is unknown, and the range it accepts. */
export const DEFAULT_REFRESH_MS = 15_000;
const MIN_REFRESH_MS = 5_000;
const MAX_REFRESH_MS = 5 * 60_000;

/**
 * The comparison table for GET /api/profile: one column per known profile (fixed order),
 * one row per knob with each profile's value, the effective value and whether a config key
 * overrides it. Null when the answer is not usable.
 */
export function profileTable(view) {
  if (!view || typeof view !== 'object' || !view.profiles || typeof view.profiles !== 'object' || !view.values) return null;
  const columns = PROFILE_ORDER.filter((name) => view.profiles[name] && typeof view.profiles[name] === 'object');
  if (!columns.length) return null;
  const overridden = Array.isArray(view.overridden) ? view.overridden : [];
  return {
    selected: columns.includes(view.profile) ? view.profile : null,
    columns,
    rows: PROFILE_KEYS.map((key) => ({ key, values: columns.map((name) => view.profiles[name][key]), effective: view.values[key], overridden: overridden.includes(key) })),
  };
}

const MODEL = /^claude-([a-z]+)-(\d+)-(\d+)$/;

/** How one knob value reads: `{ text }` as is, or `{ key }` to translate (the judge mode). */
export function profileValue(key, value) {
  if (key === 'nightModel') {
    const match = MODEL.exec(String(value ?? ''));
    return { text: match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : String(value ?? '') };
  }
  if (key === 'judgeMode') return { key: `night.profile.judge.${value}` };
  if (key === 'engramCacheMs' || key === 'trackingRefreshMs') return { text: `${Math.round(Number(value) / 1000)} s` };
  return { text: String(value ?? '') };
}

const usage = (entry) =>
  entry && Number.isInteger(entry.used) && Number.isInteger(entry.limit) && entry.used >= 0 && entry.limit >= 0 ? entry : null;

/**
 * The budget meter: the night's Claude calls and today's "Mejorar con IA" runs as used/limit, a
 * whole percentage (capped at 100) and a tone (ok, warn from 80 %, danger when used up).
 */
export function budgetMeter(budget) {
  const rows = [];
  for (const key of ['night', 'improveToday']) {
    const entry = usage(budget?.[key]);
    if (!entry) continue;
    const percent = entry.limit === 0 ? 100 : Math.min(100, Math.round((entry.used / entry.limit) * 100));
    rows.push({ key, used: entry.used, limit: entry.limit, percent, tone: entry.used >= entry.limit ? 'danger' : percent >= 80 ? 'warn' : 'ok' });
  }
  return rows;
}

/** The tracking refresh of the profile view, within 5 s and 5 min; otherwise 15 s. */
export function refreshMs(view) {
  const value = view?.values?.trackingRefreshMs;
  return Number.isInteger(value) && value >= MIN_REFRESH_MS && value <= MAX_REFRESH_MS ? value : DEFAULT_REFRESH_MS;
}

/** The night's Claude calls of a report summary ({ used, limit }), or null. */
export function reportCalls(summary) {
  return usage(summary?.calls) ? { used: summary.calls.used, limit: summary.calls.limit } : null;
}

/** The nodes a part shows: nested lists flattened, null and undefined dropped (replaceChildren would print "null"). */
export function redrawNodes(nodes) {
  return nodes.flat(Infinity).filter((node) => node !== null && node !== undefined);
}

/* ---------- Autopilot ---------- */

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const QUARTER_MS = 15 * 60_000;

/** The time the "until" field starts with: two hours from `now`, rounded up to the quarter hour, as local HH:MM in `timeZone`. */
export function defaultUntil(now, timeZone) {
  const at = Math.ceil((now + 2 * 60 * 60_000) / QUARTER_MS) * QUARTER_MS;
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

/**
 * What PUT /api/night sends for a manual on: `choice` 'off' ("until I turn it off") sends
 * { active } alone; 'time' sends the local `time` as until (the server makes it today or
 * tomorrow). A time that is not HH:MM gives { error } with the message key.
 */
export function manualOnBody(choice, time) {
  if (choice !== 'time') return { body: { active: true } };
  return LOCAL_TIME.test(time) ? { body: { active: true, until: time } } : { error: 'night.until.error' };
}

/** The state line of an autopilot that is on (GET /api/night): the message key, since and until; null while off. */
export function autopilotState(status) {
  if (!status?.active) return null;
  const since = typeof status.since === 'string' ? status.since : null;
  const until = typeof status.until === 'string' ? status.until : null;
  if (status.source === 'manual') return { key: until ? 'night.state.onManualUntil' : 'night.state.onManual', since, until };
  if (status.source === 'schedule') return { key: 'night.state.onSchedule', since, until: null };
  return { key: since ? 'night.state.onSince' : 'night.state.on', since, until: null };
}

/**
 * The strip's Claude calls: while the autopilot is on by hand there is no cap, so only
 * the count (`limit` and `percent` null); otherwise used of limit with the meter's tone.
 */
export function stripCalls(budget, status) {
  const entry = usage(budget?.night);
  if (!entry) return null;
  if (status?.active && status.source === 'manual') return { used: entry.used, limit: null, uncapped: true, percent: null, tone: 'ok' };
  const row = budgetMeter({ night: entry })[0];
  return { used: row.used, limit: row.limit, uncapped: false, percent: row.percent, tone: row.tone };
}

/* ---------- Pending cards ---------- */

/** Follow-up kinds whose server summary is a fixed English title (src/night/service.ts SUMMARIES). */
const PENDING_TITLES = { 'auto-follow-up': 'night.pending.title.autoFollowUp', delegate: 'night.pending.title.delegate' };

/**
 * The title of a pending card (GET /api/night → pending) in the panel's language: a follow-up
 * by its kind; a question, or a kind this client does not know, keeps the server's text.
 * `t` is the translate function.
 */
export function pendingTitle(item, t) {
  const key = Object.hasOwn(PENDING_TITLES, item?.kind) ? PENDING_TITLES[item.kind] : null;
  if (key) return t(key);
  return typeof item?.summary === 'string' && item.summary ? item.summary : t('night.pending.noSummary');
}

/* ---------- Answering from Telegram ---------- */

/**
 * The «Responder desde Telegram» switch from GET /api/night/telegram (`telegram`) and GET
 * /api/night/telegram/answers (`answers`): null while either is unknown or no bot is set;
 * otherwise whether it shows on, whether it can change, and the i18n key of its hint.
 */
export function telegramAnswersView(telegram, answers) {
  if (!telegram?.configured || !answers || typeof answers.enabled !== 'boolean') return null;
  if (answers.available) return { checked: answers.enabled, disabled: false, hint: 'night.telegram.answers.hint' };
  return { checked: false, disabled: true, hint: answers.privateChat ? 'night.telegram.answers.unavailable' : 'night.telegram.answers.private' };
}
