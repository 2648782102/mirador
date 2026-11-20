// Public release T8: the community files a new contributor expects (code of conduct, issue and pull request
// templates), GitHub Actions pinned by commit SHA and kept up to date by dependabot (L25), and a README
// section on the Gentle names a reader meets in the code: gentle-ai, Engram, gentle-deck and bin/herdr-shim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const TEMPLATES = '.github/ISSUE_TEMPLATE';
const WORKFLOWS = '.github/workflows';
// Joined from pieces, as in scripts/export-scan.ts.
const CONTACT = ['contacto', 'zurai.cl'].join('@');

/** The lines of a Markdown file under the `## <title>` heading, up to the next heading of level 1 or 2. */
function section(text: string, title: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

test('CODE_OF_CONDUCT.md exists, gives the contact address for reports, and CONTRIBUTING.md links it', () => {
  assert.ok(existsSync(join(ROOT, 'CODE_OF_CONDUCT.md')), 'CODE_OF_CONDUCT.md is missing');
  assert.ok(read('CODE_OF_CONDUCT.md').includes(CONTACT), 'the code of conduct names the address that takes reports');
  assert.match(read('CONTRIBUTING.md'), /\]\(CODE_OF_CONDUCT\.md\)/);
});

test('issue templates for a bug and a feature request, and a pull request template, exist under .github/', () => {
  const issues = existsSync(join(ROOT, TEMPLATES)) ? readdirSync(join(ROOT, TEMPLATES)) : [];
  assert.ok(issues.some((name) => /^bug/.test(name) && /\.(md|ya?ml)$/.test(name)), `no bug template in ${TEMPLATES}: ${issues.join(', ')}`);
  assert.ok(issues.some((name) => /^feature/.test(name) && /\.(md|ya?ml)$/.test(name)), `no feature template in ${TEMPLATES}: ${issues.join(', ')}`);
  assert.ok(existsSync(join(ROOT, '.github/pull_request_template.md')), '.github/pull_request_template.md is missing');
});

test('the bug template asks for the doctor report', () => {
  assert.ok(existsSync(join(ROOT, TEMPLATES)), `${TEMPLATES} is missing`);
  const bug = readdirSync(join(ROOT, TEMPLATES)).find((name) => /^bug/.test(name));
  assert.ok(bug, 'no bug template');
  assert.ok(read(`${TEMPLATES}/${bug}`).includes('pnpm run doctor --report'));
});

test('.github/dependabot.yml updates the github-actions ecosystem from the repository root', () => {
  const path = '.github/dependabot.yml';
  assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
  const config = read(path);
  assert.match(config, /^version: 2$/m);
  assert.match(config, /^\s*- package-ecosystem: "?github-actions"?$/m);
  assert.match(config, /^\s*directory: "?\/"?$/m);
  assert.match(config, /^\s*interval: "?(daily|weekly|monthly)"?$/m);
});

test('every uses: in .github/workflows/*.yml is pinned to a 40-hex commit SHA with a trailing # vX.Y.Z comment', () => {
  const files = readdirSync(join(ROOT, WORKFLOWS)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'no workflow files');
  const uses: string[] = [];
  const unpinned: string[] = [];
  for (const file of files) {
    read(`${WORKFLOWS}/${file}`).split('\n').forEach((line, index) => {
      if (!/^\s*(?:-\s+)?uses:/.test(line)) return;
      uses.push(line);
      if (!/^\s*(?:-\s+)?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/.test(line)) unpinned.push(`${WORKFLOWS}/${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.ok(uses.length > 0, 'no uses: lines found');
  assert.deepEqual(unpinned, []);
});

test('the README has a section that explains gentle-ai, Engram, gentle-deck and bin/herdr-shim, and lists it in the top links', () => {
  const readme = read('README.md');
  const body = section(readme, 'Gentle names in the code');
  assert.ok(body, 'no "## Gentle names in the code" section');
  for (const name of ['gentle-ai', 'Engram', 'gentle-deck', 'bin/herdr-shim']) assert.ok(body.includes(name), `the section does not name ${name}`);
  assert.ok(readme.includes('[Gentle names](#gentle-names-in-the-code)'), 'the top links do not list the section');
});
