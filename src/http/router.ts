import type { IncomingMessage, ServerResponse } from 'node:http';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a route handler receives. `params` holds the decoded `:name` segments of the path. */
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export interface Route {
  method: Method;
  /** Exact path; `:name` matches one non-empty segment, e.g. `/api/workspaces/:id`. */
  path: string;
  handler: (request: RouteRequest) => Promise<void> | void;
}

interface CompiledRoute {
  route: Route;
  pattern: RegExp;
  names: string[];
}

function compile(route: Route): CompiledRoute {
  const names: string[] = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { route, pattern: new RegExp(`^${source}$`), names };
}

/**
 * Method + path matching for the API. Authentication and Origin checks run in
 * server.ts before any route, so a route only decides what it answers.
 */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(route: Route): void {
    if (this.routes.some((r) => r.route.method === route.method && r.route.path === route.path)) {
      throw new Error(`route already registered: ${route.method} ${route.path}`);
    }
    this.routes.push(compile(route));
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const { route, pattern, names } of this.routes) {
      if (route.method !== method) continue;
      const found = pathname.match(pattern);
      if (!found) continue;
      const params: Record<string, string> = {};
      try {
        names.forEach((name, i) => { params[name] = decodeURIComponent(found[i + 1]); });
      } catch {
        return null;
      }
      return { route, params };
    }
    return null;
  }
}
