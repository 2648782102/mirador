/** Shapes returned by the Engram HTTP API (only the fields Mirador reads). */
export interface Observation {
  id: number;
  type: string;
  title: string;
  content: string;
  project: string;
  created_at: string;
  updated_at?: string;
  topic_key?: string;
}

export interface Session {
  id: string;
  project: string;
  started_at: string;
  ended_at?: string;
  observation_count: number;
}

export interface SummaryItem {
  id: number;
  title: string;
  content: string;
  at: string;
  /** True when the observation was created on an earlier day and revised on this one. */
  updated: boolean;
}

export interface SummaryGroup {
  type: string;
  label: string;
  items: SummaryItem[];
}

export interface DailySummary {
  project: string;
  date: string;
  sessionCount: number;
  sessionSummaries: number;
  latestSummary: SummaryItem | null;
  groups: SummaryGroup[];
  total: number;
}

export interface ProjectActivity {
  project: string;
  count: number;
  lastAt: string;
  titles: string[];
}

const SESSION_SUMMARY = 'session_summary';

const TYPE_ORDER: Array<[string, string]> = [
  ['decision', 'Decisions'],
  ['architecture', 'Architecture'],
  ['bugfix', 'Bug fixes'],
  ['discovery', 'Discoveries'],
  ['pattern', 'Patterns'],
  ['config', 'Configuration'],
  ['preference', 'Preferences'],
  ['learning', 'Learnings'],
  ['manual', 'Notes'],
];

/** Engram stores UTC timestamps as "YYYY-MM-DD HH:MM:SS[.fraction]" without a zone. */
export function parseEngramTime(value: string): Date {
  const [date, time = '00:00:00'] = value.trim().split(/[ T]/);
  const [clock, fraction = ''] = time.split('.');
  return new Date(`${date}T${clock}.${fraction.padEnd(3, '0').slice(0, 3)}Z`);
}

// Building an Intl.DateTimeFormat costs far more than formatting with one: keep one per time zone.
const dayFormats = new Map<string, Intl.DateTimeFormat>();

export function localDay(value: string, timeZone: string): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    // en-CA formats dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(timeZone, format);
  }
  return format.format(parseEngramTime(value));
}

const hourFormats = new Map<string, Intl.DateTimeFormat>();

/** The local hour (0-23) of an Engram time in `timeZone`. */
export function localHour(value: string, timeZone: string): number {
  let format = hourFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    hourFormats.set(timeZone, format);
  }
  return Number(format.format(parseEngramTime(value)));
}

/**
 * Remembers `compute(window, key)` per Engram window (the array allObservations shares
 * while its cache lasts) and key, so repeated polls inside one window cost no recomputation
 * and the next window is computed afresh. Each window keeps at most `maxKeys` results, and
 * a window's results go with it (WeakMap). Results are shared: callers must not mutate them.
 */
export function memoByWindow<T>(compute: (window: Observation[], key: string) => T, maxKeys = 16): (window: Observation[], key: string) => T {
  const results = new WeakMap<Observation[], Map<string, T>>();
  return (window, key) => {
    let byKey = results.get(window);
    if (!byKey) {
      byKey = new Map();
      results.set(window, byKey);
    }
    if (byKey.has(key)) return byKey.get(key) as T;
    const value = compute(window, key);
    if (byKey.size >= maxKeys) byKey.delete(byKey.keys().next().value as string);
    byKey.set(key, value);
    return value;
  };
}

/**
 * Engram returns only the newest `limit` entries, with no date filter. A full
 * window whose oldest entry is on `date` or later may be missing entries of
 * that day; a shorter window holds everything Engram has.
 */
export function windowMayMissDay(times: string[], limit: number, date: string, timeZone: string): boolean {
  if (times.length === 0 || times.length < limit) return false;
  const oldest = times.reduce((min, t) => (parseEngramTime(t) < parseEngramTime(min) ? t : min));
  return localDay(oldest, timeZone) >= date;
}

function lastTouched(o: Observation): string {
  return o.updated_at && o.updated_at > o.created_at ? o.updated_at : o.created_at;
}

function touchedOn(o: Observation, date: string, timeZone: string): boolean {
  return localDay(o.created_at, timeZone) === date || localDay(lastTouched(o), timeZone) === date;
}

function newestFirst(a: Observation, b: Observation): number {
  return lastTouched(b).localeCompare(lastTouched(a));
}

function toItem(o: Observation, date: string, timeZone: string): SummaryItem {
  return {
    id: o.id,
    title: o.title,
    content: o.content,
    at: lastTouched(o),
    updated: localDay(o.created_at, timeZone) !== date,
  };
}

export function buildDailySummary(input: {
  project: string;
  date: string;
  timeZone: string;
  observations: Observation[];
  sessions: Session[];
}): DailySummary {
  const { project, date, timeZone } = input;
  const ofDay = input.observations.filter((o) => touchedOn(o, date, timeZone)).sort(newestFirst);
  const summaries = ofDay.filter((o) => o.type === SESSION_SUMMARY);
  const rest = ofDay.filter((o) => o.type !== SESSION_SUMMARY);

  const known = new Map(TYPE_ORDER);
  const types = [...TYPE_ORDER.map(([t]) => t), ...new Set(rest.map((o) => o.type).filter((t) => !known.has(t)))];
  const groups = types
    .map((type) => ({
      type,
      label: known.get(type) ?? type,
      items: rest.filter((o) => o.type === type).map((o) => toItem(o, date, timeZone)),
    }))
    .filter((g) => g.items.length > 0);

  return {
    project,
    date,
    sessionCount: input.sessions.filter((s) => localDay(s.started_at, timeZone) === date).length,
    sessionSummaries: summaries.length,
    latestSummary: summaries[0] ? toItem(summaries[0], date, timeZone) : null,
    groups,
    total: ofDay.length,
  };
}

/**
 * Projects whose Engram directory bindings sit at `folder` or below it. Used for
 * container folders (e.g. ~/Dev/web) that Engram itself reports as ambiguous.
 */
export function projectsUnder(folder: string, projects: Array<{ name: string; directories: string[] | null }>): string[] {
  const base = folder.replace(/\/+$/, '');
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => (Array.isArray(p?.directories) ? p.directories : []).some((dir) => dir === base || dir.startsWith(base + '/')))
    .map((p) => p.name);
}

export function buildActivityOverview(input: {
  date: string;
  timeZone: string;
  observations: Observation[];
  projects?: string[];
}): ProjectActivity[] {
  const byProject = new Map<string, Observation[]>();
  for (const o of input.observations) {
    if (input.projects && !input.projects.includes(o.project)) continue;
    if (!touchedOn(o, input.date, input.timeZone)) continue;
    const list = byProject.get(o.project);
    if (list) list.push(o);
    else byProject.set(o.project, [o]);
  }
  return [...byProject.entries()]
    .map(([project, list]) => {
      const sorted = [...list].sort(newestFirst);
      return { project, count: sorted.length, lastAt: lastTouched(sorted[0]), titles: sorted.map((o) => o.title) };
    })
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

/**
 * Memories per local hour (0-23) of `date` in `timeZone`: the same memories
 * buildActivityOverview counts, each once, at its last change on that day (its
 * creation when it was revised on a later day), so the hours add up to the
 * overview's counts.
 */
export function activityHours(input: { date: string; timeZone: string; observations: Observation[]; projects?: string[] }): number[] {
  const { date, timeZone } = input;
  const hours: number[] = Array(24).fill(0);
  for (const o of input.observations) {
    if (input.projects && !input.projects.includes(o.project)) continue;
    if (!touchedOn(o, date, timeZone)) continue;
    const last = lastTouched(o);
    hours[localHour(localDay(last, timeZone) === date ? last : o.created_at, timeZone)] += 1;
  }
  return hours;
}
