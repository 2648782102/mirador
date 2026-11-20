import { InvalidFolderError } from '../folders/tree.ts';
import { RESTORE_DELAY_MS, sleep, type RestoreFolder } from './open-agents.ts';
import type { LaunchGate } from '../system/memory-gate.ts';
import type { TerminalInfo, TerminalRegistry } from './registry.ts';

/**
 * Opening gentle-shell in several folders of one workspace.
 * Every folder is resolved before any agent opens: with `missing: 'reject'` one that does not
 * resolve inside the workspace rejects the whole batch; with `missing: 'skip'` (a saved project
 * set, whose folders may have gone since) it is reported as missing. The agents then open one
 * after another, RESTORE_DELAY_MS apart like the startup restore, through registry.create, so
 * night variables, bridge args, scopes and open-agent records apply as for a single one.
 * A folder that already runs an agent of that workspace is skipped unless `reopen` is set;
 * that check runs right before each folder opens, so two batches at once never double one.
 *
 * Delegating an instruction (`delegation`): `ready()` runs
 * once every folder resolved, before anything opens or is sent; a new agent opens with
 * `firstMessageArgs` (the instruction as its first message) and is reported to `opened()`;
 * a folder whose agent is already open gets the instruction through `sendToOpen()` instead of
 * a second agent (`reopen` does not apply), reported `sent` once delivered, else `failed`.
 *
 * With a launch gate (src/system/memory-gate.ts) each new agent waits for its turn: batches
 * that settle, and enough available memory. The first time the batch has to wait, `onWait()`
 * gets the results so far with every folder still to do as `queued`; `onProgress()` gets the
 * same snapshot after each folder. When the gate gives up on memory, the folders left that need
 * a new agent are reported `low_memory` (an open agent still gets a delegated instruction); when
 * the server shuts down or `signal` aborts, every folder left is reported `cancelled`.
 */

export type BatchResult =
  | { rel: string; status: 'opened'; terminal: TerminalInfo }
  | { rel: string; status: 'already_open'; terminalId: string }
  | { rel: string; status: 'sent'; terminalId: string }
  | { rel: string; status: 'missing' }
  | { rel: string; status: 'failed'; error: string }
  | { rel: string; status: 'queued' }
  | { rel: string; status: 'low_memory' }
  | { rel: string; status: 'cancelled' };

/** Longest instruction the user can delegate (characters, after trimming). */
export const MAX_INSTRUCTION_CHARS = 2000;

export interface BatchDelegation {
  /** Agent args that make the instruction a new agent's first message; null when the agent command cannot take one. */
  firstMessageArgs: string[] | null;
  /** Gives the instruction to the agent already open in a folder: null once delivered, else why not. */
  sendToOpen(terminalId: string): Promise<string | null>;
  /** A new agent opened with the instruction. */
  opened(terminalId: string): void;
  /** Every folder resolved; nothing opened or sent yet. */
  ready(): void;
}

export interface BatchOptions {
  workspaceId: string;
  rels: string[];
  missing: 'reject' | 'skip';
  reopen: boolean;
  cols: number;
  rows: number;
  registry: Pick<TerminalRegistry, 'create' | 'list'>;
  resolveFolder(workspaceId: string, rel: string): Promise<RestoreFolder>;
  delegation?: BatchDelegation;
  delayMs?: number;
  sleep?(ms: number): Promise<void>;
  /** The server's launch gate; without one, agents open RESTORE_DELAY_MS apart as before. */
  gate?: LaunchGate;
  /** The id of the batch's launch run in the gate (gate.status(), gate.cancel()); made up when absent. */
  runId?: string;
  signal?: AbortSignal;
  onWait?(snapshot: BatchResult[]): void;
  onProgress?(snapshot: BatchResult[]): void;
}

export async function openAgentBatch(options: BatchOptions): Promise<BatchResult[]> {
  const delayMs = options.delayMs ?? RESTORE_DELAY_MS;
  const pause = options.sleep ?? sleep;
  const { delegation } = options;
  const plan: Array<{ rel: string; folder: RestoreFolder | null }> = [];
  for (const rel of options.rels) {
    let folder: RestoreFolder | null;
    try {
      folder = await options.resolveFolder(options.workspaceId, rel);
    } catch (error) {
      if (options.missing === 'reject' || !(error instanceof InvalidFolderError)) throw error;
      folder = null;
    }
    const key = folder ? folder.rel : rel;
    if (!plan.some((entry) => (entry.folder ? entry.folder.rel : entry.rel) === key)) plan.push({ rel: key, folder });
  }
  delegation?.ready();

  const results: BatchResult[] = [];
  const snapshot = (): BatchResult[] => [
    ...results,
    ...plan.slice(results.length).map(({ rel, folder }): BatchResult => (folder ? { rel, status: 'queued' } : { rel, status: 'missing' })),
  ];
  let waitHeard = false;
  const run = options.gate?.run({
    id: options.runId,
    kind: 'batch',
    workspaceId: options.workspaceId,
    total: plan.filter((entry) => entry.folder).length,
    signal: options.signal,
    onWait: () => {
      if (waitHeard) return;
      waitHeard = true;
      options.onWait?.(snapshot());
    },
  });
  // Set once the gate gave up on memory or the batch was cancelled: no agent opens after it.
  let stopped: 'low_memory' | 'cancelled' | null = null;
  let opened = 0;
  try {
    for (const { rel, folder } of plan) {
      if (results.length) options.onProgress?.(snapshot());
      if (stopped === 'cancelled' || options.signal?.aborted) {
        results.push({ rel, status: 'cancelled' });
        continue;
      }
      if (!folder) {
        results.push({ rel, status: 'missing' });
        continue;
      }
      const running = options.registry
        .list()
        .find((info) => info.kind === 'agent' && info.status === 'running' && info.workspaceId === folder.workspace.id && info.rel === folder.rel);
      if (running && delegation) {
        const problem = await delegation.sendToOpen(running.id);
        results.push(problem === null ? { rel, status: 'sent', terminalId: running.id } : { rel, status: 'failed', error: problem });
        run?.skip();
        continue;
      }
      if (running && !options.reopen) {
        results.push({ rel, status: 'already_open', terminalId: running.id });
        run?.skip();
        continue;
      }
      if (delegation && !delegation.firstMessageArgs) {
        results.push({ rel, status: 'failed', error: 'the agent command cannot take a first message' });
        run?.skip();
        continue;
      }
      if (stopped) {
        results.push({ rel, status: stopped });
        continue;
      }
      if (opened > 0) await pause(delayMs);
      const outcome = run ? await run.next() : options.signal?.aborted ? 'cancelled' : 'go';
      if (outcome !== 'go') {
        stopped = outcome;
        results.push({ rel, status: outcome });
        continue;
      }
      try {
        const terminal = options.registry.create({
          cwd: folder.path,
          kind: 'agent',
          cols: options.cols,
          rows: options.rows,
          workspaceId: folder.workspace.id,
          rel: folder.rel,
          ...(delegation ? { agentArgs: delegation.firstMessageArgs! } : {}),
        });
        delegation?.opened(terminal.id);
        results.push({ rel, status: 'opened', terminal });
        opened++;
      } catch (error) {
        results.push({ rel, status: 'failed', error: (error as Error).message });
        run?.fail();
      }
    }
  } finally {
    run?.end();
  }
  return results;
}
