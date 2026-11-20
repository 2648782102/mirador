// Pure data shaping for the tracking charts (public/charts.js draws them): agent
// states as one stacked bar, memories per Engram project as sorted bars, and
// memories per local hour. No DOM and no core.js: the browser and the tests import it.

/** Agent states in the order the stacked bar and its legend show them. */
export const AGENT_STATES = ['working', 'waiting', 'finished', 'exited'];

/** How many projects get their own bar; the rest share one "others" bar. */
export const TOP_PROJECTS = 8;

/**
 * Whole percentages of `counts` that always add up to 100 (largest remainder;
 * ties go to the earlier entry). All zeros when the counts add up to 0.
 */
export function percentages(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return counts.map(() => 0);
  const exact = counts.map((n) => (n * 100) / total);
  const result = exact.map(Math.floor);
  let left = 100 - result.reduce((sum, n) => sum + n, 0);
  const order = exact.map((value, index) => ({ index, rest: value - result[index] })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    result[index] += 1;
    left -= 1;
  }
  return result;
}

/**
 * Agent states of the tracking summary as slices of one stacked bar:
 * { total, slices: [{ state, count, share, offset, percent }] }, `share` and
 * `offset` as fractions of the total (0 when there are no agents).
 */
export function agentStateShares(summary) {
  const counts = AGENT_STATES.map((state) => summary?.[state] ?? 0);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const percent = percentages(counts);
  let before = 0;
  const slices = AGENT_STATES.map((state, index) => {
    const count = counts[index];
    const slice = { state, count, share: total ? count / total : 0, offset: total ? before / total : 0, percent: percent[index] };
    before += count;
    return slice;
  });
  return { total, slices };
}

/**
 * Projects of GET /api/activity as horizontal bars, most memories first (ties by
 * name): the top `limit` get a bar each and the rest fold into `others`
 * ({ count, projects, share }), or null when nothing is left over. `share` is the
 * length relative to the longest bar.
 */
export function projectBars(activity, limit = TOP_PROJECTS) {
  const active = activity.filter((project) => project.count > 0).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
  const total = active.reduce((sum, project) => sum + project.count, 0);
  const top = active.slice(0, limit);
  const rest = active.slice(limit);
  const restCount = rest.reduce((sum, project) => sum + project.count, 0);
  const max = Math.max(0, ...top.map((project) => project.count), restCount);
  const share = (count) => (max ? count / max : 0);
  return {
    bars: top.map((project) => ({ project: project.project, count: project.count, share: share(project.count) })),
    others: rest.length ? { count: restCount, projects: rest.length, share: share(restCount) } : null,
    total,
    max,
  };
}

/** Engram stores UTC times as "YYYY-MM-DD HH:MM:SS[.fraction]" without a zone. */
function engramDate(value) {
  const [day, time = '00:00:00'] = String(value).trim().split(/[ T]/);
  return new Date(`${day}T${time.split('.')[0]}Z`);
}

/**
 * Memories per local hour (0-23) of `date` (YYYY-MM-DD) in `timeZone`, from Engram
 * UTC times. Times on another local day or unreadable are left out.
 */
export function hourBuckets(times, timeZone, date) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const buckets = Array(24).fill(0);
  for (const value of times) {
    const at = engramDate(value);
    if (Number.isNaN(at.getTime())) continue;
    const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` !== date) continue;
    buckets[Number(parts.hour)] += 1;
  }
  return buckets;
}

/**
 * The 24 hourly counts of GET /api/activity (`hours`) as columns: { total, max,
 * peaks, columns: [{ hour, count, share }] }, `share` relative to the busiest hour
 * and `peaks` every hour with that count. Anything but a whole count of 0 or more
 * reads as 0; a missing or short answer is padded with zeros.
 */
export function hourColumns(hours) {
  const counts = Array.from({ length: 24 }, (_, hour) => {
    const value = Array.isArray(hours) ? hours[hour] : 0;
    return Number.isInteger(value) && value > 0 ? value : 0;
  });
  const total = counts.reduce((sum, n) => sum + n, 0);
  const max = Math.max(...counts);
  return {
    total,
    max,
    peaks: max ? counts.flatMap((count, hour) => (count === max ? [hour] : [])) : [],
    columns: counts.map((count, hour) => ({ hour, count, share: max ? count / max : 0 })),
  };
}
