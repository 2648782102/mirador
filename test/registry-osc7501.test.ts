// The terminal registry reads OSC 7501 (Program Status Protocol) from each pty before anything
// else sees the output: scrollback and listeners (the WebSocket to xterm.js) never get the raw
// sequences, reports go to onStatus listeners, and the probe is answered once into the pty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRegistry, type SpawnFn } from '../src/terminals/registry.ts';
import type { ProgramStatusEvent } from '../src/attention/osc7501.ts';

const ESC = '\x1b';
const ST = `${ESC}\\`;

function setup() {
  const ptys: Array<{ emit: (data: string) => void; exit: (code: number) => void; written: string[] }> = [];
  const spawn: SpawnFn = () => {
    let onData: (data: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const written: string[] = [];
    ptys.push({ emit: (data) => onData(data), exit: (code) => onExit({ exitCode: code }), written });
    return { onData(l) { onData = l; }, onExit(l) { onExit = l; }, write(data) { written.push(data); }, resize() {}, kill() {} };
  };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'pi', agentRcFile: '/rc', env: {}, scrollbackLimit: 10_000 });
  return { registry, ptys };
}

test('raw OSC 7501 sequences reach neither the scrollback nor the listeners; the reports reach onStatus', () => {
  const { registry, ptys } = setup();
  const statuses: Array<[string, ProgramStatusEvent]> = [];
  registry.onStatus(() => { throw new Error('boom'); });
  registry.onStatus((id, event) => statuses.push([id, event]));
  const info = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  let live = '';
  registry.attach(info.id, { onData: (data) => { live += data; }, onExit() {} });

  ptys[0].emit(`hello ${ESC}]0;title\x07${ESC}]75`);
  ptys[0].emit(`01;state=working:app=pi${ST}world${ESC}]7501;state=blocked:kind=question\x07!${ESC}]133;A\x07`);

  const expected = `hello ${ESC}]0;title\x07world!${ESC}]133;A\x07`;
  assert.equal(live, expected, 'listeners get the output without the sequences, other OSC untouched');
  assert.equal(registry.attach(info.id, { onData() {}, onExit() {} }).scrollback, expected, 'scrollback too');
  assert.equal(registry.tail(info.id, 1000), 'hello world!');
  assert.deepEqual(statuses, [
    [info.id, { type: 'report', report: { id: '', state: 'working', app: 'pi' } }],
    [info.id, { type: 'report', report: { id: '', state: 'blocked', kind: 'question' } }],
    [info.id, { type: 'prompt' }],
  ]);
});

test('the probe is answered exactly once per probe, into that pty only, and is not reported as input', () => {
  const { registry, ptys } = setup();
  const inputs: string[] = [];
  registry.onInput((_id, data) => inputs.push(data));
  const a = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  let live = '';
  registry.attach(a.id, { onData: (data) => { live += data; }, onExit() {} });

  ptys[0].emit(`${ESC}]7501;?${ESC}`);
  assert.deepEqual(ptys[0].written, [], 'not answered before the probe is complete');
  ptys[0].emit(`\\${ESC}[c`);
  assert.deepEqual(ptys[0].written, [`${ESC}]7501;?${ST}`]);
  ptys[0].emit(`${ESC}]7501;?\x07`);
  assert.deepEqual(ptys[0].written, [`${ESC}]7501;?${ST}`, `${ESC}]7501;?\x07`], 'a second probe gets a second reply, in its terminator');
  assert.deepEqual(ptys[1].written, [], 'the other terminal hears nothing');
  assert.equal(live, `${ESC}[c`, 'xterm.js never sees the probe (and so never answers it too)');
  assert.deepEqual(inputs, []);
});

test('output held mid-sequence is delivered unchanged when the process exits', () => {
  const { registry, ptys } = setup();
  const info = registry.create({ cwd: '/tmp', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const events: string[] = [];
  registry.attach(info.id, { onData: (data) => events.push(`data:${data}`), onExit: (code) => events.push(`exit:${code}`) });
  ptys[0].emit(`bye${ESC}]7501;state=wor`);
  ptys[0].exit(0);
  assert.deepEqual(events, ['data:bye', `data:${ESC}]7501;state=wor`, 'exit:0']);
});

test('plain output and other escape sequences still reach listeners and scrollback as before', () => {
  const { registry, ptys } = setup();
  const info = registry.create({ cwd: '/tmp', kind: 'shell', cols: 80, rows: 24, workspaceId: 'dev', rel: '' });
  const chunks: string[] = [];
  registry.attach(info.id, { onData: (data) => chunks.push(data), onExit() {} });
  const sent = ['$ ls\r\n', `${ESC}[?1049h${ESC}[31mred${ESC}[0m`, 'é😀\r\n'];
  for (const chunk of sent) ptys[0].emit(chunk);
  assert.deepEqual(chunks, sent, 'chunk for chunk');
  assert.equal(registry.attach(info.id, { onData() {}, onExit() {} }).scrollback, sent.join(''));
});
