// The gitleaks allowlist covers only the fixture paths.
// No allowlist for ODD task logs; one narrow rule lets subagent ids through.
// The scan tests skip when gitleaks is not installed; CI runs the scan itself through gitleaks-action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installed = spawnSync('gitleaks', ['version']).status === 0;
const CONFIG = join(process.cwd(), '.gitleaks.toml');
const FIXTURE_PATHS = [
  '^test/night-telegram-answers\\.test\\.ts$',
  '^test/inbox\\.test\\.ts$',
  '^test/gitleaks-config\\.test\\.ts$',
];
const SUBAGENT_ID = '^[a-z0-9]{8}-[0-9]+-[a-z0-9]{4}$';
// A real log line that gitleaks' generic-api-key rule flags: "API" is its keyword, the id its secret.
const SUBAGENT_LINE = 'The parent updated the README sleeping-API line. Verifier: `mwa0wet9-5-k10r`.';
const PAT = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

/** The '''…''' entries of every `<key> = [ … ]` array in the config. */
const entries = (toml: string, key: string): string[] =>
  [...toml.matchAll(new RegExp(`^${key} = \\[([\\s\\S]*?)^\\]`, 'gm'))].flatMap((m) =>
    [...m[1].matchAll(/'''(.*?)'''/g)].map((e) => e[1]),
  );

/** Commits `files` with `config` in a fresh repository, runs `gitleaks git` and returns its exit code and flagged files. */
function scan(config: string, files: Record<string, string>): { status: number | null; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'mirador-gitleaks-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir });
    git('init', '-q');
    writeFileSync(join(dir, '.gitleaks.toml'), config);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '.');
    git('commit', '-q', '-m', 'probe');
    // The report is written after the commit, so the scan of the history never sees it.
    const report = join(dir, 'report.json');
    const run = spawnSync('gitleaks', ['git', '.', '--no-banner', '--config', '.gitleaks.toml', '--report-format', 'json', '--report-path', report], { cwd: dir });
    const found = (JSON.parse(readFileSync(report, 'utf8')) as { File: string }[]).map((f) => f.File).sort();
    return { status: run.status, files: found };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('T7: the path allowlist names only the three test fixtures, and no allowlist names odd/', () => {
  const toml = readFileSync(CONFIG, 'utf8');
  assert.deepEqual(entries(toml, 'paths'), FIXTURE_PATHS);
  assert.doesNotMatch(toml, /odd\//, 'neither a path nor a description points into odd/');
  assert.doesNotMatch(toml, /ODD/, 'no allowlist is described as being for ODD task logs');
});

test('T7: the one regex allowlist matches only the subagent id shape, on the secret', () => {
  const toml = readFileSync(CONFIG, 'utf8');
  assert.deepEqual(entries(toml, 'regexes'), [SUBAGENT_ID]);
  assert.match(toml, /^regexTarget = "secret"$/m);
  const id = new RegExp(SUBAGENT_ID);
  assert.equal(id.test('mwa0wet9-5-k10r'), true);
  assert.equal(id.test(PAT), false);
  assert.equal(id.test('glpat-ABCDEFGHIJ0123456789'), false);
});

test('the gitleaks allowlist hides example tokens only in the fixture paths; odd/tasks/ is scanned like any other path', { skip: !installed && 'gitleaks not installed' }, () => {
  const result = scan(readFileSync(CONFIG, 'utf8'), {
    'src/leak.ts': `export const token = "${PAT}";\n`,
    'test/inbox.test.ts': `const fixture = "${PAT}";\n`,
    'odd/tasks/x.md': `verifier ${PAT}\n`,
  });
  assert.equal(result.status, 1, 'a planted token outside the allowlist must fail the scan');
  assert.deepEqual(result.files, ['odd/tasks/x.md', 'src/leak.ts']);
});

test('T7: a subagent id in a log passes the scan only because of the narrow rule; a token on the same line still fails', { skip: !installed && 'gitleaks not installed' }, () => {
  const config = readFileSync(CONFIG, 'utf8');
  const log = { 'odd/tasks/log.md': `${SUBAGENT_LINE}\n` };
  assert.deepEqual(scan(config, log), { status: 0, files: [] });
  const withoutRule = config.slice(0, config.lastIndexOf('[[allowlists]]'));
  assert.doesNotMatch(withoutRule, /regexes/, 'the subagent rule is the last allowlist');
  assert.deepEqual(scan(withoutRule, log), { status: 1, files: ['odd/tasks/log.md'] }, 'without the rule gitleaks flags the id');
  assert.deepEqual(scan(config, { 'odd/tasks/log.md': `${SUBAGENT_LINE} ${PAT}\n` }), { status: 1, files: ['odd/tasks/log.md'] });
});
