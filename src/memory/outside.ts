// "Traer a Mirador": where a project seen only through
// its Engram memories would open in Mirador. Pure: the route checks the answer with
// WorkspaceStore.resolve (root and symlink guard) before offering it.
import { clip, leftOffFrom } from './overview.ts';
import type { Observation } from './daily-summary.ts';

/** A workspace folder to open, or why there is none. */
export type AdoptPlace = { ws: string; rel: string } | { reason: 'no_directory' | 'outside_workspaces' };

/** Most characters of Next Steps handed to the client: room is left for its lead line within the 2000 of an instruction. */
export const ADOPT_STEPS_MAX = 1900;
const ADOPT_STEPS_LINES = 200;

const trimSlash = (path: string) => path.replace(/\/+$/, '') || '/';
const CONTROL = /\p{Cc}/u;

/** An absolute path without `.`/`..` segments or control characters, without its trailing slash; null otherwise. */
function plainPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || CONTROL.test(value)) return null;
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return trimSlash(value);
}

/**
 * The workspace folder for a project's Engram `directories`: the first directory inside a
 * workspace wins and, when nested roots both contain it, the deepest root. `no_directory` when
 * Engram knows none, `outside_workspaces` when none lies inside a workspace.
 */
export function adoptPlace(directories: string[] | null, workspaces: Array<{ id: string; root: string }>): AdoptPlace {
  const dirs = Array.isArray(directories) ? directories : [];
  if (!dirs.length) return { reason: 'no_directory' };
  const roots = workspaces
    .map((w) => ({ id: w.id, root: plainPath(w.root) }))
    .filter((w): w is { id: string; root: string } => w.root !== null)
    .sort((a, b) => b.root.length - a.root.length);
  for (const raw of dirs) {
    const dir = plainPath(raw);
    if (dir === null) continue;
    const owner = roots.find((w) => dir === w.root || dir.startsWith(w.root === '/' ? '/' : `${w.root}/`));
    if (owner) return { ws: owner.id, rel: dir === owner.root ? '' : dir.slice(owner.root === '/' ? 1 : owner.root.length + 1) };
  }
  return { reason: 'outside_workspaces' };
}

/** When an observation was last written: its update, else its creation. Engram times sort as text ("YYYY-MM-DD HH:MM:SS[.fraction]"). */
export const touched = (o: Observation) => (o.updated_at && o.updated_at > o.created_at ? o.updated_at : o.created_at);

/** The latest session summary among `observations`, or null. */
export function latestSummary(observations: Observation[]): Observation | null {
  return observations
    .filter((o) => o.type === 'session_summary')
    .reduce<Observation | null>((best, o) => (!best || touched(o) > touched(best) ? o : best), null);
}

/** The Next Steps of the latest session summary among `observations`, clipped to ADOPT_STEPS_MAX; null when there are none. */
export function latestNextSteps(observations: Observation[]): string | null {
  const latest = latestSummary(observations);
  if (!latest) return null;
  // clip() may add "\n…" past its limit.
  return clip(leftOffFrom(latest.content).nextSteps, ADOPT_STEPS_LINES, ADOPT_STEPS_MAX - 2);
}
