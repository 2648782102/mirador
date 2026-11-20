import { chmod, mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from '../config.ts';
import type { Notice, NoticeTopic, NotifyChannel } from './notify.ts';

/**
 * Night notifications on the user's phone through their own Telegram bot.
 *
 * The bot token is a secret: it lives only in `<stateDir>/telegram.json` (folder 0700,
 * file 0600), goes out only in the URL of the HTTPS request to api.telegram.org (never in
 * process arguments), and is never logged, returned by the API or put in an error. A
 * file that others can read is ignored. Messages are plain text (no parse mode).
 *
 * The same file keeps whether the user answers held questions from Telegram
 * (src/night/telegram-answers.ts): `answers`, on
 * unless saved as false, kept when a new token or chat is saved.
 */

export interface TelegramCredentials {
  botToken: string;
  /** A chat id (integer, as text) or a public @channel name. */
  chatId: string;
}

export interface TelegramStatus {
  configured: boolean;
  chatIdMasked: string | null;
}

export const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const MAX_TOKEN_LENGTH = 200;
const CHAT_NUMBER = /^-?\d{1,20}$/;
const CHAT_CHANNEL = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
export const TELEGRAM_TIMEOUT_MS = 10_000;
/** Telegram's limit for one message. */
export const MAX_MESSAGE_CHARS = 4096;

/** A Telegram problem with a stable code; its message never holds the token. */
export class TelegramError extends Error {
  readonly code: 'telegram_invalid' | 'telegram_failed';
  /** Telegram's HTTP status when it answered (409: another getUpdates consumer, 429: too many requests). */
  readonly status: number | null;
  /** Telegram's `parameters.retry_after` in seconds, when it gave one. */
  readonly retryAfter: number | null;
  constructor(code: TelegramError['code'], message: string, status: number | null = null, retryAfter: number | null = null) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Telegram's Bot API; tests inject a fake server's base. */
export const TELEGRAM_API = 'https://api.telegram.org';

export function telegramPath(env = process.env): string {
  return join(stateDir(env), 'telegram.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function chatIdFrom(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  return CHAT_NUMBER.test(value) || CHAT_CHANNEL.test(value) ? value : null;
}

/** Validates `{ botToken, chatId }` (and nothing else). Throws TelegramError telegram_invalid. */
export function parseCredentials(body: Record<string, unknown>): TelegramCredentials {
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('botToken') || !keys.includes('chatId')) {
    throw new TelegramError('telegram_invalid', 'expected { botToken, chatId }');
  }
  const { botToken } = body;
  if (typeof botToken !== 'string' || botToken.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(botToken)) {
    throw new TelegramError('telegram_invalid', 'botToken is not a Telegram bot token');
  }
  const chatId = chatIdFrom(body.chatId);
  if (chatId === null) throw new TelegramError('telegram_invalid', 'chatId must be an integer or an @channel name');
  return { botToken, chatId };
}

/** Enough of a chat id to recognize it: the last 3 digits, or the first 2 letters of a channel. */
export function maskChatId(chatId: string): string {
  if (chatId.startsWith('@')) return `${chatId.slice(0, 3)}•••`;
  const digits = chatId.replace(/^-/, '');
  return digits.length > 3 ? `•••${digits.slice(-3)}` : '•••';
}

/** The token's secret part and the whole token removed from `text`. */
function redact(text: string, token: string): string {
  const secret = token.split(':')[1] ?? token;
  return text.split(token).join('[token]').split(secret).join('[token]').replace(/\d+:[A-Za-z0-9_-]{30,}/g, '[token]');
}

export class TelegramStore {
  readonly file: string;

  constructor(file = telegramPath()) {
    this.file = file;
  }

  /** The stored credentials, or null when missing, damaged, invalid or readable by others. */
  async read(): Promise<TelegramCredentials | null> {
    return (await this.readAll())?.credentials ?? null;
  }

  /** Whether held questions are answered from Telegram (on unless saved as false); null when not configured. */
  async answers(): Promise<boolean | null> {
    const stored = await this.readAll();
    return stored ? stored.answers : null;
  }

  /** Saves the answers setting with the stored credentials. Throws TelegramError telegram_invalid when not configured. */
  async setAnswers(enabled: boolean): Promise<void> {
    const stored = await this.readAll();
    if (!stored) throw new TelegramError('telegram_invalid', 'Telegram is not configured');
    await this.save(stored.credentials, enabled);
  }

  private async readAll(): Promise<{ credentials: TelegramCredentials; answers: boolean } | null> {
    let handle;
    try {
      handle = await open(this.file, 'r');
    } catch {
      return null;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) return null;
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!isRecord(value)) return null;
      return { credentials: parseCredentials({ botToken: value.botToken, chatId: value.chatId }), answers: value.answers !== false };
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  }

  async status(): Promise<TelegramStatus> {
    const credentials = await this.read();
    return credentials ? { configured: true, chatIdMasked: maskChatId(credentials.chatId) } : { configured: false, chatIdMasked: null };
  }

  /** Writes a temp file (0600) next to the target and renames it into place; the answers setting is kept. */
  async write(credentials: TelegramCredentials): Promise<void> {
    await this.save(credentials, (await this.readAll())?.answers ?? true);
  }

  private async save(credentials: TelegramCredentials, answers: boolean): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const temp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ botToken: credentials.botToken, chatId: credentials.chatId, ...(answers ? {} : { answers: false }) }) + '\n', { mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new Error(`could not store the Telegram settings (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }

  async remove(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export interface SendOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** The Bot API base (default TELEGRAM_API). */
  apiBase?: string;
  /** Aborts the request early (a closing poller). */
  signal?: AbortSignal;
}

/**
 * Calls one Bot API method with a JSON body, or a multipart one (FormData: a file, as for
 * sendDocument), and returns its `result`. Rejects with TelegramError telegram_failed (with
 * Telegram's status when it answered), never with the token.
 */
export async function callTelegram(credentials: TelegramCredentials, method: string, body: Record<string, unknown> | FormData, options: SendOptions = {}): Promise<unknown> {
  const { fetch = globalThis.fetch, timeoutMs = TELEGRAM_TIMEOUT_MS, apiBase = TELEGRAM_API } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const form = body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`${apiBase}/bot${credentials.botToken}/${method}`, {
      method: 'POST',
      // fetch writes a multipart body's content type itself, with its boundary.
      ...(form ? {} : { headers: { 'content-type': 'application/json' } }),
      body: form ? body : JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      redirect: 'error',
    });
  } catch (error) {
    // fetch errors may quote the URL, which holds the token: only a code goes out.
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code ?? (error as Error)?.name ?? 'error';
    throw new TelegramError('telegram_failed', `Telegram could not be reached (${redact(String(cause), credentials.botToken).slice(0, 40)})`);
  }
  let answer: unknown = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (!response.ok || !isRecord(answer) || answer.ok !== true) {
    const description = isRecord(answer) && typeof answer.description === 'string' ? `: ${redact(answer.description, credentials.botToken).slice(0, 120)}` : '';
    const retry = isRecord(answer) && isRecord(answer.parameters) && Number.isSafeInteger(answer.parameters.retry_after) ? (answer.parameters.retry_after as number) : null;
    throw new TelegramError('telegram_failed', `Telegram answered ${response.status}${description}`, response.status, retry);
  }
  return answer.result;
}

/** Cut to Telegram's limit of one message. */
export function messageText(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_MESSAGE_CHARS ? `${chars.slice(0, MAX_MESSAGE_CHARS - 1).join('')}…` : text;
}

/** Sends one plain-text message. Rejects with TelegramError telegram_failed, never with the token. */
export async function sendTelegram(credentials: TelegramCredentials, text: string, options: SendOptions = {}): Promise<void> {
  await callTelegram(credentials, 'sendMessage', { chat_id: credentials.chatId, text: messageText(text), disable_web_page_preview: true }, options);
}

/**
 * What the phone gets: what needs the user and the
 * summaries; never the judge's verdicts or the budget notices, and never the plain notice of a
 * question held for an answer (it arrives with its buttons instead).
 */
export function telegramAccepts(topic: NoticeTopic): boolean {
  return topic !== 'judgment' && topic !== 'budget' && topic !== 'held';
}

/** The notification channel: sends `title\nbody` when configured, skips otherwise; failures are logged without the token. */
export function telegramChannel(store: TelegramStore, options: SendOptions & { log?: (line: string) => void } = {}): NotifyChannel {
  const log = options.log ?? ((line: string) => console.error(line));
  return {
    name: 'telegram',
    accepts: telegramAccepts,
    async send(notice: Notice) {
      const credentials = await store.read();
      if (!credentials) return;
      try {
        await sendTelegram(credentials, `${notice.title}\n${notice.body}`, options);
      } catch (error) {
        const message = error instanceof TelegramError ? error.message : 'the message could not be sent';
        log(`mirador: Telegram notification failed: ${redact(message, credentials.botToken)}`);
      }
    },
  };
}
