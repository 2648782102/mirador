import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

// A full-screen TUI (gentle-shell's default) enters the alternate screen, turns autowrap
// off and mouse tracking on once, at start. The replay must keep those modes after the
// scrollback trim drops that start, or a new window draws its frames into the normal
// buffer, where they wrap, scroll and pile up as repeated rows.

class FakePty implements PtyProcess {
  size: [number, number];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  constructor(cols: number, rows: number) {
    this.size = [cols, rows];
  }
  onData(listener: (d: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void) { this.exitListeners.push(listener); }
  write() {}
  resize(cols: number, rows: number) { this.size = [cols, rows]; }
  kill() {}
  emitData(d: string) { this.dataListeners.forEach((l) => l(d)); }
  emitExit(exitCode: number) { this.exitListeners.forEach((l) => l({ exitCode })); }
}

function setup(scrollbackLimit: number, cols = 80, rows = 24) {
  let pty!: FakePty;
  const spawn: SpawnFn = (_file, _args, opts) => (pty = new FakePty(opts.cols, opts.rows));
  const registry = new TerminalRegistry(spawn, {
    shell: '/bin/bash',
    agentCommand: 'gentle-shell',
    agentRcFile: '/run/mirador/agent.bashrc',
    env: {},
    scrollbackLimit,
  });
  const { id } = registry.create({ cwd: '/tmp', kind: 'agent', cols, rows, workspaceId: 'dev', rel: '' });
  const replay = () => registry.attach(id, { onData: () => {}, onExit: () => {} }).scrollback;
  return { registry, id, pty, replay };
}

const START = '\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H\x1b[?25l';
const frame = (n: number) => `\x1b[?2026h\x1b[3;1H\x1b[2KWorking ${n}\x1b[4;1H\x1b[2Kimplementing ${n}\x1b[?2026l`;

test('the replay restores the modes the trimmed output had set', () => {
  const { pty, replay } = setup(200);
  pty.emitData(START);
  for (let n = 0; n < 20; n++) pty.emitData(frame(n));

  const scrollback = replay();
  assert.ok(!scrollback.includes(START), 'the start was trimmed');
  assert.ok(scrollback.startsWith('\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h'), JSON.stringify(scrollback.slice(0, 80)));
  assert.ok(scrollback.endsWith(frame(19)));
});

test('the replay adds nothing while the output that set the modes is still kept', () => {
  const { pty, replay } = setup(10_000);
  pty.emitData(START);
  pty.emitData(frame(1));
  assert.equal(replay(), START + frame(1));
});

test('modes set and reset again in the trimmed output are not restored', () => {
  const { pty, replay } = setup(20);
  pty.emitData('\x1b[?1049h\x1b[?1000hfull screen\x1b[?1000l\x1b[?1049l');
  pty.emitData('$ prompt again');
  assert.equal(replay(), '$ prompt again');
});

test('the replay follows mode changes split across chunks, with several parameters', () => {
  const { pty, replay } = setup(10);
  pty.emitData('\x1b[?10');
  pty.emitData('49h\x1b[?1000;1006h');
  pty.emitData('x'.repeat(30));
  assert.equal(replay(), '\x1b[?1049h\x1b[?1000h\x1b[?1006h' + 'x'.repeat(10));
});

test('a terminal reset in the trimmed output clears the modes it had set', () => {
  const { pty, replay } = setup(10);
  pty.emitData('\x1b[?1049h\x1b[?7l\x1bc');
  pty.emitData('x'.repeat(30));
  assert.equal(replay(), 'x'.repeat(10));
});

test('modes a terminal ignores are not replayed', () => {
  const { pty, replay } = setup(10);
  pty.emitData('\x1b[?2026h\x1b[?12h\x1b[1;31m');
  pty.emitData('x'.repeat(30));
  assert.equal(replay(), 'x'.repeat(10));
});

test('an unterminated control string does not swallow the output after it', () => {
  const { pty, replay } = setup(200);
  pty.emitData('\x1b]0;a title that never ends');
  for (let n = 0; n < 2000; n++) pty.emitData(`plain line ${n}\r\n`);

  assert.ok(replay().endsWith('plain line 1999\r\n'), JSON.stringify(replay().slice(-80)));
});

test('a closed terminal reports no exit after it was closed', () => {
  const { registry, id, pty } = setup(200);
  const events: string[] = [];
  registry.subscribe((event) => events.push(event.type));
  registry.close(id);
  pty.emitExit(0);

  assert.deepEqual(events, ['closed']);
});

test('the terminal info carries the pty size the replay was drawn for', () => {
  const { registry, id } = setup(100, 120, 40);
  assert.deepEqual([registry.get(id)?.cols, registry.get(id)?.rows], [120, 40]);
  registry.resize(id, 93, 48);
  const attachment = registry.attach(id, { onData: () => {}, onExit: () => {} });
  assert.deepEqual([attachment.info.cols, attachment.info.rows], [93, 48]);
});
