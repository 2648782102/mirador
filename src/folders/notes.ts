// A folder's NOTES.md, the hand-written half of plain mode's "Where it left off".
// Plain text only: the UI shows it as text, never as HTML.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { resolveInsideRoot } from './tree.ts';

/** The exact name read, at the folder's root. */
export const NOTES_FILE = 'NOTES.md';
/** Most bytes read; a longer file is cut on a whole character and `truncated` is set. */
export const MAX_NOTES_BYTES = 16 * 1024;

export interface FolderNotes {
  text: string;
  truncated: boolean;
}

const isInside = (root: string, target: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * NOTES.md of folder `rel` of the workspace at `root`, or null when there is none to show: no such
 * file, not a regular file, a symlink that leaves the root, binary (a NUL byte) or unreadable.
 * The folder goes through resolveInsideRoot (src/folders/tree.ts): outside the root it throws
 * InvalidFolderError. At most MAX_NOTES_BYTES are read; nothing is ever written.
 */
export async function readNotes(root: string, rel: string): Promise<FolderNotes | null> {
  const realRoot = await realpath(root);
  const folder = await resolveInsideRoot(realRoot, rel);
  let file;
  try {
    const target = await realpath(join(folder, NOTES_FILE));
    if (!isInside(realRoot, target)) return null;
    // O_NONBLOCK: a FIFO named NOTES.md must not hold the request until something writes to it.
    file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    // Checked on the open file, so a FIFO, device or folder (also one swapped in after realpath) is never read.
    const info = await file.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(MAX_NOTES_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > MAX_NOTES_BYTES;
    const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_NOTES_BYTES));
    if (bytes.includes(0)) return null;
    // `stream: true` keeps a character cut at the limit out instead of turning it into U+FFFD.
    const text = new TextDecoder('utf-8').decode(bytes, { stream: truncated });
    return { text, truncated };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
