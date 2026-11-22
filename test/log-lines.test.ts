// The log-line wait the launcher tests use: a log that exists but holds no line yet (the stub has
// opened it, or written only a newline) must not end the wait.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLines, waitForLogLines } from './helpers/log-lines.ts';

let scratch: string;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mirador-log-lines-'));
});
after(() => rm(scratch, { recursive: true, force: true }));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('logLines gives only the non-empty lines, and none for a missing, empty or newline-only log', async () => {
  const path = join(scratch, 'read.log');
  assert.deepEqual(await logLines(path), [], 'missing');
  await writeFile(path, '');
  assert.deepEqual(await logLines(path), [], 'empty');
  await writeFile(path, '\n');
  assert.deepEqual(await logLines(path), [], 'only a newline');
  await writeFile(path, '\nfirst\n\n  \nsecond\n');
  assert.deepEqual(await logLines(path), ['first', 'second']);
});

for (const [name, start] of [['empty', ''], ['only a newline', '\n']] as const) {
  test(`waitForLogLines keeps waiting while the log is ${name} and returns once a real line is written`, async () => {
    const path = join(scratch, `${name.replaceAll(' ', '-')}.log`);
    await writeFile(path, start);
    let settled = false;
    const wait = waitForLogLines(path, 1, 5000).finally(() => (settled = true));
    await pause(150);
    assert.equal(settled, false, `the wait ended on a log that is ${name}`);
    await appendFile(path, '--app=http://127.0.0.1:1/#launch=abc --class=mirador\n');
    assert.deepEqual(await wait, ['--app=http://127.0.0.1:1/#launch=abc --class=mirador']);
  });
}

test('waitForLogLines waits for the count it was asked for, and names the log when it times out', async () => {
  const path = join(scratch, 'count.log');
  await writeFile(path, 'first\n\n');
  await assert.rejects(waitForLogLines(path, 2, 100), { message: `timed out after 100 ms waiting for 2 line(s) in ${path}` });
  const wait = waitForLogLines(path, 2, 5000);
  await appendFile(path, 'second\n');
  assert.deepEqual(await wait, ['first', 'second']);
});
