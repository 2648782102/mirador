// Mirador's proposals from memory: what a folder's agent
// left to do, read from the latest session summary of the folder's Engram project. "Delegar a
// Mirador" and "Antes de dormir" prefill their text with it (public/features/proposals-model.js).
// Each proposal also says how fresh its source is, so
// "Antes de dormir" can warn when work or a note came after that summary.
import { parseEngramTime, type Observation } from './daily-summary.ts';
import type { EngramClient } from './engram.ts';
import { latestNextSteps, latestSummary, touched } from './outside.ts';

/**
 * One folder's proposal: its Engram project (null when it has none of its own), that project's
 * latest Next Steps and their source. Times are ISO instants, null when unknown.
 */
export interface FolderProposal {
  project: string | null;
  nextSteps: string | null;
  /** When the session summary the steps come from was last written. */
  summaryAt: string | null;
  /** When the project's newest memory of any type was last written. */
  latestMemoryAt: string | null;
  /** True when the project has memories written after that summary: work happened after it. */
  newerMemories: boolean;
  /** The newest note or delegation sent to the folder's agent after that summary. */
  lastSentAt: string | null;
}

const NONE = { summaryAt: null, latestMemoryAt: null, newerMemories: false, lastSentAt: null };

const iso = (engramTime: string) => parseEngramTime(engramTime).toISOString();

/**
 * How fresh a proposal from `observations` is: the latest summary's time, the newest memory's,
 * whether some memory came after that summary, and the newest of `sent` (ISO times of notes and
 * delegations sent to the folder's agent) that came after it. Without a summary nothing is newer.
 */
export function proposalSource(observations: Observation[], sent: string[] = []): Omit<FolderProposal, 'project' | 'nextSteps'> {
  const summary = latestSummary(observations);
  const newest = observations.reduce<string | null>((best, o) => (best === null || touched(o) > best ? touched(o) : best), null);
  const summaryAt = summary ? iso(touched(summary)) : null;
  const after = summaryAt === null ? null : Date.parse(summaryAt);
  const lastSent = after === null ? null : sent.filter((time) => Date.parse(time) > after).reduce<string | null>((best, time) => (best === null || Date.parse(time) > Date.parse(best) ? time : best), null);
  return {
    summaryAt,
    latestMemoryAt: newest === null ? null : iso(newest),
    newerMemories: summary !== null && observations.some((o) => touched(o) > touched(summary)),
    lastSentAt: lastSent === null ? null : new Date(lastSent).toISOString(),
  };
}

/**
 * The proposal for the resolved folder `cwd`. Its project is the one Engram itself resolves
 * (as GET /api/summary does); a container folder Engram reports without a project proposes
 * nothing, rather than mixing the plans of the projects below it. `sent`: the ISO times of the
 * notes and delegations already sent to this folder's agent.
 */
export async function folderProposal(engram: Pick<EngramClient, 'projectFor' | 'observations'>, cwd: string, sent: string[] = []): Promise<FolderProposal> {
  const found = await engram.projectFor(cwd);
  if (!found) return { project: null, nextSteps: null, ...NONE };
  const observations = await engram.observations(found.project);
  return { project: found.project, nextSteps: latestNextSteps(observations), ...proposalSource(observations, sent) };
}
