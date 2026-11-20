import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellQuote } from '../terminals/registry.ts';

/**
 * Claude Code's attention bridge. Claude reads its hooks from its
 * settings, so Mirador writes its own settings file and passes it on each launch with
 * `--settings <file>` (the catalog's bridgeFlag), never touching `~/.claude` or a project's
 * `.claude`; Claude merges hooks across settings levels, so the user's own hooks still run
 * (https://code.claude.com/docs/en/hooks). Every hook runs bin/claude-hook with Mirador's node, which
 * reports through the herdr socket as the gentle-shell bridge does: a submitted prompt or a finished
 * tool call is working, a Notification that waits for an answer is waiting, Stop is finished, and
 * each report carries the hook's `session_id`, which Mirador records to resume with `--resume <id>`.
 */
export const CLAUDE_HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop'] as const;
/**
 * Seconds Claude gives a hook; the script gives up after one. The hooks run in the foreground, so
 * Claude starts them in order and their reports (numbered from the clock) arrive in order.
 */
const HOOK_TIMEOUT_S = 5;

/** The settings that run `command` on every hook event Mirador follows, for any matcher. */
export function claudeSettings(command: string): { hooks: Record<string, Array<{ hooks: Array<{ type: 'command'; command: string; timeout: number }> }>> } {
  return { hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }]])) };
}

/**
 * Writes `<dir>/claude-settings.json` (mode 0600, in Mirador's 0700 herdr folder), whose hooks run
 * `hookPath` with `nodePath` (the agent's PATH may not have a node), and returns its path.
 */
export async function prepareClaudeSettings(dir: string, hookPath: string, nodePath = process.execPath): Promise<string> {
  const file = join(dir, 'claude-settings.json');
  await writeFile(file, `${JSON.stringify(claudeSettings(`${shellQuote(nodePath)} ${shellQuote(hookPath)}`), null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
