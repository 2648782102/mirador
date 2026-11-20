// The reproduction of issue #1 in test/shutdown-children.test.ts must not show up as a failing test in
// `pnpm test`: the spec reporter lists a failed `todo` test under "failing tests", even though it does not
// fail the run. It is skipped instead, with #1 named in the reason the report prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

test('the issue #1 reproduction is reported as skipped, naming #1, and never under failing tests', async () => {
  // Without NODE_TEST_CONTEXT the child runner prints its own report instead of reporting to this one.
  // Without FORCE_COLOR and with NO_COLOR its report has no colour codes, which would break the
  // line-anchored matches below, whatever the outer environment asks for.
  const { NODE_TEST_CONTEXT: _context, FORCE_COLOR: _force, ...rest } = process.env;
  const env = { ...rest, NO_COLOR: '1' };
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', 'test/shutdown-children.test.ts'], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('node --test test/shutdown-children.test.ts did not finish'));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.includes('failing tests'), false, result.stdout);
  assert.match(result.stdout, /^\S+ stopping the server without scopes leaves no process .*# .*\(#1\)$/m);
  for (const count of ['tests 1', 'pass 0', 'fail 0', 'skipped 1', 'todo 0']) assert.match(result.stdout, new RegExp(`^ℹ ${count}$`, 'm'), result.stdout);
});
