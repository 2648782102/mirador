// Pure rules behind the global tracking view (public/features/tracking-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentState, buildTracking, elapsedMinutes, projectKey } from '../public/features/tracking-model.js';

const NOW = Date.parse('2026-10-28T15:00:00Z');

const terminal = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: 'dev',
  rel: 'tools/mirador',
  cwd: '/home/m/Dev/tools/mirador',
  title: `agent ${id}`,
  kind: 'agent',
  status: 'running',
  createdAt: '2026-10-28T13:00:00Z',
  ...over,
});

const item = (terminalId: string, kind: string, over: Record<string, unknown> = {}) => ({
  terminalId,
  workspaceId: 'dev',
  rel: 'tools/mirador',
  title: `agent ${terminalId}`,
  kind,
  label: kind === 'finished' ? '' : 'Guarded command confirmation',
  detail: 'git push',
  since: '2026-10-28T14:50:00Z',
  activity: 'Writing the tracking view',
  ...over,
});

test('an agent waits for an answer on a blocked or prompt item, finished on a finished item, works otherwise', () => {
  assert.equal(agentState(terminal('a'), item('a', 'blocked')), 'waiting');
  assert.equal(agentState(terminal('a'), item('a', 'prompt')), 'waiting');
  assert.equal(agentState(terminal('a'), item('a', 'finished')), 'finished');
  assert.equal(agentState(terminal('a'), undefined), 'working');
  assert.equal(agentState(terminal('a', { status: 'exited', exitCode: 0 }), item('a', 'blocked')), 'exited', 'an exited terminal is exited whatever the inbox says');
});

// An OSC 7501 error card is its own state, not a wait.
test('an agent whose program stopped with an error (an error card) is in error, and carries the card like a waiting agent', () => {
  assert.equal(agentState(terminal('e'), item('e', 'error', { label: 'Error', detail: 'Build failed' })), 'error');
  assert.equal(agentState(terminal('e', { status: 'exited', exitCode: 1 }), item('e', 'error')), 'exited', 'an exited terminal stays exited');
  const model = buildTracking({
    terminals: [terminal('e'), terminal('q'), terminal('w')],
    items: [item('e', 'error', { label: 'Error', detail: 'Build failed', since: '2026-10-28T14:30:00Z' }), item('q', 'blocked')],
    activity: [],
    now: NOW,
  });
  const agents = model.workspaces[0].folders[0].agents;
  const e = agents.find((a: any) => a.id === 'e');
  assert.deepEqual(
    [e.state, e.itemKind, e.label, e.detail, e.since, e.minutes],
    ['error', 'error', 'Error', 'Build failed', '2026-10-28T14:30:00Z', 30],
    'it counts from when the error was reported, with the card\'s label and message',
  );
  assert.deepEqual(model.summary, { projects: 1, running: 3, working: 1, waiting: 1, finished: 0, error: 1, exited: 0, shells: 0 });
});

test('agents are grouped by workspace, in the given order, then by folder, and carry what the inbox says', () => {
  const model = buildTracking({
    terminals: [
      terminal('a', { createdAt: '2026-10-28T14:00:00Z' }),
      terminal('b', { createdAt: '2026-10-28T12:00:00Z' }),
      terminal('c', { workspaceId: 'work', rel: '', cwd: '/srv/work' }),
      terminal('d', { rel: 'games/acme-game', cwd: '/home/m/Dev/games/acme-game' }),
    ],
    items: [item('a', 'prompt', { label: 'Choice awaiting input', detail: 'Pick a layout' })],
    activity: [],
    workspaceOrder: ['work', 'dev'],
    now: NOW,
  });
  assert.deepEqual(model.workspaces.map((w: any) => w.workspaceId), ['work', 'dev']);
  const dev = model.workspaces[1];
  assert.deepEqual(dev.folders.map((f: any) => f.rel), ['games/acme-game', 'tools/mirador']);
  const mirador = dev.folders[1];
  assert.deepEqual(mirador.agents.map((a: any) => a.id), ['b', 'a'], 'oldest agent first');
  assert.deepEqual(mirador.agents[1], {
    id: 'a',
    title: 'agent a',
    workspaceId: 'dev',
    rel: 'tools/mirador',
    cwd: '/home/m/Dev/tools/mirador',
    state: 'waiting',
    itemKind: 'prompt',
    label: 'Choice awaiting input',
    detail: 'Pick a layout',
    activity: 'Writing the tracking view',
    since: '2026-10-28T14:50:00Z',
    minutes: 10,
    exitCode: null,
  });
  assert.equal(mirador.agents[0].state, 'working');
  assert.equal(mirador.agents[0].since, '2026-10-28T12:00:00Z', 'a working agent counts from its start');
  assert.equal(mirador.agents[0].minutes, 180);
  assert.equal(mirador.agents[0].activity, null);
});

test('workspaces missing from the given order come last, sorted by id', () => {
  const model = buildTracking({
    terminals: [terminal('a', { workspaceId: 'zeta' }), terminal('b', { workspaceId: 'alpha' }), terminal('c', { workspaceId: 'dev' })],
    items: [],
    activity: [],
    workspaceOrder: ['dev'],
    now: NOW,
  });
  assert.deepEqual(model.workspaces.map((w: any) => w.workspaceId), ['dev', 'alpha', 'zeta']);
});

test('the summary counts running agents by state, exited agents apart, and shells only as shells', () => {
  const model = buildTracking({
    terminals: [
      terminal('w1'),
      terminal('w2', { rel: 'games/acme-game', cwd: '/home/m/Dev/games/acme-game' }),
      terminal('q1'),
      terminal('q2'),
      terminal('f1'),
      terminal('x1', { status: 'exited', exitCode: 1 }),
      terminal('s1', { kind: 'shell' }),
      terminal('s2', { kind: 'shell', rel: 'web/shop', cwd: '/home/m/Dev/web/shop' }),
    ],
    items: [item('q1', 'blocked'), item('q2', 'prompt'), item('f1', 'finished'), item('s1', 'prompt'), item('ghost', 'blocked')],
    activity: [],
    now: NOW,
  });
  assert.deepEqual(model.summary, { projects: 2, running: 5, working: 2, waiting: 2, finished: 1, error: 0, exited: 1, shells: 2 });
  const listed = model.workspaces.flatMap((w: any) => w.folders.flatMap((f: any) => f.agents.map((a: any) => a.id)));
  assert.deepEqual(listed.sort(), ['f1', 'q1', 'q2', 'w1', 'w2', 'x1'], 'shell terminals are not listed as agents');
  const exited = model.workspaces[0].folders.find((f: any) => f.rel === 'tools/mirador').agents.find((a: any) => a.id === 'x1');
  assert.equal(exited.state, 'exited');
  assert.equal(exited.exitCode, 1);
});

test('projects advancing are the union of folders with a running agent and Engram projects active today', () => {
  const model = buildTracking({
    terminals: [
      terminal('a'), // folder "mirador", also active in Engram
      terminal('b', { rel: 'games/acme-game', cwd: '/home/m/Dev/games/acme-game/' }), // agent only
      terminal('c', { rel: 'web/shop', cwd: '/home/m/Dev/web/shop', status: 'exited', exitCode: 0 }), // exited: not advancing
      terminal('d', { rel: 'web/blog', cwd: '/home/m/Dev/web/blog', kind: 'shell' }), // a shell: not advancing
    ],
    items: [],
    activity: [
      { project: 'Mirador', count: 4, lastAt: '2026-10-28T14:40:00Z', titles: ['t1', 't2', 't3', 't4'] },
      { project: 'acme-web', count: 2, lastAt: '2026-10-28T09:00:00Z', titles: ['w1', 'w2'] },
      { project: 'idle', count: 0, lastAt: '2026-10-28T09:00:00Z', titles: [] },
    ],
    now: NOW,
  });
  assert.equal(model.summary.projects, 3, 'mirador (agent + Engram), acme-game (agent), acme-web (Engram)');
  assert.deepEqual(model.projects, [
    { project: 'Mirador', count: 4, lastAt: '2026-10-28T14:40:00Z', titles: ['t1', 't2', 't3'], withAgent: true },
    { project: 'acme-web', count: 2, lastAt: '2026-10-28T09:00:00Z', titles: ['w1', 'w2'], withAgent: false },
  ]);
});

test('with nothing running and no activity everything is empty and zero', () => {
  const model = buildTracking({ terminals: [], items: [], activity: [], now: NOW });
  assert.deepEqual(model, { summary: { projects: 0, running: 0, working: 0, waiting: 0, finished: 0, error: 0, exited: 0, shells: 0 }, workspaces: [], projects: [] });
});

test('projectKey compares a folder and an Engram project by name, ignoring case and trailing slashes', () => {
  assert.equal(projectKey('/home/m/Dev/tools/Mirador/'), 'mirador');
  assert.equal(projectKey('Mirador'), 'mirador');
  assert.equal(projectKey(''), '');
});

test('elapsedMinutes rounds down and never goes below zero or breaks on a bad date', () => {
  assert.equal(elapsedMinutes('2026-10-28T14:58:30Z', NOW), 1);
  assert.equal(elapsedMinutes('2026-10-28T15:05:00Z', NOW), 0);
  assert.equal(elapsedMinutes('not a date', NOW), 0);
});

// A seen error or finished card leaves the inbox, but GET /api/terminals still reports the agent's state.
test('an agent with no card keeps the error or finished state the server reports, with no card fields', () => {
  const model = buildTracking({
    terminals: [
      terminal('e', { agentState: 'error' }),
      terminal('f', { agentState: 'finished' }),
      terminal('w', { agentState: 'working' }),
      terminal('u', { agentState: 'unknown' }),
      terminal('n'),
      terminal('x', { status: 'exited', exitCode: 1, agentState: 'error' }),
      terminal('c', { agentState: 'error' }),
    ],
    items: [item('c', 'blocked')],
    activity: [],
    now: NOW,
  });
  const agents = model.workspaces[0].folders[0].agents;
  const of = (id: string) => agents.find((a: any) => a.id === id);
  for (const [id, state] of [['e', 'error'], ['f', 'finished']]) {
    const a = of(id);
    assert.deepEqual(
      [a.state, a.itemKind, a.label, a.detail, a.since, a.minutes],
      [state, null, null, null, '2026-10-28T13:00:00Z', 120],
      `${id}: the state comes from the server; with no card its time is the terminal's start`,
    );
  }
  assert.deepEqual(['w', 'u', 'n', 'x', 'c'].map((id) => of(id).state), ['working', 'working', 'working', 'exited', 'waiting'], 'working, unknown or no report is working; exited and a card still win');
  assert.deepEqual(model.summary, { projects: 1, running: 6, working: 3, waiting: 1, finished: 1, error: 1, exited: 1, shells: 0 });
});
