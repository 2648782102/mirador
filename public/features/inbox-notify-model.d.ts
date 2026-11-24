// Types for public/features/inbox-notify-model.js, for the TypeScript that imports it (its tests).
// The browser never loads this file: no page or module imports it, and the bundle (src/http/bundle.ts)
// follows imports from public/'s entry points only.

/** The fields of an inbox item a notification reads; the stream sends more. */
export interface NotifyCard {
  terminalId: unknown;
  since: unknown;
  /** 'blocked' and 'prompt' ask something of the user; 'error' and 'finished' do not. */
  kind?: unknown;
  /** The folder in its workspace, '' at the root. */
  rel?: unknown;
  /** The question or the detail, agent text. */
  detail?: unknown;
  /** Why it waits; a blocked card hides the detail, agent and path unless this is one of QUESTION_LABELS. */
  label?: unknown;
}

/** localStorage keys (core.js prefs): notices that ask stay on screen (default on); discreet mode (default off). */
export const NOTIFY_STAY_PREF: 'inboxNotifyStay';
export const NOTIFY_DISCREET_PREF: 'inboxNotifyDiscreet';
/** gentle-shell's blocker label for a guarded command: its notice shows only the project and the reason. */
export const GUARDED_LABEL: 'Guarded command confirmation';
/** gentle-shell's blocker labels that ask a question (matched trimmed, in any case): the only blocked cards whose notice shows the detail. */
export const QUESTION_LABELS: readonly ['Questionnaire awaiting input', 'Choice awaiting input'];
/** New cards within the page's window from which one notification stands for all of them. */
export const GROUP_AT: 3;
/** The burst notification's tag. */
export const GROUP_TAG: 'mirador-inbox:group';

/** What every notification takes besides its card. */
export interface NotifyWords {
  /** The interface language (`lang`). */
  lang?: string;
  /** Cards that ask stay on screen until the user acts (default true). */
  stay?: boolean;
  /** No project, question or path (default false). */
  discreet?: boolean;
  /** "An agent is waiting for you" / "{count} agents are waiting for you" (English without it). */
  waiting?: (count: number) => string;
}

/** One card's text: its reason (translated), its workspace's name and its agent's name (null when unknown). */
export interface NotifyCardText extends NotifyWords {
  reason: string;
  workspace: string;
  agent?: string | null;
}

export interface NotifyOptions {
  body: string;
  tag: string;
  requireInteraction: boolean;
  icon: string;
  badge: string;
  lang?: string;
  /** When the wait started (ms since the epoch). */
  timestamp?: number;
}

export interface NotifyText {
  title: string;
  options: NotifyOptions;
}

/** One line of agent text: no line breaks, control or format characters (the zero-width joiner stays), cut to `max` (120) characters. */
export function agentText(text: unknown, max?: number): string;
/** A blocker or a dialog asks something of the user. */
export function asksYou(item: { kind?: unknown }): boolean;
/** One card's notification: "{project} · {reason}", the question, then "{agent} · {path}" (no body for a blocked card unless it asks a known question). */
export function cardNotification(item: NotifyCard, text: NotifyCardText): NotifyText;
/** A burst's notification: how many wait and their projects, under GROUP_TAG. */
export function groupNotification(entries: ReadonlyArray<{ item: NotifyCard; workspace: string }>, text: NotifyWords & { waiting: (count: number) => string }): NotifyText;
