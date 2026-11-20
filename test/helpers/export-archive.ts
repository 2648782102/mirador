// The public export is `git archive HEAD`; .gitattributes marks what it leaves out.
// These helpers extract it the same way, for the tests that check what the export holds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: the folder above test/. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Why `git archive HEAD` cannot run here, or false when it can: ROOT must be the top of a git checkout.
 * An extracted export has no .git, so there the export tests skip with this message.
 */
export function notACheckout(): string | false {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
  if (top.error || top.status !== 0) return 'not a git checkout (an extracted export has no .git), so git archive HEAD cannot run';
  if (resolve(top.stdout.trim()) !== resolve(ROOT)) return `not the top of a git checkout: git sees ${top.stdout.trim()}`;
  return false;
}

/**
 * Why the export tests cannot run here, or false when they can: ROOT must be a checkout of the repository
 * the export is made from, whose HEAD tracks a .gitattributes with export-ignore rules. The public
 * repository and an extracted export carry no such file, so there these tests skip.
 */
export function notTheSource(): string | false {
  const checkout = notACheckout();
  if (checkout) return checkout;
  const rules = spawnSync('git', ['show', 'HEAD:.gitattributes'], { cwd: ROOT, encoding: 'utf8' });
  if (rules.status !== 0 || !/\sexport-ignore\b/.test(rules.stdout)) {
    return 'HEAD tracks no .gitattributes with export-ignore rules, so this is not the repository the export is made from';
  }
  return false;
}

/** The paths of HEAD's tree under `path` (git ls-tree), to tell an excluded path from a deleted one. */
export function trackedUnder(path: string): string[] {
  const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', path], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\n').filter(Boolean);
}

/**
 * `git archive HEAD` extracted into a fresh folder under the system temp dir. The caller removes it;
 * when git archive or tar fails, the folder is removed here before the error propagates.
 */
export function extractHead(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mirador-export-')));
  let extracted = false;
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: ROOT, maxBuffer: 1 << 30 });
    assert.equal(archive.status, 0, `git archive HEAD failed: ${archive.stderr}`);
    const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 1 << 30 });
    assert.equal(tar.status, 0, `tar -x failed: ${tar.stderr}`);
    extracted = true;
    return dir;
  } finally {
    if (!extracted) rmSync(dir, { recursive: true, force: true });
  }
}
