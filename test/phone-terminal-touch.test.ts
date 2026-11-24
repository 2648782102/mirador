// #67 S3: a key of the phone's bar, or typing, brings a terminal scrolled into its history back to
// the end. Neither needs code of Mirador's own: terminals.js typeKey sends the bar's keys with
// `term.input(bytes, true)` (test/phone-layout.test.ts pins that), and xterm.js 6 scrolls to the
// bottom on any user input while its `scrollOnUserInput` option is on (the default; terminals.js
// never sets it). The soft keyboard types through xterm's own textarea, the same user input. The
// real installed xterm runs here in Node, unopened: its buffer and scrolling need no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Xterm = {
  buffer: { active: { viewportY: number; baseY: number } };
  options: { scrollOnUserInput?: boolean };
  write: (data: string, done: () => void) => void;
  scrollLines: (amount: number) => void;
  input: (data: string, wasUserInput?: boolean) => void;
  onData: (listener: (data: string) => void) => void;
};
const { Terminal }: { Terminal: new (options: object) => Xterm } = await import(new URL('../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url).href);

/** A 5-row terminal with 30 lines written, scrolled 10 lines into its history. */
async function scrolledUp(): Promise<Xterm> {
  const term = new Terminal({ rows: 5, cols: 20, scrollback: 100, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'), resolve));
  term.scrollLines(-10);
  assert.equal(term.buffer.active.baseY - term.buffer.active.viewportY, 10, 'scrolled up');
  return term;
}

test('#67 S3: a key of the bar (user input, as typeKey sends it) scrolls a terminal in its history back to the end', async () => {
  const term = await scrolledUp();
  const sent: string[] = [];
  term.onData((data) => sent.push(data));
  term.input('\x1b[A', true);
  assert.equal(term.buffer.active.viewportY, term.buffer.active.baseY, 'at the end again');
  assert.deepEqual(sent, ['\x1b[A'], 'and the key still reaches the program');
});

test('#67 S3: only user input scrolls back; a program\'s automatic reply leaves the history where the finger put it', async () => {
  const term = await scrolledUp();
  const at = term.buffer.active.viewportY;
  term.input('\r', false);
  assert.equal(term.buffer.active.viewportY, at);
});

test('#67 S3: terminals.js keeps xterm\'s scroll on user input on and the bar sends its keys as user input', () => {
  const terminalsJs = readFileSync('public/terminals.js', 'utf8');
  assert.doesNotMatch(terminalsJs, /scrollOnUserInput/);
  assert.match(terminalsJs, /record\.term\.input\(bytes, true\)/);
});
