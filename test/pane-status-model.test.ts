// What a terminal's tab and pane head show of its agent
// (public/pane-status-model.js): the sidebar's state for the same terminal, so the two always agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneStatus } from '../public/pane-status-model.js';
import { terminalState } from '../public/features/sidebar-status-model.js';

const agent = (extra: Record<string, unknown> = {}) => ({ id: 'a', workspaceId: 'dev', rel: 'x', kind: 'agent', status: 'running', ...extra });
const shell = (extra: Record<string, unknown> = {}) => ({ id: 's', workspaceId: 'dev', rel: 'x', kind: 'shell', status: 'running', ...extra });
const blocked = { terminalId: 'a', kind: 'blocked', since: '2026-11-06T10:00:00Z' };
const finished = { terminalId: 'a', kind: 'finished', since: '2026-11-06T10:00:00Z' };

test('S4: each pane shows the state, glyph and border of the artboard, from the sidebar state', () => {
  assert.deepEqual(paneStatus(agent(), undefined), { state: 'work', icon: 'work', border: null, kind: null });
  assert.deepEqual(paneStatus(agent(), blocked), { state: 'wait', icon: 'wait', border: 'waiting', kind: null });
  assert.deepEqual(paneStatus(agent(), finished), { state: 'done', icon: 'check', border: null, kind: null });
  assert.deepEqual(paneStatus(agent({ status: 'exited', exitCode: 3 }), undefined), { state: 'err', icon: 'error', border: 'error', kind: null });
  assert.deepEqual(paneStatus(agent({ status: 'exited', oomKilled: true }), undefined), { state: 'err', icon: 'error', border: 'error', kind: null });
});

test('S4: no state, no pill: an agent that ended cleanly shows nothing and a shell says bash', () => {
  assert.deepEqual(paneStatus(agent({ status: 'exited', exitCode: 0 }), finished), { state: null, icon: null, border: null, kind: null });
  assert.deepEqual(paneStatus(shell(), blocked), { state: null, icon: null, border: null, kind: 'bash' });
  assert.deepEqual(paneStatus(shell({ status: 'exited', exitCode: 1 }), undefined), { state: null, icon: null, border: null, kind: 'bash' });
});

test('a git terminal says lazygit where a shell says bash', () => {
  assert.deepEqual(paneStatus(shell({ kind: 'git' }), blocked), { state: null, icon: null, border: null, kind: 'lazygit' });
});

test('S4: tabs, panes and the sidebar never disagree on a state', () => {
  const terminals = [agent(), agent({ status: 'exited', exitCode: 2 }), agent({ status: 'exited', exitSignal: 9 }), agent({ status: 'exited', exitCode: 0 }), shell()];
  for (const terminal of terminals) for (const item of [undefined, blocked, finished]) assert.equal(paneStatus(terminal, item).state, terminalState(terminal, item));
});
