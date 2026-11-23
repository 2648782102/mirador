// "Sign out the other windows" (docs/security.md, a lost phone): the one session action a window
// takes after it signed in. Redeeming a launch link (POST /api/session) stays in src/server.ts,
// before the session check.
import type { Route } from '../router.ts';
import { sendJson } from '../respond.ts';
import { bearerToken, type Sessions } from '../security.ts';

/**
 * DELETE /api/session/others → `{ cleared }`, how many sessions it forgot: every one but the
 * caller's. It sits behind the server's Host, Origin and session checks like every /api/ route, so
 * the caller's token is known. `closed` gets the forgotten tokens, whose terminal sockets and inbox
 * streams the server then ends (SessionClosers).
 */
export function signOutOthersRoute(sessions: Sessions, closed: (tokens: string[]) => void): Route {
  return {
    method: 'DELETE',
    path: '/api/session/others',
    handler: ({ req, res }) => {
      const cleared = sessions.signOutOthers(bearerToken(req.headers.authorization));
      closed(cleared);
      sendJson(res, 200, { cleared: cleared.length });
    },
  };
}
