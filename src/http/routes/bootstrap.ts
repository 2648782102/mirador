// What public/app.js reads before anything draws, in one
// request instead of one per endpoint. Each part is answered by its own registered route handler;
// nothing here re-implements them, and those endpoints stay for every other caller.
import type { Route } from '../router.ts';
import { sendJson } from '../respond.ts';

/** The start-up state's parts and the GET routes that answer them. */
export const BOOTSTRAP_PARTS = { config: '/api/config', workspaces: '/api/workspaces' } as const;

/**
 * GET /api/bootstrap → `{ config, workspaces }`, each exactly the 200 body of its own route.
 * `read` runs a registered GET route in-process (src/server.ts routeJson) and gives null unless it
 * answered 200. It sits behind the server's session check like every /api/ route.
 */
export function bootstrapRoute(read: (path: string) => Promise<unknown>): Route {
  return {
    method: 'GET',
    path: '/api/bootstrap',
    handler: async ({ res }) => {
      const entries = Object.entries(BOOTSTRAP_PARTS);
      const values = await Promise.all(entries.map(([, path]) => read(path)));
      const missing = entries.filter((_, i) => values[i] === null).map(([, path]) => path);
      if (missing.length) throw new Error(`GET /api/bootstrap: ${missing.join(', ')} did not answer 200`);
      sendJson(res, 200, Object.fromEntries(entries.map(([key], i) => [key, values[i]])));
    },
  };
}
