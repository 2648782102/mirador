import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { EnvProvider } from '../terminals/registry.ts';
import {
  CONFIRM_OPTIONS,
  MAX_DIALOG_CHARS,
  MAX_DIALOG_OPTIONS,
  MAX_FINAL_MESSAGE_BYTES,
  MAX_NOTICE_TITLE_CHARS,
  MAX_SESSION_FILE_CHARS,
  NIGHT_SOCKET_ENV,
  NIGHT_TOKEN_ENV,
  type MiradorLine,
  type NightDialog,
  type NightOption,
  type NightQuestion,
  type NightQuestionItem,
} from './protocol.ts';

/**
 * The night socket: a Unix socket at `<runtimeDir>/night/socket`
 * (folder 0700, socket 0600) that the gentle-shell bridge inside each agent
 * terminal connects to. It is the only inbound path from Mirador into agents, so:
 *
 * - each agent terminal gets its own random token (MIRADOR_NIGHT_TOKEN); the first
 *   line must be `hello` with that terminal id and token (compared in constant
 *   time), sent within HELLO_TIMEOUT_MS, or the connection is closed;
 * - one connection per terminal: a new hello replaces the old connection;
 * - JSON lines of at most 64 KiB; a longer line closes the connection, a malformed
 *   line is dropped, and a malformed question is answered `pass` so the bridge
 *   opens the dialog at once instead of waiting;
 * - at most MAX_QUESTIONS_PER_MINUTE questions per connection reach Mirador; the
 *   rest are answered `pass`;
 * - `finished` lines carry the agent's final message of a turn: at most
 *   MAX_FINAL_MESSAGE_BYTES and MAX_FINISHED_PER_MINUTE per connection, the rest
 *   dropped. The latest one per terminal is kept (lastFinished), replaced each turn
 *   and dropped when the bridge disconnects or the terminal is revoked; listeners
 *   (onFinished) hear each one. It is untrusted model output, kept as data only;
 * - `session` lines carry the agent's pi session file: at most MAX_SESSION_FILE_CHARS
 *   and MAX_SESSION_PER_MINUTE per connection, the rest dropped. Listeners (onSession)
 *   hear each one and must validate the path themselves;
 * - `dialog` lines count with the questions; one that is
 *   malformed, over MAX_DIALOG_OPTIONS or MAX_DIALOG_CHARS, or past the rate is answered `pass`; a
 *   notice dialog (`notice: true`: no message, no options, a title of at most MAX_NOTICE_TITLE_CHARS)
 *   announces one that was too big;
 * - only `question`, `dialog`, `delivered`, `finished`, `released`, `took` and `session` lines are read, only the documented
 *   Mirador lines are written. Nothing received is ever evaluated or run.
 */

export const MAX_LINE_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const MAX_CONNECTIONS = 64;
/** The bridge asks one question per tool call; past this, a connection's questions pass without reaching Mirador. */
const MAX_QUESTIONS_PER_MINUTE = 20;
/** One per agent turn; past this, a connection's finished lines are dropped. */
const MAX_FINISHED_PER_MINUTE = 20;
/** Sent on connect, on each new session and at each turn end; past this, a connection's session lines are dropped. */
const MAX_SESSION_PER_MINUTE = 20;
/** A bridge that stops reading: drop it rather than buffer without end. */
const MAX_PENDING_WRITE = 1024 * 1024;
const ID = /^[\w-]{1,128}$/;
/** Bounds on a question's parts; the 64 KiB line limit bounds the whole. */
const MAX_ITEMS = 8;
const MAX_OPTIONS = 8;
const MAX_TEXT = 16 * 1024;

export interface ChannelHandlers {
  /** A valid question from the bridge of `terminalId`; answer it with `send`. */
  question(terminalId: string, requestId: string, question: NightQuestion): void;
  /** A valid blocking dialog open in the terminal of `terminalId`; without a handler it is answered `pass`. */
  dialog?(terminalId: string, requestId: string, dialog: NightDialog): void;
  delivered(terminalId: string, messageId: string): void;
  /** The terminal's bridge connection closed (not when a new hello replaced it). */
  disconnected(terminalId: string): void;
  /** The bridge gave its held question `requestId` back to the dialog. */
  released?(terminalId: string, requestId: string): void;
  /** The bridge closed its held dialog `requestId` with Mirador's `chosen`. */
  took?(terminalId: string, requestId: string): void;
}

/** The final message of a terminal's latest turn, as its bridge sent it. */
export interface FinishedTurn {
  turnId: string;
  /** The final assistant text, '' when it had none. Untrusted. */
  text: string;
  /** When Mirador received it (epoch ms). */
  time: number;
}

export function nightSocketPath(runDir: string): string {
  return join(runDir, 'night', 'socket');
}

/** MIRADOR_NIGHT_SOCKET and a fresh MIRADOR_NIGHT_TOKEN for agent terminals; shells get none. */
export function nightEnvProvider(channel: Pick<NightChannel, 'issueToken'>, socketPath: string): EnvProvider {
  return (info): Record<string, string> => (info.kind === 'agent' ? { [NIGHT_SOCKET_ENV]: socketPath, [NIGHT_TOKEN_ENV]: channel.issueToken(info.id) } : {});
}

/** True when something is accepting connections on `path`, e.g. another running Mirador. */
function inUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT;

function readOption(value: unknown): NightOption | null {
  if (!isRecord(value) || !text(value.label) || !text(value.description)) return null;
  return { label: value.label, description: value.description };
}

function readItem(value: unknown): NightQuestionItem | null {
  if (!isRecord(value) || !text(value.question) || !text(value.header) || typeof value.multiSelect !== 'boolean') return null;
  if (!Array.isArray(value.options) || value.options.length > MAX_OPTIONS) return null;
  const options = value.options.map(readOption);
  if (options.some((option) => option === null)) return null;
  return { question: value.question, header: value.header, options: options as NightOption[], multiSelect: value.multiSelect };
}

/** A copy of the question with only the documented fields, or null when anything is off. */
function readQuestion(value: unknown, terminalId: string): NightQuestion | null {
  if (!isRecord(value) || value.terminalId !== terminalId) return null;
  if (typeof value.toolCallId !== 'string' || !value.toolCallId || value.toolCallId.length > 256) return null;
  if (value.tool !== 'ask_user_choice' && value.tool !== 'ask_user_question') return null;
  if (typeof value.allowCustomResponse !== 'boolean' || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) return null;
  const items = value.items.map(readItem);
  if (items.some((item) => item === null)) return null;
  return { terminalId, toolCallId: value.toolCallId, tool: value.tool, items: items as NightQuestionItem[], allowCustomResponse: value.allowCustomResponse };
}

/** A copy of the dialog with only the documented fields, or null when anything is off. */
function readDialog(value: unknown, terminalId: string): NightDialog | null {
  if (!isRecord(value) || value.terminalId !== terminalId || (value.kind !== 'select' && value.kind !== 'confirm')) return null;
  if (typeof value.title !== 'string' || typeof value.message !== 'string' || !Array.isArray(value.options)) return null;
  if (value.notice !== undefined) {
    if (value.notice !== true || value.message !== '' || value.options.length !== 0 || Array.from(value.title).length > MAX_NOTICE_TITLE_CHARS) return null;
    return { terminalId, kind: value.kind, title: value.title, message: '', options: [], notice: true };
  }
  const options = value.options;
  if (options.length < 1 || options.length > MAX_DIALOG_OPTIONS || !options.every((option) => typeof option === 'string')) return null;
  if (value.kind === 'confirm' ? options.join('\n') !== CONFIRM_OPTIONS.join('\n') : value.message !== '') return null;
  if ([value.title, value.message, ...options].reduce((sum, part: string) => sum + part.length, 0) > MAX_DIALOG_CHARS) return null;
  return { terminalId, kind: value.kind, title: value.title, message: value.message, options: [...options] as string[] };
}

export class NightChannel {
  private readonly server: Server;
  private readonly path: string;
  private readonly handlers: ChannelHandlers;
  private readonly helloTimeoutMs: number;
  /** sha256 of each terminal's token; the token itself is only in that terminal's environment. */
  private readonly tokens = new Map<string, Buffer>();
  private readonly connections = new Map<string, Socket>();
  private readonly sockets = new Set<Socket>();
  private readonly finals = new Map<string, FinishedTurn>();
  private readonly finishedListeners = new Set<(terminalId: string, turn: FinishedTurn) => void>();
  private readonly sessionListeners = new Set<(terminalId: string, file: string) => void>();

  private constructor(server: Server, path: string, handlers: ChannelHandlers, helloTimeoutMs: number) {
    this.server = server;
    this.path = path;
    this.handlers = handlers;
    this.helloTimeoutMs = helloTimeoutMs;
  }

  /** Listens on `path`; rejects when another Mirador serves it or it cannot be opened. */
  static async open(path: string, handlers: ChannelHandlers, options: { helloTimeoutMs?: number } = {}): Promise<NightChannel> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    // Never take the socket from a Mirador that is serving it; only replace one left by a crash.
    if (await inUse(path)) throw new Error(`${path} is in use by another Mirador`);
    await rm(path, { force: true });
    const server = createServer();
    const channel = new NightChannel(server, path, handlers, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', (conn) => channel.accept(conn));
    server.on('error', (error) => console.error('night socket error:', error));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    return channel;
  }

  /** A new random token for `terminalId` (replacing any earlier one). */
  issueToken(terminalId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(terminalId, digest(token));
    return token;
  }

  /** The terminal exited or closed: its token stops working and its connection closes. */
  revoke(terminalId: string): void {
    this.tokens.delete(terminalId);
    this.finals.delete(terminalId);
    this.connections.get(terminalId)?.destroy();
  }

  /** The final message of the terminal's latest turn, or null when none arrived since it connected. */
  lastFinished(terminalId: string): FinishedTurn | null {
    return this.finals.get(terminalId) ?? null;
  }

  /** Calls `listener` for every valid `finished` line. Returns an unsubscribe function. */
  onFinished(listener: (terminalId: string, turn: FinishedTurn) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /** Calls `listener` with every session file a bridge reports, unvalidated. Returns an unsubscribe function. */
  onSession(listener: (terminalId: string, file: string) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  isConnected(terminalId: string): boolean {
    return this.connections.has(terminalId);
  }

  connectedTerminals(): string[] {
    return [...this.connections.keys()];
  }

  /** Writes one line to the terminal's bridge. False when it has no connection. */
  send(terminalId: string, line: MiradorLine): boolean {
    const conn = this.connections.get(terminalId);
    if (!conn || conn.destroyed) return false;
    const data = JSON.stringify(line) + '\n';
    if (conn.writableLength > MAX_PENDING_WRITE) {
      conn.destroy();
      return false;
    }
    // The bridge drops longer lines; callers cap their text well below this.
    if (Buffer.byteLength(data) > MAX_LINE_BYTES + 1) return false;
    conn.write(data);
    return true;
  }

  async close(): Promise<void> {
    for (const conn of this.sockets) conn.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.path, { force: true });
  }

  private accept(conn: Socket): void {
    this.sockets.add(conn);
    let terminalId: string | null = null;
    let chunks: Buffer[] = [];
    let size = 0;
    let windowStart = Date.now();
    let questions = 0;
    let finishedLines = 0;
    let sessionLines = 0;
    const helloTimer = setTimeout(() => conn.destroy(), this.helloTimeoutMs);
    helloTimer.unref();

    const onLine = (line: string): void => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = null;
      }
      if (terminalId === null) {
        const id = this.authenticate(value);
        if (id === null) return void conn.destroy();
        clearTimeout(helloTimer);
        terminalId = id;
        const previous = this.connections.get(id);
        this.connections.set(id, conn);
        previous?.destroy();
        return;
      }
      if (!isRecord(value)) return;
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        questions = 0;
        finishedLines = 0;
        sessionLines = 0;
      }
      if (value.type === 'question' && typeof value.requestId === 'string' && ID.test(value.requestId)) {
        const question = ++questions <= MAX_QUESTIONS_PER_MINUTE ? readQuestion(value.question, terminalId) : null;
        if (question) this.handlers.question(terminalId, value.requestId, question);
        else this.send(terminalId, { type: 'pass', requestId: value.requestId });
      } else if (value.type === 'dialog' && typeof value.requestId === 'string' && ID.test(value.requestId)) {
        const dialog = ++questions <= MAX_QUESTIONS_PER_MINUTE ? readDialog(value.dialog, terminalId) : null;
        if (dialog && this.handlers.dialog) this.handlers.dialog(terminalId, value.requestId, dialog);
        else this.send(terminalId, { type: 'pass', requestId: value.requestId });
      } else if (value.type === 'delivered' && typeof value.messageId === 'string' && ID.test(value.messageId)) {
        this.handlers.delivered(terminalId, value.messageId);
      } else if (value.type === 'finished' && typeof value.turnId === 'string' && ID.test(value.turnId) && typeof value.text === 'string') {
        if (Buffer.byteLength(value.text) > MAX_FINAL_MESSAGE_BYTES || ++finishedLines > MAX_FINISHED_PER_MINUTE) return;
        this.finished(terminalId, { turnId: value.turnId, text: value.text, time: now });
      } else if (value.type === 'released' && typeof value.requestId === 'string' && ID.test(value.requestId)) {
        this.handlers.released?.(terminalId, value.requestId);
      } else if (value.type === 'took' && typeof value.requestId === 'string' && ID.test(value.requestId)) {
        this.handlers.took?.(terminalId, value.requestId);
      } else if (value.type === 'session' && typeof value.file === 'string' && value.file.length <= MAX_SESSION_FILE_CHARS) {
        if (++sessionLines > MAX_SESSION_PER_MINUTE) return;
        this.session(terminalId, value.file);
      }
    };

    conn.on('data', (chunk: Buffer) => {
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf(0x0a, start)) >= 0) {
        const piece = chunk.subarray(start, end);
        if (size + piece.length > MAX_LINE_BYTES) return void conn.destroy();
        const line = Buffer.concat([...chunks, piece], size + piece.length).toString('utf8');
        chunks = [];
        size = 0;
        start = end + 1;
        try {
          onLine(line);
        } catch (error) {
          console.error('night line failed:', error);
        }
        if (conn.destroyed) return;
      }
      const rest = chunk.subarray(start);
      size += rest.length;
      if (size > MAX_LINE_BYTES) return void conn.destroy();
      if (rest.length) chunks.push(rest);
    });
    conn.on('error', () => conn.destroy());
    conn.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(conn);
      if (terminalId !== null && this.connections.get(terminalId) === conn) {
        this.connections.delete(terminalId);
        this.finals.delete(terminalId);
        try {
          this.handlers.disconnected(terminalId);
        } catch (error) {
          console.error('night disconnect handler failed:', error);
        }
      }
    });
  }

  private finished(terminalId: string, turn: FinishedTurn): void {
    this.finals.set(terminalId, turn);
    for (const listener of this.finishedListeners) {
      try {
        listener(terminalId, turn);
      } catch (error) {
        console.error('night finished listener failed:', error);
      }
    }
  }

  private session(terminalId: string, file: string): void {
    for (const listener of this.sessionListeners) {
      try {
        listener(terminalId, file);
      } catch (error) {
        console.error('night session listener failed:', error);
      }
    }
  }

  /** The terminal id of a valid hello, or null. Compares token digests in constant time. */
  private authenticate(value: unknown): string | null {
    if (!isRecord(value) || value.type !== 'hello' || typeof value.terminalId !== 'string' || typeof value.token !== 'string') return null;
    const expected = this.tokens.get(value.terminalId);
    const given = digest(value.token);
    // Compare even for an unknown terminal, so timing does not tell which ids exist.
    const match = timingSafeEqual(given, expected ?? digest(''));
    return match && expected ? value.terminalId : null;
  }
}
