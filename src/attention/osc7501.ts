/**
 * OSC 7501, the Program Status Protocol (revision 0.4, 2026-10-10;
 * https://www.superlogical.com/rex/docs/build/program-status): a program says through its pty
 * what it is doing (idle, working, done, blocked, error) and why.
 *
 *   ESC ] 7501 ; key=value(:key=value)* ST    a report      (ST is ESC \ or BEL)
 *   ESC ] 7501 ; ? ST                        the probe: the terminal answers ESC ] 7501 ; ? ST
 *
 * Osc7501Parser is pure and streaming: feed it each pty chunk, as node-pty gives it (a string),
 * and it returns that output with every complete OSC 7501 sequence taken out, plus what they
 * carried. A sequence split across chunks is held until it ends; one that grows past the
 * 4096-byte limit, or that an ESC, CAN or SUB cancels, is let through unchanged (xterm.js ignores
 * an OSC it does not know) and parsing goes on after it. Every other byte comes out unchanged,
 * and the output is only ever cut at an ESC or a terminator, so a surrogate pair is never split.
 *
 * Reports are untrusted input. Validation follows the protocol: a malformed pair is skipped, an
 * unknown key ignored, a repeated key's last value wins; a report with no or an unknown state, or
 * a bad id, is ignored; one over a limit, with base64 that does not decode (or not to UTF-8), or
 * with a control character in its decoded text is discarded whole. Discarded or not, a complete
 * sequence never reaches the screen.
 *
 * It also reports, in order, each shell prompt mark (OSC 133 A, shell integration) it lets
 * through unchanged: the protocol drops working and blocked records when a new prompt begins.
 */

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

/** One valid report. `id` '' is the root record; `clear` removes the record and every one beneath it. */
export interface ProgramStatusReport {
  id: string;
  state: ProgramState | 'clear';
  /** blocked only. */
  kind?: BlockedKind;
  /** working or blocked only: 0-100; absent means indeterminate. */
  progress?: number;
  app?: string;
  /** Decoded base64: one line, no control characters. */
  title?: string;
  msg?: string;
}

/** What the terminal registry hands on (TerminalRegistry.onStatus): a report, or a new shell prompt. */
export type ProgramStatusEvent = { type: 'report'; report: ProgramStatusReport } | { type: 'prompt' };
export type Osc7501Event = ProgramStatusEvent | { type: 'probe'; reply: string };

const PREFIX = '\x1b]7501;';
/** OSC 133 A: a new shell prompt begins. */
const SHELL_PROMPT = '\x1b]133;A';
/** Whole sequence, OSC through ST. */
export const MAX_SEQUENCE_BYTES = 4096;
const MAX_KEY_BYTES = 16;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
const TEXT_LIMITS = { msg: { encoded: 2732, decoded: 2048 }, title: { encoded: 256, decoded: 192 } } as const;

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const KINDS = new Set(['permission', 'question', 'auth']);
const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const PROGRESS = /^\d{1,3}$/;
/** Standard base64 with optional padding (checked for length below). */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/* eslint-disable-next-line no-control-regex */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Discarded: the report is dropped whole. */
const DISCARD = Symbol('discard');

/** Decoded free text, or DISCARD when it breaks a limit, does not decode, or holds a control character. */
function decodeText(value: string, limits: { encoded: number; decoded: number }): string | typeof DISCARD {
  if (value.length > limits.encoded || !BASE64.test(value)) return DISCARD;
  const bare = value.replace(/=+$/, '');
  if (bare.length % 4 === 1 || (bare.length !== value.length && value.length % 4 !== 0)) return DISCARD;
  const bytes = Buffer.from(bare, 'base64');
  if (bytes.length > limits.decoded) return DISCARD;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return DISCARD;
  }
  return CONTROL.test(text) ? DISCARD : text;
}

function validId(id: string): boolean {
  if (id.length > MAX_ID_BYTES) return false;
  const segments = id.split('/');
  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => SEGMENT.test(segment));
}

/** The report a sequence body holds, or null when it is ignored or discarded. Never throws. */
export function parseReport(body: string): ProgramStatusReport | null {
  const pairs = new Map<string, string>();
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (Buffer.byteLength(key) > MAX_KEY_BYTES) return null; // a limit: discarded whole
    if (!KEY.test(key)) continue;
    // A malformed id must not fall back to the root record: the report is ignored instead.
    if (!VALUE.test(value)) {
      if (key === 'id') return null;
      continue;
    }
    pairs.set(key, value);
  }
  const state = pairs.get('state');
  if (state === undefined || !STATES.has(state)) return null;
  const id = pairs.get('id');
  if (id !== undefined && !validId(id)) return null;
  const report: ProgramStatusReport = { id: id ?? '', state: state as ProgramStatusReport['state'] };
  const kind = pairs.get('kind');
  if (state === 'blocked' && kind !== undefined && KINDS.has(kind)) report.kind = kind as BlockedKind;
  const progress = pairs.get('progress');
  if ((state === 'working' || state === 'blocked') && progress !== undefined && PROGRESS.test(progress) && Number(progress) <= 100) report.progress = Number(progress);
  const app = pairs.get('app');
  if (app !== undefined && APP.test(app)) report.app = app;
  for (const key of ['title', 'msg'] as const) {
    const value = pairs.get(key);
    if (value === undefined) continue;
    const text = decodeText(value, TEXT_LIMITS[key]);
    if (text === DISCARD) return null;
    report[key] = text;
  }
  return report;
}

export class Osc7501Parser {
  /** The start of a sequence (or of what may become one) waiting for the next chunk. */
  private held = '';

  feed(chunk: string): { output: string; events: Osc7501Event[] } {
    const data = this.held + chunk;
    this.held = '';
    const out: string[] = [];
    const events: Osc7501Event[] = [];
    let i = 0; // output let through up to here
    let from = 0; // looking for the next OSC from here
    for (;;) {
      const start = data.indexOf('\x1b]', from);
      if (start < 0) break;
      from = start + 2;
      if (data.startsWith(SHELL_PROMPT, start)) {
        events.push({ type: 'prompt' }); // let through unchanged
        continue;
      }
      if (!data.startsWith(PREFIX, start)) continue;
      const scan = this.scan(data, start);
      if (scan.type === 'incomplete') {
        out.push(data.slice(i, start));
        this.held = data.slice(start);
        return { output: out.join(''), events };
      }
      if (scan.type === 'cancelled') {
        // Let it through as it came; whatever cancelled it is parsed as normal output.
        from = scan.at;
        continue;
      }
      if (Buffer.byteLength(data.slice(start, scan.end)) > MAX_SEQUENCE_BYTES) {
        // Over the limit (an ST ending one byte past it, or multi-byte text): let it through as it
        // came, like a sequence that grows past the limit unterminated.
        from = scan.end;
        continue;
      }
      out.push(data.slice(i, start));
      i = from = scan.end;
      const body = data.slice(start + PREFIX.length, scan.bodyEnd);
      if (body.trim() === '?') {
        events.push({ type: 'probe', reply: `${PREFIX}?${scan.terminator}` });
        continue;
      }
      const report = parseReport(body);
      if (report) events.push({ type: 'report', report });
    }
    // The chunk may end on the first bytes of an OSC 7501 or a prompt mark: hold them.
    const tail = data.lastIndexOf('\x1b');
    const rest = tail >= from - 2 && tail >= i ? data.slice(tail) : '';
    if (rest && ((rest.length < PREFIX.length && PREFIX.startsWith(rest)) || (rest.length < SHELL_PROMPT.length && SHELL_PROMPT.startsWith(rest)))) {
      out.push(data.slice(i, tail));
      this.held = rest;
    } else {
      out.push(data.slice(i));
    }
    return { output: out.length === 1 ? out[0] : out.join(''), events };
  }

  /** What is held, unchanged (the process ended, nothing more comes); the parser starts over. */
  flush(): string {
    const held = this.held;
    this.held = '';
    return held;
  }

  private scan(
    data: string,
    start: number,
  ): { type: 'complete'; bodyEnd: number; end: number; terminator: string } | { type: 'cancelled'; at: number } | { type: 'incomplete' } {
    for (let j = start + PREFIX.length; j < data.length; j++) {
      if (j - start >= MAX_SEQUENCE_BYTES) return { type: 'cancelled', at: j };
      const code = data.charCodeAt(j);
      if (code === 0x07) return { type: 'complete', bodyEnd: j, end: j + 1, terminator: '\x07' };
      if (code === 0x18 || code === 0x1a || code === 0x9c) return { type: 'cancelled', at: j };
      if (code === 0x1b) {
        if (j + 1 >= data.length) return { type: 'incomplete' };
        if (data.charCodeAt(j + 1) === 0x5c) return { type: 'complete', bodyEnd: j, end: j + 2, terminator: '\x1b\\' };
        return { type: 'cancelled', at: j };
      }
    }
    return { type: 'incomplete' };
  }
}
