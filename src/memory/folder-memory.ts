import { basename } from 'node:path';
import { EngramUnavailableError } from './engram.ts';

/** The fields of Engram's GET /projects entries this module reads. */
export interface ProjectListing {
  name: string;
  observation_count?: number;
  directories: string[] | null;
}

/**
 * Builds "does Engram hold memory for this folder?" from one GET /projects answer.
 * Approximation (no request per folder): a folder has memory when a project with
 * observations lists a directory at or below it, or is named like the folder
 * (Engram names projects after their folder). A project above the folder does not
 * count, or every folder under ~/Dev would match the `dev` project.
 */
export function memoryLookup(projects: ProjectListing[]): (path: string) => boolean {
  const listed = Array.isArray(projects) ? projects : [];
  const withMemory = listed.filter((p) => typeof p?.name === 'string' && (p.observation_count === undefined || p.observation_count > 0));
  const directories = withMemory.flatMap((p) => (Array.isArray(p.directories) ? p.directories : [])).map((dir) => dir.replace(/\/+$/, ''));
  const names = new Set(withMemory.map((p) => p.name.toLowerCase()));
  return (path) => {
    const folder = path.replace(/\/+$/, '');
    return names.has(basename(folder).toLowerCase()) || directories.some((dir) => dir === folder || dir.startsWith(folder + '/'));
  };
}

/**
 * Caches the lookup for `ttlMs`. Answers null when it cannot ask Engram (down, slow,
 * an unexpected answer): the tree never depends on Engram. A failure is remembered for
 * `failTtlMs`, so a hung Engram slows one request, not every one; lookups that arrive
 * while Engram is being asked share that request.
 */
export class MemoryIndex {
  private cached: { at: number; lookup: ((path: string) => boolean) | null; ttlMs: number } | null = null;
  private pending: Promise<((path: string) => boolean) | null> | null = null;
  private readonly fetchProjects: () => Promise<ProjectListing[]>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly failTtlMs: number;

  constructor(fetchProjects: () => Promise<ProjectListing[]>, ttlMs = 30_000, now = Date.now, failTtlMs = 5_000) {
    this.fetchProjects = fetchProjects;
    this.ttlMs = ttlMs;
    this.now = now;
    this.failTtlMs = failTtlMs;
  }

  lookup(): Promise<((path: string) => boolean) | null> {
    if (this.cached && this.now() - this.cached.at < this.cached.ttlMs) return Promise.resolve(this.cached.lookup);
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async refresh(): Promise<((path: string) => boolean) | null> {
    try {
      const lookup = memoryLookup(await this.fetchProjects());
      this.cached = { at: this.now(), lookup, ttlMs: this.ttlMs };
      return lookup;
    } catch (error) {
      if (!(error instanceof EngramUnavailableError)) console.error('memory tags unavailable:', error);
      this.cached = { at: this.now(), lookup: null, ttlMs: this.failTtlMs };
      return null;
    }
  }
}
