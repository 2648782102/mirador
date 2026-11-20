import { AGENTS, SESSION, SESSION_ID, agentFor } from '../agents/catalog.ts';
import type { EnvProvider } from '../terminals/registry.ts';

/**
 * `<flag> <bridge>` when Mirador can load its attention bridge into `agentCommand`:
 * a plain invocation of a catalog agent with a bridge (gentle-shell or pi, `-e`; claude,
 * `--settings`; agy, `--add-dir`), optionally with its own flags. `bridges` gives each agent's bridge by catalog
 * id; a lone path is the gentle-shell bridge, for pi only. An agent whose bridge rides in its
 * environment (catalog `bridgeEnv`, opencode) gets its flag alone, and bridgeEnvProvider the rest.
 * Any other command is left exactly as configured, and so is everything when `enabled` (config
 * `attentionBridge`) is false.
 */
export function bridgeArgs(agentCommand: string, bridges: string | Readonly<Record<string, string>>, enabled = true): string[] {
  if (!enabled) return [];
  const agent = agentFor(agentCommand);
  if (!agent?.bridgeFlag) return [];
  const bridge = typeof bridges === 'string' ? (agent.id === 'pi' ? bridges : undefined) : bridges[agent.id];
  if (!bridge) return [];
  return agent.bridgeEnv ? [agent.bridgeFlag] : [agent.bridgeFlag, bridge];
}

/**
 * The environment that carries the bridge of an agent whose catalog entry has a `bridgeEnv` (opencode),
 * for agent terminals that run it: chosen by id, or the configured `agentCommand` when no id was given,
 * exactly where bridgeArgs adds its flag. Every other terminal, and all of them when `enabled` is false,
 * gets nothing.
 */
export function bridgeEnvProvider(agentCommand: string, bridges: Readonly<Record<string, string>>, enabled = true): EnvProvider {
  const configured = agentFor(agentCommand);
  return (info) => {
    if (!enabled || info.kind !== 'agent') return {};
    const agent = info.agent ? AGENTS.find((entry) => entry.id === info.agent) : configured;
    const bridge = agent?.bridgeEnv ? bridges[agent.id] : undefined;
    return agent?.bridgeEnv && bridge ? { [agent.bridgeEnv]: bridge } : {};
  };
}

/**
 * The words that reopen `session` in `agentCommand`: the catalog agent's verified resume
 * argv (`--session <file>` for gentle-shell or pi, `--resume <id>` for claude, `--session <id>` for
 * opencode, `--conversation <id>` for agy). None for any other command, or for a session its agent cannot take (an id-resumed agent
 * given anything but a SESSION_ID, such as a pi session file; a file-resumed one given a SESSION_ID, not
 * a path), which then starts a fresh session.
 */
export function resumeArgs(agentCommand: string, session: string): string[] {
  const agent = agentFor(agentCommand);
  if (!agent?.resume || (agent.resumeKey === 'id') !== SESSION_ID.test(session)) return [];
  return agent.resume.map((word) => (word === SESSION ? session : word));
}
