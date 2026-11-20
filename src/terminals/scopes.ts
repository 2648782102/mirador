import { execFile } from 'node:child_process';

/**
 * Transient systemd user scopes for terminals. systemd-oomd kills a whole cgroup on a
 * swap kill, so each pty gets its own: an OOM kill takes one terminal, not the server
 * and every agent with it.
 *
 * `systemd-run --scope` execs the command in place: the pty child keeps its pid, signals,
 * environment, folder and exit code or signal. `--expand-environment=no` keeps a `$` in the
 * command as written (systemd-run expands `$VAR` and `$$` by default).
 */
export const SCOPE_FLAGS = ['--user', '--scope', '--collect', '--quiet', '--expand-environment=no'];

/** The scope unit (without `.scope`) of terminal `id`: `mirador-agent-<id>` or `mirador-shell-<id>`. */
export function scopeUnit(kind: string, id: string): string {
  return `mirador-${kind}-${id}`;
}

/** `file args…` run inside the transient scope `<unit>.scope`. */
export function scopeCommand(unit: string, file: string, args: string[]): { file: string; args: string[] } {
  return { file: 'systemd-run', args: [...SCOPE_FLAGS, `--unit=${unit}`, '--', file, ...args] };
}

/**
 * How long one `systemctl --user stop` may take. systemd itself sends SIGTERM to every
 * process of the scope and SIGKILL after its TimeoutStopSec (DefaultTimeoutStopSec, 90 s
 * unless the user manager sets less); a stop still pending when this runs out goes on.
 */
export const STOP_TIMEOUT_MS = 20_000;

function systemctl(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => execFile(command, ['--user', ...args], { timeout: timeoutMs }, (_error, stdout) => resolve(String(stdout))));
}

/**
 * Stops the scopes `units` (names without `.scope`) and everything still running in them,
 * then resolves with the ones that still run. Each unit gets its own `systemctl stop`: one
 * that is already gone fails only its own call (systemctl refuses the whole job list when
 * one unit is not loaded). Never rejects; a state systemctl does not answer counts as gone.
 */
export async function stopScopes(units: string[], options: { command?: string; timeoutMs?: number } = {}): Promise<string[]> {
  if (units.length === 0) return [];
  const command = options.command ?? 'systemctl';
  await Promise.all(units.map((unit) => systemctl(command, ['stop', '--', `${unit}.scope`], options.timeoutMs ?? STOP_TIMEOUT_MS)));
  const states = (await systemctl(command, ['is-active', '--', ...units.map((unit) => `${unit}.scope`)], 5000)).split('\n');
  return units.filter((_, i) => states[i] !== undefined && states[i] !== '' && states[i] !== 'inactive' && states[i] !== 'failed');
}

/**
 * Whether the scope `unit` (without `.scope`) ended because memory ran out: systemd-oomd or
 * the kernel killed it, and the user manager logged its result 'oom-kill' to the user journal
 * (`USER_UNIT=<unit>.scope UNIT_RESULT=oom-kill`). The pty can report the kill before that
 * line is written, so it asks `attempts` times, `delayMs` apart. Without the line (no journal,
 * no journalctl, another reason), false: it never guesses from the signal alone.
 */
export async function scopeOomKilled(unit: string, options: { command?: string; attempts?: number; delayMs?: number } = {}): Promise<boolean> {
  const args = ['--user', `USER_UNIT=${unit}.scope`, 'UNIT_RESULT=oom-kill', '-o', 'cat', '-n', '1', '-q', '--no-pager'];
  const attempts = options.attempts ?? 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const found = await new Promise<boolean>((resolve) =>
      execFile(options.command ?? 'journalctl', args, { timeout: 2000 }, (error, stdout) => resolve(!error && String(stdout).trim() !== '')),
    );
    if (found) return true;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 500));
  }
  return false;
}

/** Whether a scope can be created here: resolves with why not, or null when it can. */
export type ScopeProbe = () => Promise<string | null>;

/**
 * Runs `systemd-run <SCOPE_FLAGS> -- true` once (missing user manager or bus, an old
 * systemd without one of the flags, or no systemd at all all fail it).
 */
export function probeScopes(command = 'systemd-run', timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...SCOPE_FLAGS, '--', 'true'], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (!error) return resolve(null);
      if (error.killed) return resolve(`no answer within ${timeoutMs} ms`);
      resolve(String(stderr).trim().split('\n')[0] || error.message);
    });
  });
}

/**
 * Decides once, at startup, whether terminals run in their own scopes: on unless the
 * config says `scopes: false` or MIRADOR_SCOPES=0, and only when the probe works.
 * macOS has no systemd: there scopes are off without probing.
 * `message` is the one line Mirador logs about it.
 */
export async function decideScopes(options: {
  config: { scopes?: unknown };
  env: Record<string, string | undefined>;
  probe: ScopeProbe;
  /** `process.platform` unless given. */
  platform?: NodeJS.Platform;
}): Promise<{ enabled: boolean; message: string }> {
  if (options.env.MIRADOR_SCOPES === '0') return { enabled: false, message: 'mirador: terminal scopes off (MIRADOR_SCOPES=0)' };
  if (options.config.scopes === false) return { enabled: false, message: 'mirador: terminal scopes off (config scopes: false)' };
  if ((options.platform ?? process.platform) === 'darwin') {
    return { enabled: false, message: 'mirador: terminal scopes off: macOS has no systemd, so terminals run without memory limits (limits not available on macOS)' };
  }
  const problem = await options.probe();
  if (problem !== null) return { enabled: false, message: `mirador: terminal scopes off: systemd-run --user --scope failed (${problem})` };
  return { enabled: true, message: 'mirador: terminal scopes on: each terminal runs in its own systemd user scope (mirador-<kind>-<id>.scope)' };
}
