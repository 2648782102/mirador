import { chmod as fsChmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

/**
 * node-pty starts every terminal on macOS through its `spawn-helper` binary, and node-pty 1.1.0
 * ships that binary in its macOS prebuilds without the execute bit (mode 0644 in the npm tarball),
 * so on a fresh install every pty.spawn fails with "posix_spawnp failed" and no terminal opens.
 * On darwin, once at startup, Mirador adds the execute bit
 * where the read bit is set (0644 → 0755) to the helper node-pty would load: its prebuild for this
 * architecture, or a local build. Elsewhere nothing is touched.
 */

export interface SpawnHelperOptions {
  /** `process.platform` unless given; only darwin is fixed. */
  platform?: NodeJS.Platform;
  /** `process.arch` unless given: picks prebuilds/darwin-<arch>. */
  arch?: string;
  /** node-pty's package folder; the installed one unless given. */
  ptyDir?: string;
  chmod?: (path: string, mode: number) => Promise<void>;
}

function installedPtyDir(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

/**
 * Makes node-pty's spawn-helper executable on macOS. Resolves with the lines to log: one per
 * helper it fixed, or that it could not fix (with the command to run); none when nothing needed
 * it. Never throws.
 */
export async function ensureSpawnHelper(options: SpawnHelperOptions = {}): Promise<string[]> {
  if ((options.platform ?? process.platform) !== 'darwin') return [];
  const ptyDir = options.ptyDir ?? installedPtyDir();
  if (!ptyDir) return [];
  const chmod = options.chmod ?? fsChmod;
  const lines: string[] = [];
  const candidates = [join(ptyDir, 'prebuilds', `darwin-${options.arch ?? process.arch}`, 'spawn-helper'), join(ptyDir, 'build', 'Release', 'spawn-helper')];
  for (const helper of candidates) {
    const mode = await stat(helper).then((info) => (info.isFile() ? info.mode & 0o7777 : null), () => null);
    if (mode === null || (mode & 0o100) !== 0) continue;
    try {
      await chmod(helper, mode | ((mode & 0o444) >> 2) | 0o100);
      lines.push(`mirador: made node-pty's spawn-helper executable (${relative(ptyDir, helper)}); without it no terminal starts on macOS (posix_spawnp failed)`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lines.push(`mirador: node-pty's spawn-helper is not executable and could not be fixed (${reason}); terminals will not start on macOS until you run: chmod +x ${helper}`);
    }
  }
  return lines;
}
