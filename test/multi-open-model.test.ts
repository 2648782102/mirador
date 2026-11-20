// Pure rules behind opening gentle-shell in several folders (public/features/multi-open-model.js):
// the marked folders per workspace, which of them already run an agent, and the batch report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyFolders, marked, markFolder, summarizeBatch, unmarkAll } from '../public/features/multi-open-model.js';

test('marking folders keeps them per workspace, once each, in name order; the count follows', () => {
  let selection = {};
  selection = markFolder(selection, 'dev', 'web', true);
  selection = markFolder(selection, 'dev', 'api', true);
  selection = markFolder(selection, 'dev', 'web', true);
  selection = markFolder(selection, 'work', 'docs', true);
  assert.deepEqual(marked(selection, 'dev'), ['api', 'web']);
  assert.deepEqual(marked(selection, 'work'), ['docs']);
  selection = markFolder(selection, 'dev', 'api', false);
  assert.deepEqual(marked(selection, 'dev'), ['web']);
  assert.deepEqual(marked(selection, 'none'), []);
});

test('marking returns a new selection and leaves the old one as it was', () => {
  const first = markFolder({}, 'dev', 'web', true);
  const second = markFolder(first, 'dev', 'api', true);
  assert.deepEqual(marked(first, 'dev'), ['web']);
  assert.deepEqual(marked(second, 'dev'), ['api', 'web']);
});

test('clearing a workspace unmarks only its folders', () => {
  let selection = markFolder(markFolder({}, 'dev', 'web', true), 'work', 'docs', true);
  selection = unmarkAll(selection, 'dev');
  assert.deepEqual(marked(selection, 'dev'), []);
  assert.deepEqual(marked(selection, 'work'), ['docs']);
});

test('busyFolders lists the folders that already run an agent in that workspace', () => {
  const terminals = [
    { id: 'a', workspaceId: 'dev', rel: 'web', kind: 'agent', status: 'running' },
    { id: 'b', workspaceId: 'dev', rel: 'api', kind: 'agent', status: 'exited' },
    { id: 'c', workspaceId: 'dev', rel: 'api', kind: 'shell', status: 'running' },
    { id: 'd', workspaceId: 'work', rel: 'docs', kind: 'agent', status: 'running' },
    { id: 'e', workspaceId: 'dev', rel: 'web', kind: 'agent', status: 'running' },
  ];
  assert.deepEqual(busyFolders(terminals, 'dev', ['web', 'api', 'docs']), ['web']);
  assert.deepEqual(busyFolders(terminals, 'work', ['docs']), ['docs']);
  assert.deepEqual(busyFolders([], 'dev', ['web']), []);
});

test('summarizeBatch splits opened terminals from skipped folders with their reason', () => {
  const summary = summarizeBatch([
    { rel: 'web', status: 'opened', terminal: { id: 't1' } },
    { rel: 'api', status: 'already_open', terminalId: 'x' },
    { rel: 'old', status: 'missing' },
    { rel: 'bad', status: 'failed', error: 'pty failed' },
  ]);
  assert.deepEqual(summary.opened, [{ id: 't1' }]);
  assert.deepEqual(summary.skipped, [
    { rel: 'api', reason: 'already_open', error: null },
    { rel: 'old', reason: 'missing', error: null },
    { rel: 'bad', reason: 'failed', error: 'pty failed' },
  ]);
  assert.deepEqual(summarizeBatch([]), { opened: [], skipped: [] });
});
