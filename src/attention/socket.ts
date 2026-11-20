import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { dirname } from 'node:path';
import { MAX_LINE_BYTES } from './store.ts';

const MAX_CONNECTIONS = 32;
const MAX_LINES_PER_CONNECTION = 16;
const IDLE_MS = 2000;

/** True when something is accepting connections on `path`, e.g. another running Mirador. */
function inUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

/**
 * Listens on the Unix socket at `path` (its folder is made 0700) and hands each
 * newline-terminated line to `onLine`. A connection that sends more than one
 * line's worth of bytes without a newline, too many lines, or nothing for two
 * seconds is dropped. Nothing is ever written back: clients only report.
 */
export async function listenForReports(path: string, onLine: (line: string) => void): Promise<Server> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  // Never take the socket from a Mirador that is serving it; only replace one left by a crash.
  if (await inUse(path)) throw new Error(`${path} is in use by another Mirador`);
  await rm(path, { force: true });
  const server = createServer((conn) => {
    let buffered = '';
    let lines = 0;
    conn.setEncoding('utf8');
    conn.setTimeout(IDLE_MS, () => conn.destroy());
    conn.on('error', () => conn.destroy());
    conn.on('data', (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (++lines > MAX_LINES_PER_CONNECTION) return conn.destroy();
        try {
          onLine(line);
        } catch (error) {
          console.error('attention report failed:', error);
        }
      }
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) conn.destroy();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('error', (error) => console.error('attention socket error:', error));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return server;
}
