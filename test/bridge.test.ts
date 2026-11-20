// The gentle-shell attention bridge: a pi extension that runs inside the agent, so it must
// report blockers, dialogs and finished turns faithfully and never throw, wait or act
// outside a Mirador agent terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttentionBridge } from '../src/attention/gentle-shell-bridge.ts';

type Handler = (...args: unknown[]) => void;

/** The parts of pi's ExtensionAPI the bridge uses: lifecycle hooks and the shared event bus. */
function fakePi() {
  const hooks = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const add = (map: Map<string, Handler[]>) => (name: string, handler: Handler) => {
    map.set(name, [...(map.get(name) ?? []), handler]);
    return () => {};
  };
  return {
    api: { on: add(hooks), events: { on: add(bus), emit: (name: string, payload: unknown) => bus.get(name)?.forEach((h) => h(payload)) } },
    hook: (name: string, event: unknown = {}) => hooks.get(name)?.forEach((h) => h(event, {})),
    emit: (name: string, payload: unknown) => bus.get(name)?.forEach((h) => h(payload)),
    registered: () => hooks.size + bus.size,
  };
}

const MIRADOR_ENV = { TERM_PROGRAM: 'mirador', HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/run/mirador/herdr/socket', HERDR_BIN_PATH: '/run/mirador/herdr/herdr' };

function setup(env: Record<string, string> = MIRADOR_ENV, finish: 'now' | 'later' = 'now') {
  const calls: Array<{ file: string; args: string[] }> = [];
  const waiting: Array<() => void> = [];
  const pi = fakePi();
  createAttentionBridge({
    env,
    seq: 1000,
    exec: (file, args, done) => {
      calls.push({ file, args });
      if (finish === 'now') done();
      else waiting.push(done);
    },
  })(pi.api);
  /** The tokens a report sets, e.g. "blocked=… & prompt=…", or "clear" when it sets none. */
  const state = (args: string[]) => {
    const set = args.flatMap((arg, i) => (arg === '--token' ? [args[i + 1]] : []));
    const cleared = args.filter((arg, i) => args[i - 1] === '--clear-token');
    assert.deepEqual([...set.map((t) => t.split('=')[0]), ...cleared].sort(), ['blocked', 'finished', 'prompt'], 'every report states all three cases');
    return set.length ? set.join(' & ') : 'clear';
  };
  return { pi, calls, states: () => calls.map((c) => state(c.args)), finishNext: () => waiting.shift()?.() };
}

test('a blocker is reported through the herdr CLI as mirador:attention, and its release clears it', () => {
  const { pi, calls, states } = setup();
  pi.emit('herdr:blocked', { active: true, label: 'Guarded command confirmation' });
  pi.emit('herdr:blocked', { active: false });

  assert.deepEqual(calls[0], {
    file: '/run/mirador/herdr/herdr',
    args: ['pane', 'report-metadata', 'pane-1', '--source', 'mirador:attention', '--agent', 'pi', '--seq', '1001',
      '--token', 'blocked=Guarded command confirmation', '--clear-token', 'prompt', '--clear-token', 'finished'],
  });
  assert.deepEqual(calls[1].args, ['pane', 'report-metadata', 'pane-1', '--source', 'mirador:attention', '--agent', 'pi', '--seq', '1002',
    '--clear-token', 'blocked', '--clear-token', 'prompt', '--clear-token', 'finished']);
  assert.deepEqual(states(), ['blocked=Guarded command confirmation', 'clear']);
});

test('any dialog the agent waits on is reported with its title, next to a gentle-ai blocker', () => {
  const { pi, states } = setup();
  pi.hook('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Authorize review authority ABANDON?' });
  pi.hook('ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm', title: 'Authorize review authority ABANDON?' });
  pi.emit('herdr:blocked', { active: true, label: 'Guarded command confirmation' });
  pi.hook('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Allow recognized data-loss command?' });
  pi.hook('ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm' });
  pi.emit('herdr:blocked', { active: false });
  pi.hook('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'custom' });
  assert.deepEqual(states(), [
    'prompt=Authorize review authority ABANDON?',
    'clear',
    'blocked=Guarded command confirmation',
    'blocked=Guarded command confirmation & prompt=Allow recognized data-loss command?',
    'blocked=Guarded command confirmation',
    'clear',
    'prompt=Awaiting input',
  ]);
});

test('a dialog that ends while another is open leaves the other one reported', () => {
  const { pi, states } = setup();
  pi.hook('ui_prompt_start', { kind: 'confirm', title: 'Outer' });
  pi.hook('ui_prompt_start', { kind: 'select', title: 'Inner' });
  pi.hook('ui_prompt_end', { kind: 'select', title: 'Inner' });
  pi.hook('ui_prompt_start', { kind: 'select', title: 'Second inner' });
  pi.hook('ui_prompt_end', { kind: 'confirm', title: 'Outer' });
  pi.hook('ui_prompt_end', { kind: 'select' });
  assert.deepEqual(states(), ['prompt=Outer', 'prompt=Inner', 'prompt=Outer', 'prompt=Second inner', 'clear']);
});

test('a finished turn is reported once per turn and cleared when the agent starts again', () => {
  const { pi, states } = setup();
  pi.hook('agent_start', { type: 'agent_start' });
  pi.hook('agent_settled', { type: 'agent_settled', aborted: false });
  pi.hook('agent_start', { type: 'agent_start' });
  pi.hook('agent_settled', { type: 'agent_settled', aborted: true });
  pi.hook('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select', title: 'Startup banner' });
  assert.deepEqual(states(), ['clear', 'finished=1000-1', 'clear', 'finished=1000-2', 'prompt=Startup banner & finished=1000-2']);
});

test('a new or ending session reports that nothing is waiting', () => {
  const { pi, states } = setup();
  pi.hook('session_start');
  pi.emit('herdr:blocked', { active: true, label: 'Choice awaiting input' });
  pi.hook('ui_prompt_start', { kind: 'select', title: 'Pick one' });
  pi.hook('session_shutdown');
  pi.hook('agent_settled', { aborted: false });
  pi.hook('session_start');
  assert.deepEqual(states(), ['clear', 'blocked=Choice awaiting input', 'blocked=Choice awaiting input & prompt=Pick one', 'clear', 'finished=1000-1', 'clear']);
});

test('outside a Mirador agent terminal, or in a subagent child, the bridge does nothing', () => {
  const cases: Record<string, Record<string, string>> = {
    'plain terminal': {},
    'real herdr pane': { ...MIRADOR_ENV, TERM_PROGRAM: 'herdr' },
    'Mirador shell terminal': { TERM_PROGRAM: 'mirador' },
    'no herdr CLI': { ...MIRADOR_ENV, HERDR_BIN_PATH: '' },
    'subagent child': { ...MIRADOR_ENV, GENTLE_PI_AGENTS_CHILD: '1' },
  };
  for (const [name, env] of Object.entries(cases)) {
    const { pi, calls } = setup(env);
    pi.hook('session_start');
    pi.emit('herdr:blocked', { active: true, label: 'Choice awaiting input' });
    pi.hook('ui_prompt_start', { kind: 'confirm', title: 'Allow?' });
    pi.hook('agent_settled', { aborted: false });
    assert.equal(calls.length, 0, name);
    assert.equal(pi.registered(), 0, `${name}: registers nothing`);
  }
});

test('malformed blocker and dialog events are ignored, and labels are plain capped text', () => {
  const { pi, states } = setup();
  for (const payload of [undefined, null, 'yes', 1, [], {}, { active: 'true' }]) pi.emit('herdr:blocked', payload);
  for (const event of [null, 'confirm', 7, []]) pi.hook('ui_prompt_start', event);
  assert.deepEqual(states(), []);

  pi.emit('herdr:blocked', { active: true });
  pi.emit('herdr:blocked', { active: true, label: `\u001b[2J${'x'.repeat(500)}` });
  const [first, second] = states();
  assert.equal(first, 'blocked=Awaiting input');
  assert.match(second, /^blocked=\[2Jx+…$/);
  assert.ok(Array.from(second).length <= 'blocked='.length + 120, String(second.length));
});

test('one report runs at a time and the latest state wins', () => {
  const { pi, states, finishNext } = setup(MIRADOR_ENV, 'later');
  pi.emit('herdr:blocked', { active: true, label: 'Guarded command confirmation' });
  pi.emit('herdr:blocked', { active: false });
  pi.emit('herdr:blocked', { active: true, label: 'Choice awaiting input' });
  assert.deepEqual(states(), ['blocked=Guarded command confirmation'], 'nothing else starts while the CLI runs');
  finishNext();
  assert.deepEqual(states(), ['blocked=Guarded command confirmation', 'blocked=Choice awaiting input']);
  finishNext();
  pi.emit('herdr:blocked', { active: true, label: 'Choice awaiting input' });
  assert.equal(states().length, 2, 'an unchanged state is not sent again');
});

test('a failing herdr CLI never throws into the agent', () => {
  const pi = fakePi();
  let attempts = 0;
  createAttentionBridge({ env: MIRADOR_ENV, exec: () => { attempts++; throw new Error('spawn EACCES'); } })(pi.api);
  assert.doesNotThrow(() => pi.emit('herdr:blocked', { active: true, label: 'Choice awaiting input' }));
  assert.doesNotThrow(() => pi.emit('herdr:blocked', { active: false }));
  assert.doesNotThrow(() => pi.hook('ui_prompt_start', { kind: 'confirm', title: 'Allow?' }));
  assert.doesNotThrow(() => pi.hook('agent_settled', { aborted: false }));
  assert.equal(attempts, 4, 'a failed report does not block the next one');
});

test('a hostile payload or event never makes a bridge handler throw', () => {
  const { pi, states } = setup();
  const hostile = new Proxy({}, {
    get() { throw new Error('getter boom'); },
    getPrototypeOf() { throw new Error('prototype boom'); },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const throwing = { get active() { throw new Error('active boom'); }, get title() { throw new Error('title boom'); } };
  for (const payload of [hostile, revoked.proxy, throwing]) {
    assert.doesNotThrow(() => pi.emit('herdr:blocked', payload));
    assert.doesNotThrow(() => pi.hook('ui_prompt_start', payload));
  }
  pi.emit('herdr:blocked', { active: true, label: 'Guarded command confirmation' });
  assert.deepEqual(states(), ['blocked=Guarded command confirmation'], 'the bridge keeps working');
});
