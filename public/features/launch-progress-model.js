// Pure rules of the loading bar: what it says for a
// GET /api/terminals/launches answer (src/system/memory-gate.ts status()), which actions wait while
// agents open, and when a finished run still shows its result. No DOM and no imports: the browser
// (public/features/launch-progress.js) and test/launch-progress-model.test.ts use it.

/** How often the bar reads the launches while a run is active. */
export const POLL_MS = 2000;

/**
 * What waits while agents open, because each starts one more pi: opening gentle-shell by hand,
 * "Abrir N", "Delegar a Mirador", "Traer a Mirador" and the Claude calls (autopilot, judge,
 * translations; the server holds those). bash, the open agents, Seguimiento and the summary stay free.
 */
export const BLOCKED_ACTIONS = Object.freeze(['agent', 'batch', 'delegate', 'adopt', 'model']);

export function blockedActions(status) {
  return status?.active ? [...BLOCKED_ACTIONS] : [];
}

const sum = (runs, pick) => runs.reduce((total, run) => total + (Number(pick(run)) || 0), 0);
const known = (runs) => runs.every((run) => Array.isArray(run.notOpened));

/** The wait the bar names: a memory wait first (it holds every run), else a batch settling. */
function currentWait(running, now) {
  const memory = running.find((run) => run.wait?.reason === 'memory')?.wait;
  if (memory) return { reason: 'memory', missingBytes: memory.missingBytes, memAvailable: memory.memAvailable };
  const settle = running.find((run) => run.wait?.reason === 'settle' && run.wait.until)?.wait;
  if (settle) return { reason: 'settle', seconds: Math.max(0, Math.ceil((Date.parse(settle.until) - now) / 1000)) };
  return null;
}

/** The agents the restore runs among `runs` left asleep (lazy restore). */
const sleepers = (runs) => sum(runs.filter((run) => run.kind === 'restore'), (run) => run.sleeping);

/**
 * Where the `count` agents left asleep are and whether each keeps its session, from the sleeping
 * list (GET /api/terminals/sleeping): { workspaceId, resumable }, workspaceId null when they sleep
 * in more than one workspace. Null unless the list holds exactly `count` agents, so the place and
 * the session never describe others (one woken since, or agents asleep from before).
 */
function asleepDetail(count, agents) {
  if (!count || !Array.isArray(agents) || agents.length !== count) return null;
  const workspaces = new Set(agents.map((agent) => agent.workspaceId));
  const detail = { workspaceId: workspaces.size === 1 ? [...workspaces][0] : null, resumable: agents.every((agent) => agent.resumable === true) };
  return detail.workspaceId === null && !detail.resumable ? null : detail;
}

/**
 * The bar for `status`, or null when it shows nothing.
 * - Running runs add up: { phase: 'running', restore, wake, done, total, sleeping, asleep, wait, memAvailable, runIds };
 *   `wake` when every run wakes sleeping agents, `sleeping` the agents a restore left asleep (not in total)
 *   and `asleep` where they are, from `sleepingAgents` (asleepDetail).
 *   `memAvailable` is the memory wait's reading, else the one given (the resources poller's).
 * - Once none runs, the ended runs not `dismissed` that this window `seen` running, or that left
 *   folders unopened (seen or not, so a reload still tells): { phase: 'done', opened, failed,
 *   lowMemory, paused, sleeping, asleep, runIds }, lowMemory and paused as { count, folders } (folders
 *   null when the server did not name them).
 */
export function launchBar(status, { now = Date.now(), memAvailable = null, seen = new Set(), dismissed = new Set(), sleepingAgents = [] } = {}) {
  const runs = Array.isArray(status?.runs) ? status.runs : [];
  const running = runs.filter((run) => run.state === 'running');
  if (running.length) {
    const wait = currentWait(running, now);
    const sleeping = sleepers(running);
    return {
      phase: 'running',
      restore: running.some((run) => run.kind === 'restore'),
      wake: running.every((run) => run.kind === 'wake'),
      done: sum(running, (run) => run.total - run.queued),
      total: sum(running, (run) => run.total),
      sleeping,
      asleep: asleepDetail(sleeping, sleepingAgents),
      wait,
      memAvailable: wait?.reason === 'memory' ? wait.memAvailable : memAvailable,
      runIds: running.map((run) => run.id),
    };
  }
  const ended = runs.filter((run) => run.state === 'done' && !dismissed.has(run.id) && (seen.has(run.id) || run.lowMemory > 0 || run.cancelled > 0));
  if (!ended.length) return null;
  const left = (field) => {
    const short = ended.filter((run) => run[field] > 0);
    return { count: sum(short, (run) => run[field]), folders: known(short) ? short.flatMap((run) => run.notOpened) : null };
  };
  const sleeping = sleepers(ended);
  return { phase: 'done', opened: sum(ended, (run) => run.opened), failed: sum(ended, (run) => run.failed), lowMemory: left('lowMemory'), paused: left('cancelled'), sleeping, asleep: asleepDetail(sleeping, sleepingAgents), runIds: ended.map((run) => run.id) };
}

/**
 * The bar's text in the UI language: `t` translates, `bytes` formats a size, `nameOf` names a
 * folder ({ workspaceId, rel }). Parts are joined with " · ".
 */
export function barText(bar, { t, bytes, nameOf }) {
  if (!bar) return '';
  if (bar.phase === 'running') {
    const parts = [t(runLabel(bar), { done: bar.done, total: bar.total })];
    if (bar.sleeping) parts.push(asleep(bar, { t, nameOf }));
    if (bar.wait?.reason === 'settle') parts.push(t('launch.nextBatch', { seconds: bar.wait.seconds }));
    if (bar.wait?.reason === 'memory') parts.push(t('launch.waitMemory', { missing: bytes(bar.wait.missingBytes) }));
    if (typeof bar.memAvailable === 'number') parts.push(t('launch.free', { free: bytes(bar.memAvailable) }));
    return parts.join(' · ');
  }
  const list = (folders) => folders.map(nameOf).join(', ');
  const parts = [bar.opened ? t(bar.opened === 1 ? 'launch.done.one' : 'launch.done.other', { count: bar.opened }) : t('launch.done.none')];
  if (bar.lowMemory.count) parts.push(bar.lowMemory.folders ? t('launch.lowMemory', { list: list(bar.lowMemory.folders) }) : t('launch.lowMemoryCount', { count: bar.lowMemory.count }));
  if (bar.paused.count) parts.push(bar.paused.folders ? t('launch.paused', { list: list(bar.paused.folders) }) : t('launch.pausedCount', { count: bar.paused.count }));
  if (bar.failed) parts.push(t(bar.failed === 1 ? 'launch.failed.one' : 'launch.failed.other', { count: bar.failed }));
  if (bar.sleeping) parts.push(asleep(bar, { t, nameOf }));
  return parts.join(' · ');
}

/** The key of a running bar's first words: restoring, waking sleeping agents, or opening. */
export function runLabel(bar) {
  return bar.restore ? 'launch.restoring' : bar.wake ? 'launch.waking' : 'launch.opening';
}

/** "2 dormidos", plus "en Dev" and ", con su sesión guardada" when the sleeping list tells (asleepDetail). */
function asleep({ sleeping: count, asleep: detail }, { t, nameOf }) {
  const one = count === 1;
  let text = detail?.workspaceId == null
    ? t(one ? 'launch.sleeping.one' : 'launch.sleeping.other', { count })
    : t(one ? 'launch.sleepingIn.one' : 'launch.sleepingIn.other', { count, name: nameOf({ workspaceId: detail.workspaceId, rel: '' }) });
  if (detail?.resumable) text = t(one ? 'launch.sleepingSaved.one' : 'launch.sleepingSaved.other', { sleeping: text });
  return text;
}
