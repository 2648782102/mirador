/**
 * A pi extension that tells Mirador when a gentle-shell agent needs the user.
 * Mirador appends `-e <this file>` to plain gentle-shell/pi agent commands
 * (config `attentionBridge`, src/attention/agent-args.ts); Mirador's server never
 * imports it.
 *
 * Why it exists: gentle-ai announces a guarded command confirmation, an
 * ask_user_question questionnaire or an ask_user_choice prompt by emitting
 * `herdr:blocked` { active, label } on pi's in-process event bus. Under herdr,
 * herdr's own bridge extension carries that to the herdr host; gentle-shell
 * itself only reports its Todo title. This bridge stands in for herdr's and
 * reports the agent's whole attention state, the way gentle-shell reports
 * activity, by running
 *   $HERDR_BIN_PATH pane report-metadata <pane> --source mirador:attention
 *     (--token blocked=<label> | --clear-token blocked)    gentle-ai's herdr:blocked
 *     (--token prompt=<title> | --clear-token prompt)      any pi dialog it waits on (ui_prompt_start/end)
 *     (--token finished=<turn> | --clear-token finished)   its turn ended (agent_settled) until it starts again
 * which in a Mirador agent terminal is Mirador's shim.
 *
 * It runs inside the agent, so it never throws, never waits on the CLI (one call
 * in flight, latest state wins, 1.5 s timeout) and does nothing outside a Mirador
 * agent terminal or in a subagent child.
 *
 * Night shift: when Mirador also gives
 * the terminal MIRADOR_NIGHT_SOCKET and MIRADOR_NIGHT_TOKEN, the bridge keeps a
 * connection to Mirador's night socket (src/night/channel.ts; reconnecting with
 * backoff) and:
 * - on pi's `tool_call` for ask_user_choice / ask_user_question, sends the
 *   question (labels and descriptions only, never option values) and waits up to
 *   QUESTION_TIMEOUT_MS: `decided` blocks the call with Mirador's reason, so the
 *   agent reads the choice and no dialog opens; `pass`, a timeout, an aborted
 *   call, a lost connection or anything unexpected returns nothing and the dialog
 *   opens as usual. Input it cannot forward whole is never sent. No other tool is
 *   ever touched. pi blocks a call whose handler throws, so this one never throws;
 * - on a `held` line, keeps that question
 *   waiting with no timeout, for the user's answer from Telegram, and shows it in a
 *   status line (ctx.ui.setStatus). While held, Esc is taken (ctx.ui.onTerminalInput,
 *   which pi runs before its own keys) to give the question back to its dialog; that,
 *   or an aborted call, sends `released` so Mirador ends it. A `held` for a question
 *   no longer waited for, or one a lost connection cut (after the next hello), is
 *   answered `released` too;
 * - wraps pi's ctx.ui.select / ctx.ui.confirm, at every
 *   `session_start` (pi builds a new ctx.ui per UI binding), `agent_start` and `tool_call`; a
 *   method already wrapped (marked with Symbol.for('mirador.night.dialog')) is never wrapped again.
 *   The dialog opens in the terminal as always, with an abort signal merged into the caller's, and
 *   is sent as a `dialog` line. Whichever answers first wins: the terminal's result is returned as
 *   is (then `released`, when held); Mirador's `chosen` closes the terminal dialog and returns that
 *   option (confirm: Yes → true, No → false), and the bridge answers `took`; a `chosen` that comes
 *   after the terminal's answer (or in the same instant, but behind it) is answered `released`, and
 *   one it cannot apply (an index the dialog has not) is ignored, so it keeps waiting. A dialog over MAX_DIALOG_OPTIONS or MAX_DIALOG_CHARS,
 *   or whose line would pass 64 KiB, is sent as a notice (`notice: true`: its kind and title cut to
 *   MAX_NOTICE_TITLE_CHARS, nothing else): the terminal dialog then gets the caller's own options, a
 *   `chosen` for it is ignored, and its end is still `released`. One with input pi would not take is
 *   never sent. When ctx.ui cannot be wrapped, dialogs stay as
 *   they are and the bridge says so once (ctx.ui.notify, since stderr would garble the TUI);
 * - on a `message` line, hands the text to pi as a follow-up user message and
 *   answers `delivered`;
 * - on pi's `agent_end`, sends a `finished` line with the text parts of the
 *   turn's last assistant message (no thinking, no tool calls; at most
 *   MAX_FINAL_MESSAGE_BYTES, keeping the end) and the turn id the attention
 *   `finished` token gets when the run settles. Fire and forget: only while the
 *   socket is connected, never awaited, never thrown.
 * - reports the agent's pi session file (ctx.sessionManager.getSessionFile()) in a
 *   `session` line on every `session_start`, at every `agent_end` (pi creates the file
 *   at the first message) and right after each hello, so Mirador can continue that
 *   session when it reopens the agent after a restart.
 *   Same fire and forget rules.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { CONFIRM_OPTIONS, MAX_DIALOG_CHARS, MAX_DIALOG_OPTIONS, MAX_FINAL_MESSAGE_BYTES, MAX_NOTICE_TITLE_CHARS, MAX_SESSION_FILE_CHARS, NIGHT_SOCKET_ENV, NIGHT_TOKEN_ENV, QUESTION_TIMEOUT_MS } from '../night/protocol.ts';
import type { NightDialog, NightQuestion, NightQuestionItem } from '../night/protocol.ts';

type Handler = (...args: never[]) => unknown;
/** The parts of pi's ExtensionAPI this bridge uses. */
interface PiLike {
  on?(event: string, handler: Handler): unknown;
  events?: { on?(event: string, handler: (payload: unknown) => void): unknown };
  sendUserMessage?(content: string, options?: { deliverAs?: 'steer' | 'followUp'; expandPromptTemplates?: boolean }): unknown;
}
type Exec = (file: string, args: string[], done: () => void) => void;

/** Timing of the night connection; tests shorten it. */
export interface NightTiming {
  /** How long a question waits for Mirador before the dialog opens anyway. */
  questionTimeoutMs?: number;
  /** How long a question waits for the connection itself. */
  connectTimeoutMs?: number;
  /** Reconnect backoff: first delay, doubled up to the max. */
  retryMinMs?: number;
  retryMaxMs?: number;
}

export const BLOCKED_EVENT = 'herdr:blocked';
const SOURCE = 'mirador:attention';
const DEFAULT_LABEL = 'Awaiting input';
const MAX_LABEL = 120;

/** One line of plain text, capped, so the report stays well inside the shim's limits. */
function cleanLabel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_LABEL;
  // eslint-disable-next-line no-control-regex
  const text = value.slice(0, 4096).replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁯﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (!chars.length) return DEFAULT_LABEL;
  return chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL - 1).join('')}…` : text;
}

interface State {
  blocked: string | null;
  prompt: string | null;
  finished: string | null;
}
const TOKENS = ['blocked', 'prompt', 'finished'] as const;
const NOTHING: State = { blocked: null, prompt: null, finished: null };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Turns of this agent, numbered from the bridge's start: `<start>-<n>` is the n-th settled run. */
interface Turns {
  start: number;
  count: number;
}
const turnId = (turns: Turns, n: number): string => `${turns.start}-${n}`;

/** Every handler body runs here: a payload whose getters or proxy traps throw is dropped, never thrown into the agent. */
const safely =
  <A extends unknown[]>(handle: (...args: A) => void) =>
  (...args: A): void => {
    try {
      handle(...args);
    } catch {
      // Best effort: this one event is not reported, the next one still is.
    }
  };

export function createAttentionBridge(options: { env?: NodeJS.ProcessEnv; exec?: Exec; seq?: number; night?: NightTiming } = {}) {
  return (pi: PiLike): void => {
    const env = options.env ?? process.env;
    const pane = env.HERDR_PANE_ID?.trim();
    if (env.GENTLE_PI_AGENTS_CHILD === '1' || env.TERM_PROGRAM !== 'mirador' || env.HERDR_ENV !== '1' || !pane) return;
    const bin = env.HERDR_BIN_PATH?.trim();
    // Like gentle-shell's reporter: start from the clock so a reloaded bridge is never older.
    const turns: Turns = { start: options.seq ?? Date.now(), count: 0 };
    if (bin) reportAttention(pi, env, pane, bin, options, turns);
    const socketPath = env[NIGHT_SOCKET_ENV]?.trim();
    const token = env[NIGHT_TOKEN_ENV]?.trim();
    // The attention reporter counts settled runs; without it, the night half does.
    if (socketPath && token) joinNightShift(pi, { socketPath, token, terminalId: pane, ...options.night }, turns, !bin);
  };
}

function reportAttention(pi: PiLike, env: NodeJS.ProcessEnv, pane: string, bin: string, options: { exec?: Exec }, turns: Turns): void {
  const exec: Exec = options.exec ?? ((file, args, done) => {
    execFile(file, args, { env, timeout: 1500, maxBuffer: 4096, windowsHide: true }, () => done());
  });
  let seq = turns.start;
  let state: State = { ...NOTHING };
  let running = false;
  let pending: State | undefined;
  let last: string | undefined;

  const flush = (): void => {
    if (running || pending === undefined) return;
    const next = pending;
    pending = undefined;
    const key = JSON.stringify(next);
    if (key === last) return;
    const tokens = TOKENS.flatMap((token) => (next[token] === null ? ['--clear-token', token] : ['--token', `${token}=${next[token]}`]));
    const args = ['pane', 'report-metadata', pane, '--source', SOURCE, '--agent', 'pi', '--seq', String(++seq), ...tokens];
    running = true;
    const done = () => {
      running = false;
      last = key;
      flush();
    };
    try {
      exec(bin, args, done);
    } catch {
      // Best effort: a report that cannot start is dropped, the next one still runs.
      running = false;
    }
  };
  const report = (change: Partial<State>): void => {
    state = { ...state, ...change };
    pending = state;
    flush();
  };

  pi.events?.on?.(BLOCKED_EVENT, safely((payload: unknown) => {
    if (!isObject(payload)) return;
    const active = payload.active;
    if (typeof active !== 'boolean') return;
    report({ blocked: active ? cleanLabel(payload.label) : null });
  }));
  // Any dialog the agent waits on: review consent, authorizations, subagent questions…
  // Dialogs can open over each other: the newest open one is reported, and the one
  // under it again once it ends. An end without a known title closes the newest.
  const prompts: string[] = [];
  pi.on?.('ui_prompt_start', safely((event: unknown) => {
    if (!isObject(event)) return;
    prompts.push(cleanLabel(event.title));
    report({ prompt: prompts.at(-1) });
  }));
  pi.on?.('ui_prompt_end', safely((event: unknown) => {
    const title = isObject(event) && typeof event.title === 'string' ? cleanLabel(event.title) : undefined;
    const at = title === undefined ? -1 : prompts.lastIndexOf(title);
    prompts.splice(at < 0 ? prompts.length - 1 : at, 1);
    report({ prompt: prompts.at(-1) ?? null });
  }));
  pi.on?.('agent_start', safely(() => report({ finished: null })));
  pi.on?.('agent_settled', safely(() => report({ finished: turnId(turns, ++turns.count) })));
  // A new, resumed or ending session is not waiting for anything.
  const reset = () => {
    prompts.length = 0;
    report({ ...NOTHING });
  };
  pi.on?.('session_start', safely(reset));
  pi.on?.('session_shutdown', safely(reset));
}

/* ---------- Night shift ---------- */

const QUESTION_TOOLS = new Set(['ask_user_choice', 'ask_user_question']);
const HELD_STATUS_KEY = 'mirador';
const HELD_STATUS = 'Question waiting for your answer on Telegram · Esc to answer it here';
/** Esc as a terminal sends it: plain, kitty keyboard protocol (press or repeat), or xterm modifyOtherKeys. */
const ESCAPE = /^\x1b(?:\[27(?:;1(?::[12])?)?u|\[27;1;27~)?$/;

/** The parts of pi's ctx.ui a held question uses. */
interface HeldUi {
  setStatus?(key: string, text: string | undefined): void;
  onTerminalInput?(handler: (data: string) => { consume?: boolean } | undefined): () => void;
}

/** Calls into pi's UI without ever throwing (a stale ctx may). */
function tryUi<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
const NIGHT_MAX_LINE = 64 * 1024;
const NIGHT_ID = /^[\w-]{1,128}$/;
/** What a question may hold to be forwarded; anything bigger opens the dialog without asking Mirador. */
const MAX_ITEMS = 8;
const MAX_OPTIONS = 8;
const MAX_QUESTION = 4000;
const MAX_HEADER = 200;
const MAX_OPTION_LABEL = 500;
const MAX_DESCRIPTION = 8000;
const MAX_ANSWER = 16 * 1024;
const CUT_MARK = '[…]\n';

/** At most `maxBytes` of UTF-8 from the end of `text`, starting on a whole character, marked when cut. */
function keepEnd(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.max(0, maxBytes - Buffer.byteLength(CUT_MARK));
  // Skip UTF-8 continuation bytes, so no character is cut in half.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return CUT_MARK + bytes.subarray(start).toString('utf8');
}

/**
 * The text of the last assistant message in pi's `agent_end` messages: its text parts
 * joined by newlines (thinking and tool calls left out), at most MAX_FINAL_MESSAGE_BYTES
 * keeping the end. '' when there is none or the payload is odd. Never throws.
 */
export function finalAssistantText(messages: unknown): string {
  try {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message: unknown = messages[i];
      if (!isObject(message) || message.role !== 'assistant') continue;
      const content = message.content;
      if (typeof content === 'string') return keepEnd(content, MAX_FINAL_MESSAGE_BYTES);
      if (!Array.isArray(content)) return '';
      const texts = content.flatMap((part: unknown) => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
      return keepEnd(texts.join('\n'), MAX_FINAL_MESSAGE_BYTES);
    }
    return '';
  } catch {
    return '';
  }
}

/** The `finished` line for a turn, shortened (keeping the end) until it fits the socket's line limit. */
function finishedLine(turn: string, text: string): string {
  let line = JSON.stringify({ type: 'finished', turnId: turn, text }) + '\n';
  // Escaped control characters can grow the JSON well past the text's own size.
  while (Buffer.byteLength(line) > NIGHT_MAX_LINE && text) {
    text = keepEnd(text, Math.floor(Buffer.byteLength(text) / 2));
    line = JSON.stringify({ type: 'finished', turnId: turn, text }) + '\n';
  }
  return line;
}

interface NightConfig extends NightTiming {
  socketPath: string;
  token: string;
  terminalId: string;
}

/** Thrown while reading tool input that cannot be forwarded whole. */
class Unforwardable extends Error {}

function field(value: unknown, max: number, optional = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max) throw new Unforwardable();
  return value;
}

function readOptions(value: unknown, withPreview: boolean): NightQuestionItem['options'] {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) throw new Unforwardable();
  return value.map((option: unknown) => {
    if (!isObject(option)) throw new Unforwardable();
    const description = field(option.description, MAX_DESCRIPTION);
    // ask_user_question shows a preview next to the option: it is part of what the user would read.
    const preview = withPreview ? field(option.preview, MAX_DESCRIPTION, true) : '';
    const full = preview ? `${description}\n\nPreview:\n${preview}` : description;
    if (full.length > MAX_DESCRIPTION) throw new Unforwardable();
    return { label: field(option.label, MAX_OPTION_LABEL), description: full };
  });
}

/**
 * The night question for a question tool call, or null when the input is not
 * exactly what the tool accepts within the size limits. Option values (opaque
 * answer tokens of ask_user_choice) are never included.
 */
export function nightQuestion(toolName: unknown, toolCallId: unknown, input: unknown, terminalId: string): NightQuestion | null {
  try {
    if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 256 || !isObject(input)) return null;
    if (toolName === 'ask_user_choice') {
      const custom = input.allowCustomResponse;
      if (custom !== undefined && typeof custom !== 'boolean') return null;
      const items = [{ question: field(input.question, MAX_QUESTION), header: '', options: readOptions(input.options, false), multiSelect: false }];
      return { terminalId, toolCallId, tool: toolName, items, allowCustomResponse: custom === true };
    }
    if (toolName === 'ask_user_question') {
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length > MAX_ITEMS) return null;
      const items = questions.map((item: unknown): NightQuestionItem => {
        if (!isObject(item) || (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean')) throw new Unforwardable();
        return { question: field(item.question, MAX_QUESTION), header: field(item.header, MAX_HEADER, true), options: readOptions(item.options, true), multiSelect: item.multiSelect === true };
      });
      return { terminalId, toolCallId, tool: toolName, items, allowCustomResponse: false };
    }
    return null;
  } catch {
    return null;
  }
}

/** The session file pi's handler context names, or null; never throws (a stale ctx may). */
function sessionFileOf(ctx: unknown): string | null {
  try {
    if (!isObject(ctx)) return null;
    const manager = ctx.sessionManager;
    if (!isObject(manager) || typeof manager.getSessionFile !== 'function') return null;
    const file: unknown = manager.getSessionFile();
    return typeof file === 'string' && file && file.length <= MAX_SESSION_FILE_CHARS ? file : null;
  } catch {
    return null;
  }
}

/**
 * The bridge's connection to Mirador's night socket. Connects at once and again
 * after every close (backoff doubling from retryMinMs to retryMaxMs); the socket
 * and retry timers never keep the agent's process alive. `greeting` gives the line
 * written right after each hello, if any.
 */
function nightClient(config: NightConfig, deliver: (messageId: unknown, text: unknown) => boolean, greeting: () => string | null) {
  const questionTimeoutMs = config.questionTimeoutMs ?? QUESTION_TIMEOUT_MS;
  const connectTimeoutMs = config.connectTimeoutMs ?? 2000;
  const retryMinMs = config.retryMinMs ?? 1000;
  const retryMaxMs = config.retryMaxMs ?? 30_000;
  let socket: Socket | null = null;
  let connecting: Promise<Socket | null> | null = null;
  let retryDelay = retryMinMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Questions and dialogs waiting for Mirador, by request id; anything else Mirador answers is
   * dropped. A question finishes with Mirador's reason, a dialog (`options`: its option count) with
   * the index the user chose (never a notice: it has none); null always means Mirador will not answer.
   */
  const waiting = new Map<string, { finish: (answer: string | number | null) => void; hold: () => void; held: () => boolean; options?: number; notice?: boolean }>();
  /** Held questions a lost connection cut: Mirador hears `released` for them after the next hello. */
  const cut = new Set<string>();
  const releasedLine = (requestId: string): string => JSON.stringify({ type: 'released', requestId }) + '\n';
  /** A held dialog closed with Mirador's `chosen`. */
  const tookLine = (requestId: string): string => JSON.stringify({ type: 'took', requestId }) + '\n';

  const scheduleRetry = (): void => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryDelay * 2, retryMaxMs);
  };

  const onLine = (line: string, conn: Socket): void => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(value)) return;
    if ((value.type === 'pass' || value.type === 'decided') && typeof value.requestId === 'string') {
      const question = waiting.get(value.requestId);
      if (!question) return;
      const reason = value.reason;
      // Only a well-formed `decided` decides a question; any other answer opens the dialog (a dialog stays as it is).
      question.finish(question.options === undefined && value.type === 'decided' && typeof reason === 'string' && reason.trim() && reason.length <= MAX_ANSWER ? reason : null);
    } else if (value.type === 'chosen' && typeof value.requestId === 'string') {
      const dialog = waiting.get(value.requestId);
      // A notice is answered only in the terminal: a `chosen` for it changes nothing.
      if (dialog?.options === undefined || dialog.notice) return;
      const index = value.index;
      // One it cannot apply changes nothing either: it keeps waiting for a valid one, or the terminal.
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= dialog.options) return;
      dialog.finish(index);
    } else if (value.type === 'held' && typeof value.requestId === 'string' && NIGHT_ID.test(value.requestId)) {
      const question = waiting.get(value.requestId);
      // Its dialog already opened: Mirador must not wait for an answer from Telegram.
      if (question) question.hold();
      else conn.write(releasedLine(value.requestId));
    } else if (value.type === 'message') {
      if (deliver(value.messageId, value.text)) conn.write(JSON.stringify({ type: 'delivered', messageId: value.messageId }) + '\n');
    }
  };

  const connect = (): Promise<Socket | null> => {
    if (socket) return Promise.resolve(socket);
    connecting ??= new Promise<Socket | null>((resolve) => {
      let conn: Socket;
      try {
        conn = createConnection(config.socketPath);
      } catch {
        scheduleRetry();
        return resolve(null);
      }
      conn.unref();
      let chunks: Buffer[] = [];
      let size = 0;
      conn.once('connect', () => {
        retryDelay = retryMinMs;
        socket = conn;
        conn.write(JSON.stringify({ type: 'hello', terminalId: config.terminalId, token: config.token }) + '\n');
        const line = greeting();
        if (line) conn.write(line);
        for (const requestId of cut) conn.write(releasedLine(requestId));
        cut.clear();
        resolve(conn);
      });
      conn.on('data', (chunk: Buffer) => {
        let start = 0;
        let end: number;
        while ((end = chunk.indexOf(0x0a, start)) >= 0) {
          const piece = chunk.subarray(start, end);
          if (size + piece.length > NIGHT_MAX_LINE) return void conn.destroy();
          const line = Buffer.concat([...chunks, piece], size + piece.length).toString('utf8');
          chunks = [];
          size = 0;
          start = end + 1;
          try {
            onLine(line, conn);
          } catch {
            // One bad line is dropped; the connection stays.
          }
        }
        const rest = chunk.subarray(start);
        size += rest.length;
        if (size > NIGHT_MAX_LINE) return void conn.destroy();
        if (rest.length) chunks.push(rest);
      });
      conn.on('error', () => conn.destroy());
      conn.on('close', () => {
        resolve(null);
        if (socket === conn) {
          socket = null;
          for (const [requestId, question] of waiting) {
            if (question.held()) cut.add(requestId);
            question.finish(null);
          }
        }
        scheduleRetry();
      });
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  };

  /** Mirador's reason when it decided `question`; null whenever the dialog should open. */
  const ask = async (question: NightQuestion, signal: AbortSignal | undefined, ui?: HeldUi): Promise<string | null> => {
    if (signal?.aborted) return null;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const conn = await Promise.race([
      connect(),
      new Promise<null>((resolve) => {
        connectTimer = setTimeout(() => resolve(null), connectTimeoutMs);
      }),
    ]);
    clearTimeout(connectTimer);
    if (!conn || conn.destroyed || signal?.aborted) return null;
    const requestId = randomUUID();
    const line = JSON.stringify({ type: 'question', requestId, question }) + '\n';
    if (Buffer.byteLength(line) > NIGHT_MAX_LINE) return null;
    return new Promise<string | null>((resolve) => {
      let held = false;
      let stopInput: (() => void) | undefined;
      const finish = (answer: string | number | null): void => {
        if (!waiting.delete(requestId)) return;
        const reason = typeof answer === 'string' ? answer : null;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (held) {
          tryUi(() => stopInput?.());
          tryUi(() => ui?.setStatus?.(HELD_STATUS_KEY, undefined));
        }
        resolve(reason);
      };
      /** Gives a held question back to its dialog (or, aborted, to nobody) and tells Mirador. */
      const release = (): void => {
        if (held && waiting.has(requestId)) notify(releasedLine(requestId));
        finish(null);
      };
      const onAbort = () => release();
      const hold = (): void => {
        if (held) return;
        held = true;
        clearTimeout(timer);
        tryUi(() => ui?.setStatus?.(HELD_STATUS_KEY, HELD_STATUS));
        stopInput = tryUi(() =>
          ui?.onTerminalInput?.((data) => {
            if (typeof data !== 'string' || !ESCAPE.test(data)) return undefined;
            release();
            return { consume: true };
          }),
        );
      };
      waiting.set(requestId, { finish, hold, held: () => held });
      // Kept referenced: while the agent waits for this answer, the process must stay up.
      const timer = setTimeout(() => finish(null), questionTimeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        conn.write(line);
      } catch {
        finish(null);
      }
    });
  };

  /**
   * Offers Mirador a dialog open in the terminal; resolves with the option index the user chose on
   * Telegram, or null once Mirador will not answer it (not held, `pass`, a lost connection, or
   * `ended`: the terminal dialog ended first, and a held one is then `released`). With the index
   * comes `settle`: the caller tells whether that answer won (Mirador hears `took`) or the
   * terminal's came first (`released`).
   */
  const offer = async (dialog: NightDialog, ended: AbortSignal): Promise<Chosen | null> => {
    if (ended.aborted) return null;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const conn = await Promise.race([
      connect(),
      new Promise<null>((resolve) => {
        connectTimer = setTimeout(() => resolve(null), connectTimeoutMs);
      }),
    ]);
    clearTimeout(connectTimer);
    if (!conn || conn.destroyed || ended.aborted) return null;
    const requestId = randomUUID();
    const line = dialogLine(requestId, dialog);
    if (Buffer.byteLength(line) > NIGHT_MAX_LINE) return null;
    const notice = dialog.notice === true;
    return new Promise<Chosen | null>((resolve) => {
      let held = false;
      const finish = (answer: string | number | null): void => {
        if (!waiting.delete(requestId)) return;
        ended.removeEventListener('abort', onEnded);
        resolve(typeof answer === 'number' ? { index: answer, settle: (won) => notify(won ? tookLine(requestId) : releasedLine(requestId)) } : null);
      };
      const onEnded = (): void => {
        if (held && waiting.has(requestId)) notify(releasedLine(requestId));
        finish(null);
      };
      // No timer and no status line: the terminal dialog is open the whole time.
      waiting.set(requestId, { finish, hold: () => void (held = true), held: () => held, options: dialog.options.length, notice });
      ended.addEventListener('abort', onEnded, { once: true });
      try {
        conn.write(line);
      } catch {
        finish(null);
      }
    });
  };

  /** Writes a line only when connected; never connects, waits or throws. */
  const notify = (line: string): void => {
    try {
      if (socket && !socket.destroyed) socket.write(line);
    } catch {
      // Fire and forget: a line that cannot be written is dropped.
    }
  };

  void connect();
  return { ask, offer, notify };
}

/* ---------- Dialogs ---------- */

type DialogKind = NightDialog['kind'];
type DialogFn = (this: unknown, title: unknown, second: unknown, opts?: unknown) => unknown;
/** Marks the wrappers this bridge installs (any copy of it), so a method is never wrapped twice. */
const WRAPPED = Symbol.for('mirador.night.dialog');
const PATCH_FAILED = "Mirador cannot forward this agent's dialogs to Telegram; they stay in the terminal as usual.";

const dialogLine = (requestId: string, dialog: NightDialog): string => JSON.stringify({ type: 'dialog', requestId, dialog }) + '\n';

/** The user's answer to an offered dialog, and how the bridge tells Mirador whether it won. */
interface Chosen {
  index: number;
  settle: (won: boolean) => void;
}

/** What Mirador hears of a dialog too big to forward: its kind and its title (cut), nothing to answer. */
function noticeOf(dialog: NightDialog): NightDialog {
  const chars = Array.from(dialog.title);
  const title = chars.length > MAX_NOTICE_TITLE_CHARS ? `${chars.slice(0, MAX_NOTICE_TITLE_CHARS - 1).join('')}…` : dialog.title;
  return { terminalId: dialog.terminalId, kind: dialog.kind, title, message: '', options: [], notice: true };
}

/**
 * The night dialog for a select / confirm call (a notice when it is too big to forward whole), or
 * null when it is not exactly what pi takes.
 */
function dialogOf(kind: DialogKind, title: unknown, second: unknown, terminalId: string): NightDialog | null {
  if (typeof title !== 'string') return null;
  let message = '';
  let options: string[];
  if (kind === 'confirm') {
    if (typeof second !== 'string') return null;
    message = second;
    options = [...CONFIRM_OPTIONS];
  } else {
    if (!Array.isArray(second) || second.length < 1 || !second.every((option) => typeof option === 'string')) return null;
    options = [...second] as string[];
  }
  const dialog: NightDialog = { terminalId, kind, title, message, options };
  // Too big to show whole on Telegram: only announced, so no part of it is ever cut.
  if (options.length > MAX_DIALOG_OPTIONS || [title, message, ...options].reduce((sum, part) => sum + part.length, 0) > MAX_DIALOG_CHARS) return noticeOf(dialog);
  // Escaped characters can grow the line past the socket's limit (request ids are UUIDs: 36 characters).
  if (Buffer.byteLength(dialogLine('0'.repeat(36), dialog)) > NIGHT_MAX_LINE) return noticeOf(dialog);
  return dialog;
}

/**
 * Wraps pi's ctx.ui.select / confirm: the original dialog opens as always, with an abort signal
 * merged into the caller's, and the dialog is offered to Mirador. Whichever answers first wins:
 * the terminal's result is returned as is; the user's answer from Telegram closes the terminal
 * dialog (the signal) and returns their option (confirm: Yes → true, No → false). Whatever the
 * original does (a throw, a rejection) reaches the caller unchanged; the wrapper adds no error.
 * A notice is never answered from Telegram, so its dialog gets the caller's options untouched.
 */
function wrapDialog(kind: DialogKind, original: DialogFn, offer: (dialog: NightDialog, ended: AbortSignal) => Promise<Chosen | null>, terminalId: string): DialogFn {
  const wrapper: DialogFn = function (this: unknown, title, second, opts) {
    let dialog: NightDialog | null = null;
    let local: AbortController | null = null;
    let options = opts;
    try {
      const caller = isObject(opts) && opts.signal instanceof AbortSignal ? opts.signal : undefined;
      dialog = caller?.aborted ? null : dialogOf(kind, title, second, terminalId);
      if (dialog) local = new AbortController();
      if (dialog && local && !dialog.notice) options = { ...(isObject(opts) ? opts : {}), signal: caller ? AbortSignal.any([caller, local.signal]) : local.signal };
    } catch {
      dialog = null;
      options = opts;
    }
    const result = original.call(this, title, second, options);
    if (!dialog || !local || !(result instanceof Promise)) return result;
    const found = dialog;
    const end = local;
    return new Promise((resolve, reject) => {
      let settled = false;
      result.then(
        (value) => {
          if (settled) return;
          settled = true;
          end.abort();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          end.abort();
          reject(error);
        },
      );
      offer(found, end.signal).then(
        (chosen) => {
          if (chosen === null) return;
          // The terminal's answer came first: Mirador must not count this one as given.
          if (settled) return chosen.settle(false);
          settled = true;
          // Closes the terminal dialog; its own (empty) result is then ignored.
          end.abort();
          chosen.settle(true);
          resolve(kind === 'confirm' ? chosen.index === 0 : found.options[chosen.index]);
        },
        () => undefined,
      );
    });
  };
  (wrapper as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  return wrapper;
}

function joinNightShift(pi: PiLike, config: NightConfig, turns: Turns, countTurns: boolean): void {
  const deliver = (messageId: unknown, text: unknown): boolean => {
    if (typeof messageId !== 'string' || !NIGHT_ID.test(messageId) || typeof text !== 'string' || !text.trim() || text.length > MAX_ANSWER) return false;
    if (typeof pi.sendUserMessage !== 'function') return false;
    try {
      // Plain text: never run as a command or prompt template.
      const sent = pi.sendUserMessage(text, { deliverAs: 'followUp', expandPromptTemplates: false });
      if (sent instanceof Promise) sent.catch(() => undefined);
    } catch {
      return false;
    }
    return true;
  };
  let sessionLine: string | null = null;
  const client = nightClient(config, deliver, () => sessionLine);
  let patchFailed = false;
  /**
   * Wraps the select / confirm of pi's current ctx.ui (one object per UI binding, rebuilt on bind
   * and reload) unless already wrapped. When it cannot, dialogs stay as they are and the agent's
   * terminal says so once.
   */
  const patchDialogs = (ctx: unknown): void => {
    // A stale ctx throws here: nothing to wrap, and nothing to say.
    const ui = tryUi(() => (isObject(ctx) && ctx.hasUI !== false && isObject(ctx.ui) ? ctx.ui : undefined));
    if (!ui) return;
    try {
      for (const kind of ['select', 'confirm'] as const) {
        const current = ui[kind];
        if (typeof current !== 'function' || (current as unknown as Record<symbol, unknown>)[WRAPPED] === true) continue;
        const wrapper = wrapDialog(kind, current as DialogFn, client.offer, config.terminalId);
        ui[kind] = wrapper;
        if (ui[kind] !== wrapper) throw new Error('ctx.ui is read-only');
      }
    } catch {
      if (patchFailed) return;
      patchFailed = true;
      tryUi(() => (typeof ui.notify === 'function' ? ui.notify(PATCH_FAILED, 'warning') : undefined));
    }
  };
  const reportSession = (ctx: unknown): void => {
    const file = sessionFileOf(ctx);
    if (!file) return;
    sessionLine = JSON.stringify({ type: 'session', file }) + '\n';
    client.notify(sessionLine);
  };

  pi.on?.('tool_call', async (event: unknown, ctx: unknown) => {
    try {
      patchDialogs(ctx);
      if (!isObject(event) || typeof event.toolName !== 'string' || !QUESTION_TOOLS.has(event.toolName)) return undefined;
      const question = nightQuestion(event.toolName, event.toolCallId, event.input, config.terminalId);
      if (!question) return undefined;
      const signal = isObject(ctx) && ctx.signal instanceof AbortSignal ? ctx.signal : undefined;
      const ui = isObject(ctx) && isObject(ctx.ui) ? (ctx.ui as HeldUi) : undefined;
      const reason = await client.ask(question, signal, ui);
      return reason === null ? undefined : { block: true, reason };
    } catch {
      // pi blocks a tool call whose handler throws; on any doubt the dialog opens instead.
      return undefined;
    }
  });

  if (countTurns) pi.on?.('agent_settled', safely(() => void turns.count++));
  // The id the attention token gets when this run settles; a retried run sends it again with its newer text.
  pi.on?.('agent_end', safely((event: unknown) => {
    const messages = isObject(event) ? event.messages : undefined;
    client.notify(finishedLine(turnId(turns, turns.count + 1), finalAssistantText(messages)));
  }));
  // `/new`, `/resume` and `/fork` change the file; a fresh session gets one at its first message.
  pi.on?.('session_start', safely((_event: unknown, ctx: unknown) => reportSession(ctx)));
  // pi builds a new ctx.ui at every UI binding, then emits session_start; the others catch any rebinding missed.
  pi.on?.('session_start', safely((_event: unknown, ctx: unknown) => patchDialogs(ctx)));
  pi.on?.('agent_start', safely((_event: unknown, ctx: unknown) => patchDialogs(ctx)));
  pi.on?.('agent_end', safely((_event: unknown, ctx: unknown) => reportSession(ctx)));
}

export default createAttentionBridge();
