import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * gentle-ai's record of the agents it configured: `${GENTLE_AI_HOME:-~/.gentle-ai}/state.json`.
 * It is gentle-ai's undocumented internal state, so it is read leniently.
 */
export function gentleAiStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GENTLE_AI_HOME || join(env.HOME || homedir(), '.gentle-ai'), 'state.json');
}

/**
 * The ids in `installed_agents`, in gentle-ai's order, without duplicates. A missing or
 * unreadable file, bad JSON or a missing field give []; entries that are not ids are skipped.
 * Ids Mirador does not know are kept here: the agent catalog decides what it offers.
 */
export async function readInstalledAgents(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let state: unknown;
  try {
    state = JSON.parse(await readFile(gentleAiStatePath(env), 'utf8'));
  } catch {
    return [];
  }
  const installed = state && typeof state === 'object' ? (state as { installed_agents?: unknown }).installed_agents : undefined;
  if (!Array.isArray(installed)) return [];
  return [...new Set(installed.filter((id): id is string => typeof id === 'string' && id !== ''))];
}
