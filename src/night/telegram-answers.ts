import { randomBytes } from 'node:crypto';
import { shortLine } from './notify.ts';
import { MAX_MESSAGE_CHARS, TelegramError, callTelegram, messageText, type TelegramCredentials, type TelegramStore } from './telegram.ts';

/**
 * Answering from Telegram the questions the autopilot leaves to the user.
 *
 * While the user's bot is configured for a private chat and "Responder desde Telegram" is on, the night
 * service holds those questions (holdForAnswers) instead of opening their dialog, and each held
 * question arrives as one message: which decision waits, where and why, its options, and one
 * inline button per option. Updates come by getUpdates long polling (no webhook, nothing
 * listens on the network), asking only for button taps.
 *
 * Every button carries an opaque random token (16 characters, well under Telegram's 64 bytes)
 * that names one action on one question; a tap spends every token of that message, and the
 * message is redrawn with new ones when it stays open, so a token works once and a replayed or
 * unknown one does nothing. A tap counts only from the configured chat, by its owner (in a
 * private chat both ids are the chat id), on the very message the token was sent with; every
 * tap gets its answerCallbackQuery. When the question ends (answered, released to the terminal,
 * the terminal closed or the autopilot off) the message is edited to say so, without buttons.
 *
 * Dialogs: a held pi select / confirm dialog (a guarded
 * command confirmation, for one) arrives the same way with its title and its whole message, never
 * cut, and one button per option as the dialog shows it (confirm: «Sí», «No»). Every dialog asks
 * for «Confirmar» before the answer is sent. It is also open in the terminal: when it ends there,
 * the message says so. A dialog too long for one message goes in two: first its whole text as
 * a document (`dialogo.txt`, sendDocument, no buttons), and only once Telegram took it the buttons
 * message, replying to it, with a summary instead of the whole text; a refused document is sent
 * again like a refused message, and its buttons never go without it. A notice (a dialog the bridge
 * found too big to forward) arrives without buttons: which agent waits and to answer it on the
 * laptop. A dialog's text is shown whole: only clear credentials are covered, each marked
 * «[credencial oculta]» (shortLine's generic redaction of long runs is for questions only).
 * A confirmed answer to a dialog is only sent:
 * the message says «Enviando respuesta…», without buttons, until the service tells its end:
 * `answered` (its bridge took it) «✓ Respondido desde Telegram: …», `terminal` (the terminal
 * answered first) the usual terminal line. A question's answer is final at once.
 */

export interface HeldOption {
  label: string;
  description: string;
}

export interface HeldItem {
  question: string;
  header: string;
  options: HeldOption[];
  multiSelect: boolean;
}

/** A question the night service holds for the user's answer (src/night/service.ts). */
export interface HeldQuestion {
  /** Short and opaque (at most 16 characters). */
  id: string;
  terminalId: string;
  workspaceId: string | null;
  workspaceName: string;
  rel: string | null;
  tool: string | null;
  items: HeldItem[];
  /** A held dialog's kind and texts; absent for a question. A notice has no message and no options. */
  dialog?: { kind: 'select' | 'confirm'; title: string; message: string; notice?: true };
  reason: string;
  rule: string;
  /** What makes it sensitive, or null. */
  sensitive: string | null;
  since: string;
}

export type HeldEnd = 'answered' | 'terminal' | 'closed' | 'stopped';
export type HeldAnswer = { ok: true } | { ok: false; code: 'unknown' | 'ended' | 'invalid' };

/** The held-question side of the night service. */
export interface HeldQuestions {
  holdForAnswers(enabled: boolean): void;
  onHeld(listener: (question: HeldQuestion) => void): (() => void) | void;
  heldQuestions(): HeldQuestion[];
  answerHeld(id: string, choices: number[][], source: 'telegram'): HeldAnswer;
  onHeldEnd(listener: (id: string, outcome: HeldEnd) => void): (() => void) | void;
}

export interface TelegramAnswersOptions {
  service: HeldQuestions;
  /** The bot, its chat and the "answer from Telegram" setting. */
  store: TelegramStore;
  fetch?: typeof globalThis.fetch;
  /** The Bot API base (tests: a fake server). */
  apiBase?: string;
  log?: (line: string) => void;
  /** getUpdates' long-poll wait in seconds (default 25). */
  pollTimeoutS?: number;
  /** The first wait after a failed poll, doubled up to a minute (default 5 s). */
  retryMs?: number;
  /** Makes one button token (default: 12 random bytes as base64url). Tests pass a seeded one. */
  token?: () => string;
}

export interface TelegramAnswers {
  /** Reads the store again and starts or stops answering to match it. */
  refresh(): Promise<void>;
  /** Stops polling and releases the held questions to their terminals. */
  close(): Promise<void>;
}

/** Only a private chat (a positive id, equal to its owner's user id) can answer. */
export const isPrivateChat = (chatId: string): boolean => /^[1-9]\d{0,19}$/.test(chatId);

/** `pick` an option, `send` the picks of a multi-option message, `confirm` or go `back` from a sensitive answer. */
type Action = { kind: 'pick'; item: number; index: number } | { kind: 'send' } | { kind: 'confirm' } | { kind: 'back' };

interface Thread {
  held: HeldQuestion;
  /** The bot and chat it was sent with; its edits go there. */
  credentials: TelegramCredentials;
  messageId: number | null;
  /** The tokens of the buttons shown now. */
  tokens: string[];
  /** How it ended before its message was sent: the edit waits for the send. */
  ended: string | null;
  /** The options marked so far, per item (several items or multi-select). */
  picks: number[][];
  /** A sensitive answer waiting for «Confirmar». */
  confirming: number[][] | null;
  /** Delivery attempts so far (the document, then the message); one is in flight while `sending`. */
  tries: number;
  sending: boolean;
  /** A dialog too long for one message: its whole text goes first as a document, and the message replies to it. */
  long: boolean;
  /** That document, once Telegram took it. */
  documentId: number | null;
  /** A dialog's answer handed to the service, as labels: its end says whether it reached the agent. */
  answered: string[] | null;
  /** While answerHeld runs; an end the service tells meanwhile waits in `told`. */
  handing: boolean;
  told: HeldEnd | null;
  /** Its edits, in order: an end line never lands before an earlier edit. */
  edits: Promise<unknown>;
}

const MAX_UPDATES = 100;
const MAX_DATA_BYTES = 64;
const MAX_RETRY_MS = 60_000;
/** A refused message is sent again before the next polls, up to this many tries in all. */
const MAX_SEND_TRIES = 3;

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The last line of a message whose question ended without its tap. */
const END_LINES: Record<HeldEnd, string> = {
  answered: '✓ Respondida.',
  terminal: 'Ya no espera aquí: quedó para responder en la terminal.',
  closed: 'Ya no espera respuesta: la terminal se cerró.',
  stopped: 'Ya no espera aquí: el piloto automático se apagó; respóndela en la terminal.',
};

/** The same ends, said of a dialog that is also open in the terminal. */
const DIALOG_END_LINES: Record<HeldEnd, string> = {
  answered: '✓ Respondido.',
  terminal: 'Ya no espera aquí: se respondió en la terminal o quedó para responder allí.',
  closed: 'Ya no espera respuesta: la terminal se cerró.',
  stopped: 'Ya no espera aquí: el piloto automático se apagó; respóndelo en la terminal.',
};
/** How a confirm dialog's Yes / No read on Telegram. */
const CONFIRM_LABELS = ['Sí', 'No'];
/** A dialog's texts are bounded by the bridge (MAX_DIALOG_CHARS): its lines are shown whole, never cut. */
const WHOLE = 16_000;
/** Room kept in a dialog's message for what is added below its text (the confirmation, the end line). */
const MESSAGE_RESERVE = 200;
/** In the buttons message of a long dialog (its whole text is in the document). */
const SUMMARY_TITLE = 300;
const SUMMARY_LABEL = 120;
const DOCUMENT_NAME = 'dialogo.txt';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const messageIdOf = (result: unknown): number | null => (isRecord(result) && Number.isSafeInteger(result.message_id) ? (result.message_id as number) : null);
const quoted = (labels: string[]) => labels.map((label) => `«${label}»`).join(', ');

/** How a covered credential reads. */
const HIDDEN = '[credencial oculta]';
const CREDENTIAL_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&;|]+)`;
/**
 * Clear credentials: a Telegram bot token, known key prefixes, and the value after
 * `Authorization:` (with its scheme), `Bearer`, `--token` / `--password`, or `…password=`,
 * `…token=`, `…secret=`, `…password:`, `…token:`, `…secret:` (the name stays, `keep`); a JSON
 * string whose key ends in password, token or secret (the key and quotes stay, `json`); and the
 * password of a URL's user info (scheme and user stay, `url`).
 * Nothing else: commit SHAs, paths and base64 stay readable.
 */
const CREDENTIAL = new RegExp(
  [
    String.raw`(?<![\w-])\d{5,}:[A-Za-z0-9_-]{30,}`,
    // A key may follow a slash (https://ghp_…@github.com); a path segment shaped like a key is covered too, the safe side.
    String.raw`(?<![\w.-])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,})`,
    String.raw`(?<keep>\bAuthorization[ \t]*[:=][ \t]*(?:(?:Bearer|Basic|Token|Bot)[ \t]+)?|\bBearer[ \t]+|--(?:token|password)(?:=|[ \t]+)|(?<![\w-])[\w-]*(?:password|token|secret)(?:=|[ \t]*:[ \t]*))${CREDENTIAL_VALUE}`,
    String.raw`(?<json>"[\w-]*(?:password|token|secret)"[ \t]*:[ \t]*")(?:[^"\\\n]|\\.)+(?=")`,
    String.raw`(?<url>\b[a-z][a-z\d+.-]*://[^\s/:@]+:)[^\s/@]+(?=@)`,
  ].join('|'),
  'gi',
);

/** `text` with its clear credentials, and the bot's own token anywhere, covered by «[credencial oculta]». */
function hideCredentials(text: string, botToken: string): string {
  const covered = text.replace(CREDENTIAL, (...args) => {
    const groups = args.at(-1) as { keep?: string; json?: string; url?: string };
    return `${groups.keep ?? groups.json ?? groups.url ?? ''}${HIDDEN}`;
  });
  const secret = botToken.split(':')[1];
  return [botToken, ...(secret && secret.length >= 16 ? [secret] : [])].reduce((value, part) => value.split(part).join(HIDDEN), covered);
}

/** One line of a dialog's text: control and format characters become spaces, credentials covered, capped. */
function dialogLine(value: unknown, max: number, botToken: string): string {
  const text = hideCredentials(String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim(), botToken);
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** How agent text becomes one line: a dialog's as S9 says, a question's as every notice does (shortLine). */
const lineFor = (held: HeldQuestion, botToken: string) => (value: unknown, max: number) => (held.dialog ? dialogLine(value, max, botToken) : shortLine(value, max));

/** One tap on an option answers; otherwise options are marked and sent with «Enviar respuesta». */
const oneTap = (held: HeldQuestion) => held.items.length === 1 && !held.items[0].multiSelect;

/** An option as the user reads it: a confirm dialog's Yes / No in Spanish, any other as the agent wrote it. */
const optionLabel = (held: HeldQuestion, item: number, index: number): string | undefined =>
  held.dialog?.kind === 'confirm' ? CONFIRM_LABELS[index] : held.items[item]?.options[index]?.label;

const labelsOf = (held: HeldQuestion, choices: number[][], botToken: string) => choices.flatMap((list, i) => list.map((index) => lineFor(held, botToken)(optionLabel(held, i, index), 60)));

/** A dialog's text kept line by line (control characters out, credentials covered), each line whole. */
const block = (value: string, botToken: string): string[] => value.split('\n').map((line) => dialogLine(line, WHOLE, botToken)).filter((line, i, lines) => line || (i > 0 && lines[i - 1]));

type Dialog = NonNullable<HeldQuestion['dialog']>;
const placeOf = (held: HeldQuestion) => shortLine(held.rel ? `${held.workspaceName} / ${held.rel}` : held.workspaceName, 80);
/** What waits, as the user reads it: gentle-ai titles its guarded command confirmations "Allow guarded actions: …". */
const whatOf = (dialog: Dialog) => (/guarded/i.test(dialog.title) ? 'un comando protegido' : 'un diálogo');

/** A dialog's message: whole, or (`whole` false: its document holds the whole text) a summary. A notice says to answer it on the laptop. */
function dialogText(held: HeldQuestion, dialog: Dialog, botToken: string, whole: boolean): string {
  const topic = held.sensitive && held.sensitive !== 'dialog' ? shortLine(held.sensitive, 160) : 'diálogo de la terminal';
  const lines = [`⚠ sensible: ${topic}`, 'Mirador: un agente espera tu respuesta en su terminal', placeOf(held), ''];
  if (dialog.notice) {
    lines.push(dialogLine(dialog.title, SUMMARY_TITLE, botToken), '', `Es ${whatOf(dialog)} demasiado largo para Telegram (texto u opciones): respóndelo en el laptop.`);
    return lines.join('\n');
  }
  if (whole) {
    lines.push(...block(dialog.title, botToken));
    if (dialog.message) lines.push(...block(dialog.message, botToken));
  } else {
    lines.push(dialogLine(dialog.title, SUMMARY_TITLE, botToken), '', 'El texto completo está en el archivo adjunto.');
  }
  lines.push('');
  held.items[0]?.options.forEach((_option, j) => lines.push(`${j + 1}) ${dialogLine(optionLabel(held, 0, j), whole ? WHOLE : SUMMARY_LABEL, botToken)}`));
  lines.push('', 'También puedes responderlo en la terminal.');
  return lines.join('\n');
}

/** The attached file of a long dialog: all of it, line by line as the agent wrote it, only control characters out and credentials covered. */
function documentText(held: HeldQuestion, dialog: Dialog, botToken: string): string {
  const clean = (value: string) => hideCredentials(value.replace(/\r\n?/g, '\n').replace(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, ' '), botToken);
  const lines = [`Mirador: ${whatOf(dialog)} espera tu respuesta en su terminal`, placeOf(held), '', clean(dialog.title)];
  if (dialog.message) lines.push('', clean(dialog.message));
  lines.push('', 'Opciones:');
  held.items[0]?.options.forEach((_option, j) => lines.push(`${j + 1}) ${dialogLine(optionLabel(held, 0, j), WHOLE, botToken)}`));
  lines.push('', 'Responde con los botones del mensaje siguiente (siempre con «Confirmar»), o en la terminal.');
  return `${lines.join('\n')}\n`;
}

function questionText(held: HeldQuestion, botToken: string, long = false): string {
  if (held.dialog) return dialogText(held, held.dialog, botToken, !long);
  const lines: string[] = held.sensitive ? [`⚠ sensible: ${shortLine(held.sensitive, 160) || 'requiere tu confirmación'}`] : [];
  lines.push('Mirador: una decisión espera tu respuesta', shortLine(held.rel ? `${held.workspaceName} / ${held.rel}` : held.workspaceName, 80));
  held.items.forEach((item, i) => {
    const header = shortLine(item.header, 40);
    lines.push('', `${held.items.length > 1 ? `${i + 1}. ` : ''}${header ? `${header}: ` : ''}${shortLine(item.question, 300)}`);
    item.options.forEach((option, j) => {
      const description = shortLine(option.description, 160);
      lines.push(`${j + 1}) ${shortLine(option.label, 120)}${description ? ` — ${description}` : ''}`);
    });
    if (item.multiSelect) lines.push('(puedes elegir varias)');
  });
  lines.push('', `Por qué te espera: ${shortLine(held.reason, 200) || 'sin motivo'}`);
  return lines.join('\n');
}

class Answers implements TelegramAnswers {
  private readonly options: TelegramAnswersOptions;
  private readonly log: (line: string) => void;
  private credentials: TelegramCredentials | null = null;
  private readonly threads = new Map<string, Thread>();
  private readonly buttons = new Map<string, { id: string; action: Action }>();
  private offset = 0;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(options: TelegramAnswersOptions) {
    this.options = options;
    this.log = options.log ?? ((line) => console.error(line));
    const { service } = options;
    const off = [service.onHeld((held) => this.adopt(held)), service.onHeldEnd((id, outcome) => this.ended(id, outcome))];
    for (const stop of off) if (typeof stop === 'function') this.unsubscribe.push(stop);
  }

  async refresh(): Promise<void> {
    const credentials = await this.options.store.read();
    const wanted = credentials && (await this.options.store.answers()) === true && isPrivateChat(credentials.chatId) ? credentials : null;
    const current = this.credentials;
    if (wanted && current && wanted.botToken === current.botToken && wanted.chatId === current.chatId) return;
    // Turning off (or moving to another bot or chat) gives the held questions back to their terminals.
    if (!wanted || current) await this.stop();
    if (!wanted) return;
    this.credentials = wanted;
    this.options.service.holdForAnswers(true);
    for (const held of this.options.service.heldQuestions()) this.adopt(held);
    const abort = new AbortController();
    this.abort = abort;
    this.loop = this.poll(wanted, abort.signal);
  }

  async close(): Promise<void> {
    await this.stop();
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.threads.clear();
  }

  /**
   * Releases what is held and stops polling; every button stops working. A released question's
   * message is still edited when the service tells how it ended.
   */
  private async stop(): Promise<void> {
    this.options.service.holdForAnswers(false);
    this.abort?.abort();
    await this.loop;
    this.abort = null;
    this.loop = null;
    this.credentials = null;
    this.buttons.clear();
    for (const thread of this.threads.values()) thread.tokens = [];
  }

  /** Calls a method whose failure is only logged (its message never holds the token). */
  private quietly(credentials: TelegramCredentials, method: string, body: Record<string, unknown> | FormData): Promise<unknown> {
    return callTelegram(credentials, method, body, { fetch: this.options.fetch, apiBase: this.options.apiBase }).catch((error) => {
      this.log(`mirador: Telegram ${method} failed: ${error instanceof TelegramError ? error.message : 'error'}`);
      return null;
    });
  }

  private adopt(held: HeldQuestion): void {
    const { credentials } = this;
    if (!credentials || this.threads.has(held.id)) return;
    const { dialog } = held;
    const long = !!dialog && !dialog.notice && Array.from(dialogText(held, dialog, credentials.botToken, true)).length > MAX_MESSAGE_CHARS - MESSAGE_RESERVE;
    const thread: Thread = {
      held, credentials, messageId: null, tokens: [], ended: null, picks: held.items.map(() => []), confirming: null, tries: 0, sending: false, long, documentId: null,
      answered: null, handing: false, told: null, edits: Promise.resolve(),
    };
    this.threads.set(held.id, thread);
    this.send(thread);
  }

  private send(thread: Thread): void {
    thread.tries++;
    thread.sending = true;
    void this.deliver(thread).then(() => {
      thread.sending = false;
      if (thread.messageId !== null && thread.ended !== null) this.edit(thread, thread.ended);
    });
  }

  /** Sends the document first when the thread needs one; the message goes only once Telegram took it, as a reply to it. */
  private async deliver(thread: Thread): Promise<void> {
    const { credentials, held } = thread;
    if (thread.long && held.dialog && thread.documentId === null) {
      const what = whatOf(held.dialog);
      const form = new FormData();
      form.append('chat_id', credentials.chatId);
      form.append('caption', `⚠ Mirador: ${what} espera tu respuesta en ${placeOf(held)}. No cabe en un mensaje: lee el archivo adjunto; los botones van en el mensaje siguiente.`);
      form.append('document', new Blob([documentText(held, held.dialog, credentials.botToken)], { type: 'text/plain;charset=utf-8' }), DOCUMENT_NAME);
      thread.documentId = messageIdOf(await this.quietly(credentials, 'sendDocument', form));
      if (thread.documentId === null) return;
    }
    const reply = thread.documentId === null ? {} : { reply_parameters: { message_id: thread.documentId } };
    thread.messageId = messageIdOf(await this.quietly(credentials, 'sendMessage', { chat_id: credentials.chatId, ...this.view(thread), ...reply, disable_web_page_preview: true }));
  }

  /** Sends again the messages (or documents) Telegram refused (their questions still held). */
  private resend(): void {
    for (const thread of this.threads.values()) {
      if (thread.messageId === null && !thread.sending && thread.tries < MAX_SEND_TRIES && thread.credentials === this.credentials) this.send(thread);
    }
  }

  private ended(id: string, outcome: HeldEnd): void {
    const thread = this.threads.get(id);
    if (!thread) return;
    if (thread.handing) return void (thread.told = outcome);
    const answered = outcome === 'answered' ? thread.answered : null;
    this.finish(thread, answered ? `✓ Respondido desde Telegram: ${quoted(answered)}` : (thread.held.dialog ? DIALOG_END_LINES : END_LINES)[outcome]);
  }

  private text(thread: Thread): string {
    return questionText(thread.held, thread.credentials.botToken, thread.long);
  }

  /** Spends the tokens shown now. */
  private revoke(thread: Thread): void {
    for (const token of thread.tokens.splice(0)) this.buttons.delete(token);
  }

  private button(thread: Thread, text: string, action: Action) {
    const token = this.options.token ? this.options.token() : randomBytes(12).toString('base64url');
    this.buttons.set(token, { id: thread.held.id, action });
    thread.tokens.push(token);
    return { text, callback_data: token };
  }

  /** The message with fresh buttons (a notice has none). */
  private view(thread: Thread): { text: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
    this.revoke(thread);
    const { held, picks, confirming } = thread;
    const line = lineFor(held, thread.credentials.botToken);
    if (held.dialog?.notice) return { text: messageText(this.text(thread)) };
    if (confirming) {
      const labels = quoted(labelsOf(held, confirming, thread.credentials.botToken));
      return {
        text: messageText(`${this.text(thread)}\n\nVas a responder: ${labels}. Toca «Confirmar» para enviarla.`),
        reply_markup: { inline_keyboard: [[this.button(thread, line(`Confirmar ${labels}`, 64), { kind: 'confirm' })], [this.button(thread, 'Volver', { kind: 'back' })]] },
      };
    }
    const single = oneTap(held);
    const rows = held.items.flatMap((item, i) =>
      item.options.map((option, j) => {
        const picked = picks[i].includes(j);
        const mark = single ? '' : item.multiSelect ? (picked ? '☑ ' : '☐ ') : picked ? '● ' : '○ ';
        const text = `${held.items.length > 1 ? `${i + 1}· ` : ''}${mark}${line(optionLabel(held, i, j) ?? option.label, 60) || `${j + 1}`}`;
        return [this.button(thread, text, { kind: 'pick', item: i, index: j })];
      }),
    );
    if (!single) rows.push([this.button(thread, 'Enviar respuesta', { kind: 'send' })]);
    const hint = single ? 'Toca una opción para responder.' : 'Marca tus opciones y toca «Enviar respuesta».';
    return { text: messageText(`${this.text(thread)}\n\n${hint}`), reply_markup: { inline_keyboard: rows } };
  }

  /** Shows the message again with fresh buttons (the ones just used stop working). */
  private redraw(thread: Thread): void {
    if (thread.messageId === null) return;
    const view = this.view(thread);
    void this.quietly(thread.credentials, 'editMessageText', { chat_id: thread.credentials.chatId, message_id: thread.messageId, ...view, disable_web_page_preview: true });
  }

  /** Ends a message: its text says how, and its buttons go. */
  private finish(thread: Thread, line: string): void {
    this.revoke(thread);
    this.threads.delete(thread.held.id);
    if (thread.messageId === null) thread.ended = line;
    else this.edit(thread, line);
  }

  private edit(thread: Thread, line: string): void {
    if (thread.messageId === null) return;
    const body = { chat_id: thread.credentials.chatId, message_id: thread.messageId, text: messageText(`${this.text(thread)}\n\n${line}`) };
    thread.edits = thread.edits.then(() => this.quietly(thread.credentials, 'editMessageText', body));
  }

  private async poll(credentials: TelegramCredentials, signal: AbortSignal): Promise<void> {
    const timeoutS = this.options.pollTimeoutS ?? 25;
    let failures = 0;
    while (!signal.aborted) {
      this.resend();
      let updates: unknown[];
      try {
        const result = await callTelegram(
          credentials,
          'getUpdates',
          { offset: this.offset, timeout: timeoutS, limit: MAX_UPDATES, allowed_updates: ['callback_query'] },
          { fetch: this.options.fetch, apiBase: this.options.apiBase, timeoutMs: (timeoutS + 10) * 1000, signal },
        );
        if (!Array.isArray(result)) throw new TelegramError('telegram_failed', 'Telegram answered getUpdates without a list');
        updates = result;
      } catch (error) {
        if (signal.aborted) return;
        // One line per run of failures; a 409 means another program reads this bot's updates.
        if (failures++ === 0) this.log(`mirador: Telegram answers could not read updates: ${error instanceof TelegramError ? error.message : 'error'}`);
        const retryAfter = error instanceof TelegramError && error.retryAfter !== null ? error.retryAfter * 1000 : null;
        await pause(retryAfter ?? Math.min((this.options.retryMs ?? 5000) * 2 ** (failures - 1), MAX_RETRY_MS), signal);
        continue;
      }
      failures = 0;
      for (const update of updates.slice(0, MAX_UPDATES)) {
        if (signal.aborted) return;
        if (isRecord(update) && Number.isSafeInteger(update.update_id)) this.offset = Math.max(this.offset, (update.update_id as number) + 1);
        await this.tap(update, credentials);
      }
    }
  }

  private async tap(update: unknown, credentials: TelegramCredentials): Promise<void> {
    const query = isRecord(update) ? update.callback_query : null;
    if (!isRecord(query) || typeof query.id !== 'string') return;
    const ack = (text?: string) => this.quietly(credentials, 'answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) });
    const message = isRecord(query.message) ? query.message : null;
    const chat = message && isRecord(message.chat) ? message.chat.id : null;
    const user = isRecord(query.from) ? query.from.id : null;
    // Anyone else is told nothing and changes nothing.
    const owner = credentials.chatId;
    if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(user) || String(chat) !== owner || String(user) !== owner) return void (await ack());
    const button = typeof query.data === 'string' && Buffer.byteLength(query.data) <= MAX_DATA_BYTES ? this.buttons.get(query.data) : undefined;
    const thread = button ? this.threads.get(button.id) : undefined;
    if (!button || !thread || thread.messageId === null || message?.message_id !== thread.messageId) return void (await ack('Este botón ya no sirve.'));
    const { action } = button;
    const { held } = thread;
    if (action.kind === 'confirm') return thread.confirming ? this.submit(thread, thread.confirming, ack) : void (await ack('Este botón ya no sirve.'));
    if (action.kind === 'back') {
      thread.confirming = null;
      this.redraw(thread);
      return void (await ack());
    }
    if (action.kind === 'pick' && !oneTap(held)) {
      const list = thread.picks[action.item];
      const at = list.indexOf(action.index);
      if (at >= 0) list.splice(at, 1);
      else if (held.items[action.item].multiSelect) list.push(action.index), list.sort((a, b) => a - b);
      else list.splice(0, list.length, action.index);
      this.redraw(thread);
      return void (await ack());
    }
    const choices = action.kind === 'pick' ? [[action.index]] : thread.picks.map((list) => [...list]);
    if (choices.some((list) => list.length === 0)) {
      this.redraw(thread);
      return void (await ack(held.items.length > 1 ? 'Elige una opción en cada pregunta.' : 'Elige al menos una opción.'));
    }
    // A dialog is always confirmed, whatever the service marked.
    if (held.sensitive || held.dialog) {
      thread.confirming = choices;
      this.redraw(thread);
      return void (await ack('Confirma tu respuesta: es sensible.'));
    }
    await this.submit(thread, choices, ack);
  }

  private async submit(thread: Thread, choices: number[][], ack: (text?: string) => Promise<unknown>): Promise<void> {
    const labels = labelsOf(thread.held, choices, thread.credentials.botToken);
    const { id, dialog } = thread.held;
    this.revoke(thread);
    // A question leaves the map first: the service may tell its end while answering it. A dialog's
    // end comes later and says whether the answer reached the agent; one told meanwhile waits.
    if (dialog) thread.handing = true;
    else this.threads.delete(id);
    const result = this.options.service.answerHeld(id, choices, 'telegram');
    thread.handing = false;
    if (result.ok && dialog) {
      thread.answered = labels;
      thread.confirming = null;
      if (thread.told) this.ended(id, thread.told);
      else this.edit(thread, 'Enviando respuesta…');
      return void (await ack('Respuesta enviada.'));
    }
    this.threads.delete(id);
    if (result.ok) {
      this.finish(thread, `✓ Respondida desde Telegram: ${quoted(labels)}`);
      return void (await ack('Respuesta enviada.'));
    }
    if (result.code === 'invalid') {
      this.threads.set(thread.held.id, thread);
      thread.confirming = null;
      this.redraw(thread);
      return void (await ack('Mirador no aceptó esa respuesta; elige de nuevo.'));
    }
    this.finish(thread, 'Ya no espera respuesta.');
    await ack('Esta pregunta ya no espera respuesta.');
  }
}

export function startTelegramAnswers(options: TelegramAnswersOptions): TelegramAnswers {
  return new Answers(options);
}
