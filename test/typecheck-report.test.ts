// scripts/typecheck-report.ts: the informational test/ typecheck. It counts tsc's errors per area and
// compares the test/ count with the recorded baseline; it never fails the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countByArea, reportLine, TEST_BASELINE } from '../scripts/typecheck-report.ts';

const OUTPUT = [
  "test/a.test.ts(3,10): error TS7016: Could not find a declaration file for module '../public/x.js'.",
  'test/a.test.ts(9,1): error TS7006: Parameter \'x\' implicitly has an \'any\' type.',
  "scripts/eval-night.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/night/service.ts(774,5): error TS2345: Argument of type 'x' is not assignable.",
  '  Type \'x\' is not assignable to type \'y\'.',
  'Found 4 errors in 3 files.',
].join('\n');

test('the test/ baseline is the last measured count (it was 252 after src/ reached 0)', () => {
  assert.equal(TEST_BASELINE, 250);
});

test('errors are counted per area by the path tsc prints, continuation lines and the summary are not errors', () => {
  assert.deepEqual(countByArea(OUTPUT), { src: 1, test: 3 });
});

test('the report line says the count, the baseline and whether it grew', () => {
  assert.equal(reportLine(250), 'typecheck test/ + scripts/: 250 errors (baseline 250). Informational, not a CI gate.');
  assert.equal(reportLine(248), 'typecheck test/ + scripts/: 248 errors (baseline 250, 2 fewer). Informational, not a CI gate.');
  assert.equal(reportLine(253), 'typecheck test/ + scripts/: 253 errors (baseline 250, 3 MORE: your change adds type errors). Informational, not a CI gate.');
});

test('lines without a test/ or scripts/ path (config errors, public/, node_modules/) are not counted', () => {
  const out = "error TS5058: The specified path does not exist: 'tsconfig.test.json'.\npublic/x.js(1,1): error TS7016: z\nnode_modules/foo/index.d.ts(1,1): error TS1000: q";
  assert.deepEqual(countByArea(out), { src: 0, test: 0 });
});

test('when tsc cannot run, the report says so instead of reading as 0 errors, and still exits 0', async () => {
  const { mkdtemp, mkdir, copyFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'mirador-typecheck-report-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../scripts/typecheck-report.ts', import.meta.url), join(dir, 'scripts', 'typecheck-report.ts'));
    const run = spawnSync(process.execPath, [join(dir, 'scripts', 'typecheck-report.ts')], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /^typecheck test\/: tsc did not run \(/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
