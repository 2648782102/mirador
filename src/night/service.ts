import { randomBytes, randomUUID } from 'node:crypto';
import { isTyping, type AgentAttentionState, type AttentionItem, type NightFlow, type NightTerminalState } from '../attention/store.ts';
import { DEFAULT_OWNER_NAME, ownerAtStart, ownerNameFrom, type Workspace } from '../config.ts';
import type { TerminalRegistry } from '../terminals/registry.ts';
import type { FinishedTurn } from './channel.ts';
import type { LoggedQuestion, NightRecord } from './log.ts';
import { CLAIM_MS, MEMORY_POLL_MS, NightQueue, holdsSlot, type QueueEntry, type QueueLimit, type QueueSummary } from './night-queue.ts';
import type { ExecutionNote } from './notes.ts';
import { checkQuestion, findSensitive } from './policy.ts';
import { MIN_CONFIDENCE, QUESTION_TIMEOUT_MS, TOOK_GRACE_MS, finalAsk, type Decider, type MiradorLine, type NightContext, type NightDialog, type NightQuestion, type NightQuestionItem } from './protocol.ts';

/**
 * The night service: answers the questions bridges send while the
 * night shift is on, and sends follow-ups to finished agents the user delegates.
 *
 * Question: night shift off → `pass` at once (nothing logged). On: one question
 * per terminal at a time, then policy (src/night/policy.ts) → context → Decider
 * (aborted past its budget, below QUESTION_TIMEOUT_MS) → MIN_CONFIDENCE → `decided`
 * with a reason the agent reads, or `pass` so the dialog opens for the user. A
 * question whose bridge disconnects meanwhile is dropped. Turning the night shift
 * off passes the questions in flight.
 *
 * Held questions: while holdForAnswers is on, a question
 * left to the user by the policy, a decider deferral or low confidence, that buttons can answer, is
 * answered `held` instead of `pass` (onHeld, heldQuestions; its record has `sent: 'held'` and
 * `heldId`). It never times out and ends once (onHeldEnd): `answered` by answerHeld, `terminal`
 * when its bridge releases it (escape key, abort) or holding turns off (its dialog opens),
 * `closed` when its bridge leaves, `stopped` when the autopilot turns off or Mirador shuts down.
 *
 * Held dialogs: a blocking pi select / confirm dialog the
 * bridge reports (dialog()) is held the same way, with `tool: 'dialog'` and `dialog`, while the
 * autopilot and holding are on; never decided by the autopilot, never listed as pending, always
 * sensitive (the extra «Confirmar» on Telegram). answerHeld sends the bridge `chosen` with the
 * option index; the dialog is then answering, and a second answer reads `ended`. Only when the
 * bridge says `took` (or TOOK_GRACE_MS later, from a bridge that never says it) does it end
 * `answered` and log that answer (`tool: 'dialog'`, `decidedBy: 'user-telegram'`); a `released`
 * meanwhile (the terminal answered first) ends it `terminal` with no record.
 * A notice dialog (one too big to forward, `notice: true`) is held the same way, so its end is
 * told, but it has no options and answerHeld refuses it (`invalid`).
 *
 * Delegation (any time): only a running agent terminal whose turn finished (per
 * the attention inbox) and whose bridge is connected; the follow-up must be
 * confident and free of sensitive material, then goes out as a `message` line.
 * The decider reads the agent's final message of that turn when the bridge sent
 * one; a closing question that mentions sensitive material is left for
 * the user without asking it. A follow-up whose turn is no longer the latest when
 * the decider answers (a newer turn, or the agent left the inbox) is dropped.
 *
 * Automatic follow-up (night shift on only): AUTO_DELAY_MS after a bridge
 * reports a finished turn, the same flow runs by itself (record kind
 * 'auto-follow-up') unless a newer turn arrived, the agent started again, the user
 * typed in that terminal, or another flow of it is in progress. At most
 * MAX_AUTO_PER_NIGHT runs per terminal per night (hitting the cap is logged once);
 * after MAX_AUTO_DEFERRALS deferrals in a row the terminal is left alone until
 * the user types in it or the night shift is turned on again.
 *
 * Every question while on, every delegation and every automatic follow-up that
 * reaches the decider leaves one NightRecord in the log; the ones left for the user
 * are listed as pending since the last activation. Automatic follow-ups list one
 * item per terminal, the latest: typing by
 * the user in that terminal removes it, and one that ends after the user typed into its
 * turn is logged without being listed. Other kinds keep every item.
 *
 * Turning the night shift on (by hand or by the schedule, src/night/schedule.ts), in order:
 * 1. Execution notes (src/night/notes.ts): each pending note is delivered once, verbatim
 *    after a short framing, as a bridge `message` line: a terminal note to that terminal, a
 *    workspace note to every running agent terminal of that workspace whose bridge is
 *    connected. A note that reaches nobody stays pending with the reason. Every terminal
 *    reached leaves one record of kind 'note' (with `note: { id, text }`); notes are
 *    the user's own words, so they are neither filtered nor listed as pending.
 * 2. Sweep: agents already waiting in "finished" when the night shift turned on get the
 *    automatic follow-up flow (kind 'auto-follow-up', `sweep: true`) with all its rules,
 *    one start every SWEEP_INTERVAL_MS, skipping terminals that just received a note, that
 *    the user typed in since their turn ended, or whose turn was already followed up. Without
 *    the agent's final message the flow defers (rule 'no-final-message'). Turning the night
 *    shift off stops the sweep.
 *
 * Autopilot: the night service is the one "Piloto
 * automático"; `source` says who turned it on, the user by hand (`manual`, the default) or the
 * schedule (`schedule`), and the scheduler turns off only its own on. A manual on may carry
 * `until` (an instant): when it passes inside a schedule window that is running (handOverTo),
 * the schedule takes it over (source `schedule`, same activation, no on/off event) and ends it
 * at the window end; otherwise the service turns itself off as if the user did. Turning
 * it on by hand while the schedule has it on takes it over (source `manual`, the new until),
 * without a new activation. Every change of a manual on is handed to `saveManual` ({ since,
 * until }, or null once it is off or the schedule's), so a restart can resume it with
 * setActive(true, { source: 'manual', since, until }).
 *
 * Activation log: every change of the autopilot's state
 * (on, off, a take-over by hand, a handover to the schedule, a new until, a shutdown) reaches
 * onAutopilotChange as one AutopilotChange with the state before and after and its cause: the
 * caller's `cause` (PUT /api/night says 'user', the scheduler 'window-start' / 'window-end', a
 * restart 'restart-resume'), else 'user' by hand and 'schedule' for the schedule; the service's
 * own are 'until', 'handover' and 'shutdown'. Logs written before F5 hold a legacy cause for the user
 * (LEGACY_USER_VALUES.cause, src/night/legacy-owner.ts):
 * ScheduleStore.activations() reads them as 'user'.
 *
 * Delegated tasks: assignTask() keeps, in memory, the
 * instruction the user delegated to an agent terminal; it goes to the decider as
 * NightContext.task and leaves with the terminal. The policy never reads it, so it cannot
 * widen what may be decided.
 *
 * reminder() is the bedtime reminder content: running agents per workspace with their
 * state, what each asks at the end of its last turn, its delegated task, whether the
 * workspace has a mission, and what waits for the user.
 *
 * Night queue (src/night/night-queue.ts), when `queue` is
 * given (the server always gives it): while the autopilot is on, at most N agents work at once. A
 * note for an agent that holds no slot (it finished or waits) and every automatic follow-up that is
 * due (also from the sweep) join a first-in-first-out queue; the next one starts when an agent's
 * state frees a slot, a note is added, a follow-up is due, N changes, a terminal closes or memory
 * comes back, and only while MemAvailable is at or above the reserve (`queue.reserve`; an
 * unreadable meminfo never blocks). A note to an agent that already holds a slot (working) goes out
 * at once, as before; one whose state is unknown (nothing reported, or pi quit) waits its turn like a
 * finished one. A granted start's claim ends when the agent reports working, or the end of a turn
 * (its bridge's finished line), or nothing went out. When its entry starts, a terminal gets every
 * note waiting for it, oldest first. A workspace note is marked delivered once every agent it was
 * for got it in the same activation; an off or a shutdown in the middle leaves it pending (the
 * ones reached so far are kept in memory only, so a later activation of this process does not send
 * it to them again; after a restart they get it again).
 * Turning the autopilot off empties the queue: the notes stay pending in the store for the next on,
 * the follow-ups are dropped like any pending one. Never queued: what the user does themselves (typing, a
 * delegated task through sendNote, delegate()) and questions.
 *
 * Live cards (onTerminalState): `deciding` when a decider call starts for a terminal
 * (question or follow-up, by hand, automatic or from the sweep) and when a note goes out;
 * `resolved` when a decision, follow-up or note reached the agent, with the chosen labels,
 * the start of the instruction or of the note (≤ 120 characters); `deferred` with the rule
 * and reason whenever something is left for the user (also a follow-up or note the bridge
 * never confirmed: rule 'not-delivered'); `cleared` when a flow is dropped. Never terminal
 * output or memory text.
 */

/** How the service reaches the bridges: the night channel, or a fake in tests. */
export interface NightLink {
  send(terminalId: string, line: MiradorLine): boolean;
  isConnected(terminalId: string): boolean;
  connectedTerminals(): string[];
  /** The final message of the terminal's latest turn; absent in links without it. */
  lastFinished?(terminalId: string): FinishedTurn | null;
  /** Hears every finished turn; the service subscribes itself when the link offers it. */
  onFinished?(listener: (terminalId: string, turn: FinishedTurn) => void): () => void;
  /** Hears every session file a bridge reports, unvalidated; absent in links without it. */
  onSession?(listener: (terminalId: string, file: string) => void): () => void;
}

/** The part of the attention store the night shift reads. */
export interface AttentionView {
  items(): AttentionItem[];
  /** Each agent's state (AttentionStore.agentState), for the night queue; derived from items() when absent. */
  agentState?(terminalId: string): AgentAttentionState;
  /** Hears every change of an agent's state (AttentionStore.onAgentState); returns an unsubscribe function. */
  onAgentState?(listener: (terminalId: string, state: AgentAttentionState) => void): () => void;
}

/** What the night queue needs from the server: N, the machine's memory and the launch gate's reserve. */
export interface NightQueueOptions {
  limit(): QueueLimit;
  readMemory(): Promise<{ memTotal: number | null; memAvailable: number | null }>;
  /** The memory a start leaves free at least, in bytes (reserveFor of the launch gate's limits). */
  reserve(memTotal: number | null): number;
  /** How often a start waiting for memory reads it again (default MEMORY_POLL_MS). */
  pollMs?: number;
  /** How long a start that went out holds its slot with no new turn reported (default CLAIM_MS). */
  claimMs?: number;
}

/**
 * The attention store lives in the inbox routes; they hand it over with
 * provideNightAttention(ctx.terminals, store). Keyed by an object of that app
 * (its terminal registry), so two apps (or tests) never see each other's store.
 */
const attentionByApp = new WeakMap<object, AttentionView>();

export function provideNightAttention(app: object, view: AttentionView): void {
  attentionByApp.set(app, view);
}

export function nightAttention(app: object): AttentionView | null {
  return attentionByApp.get(app) ?? null;
}

export interface NightServiceOptions {
  /** Null when the night socket could not be opened: questions never arrive, delegations defer. */
  link: NightLink | null;
  decider: Decider;
  log: { append(record: NightRecord): Promise<void> };
  /** With `onInput`, typing by the user holds back automatic follow-ups of that terminal. */
  terminals: Pick<TerminalRegistry, 'get' | 'tail'> & Partial<Pick<TerminalRegistry, 'onInput' | 'list'>>;
  workspaces: { get(id: string): Workspace | undefined };
  attention?: () => AttentionView | null;
  /** Execution notes delivered when the night shift turns on (NoteStore). */
  notes?: NoteSink;
  /** The night queue's limits; without it every start goes out at once (no cap). */
  queue?: NightQueueOptions;
  /** Between two starts of the activation sweep (default SWEEP_INTERVAL_MS). */
  sweepIntervalMs?: number;
  /** How long the decider may take; it must stay below QUESTION_TIMEOUT_MS, when the bridge gives up. */
  decideBudgetMs?: number;
  /** How long to wait for the bridge to confirm a follow-up. */
  deliveryTimeoutMs?: number;
  /** How long after a finished turn the automatic follow-up runs (default AUTO_DELAY_MS). */
  autoDelayMs?: number;
  /** Automatic follow-ups per terminal per night (default MAX_AUTO_PER_NIGHT). */
  maxAutoPerNight?: number;
  /** Hears every change of a manual on: { since, until }, or null when there is none. */
  saveManual?: (manual: ManualOn | null) => unknown;
  now?: () => number;
  /** Runs `fn` after `ms` (the manual on's `until`); returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /**
   * Config `ownerName`, read whenever a text names the owner: the decider's context, the texts
   * agents receive, the reasons the report shows. Unset or not valid = "the user" (ownerNameFrom).
   */
  ownerName?: () => unknown;
}

/** Who turned the autopilot on. */
export type AutopilotSource = 'manual' | 'schedule';

/** A manual on as saved across restarts: its activation and its limit (ISO), or no limit. */
export interface ManualOn {
  since: string;
  until: string | null;
}

export interface ActivationOptions {
  /** Default `manual`. */
  source?: AutopilotSource;
  /** A manual on's limit (ISO); ignored for the schedule. */
  until?: string | null;
  /** A restart resuming a saved manual on keeps its activation time. */
  since?: string;
  /** Why, for the activation log (default 'user' by hand, 'schedule' for the schedule). */
  cause?: string;
  /** More detail for the activation log. */
  reason?: string;
}

/** The autopilot as the activation log describes it. */
export interface AutopilotState {
  active: boolean;
  source: AutopilotSource | null;
  until: string | null;
}

/** One change of the autopilot's state and why. */
export interface AutopilotChange {
  time: string;
  from: AutopilotState;
  to: AutopilotState;
  cause: string;
  reason?: string;
  /** The saved manual on a restart resumed, kept or dropped. */
  saved?: ManualOn;
}

export interface PendingItem {
  id: string;
  time: string;
  kind: NightRecord['kind'];
  terminalId: string;
  workspaceId: string | null;
  rel: string | null;
  tool: string | null;
  /** The (first) question, or what was delegated. */
  summary: string;
  rule: string;
  reason: string;
}

/** The part of the note store the service uses. */
export interface NoteSink {
  pending(): Promise<ExecutionNote[]>;
  markDelivered(id: string, terminalIds: string[]): Promise<void>;
  markPending(id: string, reason: string): Promise<void>;
}

export interface NoteSent {
  /** The line went out to the bridge. */
  sent: boolean;
  /** The bridge confirmed it handed the note to the agent. */
  delivered: boolean;
  /** Why it was not sent. */
  reason?: string;
}

export type ReminderAgentState = 'blocked' | 'prompt' | 'error' | 'finished' | 'working';

export interface ReminderAgent {
  terminalId: string;
  rel: string;
  title: string;
  /**
   * From the attention inbox: waiting for an answer (blocked, prompt), stopped with an error (error,
   * which waits for the user like blocked: docs/attention.md), finished, or working.
   */
  state: ReminderAgentState;
  /** Whether its bridge is connected, so the night shift (and notes) can reach it. */
  connected: boolean;
  activity: string | null;
  /** What it waits for when it waits for an answer (the dialog or gentle-ai label). */
  waitingFor: string | null;
  /** The last line of its final message that asks something, when known. Untrusted agent text. */
  closingQuestion: string | null;
  /** The instruction the user delegated to it through Mirador, or null. */
  task: string | null;
}

export interface ReminderWorkspace {
  workspaceId: string;
  name: string;
  hasMission: boolean;
  /** Set when the workspace has no mission. */
  missionNote: string | null;
  agents: ReminderAgent[];
}

export interface ReminderContent {
  time: string;
  /** Workspaces with running agent terminals, in the order of the terminal list. */
  workspaces: ReminderWorkspace[];
  /** Agents waiting for an answer right now. */
  waiting: number;
  /** What the night shift left for the user since its last activation. */
  pending: PendingItem[];
}

/**
 * A question the autopilot left to the user, held for their answer from Telegram
 * its bridge keeps waiting, so no dialog opens.
 */
export interface HeldQuestion {
  /** Short and opaque (16 characters, 96 random bits): the answer names it. */
  id: string;
  terminalId: string;
  workspaceId: string;
  workspaceName: string;
  rel: string;
  tool: NightQuestion['tool'] | 'dialog';
  /** A held dialog's kind and texts; absent for a question. Untrusted agent text. */
  dialog?: { kind: NightDialog['kind']; title: string; message: string; notice?: true };
  /** As the agent asked them (a dialog: one item with its title and options; a notice: none). Untrusted agent text. */
  items: NightQuestion['items'];
  /** Why it was left to the user, and its rule. */
  reason: string;
  rule: string;
  /** The sensitive topic when the policy found one, else null. */
  sensitive: string | null;
  /** When it was held (ISO). */
  since: string;
}

/** How a held question ended: answered from Telegram, released to its dialog, its terminal closed, or the autopilot stopped. */
export type HeldOutcome = 'answered' | 'terminal' | 'closed' | 'stopped';

export interface NightStatus {
  active: boolean;
  /** False when the night socket could not be opened. */
  available: boolean;
  /** When the night shift was last turned on (ISO), or null. */
  since: string | null;
  /** Who turned it on while it is on, else null. */
  source: AutopilotSource | null;
  /** When a manual on turns itself off (ISO), or null (no limit, or off). */
  until: string | null;
  connectedTerminals: string[];
  /** What was left for the user since the last activation, oldest first. */
  pending: PendingItem[];
  /** The night queue while the autopilot is on (absent while off or without a queue). */
  queue?: QueueSummary;
}

export const RECENT_OUTPUT_BYTES = 8 * 1024;
/** The automatic follow-up waits this long after a turn ends, so a busy agent or an awake user goes first. */
export const AUTO_DELAY_MS = 20_000;
export const MAX_AUTO_PER_NIGHT = 10;
/** Deferrals in a row after which a terminal gets no more automatic follow-ups until the user types in it. */
export const MAX_AUTO_DEFERRALS = 2;
/** The activation sweep starts one follow-up flow this often. */
export const SWEEP_INTERVAL_MS = 5000;
export const NO_MISSION_NOTE = 'This workspace has no mission: Mirador will defer everything there.';
const MAX_NOTE_TEXT = 8000;
const MAX_CLOSING_QUESTION = 300;
const DEFAULT_BUDGET_MS = QUESTION_TIMEOUT_MS - 60_000;
const DEFAULT_DELIVERY_MS = 30_000;
const MAX_PENDING = 200;
const MAX_FOLLOW_UP = 8000;
const MAX_REASON = 1000;
const MAX_STATE_SUMMARY = 120;
const MAX_STATE_REASON = 200;
/** The until timer never waits longer than this, so a suspended laptop or a clock change is noticed within the hour. */
const MAX_UNTIL_WAIT_MS = 60 * 60_000;

const realTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

type Stop = 'timeout' | 'disconnected' | 'stopped' | 'shutdown';
type RunResult<T> = { value: T } | { stop: Stop } | { error: string };
/** NightRecord['kind'] plus the automatic follow-up and the execution note, until log.ts lists them. */
type RecordKind = NightRecord['kind'] | 'auto-follow-up' | 'note';
/** Fields this service adds to a record: the sweep flag and the note delivered. */
type ServiceRecord = NightRecord & { sweep?: boolean; note?: { id: string; text: string } };
/** A held question and what answering it needs. */
interface Held {
  held: HeldQuestion;
  requestId: string;
  /** A question, or a dialog (never both). */
  question: NightQuestion | null;
  dialog: NightDialog | null;
  /** The record logged when the question was held, listed as pending; null for a dialog. */
  recordId: string | null;
  /** A dialog whose `chosen` went to its bridge: the option, and the TOOK_GRACE_MS fallback to cancel. */
  answering: { index: number; cancel: () => void } | null;
}
/** Ended held ids remembered, so a late answer reads 'ended' rather than 'unknown'. */
const MAX_ENDED_HELD = 1000;

/** Whether buttons can answer every item of `question`: at least one option each. */
const holdable = (question: NightQuestion): boolean => question.items.length > 0 && question.items.every((item) => item.options.length > 0);

/** Whether `choices` answers `question`: one list per item of distinct option indexes, exactly one unless multi-select. */
function fitsChoices(question: { items: NightQuestionItem[] }, choices: unknown): choices is number[][] {
  return (
    Array.isArray(choices) &&
    choices.length === question.items.length &&
    choices.every((list: unknown, i) => {
      const item = question.items[i];
      return (
        Array.isArray(list) &&
        list.length >= 1 &&
        (item.multiSelect || list.length === 1) &&
        new Set(list).size === list.length &&
        list.every((index: unknown) => Number.isInteger(index) && (index as number) >= 0 && (index as number) < item.options.length)
      );
    })
  );
}

/**
 * What the agent reads for the user's answer, in gentle-pi's own result wording (ask_user_choice:
 * "User selected: <n>. <label>" without the option value, which never leaves the agent;
 * ask_user_question: one "<n>. <question> — <label>" line per item, "selected: a, b" for a
 * multi-select one). Texts are kept to one line and capped, so the reason fits the bridge's limit.
 */
export function heldAnswerReason(question: NightQuestion, choices: number[][]): string {
  const label = (item: number, index: number) => oneLine(question.items[item].options[index].label, 200);
  if (question.tool === 'ask_user_choice') return `User selected: ${choices[0][0] + 1}. ${label(0, choices[0][0])}`;
  return question.items
    .map((item, i) => {
      const labels = choices[i].map((index) => label(i, index));
      return `${i + 1}. ${oneLine(item.question, 300)} — ${item.multiSelect ? `selected: ${labels.join(', ')}` : labels[0]}`;
    })
    .join('\n');
}
/** A queued start: a note entry carries nothing (its notes are read when it starts); a follow-up its turn. */
type QueuedStart = { seq: number; sweep: boolean } | null;
interface Flight {
  kind: RecordKind;
  controller: AbortController;
}

/** Automatic follow-up bookkeeping of one terminal. */
interface AutoState {
  /** Bumped by every finished turn: a flow started for an older value is stale. */
  seq: number;
  /** The `seq` during which the user last typed in the terminal (-1: never). */
  typedSeq: number;
  /** The `seq` whose automatic follow-up already ran (-1: none), so a turn is never followed up twice. */
  handledSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Automatic runs this night, deferrals in a row, and whether the cap was logged. */
  runs: number;
  deferrals: number;
  capped: boolean;
}

const SUMMARIES: Record<string, string> = {
  delegate: 'Follow-up for a finished agent',
  'auto-follow-up': 'Automatic follow-up for a finished agent',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const flowOf = (kind: RecordKind): NightFlow => (kind === 'question' ? 'question' : kind === 'note' ? 'note' : 'follow-up');
/** A decider deferral's rule: `budget` when the nightly Claude budget refused the run, else `decider`. */
const deferRule = (answer: Record<string, unknown>): string => (answer.rule === 'budget' ? 'budget' : 'decider');
const isConfidence = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * The last line of an agent's final message that asks something (has ? or ¿), as one
 * line of at most 300 characters; null when it asks nothing. Only the closing part
 * (finalAsk) is read.
 */
export function closingQuestion(text: string): string | null {
  const lines = finalAsk(text).split('\n').map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (/[?¿]/.test(lines[i])) return oneLine(lines[i], MAX_CLOSING_QUESTION);
  return null;
}

/** What the agent receives for an execution note: who wrote it (config `ownerName`; unset: "the user"), then the note as written. */
export function noteText(text: string, ownerName?: unknown): string {
  return `Execution note from ${ownerNameFrom(ownerName)}, who is away from the keyboard:\n\n${text}`;
}

/** What an agent receives for an instruction the owner delegates to it through Mirador: who sends it, then the instruction as written. */
export function taskText(text: string, ownerName?: unknown): string {
  return `Task from ${ownerNameFrom(ownerName)}, delegated through Mirador:\n\n${text}`;
}

/** The night service of one app, for other route modules; keyed like provideNightAttention. */
const serviceByApp = new WeakMap<object, NightService>();
const serviceWaiters = new WeakMap<object, Array<(service: NightService) => void>>();

export function provideNightService(app: object, service: NightService): void {
  serviceByApp.set(app, service);
  for (const waiter of serviceWaiters.get(app)?.splice(0) ?? []) {
    try {
      waiter(service);
    } catch (error) {
      console.error('night service waiter failed:', error);
    }
  }
}

/**
 * Runs `use` with the night service of `app` once it is provided, or now when it already is:
 * route modules registered before the night routes (the inbox) reach it this way.
 */
export function whenNightService(app: object, use: (service: NightService) => void): void {
  const service = serviceByApp.get(app);
  if (service) return use(service);
  const waiters = serviceWaiters.get(app) ?? [];
  waiters.push(use);
  serviceWaiters.set(app, waiters);
}

export function nightService(app: object): NightService | null {
  return serviceByApp.get(app) ?? null;
}

/** One line of plain text: control and format characters become spaces; capped. */
function oneLine(value: string, max: number): string {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function summarize(question: NightQuestion): LoggedQuestion {
  return {
    allowCustomResponse: question.allowCustomResponse,
    items: question.items.map((item) => ({
      question: oneLine(item.question, 300),
      header: oneLine(item.header, 64),
      options: item.options.map((option) => oneLine(option.label, 120)),
      multiSelect: item.multiSelect,
    })),
  };
}

const SENSITIVE_REMINDER =
  'secrets, .env files, tokens, passwords, credentials, keys, certificates, permissions, sudo, deleting, force-pushing, production, deploys, releases, payments';

/** What the agent reads instead of the dialog: who decided, what, why, and how to go on. */
export function decidedReason(context: NightContext, question: NightQuestion, choices: number[], why: string): string {
  const owner = ownerNameFrom(context.ownerName);
  const picks = question.items.map((item, i) => ({ name: oneLine(item.header || item.question, 80), label: oneLine(item.options[choices[i]].label, 120) }));
  const chosen = picks.length === 1 ? `Chosen option: "${picks[0].label}".` : ['Chosen options:', ...picks.map((pick) => `- ${pick.name}: "${pick.label}"`)].join('\n');
  return [
    `${ownerAtStart(owner)} is away from the keyboard, so this question was not shown to ${owner}. Mirador's autopilot chose on ${owner}'s behalf, following the mission of workspace "${oneLine(context.workspaceName, 80)}".`,
    chosen,
    `Why: ${oneLine(why, MAX_REASON) || 'no reason given.'}`,
    `Continue with this choice as if ${owner} had selected it. Leave anything sensitive (${SENSITIVE_REMINDER}) pending for ${owner}: do not do it yourself, and list it in your summary.`,
  ].join('\n');
}

/** What the agent receives for a delegated follow-up: who sends it, the message, and the same limits. */
export function followUpText(context: NightContext, message: string): string {
  const owner = ownerNameFrom(context.ownerName);
  return [
    `Follow-up from Mirador on ${owner}'s behalf, following the mission of workspace "${oneLine(context.workspaceName, 80)}":`,
    '',
    message,
    '',
    `Leave anything sensitive (${SENSITIVE_REMINDER}) pending for ${owner}: do not do it yourself, and list it in your summary.`,
  ].join('\n');
}

export class NightService {
  private readonly options: NightServiceOptions;
  private readonly budgetMs: number;
  private readonly deliveryMs: number;
  private on = false;
  private since: string | null = null;
  private startedBy: AutopilotSource | null = null;
  private until: number | null = null;
  private cancelUntil: (() => void) | null = null;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<NightServiceOptions['setTimer']>;
  private covers: () => boolean = () => false;
  private saving: Promise<void> = Promise.resolve();
  /** The instruction delegated to each agent terminal, in memory only; gone with the terminal. */
  private readonly tasks = new Map<string, string>();
  private pending: PendingItem[] = [];
  /** The turn (AutoState.seq) each automatic follow-up record was started for. */
  private readonly autoTurns = new WeakMap<NightRecord, number>();
  private readonly flights = new Map<string, Flight>();
  private readonly deliveries = new Map<string, { terminalId: string; resolve: (delivered: boolean) => void }>();
  private readonly autoDelayMs: number;
  private readonly maxAuto: number;
  private readonly auto = new Map<string, AutoState>();
  private readonly activeListeners = new Set<(active: boolean, since: string | null, cause: AutopilotSource) => void>();
  private readonly changeListeners = new Set<(change: AutopilotChange) => void>();
  private readonly stateListeners = new Set<(state: NightTerminalState) => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly sweepMs: number;
  /** Bumped by every activation: a sweep of an older one stops. */
  private night = 0;
  /** Settles once the latest note delivery ended; its value (the Set deliverNotes returns, or undefined) is not part of the contract. */
  private notesRun: Promise<unknown> = Promise.resolve();
  private sweepRun: Promise<void> = Promise.resolve();
  /** The night queue (null without `options.queue`), and its pump's state. */
  private readonly queue: NightQueue<QueuedStart> | null;
  private memoryWait = false;
  private pumping = false;
  private pumpAgain = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly claimTimers = new Map<string, () => void>();
  /** Workspace notes delivered to some of their agents, the others still queued: note id → terminals reached. */
  private readonly reached = new Map<string, Set<string>>();
  /** Terminals whose note entry was granted and whose notes are still on their way. */
  private readonly noteGrants = new Set<string>();
  /** Holding for answers from Telegram (holdForAnswers), the questions held now by id, and the ids that ended. */
  private holding = false;
  private readonly held = new Map<string, Held>();
  private readonly endedHeld = new Map<string, HeldOutcome>();
  private readonly heldListeners = new Set<(question: HeldQuestion) => void>();
  private readonly heldEndListeners = new Set<(id: string, outcome: HeldOutcome) => void>();

  constructor(options: NightServiceOptions) {
    this.options = options;
    this.budgetMs = Math.min(options.decideBudgetMs ?? DEFAULT_BUDGET_MS, DEFAULT_BUDGET_MS);
    this.deliveryMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_MS;
    this.autoDelayMs = options.autoDelayMs ?? AUTO_DELAY_MS;
    this.maxAuto = options.maxAutoPerNight ?? MAX_AUTO_PER_NIGHT;
    this.sweepMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? realTimer;
    const finished = options.link?.onFinished?.((terminalId) => this.finished(terminalId));
    if (finished) this.unsubscribe.push(finished);
    const input = options.terminals.onInput?.((terminalId, data) => this.input(terminalId, data));
    if (input) this.unsubscribe.push(input);
    this.queue = options.queue ? new NightQueue<QueuedStart>() : null;
    // The attention store is provided before the night routes (the inbox registers first).
    const states = this.queue ? this.attention()?.onAgentState?.((terminalId, state) => this.agentChanged(terminalId, state)) : undefined;
    if (states) this.unsubscribe.push(states);
  }

  get active(): boolean {
    return this.on;
  }

  /** Who turned it on while it is on, else null. */
  get source(): AutopilotSource | null {
    return this.startedBy;
  }

  /** `covers()`: whether the schedule would have the autopilot on now (NightScheduler.covers); a passing until then hands it over. */
  handOverTo(covers: () => boolean): void {
    this.covers = covers;
  }

  /**
   * Calls `listener` with every pi session file an agent's bridge reports (unvalidated:
   * the listener checks it), for the open-agents records. Returns an unsubscribe function.
   */
  onSessionFile(listener: (terminalId: string, file: string) => void): () => void {
    return this.options.link?.onSession?.(listener) ?? (() => undefined);
  }

  /**
   * Turns the night shift on (a new night: new pending list, automatic follow-up counts
   * start over) or off (questions and automatic follow-ups in flight stop at once).
   * `options.source` says who does it (default `manual`); see the autopilot notes above.
   */
  setActive(active: boolean, options: ActivationOptions = {}): NightStatus {
    const source = options.source ?? 'manual';
    const until = source === 'manual' && typeof options.until === 'string' && Number.isFinite(Date.parse(options.until)) ? Date.parse(options.until) : null;
    const before = this.state();
    const cause = options.cause ?? (source === 'manual' ? 'user' : 'schedule');
    // Turning it on while it is on is not a new night: keep its start, budget and caps.
    if (active && this.on) {
      // The user takes over (or changes the limit of) the current on; the schedule never takes a manual on back.
      if (source === 'manual') {
        this.startedBy = 'manual';
        this.armUntil(until);
        this.manualChanged();
        this.logChange(before, cause, options.reason);
      }
      return this.status();
    }
    const changed = active !== this.on;
    for (const state of this.auto.values()) this.clearTimer(state);
    if (active) {
      this.on = true;
      this.since = options.since && Number.isFinite(Date.parse(options.since)) ? new Date(Date.parse(options.since)).toISOString() : new Date(this.now()).toISOString();
      this.startedBy = source;
      this.armUntil(until);
      this.pending = [];
      for (const state of this.auto.values()) Object.assign(state, { runs: 0, deferrals: 0, capped: false });
    } else {
      this.on = false;
      this.startedBy = null;
      this.armUntil(null);
      for (const flight of this.flights.values()) if (flight.kind !== 'delegate') flight.controller.abort('stopped');
      this.releaseHeld('stopped');
      // Queued notes stay pending in the store for the next on; queued follow-ups are dropped.
      this.clearQueue();
    }
    if (changed) this.manualChanged();
    if (changed) this.logChange(before, cause, options.reason);
    if (changed) this.activeChanged(source);
    if (changed && active) this.activated();
    return this.status();
  }

  /**
   * Calls `listener` with every change of the autopilot's state (active, source or until) and its
   * cause, for the activation log; never for a set that changes nothing. Returns an unsubscribe function.
   */
  onAutopilotChange(listener: (change: AutopilotChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** The night queue now (also while off: N and nothing queued), or null without a queue. */
  queueSummary(): QueueSummary | null {
    if (!this.queue) return null;
    return { ...this.limit(), working: this.queue.busy(this.agentStates()), queued: this.queue.size, memoryWait: this.on && this.memoryWait, items: this.queue.items() };
  }

  /** N changed (PUT /api/night/queue): a larger one may start what waits. */
  queueChanged(): void {
    this.pump();
  }

  /** The latest change of a manual on, once saveManual finished with it (or failed). */
  get manualSaved(): Promise<void> {
    return this.saving;
  }

  /**
   * Records `text` as the task the user delegated to the agent in `terminalId`, replacing an
   * earlier one. The decider reads it as data next to the mission; it never widens the policy.
   */
  assignTask(terminalId: string, text: string): void {
    this.tasks.set(terminalId, text);
  }

  /** The execution notes of the latest activation, once delivered (or left pending). */
  get noteDelivery(): Promise<unknown> {
    return this.notesRun;
  }

  /** While the night shift is on: delivers the notes still pending now (a note written during the night). Await it; its value means nothing. */
  deliverNotesNow(): Promise<unknown> {
    const night = this.night;
    this.notesRun = this.notesRun.then(() => this.deliverNotes(night, new Set())).catch((error) => console.error('night execution notes failed:', error));
    return this.notesRun;
  }

  /** The activation sweep of the latest activation, once every flow it started ended. */
  get sweepDone(): Promise<void> {
    return this.sweepRun;
  }

  /**
   * Sends the user's note `text` to the agent in `terminalId` through its bridge, framed by
   * `frame` (noteText(), or taskText() for a delegated instruction) and otherwise verbatim,
   * and logs it (kind 'note'). Resolves once the bridge confirms, or after the delivery timeout.
   * `from` 'mirador' is Mirador's own note before it puts an idle agent to sleep (IdleSleep): logged
   * as Mirador's, and it moves no live night card, since it is housekeeping and not a night move.
   */
  async sendNote(terminalId: string, text: string, noteId = '', frame: (text: string, ownerName: string) => string = noteText, from: 'user' | 'mirador' = 'user'): Promise<NoteSent> {
    const owner = this.owner();
    const record = this.record('note', terminalId, null);
    const mirador = from === 'mirador';
    record.note = mirador ? { id: noteId, text, from: 'mirador' } : { id: noteId, text };
    record.policy = {
      allowed: true,
      rule: 'note',
      reason: mirador ? 'a note from Mirador before it puts an idle agent to sleep, delivered as written' : `an execution note from ${owner}, delivered as written`,
    };
    const info = this.options.terminals.get(terminalId);
    const refused: [string, string] | null =
      !info || info.status !== 'running' ? ['terminal', 'the terminal is closed']
      : info.kind !== 'agent' ? ['terminal', 'not an agent terminal']
      : !text.trim() || text.length > MAX_NOTE_TEXT ? ['invalid-note', 'the note is empty or too long']
      : !this.options.link ? ['unavailable', 'the night socket is not available']
      : null;
    if (refused) return this.noteNotSent(record, ...refused);
    const delivery = this.deliver(terminalId, record.id, frame(text, owner));
    if (!delivery) return this.noteNotSent(record, 'not-connected', "the agent's bridge is not connected");
    if (!mirador) this.emitState(terminalId, 'deciding', 'note');
    record.sent = 'message';
    record.outcome = 'followed-up';
    record.delivered = await delivery;
    if (!mirador) this.emitSent(terminalId, 'note', text, record.delivered);
    await this.options.log.append(record);
    return { sent: true, delivered: record.delivered };
  }

  /** The bedtime reminder content, built now. */
  reminder(): ReminderContent {
    const attention = this.attention();
    const items = attention ? this.safeItems(attention) : [];
    const byWorkspace = new Map<string, ReminderWorkspace>();
    for (const info of this.options.terminals.list?.() ?? []) {
      if (info.kind !== 'agent' || info.status !== 'running') continue;
      let entry = byWorkspace.get(info.workspaceId);
      if (!entry) {
        const workspace = this.options.workspaces.get(info.workspaceId);
        const hasMission = !!workspace?.mission?.trim();
        entry = { workspaceId: info.workspaceId, name: workspace?.name ?? info.workspaceId, hasMission, missionNote: hasMission ? null : NO_MISSION_NOTE, agents: [] };
        byWorkspace.set(info.workspaceId, entry);
      }
      const item = items.find((candidate) => candidate.terminalId === info.id);
      const final = this.lastFinished(info.id);
      entry.agents.push({
        terminalId: info.id,
        rel: info.rel,
        title: info.title,
        state: item?.kind ?? 'working',
        connected: this.options.link?.isConnected(info.id) ?? false,
        activity: item?.activity ?? null,
        waitingFor: item && item.kind !== 'finished' ? item.detail ?? item.label : null,
        closingQuestion: final ? closingQuestion(final.text) : null,
        task: this.tasks.get(info.id) ?? null,
      });
    }
    const workspaces = [...byWorkspace.values()];
    return {
      time: new Date().toISOString(),
      workspaces,
      waiting: workspaces.reduce((sum, entry) => sum + entry.agents.filter((agent) => agent.state === 'blocked' || agent.state === 'prompt' || agent.state === 'error').length, 0),
      pending: [...this.pending],
    };
  }

  /**
   * Calls `listener` after every change of `active` (never on a set that changes
   * nothing) with the new value, `since` and who made the change (`schedule`, or `manual`:
   * the user, also through a manual on's `until`). Returns an unsubscribe function.
   */
  onActiveChange(listener: (active: boolean, since: string | null, cause: AutopilotSource) => void): () => void {
    this.activeListeners.add(listener);
    return () => this.activeListeners.delete(listener);
  }

  /**
   * Calls `listener` with every night state of a terminal: deciding, resolved,
   * deferred or cleared, as described at the top of this file. Returns an unsubscribe function.
   */
  onTerminalState(listener: (state: NightTerminalState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  status(): NightStatus {
    const status: NightStatus = {
      active: this.on,
      available: this.options.link !== null,
      since: this.since,
      source: this.startedBy,
      until: this.until === null ? null : new Date(this.until).toISOString(),
      connectedTerminals: this.options.link?.connectedTerminals() ?? [],
      pending: [...this.pending],
    };
    const queue = this.on ? this.queueSummary() : null;
    if (queue) status.queue = queue;
    return status;
  }

  /**
   * While on (Telegram answering is configured and enabled), a question the autopilot leaves to
   * the user is held for their answer from Telegram instead of opening its dialog.
   */
  holdForAnswers(enabled: boolean): void {
    this.holding = enabled;
    // Turned off: what waits for Telegram goes to its dialog.
    if (!enabled) this.releaseHeld('terminal');
  }

  /**
   * The bridge of `terminalId` released its held question `requestId` to the dialog (the user
   * pressed its escape key, or the agent aborted the call): it ends `terminal`. Anything
   * else, already ended or of another terminal, changes nothing.
   */
  released(terminalId: string, requestId: string): void {
    for (const [id, entry] of this.held) if (entry.held.terminalId === terminalId && entry.requestId === requestId) this.endHeld(id, 'terminal');
  }

  /**
   * The bridge of `terminalId` closed its held dialog `requestId` with the `chosen` Mirador sent:
   * the user's answer from Telegram reached pi, so it ends `answered` and is logged. A `took` for
   * anything Mirador sent no `chosen` for counts as `released`.
   */
  took(terminalId: string, requestId: string): void {
    for (const [id, entry] of this.held) {
      if (entry.held.terminalId !== terminalId || entry.requestId !== requestId) continue;
      if (entry.answering && entry.dialog) this.dialogAnswered(id, entry, entry.dialog, entry.answering.index);
      else this.endHeld(id, 'terminal');
    }
  }

  /** The questions held now, oldest first. */
  heldQuestions(): HeldQuestion[] {
    return [...this.held.values()].map((entry) => structuredClone(entry.held));
  }

  /** Calls `listener` with every question held, before its record is logged. Returns an unsubscribe function. */
  onHeld(listener: (question: HeldQuestion) => void): () => void {
    this.heldListeners.add(listener);
    return () => this.heldListeners.delete(listener);
  }

  /**
   * The user's answer from Telegram to the held question `id`: one list of 0-based option indexes
   * per item. On success its bridge gets `decided`, the answer is logged with `decidedBy:
   * 'user-telegram'`, it leaves the pending list and ends `answered`. A question that already
   * ended reads `ended` (nothing is sent twice); choices that do not fit read `invalid` and
   * leave it held.
   */
  answerHeld(id: string, choices: number[][], source: 'telegram'): { ok: true } | { ok: false; code: 'unknown' | 'ended' | 'invalid' } {
    const entry = typeof id === 'string' ? this.held.get(id) : undefined;
    if (!entry) return { ok: false, code: typeof id === 'string' && this.endedHeld.has(id) ? 'ended' : 'unknown' };
    // A dialog whose answer already went: one answer only.
    if (entry.answering) return { ok: false, code: 'ended' };
    // A notice dialog is answered only in its terminal.
    if (source !== 'telegram' || entry.dialog?.notice || !fitsChoices(entry.held, choices)) return { ok: false, code: 'invalid' };
    if (entry.dialog) return this.answerDialog(id, entry, entry.dialog, choices[0][0]);
    const { question } = entry;
    if (!question) return { ok: false, code: 'invalid' };
    const { terminalId } = entry.held;
    const picked = choices.map((list) => [...list].sort((a, b) => a - b));
    const reason = heldAnswerReason(question, picked);
    if (!this.options.link?.send(terminalId, { type: 'decided', requestId: entry.requestId, reason })) {
      this.endHeld(id, 'closed');
      return { ok: false, code: 'ended' };
    }
    this.endHeld(id, 'answered');
    this.pending = this.pending.filter((item) => item.id !== entry.recordId);
    const record = this.record('question', terminalId, question);
    record.policy = { allowed: false, rule: entry.held.rule, reason: entry.held.reason };
    record.decision = {
      action: 'answer',
      choices: picked.flatMap((list, item) => list.map((index) => ({ item, index, label: oneLine(question.items[item].options[index].label, 120) }))),
      reason: `${ownerAtStart(this.owner())} answered from Telegram`,
    };
    record.sent = 'decided';
    record.outcome = 'decided';
    record.decidedBy = 'user-telegram';
    record.heldId = id;
    this.emitState(terminalId, 'resolved', 'question', { summary: oneLine(record.decision.choices!.map((choice) => choice.label).join(', '), MAX_STATE_SUMMARY) });
    this.options.log.append(record).catch((error) => console.error('night held answer was not logged:', error));
    return { ok: true };
  }

  /**
   * The user's answer to a held dialog: `chosen` to its bridge, and the dialog waits for its `took`
   * (dialogAnswered) or `released`; TOOK_GRACE_MS without either counts as `took`.
   */
  private answerDialog(id: string, entry: Held, dialog: NightDialog, index: number): { ok: true } | { ok: false; code: 'ended' } {
    const { terminalId } = entry.held;
    if (!this.options.link?.send(terminalId, { type: 'chosen', requestId: entry.requestId, index })) {
      this.endHeld(id, 'closed');
      return { ok: false, code: 'ended' };
    }
    entry.answering = { index, cancel: this.setTimer(() => this.held.get(id) === entry && this.dialogAnswered(id, entry, dialog, index), TOOK_GRACE_MS) };
    return { ok: true };
  }

  /** A held dialog closed with the user's answer from Telegram: it ends `answered`, and only this answer is logged. */
  private dialogAnswered(id: string, entry: Held, dialog: NightDialog, index: number): void {
    const { terminalId } = entry.held;
    this.endHeld(id, 'answered');
    const label = oneLine(dialog.options[index], 120);
    const record = this.record('question', terminalId, null);
    record.tool = 'dialog';
    record.question = { allowCustomResponse: false, items: [{ question: oneLine(dialog.message ? `${dialog.title} ${dialog.message}` : dialog.title, 600), header: dialog.kind, options: dialog.options.map((option) => oneLine(option, 120)), multiSelect: false }] };
    record.policy = { allowed: false, rule: entry.held.rule, reason: entry.held.reason };
    record.decision = { action: 'answer', choices: [{ item: 0, index, label }], reason: `${ownerAtStart(this.owner())} answered from Telegram` };
    record.sent = 'decided';
    record.outcome = 'decided';
    record.decidedBy = 'user-telegram';
    record.heldId = id;
    this.emitState(terminalId, 'resolved', 'question', { summary: oneLine(label, MAX_STATE_SUMMARY) });
    this.options.log.append(record).catch((error) => console.error('night held dialog answer was not logged:', error));
  }

  /**
   * A blocking dialog open in the terminal of `terminalId`: held for the user's answer from Telegram
   * while the autopilot and holding are on (the bridge gets `held`, onHeld hears it), else `pass`,
   * and the terminal dialog simply stays. No policy, decider, record or pending item.
   */
  dialog(terminalId: string, requestId: string, dialog: NightDialog): void {
    const info = this.options.terminals.get(terminalId);
    if (!this.on || !this.holding || info?.kind !== 'agent' || !this.options.link?.send(terminalId, { type: 'held', requestId })) {
      this.options.link?.send(terminalId, { type: 'pass', requestId });
      return;
    }
    const held: HeldQuestion = {
      id: randomBytes(12).toString('base64url'),
      terminalId,
      workspaceId: info.workspaceId,
      workspaceName: this.options.workspaces.get(info.workspaceId)?.name ?? info.workspaceId,
      rel: info.rel,
      tool: 'dialog',
      dialog: { kind: dialog.kind, title: dialog.title, message: dialog.message, ...(dialog.notice ? { notice: true as const } : {}) },
      items: [{ question: dialog.title, header: '', options: dialog.options.map((label) => ({ label, description: '' })), multiSelect: false }],
      reason: 'the agent waits for this dialog in its terminal',
      rule: 'dialog',
      // A dialog is a gate the agent cannot pass alone: always the extra «Confirmar».
      sensitive: findSensitive([dialog.title, dialog.message, ...dialog.options].join('\n')) ?? 'dialog',
      since: new Date(this.now()).toISOString(),
    };
    this.held.set(held.id, { held, requestId, question: null, dialog, recordId: null, answering: null });
    this.announceHeld(held);
  }

  /** Calls `listener` once per held question, when it ends. Returns an unsubscribe function. */
  onHeldEnd(listener: (id: string, outcome: HeldOutcome) => void): () => void {
    this.heldEndListeners.add(listener);
    return () => this.heldEndListeners.delete(listener);
  }

  /** A question from the bridge of `terminalId`; always ends with one answer sent (or dropped). */
  async question(terminalId: string, requestId: string, question: NightQuestion): Promise<void> {
    const pass = () => void this.options.link?.send(terminalId, { type: 'pass', requestId });
    if (!this.on) return pass();
    const record = this.record('question', terminalId, question);
    if (this.flights.has(terminalId)) {
      pass();
      return void (await this.defer(record, 'busy', 'another question or delegation of this terminal is in progress', 'pass'));
    }
    const policy = checkQuestion(question, true, this.owner());
    if (!policy.allow) {
      record.policy = { allowed: false, rule: policy.rule, reason: policy.reason };
      return this.leave(terminalId, requestId, question, record, policy.rule, policy.reason);
    }
    record.policy = { allowed: true };
    const context = this.context(terminalId);
    if (!context) {
      pass();
      return void (await this.defer(record, 'terminal', 'not a running agent terminal', 'pass'));
    }

    const run = await this.run('question', terminalId, (signal) => this.options.decider.decide(question, context, signal));
    if ('stop' in run && run.stop !== 'timeout' && run.stop !== 'stopped') return void (await this.drop(record));
    if (!this.options.link?.isConnected(terminalId)) return void (await this.drop(record));
    if ('stop' in run || 'error' in run) {
      if ('error' in run) record.error = run.error;
      const [rule, reason] = 'error' in run ? ['error', 'the decider failed'] : run.stop === 'timeout' ? ['timeout', `the decider took longer than ${Math.round(this.budgetMs / 1000)} s`] : ['stopped', 'the night shift was turned off'];
      // A failed or late decider leaves the question to the user like a deferral, so it can be held for Telegram.
      if (rule !== 'stopped') return this.leave(terminalId, requestId, question, record, rule, reason);
      pass();
      return void (await this.defer(record, rule, reason, 'pass'));
    }

    const decision: unknown = run.value;
    if (isRecord(decision) && decision.action === 'defer') {
      record.decision = { action: 'defer', reason: typeof decision.reason === 'string' ? oneLine(decision.reason, MAX_REASON) : '' };
      return this.leave(terminalId, requestId, question, record, deferRule(decision), record.decision.reason || 'the decider deferred');
    }
    const valid =
      isRecord(decision) &&
      decision.action === 'answer' &&
      Array.isArray(decision.choices) &&
      decision.choices.length === question.items.length &&
      decision.choices.every((choice, i) => Number.isInteger(choice) && choice >= 0 && choice < question.items[i].options.length) &&
      isConfidence(decision.confidence) &&
      typeof decision.reason === 'string';
    if (!valid) return this.leave(terminalId, requestId, question, record, 'invalid-decision', 'the decider gave an answer that does not fit the question');
    const choices = decision.choices as number[];
    const confidence = decision.confidence as number;
    const why = decision.reason as string;
    const picked = choices.map((index, item) => ({ item, index, label: oneLine(question.items[item].options[index].label, 120) }));
    record.decision = {
      action: 'answer',
      choices: picked,
      reason: oneLine(why, MAX_REASON),
      confidence,
    };
    if (confidence < MIN_CONFIDENCE) return this.leave(terminalId, requestId, question, record, 'low-confidence', `confidence ${confidence} is below ${MIN_CONFIDENCE}`);
    if (!this.on) {
      pass();
      return void (await this.defer(record, 'stopped', 'the night shift was turned off', 'pass'));
    }
    if (!this.options.link.send(terminalId, { type: 'decided', requestId, reason: decidedReason(context, question, choices, why) })) return void (await this.drop(record));
    record.sent = 'decided';
    record.outcome = 'decided';
    this.emitState(terminalId, 'resolved', 'question', { summary: oneLine(picked.map((choice) => choice.label).join(', '), MAX_STATE_SUMMARY) });
    await this.options.log.append(record);
  }

  /**
   * Leaves a question to the user: held for their answer from Telegram while holding is on and
   * buttons can answer it (the bridge gets `held`, onHeld hears it, then its record is logged
   * with `sent: 'held'`), else passed so its dialog opens.
   */
  private async leave(terminalId: string, requestId: string, question: NightQuestion, record: ServiceRecord, rule: string, reason: string): Promise<void> {
    const info = this.options.terminals.get(terminalId);
    const id = randomBytes(12).toString('base64url');
    if (!this.holding || !holdable(question) || info?.kind !== 'agent' || !this.options.link?.send(terminalId, { type: 'held', requestId })) {
      this.options.link?.send(terminalId, { type: 'pass', requestId });
      return void (await this.defer(record, rule, reason, 'pass'));
    }
    const held: HeldQuestion = {
      id,
      terminalId,
      workspaceId: info.workspaceId,
      workspaceName: this.options.workspaces.get(info.workspaceId)?.name ?? info.workspaceId,
      rel: info.rel,
      tool: question.tool,
      items: structuredClone(question.items),
      reason,
      rule,
      sensitive: rule.startsWith('sensitive:') ? rule.slice('sensitive:'.length) : null,
      since: new Date(this.now()).toISOString(),
    };
    this.held.set(id, { held, requestId, question, dialog: null, recordId: record.id, answering: null });
    record.heldId = id;
    this.announceHeld(held);
    await this.defer(record, rule, reason, 'held');
    // Answered while its record was on its way: it is not pending.
    if (this.endedHeld.get(id) === 'answered') this.pending = this.pending.filter((item) => item.id !== record.id);
  }

  private announceHeld(held: HeldQuestion): void {
    for (const listener of this.heldListeners) {
      try {
        listener(structuredClone(held));
      } catch (error) {
        console.error('night held listener failed:', error);
      }
    }
  }

  /** Ends every held question (of `terminalId` only, when given) with `outcome`; `pass` opens its dialog. */
  private releaseHeld(outcome: HeldOutcome, options: { terminalId?: string; pass?: boolean } = {}): void {
    for (const [id, entry] of [...this.held]) {
      if (options.terminalId !== undefined && entry.held.terminalId !== options.terminalId) continue;
      if (options.pass !== false) this.options.link?.send(entry.held.terminalId, { type: 'pass', requestId: entry.requestId });
      this.endHeld(id, outcome);
    }
  }

  /** Ends the held question `id` once with `outcome`; null when it is not held. */
  private endHeld(id: string, outcome: HeldOutcome): Held | null {
    const entry = this.held.get(id);
    if (!entry) return null;
    this.held.delete(id);
    entry.answering?.cancel();
    this.endedHeld.set(id, outcome);
    if (this.endedHeld.size > MAX_ENDED_HELD) this.endedHeld.delete(this.endedHeld.keys().next().value!);
    for (const listener of this.heldEndListeners) {
      try {
        listener(id, outcome);
      } catch (error) {
        console.error('night held end listener failed:', error);
      }
    }
    return entry;
  }

  /**
   * Asks the decider for a follow-up to the finished agent in `terminalId`. Null for
   * an unknown terminal; otherwise the record id now and the finished record later.
   */
  delegate(terminalId: string): { id: string; done: Promise<NightRecord> } | null {
    if (!this.options.terminals.get(terminalId)) return null;
    const record = this.record('delegate', terminalId, null);
    return { id: record.id, done: this.followUp(record) };
  }

  delivered(terminalId: string, messageId: string): void {
    const delivery = this.deliveries.get(messageId);
    if (delivery?.terminalId === terminalId) delivery.resolve(true);
  }

  /** The terminal's bridge went away (or the terminal closed): what it waited for is dropped. */
  disconnected(terminalId: string): void {
    this.flights.get(terminalId)?.controller.abort('disconnected');
    this.releaseHeld('closed', { terminalId, pass: false });
    for (const delivery of this.deliveries.values()) if (delivery.terminalId === terminalId) delivery.resolve(false);
    const state = this.auto.get(terminalId);
    if (state) {
      this.clearTimer(state);
      // A terminal that is gone takes its bookkeeping along; a reconnecting bridge keeps its counts.
      if (this.options.terminals.get(terminalId)?.status !== 'running') this.auto.delete(terminalId);
    }
    if (this.options.terminals.get(terminalId)?.status !== 'running') {
      this.tasks.delete(terminalId);
      this.closedInQueue(terminalId);
    }
  }

  close(): void {
    const before = this.state();
    this.on = false;
    if (before.active) this.logChange(before, 'shutdown', 'Mirador stopped; a saved manual on resumes at the next start');
    // The saved manual on stays: the next start resumes it.
    this.cancelUntil?.();
    this.cancelUntil = null;
    for (const stop of this.unsubscribe.splice(0)) stop();
    for (const state of this.auto.values()) this.clearTimer(state);
    for (const flight of this.flights.values()) flight.controller.abort('shutdown');
    this.releaseHeld('stopped');
    for (const delivery of this.deliveries.values()) delivery.resolve(false);
    this.clearQueue();
    // A shutdown is not the end of the night: no on/off event, so no morning summary and
    // no manual-off record. The next start re-activates through the schedule or by hand.
  }

  /** A new night: notes first, then the sweep of agents that finished before it. */
  private activated(): void {
    const night = ++this.night;
    const noted = new Set<string>();
    // Who waits in "finished" now, with their latest turn: a turn that ends later has its own timer.
    const attention = this.attention();
    const waiting = new Map<string, number>();
    for (const item of attention ? this.safeItems(attention) : []) if (item.kind === 'finished' && !waiting.has(item.terminalId)) waiting.set(item.terminalId, this.autoState(item.terminalId).seq);
    this.notesRun = this.notesRun.then(() => this.deliverNotes(night, noted)).catch((error) => console.error('night execution notes failed:', error));
    this.sweepRun = this.notesRun.then(() => this.sweep(night, waiting, noted)).catch((error) => console.error('night activation sweep failed:', error));
  }

  /**
   * Delivers the pending notes. Without `grant`: to every target that holds a slot (all of them
   * without a queue), queueing the others. With `grant` (its queue entry started): to that terminal
   * only. Returns the terminals a note went out to.
   */
  private async deliverNotes(night: number, noted: Set<string>, grant?: string): Promise<Set<string>> {
    const out = new Set<string>();
    const store = this.options.notes;
    if (!store || !this.on || night !== this.night) return out;
    for (const note of await store.pending()) {
      // An off or a shutdown in the middle: what is left waits for the next activation.
      if (!this.on || night !== this.night) break;
      const { targets, reason } = this.noteTargets(note);
      const reached = this.reached.get(note.id) ?? new Set<string>();
      const open = targets.filter((id) => !reached.has(id));
      if (grant !== undefined && !open.includes(grant)) continue;
      const now = grant !== undefined ? [grant] : open.filter((id) => this.holds(id));
      // A start granted here, with a free slot and nothing queued before it, goes out in this pass.
      const direct = new Set<string>();
      if (grant === undefined) {
        for (const id of open) {
          if (now.includes(id)) continue;
          if (await this.grantNow(id)) {
            direct.add(id);
            now.push(id);
          } else if (this.queue!.add(id, 'note', null, this.now())) noted.add(id);
        }
      }
      const results = await Promise.all(now.map(async (id) => [id, await this.sendNote(id, note.text, note.id)] as const));
      for (const [id, result] of results) {
        if (direct.has(id)) this.started(id, result.sent);
        if (!result.sent) continue;
        reached.add(id);
        noted.add(id);
        out.add(id);
      }
      // Agents still waiting in the queue, whose start is on its way, or left out because the activation ended
      // while this pass ran (an off or a shutdown empties the queue): it stays pending until they get it.
      const ended = !this.on || night !== this.night;
      if (open.some((id) => !reached.has(id) && (ended || this.queue?.has(id, 'note') || this.noteGrants.has(id)))) {
        if (reached.size) this.reached.set(note.id, reached);
        continue;
      }
      this.reached.delete(note.id);
      if (reached.size) await store.markDelivered(note.id, [...reached]);
      else await store.markPending(note.id, results[0]?.[1].reason ?? reason);
    }
    this.pump();
    return out;
  }

  /** Who a note goes to now, or why it reaches nobody. */
  private noteTargets(note: ExecutionNote): { targets: string[]; reason: string } {
    if (note.terminalId) {
      const info = this.options.terminals.get(note.terminalId);
      const reason =
        !info || info.status !== 'running' ? 'the terminal is closed'
        : info.kind !== 'agent' || info.workspaceId !== note.workspaceId ? 'not an agent terminal of this workspace'
        : !this.options.link?.isConnected(note.terminalId) ? "the agent's bridge is not connected"
        : '';
      return { targets: reason ? [] : [note.terminalId], reason };
    }
    const agents = (this.options.terminals.list?.() ?? []).filter((info) => info.kind === 'agent' && info.status === 'running' && info.workspaceId === note.workspaceId);
    return {
      targets: agents.filter((info) => this.options.link?.isConnected(info.id)).map((info) => info.id),
      reason: agents.length ? 'no agent terminal of this workspace is connected' : 'no agent terminal of this workspace is open',
    };
  }

  /**
   * Starts the automatic follow-up flow for each agent that waited in "finished" at activation
   * (`waiting`: terminal → its turn then), one every sweepMs; a newer turn is left to its timer.
   */
  private async sweep(night: number, waiting: Map<string, number>, noted: Set<string>): Promise<void> {
    const flows: Promise<void>[] = [];
    let started = 0;
    for (const [terminalId, seq] of waiting) {
      if (noted.has(terminalId) || this.auto.get(terminalId)?.seq !== seq) continue;
      if (started++ > 0) await new Promise((resolve) => setTimeout(resolve, this.sweepMs).unref?.());
      if (!this.on || night !== this.night) break;
      // With the queue, the sweep only queues: the flow starts when a slot is free.
      if (this.queue) this.enqueueFollowUp(terminalId, seq, true);
      else flows.push(this.autoFollowUp(terminalId, seq, true).then(() => undefined, (error) => console.error('night sweep follow-up failed:', error)));
    }
    await Promise.all(flows);
  }

  /** Starts a confirmed delivery of `text` to the bridge; null when the line could not be written. */
  private deliver(terminalId: string, messageId: string, text: string): Promise<boolean> | null {
    const delivered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), this.deliveryMs);
      timer.unref?.();
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.deliveries.delete(messageId);
        resolve(value);
      };
      this.deliveries.set(messageId, { terminalId, resolve: finish });
    });
    if (!this.options.link?.send(terminalId, { type: 'message', messageId, text })) {
      this.deliveries.get(messageId)?.resolve(false);
      return null;
    }
    return delivered;
  }

  /** Logs a note that could not go out (never listed as pending: the note store keeps it). */
  private async noteNotSent(record: ServiceRecord, rule: string, reason: string): Promise<NoteSent> {
    record.outcome = 'deferred';
    record.sent = 'none';
    record.delivered = false;
    record.deferral = { rule, reason };
    await this.options.log.append(record);
    return { sent: false, delivered: false, reason };
  }

  /** Sets the manual on's limit (null: none) and arms its timer, at most an hour at a time. */
  private armUntil(until: number | null): void {
    this.until = until;
    this.cancelUntil?.();
    this.cancelUntil = null;
    if (until === null) return;
    const check = () => {
      this.cancelUntil = null;
      if (!this.on || this.until !== until) return;
      if (this.now() >= until) {
        if (this.handsOver()) {
          // The running window takes it: same activation, no event, nothing left to resume.
          const before = this.state();
          this.startedBy = 'schedule';
          this.until = null;
          this.manualChanged();
          this.logChange(before, 'handover', 'the until passed inside a running window');
          return;
        }
        // As if the user turned it off: the scheduler reads it as the user's off, the report sends the summary.
        this.setActive(false, { source: 'manual', cause: 'until' });
        return;
      }
      this.cancelUntil = this.setTimer(check, Math.min(Math.max(until - this.now(), 0), MAX_UNTIL_WAIT_MS));
    };
    this.cancelUntil = this.setTimer(check, Math.min(Math.max(until - this.now(), 0), MAX_UNTIL_WAIT_MS));
  }

  private handsOver(): boolean {
    try {
      return this.covers();
    } catch (error) {
      console.error('night autopilot could not ask the schedule:', error);
      return false;
    }
  }

  private manualChanged(): void {
    const manual: ManualOn | null = this.on && this.startedBy === 'manual' && this.since ? { since: this.since, until: this.until === null ? null : new Date(this.until).toISOString() } : null;
    try {
      this.saving = Promise.resolve(this.options.saveManual?.(manual)).then(
        () => undefined,
        (error) => console.error('night autopilot state was not saved:', error),
      );
    } catch (error) {
      console.error('night autopilot state was not saved:', error);
    }
  }

  private state(): AutopilotState {
    return { active: this.on, source: this.on ? this.startedBy : null, until: this.on && this.until !== null ? new Date(this.until).toISOString() : null };
  }

  /** Tells the change listeners when the state differs from `before`. */
  private logChange(before: AutopilotState, cause: string, reason?: string): void {
    const to = this.state();
    if (before.active === to.active && before.source === to.source && before.until === to.until) return;
    const change: AutopilotChange = { time: new Date(this.now()).toISOString(), from: before, to, cause };
    if (reason) change.reason = reason;
    for (const listener of this.changeListeners) {
      try {
        listener({ ...change });
      } catch (error) {
        console.error('night autopilot change listener failed:', error);
      }
    }
  }

  private activeChanged(cause: AutopilotSource): void {
    for (const listener of this.activeListeners) {
      try {
        listener(this.on, this.since, cause);
      } catch (error) {
        console.error('night active listener failed:', error);
      }
    }
  }

  private autoState(terminalId: string): AutoState {
    let state = this.auto.get(terminalId);
    if (!state) {
      state = { seq: 0, typedSeq: -1, handledSeq: -1, timer: null, runs: 0, deferrals: 0, capped: false };
      this.auto.set(terminalId, state);
    }
    return state;
  }

  private clearTimer(state: AutoState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  /** A bridge reported a finished turn: it becomes the latest, and at night its follow-up is scheduled. */
  private finished(terminalId: string): void {
    const state = this.autoState(terminalId);
    const seq = ++state.seq;
    this.clearTimer(state);
    // The end of a turn ends a granted start's claim even when its state stays finished (no state change event).
    if (this.queue?.claimed(terminalId)) {
      this.releaseClaim(terminalId);
      this.pump();
    }
    if (!this.on) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.queue) this.enqueueFollowUp(terminalId, seq, false);
      else this.autoFollowUp(terminalId, seq).catch((error) => console.error('night automatic follow-up failed:', error));
    }, this.autoDelayMs);
    state.timer.unref?.();
  }

  /**
   * The user typed in the terminal: its pending automatic follow-up is cancelled, its deferral
   * streak ends, and its automatic follow-ups left for the user leave the pending list.
   */
  private input(terminalId: string, data: string): void {
    const state = this.auto.get(terminalId);
    if (!state || !isTyping(data)) return;
    this.queue?.remove(terminalId, 'follow-up');
    this.unlistAuto(terminalId);
    state.typedSeq = state.seq;
    state.deferrals = 0;
    this.clearTimer(state);
  }

  /** `sweep`: started by the activation sweep, which also needs the agent's final message. True when a follow-up went out. */
  private async autoFollowUp(terminalId: string, seq: number, sweep = false): Promise<boolean> {
    const state = this.auto.get(terminalId);
    if (!this.on || !state || state.seq !== seq || state.typedSeq === seq || state.handledSeq === seq || state.deferrals >= MAX_AUTO_DEFERRALS) return false;
    // The agent started again, the user saw it, its bridge left, or another flow runs: nothing to follow up.
    if (this.refuseDelegation(terminalId)) return false;
    const autoRecord = () => {
      const record: ServiceRecord = this.record('auto-follow-up', terminalId, null);
      if (sweep) record.sweep = true;
      this.autoTurns.set(record, seq);
      return record;
    };
    if (state.runs >= this.maxAuto) {
      if (state.capped) return false;
      state.capped = true;
      const record = autoRecord();
      const reason = `${this.maxAuto} automatic follow-ups ran for this terminal this night; the next ones wait for ${this.owner()}`;
      record.policy = { allowed: false, rule: 'auto-cap', reason };
      await this.defer(record, 'auto-cap', reason, 'none');
      return false;
    }
    state.handledSeq = seq;
    if (sweep && !this.lastFinished(terminalId)) {
      const record = autoRecord();
      const reason = `Mirador does not know the agent's final message of this turn; it stays for ${this.owner()}`;
      record.policy = { allowed: false, rule: 'no-final-message', reason };
      await this.defer(record, 'no-final-message', reason, 'none');
      return false;
    }
    state.runs++;
    const record = await this.followUp(autoRecord());
    if (record.outcome === 'deferred') state.deferrals++;
    else if (record.outcome === 'followed-up') state.deferrals = 0;
    return record.sent === 'message';
  }

  /* ---------- The night queue ---------- */

  private limit(): QueueLimit {
    try {
      return this.options.queue!.limit();
    } catch (error) {
      console.error('night queue limit failed:', error);
      return { slots: 1, suggested: 1, custom: false, memTotal: null };
    }
  }

  /** What agent `terminalId` is doing: the attention store's state, else derived from its inbox card (none: working). */
  private agentState(terminalId: string): AgentAttentionState {
    const attention = this.attention();
    if (!attention) return 'unknown';
    try {
      if (attention.agentState) return attention.agentState(terminalId);
    } catch {
      return 'unknown';
    }
    const item = this.safeItems(attention).find((entry) => entry.terminalId === terminalId);
    return !item ? 'working' : item.kind === 'finished' ? 'finished' : 'waiting';
  }

  /** The state of every running agent terminal. */
  private agentStates(): Array<[string, AgentAttentionState]> {
    return (this.options.terminals.list?.() ?? []).filter((info) => info.kind === 'agent' && info.status === 'running').map((info) => [info.id, this.agentState(info.id)]);
  }

  /** Whether a note to `terminalId` can go out now: no queue, or it holds a slot already (it works, or a start of its own). */
  private holds(terminalId: string): boolean {
    if (!this.queue || this.queue.claimed(terminalId)) return true;
    return holdsSlot(this.agentState(terminalId));
  }

  /** A due automatic follow-up joins the queue (unless a note of that terminal waits there). */
  private enqueueFollowUp(terminalId: string, seq: number, sweep: boolean): void {
    if (!this.on) return;
    this.queue!.add(terminalId, 'follow-up', { seq, sweep }, this.now());
    this.pump();
  }

  /** An agent's state changed: one that reports a new turn holds its slot by its state now; any change may free one. */
  private agentChanged(terminalId: string, state: AgentAttentionState): void {
    if (state === 'working') this.releaseClaim(terminalId);
    this.pump();
  }

  /** A terminal that closed leaves the queue; its notes are looked at again (they stay pending with the reason). */
  private closedInQueue(terminalId: string): void {
    if (!this.queue) return;
    const removed = this.queue.remove(terminalId);
    this.releaseClaim(terminalId);
    if (this.on && removed.some((entry) => entry.kind === 'note')) void this.deliverNotesNow();
    this.pump();
  }

  private releaseClaim(terminalId: string): void {
    this.claimTimers.get(terminalId)?.();
    this.claimTimers.delete(terminalId);
    this.queue?.release(terminalId);
  }

  /** Empties the queue: its notes stay pending in the store, its follow-ups are dropped. */
  private clearQueue(): void {
    if (!this.queue) return;
    this.queue.clear();
    for (const cancel of this.claimTimers.values()) cancel();
    this.claimTimers.clear();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.memoryWait = false;
  }

  /** Starts what waits while a slot is free and memory allows; one pump at a time, asked again when something changed meanwhile. */
  private pump(): void {
    if (!this.queue) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    this.pumpAgain = false;
    this.pumpOnce()
      .catch((error) => console.error('night queue failed:', error))
      .finally(() => {
        this.pumping = false;
        if (this.pumpAgain) this.pump();
      });
  }

  private async pumpOnce(): Promise<void> {
    const queue = this.queue!;
    const full = () => queue.busy(this.agentStates()) >= this.limit().slots;
    while (this.on && queue.size && !full()) {
      if (!(await this.memoryAllows())) return;
      if (!this.on || !queue.size || full()) break;
      this.start(queue.grant()!);
    }
    this.memoryWait = false;
  }

  /**
   * Grants `terminalId` a slot right away when nothing waits before it, a slot is free and memory
   * allows (checked after the memory read, together with the claim, so a pump cannot take the same slot).
   */
  private async grantNow(terminalId: string): Promise<boolean> {
    const queue = this.queue!;
    if (queue.size || queue.busy(this.agentStates()) >= this.limit().slots) return false;
    if (!(await this.memoryAllows())) return false;
    if (!this.on || queue.size || queue.busy(this.agentStates()) >= this.limit().slots) return false;
    queue.claim(terminalId);
    return true;
  }

  /** Whether free memory is at or above the reserve (an unreadable meminfo allows); arms a new look when not. */
  private async memoryAllows(): Promise<boolean> {
    let memory: { memTotal: number | null; memAvailable: number | null };
    try {
      memory = await this.options.queue!.readMemory();
    } catch {
      memory = { memTotal: null, memAvailable: null };
    }
    if (memory.memAvailable === null || memory.memAvailable >= this.options.queue!.reserve(memory.memTotal)) {
      this.memoryWait = false;
      return true;
    }
    this.memoryWait = true;
    this.pollTimer ??= setTimeout(() => {
      this.pollTimer = null;
      this.pump();
    }, this.options.queue!.pollMs ?? MEMORY_POLL_MS);
    this.pollTimer.unref?.();
    return false;
  }

  /** Runs a granted start; its claim lasts until the agent reports a new turn, or ends when nothing went out or after claimMs. */
  private start(entry: QueueEntry<QueuedStart>): void {
    const { terminalId } = entry;
    const night = this.night;
    let run: Promise<boolean>;
    if (entry.kind === 'note' || !entry.data) {
      this.noteGrants.add(terminalId);
      const notes = this.notesRun.then(() => this.deliverNotes(night, new Set(), terminalId)).finally(() => this.noteGrants.delete(terminalId));
      this.notesRun = notes.then(() => undefined, (error) => console.error('night execution notes failed:', error));
      run = notes.then((out) => out.has(terminalId));
    } else {
      run = this.autoFollowUp(terminalId, entry.data.seq, entry.data.sweep);
    }
    run.then(
      (sent) => this.started(terminalId, sent),
      (error) => {
        console.error('night queued start failed:', error);
        this.started(terminalId, false);
      },
    );
  }

  private started(terminalId: string, sent: boolean): void {
    if (sent && this.queue!.sent(terminalId, this.now())) {
      this.claimTimers.get(terminalId)?.();
      this.claimTimers.set(
        terminalId,
        this.setTimer(() => {
          this.claimTimers.delete(terminalId);
          this.queue?.release(terminalId);
          this.pump();
        }, this.options.queue!.claimMs ?? CLAIM_MS),
      );
      return;
    }
    if (!sent) this.releaseClaim(terminalId);
    this.pump();
  }

  /** Whether the turn `seq` of `terminalId` is still the one to follow up: no newer turn, still finished in the inbox. */
  private current(record: NightRecord, seq: number): boolean {
    const state = this.auto.get(record.terminalId);
    if ((state?.seq ?? 0) !== seq) return false;
    if ((record.kind as RecordKind) === 'auto-follow-up' && state?.typedSeq === seq) return false;
    const attention = this.attention();
    return !!attention && this.safeItems(attention).some((item) => item.terminalId === record.terminalId && item.kind === 'finished');
  }

  private async followUp(record: NightRecord): Promise<NightRecord> {
    const terminalId = record.terminalId;
    const refused = this.refuseDelegation(terminalId);
    if (refused) {
      record.policy = { allowed: false, rule: refused[0], reason: refused[1] };
      return this.defer(record, refused[0], refused[1], 'none');
    }
    const seq = this.auto.get(terminalId)?.seq ?? 0;
    const context = this.context(terminalId, true)!;
    // Like a question's texts (policy.ts): a closing question about sensitive material is never put to the decider.
    const asked = typeof context.lastMessage === 'string' ? findSensitive(finalAsk(context.lastMessage)) : null;
    if (asked) {
      const reason = `the agent's closing question mentions sensitive material (${asked}); it stays pending for ${this.owner()}`;
      record.policy = { allowed: false, rule: `sensitive:${asked}`, reason };
      return this.defer(record, `sensitive:${asked}`, reason, 'none');
    }
    record.policy = { allowed: true };
    const run = await this.run(record.kind, terminalId, (signal) => this.options.decider.followUp(context, signal));
    if ('stop' in run && run.stop !== 'timeout' && run.stop !== 'stopped') return this.drop(record);
    if (!this.current(record, seq)) return this.discard(record, 'stale', `the agent started a new turn, or ${this.owner()} took over, before the follow-up was ready`);
    if ('stop' in run) {
      return run.stop === 'timeout'
        ? this.defer(record, 'timeout', `the decider took longer than ${Math.round(this.budgetMs / 1000)} s`, 'none')
        : this.defer(record, 'stopped', 'the night shift was turned off', 'none');
    }
    if ('error' in run) {
      record.error = run.error;
      return this.defer(record, 'error', 'the decider failed', 'none');
    }

    const followUp: unknown = run.value;
    if (isRecord(followUp) && followUp.action === 'defer') {
      record.followUp = { action: 'defer', reason: typeof followUp.reason === 'string' ? oneLine(followUp.reason, MAX_REASON) : '' };
      return this.defer(record, deferRule(followUp), record.followUp.reason || 'the decider deferred', 'none');
    }
    const message = isRecord(followUp) && typeof followUp.message === 'string' ? followUp.message.trim() : '';
    if (!isRecord(followUp) || followUp.action !== 'follow-up' || !message || message.length > MAX_FOLLOW_UP || !isConfidence(followUp.confidence) || typeof followUp.reason !== 'string') {
      return this.defer(record, 'invalid-decision', 'the decider gave a follow-up Mirador cannot send', 'none');
    }
    record.followUp = { action: 'follow-up', message, reason: oneLine(followUp.reason, MAX_REASON), confidence: followUp.confidence };
    if (followUp.confidence < MIN_CONFIDENCE) return this.defer(record, 'low-confidence', `confidence ${followUp.confidence} is below ${MIN_CONFIDENCE}`, 'none');
    const topic = findSensitive(message);
    if (topic) return this.defer(record, `sensitive:${topic}`, `the follow-up mentions sensitive material (${topic}); it stays pending for ${this.owner()}`, 'none');

    const delivered = this.deliver(terminalId, record.id, followUpText(context, message));
    if (!delivered) return this.defer(record, 'not-connected', "the agent's bridge is not connected", 'none');
    record.sent = 'message';
    record.outcome = 'followed-up';
    record.delivered = await delivered;
    this.emitSent(terminalId, 'follow-up', message, record.delivered);
    await this.options.log.append(record);
    return record;
  }

  /** Why `terminalId` cannot be delegated now, as [rule, reason], or null. */
  private refuseDelegation(terminalId: string): [string, string] | null {
    const info = this.options.terminals.get(terminalId);
    if (!info || info.kind !== 'agent' || info.status !== 'running') return ['terminal', 'not a running agent terminal'];
    if (!this.options.link) return ['unavailable', 'the night socket is not available'];
    const attention = this.attention();
    if (!attention) return ['no-attention', 'the attention inbox is not reachable'];
    const item = this.safeItems(attention).find((entry) => entry.terminalId === terminalId);
    if (item?.kind !== 'finished') return ['not-finished', item ? 'the agent waits for an answer' : 'the agent has not finished its turn'];
    if (!this.options.link.isConnected(terminalId)) return ['not-connected', "the agent's bridge is not connected"];
    if (this.flights.has(terminalId)) return ['busy', 'another question or delegation of this terminal is in progress'];
    return null;
  }

  /** Runs one decider call for `terminalId`, aborted past the budget, on disconnect, or when stopped. */
  private async run<T>(kind: RecordKind, terminalId: string, call: (signal: AbortSignal) => Promise<T>): Promise<RunResult<T>> {
    const controller = new AbortController();
    this.flights.set(terminalId, { kind, controller });
    this.emitState(terminalId, 'deciding', flowOf(kind));
    const stopped = new Promise<{ stop: Stop }>((resolve) => controller.signal.addEventListener('abort', () => resolve({ stop: controller.signal.reason as Stop }), { once: true }));
    const timer = setTimeout(() => controller.abort('timeout'), this.budgetMs);
    timer.unref?.();
    try {
      const result: RunResult<T> = await Promise.race([
        Promise.resolve()
          .then(() => call(controller.signal))
          .then(
            (value) => ({ value }),
            (error) => ({ error: oneLine(error instanceof Error ? error.message : String(error), 300) }),
          ),
        stopped,
      ]);
      // An answer that raced the abort is still late.
      return controller.signal.aborted ? { stop: controller.signal.reason as Stop } : result;
    } finally {
      clearTimeout(timer);
      if (this.flights.get(terminalId)?.controller === controller) this.flights.delete(terminalId);
    }
  }

  /** Config `ownerName` as the texts use it; "the user" when unset, not valid or unreadable. */
  private owner(): string {
    try {
      return ownerNameFrom(this.options.ownerName?.());
    } catch {
      return ownerNameFrom(undefined);
    }
  }

  /** The decider's context; follow-ups also get the agent's final message of its latest turn when known. */
  private context(terminalId: string, followUp = false): NightContext | null {
    const info = this.options.terminals.get(terminalId);
    if (!info || info.kind !== 'agent') return null;
    const workspace = this.options.workspaces.get(info.workspaceId);
    const attention = this.attention();
    const item = attention ? this.safeItems(attention).find((entry) => entry.terminalId === terminalId) : undefined;
    const context: NightContext = {
      workspaceId: info.workspaceId,
      workspaceName: workspace?.name ?? info.workspaceId,
      rel: info.rel,
      cwd: info.cwd,
      mission: workspace?.mission ?? '',
      activity: item?.activity ?? null,
      recentOutput: this.options.terminals.tail(terminalId, RECENT_OUTPUT_BYTES) ?? '',
    };
    // Only a configured name: without one the decider's prompts use the default ("the user") themselves.
    const owner = this.owner();
    if (owner !== DEFAULT_OWNER_NAME) context.ownerName = owner;
    const task = this.tasks.get(terminalId);
    if (task) context.task = task;
    const final = followUp ? this.lastFinished(terminalId) : null;
    if (final) context.lastMessage = final.text;
    return context;
  }

  private lastFinished(terminalId: string): FinishedTurn | null {
    try {
      const turn = this.options.link?.lastFinished?.(terminalId);
      return turn && typeof turn.text === 'string' ? turn : null;
    } catch {
      return null;
    }
  }

  private attention(): AttentionView | null {
    try {
      return this.options.attention?.() ?? null;
    } catch {
      return null;
    }
  }

  private safeItems(attention: AttentionView): AttentionItem[] {
    try {
      return attention.items();
    } catch {
      return [];
    }
  }

  private record(kind: RecordKind, terminalId: string, question: NightQuestion | null): ServiceRecord {
    const info = this.options.terminals.get(terminalId);
    return {
      id: randomUUID(),
      time: new Date().toISOString(),
      kind: kind as NightRecord['kind'],
      terminalId,
      workspaceId: info?.workspaceId ?? null,
      rel: info?.rel ?? null,
      tool: question?.tool ?? null,
      question: question ? summarize(question) : null,
      policy: { allowed: false },
      decision: null,
      followUp: null,
      sent: 'none',
      delivered: null,
      outcome: 'deferred',
      deferral: null,
      error: null,
    };
  }

  private async defer(record: NightRecord, rule: string, reason: string, sent: NightRecord['sent']): Promise<NightRecord> {
    record.outcome = 'deferred';
    record.sent = sent;
    record.deferral = { rule, reason };
    return this.keep(record);
  }

  private async drop(record: NightRecord): Promise<NightRecord> {
    record.outcome = 'dropped';
    record.sent = 'none';
    record.deferral = { rule: 'disconnected', reason: "the agent's bridge disconnected before the answer" };
    return this.keep(record);
  }

  /** Logs a dropped record that nobody needs to act on (its turn is over), without listing it as pending. */
  private async discard(record: NightRecord, rule: string, reason: string): Promise<NightRecord> {
    record.outcome = 'dropped';
    record.sent = 'none';
    record.deferral = { rule, reason };
    this.emitState(record.terminalId, 'cleared', flowOf(record.kind));
    await this.options.log.append(record);
    return record;
  }

  /** A follow-up or note went out: resolved with the start of `text` once confirmed, else deferred. */
  private emitSent(terminalId: string, flow: NightFlow, text: string, delivered: boolean): void {
    if (delivered) this.emitState(terminalId, 'resolved', flow, { summary: oneLine(text, MAX_STATE_SUMMARY) });
    else this.emitState(terminalId, 'deferred', flow, { rule: 'not-delivered', reason: "the agent's bridge did not confirm it received the message" });
  }

  private emitState(terminalId: string, state: NightTerminalState['state'], flow: NightFlow, extra: { summary?: string; rule?: string; reason?: string } = {}): void {
    const event: NightTerminalState = { terminalId, state, flow, summary: extra.summary ?? '', at: new Date().toISOString() };
    if (extra.rule !== undefined) event.rule = extra.rule;
    if (extra.reason !== undefined) event.reason = oneLine(extra.reason, MAX_STATE_REASON);
    for (const listener of this.stateListeners) {
      try {
        listener({ ...event });
      } catch (error) {
        console.error('night state listener failed:', error);
      }
    }
  }

  /** Removes the automatic follow-ups of `terminalId` from the pending list. */
  private unlistAuto(terminalId: string): void {
    this.pending = this.pending.filter((item) => !((item.kind as RecordKind) === 'auto-follow-up' && item.terminalId === terminalId));
  }

  /**
   * Logs a record left for the user and lists it as pending. An automatic follow-up replaces
   * the one its terminal already lists, and is not listed when the user typed into its turn.
   */
  private async keep(record: NightRecord): Promise<NightRecord> {
    if (record.outcome === 'dropped') this.emitState(record.terminalId, 'cleared', flowOf(record.kind));
    else this.emitState(record.terminalId, 'deferred', flowOf(record.kind), { rule: record.deferral!.rule, reason: record.deferral!.reason });
    const turn = this.autoTurns.get(record);
    if (turn !== undefined) {
      if ((this.auto.get(record.terminalId)?.typedSeq ?? -1) >= turn) {
        await this.options.log.append(record);
        return record;
      }
      this.unlistAuto(record.terminalId);
    }
    this.pending.push({
      id: record.id,
      time: record.time,
      kind: record.kind,
      terminalId: record.terminalId,
      workspaceId: record.workspaceId,
      rel: record.rel,
      tool: record.tool,
      summary: record.question?.items[0]?.question ?? SUMMARIES[record.kind] ?? SUMMARIES.delegate,
      rule: record.deferral!.rule,
      reason: record.deferral!.reason,
    });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    await this.options.log.append(record);
    return record;
  }
}
