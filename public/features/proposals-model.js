// Pure rules behind Mirador's proposals from memory: the
// instruction "Delegar a Mirador" opens with, built from each folder's latest Next Steps
// (GET /api/proposals), and the notes "Antes de dormir" proposes to each open agent. What a
// "Mejorar con IA" answer (POST /api/proposals/improve) does to the proposal's field.
// No imports, no DOM: the browser and the tests import it. Limits come from the callers.

const clipTo = (steps, room) => (steps.length <= room ? steps : room <= 1 ? '…' : `${steps.slice(0, room - 1).trimEnd()}…`);

/**
 * The largest share each text may keep so that together they fit `room`: short texts keep all
 * they have and leave the rest to the longer ones (max-min fairness).
 */
function fairShare(lengths, room) {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = room;
  for (const [i, length] of sorted.entries()) {
    const share = Math.floor(left / (sorted.length - i));
    if (length > share) return share;
    left -= length;
  }
  return Infinity;
}

/**
 * The proposal for `sections` ({ label, steps }, one per folder): `lead`, a blank line and the
 * steps. One folder with steps gives its steps alone (as "Traer a Mirador" does); several give a
 * "label:" section each, every one clipped with "…" to a fair share of `max`. Folders without
 * steps contribute nothing; with none left the proposal is empty, so the user writes their own.
 */
export function proposalText(sections, lead, max) {
  const kept = (Array.isArray(sections) ? sections : [])
    .map((section) => ({ label: String(section?.label ?? ''), steps: String(section?.steps ?? '').trim() }))
    .filter((section) => section.steps);
  if (!kept.length) return '';
  const head = `${String(lead ?? '').trim()}\n\n`;
  const titled = kept.length > 1;
  // Each section's label line, and the blank lines between sections.
  const frame = titled ? kept.reduce((sum, section) => sum + section.label.length + 2, 0) + 2 * (kept.length - 1) : 0;
  const share = fairShare(kept.map((section) => section.steps.length), max - head.length - frame);
  const text = head + kept.map((section) => (titled ? `${section.label}:\n` : '') + clipTo(section.steps, share)).join('\n\n');
  // So many folders that even their labels overflow: the last ones are left out.
  return text.length > max && kept.length > 1 ? proposalText(kept.slice(0, -1), lead, max) : text;
}

/** The GET /api/proposals query for folders `rels` of workspace `ws`. */
export const proposalQuery = (ws, rels) => new URLSearchParams([['ws', ws], ...rels.map((rel) => ['rel', rel])]).toString();

const agentsOf = (reminder) =>
  (Array.isArray(reminder?.workspaces) ? reminder.workspaces : []).flatMap((workspace) =>
    (Array.isArray(workspace?.agents) ? workspace.agents : []).map((agent) => ({ workspaceId: workspace.workspaceId, terminalId: agent.terminalId, rel: agent.rel ?? '' })),
  );

/**
 * What to ask GET /api/proposals for the bedtime reminder (GET /api/night/reminder): each
 * workspace once, with the distinct folders of its open agents; agents in `skip` (their
 * proposal is already on screen) are not asked again.
 */
export function proposalAsks(reminder, skip = new Set()) {
  const asks = new Map();
  for (const agent of agentsOf(reminder)) {
    if (skip.has(agent.terminalId)) continue;
    const rels = asks.get(agent.workspaceId) ?? [];
    if (!rels.includes(agent.rel)) rels.push(agent.rel);
    asks.set(agent.workspaceId, rels);
  }
  return [...asks].map(([ws, rels]) => ({ ws, rels }));
}

/**
 * One proposed note per open agent of the reminder whose folder has Next Steps in `answers`
 * (GET /api/proposals bodies): `lead` and the steps, within `max`. Agents without, none.
 */
export function bedtimeProposals(reminder, answers, lead, max) {
  const steps = new Map();
  for (const answer of Array.isArray(answers) ? answers : []) {
    for (const proposal of Array.isArray(answer?.proposals) ? answer.proposals : []) steps.set(`${answer.ws}\u0000${proposal.rel}`, proposal.nextSteps);
  }
  return agentsOf(reminder)
    .map((agent) => ({ ...agent, text: proposalText([{ label: agent.rel, steps: steps.get(`${agent.workspaceId}\u0000${agent.rel}`) }], lead, max) }))
    .filter((proposal) => proposal.text)
    .map(({ terminalId, workspaceId, rel, text }) => ({ terminalId, workspaceId, rel, text }));
}

/* ---------- Fresh proposals ---------- */

const SOURCE_KEYS = ['summaryAt', 'latestMemoryAt', 'newerMemories', 'lastSentAt'];

/**
 * The source of each open agent's proposal, by terminal id: its folder's summaryAt,
 * latestMemoryAt, newerMemories and lastSentAt in `answers` (GET /api/proposals bodies).
 * Agents of workspaces that did not answer have none.
 */
export function bedtimeSources(reminder, answers) {
  const sources = new Map();
  for (const answer of Array.isArray(answers) ? answers : []) {
    for (const proposal of Array.isArray(answer?.proposals) ? answer.proposals : []) {
      sources.set(`${answer.ws}\u0000${proposal.rel}`, Object.fromEntries(SOURCE_KEYS.map((key) => [key, proposal[key] ?? (key === 'newerMemories' ? false : null)])));
    }
  }
  const byAgent = new Map();
  for (const agent of agentsOf(reminder)) {
    const source = sources.get(`${agent.workspaceId}\u0000${agent.rel}`);
    if (source) byAgent.set(agent.terminalId, source);
  }
  return byAgent;
}

const MINUTE = 60_000;

/** Parts of `date` in `timeZone`: day/month in the language's order and the time as 24 h HH:MM. */
function stamp(date, timeZone, language) {
  // Some locales drop the leading zero (es: "2/11"): the order comes from the language, the digits stay two.
  const day = new Intl.DateTimeFormat(language, { day: '2-digit', month: '2-digit', timeZone })
    .formatToParts(date)
    .filter((part) => part.type === 'day' || part.type === 'month')
    .map((part) => part.value.padStart(2, '0'))
    .join('/');
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date);
  return { day, time, full: `${day} ${time}` };
}

/** How long ago: under a minute "now", then minutes, hours up to two days, then days. */
function agoOf(ms) {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return { unit: 'now', count: 0 };
  if (minutes < 60) return { unit: 'min', count: minutes };
  if (minutes < 48 * 60) return { unit: 'h', count: Math.floor(minutes / 60) };
  return { unit: 'd', count: Math.floor(minutes / (24 * 60)) };
}

/**
 * How "Antes de dormir" dates a proposal's `source` (bedtimeSources) at `now` (ms) in
 * `timeZone`: `when` the summary was written ("02/11 21:40") and how long `ago`; the warnings
 * `newerMemory` (the latest memory's time) when work was saved after that summary, and
 * `sentAfter` (its time) when a note or delegation reached the agent after it. A warning's time
 * carries its date when it is not today's. Null when the summary's time is unknown.
 */
export function proposalFreshness(source, now, timeZone, language) {
  const summary = new Date(source?.summaryAt ?? NaN);
  if (Number.isNaN(summary.getTime())) return null;
  const today = stamp(new Date(now), timeZone, language).day;
  const short = (iso) => {
    const date = new Date(iso ?? NaN);
    if (Number.isNaN(date.getTime())) return null;
    const parts = stamp(date, timeZone, language);
    return parts.day === today ? parts.time : parts.full;
  };
  return {
    when: stamp(summary, timeZone, language).full,
    ago: agoOf(now - summary.getTime()),
    newerMemory: source.newerMemories ? short(source.latestMemoryAt) : null,
    sentAfter: short(source.lastSentAt),
  };
}

/**
 * What a new answer does to a proposal on screen (`shown`: { text, original, source }, where
 * `original` is the text Mirador last put there). Untouched by the user, the newer text and source
 * replace it. Edited, the user's text always stays: with the same source only its warnings change; with
 * a newer one the old source stays and `newerSource` says when the newer summary was written.
 * An agent's note box before any proposal is { text: '', original: '' }:
 * empty, it takes the proposal; typed in, it keeps the user's text.
 */
export function refreshedProposal(shown, incoming) {
  if (shown.text === shown.original) return { text: incoming.text, original: incoming.text, source: incoming.source, newerSource: null };
  if (incoming.text === shown.original) return { text: shown.text, original: shown.original, source: incoming.source, newerSource: null };
  return { text: shown.text, original: shown.original, source: shown.source, newerSource: incoming.source?.summaryAt ?? null };
}

/* ---------- "Mejorar con IA" ---------- */

/** The POST /api/proposals/improve body: one folder of workspace `ws` and the draft as it is now. */
export const improveRequest = (ws, rel, draft) => ({ ws, rel: rel ?? '', draft: draft ?? '' });

/**
 * "Mejorar con IA" for one field: `read()`/`write(text)` its text, `request(draft)` Claude's
 * version (one call), `render(view)` after every change. view: `pending` while the call runs
 * (more clicks ask nothing), `error` when it failed (the field is untouched), `suggestion` when
 * the user edited the field since the click (their text is never overwritten: they may apply or
 * dismiss it), `undo` the text "Deshacer" brings back after Claude's version went in.
 */
export function improver({ read, write, request, render }) {
  let view = { pending: false, suggestion: null, undo: null, error: null };
  const show = (change) => {
    view = { ...view, ...change };
    render(view);
  };
  return {
    view: () => view,
    async improve() {
      if (view.pending) return;
      const draft = read();
      show({ pending: true, error: null, suggestion: null });
      let text;
      try {
        text = await request(draft);
      } catch (error) {
        show({ pending: false, error });
        return;
      }
      if (read() === draft) {
        write(text);
        show({ pending: false, undo: draft });
      } else {
        show({ pending: false, suggestion: text });
      }
    },
    apply() {
      if (view.suggestion === null) return;
      const before = read();
      write(view.suggestion);
      show({ suggestion: null, undo: before });
    },
    dismiss() {
      show({ suggestion: null });
    },
    undo() {
      if (view.undo === null) return;
      write(view.undo);
      show({ undo: null });
    },
  };
}
