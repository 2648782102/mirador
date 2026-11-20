// Informational typecheck of test/ and scripts/: runs tsc with tsconfig.test.json, counts the errors in
// test/ and scripts/ (errors tsc finds in src/ files they import belong to `pnpm typecheck:src`) and
// compares them with the baseline measured once src/ reached 0 (it was 253 on main 60c20e3). It always exits 0: it is not a CI gate.
//   node scripts/typecheck-report.ts
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TEST_BASELINE = 250;

const ERROR_LINE = /^(\S[^(]*)\(\d+,\d+\): error TS\d+:/;

/** Errors in tsc's `--pretty false` output, by area: `src` for src/, `test` for test/ and scripts/. */
export function countByArea(output: string): { src: number; test: number } {
  const counts = { src: 0, test: 0 };
  for (const line of output.split('\n')) {
    const file = ERROR_LINE.exec(line)?.[1];
    if (!file) continue;
    if (file.startsWith('src/')) counts.src += 1;
    else if (file.startsWith('test/') || file.startsWith('scripts/')) counts.test += 1;
  }
  return counts;
}

export function reportLine(count: number): string {
  const delta = count - TEST_BASELINE;
  const against = delta === 0 ? `baseline ${TEST_BASELINE}`
    : delta < 0 ? `baseline ${TEST_BASELINE}, ${-delta} fewer`
    : `baseline ${TEST_BASELINE}, ${delta} MORE: your change adds type errors`;
  return `typecheck test/ + scripts/: ${count} errors (${against}). Informational, not a CI gate.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tsc = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8', shell: false });
  // tsc ran when it exits 0, or when it exits with errors that name files. A missing tsc (node's "Cannot find
  // module", exit 1) or a broken config (error TS5058 with no file) is no count: say so instead of "0 errors".
  const output = `${tsc.stdout ?? ''}`;
  const ran = !tsc.error && (tsc.status === 0 || output.split('\n').some((line) => ERROR_LINE.test(line)));
  if (!ran) {
    const why = tsc.error?.message ?? (`${tsc.stderr ?? ''}${output}`.split('\n').find((line) => line.trim()) || `exit ${tsc.status}`);
    console.log(`typecheck test/: tsc did not run (${why.trim()}). Informational, not a CI gate.`);
  } else {
    console.log(reportLine(countByArea(tsc.stdout).test));
  }
}
