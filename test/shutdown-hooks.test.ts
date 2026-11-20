import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShutdownHooks } from '../src/system/shutdown-hooks.ts';

test('a hook that throws synchronously does not stop the hooks after it', async () => {
  const ran: string[] = [];
  const logged: unknown[] = [];
  await runShutdownHooks(
    [
      () => {
        throw new Error('sync boom');
      },
      async () => {
        throw new Error('async boom');
      },
      () => {
        ran.push('last');
      },
    ],
    (error) => logged.push(error),
  );
  assert.deepEqual(ran, ['last']);
  assert.deepEqual(logged.map((e) => (e as Error).message), ['sync boom', 'async boom']);
});

test('the hooks run one after another, in order', async () => {
  const ran: string[] = [];
  await runShutdownHooks([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ran.push('first');
    },
    () => {
      ran.push('second');
    },
  ]);
  assert.deepEqual(ran, ['first', 'second']);
});
