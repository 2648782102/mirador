import { describeFolders, listFolders } from '../../folders/tree.ts';
import { MemoryIndex } from '../../memory/folder-memory.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/**
 * GET /api/tree?ws=<id>&rel=<folder>: the subfolders of `rel`. At the workspace
 * top (rel empty) it lists the folders the workspace chose, or every first-level
 * folder when it chose none; `all=1` lists every first-level folder regardless.
 * Each folder carries `hasMemory`: whether Engram holds memory for it (null when
 * Engram is unreachable, slow or answers something unexpected), from one cached
 * GET /projects with its own short timeout (long enough for a slow Engram): the tree
 * never waits long on Engram.
 */
const MEMORY_TIMEOUT_MS = 3000;

export const treeRoutes: RouteModule = (ctx) => {
  const memory = new MemoryIndex(() => ctx.engram.projects({ timeoutMs: MEMORY_TIMEOUT_MS }));
  return [
    {
      method: 'GET',
      path: '/api/tree',
      handler: async ({ res, url }) => {
        const { workspace, rel } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
        const chosen = rel === '' && workspace.folders.length > 0 && url.searchParams.get('all') !== '1';
        const nodes = chosen
          ? await describeFolders(workspace.root, workspace.folders, ctx.config.ignore)
          : await listFolders(workspace.root, rel, ctx.config.ignore);
        const hasMemory = await memory.lookup();
        sendJson(res, 200, nodes.map((node) => ({ ...node, hasMemory: hasMemory ? hasMemory(node.path) : null })));
      },
    },
  ];
};
