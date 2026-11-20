import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeFolders, listFolders } from '../../folders/tree.ts';
import { projectsUnder, windowMayMissDay, type Observation } from '../../memory/daily-summary.ts';
import { RECENT_LIMIT } from '../../memory/engram.ts';
import { memoryLookup } from '../../memory/folder-memory.ts';
import { buildMemoryHealth, resolveFolders, type HealthFolder, type LookupCache } from '../../memory/memory-health.ts';
import { buildWorkspaceOverview, folderProjects, type OverviewFolder } from '../../memory/overview.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/** How much of a session summary each row of the workspace overview keeps: rows stay compact. */
const ROW_EXCERPT_LINES = 4;
const ROW_GOAL_CHARS = 160;

/** Memory health: at most this many folders resolved through Engram per request, a few at a time, cached. */
const HEALTH_LOOKUPS = 60;
const HEALTH_LOOKUP_CONCURRENCY = 4;
const HEALTH_LOOKUP_TTL_MS = 10 * 60_000;

async function isRepo(path: string): Promise<boolean> {
  return stat(join(path, '.git')).then(() => true, () => false);
}

/**
 * GET /api/overview?ws=<id>&date=: the workspace summary for that day and one row
 * per folder (the chosen folders, or every first-level folder when none were chosen,
 * as the sidebar shows them) saying when it was last worked on and where it left off.
 * Two Engram reads per request (GET /projects and one all-projects window), never one
 * per folder. The root gets a row too when Engram holds memory saved in it.
 *
 * GET /api/overview/folder?ws=&rel=&date=: the same row for one folder, resolved to its
 * Engram project the way /api/summary does, for the block above the daily summary.
 *
 * Both answer `truncated` like /api/summary: Engram's window of the newest
 * RECENT_LIMIT entries may not reach back to the whole day.
 *
 * GET /api/memory/health: the read-only memory health report (src/memory/memory-health.ts)
 * over the same shared window, GET /projects, and every workspace's root and overview
 * folders resolved through Engram (at most HEALTH_LOOKUPS, cached for HEALTH_LOOKUP_TTL_MS).
 * Titles and fallback titles only; totals.foldersNotResolved counts folders past the bound.
 */
export const overviewRoutes: RouteModule = (ctx) => {
  const mayMissDay = (observations: Observation[], date: string) =>
    windowMayMissDay(observations.map((o) => o.created_at), RECENT_LIMIT, date, ctx.config.timeZone);
  const lookupCache: LookupCache = new Map();

  /** Each workspace's root and the folders its overview shows; an unreadable workspace is skipped. */
  async function workspaceFolders(): Promise<HealthFolder[]> {
    const folders: HealthFolder[] = [];
    for (const workspace of ctx.workspaces.list()) {
      try {
        const root = await realpath(workspace.root);
        const nodes = workspace.folders.length
          ? await describeFolders(root, workspace.folders, ctx.config.ignore)
          : await listFolders(root, '', ctx.config.ignore);
        folders.push({ path: root, root: true }, ...nodes.map((node) => ({ path: node.path, root: false })));
      } catch {
        continue;
      }
    }
    return folders;
  }

  return [
    {
      method: 'GET',
      path: '/api/overview',
      handler: async ({ res, url }) => {
        const { timeZone, ignore } = ctx.config;
        const date = ctx.parseDate(url.searchParams.get('date'));
        const { workspace, path: rootPath } = await ctx.resolveFolder(url.searchParams.get('ws'), '');
        const nodes = workspace.folders.length
          ? await describeFolders(workspace.root, workspace.folders, ignore)
          : await listFolders(workspace.root, '', ignore);
        const [listing, observations] = await Promise.all([ctx.engram.projects(), ctx.engram.allObservations()]);
        const projects = folderProjects(listing);
        const hasMemory = memoryLookup(listing);
        const folders: OverviewFolder[] = nodes.map((node) => ({
          name: node.name,
          rel: node.rel,
          path: node.path,
          isRepo: node.isRepo,
          projects: projects.under(node.path),
          hasMemory: hasMemory(node.path),
        }));
        const own = projects.at(rootPath);
        if (own.length) folders.push({ name: workspace.name, rel: '', path: rootPath, isRepo: await isRepo(rootPath), projects: own, hasMemory: true });
        const { rows, summary } = buildWorkspaceOverview({
          date,
          timeZone,
          folders,
          observations,
          windowFull: observations.length >= RECENT_LIMIT,
          excerptLines: ROW_EXCERPT_LINES,
          goalChars: ROW_GOAL_CHARS,
        });
        sendJson(res, 200, { workspace: { id: workspace.id, name: workspace.name }, date, truncated: mayMissDay(observations, date), summary, rows });
      },
    },
    {
      method: 'GET',
      path: '/api/overview/folder',
      handler: async ({ res, url }) => {
        const date = ctx.parseDate(url.searchParams.get('date'));
        const { workspace, path, rel } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
        const project = await ctx.engram.projectFor(path);
        let projects: string[];
        // The Engram read as received: whether it is full (and may cut the day off) depends on all of it.
        let window: Observation[];
        if (project) {
          projects = [project.project];
          window = await ctx.engram.observations(project.project);
        } else {
          // A container folder (several repos inside): the projects bound below it, as /api/summary does.
          projects = projectsUnder(path, await ctx.engram.projects());
          window = projects.length ? await ctx.engram.allObservations() : [];
        }
        const observations = project ? window : window.filter((o) => projects.includes(o.project));
        const windowFull = window.length >= RECENT_LIMIT;
        const folder: OverviewFolder = {
          name: rel ? rel.split('/').pop() ?? rel : workspace.name,
          rel,
          path,
          isRepo: await isRepo(path),
          projects,
          hasMemory: observations.length > 0 || (windowFull && projects.length > 0),
        };
        // "Dónde quedó" pages its goal and folds, so they come whole: no "…" at the end of the last page.
        const { rows } = buildWorkspaceOverview({ date, timeZone: ctx.config.timeZone, folders: [folder], observations, windowFull, foldLines: Infinity, goalLines: Infinity, goalChars: Infinity });
        sendJson(res, 200, { cwd: path, projects, truncated: mayMissDay(window, date), row: rows[0] });
      },
    },
    {
      method: 'GET',
      path: '/api/memory/health',
      handler: async ({ res }) => {
        const folders = await workspaceFolders();
        const [listing, observations] = await Promise.all([ctx.engram.projects(), ctx.engram.allObservations()]);
        // Roots first: they are the fewest and the likeliest to be mis-assigned.
        const paths = [...folders.filter((f) => f.root), ...folders.filter((f) => !f.root)].map((f) => f.path);
        const { resolved, skipped } = await resolveFolders(paths, async (path) => (await ctx.engram.projectFor(path))?.project ?? null, {
          max: HEALTH_LOOKUPS,
          concurrency: HEALTH_LOOKUP_CONCURRENCY,
          cache: lookupCache,
          ttlMs: HEALTH_LOOKUP_TTL_MS,
        });
        const health = buildMemoryHealth({ observations, listing, folders, resolved, home: homedir(), windowFull: observations.length >= RECENT_LIMIT });
        sendJson(res, 200, { ...health, totals: { ...health.totals, foldersNotResolved: skipped } });
      },
    },
  ];
};
