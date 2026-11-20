import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface FolderNode {
  name: string;
  /** Path relative to the root, with forward slashes. Empty for the root. */
  rel: string;
  path: string;
  hasChildren: boolean;
  isRepo: boolean;
}

export class InvalidFolderError extends Error {
  constructor(rel: string) {
    super(`not a folder inside the root: ${rel}`);
    this.name = 'InvalidFolderError';
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolves `rel` against `root`, following symlinks, and guarantees the result
 * is an existing directory inside the root. Every path that reaches a terminal
 * or the filesystem goes through here.
 */
export async function resolveInsideRoot(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) throw new InvalidFolderError(rel);
  const realRoot = await realpath(root);
  let target: string;
  try {
    target = await realpath(join(realRoot, rel));
    if (!(await stat(target)).isDirectory()) throw new InvalidFolderError(rel);
  } catch {
    throw new InvalidFolderError(rel);
  }
  if (!isInside(realRoot, target)) throw new InvalidFolderError(rel);
  return target;
}

function isVisible(name: string, ignore: string[]): boolean {
  return !name.startsWith('.') && !ignore.includes(name);
}

async function visibleSubfolders(realRoot: string, dir: string, ignore: string[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!isVisible(entry.name, ignore)) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      try {
        const target = await realpath(join(dir, entry.name));
        if (isInside(realRoot, target) && (await stat(target)).isDirectory()) names.push(entry.name);
      } catch {
        // Broken symlink: not a folder.
      }
    }
  }
  return names.sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function describe(realRoot: string, path: string, name: string, ignore: string[]): Promise<FolderNode> {
  return {
    name,
    rel: relative(realRoot, path).split(sep).join('/'),
    path,
    hasChildren: (await visibleSubfolders(realRoot, path, ignore)).length > 0,
    isRepo: await exists(join(path, '.git')),
  };
}

/** Lists the visible subfolders of `rel`, one level deep. */
export async function listFolders(root: string, rel: string, ignore: string[]): Promise<FolderNode[]> {
  const realRoot = await realpath(root);
  const dir = await resolveInsideRoot(realRoot, rel);
  const names = await visibleSubfolders(realRoot, dir, ignore);
  return Promise.all(names.map((name) => describe(realRoot, join(dir, name), name, ignore)));
}

/**
 * Describes the folders a workspace chose (paths relative to the root), named by
 * that path. A chosen folder that no longer exists or now escapes the root is skipped.
 */
export async function describeFolders(root: string, rels: string[], ignore: string[]): Promise<FolderNode[]> {
  const realRoot = await realpath(root);
  const nodes: FolderNode[] = [];
  for (const rel of rels) {
    let path: string;
    try {
      path = await resolveInsideRoot(realRoot, rel);
    } catch {
      continue;
    }
    if (path === realRoot) continue;
    nodes.push(await describe(realRoot, path, relative(realRoot, path).split(sep).join('/'), ignore));
  }
  return nodes;
}
