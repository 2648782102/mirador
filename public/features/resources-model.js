// Pure rules behind the resource figures (public/features/resources.js): byte and CPU
// formatting, the low-memory threshold, an agent's usage and the heaviest-first order.
// The input is GET /api/resources (src/http/routes/resources.ts). No DOM and no core.js:
// the browser and the tests import it.

/** Below this share of RAM available the strip warns: the system starts swapping hard and systemd-oomd kills agents. */
export const LOW_MEMORY_SHARE = 0.15;

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const number = (value, language, digits) => new Intl.NumberFormat(language, { maximumFractionDigits: digits, useGrouping: false }).format(value);

/** "851 MB" under 1 GB, "7,4 GB" (one decimal) under 100 GB, "123 GB" above; null for an unknown figure. */
export function formatBytes(bytes, language) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < GB) return `${number(Math.round(bytes / MB), language, 0)} MB`;
  const gb = bytes / GB;
  return `${number(gb, language, gb < 100 ? 1 : 0)} GB`;
}

/** CPU % without the sign (the copy carries it): one decimal under 10, whole from 10 on. */
export function formatCpu(percent, language) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return number(percent, language, percent < 10 ? 1 : 0);
}

/**
 * The strip's memory line from `machine` ({ memTotal, memAvailable, swapTotal, swapFree }):
 * { total, available, swapUsed, swapTotal, low }, swapUsed null when swap is unknown;
 * null without the RAM figures.
 */
export function machineMemory(machine) {
  if (typeof machine?.memTotal !== 'number' || typeof machine?.memAvailable !== 'number' || machine.memTotal <= 0) return null;
  const swapKnown = typeof machine.swapTotal === 'number' && typeof machine.swapFree === 'number';
  return {
    total: machine.memTotal,
    available: machine.memAvailable,
    swapUsed: swapKnown ? Math.max(0, machine.swapTotal - machine.swapFree) : null,
    swapTotal: swapKnown ? machine.swapTotal : null,
    low: machine.memAvailable / machine.memTotal < LOW_MEMORY_SHARE,
  };
}

/** A terminal's entry of the snapshot as { memory, swap, total: RAM + swap, cpu }; null without a memory figure. */
export function usageOf(entry) {
  if (typeof entry?.memory !== 'number') return null;
  const swap = typeof entry.swap === 'number' ? entry.swap : null;
  return { memory: entry.memory, swap, total: entry.memory + (swap ?? 0), cpu: typeof entry.cpu === 'number' ? entry.cpu : null };
}

/** The agents of `terminals` (the snapshot's list) with a known usage, heaviest RAM + swap first (ties by id), at most `limit`. */
export function heaviestFirst(terminals, limit) {
  return (Array.isArray(terminals) ? terminals : [])
    .filter((entry) => entry.kind === 'agent')
    .map((entry) => ({ id: entry.id, ...usageOf(entry) }))
    .filter((entry) => typeof entry.total === 'number')
    .sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

/** The gentle-shells outside Mirador as { count, total: RAM + swap of all of them }; null when unknown. */
export function outsideTotal(outside) {
  if (typeof outside?.count !== 'number') return null;
  return { count: outside.count, total: (outside.memory ?? 0) + (outside.swap ?? 0) };
}
