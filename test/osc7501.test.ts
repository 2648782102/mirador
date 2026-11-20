// The OSC 7501 (Program Status Protocol, rev 0.4) parser: pty output in, the output without the
// sequences and the reports they carried out. Expected values come from the protocol text
// (superlogical.com/rex/docs/build/program-status).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Osc7501Parser, type Osc7501Event } from '../src/attention/osc7501.ts';

const ESC = '\x1b';
const ST = `${ESC}\\`;
const BEL = '\x07';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** Feeds every chunk to one parser; returns the joined output and every event. */
function run(...chunks: string[]): { output: string; events: Osc7501Event[] } {
  const parser = new Osc7501Parser();
  let output = '';
  const events: Osc7501Event[] = [];
  for (const chunk of chunks) {
    const result = parser.feed(chunk);
    output += result.output;
    events.push(...result.events);
  }
  return { output, events };
}

const reports = (events: Osc7501Event[]) => events.flatMap((e) => (e.type === 'report' ? [e.report] : []));

test('an ST-terminated report is removed from the output and parsed', () => {
  const msg = 'Apply 3 to add, 1 to change, 0 to destroy?';
  const { output, events } = run(`before${ESC}]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/${ST}after`);
  assert.equal(output, 'beforeafter');
  assert.deepEqual(events, [{ type: 'report', report: { id: '', state: 'blocked', kind: 'permission', app: 'terraform', msg } }]);
});

test('a BEL-terminated report is removed and parsed', () => {
  const { output, events } = run(`a${ESC}]7501;state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz${BEL}b`);
  assert.equal(output, 'ab');
  assert.deepEqual(reports(events), [{ id: '', state: 'working', app: 'brew', msg: 'Installing updates' }]);
});

test('a sequence split across two chunks is held until complete', () => {
  const { output, events } = run(`one${ESC}]75`, `01;state=done:msg=${b64('Docs built')}${ST}two`);
  assert.equal(output, 'onetwo');
  assert.deepEqual(reports(events), [{ id: '', state: 'done', msg: 'Docs built' }]);
});

test('a sequence split across three chunks, including between the two bytes of ST, is held until complete', () => {
  const { output, events } = run(`x${ESC}`, `]7501;state=idle${ESC}`, `\\y`);
  assert.equal(output, 'xy');
  assert.deepEqual(reports(events), [{ id: '', state: 'idle' }]);
});

test('several sequences in one chunk, mixed with normal output and other escapes, all come out', () => {
  const chunk = `${ESC}[31mred${ESC}]7501;state=working${BEL}${ESC}[0m mid ${ESC}]7501;state=done:app=make${ST}end`;
  const { output, events } = run(chunk);
  assert.equal(output, `${ESC}[31mred${ESC}[0m mid end`);
  assert.deepEqual(reports(events), [{ id: '', state: 'working' }, { id: '', state: 'done', app: 'make' }]);
});

test('other OSC sequences and lookalikes pass through byte-identical', () => {
  const chunks = [
    `${ESC}]0;my title${BEL}`,
    `${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`,
    `${ESC}]75010;state=working${BEL}`,
    `${ESC}]750;state=working${BEL}`,
    `${ESC}]7501${BEL}`,
    `${ESC}]133;D;0${ST}`,
    'plain é 漢字 😀 text',
  ];
  for (const chunk of chunks) assert.deepEqual(run(chunk), { output: chunk, events: [] }, JSON.stringify(chunk));
  // Split anywhere, still byte-identical and no event.
  const all = chunks.join('');
  for (let cut = 1; cut < all.length; cut++) assert.deepEqual(run(all.slice(0, cut), all.slice(cut)), { output: all, events: [] }, `cut ${cut}`);
});

test('a surrogate pair right before or after a sequence is never split', () => {
  const { output } = run('😀', `${ESC}]7501;state=idle${BEL}`, '😀');
  assert.equal(output, '😀😀');
});

test('invalid base64 discards the whole report, which is still kept off the screen', () => {
  // Each is inside the value character set (so the pair is well formed) but is not standard base64.
  for (const msg of ['a.bc', 'ab-_', 'QQ=Q', 'Q', 'QUJD====']) {
    const { output, events } = run(`a${ESC}]7501;state=blocked:kind=question:msg=${msg}${ST}b`);
    assert.equal(output, 'ab', msg);
    assert.deepEqual(events, [], msg);
  }
  // Padding is optional.
  assert.deepEqual(reports(run(`${ESC}]7501;state=done:msg=SGk${ST}`).events), [{ id: '', state: 'done', msg: 'Hi' }]);
});

test('a msg or title that decodes to a control character or invalid UTF-8 discards the report', () => {
  for (const value of [b64('two\nlines'), b64('tab\there'), b64('del\x7f'), b64('c1\u0085'), Buffer.from([0xff, 0xfe]).toString('base64')]) {
    assert.deepEqual(run(`${ESC}]7501;state=done:msg=${value}${ST}`).events, [], value);
    assert.deepEqual(run(`${ESC}]7501;state=done:title=${value}${ST}`).events, [], value);
  }
});

test('a msg over 2048 decoded bytes (or 2732 encoded) discards the report; exactly 2048 is kept', () => {
  const ok = 'a'.repeat(2048);
  assert.deepEqual(reports(run(`${ESC}]7501;state=done:msg=${b64(ok)}${ST}`).events), [{ id: '', state: 'done', msg: ok }]);
  const { output, events } = run(`a${ESC}]7501;state=done:msg=${b64('a'.repeat(2049))}${ST}b`);
  assert.equal(output, 'ab');
  assert.deepEqual(events, []);
  assert.deepEqual(run(`${ESC}]7501;state=done:title=${b64('t'.repeat(193))}${ST}`).events, [], 'title over 192 decoded bytes');
});

test('unknown keys and malformed pairs are skipped; the rest of the report still applies; the last repeat wins', () => {
  const { events } = run(`${ESC}]7501;state=working:future=yes:noequals:=empty:BAD=1:app=a b:progress=40:progress=55 ${ST}`);
  assert.deepEqual(reports(events), [{ id: '', state: 'working', progress: 55 }]);
  assert.deepEqual(reports(run(`${ESC}]7501; state = done : app = cargo ${BEL}`).events), [{ id: '', state: 'done', app: 'cargo' }], 'whitespace is trimmed');
});

test('values that are out of range for their key are treated as absent', () => {
  const { events } = run(`${ESC}]7501;state=done:kind=permission:progress=50:app=${'x'.repeat(33)}${ST}`);
  assert.deepEqual(reports(events), [{ id: '', state: 'done' }], 'kind and progress only with blocked/working; app over 32');
  assert.deepEqual(reports(run(`${ESC}]7501;state=blocked:kind=sudo:progress=101${ST}`).events), [{ id: '', state: 'blocked' }]);
  assert.deepEqual(reports(run(`${ESC}]7501;state=blocked:kind=auth:progress=0${ST}`).events), [{ id: '', state: 'blocked', kind: 'auth', progress: 0 }]);
});

test('an unknown or missing state ignores the whole report', () => {
  for (const body of ['state=sleeping:app=x', 'app=x', 'state=', 'state=WORKING']) {
    const { output, events } = run(`a${ESC}]7501;${body}${ST}b`);
    assert.equal(output, 'ab', body);
    assert.deepEqual(events, [], body);
  }
});

test('ids follow the record grammar; a bad id ignores the report rather than hitting the root', () => {
  assert.deepEqual(reports(run(`${ESC}]7501;state=working:id=build/test:title=${b64('Tests')}${ST}`).events), [{ id: 'build/test', state: 'working', title: 'Tests' }]);
  for (const id of ['', 'a//b', '/a', 'a b', 'x'.repeat(33), Array.from({ length: 9 }, () => 'a').join('/'), Array.from({ length: 5 }, () => 'y'.repeat(30)).join('/')]) {
    assert.deepEqual(run(`${ESC}]7501;state=working:id=${id}${ST}`).events, [], id);
  }
});

test('a key over 16 bytes breaks a limit and discards the report', () => {
  assert.deepEqual(run(`${ESC}]7501;state=done:${'k'.repeat(17)}=1${ST}`).events, []);
  assert.deepEqual(reports(run(`${ESC}]7501;state=done:${'k'.repeat(16)}=1${ST}`).events), [{ id: '', state: 'done' }]);
});

test('clear is parsed with or without an id', () => {
  assert.deepEqual(reports(run(`${ESC}]7501;state=clear:id=us-east${ST}${ESC}]7501;state=clear${BEL}`).events), [{ id: 'us-east', state: 'clear' }, { id: '', state: 'clear' }]);
});

test('the probe is reported with the reply the terminal owes, in the probe\'s own terminator', () => {
  assert.deepEqual(run(`x${ESC}]7501;?${ST}y`), { output: 'xy', events: [{ type: 'probe', reply: `${ESC}]7501;?${ST}` }] });
  assert.deepEqual(run(`${ESC}]7501;?`, BEL), { output: '', events: [{ type: 'probe', reply: `${ESC}]7501;?${BEL}` }] });
});

test('an unterminated sequence over the 4096-byte limit is let through unchanged and parsing resyncs', () => {
  const opened = `${ESC}]7501;state=working:msg=${'A'.repeat(5000)}`;
  const parser = new Osc7501Parser();
  let output = '';
  const events: Osc7501Event[] = [];
  for (const chunk of [opened.slice(0, 2000), opened.slice(2000), `${BEL}after${ESC}]7501;state=done${ST}`]) {
    const result = parser.feed(chunk);
    output += result.output;
    events.push(...result.events);
  }
  assert.equal(output, `${opened}${BEL}after`, 'held bytes are flushed byte-identical');
  assert.deepEqual(reports(events), [{ id: '', state: 'done' }], 'the next sequence parses again');
});

test('an ESC, CAN or SUB inside the sequence cancels it: the held bytes pass through unchanged', () => {
  for (const cancel of [`${ESC}[0m`, '\x18', '\x1a']) {
    const text = `${ESC}]7501;state=working${cancel}rest`;
    assert.deepEqual(run(text), { output: text, events: [] }, JSON.stringify(cancel));
    assert.deepEqual(run(text.slice(0, 12), text.slice(12)), { output: text, events: [] }, JSON.stringify(cancel));
  }
});

test('a shell prompt mark (OSC 133 A) passes through unchanged and is reported in order, once, even split', () => {
  const prompt = `${ESC}]133;A${ST}`;
  assert.deepEqual(run(`x${prompt}y`), { output: `x${prompt}y`, events: [{ type: 'prompt' }] });
  for (let cut = 1; cut < prompt.length; cut++) {
    assert.deepEqual(run(`a${prompt.slice(0, cut)}`, `${prompt.slice(cut)}b`), { output: `a${prompt}b`, events: [{ type: 'prompt' }] }, `cut ${cut}`);
  }
  const { events } = run(`${ESC}]7501;state=working${ST}${prompt}${ESC}]7501;state=done${ST}`);
  assert.deepEqual(events.map((e) => (e.type === 'report' ? e.report.state : e.type)), ['working', 'prompt', 'done']);
});

test('flush hands back what is held, unchanged, and resets the parser', () => {
  const parser = new Osc7501Parser();
  assert.deepEqual(parser.feed(`a${ESC}]7501;state=wor`), { output: 'a', events: [] });
  assert.equal(parser.flush(), `${ESC}]7501;state=wor`);
  assert.equal(parser.flush(), '');
  assert.deepEqual(parser.feed('plain'), { output: 'plain', events: [] });
});
