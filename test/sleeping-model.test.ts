// Pure rules of the sleeping agents in the window:
// how Desarrollo groups them with each workspace's terminals, and the copy in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepingCounts, sleepingGroups, withSleepingGroups } from '../public/features/sleeping-model.js';
import { translate } from '../public/i18n.js';

const WORKSPACES = [
  { id: 'dev', name: 'Dev' },
  { id: 'web', name: 'Web' },
  { id: 'ops', name: 'Ops' },
];
const sleeper = (id: string, workspaceId: string, rel: string, createdAt = '2026-10-29T10:00:00.000Z') => ({ id, workspaceId, rel, createdAt, resumable: true });

test('sleeping agents are counted per workspace and grouped in sidebar order, unknown workspaces last, folders sorted', () => {
  const agents = [sleeper('1', 'web', 'shop'), sleeper('2', 'gone', 'x'), sleeper('3', 'dev', 'b'), sleeper('4', 'dev', 'a')];
  assert.deepEqual([...sleepingCounts(agents)], [['web', 1], ['gone', 1], ['dev', 2]]);
  const groups = sleepingGroups(agents, WORKSPACES);
  assert.deepEqual(groups.map((g) => [g.workspaceId, g.name, g.known, g.agents.map((a) => a.rel)]), [
    ['dev', 'Dev', true, ['a', 'b']],
    ['web', 'Web', true, ['shop']],
    ['gone', 'gone', false, ['x']],
  ]);
  assert.deepEqual(sleepingGroups([], WORKSPACES), []);
});

test('Desarrollo: every terminal group gets its sleeping count, and a workspace with only sleeping agents gets a group of its own', () => {
  const groups = [
    { workspaceId: 'web', name: 'Web', known: true, terminals: [{ id: 't1' }] },
    { workspaceId: 'old', name: 'old', known: false, terminals: [{ id: 't2' }] },
  ];
  const counts = new Map([['ops', 2], ['web', 1], ['gone', 1]]);
  const merged = withSleepingGroups(groups, counts, WORKSPACES);
  assert.deepEqual(merged.map((g) => [g.workspaceId, g.terminals.length, g.sleeping]), [
    ['web', 1, 1],
    ['ops', 0, 2],
    ['old', 1, 0],
    ['gone', 0, 1],
  ]);
  assert.equal(merged[1].name, 'Ops');
  assert.deepEqual(withSleepingGroups(groups, new Map(), WORKSPACES).map((g) => [g.workspaceId, g.sleeping]), [['web', 0], ['old', 0]], 'without sleepers the groups stay as they were');
});

test('the copy: "Dormido", "Despertar", "Despertar todos", "Olvidar" and the one-line reason, with English parity', () => {
  const es = (key: string, vars?: Record<string, unknown>) => translate('es', key, vars);
  const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
  assert.equal(es('sleeping.state'), 'Dormido');
  assert.equal(es('sleeping.wake'), 'Despertar');
  assert.equal(es('sleeping.wakeAll'), 'Despertar todos');
  assert.equal(es('sleeping.forget'), 'Olvidar');
  assert.equal(es('sleeping.why'), 'Terminó su turno antes del reinicio; Mirador no lo abrió para ahorrar memoria.');
  assert.equal(es('sleeping.entry', { count: 2 }), 'Dormidos ({count})'.replace('{count}', '2'));
  assert.equal(en('sleeping.state'), 'Sleeping');
  assert.equal(en('sleeping.wake'), 'Wake');
  assert.equal(en('sleeping.wakeAll'), 'Wake all');
  assert.equal(en('sleeping.forget'), 'Forget');
  assert.equal(en('sleeping.why'), 'It had finished its turn before the restart; Mirador did not open it, to save memory.');
  assert.equal(en('sleeping.entry', { count: 2 }), 'Sleeping (2)');
});
