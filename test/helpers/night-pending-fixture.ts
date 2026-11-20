import { NightService, type NightLink } from '../../src/night/service.ts';
import type { FinishedTurn } from '../../src/night/channel.ts';
import type { NightRecord } from '../../src/night/log.ts';
import type { Decider, MiradorLine, NightContext, NightFollowUp, NightQuestion } from '../../src/night/protocol.ts';
import type { AttentionItem } from '../../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../../src/terminals/registry.ts';
class FakePty implements PtyProcess { onData() {} onExit() {} write() {} resize() {} kill() {} }
export const DELAY = 30;
export const ASK = 'N4 is done.\n¿Avanzamos con A (recomendado) o B?';
export const DEFER = async (): Promise<NightFollowUp> => ({ action: 'defer', reason: 'The mission does not cover B.' });
function fakeLink() {
  const sent: Array<[string, MiradorLine]> = []; const connected = new Set<string>(); const finals = new Map<string, FinishedTurn>();
  const listeners = new Set<(id: string, turn: FinishedTurn) => void>();
  const link: NightLink & { connected: typeof connected; finish(id: string, turnId: string, text?: string): void } = {
    connected, send: (id, line) => (connected.has(id) ? (sent.push([id, line]), true) : false), isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected], lastFinished: (id) => finals.get(id) ?? null,
    onFinished: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    finish(id, turnId, text = ASK) { const turn = { turnId, text, time: Date.now() }; finals.set(id, turn); for (const l of listeners) l(id, turn); },
  };
  return link;
}
export function setup(extra: Record<string, unknown> = {}) {
  const terminals = new TerminalRegistry((() => new FakePty()) as SpawnFn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const link = fakeLink(); const records: NightRecord[] = []; const contexts: NightContext[] = [];
  const box: { followUp: (c: NightContext, signal?: AbortSignal) => Promise<NightFollowUp> } = { followUp: DEFER };
  const decider: Decider = { decide: async () => ({ action: 'defer', reason: 'not used' }), followUp: (c, s) => { contexts.push(c); return box.followUp(c, s); } };
  let items: AttentionItem[] = [];
  const service = new NightService({
    link, decider, log: { append: async (record) => void records.push(record) }, terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift.' } : undefined) },
    attention: () => ({ items: () => items }), decideBudgetMs: 2000, deliveryTimeoutMs: 50, autoDelayMs: DELAY, ...extra,
  } as any);
  const agent = (rel: string) => { const info = terminals.create({ cwd: `/dev/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel }); link.connected.add(info.id); return info.id; };
  const finish = (id: string, turnId: string, text = ASK) => {
    items = [...items.filter((i) => i.terminalId !== id), { terminalId: id, workspaceId: 'dev', rel: 'alpha', title: 'alpha', kind: 'finished', label: 'Finished', detail: null, since: new Date().toISOString(), activity: null }];
    link.finish(id, turnId, text);
  };
  const ask = (id: string, text: string, call = 'call-1') => service.question(id, 'r1', { terminalId: id, toolCallId: call, tool: 'ask_user_choice', allowCustomResponse: false,
    items: [{ question: text, header: '', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] } as NightQuestion);
  const pending = () => service.status().pending;
  const type = (id: string, text = 'go on\r') => terminals.write(id, text);
  return { service, link, records, contexts, terminals, agent, finish, ask, pending, type, box };
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(check: () => boolean, ms = 3000): Promise<void> { const d = Date.now() + ms; while (!check()) { if (Date.now() > d) throw new Error('timed out'); await sleep(5); } }
export const BLOCK_UNTIL_ABORT = (_c: NightContext, signal?: AbortSignal) => new Promise<NightFollowUp>((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
