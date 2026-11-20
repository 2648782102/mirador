import { stat } from 'node:fs/promises';
import { onPath } from './agents/catalog.ts';
import { gentleAiStatePath } from './agents/gentle-ai-state.ts';
import type { Mode } from './config.ts';

/** The mode the UI shows: `auto` already decided. */
export type ResolvedMode = Exclude<Mode, 'auto'>;

/**
 * The mode for the configured `mode`. `auto` is gentle-deck when
 * gentle-ai's state.json exists or gentle-shell is on PATH, and plain otherwise. `env` supplies
 * GENTLE_AI_HOME/HOME and PATH; it is read on each call, so installing gentle-ai needs no restart.
 */
export async function resolveMode(mode: Mode, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedMode> {
  if (mode !== 'auto') return mode;
  const state = await stat(gentleAiStatePath(env)).then(() => true, () => false);
  return state || (await onPath('gentle-shell', env.PATH)) ? 'gentle-deck' : 'plain';
}
