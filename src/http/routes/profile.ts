import { CallBudget, CallTelemetry, callAccounting } from '../../night/budget.ts';
import { PROFILE_NAMES, ProfileError, ResourceProfiles, isProfileName, resourceProfiles } from '../../profiles.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson } from '../respond.ts';

/**
 * Resource profiles, call budget and telemetry.
 *
 * GET /api/profile                → { profile, values, overridden, profiles, budget }
 *                                   values: the effective knobs; overridden: the config keys that won;
 *                                   profiles: every profile's values; budget: { night, improveToday } as { used, limit }
 * PUT /api/profile { profile }    → the same view after the switch; 400 profile_invalid for any other body.
 *                                   Applies at once: concurrency, Engram cache, decider model, judge mode, budgets.
 * GET /api/telemetry?since=       → { since, calls: { [feature]: { [outcome]: n } }, total, totalMs,
 *                                     latency: { [feature]: { p50, p95, runs } }, budget }
 *                                   since: ISO time or epoch ms (default the last 24 h); 400 telemetry_since
 *
 * server.ts builds the profiles, the budget and the telemetry before the routes and provides
 * them per app; tests pass their own.
 */

export interface ProfileRoutesOptions {
  profiles?: ResourceProfiles;
  budget?: CallBudget;
  telemetry?: CallTelemetry;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sinceParam(url: URL): number {
  const value = url.searchParams.get('since');
  if (value === null) return Date.now() - DAY_MS;
  const since = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(since)) throw new HttpError(400, 'since must be an ISO time or epoch milliseconds', 'telemetry_since');
  return since;
}

export function createProfileRoutes(options: ProfileRoutesOptions = {}): RouteModule {
  return (ctx) => {
    const accounting = ctx.terminals ? callAccounting(ctx.terminals) : null;
    const profiles = options.profiles ?? (ctx.terminals ? resourceProfiles(ctx.terminals) : null) ?? new ResourceProfiles();
    const budget = options.budget ?? accounting?.budget ?? null;
    const telemetry = options.telemetry ?? accounting?.telemetry ?? null;

    const budgetView = () => {
      if (!budget) return null;
      const night = budget.night();
      const today = budget.improveToday();
      return { night: { used: night.used, limit: night.limit }, improveToday: { used: today.used, limit: today.limit } };
    };
    const view = () => ({ ...profiles.view(), budget: budgetView() });

    return [
      { method: 'GET', path: '/api/profile', handler: ({ res }) => sendJson(res, 200, view()) },
      {
        method: 'PUT',
        path: '/api/profile',
        handler: async ({ req, res }) => {
          const body = await readJson(req);
          const keys = Object.keys(body);
          if (keys.length !== 1 || keys[0] !== 'profile' || !isProfileName(body.profile)) {
            throw new HttpError(400, `expected { profile: ${PROFILE_NAMES.map((name) => `"${name}"`).join(' | ')} }`, 'profile_invalid');
          }
          try {
            await profiles.set(body.profile);
          } catch (error) {
            if (error instanceof ProfileError) throw new HttpError(400, error.message, error.code);
            throw error;
          }
          sendJson(res, 200, view());
        },
      },
      {
        method: 'GET',
        path: '/api/telemetry',
        handler: async ({ res, url }) => {
          const since = sinceParam(url);
          const summary = telemetry ? await telemetry.summary(since) : { since: new Date(since).toISOString(), calls: {}, total: 0, totalMs: 0, latency: {} };
          sendJson(res, 200, { ...summary, budget: budgetView() });
        },
      },
    ];
  };
}

/** The routes over the app's own profiles, budget and telemetry (src/server.ts). */
export const profileRoutes: RouteModule = createProfileRoutes();
