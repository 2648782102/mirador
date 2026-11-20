// Memory health (read-only): what in Engram's data hides memories from Mirador or
// clutters them. Pure functions over one all-projects window and one GET /projects
// answer, plus a bounded, cached folder → project lookup. Nothing here writes to Engram.
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { fallbackTitle } from '../../public/memory-health-model.js';
import type { Observation } from './daily-summary.ts';
import type { ProjectListing } from './folder-memory.ts';
import { folderProjects } from './overview.ts';

/** Engram observations also carry the session that saved them. */
export type HealthObservation = Observation & { session_id?: string };

/** A folder of some workspace: its root (`root: true`) or one of the folders the overview shows. */
export interface HealthFolder {
  path: string;
  root: boolean;
}

/**
 * Why a project looks mis-assigned: it was created by running an agent in the home folder,
 * in a workspace root that holds several projects, or in Downloads, Desktop or a temp folder.
 */
export type SuspiciousReason = 'home' | 'container' | 'scratch';

export interface ProjectHealth {
  name: string;
  /** Engram's own count when it lists the project; else the count in the window read. */
  observations: number;
  inWindow: number;
  untitled: number;
  duplicateCopies: number;
  withoutTopicKey: number;
  passive: number;
  /** Some folder of some workspace maps to it. */
  matched: boolean;
  suspicious: SuspiciousReason | null;
}

export interface UntitledMemory {
  id: number;
  project: string;
  type: string;
  at: string;
  /** The first meaningful line of the content (see fallbackTitle); null when it has no text. */
  fallbackTitle: string | null;
}

export interface DuplicateGroup {
  project: string;
  /** The newest copy's title (or fallback title). */
  title: string;
  type: string;
  copies: number;
  /** The newest copies' ids, at most DUPLICATE_IDS. */
  ids: number[];
  lastAt: string;
}

export interface ProjectFinding {
  name: string;
  observations: number;
  /** The folders Engram saw it used from, at most DIRECTORIES. */
  directories: string[];
}

export interface MemoryHealth {
  projects: ProjectHealth[];
  untitled: UntitledMemory[];
  duplicates: DuplicateGroup[];
  unmatchedProjects: ProjectFinding[];
  suspiciousProjects: Array<ProjectFinding & { reason: SuspiciousReason }>;
  totals: {
    projects: number;
    observations: number;
    inWindow: number;
    /** The window hit Engram's read limit: per-memory findings cover only the newest entries. */
    windowFull: boolean;
    untitled: number;
    duplicateGroups: number;
    /** Copies beyond the first of every duplicate group. */
    duplicateCopies: number;
    withoutTopicKey: number;
    passive: number;
    unmatched: number;
    suspicious: number;
  };
}

export const HEALTH_LIST_LIMIT = 50;
const DUPLICATE_IDS = 10;
const DIRECTORIES = 5;
const SESSION_SUMMARY = 'session_summary';
const PASSIVE = 'passive';

/** Folder names that are never a project (English and Spanish desktops). */
const SCRATCH_NAMES = new Set(['downloads', 'descargas', 'desktop', 'escritorio', 'documents', 'documentos', 'tmp', 'temp']);
const SCRATCH_HOME_DIRS = ['Downloads', 'Descargas', 'Desktop', 'Escritorio', 'Documents', 'Documentos'];

const trimSlash = (path: string) => path.replace(/\/+$/, '') || '/';
const isBlank = (value: unknown) => typeof value !== 'string' || !value.trim();
const normalize = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
const byCountThenName = <T extends { observations: number; name: string }>(a: T, b: T) => b.observations - a.observations || a.name.localeCompare(b.name);

/** The title a memory is known by: its own, or the fallback for an untitled one. */
const effectiveTitle = (o: HealthObservation): string | null => (isBlank(o.title) ? fallbackTitle(o.content) : o.title);

/**
 * Duplicate rule: two memories are copies when they share the project and the title,
 * ignoring case and repeated spaces (an untitled memory uses its fallback title; one
 * without any text is never a copy). Session summaries all share a generic title, so
 * they count as copies only within the same session (a summary saved twice); summaries
 * of different sessions, or without a session, are separate.
 */
function duplicateKey(o: HealthObservation): string | null {
  const title = effectiveTitle(o);
  if (!title) return null;
  if (o.type === SESSION_SUMMARY) return isBlank(o.session_id) ? null : `${o.project}\0${normalize(title)}\0${o.session_id}`;
  return `${o.project}\0${normalize(title)}`;
}

function suspicion(name: string, directories: string[], home: string, roots: string[], tmpDirs: string[]): SuspiciousReason | null {
  const lower = name.toLowerCase();
  if (lower === basename(home).toLowerCase()) return 'home';
  if (roots.some((root) => basename(root).toLowerCase() === lower)) return 'container';
  if (SCRATCH_NAMES.has(lower)) return 'scratch';
  // Under another name, but only ever used from folders that are not projects.
  const scratchDirs = SCRATCH_HOME_DIRS.map((dir) => `${home}/${dir}`);
  const kindOf = (dir: string): SuspiciousReason | null => {
    if (dir === home) return 'home';
    if (roots.includes(dir)) return 'container';
    // Inside a workspace is a project, even when the workspace itself lives in a temp folder.
    if (roots.some((root) => dir.startsWith(`${root}/`))) return null;
    if (scratchDirs.includes(dir) || tmpDirs.some((tmp) => dir === tmp || dir.startsWith(`${tmp}/`))) return 'scratch';
    return null;
  };
  const kinds = directories.map(kindOf);
  return kinds.length && kinds.every((kind) => kind !== null) ? kinds[0] : null;
}

/**
 * The health report. `observations` is the shared all-projects window (never mutated);
 * `listing` is GET /projects; `folders` are every workspace's root and folders, and
 * `resolved` what Engram's own resolution (GET /project/current) gave for some of them.
 *
 * A project matches a folder by the overview's rule (folderProjects: named like the folder
 * or used from a directory at or below it; only at a root) or by Engram resolving that
 * folder to it. `unmatchedProjects` leaves out the suspicious ones, which are listed with
 * their reason. Only titles and fallback titles leave this function, never content.
 */
export function buildMemoryHealth(input: {
  observations: HealthObservation[];
  listing: ProjectListing[];
  folders: HealthFolder[];
  resolved: ReadonlyMap<string, string | null>;
  home: string;
  windowFull: boolean;
  limit?: number;
  /** Temp folders a project must not live in (default /tmp, /var/tmp and the OS temp dir). */
  tmpDirs?: string[];
}): MemoryHealth {
  const limit = input.limit ?? HEALTH_LIST_LIMIT;
  const home = trimSlash(input.home);
  const roots = input.folders.filter((f) => f.root).map((f) => trimSlash(f.path));
  const tmpDirs = (input.tmpDirs ?? [...new Set(['/tmp', '/var/tmp', tmpdir()])]).map(trimSlash);

  // Per-memory findings, in one pass over the window.
  const perProject = new Map<string, { inWindow: number; untitled: number; withoutTopicKey: number; passive: number; duplicateCopies: number }>();
  const untitled: HealthObservation[] = [];
  const groups = new Map<string, HealthObservation[]>();
  for (const o of input.observations) {
    let counts = perProject.get(o.project);
    if (!counts) perProject.set(o.project, (counts = { inWindow: 0, untitled: 0, withoutTopicKey: 0, passive: 0, duplicateCopies: 0 }));
    counts.inWindow++;
    if (isBlank(o.title)) {
      counts.untitled++;
      untitled.push(o);
    }
    if (o.type === PASSIVE) counts.passive++;
    // Session summaries and passive captures are saved without a topic key by design.
    else if (o.type !== SESSION_SUMMARY && isBlank(o.topic_key)) counts.withoutTopicKey++;
    const key = duplicateKey(o);
    if (key) groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const newestFirst = (a: HealthObservation, b: HealthObservation) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : b.id - a.id);
  const duplicates: DuplicateGroup[] = [...groups.values()]
    .filter((copies) => copies.length > 1)
    .map((copies) => {
      const sorted = [...copies].sort(newestFirst);
      const newest = sorted[0];
      (perProject.get(newest.project) as { duplicateCopies: number }).duplicateCopies += copies.length - 1;
      return { project: newest.project, title: effectiveTitle(newest) as string, type: newest.type, copies: copies.length, ids: sorted.slice(0, DUPLICATE_IDS).map((o) => o.id), lastAt: newest.created_at };
    })
    .sort((a, b) => b.copies - a.copies || a.project.localeCompare(b.project) || normalize(a.title).localeCompare(normalize(b.title)));

  // Projects: Engram's listing (with memory) and anything the window holds.
  const listed = new Map<string, ProjectListing>();
  for (const p of Array.isArray(input.listing) ? input.listing : []) {
    if (typeof p?.name === 'string' && (p.observation_count === undefined || p.observation_count > 0)) listed.set(p.name, p);
  }
  const mapping = folderProjects(input.listing);
  const matched = new Set<string>();
  for (const folder of input.folders) {
    for (const name of folder.root ? mapping.at(folder.path) : mapping.under(folder.path)) matched.add(name);
    const resolved = input.resolved.get(folder.path);
    if (resolved) matched.add(resolved);
  }
  const names = new Set([...listed.keys(), ...perProject.keys()]);
  const projects: ProjectHealth[] = [];
  const unmatchedProjects: ProjectFinding[] = [];
  const suspiciousProjects: MemoryHealth['suspiciousProjects'] = [];
  for (const name of names) {
    const counts = perProject.get(name) ?? { inWindow: 0, untitled: 0, withoutTopicKey: 0, passive: 0, duplicateCopies: 0 };
    const listing = listed.get(name);
    const directories = (Array.isArray(listing?.directories) ? listing.directories : []).map(trimSlash);
    const observations = Math.max(listing?.observation_count ?? 0, counts.inWindow);
    const reason = suspicion(name, directories, home, roots, tmpDirs);
    const isMatched = matched.has(name);
    projects.push({ name, observations, ...counts, matched: isMatched, suspicious: reason });
    const finding = { name, observations, directories: directories.slice(0, DIRECTORIES) };
    if (reason) suspiciousProjects.push({ ...finding, reason });
    else if (!isMatched) unmatchedProjects.push(finding);
  }
  // Key order of a project entry stays fixed: name first, then its counts.
  const ordered = projects
    .sort(byCountThenName)
    .map((p) => ({ name: p.name, observations: p.observations, inWindow: p.inWindow, untitled: p.untitled, duplicateCopies: p.duplicateCopies, withoutTopicKey: p.withoutTopicKey, passive: p.passive, matched: p.matched, suspicious: p.suspicious }));
  unmatchedProjects.sort(byCountThenName);
  suspiciousProjects.sort(byCountThenName);

  const sum = (pick: (p: ProjectHealth) => number) => ordered.reduce((total, p) => total + pick(p), 0);
  return {
    projects: ordered,
    untitled: untitled
      .sort(newestFirst)
      .slice(0, limit)
      .map((o) => ({ id: o.id, project: o.project, type: o.type, at: o.created_at, fallbackTitle: fallbackTitle(o.content) })),
    duplicates: duplicates.slice(0, limit),
    unmatchedProjects,
    suspiciousProjects,
    totals: {
      projects: ordered.length,
      observations: sum((p) => p.observations),
      inWindow: input.observations.length,
      windowFull: input.windowFull,
      untitled: untitled.length,
      duplicateGroups: duplicates.length,
      duplicateCopies: sum((p) => p.duplicateCopies),
      withoutTopicKey: sum((p) => p.withoutTopicKey),
      passive: sum((p) => p.passive),
      unmatched: unmatchedProjects.length,
      suspicious: suspiciousProjects.length,
    },
  };
}

/** A cached folder → project answer (null: Engram resolves the folder to no project). */
export type LookupCache = Map<string, { at: number; project: string | null }>;

const CACHE_ENTRIES = 500;

/**
 * Resolves at most `max` folders to their Engram project with `lookup`, `concurrency` at
 * a time, reusing answers younger than `ttlMs` from `cache`. Folders past `max` are
 * `skipped` (they still match by the overview's rule). A failed lookup rejects and is not
 * cached, so the route answers 503 like every other Engram read.
 */
export async function resolveFolders(
  paths: string[],
  lookup: (path: string) => Promise<string | null>,
  options: { max: number; concurrency: number; cache: LookupCache; ttlMs: number; now?: () => number },
): Promise<{ resolved: Map<string, string | null>; skipped: number }> {
  const now = options.now ?? Date.now;
  const unique = [...new Set(paths)];
  const taken = unique.slice(0, Math.max(0, options.max));
  const answers = new Map<string, string | null>();
  const missing: string[] = [];
  for (const path of taken) {
    const cached = options.cache.get(path);
    if (cached && now() - cached.at < options.ttlMs) answers.set(path, cached.project);
    else missing.push(path);
  }
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const path = missing[next++];
      const project = await lookup(path);
      answers.set(path, project);
      options.cache.delete(path);
      options.cache.set(path, { at: now(), project });
      if (options.cache.size > CACHE_ENTRIES) options.cache.delete(options.cache.keys().next().value as string);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency), missing.length) }, worker));
  return { resolved: new Map(taken.map((path) => [path, answers.get(path) ?? null])), skipped: unique.length - taken.length };
}
