// Verifier harness: fake bridge link, fake attention states, fake meminfo, real NoteStore and TerminalRegistry over fake ptys.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightService, type NightLink } from '../../src/night/service.ts';
import { NoteStore } from '../../src/night/notes.ts';
import { reserveFor } from '../../src/system/memory-gate.ts';
import type { FinishedTurn } from '../../src/night/channel.ts';
import type { NightRecord } from '../../src/night/log.ts';
import type { Decider, MiradorLine, NightContext } from '../../src/night/protocol.ts';
import type { AttentionItem } from '../../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../../src/terminals/registry.ts';

export type State = 'working' | 'waiting' | 'finished' | 'unknown';
class FakePty implements PtyProcess { onData() {} onExit() {} write() {} resize() {} kill() {} }
export const GIB = 1024 ** 3;
export const DELAY = 30;
const ASK = 'N4 is done.\n¿Avanzamos con A (recomendado) o B?';
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('timed out'); await sleep(5); }
}

export function fakeLink(hooks: { onSend?: (id: string, line: MiradorLine) => void } = {}) {
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const finals = new Map<string, FinishedTurn>();
  const listeners = new Set<(id: string, turn: FinishedTurn) => void>();
  const link: NightLink & { sent: typeof sent; connected: typeof connected; finish(id: string, turnId: string): void } = {
    sent, connected,
    send: (id, line) => { if (!connected.has(id)) return false; sent.push([id, line]); hooks.onSend?.(id, line); return true; },
    isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected],
    lastFinished: (id) => finals.get(id) ?? null,
    onFinished: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    finish(id, turnId) { const turn = { turnId, text: ASK, time: Date.now() }; finals.set(id, turn); for (const l of listeners) l(id, turn); },
  };
  return link;
}

export function fakeAttention() {
  const states = new Map<string, State>();
  const listeners = new Set<(id: string, state: State) => void>();
  const item = (terminalId: string, kind: AttentionItem['kind']): AttentionItem => ({ terminalId, workspaceId: 'dev', rel: terminalId, title: terminalId, kind, label: kind === 'finished' ? 'Finished' : 'Choose', detail: null, since: new Date().toISOString(), activity: null });
  return {
    view: {
      items: () => [...states].flatMap(([id, state]) => (state === 'finished' ? [item(id, 'finished')] : state === 'waiting' ? [item(id, 'blocked')] : [])),
      agentState: (id: string) => states.get(id) ?? 'unknown',
      onAgentState: (listener: (id: string, state: State) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    get: (id: string) => states.get(id),
    set(id: string, state: State) { states.set(id, state); for (const l of listeners) l(id, state); },
  };
}

export interface Setup { slots?: number; claimMs?: number; deliveryTimeoutMs?: number; base?: string; onSend?: (id: string, line: MiradorLine) => void; noQueue?: boolean; ownerName?: () => unknown }

export async function setup(options: Setup = {}) {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'verify-night-queue-')));
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const link = fakeLink({ onSend: options.onSend });
  const attention = fakeAttention();
  const store = new NoteStore(join(base, 'night'));
  const records: NightRecord[] = [];
  const followUps: NightContext[] = [];
  const decisions: NightContext[] = [];
  const decider: Decider = {
    decide: async (_q, context) => { decisions.push(context); return { action: 'defer', reason: 'not used' }; },
    followUp: async (context) => { followUps.push(context); return { action: 'follow-up', message: 'Proceed with option A, as you recommended.', reason: 'A is recommended.', confidence: 0.9 }; },
  };
  const limits = { slots: options.slots ?? 2 };
  const memory = { memTotal: 24 * GIB as number | null, memAvailable: 12 * GIB as number | null };
  let memReads = 0;
  const service = new NightService({
    link, decider,
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift.' } : undefined) },
    attention: () => attention.view,
    notes: store,
    decideBudgetMs: 2000,
    deliveryTimeoutMs: options.deliveryTimeoutMs ?? 30,
    autoDelayMs: DELAY,
    sweepIntervalMs: 5,
    ...(options.ownerName ? { ownerName: options.ownerName } : {}),
    ...(options.noQueue ? {} : { queue: {
      limit: () => ({ slots: limits.slots, suggested: 5, custom: true, memTotal: memory.memTotal }),
      readMemory: async () => { memReads++; return { ...memory }; },
      reserve: (memTotal: number | null) => reserveFor({ reserveBytes: null }, memTotal),
      pollMs: 20,
      claimMs: options.claimMs ?? 5000,
    } }),
  } as any);
  const agent = (rel: string, state: State, connected = true) => {
    const info = terminals.create({ cwd: `/dev/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel });
    if (connected) link.connected.add(info.id);
    attention.set(info.id, state);
    return info.id;
  };
  const note = (terminalId: string | undefined, text: string) => store.add({ workspaceId: 'dev', ...(terminalId ? { terminalId } : {}), text });
  const received = (id: string) => link.sent.filter(([to, line]) => to === id && line.type === 'message').map(([, line]) => (line.type === 'message' ? line.text : ''));
  const queue = () => (service.status() as any).queue;
  const items = () => queue()?.items.map((i: any) => [i.terminalId, i.kind]);
  const notesHash = async () => createHash('sha256').update(await readFile(join(base, 'night', 'notes.json')).catch(() => Buffer.from(''))).digest('hex');
  const cleanup = async (keep = false) => {
    service.close();
    await service.noteDelivery; await sleep(20); await service.noteDelivery;
    if (!keep) await rm(base, { recursive: true, force: true });
  };
  const memReadsSoFar = () => memReads;
  return { base, service, link, attention, store, records, followUps, decisions, terminals, limits, memory, agent, note, received, queue, items, notesHash, cleanup, memReadsSoFar };
}

/** Normalized trace for differential comparison. */
export function trace(s: Awaited<ReturnType<typeof setup>>, names: Map<string, string>) {
  const n = (id: string | null | undefined) => (id ? names.get(id) ?? id : id);
  return {
    records: s.records.map((r: any) => ({ kind: r.kind, terminalId: n(r.terminalId), rel: r.rel, outcome: r.outcome, sent: r.sent, delivered: r.delivered, policy: r.policy, deferral: r.deferral, sweep: r.sweep ?? null, note: r.note?.text ?? null, followUp: r.followUp?.message ?? null })),
    sent: s.link.sent.map(([to, line]: any) => [n(to), line.type, line.text ?? null]),
    followUps: s.followUps.map((c) => [c.rel, c.lastMessage ?? null, c.task ?? null]),
  };
}
