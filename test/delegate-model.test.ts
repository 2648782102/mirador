// Pure rules behind "Delegar a Mirador" (public/features/delegate-model.js):
// the instruction field's count and error, the request body, and the per-folder report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INSTRUCTION, checkInstruction, delegateBody, summarizeDelegation } from '../public/features/delegate-model.js';
import { MAX_INSTRUCTION_CHARS } from '../src/terminals/open-many.ts';

test('the dialog allows exactly what the server accepts', () => {
  assert.equal(MAX_INSTRUCTION, MAX_INSTRUCTION_CHARS);
});

test('checkInstruction counts the trimmed text and names what is wrong: empty, too long, a control character', () => {
  assert.deepEqual(checkInstruction(''), { count: 0, error: 'empty' });
  assert.deepEqual(checkInstruction('  \n\t '), { count: 0, error: 'empty' });
  assert.deepEqual(checkInstruction('  Run the tests.\n'), { count: 14, error: null });
  assert.deepEqual(checkInstruction('Line one\r\nline two\ttab'), { count: 21, error: null });
  assert.deepEqual(checkInstruction('x'.repeat(2000)), { count: 2000, error: null });
  assert.deepEqual(checkInstruction(`  ${'x'.repeat(2000)}  `), { count: 2000, error: null });
  assert.deepEqual(checkInstruction('x'.repeat(2001)), { count: 2001, error: 'too_long' });
  assert.deepEqual(checkInstruction('Run\u0007 it'), { count: 7, error: 'control' });
});

test('delegateBody sends the folders, the trimmed instruction, the autopilot choice and the size; never reopen', () => {
  assert.deepEqual(delegateBody('dev', ['api', 'web'], '  Run the tests.\r\n', true, { cols: 90, rows: 30 }), {
    ws: 'dev', rels: ['api', 'web'], instruction: 'Run the tests.', autopilot: true, cols: 90, rows: 30,
  });
  assert.equal(delegateBody('dev', ['api'], 'x', false, { cols: 80, rows: 24 }).autopilot, false);
});

test('summarizeDelegation lists every folder with what happened, the new terminals and the autopilot outcome', () => {
  const summary = summarizeDelegation({
    results: [
      { rel: 'web', status: 'opened', terminal: { id: 't1' } },
      { rel: 'api', status: 'sent', terminalId: 'a1' },
      { rel: 'old', status: 'missing' },
      { rel: 'bad', status: 'failed', error: "the agent's bridge is not connected" },
    ],
    autopilot: 'turned_on',
  });
  assert.deepEqual(summary.opened, [{ id: 't1' }]);
  assert.deepEqual(summary.lines, [
    { rel: 'web', status: 'opened', error: null },
    { rel: 'api', status: 'sent', error: null },
    { rel: 'old', status: 'missing', error: null },
    { rel: 'bad', status: 'failed', error: "the agent's bridge is not connected" },
  ]);
  assert.deepEqual(summary.counts, { done: 2, notDone: 2 });
  assert.equal(summary.autopilot, 'turned_on');
  assert.equal(summarizeDelegation({ results: [] }).autopilot, null);
});
