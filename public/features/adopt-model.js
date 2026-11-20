// Pure rules behind "Traer a Mirador" on an outside card (public/features/tracking.js):
// whether the project looks idle enough to adopt,
// and the instruction the delegate dialog opens with.
// No DOM and no core.js: the browser and the tests import it.
import { MAX_INSTRUCTION } from './delegate-model.js';

/** Minutes without a new memory before Mirador offers to bring a project in: before that, an agent may still be working there. */
export const ADOPT_IDLE_MINUTES = 30;

/** Engram stores UTC times as "YYYY-MM-DD HH:MM:SS[.fraction]" without a zone. */
const engramMs = (value) => {
  const [day, time = '00:00:00'] = String(value ?? '').split(/[ T]/);
  return Date.parse(`${day}T${time.replace(/Z$/, '')}Z`);
};

/**
 * How long ago `lastAt` (an Engram time) was at `now` (ms): `recent` while under
 * ADOPT_IDLE_MINUTES, and the whole minutes to show (at least 1).
 */
export function adoptActivity(lastAt, now) {
  const elapsed = now - engramMs(lastAt);
  if (!Number.isFinite(elapsed)) return { recent: false, minutes: null };
  return { recent: elapsed < ADOPT_IDLE_MINUTES * 60_000, minutes: Math.max(1, Math.floor(elapsed / 60_000)) };
}

/**
 * The instruction the dialog opens with: `lead`, a blank line and the Next Steps, clipped with
 * "…" to fit MAX_INSTRUCTION; empty without Next Steps, so the user writes their own.
 */
export function adoptInstruction(nextSteps, lead) {
  const steps = String(nextSteps ?? '').trim();
  if (!steps) return '';
  const head = `${String(lead ?? '').trim()}\n\n`;
  const room = MAX_INSTRUCTION - head.length;
  return head + (steps.length > room ? `${steps.slice(0, room - 1).trimEnd()}…` : steps);
}
