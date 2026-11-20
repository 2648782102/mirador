import { McpFileError, gentleShellAgentDir, readProjectMcp, saveProjectMcp } from '../../mcp/project-mcp.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson } from '../respond.ts';

/**
 * Per-project MCP servers (rules in src/mcp/project-mcp.ts).
 *
 * GET /api/mcp?ws=&rel= → ProjectMcpView
 *   { file: '.pi/mcp.json', exists, git: 'tracked' | 'ignored' | 'untracked' | 'none' | 'unknown',
 *     trust: 'trusted' | 'untrusted' | 'unknown', userConfig: 'ok' | 'missing' | 'invalid',
 *     servers: [{ name, source: 'user' | 'project', enabled, locked, description, estimatedMb }] }
 * PUT /api/mcp { ws, rel, disabled: string[] } → ProjectMcpView + { saved: { written, excluded } }
 *   400 mcp_invalid: `disabled` is not a list of listed server names;
 *   409 mcp_unreadable: the existing project file is not a JSON object of servers (left untouched);
 *   409 mcp_not_regular: `.pi` or the file is a symlink or not a regular file.
 *
 * gentle-shell's agent dir is the config key `gentleShellAgentDir`, else GENTLE_SHELL_HOME, else
 * ~/.gentle-shell/agent; Mirador only reads it.
 */

const MAX_NAMES = 200;

function mcpError(error: unknown): never {
  if (error instanceof McpFileError) throw new HttpError(error.code === 'mcp_invalid' ? 400 : 409, error.message, error.code);
  throw error;
}

function disabledNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_NAMES || !value.every((name) => typeof name === 'string')) {
    throw new HttpError(400, 'disabled must be a list of server names', 'mcp_invalid');
  }
  return [...new Set(value as string[])];
}

export const mcpRoutes: RouteModule = (ctx) => {
  const agentDir = () => gentleShellAgentDir((ctx.config as { gentleShellAgentDir?: unknown }).gentleShellAgentDir);
  return [
    {
      method: 'GET',
      path: '/api/mcp',
      handler: async ({ res, url }) => {
        const { path } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel') ?? '');
        sendJson(res, 200, await readProjectMcp({ folder: path, agentDir: agentDir() }).catch(mcpError));
      },
    },
    {
      method: 'PUT',
      path: '/api/mcp',
      handler: async ({ req, res }) => {
        const body = await readJson(req);
        const disabled = disabledNames(body.disabled);
        const { path } = await ctx.resolveFolder(body.ws, body.rel ?? '');
        sendJson(res, 200, await saveProjectMcp({ folder: path, agentDir: agentDir(), disabled }).catch(mcpError));
      },
    },
  ];
};
