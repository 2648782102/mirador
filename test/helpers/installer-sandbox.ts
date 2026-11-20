import { existsSync, realpathSync } from 'node:fs';
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
 * temp dir, and HOME is neither the real home nor a folder holding it. Call it on the child's env right
 * before spawning either script or a copy of it.
 */
export function assertInstallerSandbox(env: NodeJS.ProcessEnv, probe: InstallerSandboxProbe = defaultProbe): void {
  if (probe.inContainer()) return;
  const tmp = resolveReal(probe.tmpdir());
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
