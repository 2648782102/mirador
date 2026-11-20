import { readFile, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from './config.ts';
import { engramCacheMsFrom } from './memory/engram.ts';

/**
 * Resource profiles: Ahorro, Equilibrado
 * (default) and Potencia change how much Mirador spends and how fast it refreshes, never what
 * it may do. They set the nightly Claude call budget, the "Mejorar con IA" runs per day, the night
 * decider's model, whether the judge reviews every move or only doubtful ones, the Claude
 * processes at once, the Engram window cache and the tracking refresh. The policy, the
 * sensitive filters, MIN_CONFIDENCE and the per-terminal caps are the same in every profile:
 * no profile has a knob for them.
 *
 * The choice lives in `<stateDir>/profile.json` (0600), so the UI changes it at runtime
 * without touching config.json. The config keys `nightModel`, `maxConcurrent`,
 * `engramCacheMs` and `nightBudget` still win over the profile (and MIRADOR_ENGRAM_CACHE_MS
 * over everything), and are reported as overridden. Any other key, such as `translateBudget` or
 * `translateModel` from before translation moved to the browser,
 * is ignored.
 */

export const PROFILE_NAMES = ['ahorro', 'equilibrado', 'potencia'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
export type JudgeMode = 'every' | 'doubtful-only';

export interface ProfileValues {
  /** Decider, follow-up and judge calls per night. */
  nightBudget: number;
  /** "Mejorar con IA" runs per day (feature `propose`). */
  improveBudget: number;
  /** The night decider's (and judge's) Claude model. */
  nightModel: string;
  /** `doubtful-only`: the judge reviews decisions below JUDGE_DOUBT_BELOW confidence and follow-ups only. */
  judgeMode: JudgeMode;
  /** Claude processes at once (the process-wide gate). */
  maxConcurrent: number;
  /** How long one all-projects Engram read is shared. */
  engramCacheMs: number;
  /** The tracking view's refresh interval (read by the browser). */
  trackingRefreshMs: number;
}

export const DEFAULT_PROFILE: ProfileName = 'equilibrado';
/** In `doubtful-only` mode, decisions at or above this confidence are not reviewed. */
export const JUDGE_DOUBT_BELOW = 0.85;

const freeze = (values: ProfileValues): Readonly<ProfileValues> => Object.freeze(values);

export const PROFILES: Readonly<Record<ProfileName, Readonly<ProfileValues>>> = Object.freeze({
  ahorro: freeze({ nightBudget: 60, improveBudget: 100, nightModel: 'claude-haiku-5-5', judgeMode: 'doubtful-only', maxConcurrent: 1, engramCacheMs: 60_000, trackingRefreshMs: 30_000 }),
  equilibrado: freeze({ nightBudget: 150, improveBudget: 300, nightModel: 'claude-sonnet-5-5', judgeMode: 'every', maxConcurrent: 2, engramCacheMs: 20_000, trackingRefreshMs: 15_000 }),
  potencia: freeze({ nightBudget: 400, improveBudget: 1000, nightModel: 'claude-opus-5-5', judgeMode: 'every', maxConcurrent: 4, engramCacheMs: 10_000, trackingRefreshMs: 10_000 }),
});

/** Config keys that win over the profile, in the order they are reported. */
export type ProfileOverrides = { nightModel?: unknown; maxConcurrent?: unknown; engramCacheMs?: unknown; nightBudget?: unknown };

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === 'string' && (PROFILE_NAMES as readonly string[]).includes(value);
}

const isInt = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const isModel = (value: unknown): value is string => typeof value === 'string' && /^claude-[a-z0-9.-]{1,60}$/.test(value);

/** The profile's values with valid config overrides applied, and which keys they replaced. */
export function effectiveValues(profile: ProfileName, overrides: ProfileOverrides = {}, env: Record<string, string | undefined> = process.env): { values: ProfileValues; overridden: string[] } {
  const values: ProfileValues = { ...PROFILES[profile] };
  const overridden: string[] = [];
  if (isModel(overrides.nightModel)) {
    values.nightModel = overrides.nightModel;
    overridden.push('nightModel');
  }
  if (isInt(overrides.maxConcurrent, 1, 64)) {
    values.maxConcurrent = overrides.maxConcurrent;
    overridden.push('maxConcurrent');
  }
  const configuredTtl = typeof overrides.engramCacheMs === 'number' && Number.isFinite(overrides.engramCacheMs) && overrides.engramCacheMs >= 0;
  const ttl = engramCacheMsFrom(env, configuredTtl ? overrides.engramCacheMs : values.engramCacheMs);
  const fromEnv = env.MIRADOR_ENGRAM_CACHE_MS === undefined || env.MIRADOR_ENGRAM_CACHE_MS === '' ? NaN : Number(env.MIRADOR_ENGRAM_CACHE_MS);
  const envTtl = Number.isFinite(fromEnv) && fromEnv >= 0;
  if (configuredTtl || envTtl) {
    values.engramCacheMs = ttl;
    overridden.push('engramCacheMs');
  }
  if (isInt(overrides.nightBudget, 0, 100_000)) {
    values.nightBudget = overrides.nightBudget;
    overridden.push('nightBudget');
  }
  return { values, overridden };
}

export function profilePath(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env as NodeJS.ProcessEnv), 'profile.json');
}

/** A refused profile change, with the API's stable code. */
export class ProfileError extends Error {
  readonly code = 'profile_invalid';
}

export interface ProfileView {
  profile: ProfileName;
  values: ProfileValues;
  overridden: string[];
  profiles: typeof PROFILES;
}

export interface ResourceProfilesOptions {
  file?: string;
  profile?: ProfileName;
  overrides?: ProfileOverrides;
  env?: Record<string, string | undefined>;
}

/** The chosen profile of one Mirador, its effective values and who listens for changes. */
export class ResourceProfiles {
  readonly file: string;
  private current: ProfileName;
  private readonly overrides: ProfileOverrides;
  private readonly env: Record<string, string | undefined>;
  private effective: { values: ProfileValues; overridden: string[] };
  private readonly listeners = new Set<(values: ProfileValues, profile: ProfileName) => void>();
  private writes: Promise<void> = Promise.resolve();

  constructor(options: ResourceProfilesOptions = {}) {
    this.file = options.file ?? profilePath();
    this.current = options.profile ?? DEFAULT_PROFILE;
    this.overrides = options.overrides ?? {};
    this.env = options.env ?? process.env;
    this.effective = effectiveValues(this.current, this.overrides, this.env);
  }

  /** The stored profile; a missing or invalid file means the default. */
  static async load(options: Omit<ResourceProfilesOptions, 'profile'> = {}): Promise<ResourceProfiles> {
    const file = options.file ?? profilePath();
    let profile: ProfileName = DEFAULT_PROFILE;
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { profile?: unknown };
      if (isProfileName(saved?.profile)) profile = saved.profile;
      else console.error('mirador: profile.json names no known profile; using equilibrado');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('mirador: could not read profile.json; using equilibrado');
    }
    return new ResourceProfiles({ ...options, file, profile });
  }

  get profile(): ProfileName {
    return this.current;
  }

  /** The effective values (a copy). */
  values(): ProfileValues {
    return { ...this.effective.values };
  }

  view(): ProfileView {
    return { profile: this.current, values: this.values(), overridden: [...this.effective.overridden], profiles: PROFILES };
  }

  /** Stores and applies `profile`; listeners run before it resolves. ProfileError for an unknown name. */
  async set(profile: unknown): Promise<ProfileView> {
    if (!isProfileName(profile)) throw new ProfileError(`profile must be one of ${PROFILE_NAMES.join(', ')}`);
    await this.save(profile);
    this.current = profile;
    this.effective = effectiveValues(profile, this.overrides, this.env);
    const values = this.values();
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...values }, profile);
      } catch (error) {
        console.error('mirador: profile listener failed:', error);
      }
    }
    return this.view();
  }

  /** Called after every change with the new effective values. Returns the unsubscribe function. */
  onChange(listener: (values: ProfileValues, profile: ProfileName) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Writes `{ profile }` (temp file and rename, 0600), one write at a time. */
  private save(profile: ProfileName): Promise<void> {
    const run = this.writes.then(async () => {
      const dir = dirname(this.file);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify({ profile })}\n`, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, this.file);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}

/** The profiles of one app, for its route modules; keyed by an object of that app (its terminal registry). */
const profilesByApp = new WeakMap<object, ResourceProfiles>();

export function provideProfiles(app: object, profiles: ResourceProfiles): void {
  profilesByApp.set(app, profiles);
}

export function resourceProfiles(app: object): ResourceProfiles | null {
  return profilesByApp.get(app) ?? null;
}
