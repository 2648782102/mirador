import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Observation, Session } from './daily-summary.ts';
import type { ProjectListing } from './folder-memory.ts';

export interface EngramProject {
  project: string;
  source: string;
  path: string;
}

/**
 * Entries read per request. Engram 3.6.0's /observations/recent and
 * /sessions/recent take only `project` (or `all_projects`) and `limit`: no
 * date filter, offset or cursor. They return the newest entries first, so
 * Mirador reads a generous window and reports when a day may lie beyond it
 * (see windowMayMissDay).
 */
export const RECENT_LIMIT = 5000;

/**
 * How long one all-projects window is shared between requests by default (20 s): longer
 * than the tracking view's 15 s refresh, so each refresh reads Engram at most once.
 */
export const DEFAULT_ENGRAM_CACHE_MS = 20_000;

/**
 * The all-projects window TTL in ms: MIRADOR_ENGRAM_CACHE_MS when set (tests that change
 * Engram's data between requests set 0), else the configured `engramCacheMs`, else
 * DEFAULT_ENGRAM_CACHE_MS. Anything but a finite number >= 0 is ignored.
 */
export function engramCacheMsFrom(env: Record<string, string | undefined>, configured: unknown): number {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const fromEnv = env.MIRADOR_ENGRAM_CACHE_MS === undefined || env.MIRADOR_ENGRAM_CACHE_MS === '' ? NaN : Number(env.MIRADOR_ENGRAM_CACHE_MS);
  if (valid(fromEnv)) return fromEnv;
  return valid(configured) ? configured : DEFAULT_ENGRAM_CACHE_MS;
}

export class EngramUnavailableError extends Error {
  /** HTTP status when Engram answered with an error; undefined when it did not answer. */
  status?: number;

  constructor(cause: unknown, status?: number) {
    super(`Engram is not reachable: ${(cause as Error)?.message ?? cause}`);
    this.name = 'EngramUnavailableError';
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One memory Mirador writes (the night judge's feedback). */
export interface ObservationInput {
  project: string;
  /** Engram upserts by topic key within the project: one key per evolving fact. */
  topicKey: string;
  title: string;
  content: string;
  type: string;
  /**
   * The absolute folder the write session is registered for (Engram requires one). Use a
   * folder whose name is the project, so Engram's own folder detection agrees with it.
   */
  directory: string;
}

export const MAX_OBSERVATION_CHARS = 20_000;

function checkObservation(input: ObservationInput): void {
  const short = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  if (!short(input.project, 200)) throw new TypeError('project must be a non-empty string');
  if (!short(input.topicKey, 300)) throw new TypeError('topicKey must be a non-empty string');
  if (!short(input.title, 300)) throw new TypeError('title must be a non-empty string');
  if (!short(input.content, MAX_OBSERVATION_CHARS)) throw new TypeError(`content must be 1-${MAX_OBSERVATION_CHARS} characters`);
  if (!short(input.type, 40)) throw new TypeError('type must be a non-empty string');
  if (typeof input.directory !== 'string' || !isAbsolute(input.directory)) throw new TypeError('directory must be an absolute path');
}

function toListing(entry: Record<string, unknown>): ProjectListing {
  const listing: ProjectListing = {
    name: entry.name as string,
    directories: Array.isArray(entry.directories) ? entry.directories.filter((dir): dir is string => typeof dir === 'string') : null,
  };
  if (typeof entry.observation_count === 'number') listing.observation_count = entry.observation_count;
  return listing;
}

/**
 * Client for the local `engram serve` HTTP API: reads, and one write (saveObservation)
 * for the memories Mirador itself owns.
 */
export class EngramClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cacheMs: number;
  private readonly now: () => number;
  /** The latest all-projects window: shared by every caller for `cacheMs`, failures dropped. */
  private window: { limit: number; at: number; entries: Promise<Observation[]> } | null = null;
  /** The write session registered per project (Engram 3.6 needs one for every save). */
  private readonly writeSessions = new Map<string, Promise<string>>();

  /** `cacheMs`: how long one all-projects window serves every caller (0 reads Engram every time). */
  constructor(baseUrl: string, timeoutMs = 4000, options: { cacheMs?: number; now?: () => number } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.cacheMs = options.cacheMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  /**
   * Changes how long the all-projects window is shared (a resource profile switch); the
   * window already read is judged by the new value from now on. Anything but a finite
   * number >= 0 is ignored.
   */
  setCacheMs(cacheMs: number): void {
    if (typeof cacheMs !== 'number' || !Number.isFinite(cacheMs) || cacheMs < 0) return;
    this.cacheMs = cacheMs;
    if (cacheMs === 0) this.window = null;
  }

  /**
   * The parsed JSON body, as unknown: callers check its shape. A body that is not
   * JSON (another service on the port, a cut answer) counts as Engram being unavailable.
   */
  private async get(path: string, params: Record<string, string>, timeoutMs = this.timeoutMs): Promise<unknown> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params)}`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new EngramUnavailableError(error);
    }
    if (!response.ok) throw new EngramUnavailableError(new Error(`${path} answered ${response.status}`), response.status);
    try {
      return await response.json();
    } catch (error) {
      throw new EngramUnavailableError(new Error(`${path} did not answer JSON: ${(error as Error)?.message ?? error}`));
    }
  }

  /** Resolves a folder to its Engram project the same way Engram itself does. */
  async projectFor(cwd: string): Promise<EngramProject | null> {
    const body = await this.get('/project/current', { cwd });
    if (!isRecord(body) || typeof body.project !== 'string' || !body.project) return null;
    return {
      project: body.project,
      source: typeof body.project_source === 'string' ? body.project_source : 'unknown',
      path: typeof body.project_path === 'string' ? body.project_path : cwd,
    };
  }

  /**
   * Every project Engram knows, with its observation count and the directories it was
   * used from. Engram encodes an empty list as null: anything but a list reads as none,
   * and entries without a name are skipped. `timeoutMs` overrides the client's timeout.
   */
  async projects(options: { timeoutMs?: number } = {}): Promise<ProjectListing[]> {
    const body = await this.get('/projects', {}, options.timeoutMs);
    const entries = isRecord(body) && Array.isArray(body.projects) ? body.projects : [];
    return entries.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.name === 'string').map(toListing);
  }

  /**
   * A list endpoint's entries. Engram answers 404 "project not found" for a project with
   * no data yet, and null for an empty list: both read as an empty list.
   */
  private async list<T>(path: string, params: Record<string, string>): Promise<T[]> {
    let body: unknown;
    try {
      body = await this.get(path, params);
    } catch (error) {
      if (error instanceof EngramUnavailableError && error.status === 404) return [];
      throw error;
    }
    return Array.isArray(body) ? (body.filter(isRecord) as T[]) : [];
  }

  observations(project: string, limit = RECENT_LIMIT): Promise<Observation[]> {
    return this.list('/observations/recent', { project, limit: String(limit) });
  }

  /**
   * The newest `limit` observations of every project. The workspace overview, the
   * activity view and container summaries all read this window, so within `cacheMs`
   * they share one read (and one parse of up to RECENT_LIMIT entries). Callers must
   * not mutate the entries.
   */
  allObservations(limit = RECENT_LIMIT): Promise<Observation[]> {
    const at = this.now();
    if (this.window && this.window.limit === limit && at - this.window.at < this.cacheMs) return this.window.entries;
    const entries = this.list<Observation>('/observations/recent', { all_projects: 'true', limit: String(limit) });
    const window = { limit, at, entries };
    if (this.cacheMs > 0) this.window = window;
    entries.catch(() => {
      if (this.window === window) this.window = null;
    });
    return entries;
  }

  sessions(project: string, limit = RECENT_LIMIT): Promise<Session[]> {
    return this.list('/sessions/recent', { project, limit: String(limit) });
  }

  /**
   * POSTs a JSON body; the parsed answer. Errors carry the path and status, never the body.
   * A non-2xx answer is EngramUnavailableError with its status and Engram's `code`.
   */
  private async post(path: string, body: Record<string, unknown>): Promise<{ value: unknown; code?: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new EngramUnavailableError(error);
    }
    let value: unknown = null;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!response.ok) {
      const code = isRecord(value) && typeof value.code === 'string' ? value.code.slice(0, 60) : undefined;
      throw new EngramUnavailableError(new Error(`POST ${path} answered ${response.status}${code ? ` (${code})` : ''}`), response.status);
    }
    return { value };
  }

  /** Registers (once per project and process) the session Mirador's saves belong to. */
  private writeSession(project: string, directory: string): Promise<string> {
    let session = this.writeSessions.get(project);
    if (!session) {
      const id = `${project}-mirador-${randomUUID()}`;
      session = this.post('/sessions', { id, project, directory, ownership_mode: 'project_owned' }).then(({ value }) =>
        isRecord(value) && typeof value.id === 'string' && value.id ? value.id : id,
      );
      this.writeSessions.set(project, session);
      session.catch(() => {
        if (this.writeSessions.get(project) === session) this.writeSessions.delete(project);
      });
    }
    return session;
  }

  /**
   * Saves one observation with `topicKey` (Engram upserts by it) in `project`, scope
   * project. Registers a write session first; when Engram answers that it no longer knows
   * that session (404), registers a new one and retries once. Rejects with
   * EngramUnavailableError (status set when Engram answered), never with the content.
   */
  async saveObservation(input: ObservationInput): Promise<{ id: number | string | null }> {
    checkObservation(input);
    const save = async () => {
      const sessionId = await this.writeSession(input.project, input.directory);
      return this.post('/observations', {
        session_id: sessionId,
        title: input.title,
        content: input.content,
        type: input.type,
        project: input.project,
        scope: 'project',
        topic_key: input.topicKey,
      });
    };
    let answer: { value: unknown };
    try {
      answer = await save();
    } catch (error) {
      if (!(error instanceof EngramUnavailableError) || error.status !== 404) throw error;
      this.writeSessions.delete(input.project);
      answer = await save();
    }
    const id = isRecord(answer.value) && (typeof answer.value.id === 'number' || typeof answer.value.id === 'string') ? answer.value.id : null;
    return { id };
  }
}
