// Pure rules behind opening gentle-shell in several folders (public/features/workspaces.js):
// the folders marked in each workspace, which of them already run an agent, and the report
// of POST /api/terminals/batch. No DOM and no core.js: the browser and the tests import it.

/** Marks (`checked` true) or unmarks folder `rel` of workspace `ws`; returns a new selection. */
export function markFolder(selection, ws, rel, checked) {
  const rels = new Set(selection[ws] ?? []);
  if (checked) rels.add(rel);
  else rels.delete(rel);
  return { ...selection, [ws]: [...rels].sort() };
}

/** The folders marked in workspace `ws`, in name order. */
export function marked(selection, ws) {
  return [...(selection[ws] ?? [])];
}

/** Unmarks every folder of workspace `ws`; returns a new selection. */
export function unmarkAll(selection, ws) {
  const { [ws]: _dropped, ...rest } = selection;
  return rest;
}

/** The folders of `rels` that already run an agent of workspace `ws` (GET /api/terminals entries). */
export function busyFolders(terminals, ws, rels) {
  const busy = new Set(terminals.filter((t) => t.kind === 'agent' && t.status === 'running' && t.workspaceId === ws).map((t) => t.rel));
  return rels.filter((rel) => busy.has(rel));
}

/** The batch results as the terminals to show and the folders skipped, each with its reason (queued ones are not skipped). */
export function summarizeBatch(results) {
  return {
    opened: results.filter((r) => r.status === 'opened').map((r) => r.terminal),
    skipped: results.filter((r) => r.status !== 'opened' && r.status !== 'queued').map((r) => ({ rel: r.rel, reason: r.status, error: r.error ?? null })),
  };
}

/** How often the window asks a batch that goes on in the server (answered with a batchId) what it did since. */
export const FOLLOW_MS = 5000;

/** The folders a batch answer left queued: the server opens them once the launch gate lets it. */
export function queuedFolders(results) {
  return results.filter((r) => r.status === 'queued').map((r) => r.rel);
}

/**
 * What became of the folders that were `queued` (GET /api/terminals/batch/:id results): the
 * terminals opened that `shown` (a Set of ids) does not hold yet, and the folders that will not
 * open, each with its status and error.
 */
export function batchProgress(results, queued, shown) {
  const later = results.filter((r) => queued.includes(r.rel));
  return {
    fresh: later.filter((r) => r.status === 'opened' && !shown.has(r.terminal.id)).map((r) => r.terminal),
    opened: later.filter((r) => r.status === 'opened' || r.status === 'sent').length,
    notOpened: later.filter((r) => r.status !== 'opened' && r.status !== 'sent' && r.status !== 'queued').map((r) => ({ rel: r.rel, status: r.status, error: r.error ?? null })),
  };
}
