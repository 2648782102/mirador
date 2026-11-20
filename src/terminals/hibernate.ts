import { isTyping, type AgentAttentionState, type AttentionStore } from '../attention/store.ts';
import { ownerNameFrom } from '../config.ts';
import type { OpenAgents, Schedule } from './open-agents.ts';
import type { TerminalRegistry } from './registry.ts';

/**
 * Idle sleep: an open agent whose attention state has
 * been `finished` for `idleMs` (config `idleSleepHours`, 4 h by default, 0 = off) with nothing else
 * going on goes to sleep, so its pi and MCP servers stop using memory:
 *
 * 1. Its idle clock starts when its state becomes finished and restarts when the user types into it
 *    (terminal replies such as focus reports do not count). Any other state stops it: an agent that
 *    works, waits for the user (a blocked or prompt token, OSC 7501 blocked), stopped with an error
 *    (OSC 7501 error, which survives the prompt its bash draws next) or whose state is unknown never
 *    sleeps.
 * 2. When the clock runs out, an agent with an open gentle-shell Todo, or that the night shift is
 *    deciding about or left for the user (AttentionStore.idleHold), or with no recorded pi session to
 *    resume, stays open and its clock starts again. Any other gets sleepNote() through the night
 *    shift's note path (NightService.sendNote), framed as a note from Mirador and logged as Mirador's.
 * 3. Once that save turn ends (working, then finished again) it is closed the way × closes it
 *    (TerminalRegistry.close, which also stops its scope) and its record becomes a sleeping
 *    record (OpenAgents.sleep): listed under "💤 Dormidos", woken with its session through the gate.
 *    If the user types into it, it waits for them, or the turn does not end within `saveTurnMs`, it
 *    stays open and its clock starts again once it is finished.
 */

/** How long the save turn may take before the agent is left open. */
export const SAVE_TURN_MS = 15 * 60_000;

/** The save note for `owner` (config `ownerName`, already resolved by ownerNameFrom; unset: "the user"). */
export function sleepNote(owner: string): string {
  return (
    'This session has been idle for a long time, so Mirador will close it to free memory; ' +
    `it resumes this same session when ${owner} wakes it. Save your session summary now with ` +
    'mem_session_summary (Goal, Instructions, Discoveries, Accomplished, Next Steps, Relevant Files), ' +
    'then end your turn without starting other work.'
  );
}

/** What the agent receives for the save note: who sends it, then the note. */
export function sleepNoteText(text: string): string {
  return `Note from Mirador, which puts idle agents to sleep:\n\n${text}`;
}

export interface IdleSleepOptions {
  registry: Pick<TerminalRegistry, 'subscribe' | 'onInput' | 'get' | 'close'>;
  attention: Pick<AttentionStore, 'agentState' | 'onAgentState' | 'idleHold'>;
  openAgents: Pick<OpenAgents, 'canSleep' | 'sleep'>;
  /** NightService.sendNote: delivers `frame(text)` to the agent's bridge; `from` 'mirador' logs it as Mirador's note. */
  sendNote(terminalId: string, text: string, noteId: string, frame: (text: string) => string, from?: 'user' | 'mirador'): Promise<{ sent: boolean; reason?: string }>;
  /** How long an agent stays finished before it sleeps; 0 turns idle sleep off. */
  idleMs: number;
  saveTurnMs?: number;
  /** Timer for the idle clock and the save turn; tests replace it. The default never keeps the process alive. */
  schedule?: Schedule;
  log?: (line: string) => void;
  /** Config `ownerName`, read before every save note; unset, not valid or unreadable = "the user". */
  ownerName?: () => unknown;
}

interface Agent {
  /** Cancels the idle clock while it runs. */
  cancelIdle: (() => void) | null;
  /** From the save note until the agent is closed or stays open. */
  saving: { cancelTimeout: () => void; turnStarted: boolean } | null;
}

const unrefSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class IdleSleep {
  private readonly options: IdleSleepOptions;
  private readonly schedule: Schedule;
  private readonly saveTurnMs: number;
  private readonly log: (line: string) => void;
  private readonly agents = new Map<string, Agent>();
  private readonly stops: Array<() => void> = [];

  constructor(options: IdleSleepOptions) {
    this.options = options;
    this.schedule = options.schedule ?? unrefSchedule;
    this.saveTurnMs = options.saveTurnMs ?? SAVE_TURN_MS;
    this.log = options.log ?? ((line: string) => console.error(line));
  }

  /** Follows the agents' states and the user's typing; does nothing when idle sleep is off. */
  start(): void {
    if (!(this.options.idleMs > 0) || this.stops.length) return;
    const { registry, attention } = this.options;
    this.stops.push(
      registry.subscribe(({ type, info }) => {
        if (type !== 'created') this.forget(info.id);
      }),
      registry.onInput((id, data) => {
        if (isTyping(data)) this.typed(id);
      }),
      attention.onAgentState((id, state) => this.changed(id, state)),
    );
  }

  /** The server stops: no clock runs and nothing more is closed. */
  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    for (const id of [...this.agents.keys()]) this.forget(id);
  }

  private changed(id: string, state: AgentAttentionState): void {
    const agent = this.agent(id);
    if (!agent.saving) {
      if (state === 'finished') this.arm(id, agent);
      else this.disarm(agent);
      return;
    }
    if (state === 'working') agent.saving.turnStarted = true;
    else if (state === 'finished' && agent.saving.turnStarted) this.saved(id, agent);
    // Waiting for the user, or silent: it stays open.
    else this.stayOpen(id, agent);
  }

  private typed(id: string): void {
    const agent = this.agents.get(id);
    if (agent?.saving) this.stayOpen(id, agent);
    else if (agent?.cancelIdle) this.arm(id, agent);
  }

  private arm(id: string, agent: Agent): void {
    agent.cancelIdle?.();
    agent.cancelIdle = this.schedule(() => {
      agent.cancelIdle = null;
      this.due(id, agent);
    }, this.options.idleMs);
  }

  private disarm(agent: Agent): void {
    agent.cancelIdle?.();
    agent.cancelIdle = null;
  }

  /** The idle clock ran out: asks the agent to save, unless something keeps it awake. */
  private due(id: string, agent: Agent): void {
    const { registry, attention, openAgents } = this.options;
    if (registry.get(id)?.status !== 'running' || attention.agentState(id) !== 'finished') return;
    if (attention.idleHold(id) !== null || !openAgents.canSleep(id)) return this.arm(id, agent);
    agent.saving = { cancelTimeout: this.schedule(() => this.stayOpen(id, agent), this.saveTurnMs), turnStarted: false };
    this.options
      .sendNote(id, sleepNote(this.owner()), '', sleepNoteText, 'mirador')
      .then((result) => {
        if (!result.sent) this.stayOpen(id, agent);
      }, () => this.stayOpen(id, agent));
  }

  /** The save turn ended: the agent goes to sleep unless something keeps it awake. */
  private saved(id: string, agent: Agent): void {
    const { registry, attention, openAgents } = this.options;
    agent.saving?.cancelTimeout();
    agent.saving = null;
    if (attention.idleHold(id) !== null || !openAgents.sleep(id)) return this.arm(id, agent);
    const info = registry.get(id);
    registry.close(id);
    const hours = Math.round((this.options.idleMs / 3_600_000) * 10) / 10;
    this.log(`mirador: the open agent of workspace ${JSON.stringify(info?.workspaceId)} folder ${JSON.stringify(info?.rel)} sleeps: its turn had been finished for ${hours} h and it saved its session; it reopens when woken in Mirador`);
  }

  /** Back to the idle clock: it starts again now when the agent is finished, else once it is. */
  private stayOpen(id: string, agent: Agent): void {
    if (!agent.saving || !this.agents.has(id)) return;
    agent.saving.cancelTimeout();
    agent.saving = null;
    if (this.options.attention.agentState(id) === 'finished') this.arm(id, agent);
  }

  private agent(id: string): Agent {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = { cancelIdle: null, saving: null };
      this.agents.set(id, agent);
    }
    return agent;
  }

  /** Config `ownerName` as the save note uses it; "the user" when unset, not valid or unreadable. */
  private owner(): string {
    try {
      return ownerNameFrom(this.options.ownerName?.());
    } catch {
      return ownerNameFrom(undefined);
    }
  }

  private forget(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.disarm(agent);
    agent.saving?.cancelTimeout();
    agent.saving = null;
    this.agents.delete(id);
  }
}
