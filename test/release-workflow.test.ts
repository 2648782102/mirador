// The release workflow (.github/workflows/release.yml) builds the prebuilt Linux archives of a tag and attaches
// them to a draft GitHub release; a person publishes it. These checks read the file as text: the trigger, the
// environment the publishing job waits behind, least-privilege permissions, a draft and never a published
// release, the provenance attestation, the glibc 2.28 build container, and the actions test.yml also uses
// pinned to the same commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const WORKFLOW = read('.github/workflows/release.yml');
const TEST_WORKFLOW = read('.github/workflows/test.yml');

/** The file without its comment lines, so that a comment never satisfies a check. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The top-level section `name:` (its lines up to the next top-level key). */
function section(text: string, name: string): string {
  const match = new RegExp(`^${name}:.*\\n((?:(?:[ \\t].*)?\\n)*)`, 'm').exec(code(text));
  assert.ok(match, `no top-level ${name}:`);
  return match[0];
}

/** Each job's id and text, from the jobs: section. */
function jobs(text: string): Map<string, string> {
  const body = section(text, 'jobs');
  const found = new Map<string, string>();
  for (const match of body.matchAll(/^ {2}([\w-]+):\n((?: {3,}.*\n|\s*\n)*)/gm)) found.set(match[1], match[2]);
  return found;
}

/** The `uses:` references of a workflow, as `owner/repo@ref # comment`. */
const uses = (text: string) => [...code(text).matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((m) => ({ ref: m[1], comment: m[2].trim() }));

/** Every line of a `run:` step, single-line or block. */
function runLines(text: string): string[] {
  const out: string[] = [];
  const lines = code(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (!/^[|>]/.test(match[2])) {
      out.push(match[2]);
      continue;
    }
    const indent = match[1].length;
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s*/.exec(lines[i + 1])![0].length > indent)) out.push(lines[++i]);
  }
  return out;
}

const JOBS = jobs(WORKFLOW);
const releaseJobs = [...JOBS].filter(([, body]) => /^ {4}environment: release$/m.test(body));

test('it runs on a pushed v* tag, or by hand for a tag given as input', () => {
  const on = section(WORKFLOW, 'on');
  assert.match(on, /^ {2}push:\n {4}tags:\n {6}- 'v\*'\n/m);
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}.*\n)*? {8}required: true\n/m);
  assert.doesNotMatch(on, /pull_request|branches:/);
});

test('one job publishes, behind the release environment, and only it can write', () => {
  assert.match(code(WORKFLOW), /^permissions: \{\}$/m, 'the workflow grants nothing by default');
  assert.equal(releaseJobs.length, 1, `jobs behind environment: release: ${releaseJobs.map(([id]) => id).join(', ')}`);
  const [id, body] = releaseJobs[0];
  assert.match(body, /^ {4}permissions:\n {6}contents: write\n {6}id-token: write\n {6}attestations: write\n(?! {6})/m);
  assert.match(body, /gh release create/);
  for (const [other, text] of JOBS) {
    if (other === id) continue;
    assert.match(text, /^ {4}permissions:\n {6}contents: read\n(?! {6})/m, `${other} must read only`);
    assert.doesNotMatch(text, /gh release|environment:/, other);
  }
});

test('the publishing job waits for every build and creates a draft release, and nothing ever publishes one', () => {
  const [, body] = releaseJobs[0];
  const builds = [...JOBS.keys()].filter((id) => id !== releaseJobs[0][0]);
  assert.ok(builds.length > 0);
  assert.match(body, new RegExp(`^ {4}needs: (?:${builds.join('|')}|\\[${builds.join(', ')}\\])$`, 'm'));
  const creates = runLines(WORKFLOW).filter((line) => /gh release create/.test(line));
  assert.equal(creates.length, 1, creates.join('\n'));
  assert.match(creates[0], /--draft\b/);
  assert.match(creates[0], /--verify-tag\b/);
  assert.doesNotMatch(code(WORKFLOW), /gh release (?:edit|delete|upload)|--draft=false|draft: false|make_latest|gh api/);
});

test('every archive gets a build-provenance attestation, and SHA256SUMS lists them all', () => {
  const [, body] = releaseJobs[0];
  assert.match(body, /- uses: actions\/attest-build-provenance@\S+.*\n {8}with:\n {10}subject-path: '?dist\/mirador-\*\.tar\.gz'?\n/);
  assert.ok(runLines(body).some((line) => /sha256sum mirador-\*\.tar\.gz > SHA256SUMS/.test(line)), 'no SHA256SUMS step');
  const create = runLines(body).find((line) => /gh release create/.test(line))!;
  assert.match(create, /dist\/mirador-\*\.tar\.gz dist\/SHA256SUMS/);
});

test('the builds make linux-x64 and linux-arm64 on GitHub-hosted runners inside a glibc 2.28 container, from the official Node checked against SHASUMS256.txt', () => {
  const builds = [...JOBS].filter(([id]) => id !== releaseJobs[0][0]);
  assert.equal(builds.length, 1);
  const [, body] = builds[0];
  assert.match(body, /- arch: x64\n {12}runner: ubuntu-24\.04\n/);
  assert.match(body, /- arch: arm64\n {12}runner: ubuntu-24\.04-arm\n/);
  assert.match(body, /^ {4}runs-on: \$\{\{ matrix\.runner \}\}$/m);
  assert.match(section(WORKFLOW, 'env'), /^ {2}BUILD_IMAGE: almalinux:8(?:@sha256:[0-9a-f]{64})?$/m);
  assert.match(section(WORKFLOW, 'env'), /^ {2}NODE_VERSION: 24\.\d+\.\d+$/m);
  const steps = runLines(body).join('\n');
  assert.match(steps, /sh scripts\/release\/check-tag\.sh "\$TAG" package\.json/);
  assert.match(steps, /sh scripts\/release\/fetch-node\.sh "\$NODE_VERSION" "\$ARCH" /);
  assert.match(steps, /sh scripts\/release\/build-linux\.sh /);
});

test('no run step expands an expression, so a tag name never becomes shell code', () => {
  for (const line of runLines(WORKFLOW)) assert.doesNotMatch(line, /\$\{\{/, line);
});

test('every job has a timeout and every checkout keeps no credentials', () => {
  for (const [id, body] of JOBS) {
    assert.match(body, /^ {4}timeout-minutes: \d+$/m, id);
    for (const match of body.matchAll(/- uses: actions\/checkout@.*\n((?: {8}.*\n)*)/g)) assert.match(match[1], /persist-credentials: false/, id);
  }
});

test('the actions test.yml also uses are pinned to the same commit SHA and version', () => {
  const pinned = new Map(uses(TEST_WORKFLOW).map(({ ref, comment }) => [ref.split('@')[0], `${ref} ${comment}`]));
  const shared = uses(WORKFLOW).filter(({ ref }) => pinned.has(ref.split('@')[0]));
  assert.ok(shared.length >= 3, shared.map(({ ref }) => ref).join(', '));
  for (const { ref, comment } of shared) assert.equal(`${ref} ${comment}`, pinned.get(ref.split('@')[0]));
});

// That every action of every workflow is pinned to a full commit SHA with its release tag in a comment is
// checked for all workflows at once in test/community-docs.test.ts.
