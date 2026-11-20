/**
 * Night shift contract shared by the bridge channel (src/night/channel.ts and
 * src/attention/gentle-shell-bridge.ts) and the decider (src/night/decider.ts).
 *
 * Flow for a question: inside the agent, the bridge's pi `tool_call` handler sees
 * ask_user_choice / ask_user_question, sends a `question` line to Mirador's night
 * socket and waits. Mirador answers `pass` at once unless the night shift is active
 * and the policy allows deciding; then it asks the Decider and answers `decided`
 * (the bridge returns `{ block: true, reason }` to pi, so the dialog never opens and
 * the agent reads the decision) or `pass` (the dialog opens and waits for the user).
 *
 * Held questions: while holding for answers is on, a
 * question left to the user is answered `held` instead of `pass`. The bridge then stops its
 * QUESTION_TIMEOUT_MS timer, shows a status line saying the question waits for an answer from
 * Telegram, and keeps waiting until Mirador answers `decided` (the user answered from Telegram)
 * or `pass` (holding or the autopilot turned off), the connection closes, the user presses the
 * bridge's escape key (Esc, taken only while held), or the agent aborts the call. On the last
 * two the dialog opens (an abort discards it) and the bridge sends `released`, so Mirador ends
 * the held question and a later answer reaches nobody. A `held` the bridge no longer waits for
 * (it timed out first) is answered `released` too; so is every held question a lost
 * connection cut, after the next hello.
 *
 * Dialogs: when an agent opens a blocking pi `select` or
 * `confirm` dialog (a gentle-ai guarded command confirmation, for one), the bridge leaves it open in
 * the terminal and sends a `dialog` line. Mirador answers `held` while the autopilot is on and holding
 * for answers is on (no decider ever sees it), else `pass`. A held dialog ends with `chosen` (the user
 * answered from Telegram: the bridge closes the terminal dialog and returns that option) or `pass`
 * (holding or the autopilot turned off: the terminal dialog stays); when the terminal dialog ends
 * first (answered, Esc, aborted) the bridge sends `released`. The same `released` rules as for held
 * questions apply. A `chosen` the bridge applies is answered `took`, so only then Mirador logs the
 * answer as the user's from Telegram; one that comes once the terminal answered is answered `released`
 * (or nothing, when that `released` already went), and one it cannot apply (an index out of range)
 * is ignored. A held dialog Mirador sent `chosen` for and heard neither from counts as taken after
 * TOOK_GRACE_MS (a bridge that predates `took`).
 *
 * A dialog over MAX_DIALOG_OPTIONS or MAX_DIALOG_CHARS (or whose line would pass 64 KiB) goes as a
 * notice instead: `notice: true`, its kind, its title cut to MAX_NOTICE_TITLE_CHARS, no message and
 * no options. Mirador holds it like any dialog, so its end is told the same way, but it cannot be
 * answered from Telegram (the user answers it in the terminal) and the bridge ignores a `chosen` for it.
 *
 * Flow for a finished agent: Mirador asks the Decider for a follow-up and, when
 * it gives one, sends a `message` line; the bridge delivers it with
 * pi.sendUserMessage(text, { deliverAs: 'followUp' }).
 *
 * Final message of a turn: on pi's `agent_end` the bridge sends a `finished`
 * line with the text parts of the turn's last assistant message (thinking and tool
 * calls left out; at most MAX_FINAL_MESSAGE_BYTES, keeping the end, where a closing
 * question sits) and the turn id the attention `finished` token gets when the run
 * settles. It is fire and forget: sent only while the socket is connected, never
 * waited on. Mirador keeps the latest one per terminal (replaced each turn, dropped
 * on disconnect or exit) and passes it to the decider as NightContext.lastMessage
 * for follow-ups. While the night shift is on, a finished turn is followed up
 * automatically (src/night/service.ts). The text is untrusted model output: it only
 * ever reaches the decider as delimited data.
 *
 * Session file: the bridge sends a `session`
 * line with the agent's pi session file right after `hello`, on every pi
 * `session_start` (`/new`, `/resume` and `/fork` change it) and at every turn end (pi
 * creates the file only at the first message). Mirador keeps it, only when it is an
 * absolute path to an existing `.jsonl` file, to continue that session when it reopens
 * the agent after a restart (src/terminals/open-agents.ts). Additive: a bridge that
 * never sends it works as before.
 */

/** One option exactly as the agent offered it. */
export interface NightOption {
  label: string;
  description: string;
}

/** One question of a questionnaire, or the single question of a choice. */
export interface NightQuestionItem {
  question: string;
  header: string;
  options: NightOption[];
  multiSelect: boolean;
}

/** What the bridge reports when the agent is about to ask the user. */
export interface NightQuestion {
  /** The terminal (pane) id the bridge runs in. */
  terminalId: string;
  /** pi's toolCallId: the bridge's answer must carry it back. */
  toolCallId: string;
  tool: 'ask_user_choice' | 'ask_user_question';
  items: NightQuestionItem[];
  /** ask_user_choice only: the user may type their own answer. */
  allowCustomResponse: boolean;
}

/** Where the question comes from, gathered by the night service for the decider. */
export interface NightContext {
  workspaceId: string;
  workspaceName: string;
  /** Folder relative to the workspace root ('' = the root) and its absolute path. */
  rel: string;
  cwd: string;
  /** The workspace mission (Markdown), '' when unset. */
  mission: string;
  /**
   * The instruction the user delegated to this agent through Mirador,
   * absent when none. Data for the decider: it never widens what the policy allows.
   */
  task?: string;
  /** What the agent said it works on (gentle-shell's active Todo), when known. */
  activity: string | null;
  /** The last lines of the terminal, ANSI stripped, at most 8 KiB. */
  recentOutput: string;
  /**
   * Follow-ups only: the agent's final assistant message of its latest turn,
   * '' when it had no text; absent when the bridge never sent one. Untrusted.
   */
  lastMessage?: string;
  /**
   * Config `ownerName`, the name the decider's prompts and the texts agents receive use for the
   * owner; absent or not valid = "the user" (src/config.ts ownerNameFrom).
   */
  ownerName?: string;
}

/**
 * A blocking pi dialog the bridge forwards: its title, its message (`confirm` only; '' for
 * `select`) and its options as the dialog shows them (`confirm`: Yes, No). Untrusted agent text.
 * A notice (`notice: true`) only announces a dialog too big to forward: title only, no options.
 */
export interface NightDialog {
  /** The terminal (pane) id the bridge runs in. */
  terminalId: string;
  kind: 'select' | 'confirm';
  title: string;
  message: string;
  options: string[];
  notice?: true;
}

/** A dialog with more options, or more text (title, message and labels together), goes as a notice, so its text is never cut. */
export const MAX_DIALOG_OPTIONS = 20;
export const MAX_DIALOG_CHARS = 16_000;
/** A notice dialog's title is cut to this many characters. */
export const MAX_NOTICE_TITLE_CHARS = 300;
/** What a confirm dialog shows (pi's TUI) and returns: Yes → true, No → false. */
export const CONFIRM_OPTIONS = ['Yes', 'No'];

/** The decider's answer to a question. `choices` holds one 0-based option index per item. */
export type NightDecision =
  | { action: 'answer'; choices: number[]; reason: string; confidence: number }
  | { action: 'defer'; reason: string };

/** The decider's answer for an agent that finished its turn. */
export type NightFollowUp =
  | { action: 'follow-up'; message: string; reason: string; confidence: number }
  | { action: 'defer'; reason: string };

/** Implemented by N4. Must never throw: a failure is `{ action: 'defer', reason }`. */
export interface Decider {
  decide(question: NightQuestion, context: NightContext, signal?: AbortSignal): Promise<NightDecision>;
  followUp(context: NightContext, signal?: AbortSignal): Promise<NightFollowUp>;
}

/* ---------- Socket lines (JSON, one per line, each at most 64 KiB) ---------- */

/** Bridge → Mirador. `hello` must come first and carry the terminal's token. */
export type BridgeLine =
  | { type: 'hello'; terminalId: string; token: string }
  | { type: 'question'; requestId: string; question: NightQuestion }
  /** A blocking dialog open in the terminal. */
  | { type: 'dialog'; requestId: string; dialog: NightDialog }
  | { type: 'delivered'; messageId: string }
  /** The turn ended (pi `agent_end`): the final assistant text, at most MAX_FINAL_MESSAGE_BYTES. */
  | { type: 'finished'; turnId: string; text: string }
  /** The agent's pi session file, at most MAX_SESSION_FILE_CHARS. Untrusted: Mirador validates it. */
  | { type: 'session'; file: string }
  /** The held question `requestId` went back to the dialog (escape key, abort, or no longer waited for), or the held dialog ended in the terminal. */
  | { type: 'released'; requestId: string }
  /** The held dialog `requestId` was closed with Mirador's `chosen`: the user's answer from Telegram reached pi. */
  | { type: 'took'; requestId: string };

/** Mirador → bridge. */
export type MiradorLine =
  | { type: 'pass'; requestId: string }
  | { type: 'decided'; requestId: string; reason: string }
  /** Keep waiting, without the question timeout: the user may answer it from Telegram. */
  | { type: 'held'; requestId: string }
  /** The user's answer to a held dialog: the 0-based index of the option they chose. */
  | { type: 'chosen'; requestId: string; index: number }
  | { type: 'message'; messageId: string; text: string };

/** Environment Mirador gives each agent terminal for the night channel. */
export const NIGHT_SOCKET_ENV = 'MIRADOR_NIGHT_SOCKET';
export const NIGHT_TOKEN_ENV = 'MIRADOR_NIGHT_TOKEN';

/** The bridge waits this long for Mirador's answer, then lets the dialog open (pass); a held question has no limit. */
export const QUESTION_TIMEOUT_MS = 5 * 60_000;
/** How long Mirador waits for the bridge's `took` (or `released`) after a `chosen` before it counts the answer as taken. */
export const TOOK_GRACE_MS = 10_000;
/** Below this confidence the night service defers instead of answering. */
export const MIN_CONFIDENCE = 0.7;
/** Cap of a `finished` line's text (UTF-8 bytes); the bridge keeps the end of a longer message. */
export const MAX_FINAL_MESSAGE_BYTES = 32 * 1024;
/** Cap of a `session` line's file path. */
export const MAX_SESSION_FILE_CHARS = 4096;
/** How much of the end of a final message counts as its closing question for the sensitive filters. */
export const FINAL_ASK_CHARS = 1000;

/** The closing part of a final message (its last FINAL_ASK_CHARS characters), where an open question and its options sit. */
export function finalAsk(text: string): string {
  const chars = Array.from(text);
  return chars.length > FINAL_ASK_CHARS ? chars.slice(-FINAL_ASK_CHARS).join('') : text;
}
