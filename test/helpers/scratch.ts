import { tmpdir } from 'node:os';

/**
 * Where a test that starts a server makes its scratch folder. The server listens on Unix sockets
 * under <scratch>/run/mirador (night/socket, herdr/socket), and macOS caps a socket path at 104
 * bytes (sun_path; listen fails with EINVAL past it). macOS's own tmpdir, /var/folders/<2>/<28>/T
 * (/private/var/… once resolved), already takes 57 of them, so there the scratch goes under /tmp.
 * Everywhere else it is os.tmpdir(), as before (group S).
 */
export function scratchBase(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/tmp' : tmpdir();
}

/** The longest Unix socket path macOS accepts, in bytes (104 with the terminating NUL). */
export const MACOS_SOCKET_PATH_MAX = 103;
