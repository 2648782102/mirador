// Pure rules of the terminal order (public/terminal-order-model.js): tabs and grid cells reordered
// by drag and drop inside their workspace group, saved per folder and kind so a restart keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SLOTS, MAX_WORKSPACES, moveTerminal, moveTerminalBy, orderGroup, readOrder, slotKey } from '../public/terminal-order-model.js';

const terminal = (id: string, rel: string, kind = 'agent', workspaceId = 'dev') => ({ id, workspaceId, rel, kind });
const ids = (list: Array<{ id: string }>) => list.map((info) => info.id);
const dev = (order: Map<string, string[]>, list: Array<{ id: string; workspaceId: string }>) => ids(orderGroup(list.filter((t) => t.workspaceId === 'dev'), order.get('dev')));

test('a terminal is saved by its folder and kind, not by its id', () => {
  assert.equal(slotKey(terminal('a', 'api', 'agent')), 'api|agent');
  assert.equal(slotKey(terminal('b', '', 'shell')), '|shell');
});

test('with no saved order a group keeps creation order', () => {
  const list = [terminal('a', 'api'), terminal('b', 'web'), terminal('c', 'docs', 'shell')];
  assert.deepEqual(ids(orderGroup(list, undefined)), ['a', 'b', 'c']);
  assert.deepEqual(ids(orderGroup(list, [])), ['a', 'b', 'c']);
});

test('moving before or after another terminal reorders the group, and the saved order reproduces it', () => {
  const list = [terminal('a', 'api'), terminal('b', 'web'), terminal('c', 'docs')];
  const before = moveTerminal(new Map(), list, 'c', 'a', 'before');
  assert.deepEqual(dev(before, list), ['c', 'a', 'b']);
  assert.deepEqual(before.get('dev'), ['docs|agent', 'api|agent', 'web|agent']);
  const after = moveTerminal(before, list, 'c', 'b', 'after');
  assert.deepEqual(dev(after, list), ['a', 'b', 'c']);
  // Saved and read back, as prefs does with JSON.
  assert.deepEqual(dev(readOrder(JSON.parse(JSON.stringify([...before]))), list), ['c', 'a', 'b']);
});

test('after a restart (new ids, another creation order) the saved order comes back by folder and kind', () => {
  const list = [terminal('a', 'api'), terminal('b', 'web'), terminal('c', 'docs', 'shell')];
  const order = moveTerminal(new Map(), list, 'c', 'a', 'before');
  const restarted = [terminal('x', 'web'), terminal('y', 'docs', 'shell'), terminal('z', 'api')];
  assert.deepEqual(dev(order, restarted), ['y', 'z', 'x']);
});

test('several terminals of the same folder and kind keep their creation order among themselves', () => {
  const list = [terminal('a1', 'api'), terminal('s', 'api', 'shell'), terminal('a2', 'api')];
  const order = moveTerminal(new Map(), list, 's', 'a1', 'before');
  assert.deepEqual(order.get('dev'), ['api|shell', 'api|agent', 'api|agent']);
  assert.deepEqual(dev(order, list), ['s', 'a1', 'a2']);
  // Swapping the two agents of one folder cannot be told apart once saved: creation order wins.
  assert.deepEqual(dev(moveTerminal(order, list, 'a2', 'a1', 'before'), list), ['s', 'a1', 'a2']);
  // A third agent of that folder has no saved place yet: it goes last.
  assert.deepEqual(dev(order, [...list, terminal('a3', 'api')]), ['s', 'a1', 'a2', 'a3']);
});

test('a move onto another workspace group, onto itself or onto an unknown terminal changes nothing', () => {
  const list = [terminal('a', 'api'), terminal('b', 'web'), terminal('w', 'site', 'agent', 'web')];
  const order = new Map([['dev', ['web|agent']]]);
  assert.equal(moveTerminal(order, list, 'w', 'a', 'before'), order);
  assert.equal(moveTerminal(order, list, 'a', 'w', 'after'), order);
  assert.equal(moveTerminal(order, list, 'a', 'a', 'after'), order);
  assert.equal(moveTerminal(order, list, 'gone', 'a', 'before'), order);
  assert.deepEqual([...order], [['dev', ['web|agent']]]);
});

test('a new terminal goes to the end of its group, after the ones with a saved place', () => {
  const list = [terminal('a', 'api'), terminal('b', 'web')];
  const order = moveTerminal(new Map(), list, 'b', 'a', 'before');
  assert.deepEqual(dev(order, [terminal('n', 'new'), ...list]), ['b', 'a', 'n']);
  assert.deepEqual(dev(order, [...list, terminal('n', 'new')]), ['b', 'a', 'n']);
});

test('saved places of folders that are not open survive a move and apply when they reopen', () => {
  const order = new Map([['dev', ['api|agent', 'closed|agent', 'web|agent']], ['ops', ['infra|shell']]]);
  const list = [terminal('a', 'api'), terminal('b', 'web')];
  const moved = moveTerminal(order, list, 'b', 'a', 'before');
  assert.deepEqual(dev(moved, list), ['b', 'a']);
  assert.ok(moved.get('dev')!.includes('closed|agent'));
  assert.deepEqual(moved.get('ops'), ['infra|shell']);
  assert.deepEqual(dev(moved, [...list, terminal('c', 'closed')]), ['b', 'c', 'a']);
});

test('the saved order is bounded: closed folders go first, then the workspaces least recently reordered', () => {
  const closed = Array.from({ length: MAX_SLOTS + 10 }, (_, i) => `old${i}|agent`);
  const list = [terminal('a', 'api'), terminal('b', 'web')];
  const moved = moveTerminal(new Map([['dev', ['api|agent', ...closed, 'web|agent']]]), list, 'b', 'a', 'before');
  assert.equal(moved.get('dev')!.length, MAX_SLOTS);
  assert.deepEqual(dev(moved, list), ['b', 'a']);
  const many = new Map(Array.from({ length: MAX_WORKSPACES }, (_, i) => [`ws${i}`, ['x|agent']]));
  const latest = moveTerminal(many, list, 'b', 'a', 'before');
  assert.equal(latest.size, MAX_WORKSPACES);
  assert.equal(latest.has('ws0'), false);
  assert.deepEqual([...latest.keys()].at(-1), 'dev');
});

test('a saved order that is not a list of [workspace, slots] pairs reads as empty or loses the bad entries', () => {
  assert.deepEqual([...readOrder(null)], []);
  assert.deepEqual([...readOrder('broken')], []);
  assert.deepEqual([...readOrder({ dev: ['api|agent'] })], []);
  assert.deepEqual([...readOrder([['dev', ['api|agent', 7]], ['bad'], [3, []], ['web', 'x']])], [['dev', ['api|agent']]]);
});

test('without dragging, the active terminal moves one place left or right inside its group', () => {
  const list = [terminal('a', 'api'), terminal('b', 'web'), terminal('c', 'docs'), terminal('w', 'site', 'agent', 'web')];
  const left = moveTerminalBy(new Map(), list, 'c', -1);
  assert.deepEqual(dev(left, list), ['a', 'c', 'b']);
  assert.deepEqual(dev(moveTerminalBy(left, list, 'c', 1), list), ['a', 'b', 'c']);
  // At either end of its group, or alone in it, it stays put.
  assert.equal(moveTerminalBy(left, list, 'a', -1), left);
  assert.equal(moveTerminalBy(left, list, 'w', 1), left);
});
