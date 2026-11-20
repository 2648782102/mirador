// Seeded fuzz for the OSC 7501 parser (src/attention/osc7501.ts): whatever way node-pty splits the
// output, text without OSC 7501 comes out byte-identical, OSC 7501 sequences are always removed and
// reported in order, and the 4096-byte limit behaves the same at every split. Deterministic: a fixed
// seed, so a failure names the trial that reproduces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Osc7501Parser, type Osc7501Event } from '../src/attention/osc7501.ts';

const ESC = '\x1b';
const ST = `${ESC}\\`;
const BEL = '\x07';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** mulberry32: a small seeded generator, so every run plays the same trials. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] };
}

/** Cuts `text` at `cuts` random places (positions may repeat: empty chunks happen too). */
function split(text: string, cuts: number, r: ReturnType<typeof rng>): string[] {
  const at = Array.from({ length: cuts }, () => r.int(text.length + 1)).sort((x, y) => x - y);
  const chunks: string[] = [];
  let last = 0;
  for (const cut of at) {
    chunks.push(text.slice(last, cut));
    last = cut;
  }
  chunks.push(text.slice(last));
  return chunks;
}

function run(chunks: string[]): { output: string; events: Osc7501Event[] } {
  const parser = new Osc7501Parser();
  let output = '';
  const events: Osc7501Event[] = [];
  for (const chunk of chunks) {
    const result = parser.feed(chunk);
    output += result.output;
    events.push(...result.events);
  }
  output += parser.flush();
  return { output, events };
}

const PROMPT = `${ESC}]133;A`;

/** Realistic terminal output with no OSC 7501 in it. None starts with `]`, so no two glue into a new OSC. */
const PLAIN = [
  'hello world\r\n',
  `${ESC}[1;32m✔${ESC}[0m passed\r\n`,
  `${ESC}[38;2;255;100;0mtruecolor${ESC}[m`,
  `${ESC}[2J${ESC}[H${ESC}[12;40H${ESC}[K`,
  `${ESC}[?1049h${ESC}[?25l`,
  `${ESC}7${ESC}8${ESC}M`,
  `${ESC}]0;window title${BEL}`,
  `${ESC}]2;tab title${ST}`,
  `${ESC}]8;;https://example.com/a?b=c${ST}link${ESC}]8;;${ST}`,
  `${PROMPT}${ST}`,
  `${PROMPT};cl=m${BEL}`,
  `${ESC}]133;B${BEL}`,
  `${ESC}]133;D;0${ST}`,
  `${ESC}P1$r0m${ST}`,
  `${ESC}[200~pasted text${ESC}[201~`,
  'é ñ 漢字 ',
  '😀👩‍💻👨‍👩‍👧 ',
  ESC,
  '\x18',
  '\x1a',
  '\x9c',
  '\x9b',
  `${ESC}]7501${BEL}`,
  `${ESC}]75011;state=working${BEL}`,
  `${ESC}]750;state=working${BEL}`,
  `${ESC}]7501:state=working${ST}`,
  `${ESC}]75${BEL}`,
] as const;

const promptCount = (text: string) => text.split(PROMPT).length - 1;

/** OSC 7501 sequences with the events each one must give (none when it is ignored or discarded). */
const STATUS: Array<{ text: string; events: Osc7501Event[] }> = [
  { text: `${ESC}]7501;state=working:app=x${BEL}`, events: [{ type: 'report', report: { id: '', state: 'working', app: 'x' } }] },
  { text: `${ESC}]7501;state=blocked:kind=question:msg=${b64('Overwrite?')}${ST}`, events: [{ type: 'report', report: { id: '', state: 'blocked', kind: 'question', msg: 'Overwrite?' } }] },
  { text: `${ESC}]7501;?${ST}`, events: [{ type: 'probe', reply: `${ESC}]7501;?${ST}` }] },
  { text: `${ESC}]7501;?${BEL}`, events: [{ type: 'probe', reply: `${ESC}]7501;?${BEL}` }] },
  { text: `${ESC}]7501;state=done:msg=Q${ST}`, events: [] }, // invalid base64
  { text: `${ESC}]7501;state=sleeping${BEL}`, events: [] }, // unknown state
  { text: `${ESC}]7501;state=clear:id=a/b${ST}`, events: [{ type: 'report', report: { id: 'a/b', state: 'clear' } }] },
  { text: `${ESC}]7501;state=clear${BEL}`, events: [{ type: 'report', report: { id: '', state: 'clear' } }] },
  { text: `${ESC}]7501;state=done:id=build/test:title=${b64('Tests')}${ST}`, events: [{ type: 'report', report: { id: 'build/test', state: 'done', title: 'Tests' } }] },
  { text: `${ESC}]7501;state=error:id=x.y${BEL}`, events: [{ type: 'report', report: { id: 'x.y', state: 'error' } }] },
];

test('(a) output without OSC 7501 comes out byte-identical at every split; only OSC 133 A is reported', () => {
  const r = rng(7501);
  const whole = PLAIN.join('');
  const expected = Array.from({ length: promptCount(whole) }, () => ({ type: 'prompt' }));
  // Every single cut of the whole fixture, and one character per chunk.
  for (let cut = 0; cut <= whole.length; cut++) assert.deepEqual(run([whole.slice(0, cut), whole.slice(cut)]), { output: whole, events: expected }, `cut ${cut}`);
  assert.deepEqual(run([...whole]), { output: whole, events: expected }, 'one character per chunk');
  assert.deepEqual(run(whole.split('')), { output: whole, events: expected }, 'one UTF-16 unit per chunk, surrogates split');
  // Random compositions, random splits.
  for (let trial = 0; trial < 300; trial++) {
    const text = Array.from({ length: 1 + r.int(25) }, () => r.pick(PLAIN)).join('');
    const result = run(split(text, r.int(8), r));
    assert.equal(result.output, text, `trial ${trial}`);
    assert.deepEqual(result.events, Array.from({ length: promptCount(text) }, () => ({ type: 'prompt' })), `trial ${trial}`);
  }
});

test('(b) OSC 7501 sequences are removed at every split and reported in order, probes in their own terminator', () => {
  const r = rng(133);
  type Piece = { text: string; output: string; events: Osc7501Event[] };
  const plain = (text: string): Piece => ({ text, output: text, events: Array.from({ length: promptCount(text) }, () => ({ type: 'prompt' as const })) });
  const status = (s: (typeof STATUS)[number]): Piece => ({ text: s.text, output: '', events: s.events });
  const play = (pieces: Piece[], chunks: (text: string) => string[], label: string) => {
    const text = pieces.map((p) => p.text).join('');
    assert.deepEqual(run(chunks(text)), { output: pieces.map((p) => p.output).join(''), events: pieces.flatMap((p) => p.events) }, label);
  };
  // A fixed interleaving: every status sequence between plain pieces, at every single cut.
  const fixed = STATUS.flatMap((s, n) => [plain(PLAIN[n % PLAIN.length]), status(s)]).concat(plain('end'));
  const fixedText = fixed.map((p) => p.text).join('');
  for (let cut = 0; cut <= fixedText.length; cut++) play(fixed, (t) => [t.slice(0, cut), t.slice(cut)], `cut ${cut}`);
  play(fixed, (t) => t.split(''), 'one UTF-16 unit per chunk');
  // Random interleavings and splits. A lone ESC/CAN/SUB/C1 right before a status sequence would be
  // output, not part of it, so they stay out of the plain pieces here; (a) covers them.
  const safe = PLAIN.filter((p) => !['\x1b', '\x18', '\x1a', '\x9c', '\x9b'].includes(p));
  for (let trial = 0; trial < 300; trial++) {
    const pieces = Array.from({ length: 1 + r.int(20) }, () => (r.int(2) ? plain(r.pick(safe)) : status(r.pick(STATUS))));
    play(pieces, (t) => split(t, r.int(8), r), `trial ${trial}`);
  }
});

test('(c) the 4096-byte limit: exactly 4096 is a report, 4097 and an unterminated sequence pass through unchanged and parsing resyncs', () => {
  const r = rng(4096);
  const sized = (total: number, terminator: string) => {
    const head = `${ESC}]7501;state=done:pad=`;
    return `${head}${'A'.repeat(total - head.length - terminator.length)}${terminator}`;
  };
  const after = `after${ESC}]7501;state=idle${ST}`;
  const idle = { type: 'report', report: { id: '', state: 'idle' } };
  for (const terminator of [BEL, ST]) {
    const exact = sized(4096, terminator);
    const over = sized(4097, terminator);
    assert.equal(Buffer.byteLength(exact), 4096);
    const cases = [
      { text: exact + after, output: 'after', events: [{ type: 'report', report: { id: '', state: 'done' } }, idle] },
      { text: over + after, output: `${over}after`, events: [idle] },
    ];
    for (const { text, output, events } of cases) {
      for (let trial = 0; trial < 40; trial++) assert.deepEqual(run(split(text, r.int(6), r)), { output, events }, `${JSON.stringify(terminator)} ${text.length} trial ${trial}`);
      assert.deepEqual(run([text]), { output, events });
    }
  }
  const unterminated = `${ESC}]7501;state=working:msg=${'A'.repeat(5000)}`;
  for (let trial = 0; trial < 40; trial++) {
    assert.deepEqual(run(split(unterminated + BEL + after, r.int(6), r)), { output: `${unterminated}${BEL}after`, events: [idle] }, `unterminated trial ${trial}`);
  }
});
