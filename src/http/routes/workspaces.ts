import type { RouteModule } from '../context.ts';
import { readJson, sendJson, sendNoContent } from '../respond.ts';

/**
 * Workspaces: GET lists them; POST { root, name? } adds one; PATCH { name?, folders?,
 * expanded?, mission?, projects? } changes one (a blank mission or an empty project set
 * clears it); DELETE forgets one (its folder stays on disk). A workspace carries `mission`
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
      sendNoContent(res);
    },
  },
];
