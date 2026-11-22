import { stateDir } from '../../config.ts';
import { deleteLeftOffWorkspace, leftOffDir } from '../../memory/left-off.ts';
import type { RouteModule } from '../context.ts';
import { readJson, sendJson, sendNoContent } from '../respond.ts';

/**
 * Workspaces: GET lists them; POST { root, name? } adds one; PATCH { name?, folders?,
 * expanded?, mission?, projects? } changes one (a blank mission or an empty project set
 * clears it); DELETE forgets one (its folder stays on disk; Mirador's own "where it left off" records
 * of it go, src/memory/left-off.ts). A workspace carries `mission`
 * and `projects` only when it has them.
 */
export const workspaceRoutes: RouteModule = (ctx) => [
  {
    method: 'GET',
    path: '/api/workspaces',
    handler: ({ res }) => sendJson(res, 200, ctx.workspaces.list()),
  },
  {
    method: 'POST',
    path: '/api/workspaces',
    handler: async ({ req, res }) => sendJson(res, 201, await ctx.workspaces.add(await readJson(req))),
  },
  {
    method: 'PATCH',
    path: '/api/workspaces/:id',
    handler: async ({ req, res, params }) => sendJson(res, 200, await ctx.workspaces.update(params.id, await readJson(req))),
  },
  {
    method: 'DELETE',
    path: '/api/workspaces/:id',
    handler: async ({ res, params }) => {
      await ctx.workspaces.remove(params.id);
      await deleteLeftOffWorkspace(leftOffDir(stateDir()), params.id).catch((error) =>
        console.error(`mirador: the workspace's left-off records could not be removed: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}`),
      );
      sendNoContent(res);
    },
  },
];
