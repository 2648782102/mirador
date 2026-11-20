import { ResourceSampler, emptySnapshot, limitsFor, readerPlatform, type Exec, type ResourceRoots, type ResourceSnapshot } from '../../system/resources.ts';
import type { RouteModule } from '../context.ts';
import { sendJson } from '../respond.ts';

/**
 * RAM and CPU of Mirador's terminals, the machine and the gentle-shells outside Mirador
 * (reader in src/system/resources.ts, shape in docs/resources.md).
 *
 * GET /api/resources → { at, sampleMs, cpuWindowMs, machine, server, terminals, outside }
 *   at: when the sample was taken (ISO); sampleMs: SAMPLE_MS; cpuWindowMs: the span the CPU figures cover (null on the first sample)
 *   machine: { memTotal, memAvailable, swapTotal, swapFree }; server: { rss, swap }
 *   terminals: [{ id, kind, source: 'scope' | 'tree' | null, memory, swap, peak, cpu }] in the registry's order
 *   outside: { count, memory, swap, processes: [{ pid, cwd, memory, swap }] heaviest first, truncated }
 *   Bytes everywhere, cpu in % of one core; an unreadable figure is null. Always 200.
 *   On macOS only, also limits: { available: false, reason: 'macos' }: no systemd scopes or cgroups,
 *   so the terminals run without memory limits and their own figures are null (limitsFor()).
 *
 * The sampler takes at most one sample per SAMPLE_MS: a poll inside that window reads the
 * last one, and while clients poll a timer keeps it fresh so the CPU % covers the last
 * SAMPLE_MS. IDLE_MS after the last poll the timer stops; nothing is read while nobody looks.
 */

export const SAMPLE_MS = 5000;
export const IDLE_MS = 30_000;

/** Runs `fn` every `ms` until the returned function is called. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const everyInterval: Schedule = (fn, ms) => {
  const timer = setInterval(fn, ms);
  // Sampling never keeps the process alive.
  timer.unref();
  return () => clearInterval(timer);
};

export interface ResourceRoutesOptions {
  roots?: ResourceRoots;
  uid?: number;
  serverPid?: number;
  now?: () => number;
  schedule?: Schedule;
  /** The reader's platform (readerPlatform: given, else linux with injected `roots`, else the host's); darwin reads sysctl and vm_stat and adds `limits`. */
  platform?: NodeJS.Platform;
  exec?: Exec;
}

export function createResourceRoutes(options: ResourceRoutesOptions = {}): RouteModule {
  return (ctx) => {
    const now = options.now ?? Date.now;
    const schedule = options.schedule ?? everyInterval;
    const platform = readerPlatform({ platform: options.platform, injected: options.roots !== undefined });
    const sampler = new ResourceSampler({ roots: options.roots, uid: options.uid, serverPid: options.serverPid, now, platform, exec: options.exec });
    const limits = limitsFor(platform);
    let latest: Promise<ResourceSnapshot> | null = null;
    let latestAt = 0;
    let sampling = false;
    let lastAsked = 0;
    let stop: (() => void) | null = null;

    const take = () => {
      if (sampling) return;
      sampling = true;
      latestAt = now();
      const at = latestAt;
      latest = Promise.resolve()
        .then(() => sampler.sample(ctx.terminals.list()))
        // The reader degrades each figure to null; this only covers a bug, never a 500.
        .catch((error) => {
          console.error('mirador: resource sample failed:', error);
          return emptySnapshot(at);
        })
        .finally(() => {
          sampling = false;
        });
    };
    const halt = () => {
      stop?.();
      stop = null;
    };
    const tick = () => (now() - lastAsked > IDLE_MS ? halt() : take());
    ctx.onShutdown(halt);

    return [
      {
        method: 'GET',
        path: '/api/resources',
        handler: async ({ res }) => {
          lastAsked = now();
          if (!latest || now() - latestAt >= SAMPLE_MS) take();
          stop ??= schedule(tick, SAMPLE_MS);
          const { at, ...sample } = await latest!;
          // `at` first, then sampleMs, then the rest of the sample in its own order.
          sendJson(res, 200, { at, sampleMs: SAMPLE_MS, ...sample, ...(limits ? { limits } : {}) });
        },
      },
    ];
  };
}

export const resourceRoutes: RouteModule = createResourceRoutes();
