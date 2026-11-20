// The rules behind choosing the agent that opens in a folder
// (public/features/agent-picker-model.js): which offered agents a row's ▾ menu lists, and a
// POST /api/terminals body that names the chosen agent by its id only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentChoices, terminalBody } from '../public/features/agent-picker-model.js';

const pi = { id: 'pi', label: 'Pi (gentle-shell)', command: 'gentle-shell', configured: true, attention: 'hooks', resume: true };
const claude = { id: 'claude-code', label: 'Claude Code', command: 'claude', configured: false, attention: 'none', resume: false };
const opencode = { id: 'opencode', label: 'opencode', command: 'opencode', configured: false, attention: 'none', resume: false };

test('one offered agent (or none, or an unreadable answer) adds nothing: the row stays as today', () => {
  assert.deepEqual(agentChoices([pi]), []);
  assert.deepEqual(agentChoices([]), []);
  assert.deepEqual(agentChoices(undefined), []);
  assert.deepEqual(agentChoices({ agents: [pi, claude] }), []);
});

test('with more, the menu lists the offered agents other than the configured one, in order, by id and label', () => {
  assert.deepEqual(agentChoices([pi, claude, opencode]), [
    { id: 'claude-code', label: 'Claude Code' },
    { id: 'opencode', label: 'opencode' },
  ]);
  // A configured command outside the catalog has no id; the catalog agents are still offered.
  const custom = { id: null, label: 'my-agent --x', command: 'my-agent --x', configured: true, attention: 'none', resume: false };
  assert.deepEqual(agentChoices([custom, pi, claude].map((agent) => (agent === pi ? { ...pi, configured: false } : agent))), [
    { id: 'pi', label: 'Pi (gentle-shell)' },
    { id: 'claude-code', label: 'Claude Code' },
  ]);
  assert.deepEqual(agentChoices([pi, { ...claude, id: null }, null, { ...opencode, label: 7 }]), [], 'entries without a usable id or label are left out');
});

test('the body names a chosen agent by its id only, never its command; without one it is the body of today', () => {
  const folder = { ws: 'dev', rel: 'web' };
  const size = { cols: 120, rows: 32 };
  assert.deepEqual(terminalBody(folder, 'agent', size), { ws: 'dev', rel: 'web', kind: 'agent', cols: 120, rows: 32 });
  assert.deepEqual(terminalBody(folder, 'shell', size), { ws: 'dev', rel: 'web', kind: 'shell', cols: 120, rows: 32 });
  assert.deepEqual(terminalBody(folder, 'agent', size, 'claude-code'), { ws: 'dev', rel: 'web', kind: 'agent', cols: 120, rows: 32, agent: 'claude-code' });
  assert.deepEqual(terminalBody(folder, 'shell', size, 'claude-code'), { ws: 'dev', rel: 'web', kind: 'shell', cols: 120, rows: 32 }, 'only agent terminals take an agent');
  assert.equal('command' in terminalBody(folder, 'agent', size, 'claude-code'), false);
});
