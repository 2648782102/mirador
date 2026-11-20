import { activityHours, buildActivityOverview, buildDailySummary, memoByWindow, projectsUnder, windowMayMissDay, type ProjectActivity } from '../../memory/daily-summary.ts';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RECENT_LIMIT } from '../../memory/engram.ts';
import { adoptPlace, latestNextSteps } from '../../memory/outside.ts';
import { ImproveError, createImprover, improveContext, parseImproveBody, type Improver } from '../../memory/improve-proposal.ts';
import { folderProposal } from '../../memory/proposals.ts';
import { NightLog, nightLogDir } from '../../night/log.ts';
import { NoteStore } from '../../night/notes.ts';
import { resourceProfiles } from '../../profiles.ts';
import { InvalidFolderError } from '../../folders/tree.ts';
import { InvalidWorkspaceError, MAX_PROJECTS, UnknownWorkspaceError } from '../../workspaces/store.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson } from '../respond.ts';

const MAX_PROJECT_NAME = 200;
const CONTROL = /\p{Cc}/u;

/** The one `project` query parameter: 1-200 printable characters. */
function projectParam(url: URL): string {
  const values = url.searchParams.getAll('project');
  const name = values.length === 1 ? values[0] : '';
  if (!name || name.length > MAX_PROJECT_NAME || CONTROL.test(name)) {
    throw new HttpError(400, `project must be given once, 1-${MAX_PROJECT_NAME} printable characters`, 'adopt_invalid');
  }
  return name;
}

const MAX_REL = 1024;
/** How far back GET /api/proposals looks for notes and delegations sent (delivered notes are kept as long). */
const SENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * When something was already sent to the agents of
 * each folder, read-only from the night shift's files: the night log's notes and delegations that
 * reached an agent (`sent: 'message'`, they carry the folder) and the notes waiting in the notes
 * store for a terminal still open (its folder comes from the terminal). Mirador's own notes (the
 * idle-sleep save note, `note.from: 'mirador'`) are not something the user sent. Keyed by workspace and folder.
 */
async function sentTimes(terminals: { get(id: string): { workspaceId: string; rel: string } | undefined }): Promise<Map<string, string[]>> {
  const times = new Map<string, string[]>();
  const add = (workspaceId: string | null, rel: string | null, time: string) => {
    if (workspaceId === null || rel === null) return;
    const key = JSON.stringify([workspaceId, rel]);
    times.set(key, [...(times.get(key) ?? []), time]);
  };
  const dir = nightLogDir();
  const [records, notes] = await Promise.all([
    new NightLog(dir).recent({ since: Date.now() - SENT_WINDOW_MS, limit: 1000 }).catch(() => []),
    // A store of its own, read once: the night routes' store keeps its list in memory.
    new NoteStore(dir).pending().catch(() => []),
  ]);
  for (const record of records) {
    if ((record.kind === 'note' || record.kind === 'delegate') && record.sent === 'message' && record.note?.from !== 'mirador') add(record.workspaceId, record.rel, record.time);
  }
  for (const note of notes) {
    const info = note.terminalId ? terminals.get(note.terminalId) : undefined;
    if (info && info.workspaceId === note.workspaceId) add(info.workspaceId, info.rel, note.createdAt);
  }
  return times;
}

/** The `ws` parameter once and 1-MAX_PROJECTS `rel` parameters of at most MAX_REL characters, as received. */
function proposalParams(url: URL): { ws: string; rels: string[] } {
  const ws = url.searchParams.getAll('ws');
  const rels = url.searchParams.getAll('rel');
  if (ws.length !== 1 || !ws[0] || !rels.length || rels.length > MAX_PROJECTS || rels.some((rel) => rel.length > MAX_REL)) {
    throw new HttpError(400, `proposals take ws once and 1-${MAX_PROJECTS} rel values of at most ${MAX_REL} characters`, 'proposals_invalid');
  }
  return { ws: ws[0], rels };
}

/**
 * Every answer carries `truncated`: true when Engram's window of the newest
 * RECENT_LIMIT entries may not reach back to the whole day.
 */
export const summaryRoutes: RouteModule = (ctx) => {
  const mayMissDay = (times: string[], date: string) => windowMayMissDay(times, RECENT_LIMIT, date, ctx.config.timeZone);
  // The tracking view polls /api/activity; within one Engram window each day is computed once.
  const activityOf = memoByWindow((observations, key): { projects: ProjectActivity[]; hours: number[]; truncated: boolean } => {
    const [date, timeZone] = JSON.parse(key) as [string, string];
    return {
      projects: buildActivityOverview({ date, timeZone, observations }),
      // `hours`: memories per local hour of the day (24 counts), for the tracking chart.
      hours: activityHours({ date, timeZone, observations }),
      truncated: windowMayMissDay(observations.map((o) => o.created_at), RECENT_LIMIT, date, timeZone),
    };
  });
  // "Mejorar con IA": the night decider's model, read per call from the resource profile, where
  // config `nightModel` still wins. Built on the first click, so building these routes stays as before.
  let improver: Improver | null = null;
  const improverOf = (): Improver => {
    if (!improver) {
      const created = createImprover({ model: () => resourceProfiles(ctx.terminals)?.values().nightModel ?? ctx.config.nightModel, ownerName: () => ctx.config.ownerName });
      ctx.onShutdown(() => created.close());
      improver = created;
    }
    return improver;
  };
  return [
    {
      method: 'GET',
      path: '/api/summary',
      handler: async ({ res, url }) => {
        const { timeZone } = ctx.config;
        const date = ctx.parseDate(url.searchParams.get('date'));
        const { path: cwd } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
        const project = await ctx.engram.projectFor(cwd);
        if (!project) {
          // A container folder (several repos inside): summarize the projects bound below it.
          const projects = projectsUnder(cwd, await ctx.engram.projects());
          const observations = projects.length ? await ctx.engram.allObservations() : [];
          const overview = projects.length ? buildActivityOverview({ date, timeZone, observations, projects }) : [];
          const truncated = mayMissDay(observations.map((o) => o.created_at), date);
          return sendJson(res, 200, { cwd, project: null, summary: null, group: { projects, overview }, truncated });
        }
        const [observations, sessions] = await Promise.all([ctx.engram.observations(project.project), ctx.engram.sessions(project.project)]);
        const summary = buildDailySummary({ project: project.project, date, timeZone, observations, sessions });
        const truncated = mayMissDay(observations.map((o) => o.created_at), date) || mayMissDay(sessions.map((s) => s.started_at), date);
        sendJson(res, 200, { cwd, project, summary, truncated });
      },
    },
    {
      method: 'GET',
      path: '/api/activity',
      handler: async ({ res, url }) => {
        const date = ctx.parseDate(url.searchParams.get('date'));
        const { timeZone } = ctx.config;
        const observations = await ctx.engram.allObservations();
        const { projects, hours, truncated } = activityOf(observations, JSON.stringify([date, timeZone]));
        sendJson(res, 200, { date, projects, hours, truncated });
      },
    },
    {
      // "Traer a Mirador": the workspace folder an outside
      // project would open in, and the Next Steps of its latest session summary; or only why it
      // cannot be adopted. The folder passed WorkspaceStore.resolve; the launch is POST /api/terminals/batch.
      method: 'GET',
      path: '/api/activity/adopt',
      handler: async ({ res, url }) => {
        const project = projectParam(url);
        const listing = await ctx.engram.projects();
        // Engram reports real paths: compare them with each root as the store resolves it.
        const workspaces = await Promise.all(ctx.workspaces.list().map(async (w) => ({ id: w.id, root: await realpath(w.root).catch(() => w.root) })));
        const place = adoptPlace(listing.find((p) => p.name === project)?.directories ?? null, workspaces);
        if ('reason' in place) return sendJson(res, 200, { project, reason: place.reason });
        let folder;
        try {
          folder = await ctx.resolveFolder(place.ws, place.rel);
        } catch (error) {
          // A folder gone (or its whole workspace root) answers folder_missing; a symlink out of
          // the root or a workspace removed meanwhile, outside_workspaces.
          const rootGone = error instanceof InvalidWorkspaceError && error.code === 'workspace_root_missing';
          if (!(error instanceof InvalidFolderError || error instanceof UnknownWorkspaceError || rootGone)) throw error;
          const root = workspaces.find((w) => w.id === place.ws)?.root;
          const gone = rootGone || (root !== undefined && (await lstat(join(root, place.rel)).then(() => false, () => true)));
          return sendJson(res, 200, { project, reason: gone ? 'folder_missing' : 'outside_workspaces' });
        }
        const nextSteps = latestNextSteps(await ctx.engram.observations(project));
        sendJson(res, 200, { project, ws: folder.workspace.id, rel: folder.rel, workspace: folder.workspace.name, nextSteps });
      },
    },
    {
      // Mirador's proposals from memory: the latest Next
      // Steps of each folder's Engram project, for "Delegar a Mirador" and "Antes de dormir" to
      // prefill, with how fresh they are (summaryAt, latestMemoryAt, newerMemories, lastSentAt).
      // Every folder passes WorkspaceStore.resolve
      // before Engram is asked about any.
      method: 'GET',
      path: '/api/proposals',
      handler: async ({ res, url }) => {
        const { ws, rels } = proposalParams(url);
        const folders = [];
        for (const rel of rels) folders.push(await ctx.resolveFolder(ws, rel));
        const sent = await sentTimes(ctx.terminals);
        const proposals = [];
        // One folder at a time: Engram is local, and a dialog asks for a few folders at most.
        for (const [i, folder] of folders.entries()) {
          proposals.push({ rel: rels[i], ...(await folderProposal(ctx.engram, folder.path, sent.get(JSON.stringify([folder.workspace.id, folder.rel])))) });
        }
        sendJson(res, 200, { ws, proposals });
      },
    },
    {
      // "Mejorar con IA": Claude's version of one proposal, from
      // the folder's memory, the workspace mission and the project's skills. One pi run per call,
      // only on the user's click; the browser decides whether it replaces the draft. The folder
      // passes WorkspaceStore.resolve before Engram, the skills or pi are touched.
      method: 'POST',
      path: '/api/proposals/improve',
      handler: async ({ req, res }) => {
        try {
          const { ws, rel, draft } = parseImproveBody(await readJson(req));
          const folder = await ctx.resolveFolder(ws, rel);
          const context = await improveContext(ctx.engram, folder, process.env.HOME || homedir());
          sendJson(res, 200, { text: await improverOf().improve(context, draft) });
        } catch (error) {
          if (error instanceof ImproveError) throw new HttpError(error.status, error.message, error.code);
          throw error;
        }
      },
    },
  ];
};
