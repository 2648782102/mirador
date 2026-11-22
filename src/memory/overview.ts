// Workspace overview and "where it left off": pure functions over one Engram read.
import { basename } from 'node:path';
import { localDay, memoByWindow, type Observation } from './daily-summary.ts';
import type { ProjectListing } from './folder-memory.ts';
import { engramTime, leftOffSource, type LeftOffRecord } from './left-off.ts';

/** The parts of a session summary that say where the work stopped. Each is Markdown, or null. */
export interface LeftOffSections {
  goal: string | null;
  accomplished: string | null;
  nextSteps: string | null;
  /** A free-form summary (no heading recognised): its whole text, so it can still be shown. */
  excerpt?: string;
}

// Engram session summaries are Markdown with `## Goal`, `## Accomplished`, `## Next Steps`, ...
// Agents vary the headings a little; these are the variants seen in real summaries.
// `excerpt` has no heading: it is the whole text when none of these is recognised.
const SECTION_NAMES: Record<Exclude<keyof LeftOffSections, 'excerpt'>, RegExp> = {
  goal: /^(goal|objective|objetivo)$/i,
  accomplished: /^(accomplished|done|completed|progress|progress so far|logrado|hecho|avances)$/i,
  nextSteps: /^(next steps?|siguientes pasos|pr[oó]ximos pasos|pendientes?)$/i,
};

/** Splits a session summary into its Goal, Accomplished and Next Steps sections; without any, its text is the excerpt. */
export function leftOffFrom(content: string): LeftOffSections {
  const found: LeftOffSections = { goal: null, accomplished: null, nextSteps: null };
  let current: keyof typeof SECTION_NAMES | null = null;
  let recognised = false;
  let lines: string[] = [];
  const close = () => {
    const text = lines.join('\n').trim();
    if (current && text && found[current] === null) found[current] = text;
    lines = [];
  };
  for (const line of String(content ?? '').split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*:?\s*$/);
    if (heading) {
      close();
      const name = heading[1].trim();
      current = (Object.keys(SECTION_NAMES) as Array<keyof typeof SECTION_NAMES>).find((key) => SECTION_NAMES[key].test(name)) ?? null;
      if (current) recognised = true;
      continue;
    }
    if (current) lines.push(line);
  }
  close();
  const text = String(content ?? '').trim();
  if (!recognised && text) found.excerpt = text;
  return found;
}

/** The first `maxLines` lines (and at most `maxChars` characters) of `text`, with "…" when something was cut. */
export function clip(text: string | null, maxLines: number, maxChars = 2000): string | null {
  if (text === null) return null;
  const lines = text.split('\n');
  const kept = lines.slice(0, maxLines).join('\n');
  if (kept.length > maxChars) return `${kept.slice(0, maxChars).trimEnd()}…`;
  return lines.length > maxLines ? `${kept}\n…` : kept;
}

const trimSlash = (path: string) => path.replace(/\/+$/, '') || '/';

/**
 * Maps folders to Engram project names from one GET /projects answer, by the same
 * rule as the sidebar's memoryLookup (src/memory/folder-memory.ts): a project with
 * observations belongs to a folder when it lists a directory at or below it, or is
 * named like the folder. `at` is for a workspace root: only directories equal to it
 * (or its name) count, since everything below the root belongs to its folders.
 */
export function folderProjects(listing: ProjectListing[]): { under(path: string): string[]; at(path: string): string[] } {
  const withMemory = (Array.isArray(listing) ? listing : [])
    .filter((p) => typeof p?.name === 'string' && (p.observation_count === undefined || p.observation_count > 0))
    .map((p) => ({ name: p.name, lower: p.name.toLowerCase(), dirs: (Array.isArray(p.directories) ? p.directories : []).map(trimSlash) }));
  const match = (path: string, below: boolean) => {
    const folder = trimSlash(path);
    const name = basename(folder).toLowerCase();
    return withMemory
      .filter((p) => p.lower === name || p.dirs.some((dir) => dir === folder || (below && dir.startsWith(folder + '/'))))
      .map((p) => p.name);
  };
  return { under: (path) => match(path, true), at: (path) => match(path, false) };
}

/** A folder of the workspace and the Engram projects it maps to (see folderProjects). */
export interface OverviewFolder {
  name: string;
  /** Relative to the workspace root; '' for the root itself. */
  rel: string;
  path: string;
  isRepo: boolean;
  projects: string[];
  /** Whether Engram holds memory for the folder at all (it may lie beyond the window read). */
  hasMemory: boolean;
}

/**
 * Where a summary from the local record (src/memory/left-off.ts) comes from: Claude Code, from its final
 * message, its compaction summary, or only the user's last message (nothing from the agent yet).
 * An Engram summary has none of these keys.
 */
export interface LocalSource {
  source: 'claude-code';
  from: 'lastMessage' | 'compactSummary' | 'lastUserMessage';
  /** The user's last message, clipped like an excerpt; null when none was recorded. */
  lastUserMessage: string | null;
}

export interface LeftOff {
  /**
   * The newest of the latest Engram session summary and the folder's local record: its sections (or a
   * free-form text's excerpt), each clipped to a few lines, with LocalSource when it is the record.
   */
  summary: ({ at: string } & LeftOffSections & Partial<LocalSource>) | null;
  /** The latest memory that is not a session summary. */
  memory: { title: string; type: string; at: string } | null;
}

export interface FolderRow extends OverviewFolder {
  /** Engram time (UTC) of the folder's latest memory, any day; null when none was read. */
  lastAt: string | null;
  /** The day of `lastAt` in the configured time zone. */
  lastDay: string | null;
  /** Engram holds memory for the folder, but none lies in the window Mirador read. */
  beyondWindow: boolean;
  leftOff: LeftOff;
  /** The chosen day: memories saved or revised, sessions that saved them, the most relevant titles. */
  day: { memories: number; sessions: number; headlines: Headline[] };
}

export interface Headline {
  title: string;
  type: string;
  at: string;
}

export interface WorkspaceSummary {
  folders: number;
  /** Folders with at least one memory on the chosen day. */
  activeFolders: number;
  memories: number;
  sessions: number;
  /** The day's most relevant memories across the workspace, with the folder they belong to. */
  headlines: Array<Headline & { folder: string; rel: string }>;
}

const SESSION_SUMMARY = 'session_summary';
// Most relevant first; unknown types come after these, and passive captures last.
const TYPE_RANK = ['decision', 'architecture', 'bugfix', 'feature', 'discovery', 'pattern', 'config', 'preference', 'learning', 'manual'];
const ROW_HEADLINES = 3;
const SUMMARY_HEADLINES = 6;

/** Engram observations also carry the session that saved them. */
type EngramObservation = Observation & { session_id?: string };

/** Everything one project's observations say, computed once per request. */
interface ProjectDigest {
  lastAt: string;
  latestSummary: Observation | null;
  latestMemory: Observation | null;
  /** Observations saved or revised on the chosen day. */
  dayCount: number;
  daySessions: Set<string>;
  /** The day's observations that are not session summaries: headline candidates. */
  dayItems: Observation[];
}

/** Engram times sort as text ("YYYY-MM-DD HH:MM:SS[.fraction]"). */
function lastTouched(o: Observation): string {
  return o.updated_at && o.updated_at > o.created_at ? o.updated_at : o.created_at;
}

const newer = (a: Observation | null, b: Observation | null) => (!a ? b : !b ? a : lastTouched(b) > lastTouched(a) ? b : a);

function digest(observations: EngramObservation[], date: string, timeZone: string): Map<string, ProjectDigest> {
  const digests = new Map<string, ProjectDigest>();
  for (const o of observations) {
    const touched = lastTouched(o);
    let d = digests.get(o.project);
    if (!d) {
      d = { lastAt: touched, latestSummary: null, latestMemory: null, dayCount: 0, daySessions: new Set(), dayItems: [] };
      digests.set(o.project, d);
    }
    if (touched > d.lastAt) d.lastAt = touched;
    const summary = o.type === SESSION_SUMMARY;
    if (summary) d.latestSummary = newer(d.latestSummary, o);
    else d.latestMemory = newer(d.latestMemory, o);
    if (localDay(o.created_at, timeZone) === date || (touched !== o.created_at && localDay(touched, timeZone) === date)) {
      d.dayCount++;
      if (o.session_id) d.daySessions.add(o.session_id);
      if (!summary) d.dayItems.push(o);
    }
  }
  return digests;
}

/**
 * digest() per Engram window, date and time zone: every workspace overview polled within one
 * window reuses it (the digest is per project, so it does not depend on the workspace).
 * Digests are read-only once built.
 */
const windowDigest = memoByWindow((observations, key) => {
  const [date, timeZone] = JSON.parse(key) as [string, string];
  return digest(observations, date, timeZone);
});

function rank(type: string): number {
  if (type === 'passive') return TYPE_RANK.length + 1;
  const index = TYPE_RANK.indexOf(type);
  return index === -1 ? TYPE_RANK.length : index;
}

/** The most relevant of `items`: by type (decisions first), then newest first. */
function headlines(items: Observation[], limit: number): Observation[] {
  return [...items].sort((a, b) => rank(a.type) - rank(b.type) || (lastTouched(a) > lastTouched(b) ? -1 : lastTouched(a) < lastTouched(b) ? 1 : 0)).slice(0, limit);
}

const toHeadline = (o: Observation): Headline => ({ title: o.title, type: o.type, at: lastTouched(o) });

function dayOf(own: ProjectDigest[]): FolderRow['day'] {
  return {
    memories: own.reduce((sum, d) => sum + d.dayCount, 0),
    sessions: new Set(own.flatMap((d) => [...d.daySessions])).size,
    headlines: headlines(own.flatMap((d) => d.dayItems), ROW_HEADLINES).map(toHeadline),
  };
}

function leftOff(own: ProjectDigest[], excerptLines: number, foldLines: number, goalLines: number, goalChars: number, local: LeftOffRecord | null): LeftOff {
  const summary = own.reduce<Observation | null>((latest, d) => newer(latest, d.latestSummary), null);
  const memory = own.reduce<Observation | null>((latest, d) => newer(latest, d.latestMemory), null);
  const shape = (at: string, sections: LeftOffSections) => ({
    at,
    goal: clip(sections.goal, goalLines, goalChars),
    accomplished: clip(sections.accomplished, foldLines),
    nextSteps: clip(sections.nextSteps, foldLines),
    ...(sections.excerpt !== undefined && { excerpt: clip(sections.excerpt, excerptLines) as string }),
  });
  const memoryRow = memory && { title: memory.title, type: memory.type, at: lastTouched(memory) };
  // The newest wins, judged by the text the view would show (the final message, else the compaction
  // summary), not by the record's latest write, which can be a bare prompt. A record with only a prompt
  // never beats Engram's summary; a tie goes to Engram. Without an Engram summary the record shows.
  const { from, text } = local ? leftOffSource(local) : { from: null, text: null };
  const shownAt = text ? engramTime(text.at) : null;
  if (local && from && (!summary || (shownAt !== null && shownAt > lastTouched(summary)))) {
    const at = engramTime(text?.at ?? local.lastUserMessage?.at ?? local.at);
    const sections = text ? leftOffFrom(text.text) : { goal: null, accomplished: null, nextSteps: null };
    const asked = local.lastUserMessage ? clip(local.lastUserMessage.text, excerptLines) : null;
    return { summary: { ...shape(at, sections), source: local.agent, from, lastUserMessage: asked }, memory: memoryRow };
  }
  return { summary: summary && shape(lastTouched(summary), leftOffFrom(summary.content)), memory: memoryRow };
}

/** The local record as plain mode shows it (GET /api/folder/git `leftOff`): its texts as text, each clipped to `lines`. */
export interface PlainLeftOff extends Omit<LocalSource, 'lastUserMessage'> {
  /** ISO time of the text shown (the user's message when the agent has said nothing yet). */
  at: string;
  /** The final message or the compaction summary; null when only the user's message was recorded. */
  text: string | null;
  lastUserMessage: string | null;
}

export function plainLeftOff(record: LeftOffRecord, lines = 12): PlainLeftOff {
  const { from, text } = leftOffSource(record);
  return {
    source: record.agent,
    from,
    at: text?.at ?? record.lastUserMessage?.at ?? record.at,
    text: text ? clip(text.text, lines) : null,
    lastUserMessage: record.lastUserMessage ? clip(record.lastUserMessage.text, lines) : null,
  };
}

function byRecency(a: FolderRow, b: FolderRow): number {
  if (a.lastAt !== b.lastAt) return a.lastAt === null ? 1 : b.lastAt === null ? -1 : a.lastAt > b.lastAt ? -1 : 1;
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
}

/**
 * The workspace overview for `date`: one row per folder, most recent work first.
 * `observations` is one all-projects Engram read; `windowFull` says it hit the
 * read limit, so a folder with memory but nothing in it worked on before that window.
 */
export function buildWorkspaceOverview(input: {
  date: string;
  timeZone: string;
  folders: OverviewFolder[];
  observations: Observation[];
  windowFull: boolean;
  /** Lines kept of a summary's Accomplished and Next Steps (default 12). */
  excerptLines?: number;
  /** Lines kept of a summary's Accomplished and Next Steps (default excerptLines). */
  foldLines?: number;
  /** Lines kept of a summary's Goal (default 2). */
  goalLines?: number;
  /** Characters kept of a summary's Goal (default 400). Infinity with foldLines and goalLines keeps its sections whole. */
  goalChars?: number;
  /** The folder's local left-off record (src/memory/left-off.ts), or null; none by default. */
  localLeftOff?: (folder: OverviewFolder) => LeftOffRecord | null;
}): { rows: FolderRow[]; summary: WorkspaceSummary } {
  const digests = windowDigest(input.observations, JSON.stringify([input.date, input.timeZone]));
  const rows = input.folders.map((folder): FolderRow => {
    const own = folder.projects.map((name) => digests.get(name)).filter((d): d is ProjectDigest => !!d);
    const local = input.localLeftOff?.(folder) ?? null;
    const engramAt = own.reduce<string | null>((max, d) => (max === null || d.lastAt > max ? d.lastAt : max), null);
    // Last worked counts the local record too.
    const localAt = local && engramTime(local.at);
    const lastAt = localAt !== null && (engramAt === null || localAt > engramAt) ? localAt : engramAt;
    return {
      ...folder,
      lastAt,
      lastDay: lastAt === null ? null : localDay(lastAt, input.timeZone),
      beyondWindow: folder.hasMemory && engramAt === null && input.windowFull,
      leftOff: leftOff(own, input.excerptLines ?? 12, input.foldLines ?? input.excerptLines ?? 12, input.goalLines ?? 2, input.goalChars ?? 400, local),
      day: dayOf(own),
    };
  });
  rows.sort(byRecency);
  return { rows, summary: summarize(rows, digests) };
}

/** Totals over the workspace; a project shared by two folders counts once, for the most recent one. */
function summarize(rows: FolderRow[], digests: Map<string, ProjectDigest>): WorkspaceSummary {
  const owner = new Map<string, FolderRow>();
  for (const row of rows) for (const project of row.projects) if (!owner.has(project) && digests.has(project)) owner.set(project, row);
  const owned = [...owner.keys()].map((project) => digests.get(project) as ProjectDigest);
  const total = dayOf(owned);
  const items = owned.flatMap((d) => d.dayItems);
  return {
    folders: rows.length,
    activeFolders: rows.filter((row) => row.day.memories > 0).length,
    memories: total.memories,
    sessions: total.sessions,
    headlines: headlines(items, SUMMARY_HEADLINES).map((o) => {
      const row = owner.get(o.project) as FolderRow;
      return { ...toHeadline(o), folder: row.name, rel: row.rel };
    }),
  };
}
