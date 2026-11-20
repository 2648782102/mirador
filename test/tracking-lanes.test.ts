// Lanes of the Seguimiento view (public/features/tracking-model.js, trackingLanes):
// every agent, inbox night note and night-shift pending item goes to the lane of what
// it needs from the user, ordered so the one that has waited longest leads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTracking, dockGroups, placeChip, trackingLanes } from '../public/features/tracking-model.js';

const NOW = Date.parse('2026-10-28T15:00:00Z');
const NAMES: Record<string, string> = { dev: 'Dev', work: 'Work' };
const workspaceName = (id: string | null) => (id === null ? '(unknown)' : NAMES[id] ?? id);

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
  label: kind === 'finished' ? 'Finished' : 'Guarded command confirmation',
  detail: null,
  since: '2026-10-28T14:50:00Z',
  activity: null,
  ...over,
});

const night = (state: string, at: string, over: Record<string, unknown> = {}) => ({ state, flow: 'question', summary: '', at, ...over });

const pendingItem = (id: string, terminalId: string, time: string, over: Record<string, unknown> = {}) => ({
  id,
  time,
  kind: 'question',
  terminalId,
  workspaceId: 'dev',
  rel: 'games/acme-game',
  tool: null,
  summary: `question ${id}`,
  rule: 'sensitive:push',
  reason: 'touches a push',
  ...over,
});

function lanes({ terminals = [] as any[], items = [] as any[], nightNotes = [] as any[], pending = [] as any[], activity = [] as any[] } = {}) {
  const model = buildTracking({ terminals, items, activity, workspaceOrder: ['dev', 'work'], now: NOW });
  return trackingLanes({ model, items, nightNotes, pending, workspaceName });
}

function dock({ terminals = [] as any[], items = [] as any[], activity = [] as any[], sleeping = undefined as any[] | undefined } = {}) {
  return dockGroups({ model: buildTracking({ terminals, items, activity, workspaceOrder: ['dev', 'work'], now: NOW }), workspaceName, ...(sleeping ? { sleeping } : {}) });
}

const ids = (group: any) => group.cards.map((card: any) => card.id ?? card.terminalId ?? card.project);
const keys = (lane: any) => lane.groups.map((group: any) => group.key);

test('placeChip reduces workspace › folder to the workspace and the last folder, keeping the full path apart', () => {
  assert.deepEqual(placeChip('Dev', 'tools/mirador'), { chip: 'Dev › mirador', full: 'Dev › tools › mirador' });
  assert.deepEqual(placeChip('Dev', 'mirador'), { chip: 'Dev › mirador', full: 'Dev › mirador' });
  assert.deepEqual(placeChip('Dev', ''), { chip: 'Dev', full: 'Dev' });
  assert.deepEqual(placeChip('Dev', null), { chip: 'Dev', full: 'Dev' });
  assert.deepEqual(placeChip('Dev', '/web/shop/'), { chip: 'Dev › shop', full: 'Dev › web › shop' });
});

test('agents waiting for an answer go to "needs you", the longest wait first, with their place and night line', () => {
  const result = lanes({
    terminals: [terminal('a'), terminal('b', { workspaceId: 'work', rel: '' }), terminal('w')],
    items: [
      item('a', 'prompt', { since: '2026-10-28T14:40:00Z', night: night('deferred', '2026-10-28T14:41:00Z', { rule: 'low-confidence' }) }),
      item('b', 'blocked', { since: '2026-10-28T12:50:00Z', workspaceId: 'work', rel: '' }),
    ],
  });
  assert.deepEqual(keys(result.needs), ['waiting']);
  const [waiting] = result.needs.groups;
  assert.deepEqual(ids(waiting), ['b', 'a']);
  assert.equal(waiting.cards[0].type, 'agent');
  assert.equal(waiting.cards[0].state, 'waiting');
  assert.equal(waiting.cards[0].minutes, 130);
  assert.deepEqual(waiting.cards[0].place, { chip: 'Work', full: 'Work' });
  assert.equal(waiting.cards[0].night, null);
  assert.deepEqual(waiting.cards[1].place, { chip: 'Dev › mirador', full: 'Dev › tools › mirador' });
  assert.deepEqual(waiting.cards[1].night, night('deferred', '2026-10-28T14:41:00Z', { rule: 'low-confidence' }));
  assert.ok(!result.working.groups.some((group: any) => group.cards.some((card: any) => card.id === 'a' || card.id === 'b')), 'a waiting agent is not also working');
});

// An agent stopped with an error waits for the user with the
// blocked ones, as the inbox's "Needs you" list has it (release-c2): one list, the longest wait first.
test('an agent stopped with an error goes to "needs you" with the waiting agents, the longest wait first, and to no other lane', () => {
  const result = lanes({
    terminals: [terminal('q1'), terminal('e1'), terminal('q2'), terminal('w1')],
    items: [
      item('q1', 'blocked', { since: '2026-10-28T14:00:00Z' }),
      item('e1', 'error', { since: '2026-10-28T13:00:00Z', label: 'Error', detail: 'Build failed' }),
      item('q2', 'prompt', { since: '2026-10-28T14:30:00Z' }),
    ],
  });
  assert.deepEqual(result.needs.groups.map((g: any) => [g.key, ids(g)]), [['waiting', ['e1', 'q1', 'q2']]]);
  assert.equal(result.needs.count, 3);
  const [error] = result.needs.groups[0].cards;
  assert.deepEqual([error.state, error.itemKind, error.label, error.detail, error.minutes], ['error', 'error', 'Error', 'Build failed', 120]);
  assert.deepEqual(result.review, { count: 0, groups: [] });
  assert.deepEqual(result.working.groups.map((g: any) => [g.key, ids(g)]), [['working', ['w1']]]);
  assert.equal(result.strip.running, 4, 'it still runs');
});

test('night-shift pending items follow the waiting agents in "needs you", oldest first, placed by workspace and folder', () => {
  const result = lanes({
    terminals: [terminal('a')],
    items: [item('a', 'blocked')],
    pending: [
      pendingItem('p2', 'x', '2026-10-28T04:20:00Z'),
      pendingItem('p1', 'y', '2026-10-28T01:05:00Z', { workspaceId: null, rel: null, kind: 'follow-up' }),
    ],
  });
  assert.deepEqual(keys(result.needs), ['waiting', 'pending']);
  const pending = result.needs.groups[1];
  assert.deepEqual(ids(pending), ['p1', 'p2']);
  assert.deepEqual(pending.cards[0], {
    type: 'pending',
    id: 'p1',
    terminalId: 'y',
    kind: 'follow-up',
    time: '2026-10-28T01:05:00Z',
    summary: 'question p1',
    rule: 'sensitive:push',
    reason: 'touches a push',
    place: { chip: '(unknown)', full: '(unknown)' },
  });
  assert.deepEqual(pending.cards[1].place, { chip: 'Dev › acme-game', full: 'Dev › games › acme-game' });
});

test('a night note Mirador left for you goes to "needs you" unless a pending item already stands for that terminal', () => {
  const result = lanes({
    terminals: [terminal('n1'), terminal('n2')],
    nightNotes: [
      item('n1', 'prompt', { since: '2026-10-28T14:30:00Z', night: night('deferred', '2026-10-28T14:31:00Z') }),
      item('n2', 'prompt', { since: '2026-10-28T14:00:00Z', night: night('deferred', '2026-10-28T14:01:00Z') }),
    ],
    pending: [pendingItem('p1', 'n1', '2026-10-28T14:31:00Z')],
  });
  assert.deepEqual(keys(result.needs), ['pending', 'deferred']);
  const deferred = result.needs.groups[1];
  assert.deepEqual(ids(deferred), ['n2']);
  assert.deepEqual(deferred.cards[0], {
    type: 'note',
    terminalId: 'n2',
    title: 'agent n2',
    kind: 'prompt',
    label: 'Guarded command confirmation',
    since: '2026-10-28T14:00:00Z',
    night: night('deferred', '2026-10-28T14:01:00Z'),
    place: { chip: 'Dev › mirador', full: 'Dev › tools › mirador' },
  });
});

test('finished agents go to "to review", the longest wait first; results Mirador resolved follow, oldest first', () => {
  const result = lanes({
    terminals: [terminal('f1'), terminal('f2'), terminal('r1'), terminal('r2')],
    items: [item('f1', 'finished', { since: '2026-10-28T14:40:00Z' }), item('f2', 'finished', { since: '2026-10-28T14:08:00Z' })],
    nightNotes: [
      item('r1', 'finished', { since: '2026-10-28T13:00:00Z', night: night('resolved', '2026-10-28T14:30:00Z', { flow: 'follow-up', summary: 'run the tests' }) }),
      item('r2', 'prompt', { since: '2026-10-28T13:00:00Z', night: night('resolved', '2026-10-28T13:30:00Z', { summary: 'Yes' }) }),
    ],
  });
  assert.deepEqual(keys(result.review), ['finished', 'resolved']);
  assert.deepEqual(ids(result.review.groups[0]), ['f2', 'f1']);
  assert.equal(result.review.groups[0].cards[0].state, 'finished');
  assert.deepEqual(ids(result.review.groups[1]), ['r2', 'r1']);
  assert.equal(result.review.groups[1].cards[0].type, 'note');
  assert.deepEqual(result.review.groups[1].cards[1].night, night('resolved', '2026-10-28T14:30:00Z', { flow: 'follow-up', summary: 'run the tests' }));
  assert.equal(result.needs.groups.length, 0, 'a resolved note needs nothing from you');
});

test('"working" lists only the agents running now, longest first, and counts shells; closed agents and Engram-only projects leave the lanes', () => {
  const result = lanes({
    terminals: [
      terminal('w1', { createdAt: '2026-10-28T14:35:00Z' }),
      terminal('w2', { createdAt: '2026-10-28T11:55:00Z', rel: 'games/acme-game', cwd: '/home/m/Dev/games/acme-game' }),
      terminal('x1', { status: 'exited', exitCode: 0, createdAt: '2026-10-28T10:00:00Z' }),
      terminal('s1', { kind: 'shell' }),
      terminal('s2', { kind: 'shell' }),
    ],
    nightNotes: [item('w1', 'prompt', { night: night('deciding', '2026-10-28T14:59:00Z') })],
    activity: [
      { project: 'gentle-pi', count: 3, lastAt: '2026-10-28 00:41:00', titles: ['t1'] },
      { project: 'acme-web', count: 2, lastAt: '2026-10-28 09:00:00', titles: [] },
    ],
  });
  assert.deepEqual(keys(result.working), ['working']);
  assert.deepEqual(ids(result.working.groups[0]), ['w2', 'w1']);
  assert.deepEqual(result.working.groups[0].cards[1].night, night('deciding', '2026-10-28T14:59:00Z'), 'a working agent shows what Mirador is doing for it');
  assert.deepEqual(result.working.groups[0].cards[0].place, { chip: 'Dev › acme-game', full: 'Dev › games › acme-game' });
  assert.equal(result.working.count, 2);
  assert.equal(result.working.shells, 2);
  assert.equal(result.needs.groups.length, 0, 'a deciding note does not need you yet');
});

test('the dock lists closed agents, oldest first, then Engram projects active today with no agent in Mirador, in activity order', () => {
  const result = dock({
    terminals: [
      terminal('w1'),
      terminal('x2', { status: 'exited', exitCode: 1, createdAt: '2026-10-28T12:00:00Z', workspaceId: 'work', rel: '' }),
      terminal('x1', { status: 'exited', exitCode: 0, createdAt: '2026-10-28T10:00:00Z' }),
    ],
    activity: [
      { project: 'acme-web', count: 2, lastAt: '2026-10-28 09:00:00', titles: [] },
      { project: 'mirador', count: 9, lastAt: '2026-10-28 14:00:00', titles: ['m1'] },
      { project: 'gentle-pi', count: 3, lastAt: '2026-10-28 00:41:00', titles: ['t1'] },
    ],
  });
  assert.deepEqual(keys(result), ['exited', 'outside']);
  assert.deepEqual(ids(result.groups[0]), ['x1', 'x2']);
  assert.equal(result.groups[0].cards[0].type, 'agent');
  assert.equal(result.groups[0].cards[0].exitCode, 0);
  assert.deepEqual(result.groups[0].cards[1].place, { chip: 'Work', full: 'Work' });
  assert.deepEqual(ids(result.groups[1]), ['acme-web', 'gentle-pi'], 'mirador has a running agent here, so it is not outside');
  assert.deepEqual(result.groups[1].cards[1], { type: 'project', project: 'gentle-pi', count: 3, lastAt: '2026-10-28 00:41:00', titles: ['t1'] });
  assert.equal(result.count, 4);
  assert.deepEqual(dock(), { count: 0, groups: [] }, 'nothing closed and no activity: an empty dock section');
});

test('each terminal appears only in its most urgent lane: needs you, then to review, then working', () => {
  // The verifier's repro: a running agent with a deferred night note and no pending item.
  const repro = lanes({ terminals: [terminal('n2')], nightNotes: [item('n2', 'prompt', { night: night('deferred', '2026-10-28T14:01:00Z') })] });
  assert.deepEqual(repro.needs.groups.map((g: any) => [g.key, ids(g)]), [['deferred', ['n2']]]);
  assert.deepEqual(repro.working, { count: 0, groups: [], shells: 0 });

  const result = lanes({
    terminals: [terminal('r1'), terminal('f1'), terminal('w1')],
    items: [item('f1', 'finished')],
    nightNotes: [item('r1', 'finished', { night: night('resolved', '2026-10-28T14:00:00Z') })],
    pending: [pendingItem('p1', 'f1', '2026-10-28T03:00:00Z')],
  });
  assert.deepEqual(result.needs.groups.map((g: any) => [g.key, ids(g)]), [['pending', ['p1']]], 'the pending item of a finished agent needs you');
  assert.deepEqual(result.review.groups.map((g: any) => [g.key, ids(g)]), [['resolved', ['r1']]], 'f1 is not listed again to review');
  assert.equal(result.review.count, 0);
  assert.deepEqual(result.working.groups.map((g: any) => [g.key, ids(g)]), [['working', ['w1']]], 'r1 runs, but its resolved note already shows it to review');
  assert.equal(result.working.count, 1);
});

test('every lane group is oldest first: the one that has waited longest leads', () => {
  const result = lanes({
    terminals: [
      ...['q1', 'q2', 'q3', 'f1', 'f2', 'f3'].map((id) => terminal(id)),
      terminal('w1', { createdAt: '2026-10-28T13:00:00Z' }),
      terminal('w2', { createdAt: '2026-10-28T09:00:00Z' }),
      terminal('w3', { createdAt: '2026-10-28T11:00:00Z' }),
    ],
    items: [
      item('q1', 'blocked', { since: '2026-10-28T14:00:00Z' }),
      item('q2', 'prompt', { since: '2026-10-28T12:00:00Z' }),
      item('q3', 'blocked', { since: '2026-10-28T13:00:00Z' }),
      item('f1', 'finished', { since: '2026-10-28T13:30:00Z' }),
      item('f2', 'finished', { since: '2026-10-28T14:30:00Z' }),
      item('f3', 'finished', { since: '2026-10-28T12:30:00Z' }),
    ],
    nightNotes: [
      item('d1', 'prompt', { since: '2026-10-28T14:10:00Z', night: night('deferred', '2026-10-28T14:11:00Z') }),
      item('d2', 'prompt', { since: '2026-10-28T10:10:00Z', night: night('deferred', '2026-10-28T10:11:00Z') }),
      item('d3', 'prompt', { since: '2026-10-28T12:10:00Z', night: night('deferred', '2026-10-28T12:11:00Z') }),
      item('r1', 'finished', { night: night('resolved', '2026-10-28T11:00:00Z') }),
      item('r2', 'finished', { night: night('resolved', '2026-10-28T14:00:00Z') }),
      item('r3', 'finished', { night: night('resolved', '2026-10-28T08:00:00Z') }),
    ],
    pending: [pendingItem('p1', 'g1', '2026-10-28T04:00:00Z'), pendingItem('p2', 'g2', '2026-10-28T02:00:00Z'), pendingItem('p3', 'g3', '2026-10-28T03:00:00Z')],
  });
  const order = (lane: any) => lane.groups.map((g: any) => [g.key, ids(g)]);
  assert.deepEqual(order(result.needs), [['waiting', ['q2', 'q3', 'q1']], ['pending', ['p2', 'p3', 'p1']], ['deferred', ['d2', 'd3', 'd1']]]);
  assert.deepEqual(order(result.review), [['finished', ['f3', 'f1', 'f2']], ['resolved', ['r3', 'r1', 'r2']]]);
  assert.deepEqual(order(result.working), [['working', ['w2', 'w3', 'w1']]]);
});

test('with no terminal in two lanes, "needs you" and "to review" keep their groups, cards and counts', () => {
  const result = lanes({
    terminals: [terminal('q1', { workspaceId: 'work', rel: 'api' }), terminal('f1')],
    items: [item('q1', 'blocked', { since: '2026-10-28T14:40:00Z', workspaceId: 'work', rel: 'api', label: 'Choice awaiting input', detail: 'Pick one' })],
    nightNotes: [item('r1', 'finished', { since: '2026-10-28T13:00:00Z', night: night('resolved', '2026-10-28T14:00:00Z', { summary: 'Yes' }) })],
    pending: [pendingItem('p1', 'gone', '2026-10-28T03:00:00Z')],
  });
  assert.deepEqual(result.needs.groups.map((g: any) => [g.key, ids(g)]), [['waiting', ['q1']], ['pending', ['p1']]]);
  assert.equal(result.needs.count, 2);
  assert.deepEqual(
    { ...result.needs.groups[0].cards[0] },
    {
      type: 'agent',
      id: 'q1',
      title: 'agent q1',
      workspaceId: 'work',
      rel: 'api',
      cwd: '/home/m/Dev/tools/mirador',
      state: 'waiting',
      itemKind: 'blocked',
      label: 'Choice awaiting input',
      detail: 'Pick one',
      activity: null,
      since: '2026-10-28T14:40:00Z',
      minutes: 20,
      exitCode: null,
      place: { chip: 'Work › api', full: 'Work › api' },
      night: null,
    },
  );
  assert.deepEqual(result.review.groups.map((g: any) => [g.key, ids(g)]), [['resolved', ['r1']]]);
  assert.equal(result.review.count, 0, 'a resolved note is only for your information');
  assert.deepEqual(result.working.groups.map((g: any) => [g.key, ids(g)]), [['working', ['f1']]]);
});

test('lane counts are what needs action (every "needs you" card, finished agents, running agents) and the strip has projects and running agents', () => {
  const result = lanes({
    terminals: [terminal('q1'), terminal('f1'), terminal('w1'), terminal('w2'), terminal('x1', { status: 'exited', exitCode: 1 }), terminal('r1')],
    items: [item('q1', 'blocked'), item('f1', 'finished')],
    nightNotes: [
      item('r1', 'finished', { night: night('resolved', '2026-10-28T14:00:00Z') }),
      item('d1', 'prompt', { night: night('deferred', '2026-10-28T14:00:00Z') }),
    ],
    pending: [pendingItem('p1', 'gone', '2026-10-28T03:00:00Z'), pendingItem('p2', 'gone2', '2026-10-28T04:00:00Z')],
    activity: [{ project: 'acme-web', count: 2, lastAt: '2026-10-28 09:00:00', titles: [] }],
  });
  assert.equal(result.needs.count, 4, 'q1 waiting, p1 and p2 pending, d1 deferred');
  assert.equal(result.review.count, 1, 'f1 finished; the resolved r1 is only for your information');
  assert.equal(result.working.count, 2, 'w1 and w2 run without a card; r1 shows to review; the exited x1 is not counted');
  assert.deepEqual(result.strip, { projects: 2, running: 5 });
});

test('with nothing running, nothing pending and no activity every lane is empty and every count is zero', () => {
  const empty = { count: 0, groups: [] };
  assert.deepEqual(lanes(), { strip: { projects: 0, running: 0 }, needs: empty, review: empty, working: { count: 0, groups: [], shells: 0 } });
  const model = buildTracking({ terminals: [], items: [], activity: [], now: NOW });
  assert.deepEqual(trackingLanes({ model, pending: null }).needs, empty, 'pending not read yet counts as none');
});

test('R5a: sleeping agents get their own dock group between the closed agents and the outside projects, oldest first', () => {
  const sleeper = (id: string, workspaceId: string, rel: string, createdAt: string) => ({ id, workspaceId, rel, createdAt, resumable: id !== 's2' });
  const result = dock({
    terminals: [terminal('x1', { status: 'exited', exitCode: 1 })],
    activity: [{ project: 'acme-web', count: 2, lastAt: '2026-10-28 09:00:00', titles: [] }],
    sleeping: [sleeper('s1', 'work', 'api', '2026-10-28T12:00:00Z'), sleeper('s2', 'dev', 'games/acme-game', '2026-10-28T08:00:00Z')],
  });
  assert.deepEqual(result.groups.map((g: any) => [g.key, ids(g)]), [['exited', ['x1']], ['sleeping', ['s2', 's1']], ['outside', ['acme-web']]]);
  assert.equal(result.count, 4);
  assert.deepEqual(result.groups[1].cards[0], { type: 'sleeping', id: 's2', workspaceId: 'dev', rel: 'games/acme-game', createdAt: '2026-10-28T08:00:00Z', resumable: false, place: { chip: 'Dev › acme-game', full: 'Dev › games › acme-game' } });
  assert.deepEqual(dock().groups, [], 'no sleeping agents, no group');
});

// An agent whose error or finished card was seen stays in its lane, not in "working": its card left the
// inbox, but the lane follows the agentState the server reports.
test('an agent with a seen error card stays in "needs you" and one with a seen finished card in "to review"', () => {
  const result = lanes({ terminals: [terminal('e', { agentState: 'error' }), terminal('f', { agentState: 'finished' }), terminal('w', { agentState: 'working' })] });
  assert.deepEqual(result.needs.groups.map((g: any) => [g.key, ids(g)]), [['waiting', ['e']]]);
  assert.deepEqual(result.review.groups.map((g: any) => [g.key, ids(g)]), [['finished', ['f']]]);
  assert.deepEqual(result.working.groups.map((g: any) => [g.key, ids(g)]), [['working', ['w']]]);
});
