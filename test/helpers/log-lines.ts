import { readFile } from 'node:fs/promises';
import { waitFor } from './wait.ts';

/**
 * The non-empty lines of a log a stub or a child process appends to, one per call. A missing log,
 * an empty one or one that holds only a newline has none, so a wait on it does not end early.
 */
export async function logLines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((line) => line.trim() !== '');
}

/** Waits until the log at `path` holds at least `count` lines, and resolves with all of them. */
export function waitForLogLines(path: string, count: number, ms?: number): Promise<string[]> {
  return waitFor(async () => {
    const lines = await logLines(path);
    return lines.length >= count ? lines : undefined;
  }, `${count} line(s) in ${path}`, ms);
}
