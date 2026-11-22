import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

/** What the guard asks of the host; tests fake it. */
export interface InstallerSandboxProbe {
  /** Whether this process runs in a container (Docker's /.dockerenv, Podman's /run/.containerenv). */
  inContainer(): boolean;
  /** The user's real home, from the user database, never from $HOME. */
  realHome(): string;
  /** The temp dir a scratch HOME must lie inside. */
  tmpdir(): string;
}

export const defaultProbe: InstallerSandboxProbe = {
  inContainer: () => existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
  realHome: () => userInfo().homedir,
  tmpdir: () => tmpdir(),
};

/** The tools that reach the network, which an installer test must never run for real (a mise under a scratch HOME downloads Node). */
export const NETWORK_TOOLS = ['mise', 'curl', 'wget'] as const;
/** The exit code of every fake in the network barrier. */
export const NETWORK_BARRIER_EXIT = 97;

/**
 * Writes into `dir` (created if needed) a fake of each of `tools` that prints one line on stderr saying it is
 * blocked and exits NETWORK_BARRIER_EXIT, touching nothing else. Put `dir` on an installer test's PATH right
 * after the test's own stubs, before any system folder. Returns `dir`.
 */
export async function writeNetworkBarrier(dir: string, tools: readonly string[] = NETWORK_TOOLS): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const line = `mirador test sandbox: '${tool}' is blocked here, installer tests must not reach the network`;
    await writeFile(join(dir, tool), `#!/bin/sh\nprintf '%s\\n' "${line}" >&2\nexit ${NETWORK_BARRIER_EXIT}\n`);
    await chmod(join(dir, tool), 0o755);
  }
  return dir;
}

/** Where a shell given `path` finds the executable `tool`, or undefined; relative and empty entries are skipped. */
function which(tool: string, path: string): string | undefined {
  for (const dir of path.split(':')) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, tool);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      // not there, or not executable: the shell goes on too
    }
  }
  return undefined;
}

const XDG_DIRS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

/** `path` with the symlinks of its existing parts resolved; the parts that do not exist yet stay as written. */
function resolveReal(path: string): string {
  let real: string = sep;
  for (const part of path.split(sep)) {
    if (part === '' || part === '.') continue;
    const next = join(real, part);
    real = existsSync(next) ? realpathSync(next) : next;
  }
  return real;
}

/** Whether `path` lies strictly below `dir`. */
function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Throws unless a child given `env` may run scripts/bootstrap.sh or install.sh (R2: no run changes the real
 * home): the process runs in a container, or the child's HOME and every XDG base dir it sets lie inside the
 * temp dir, and HOME is neither the real home nor a folder holding it. In a container too, the child's PATH
 * must not find a real mise, curl or wget: each one it finds must lie inside the temp dir, as the fakes of
 * writeNetworkBarrier do. Call it on the child's env right before spawning either script or a copy of it.
 */
export function assertInstallerSandbox(env: NodeJS.ProcessEnv, probe: InstallerSandboxProbe = defaultProbe): void {
  const tmp = resolveReal(probe.tmpdir());
  for (const tool of NETWORK_TOOLS) {
    const found = which(tool, env.PATH ?? '');
    if (!found) continue;
    const real = resolveReal(found);
    if (inside(real, tmp)) continue;
    const where = real === found ? found : `${found} (${real})`;
    throw new Error(`installer sandbox: PATH finds ${tool} at ${where}, outside ${tmp}; put writeNetworkBarrier's folder on PATH before any system folder, so installer tests cannot reach the network`);
  }
  if (probe.inContainer()) return;
  function refuse(reason: string): never {
    throw new Error(`installer sandbox: ${reason}; run the installer in a container or with a temporary HOME inside ${tmp}`);
  }
  const home = env.HOME;
  if (!home) refuse('HOME is not set');
  if (!isAbsolute(home)) refuse(`HOME ${home} is not an absolute path`);
  const real = resolveReal(home);
  const realHome = resolveReal(probe.realHome());
  if (real === realHome) refuse(`HOME ${home} is the real home ${realHome}`);
  if (inside(realHome, real)) refuse(`HOME ${home} contains the real home ${realHome}`);
  if (!inside(real, tmp)) refuse(`HOME ${home} is not inside ${tmp}`);
  for (const name of XDG_DIRS) {
    const dir = env[name];
    if (!dir) continue;
    if (!isAbsolute(dir)) refuse(`${name} ${dir} is not an absolute path`);
    if (!inside(resolveReal(dir), tmp)) refuse(`${name} ${dir} is not inside ${tmp}`);
  }
}
