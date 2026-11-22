// The release workflow's shell helpers under scripts/release/, run with stubs and local files only:
//   check-tag.sh  a release tag must be v<package.json's version>;
//   fetch-node.sh the official Node tarball is unpacked only when it matches its line in SHASUMS256.txt
//                 (curl is a stub serving local files, so nothing reaches nodejs.org);
//   check-glibc.sh a built addon must name glibc 2.28 at most, and name some glibc (objdump is a stub).
// Every PATH starts with a folder holding only `node`, a link to the running Node binary, so no script ever
// reaches a node shim (mise's would install a Node over the network in a scratch HOME).
// pins.sh, which prints the lines a promotion PR pins, is tested with the bootstrap script it feeds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../scripts/release/', import.meta.url));
const DIST = 'https://nodejs.org/dist';

let scratch: string;
let dirs = 0;
/** The system PATH behind a folder whose only entry is `node`, linked to the running Node binary. */
let PATH: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-release-scripts-')));
  await mkdir(join(scratch, 'node-bin'));
  await symlink(process.execPath, join(scratch, 'node-bin', 'node'));
  PATH = `${join(scratch, 'node-bin')}:/usr/bin:/bin`;
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fresh(): Promise<string> {
  const dir = join(scratch, `dir-${++dirs}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function sh(script: string, args: string[], env: NodeJS.ProcessEnv = { PATH }, cwd = scratch): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [join(SCRIPTS, script), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const exists = (path: string) => access(path).then(() => true, () => false);

test('check-tag.sh prints the version of a tag that matches package.json', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mirador', version: '0.2.0' }));
  assert.deepEqual(await sh('check-tag.sh', ['v0.2.0', join(dir, 'package.json')]), { code: 0, stdout: '0.2.0\n', stderr: '' });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mirador', version: '0.2.0-rc.1' }));
  assert.deepEqual(await sh('check-tag.sh', ['v0.2.0-rc.1', join(dir, 'package.json')]), { code: 0, stdout: '0.2.0-rc.1\n', stderr: '' });
});

test('check-tag.sh refuses a tag that is not v<major>.<minor>.<patch>, or that differs from package.json', async () => {
  const dir = await fresh();
  const pkg = join(dir, 'package.json');
  await writeFile(pkg, JSON.stringify({ name: 'mirador', version: '0.1.0' }));
  for (const tag of ['v1.2', '0.1.0', 'v0.1.0;id', 'v0.1.0 ', '']) {
    assert.deepEqual(await sh('check-tag.sh', [tag, pkg]), { code: 1, stdout: '', stderr: `check-tag.sh: "${tag}" is not a release tag (v<major>.<minor>.<patch>, such as v0.2.0)\n` }, tag);
  }
  assert.deepEqual(await sh('check-tag.sh', ['v0.2.0', pkg]), {
    code: 1,
    stdout: '',
    stderr: "check-tag.sh: tag v0.2.0 does not match package.json's version 0.1.0; bump the version in package.json (and CHANGELOG.md) first\n",
  });
});

interface NodeDist {
  dir: string;
  out: string;
  curlLog: string;
  env: NodeJS.ProcessEnv;
  name: string;
  sha: string;
}

/** A fake nodejs.org: a curl stub serving <dir>/served as https://nodejs.org/dist, with a Node 24.0.0 tarball for x64. */
async function nodeDist(shasums: (name: string, sha: string) => string): Promise<NodeDist> {
  const dir = await fresh();
  const stubs = join(dir, 'stubs');
  const served = join(dir, 'served', 'v24.0.0');
  const curlLog = join(dir, 'curl.log');
  const name = 'node-v24.0.0-linux-x64';
  await mkdir(join(dir, 'tree', name, 'bin'), { recursive: true });
  await writeFile(join(dir, 'tree', name, 'bin', 'node'), '#!/bin/sh\necho fake node\n');
  await writeFile(join(dir, 'tree', name, 'LICENSE'), 'Node.js license\n');
  await mkdir(served, { recursive: true });
  await new Promise<void>((resolve, reject) => execFile('tar', ['-cJf', join(served, `${name}.tar.xz`), '-C', join(dir, 'tree'), name], (error) => (error ? reject(error) : resolve())));
  const sha = createHash('sha256').update(await readFile(join(served, `${name}.tar.xz`))).digest('hex');
  await writeFile(join(served, 'SHASUMS256.txt'), shasums(`${name}.tar.xz`, sha));
  await mkdir(stubs);
  await writeFile(
    join(stubs, 'curl'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${curlLog}'`,
      'out= url=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o | --proto) [ "$1" = -o ] && out="$2"; shift 2 ;;',
      '    -*) shift ;;',
      '    *) url="$1"; shift ;;',
      '  esac',
      'done',
      `file='${join(dir, 'served')}'/"\${url#${DIST}/}"`,
      `if [ "$file" = '${join(dir, 'served')}'/"$url" ] || [ ! -f "$file" ]; then echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; fi`,
      'cp "$file" "$out"',
      '',
    ].join('\n'),
  );
  await chmod(join(stubs, 'curl'), 0o755);
  return { dir, out: join(dir, 'out'), curlLog, env: { PATH: `${stubs}:${PATH}` }, name, sha };
}

test('fetch-node.sh downloads the Node tarball and SHASUMS256.txt from nodejs.org over https, and unpacks the tarball when it matches its line', async () => {
  const d = await nodeDist((name, sha) => `${'1'.repeat(64)}  node-v24.0.0-linux-arm64.tar.xz\n${sha}  ${name}\n${'2'.repeat(64)}  ${name}.extra\n`);
  const result = await sh('fetch-node.sh', ['24.0.0', 'x64', d.out], d.env);
  assert.deepEqual(result, { code: 0, stdout: `fetch-node.sh: ${d.name}.tar.xz matches its sha256 in SHASUMS256.txt; unpacked it into ${d.out}/${d.name}\n`, stderr: '' });
  assert.deepEqual((await readFile(d.curlLog, 'utf8')).split('\n').filter(Boolean), [
    `-fsSL --proto =https --tlsv1.2 -o ${d.out}/SHASUMS256.txt ${DIST}/v24.0.0/SHASUMS256.txt`,
    `-fsSL --proto =https --tlsv1.2 -o ${d.out}/${d.name}.tar.xz ${DIST}/v24.0.0/${d.name}.tar.xz`,
  ]);
  assert.equal(await readFile(join(d.out, d.name, 'bin', 'node'), 'utf8'), '#!/bin/sh\necho fake node\n');
});

test('fetch-node.sh unpacks nothing when the tarball does not match SHASUMS256.txt, or has no line there', async () => {
  const wrong = await nodeDist((name) => `${'0'.repeat(64)}  ${name}\n`);
  const mismatch = await sh('fetch-node.sh', ['24.0.0', 'x64', wrong.out], wrong.env);
  assert.deepEqual(mismatch, {
    code: 1,
    stdout: '',
    stderr: `fetch-node.sh: ${wrong.name}.tar.xz does not match its sha256 in SHASUMS256.txt (expected ${'0'.repeat(64)}, got ${wrong.sha}); nothing was unpacked\n`,
  });
  assert.deepEqual(await readdir(wrong.out), ['SHASUMS256.txt']);

  const missing = await nodeDist(() => `${'1'.repeat(64)}  node-v24.0.0-linux-arm64.tar.xz\n`);
  const none = await sh('fetch-node.sh', ['24.0.0', 'x64', missing.out], missing.env);
  assert.deepEqual(none, { code: 1, stdout: '', stderr: `fetch-node.sh: SHASUMS256.txt from ${DIST}/v24.0.0 has no line for ${missing.name}.tar.xz; nothing was unpacked\n` });
  assert.equal(await exists(join(missing.out, missing.name)), false);
});

test('fetch-node.sh refuses a version or architecture it does not build', async () => {
  const usage = 'usage: fetch-node.sh <node-version, such as 24.22.3> <x64|arm64> <out-dir>\n';
  for (const args of [['24.0.0', 'armv7l', '/nowhere'], ['24', 'x64', '/nowhere'], ['24.0.0;id', 'x64', '/nowhere'], ['24.0.0', 'x64']]) {
    assert.deepEqual(await sh('fetch-node.sh', args), { code: 2, stdout: '', stderr: usage }, args.join(' '));
  }
});

/** Runs check-glibc.sh on a file with an objdump stub that prints `dump` (and exits `status`). */
async function checkGlibc(dump: string, status = 0): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await fresh();
  await mkdir(join(dir, 'stubs'));
  await writeFile(join(dir, 'dump.txt'), dump);
  await writeFile(join(dir, 'stubs', 'objdump'), `#!/bin/sh\n[ "$1" = -T ] || exit 9\ncat '${join(dir, 'dump.txt')}'\nexit ${status}\n`);
  await chmod(join(dir, 'stubs', 'objdump'), 0o755);
  await writeFile(join(dir, 'pty.node'), '');
  return sh('check-glibc.sh', [join(dir, 'pty.node')], { PATH: `${join(dir, 'stubs')}:${PATH}` });
}

const symbol = (version: string, name: string) => `0000000000000000      DF *UND*  0000000000000000 (GLIBC_${version}) ${name}\n`;

test('check-glibc.sh passes an addon whose newest glibc symbol version is 2.28 or older, and names it', async () => {
  const dump = symbol('2.2.5', 'malloc') + symbol('2.17', 'clock_gettime') + symbol('2.28', 'fcntl64') + '0000 g DF .text 0000 Base napi_register_module_v1\n';
  assert.deepEqual(await checkGlibc(dump), { code: 0, stdout: 'check-glibc.sh: pty.node needs glibc 2.28 at most\n', stderr: '' });
  assert.deepEqual(await checkGlibc(symbol('2.17', 'malloc')), { code: 0, stdout: 'check-glibc.sh: pty.node needs glibc 2.17 at most\n', stderr: '' });
});

test('check-glibc.sh stops on an addon that needs a glibc newer than 2.28', async () => {
  for (const version of ['2.29', '2.34', '3.0']) {
    assert.deepEqual(await checkGlibc(symbol('2.17', 'malloc') + symbol(version, 'newer')), { code: 1, stdout: '', stderr: `check-glibc.sh: pty.node needs glibc ${version}, newer than 2.28\n` }, version);
  }
});

test('check-glibc.sh stops with a clear message when the addon names no glibc symbol version, or objdump fails', async () => {
  assert.deepEqual(await checkGlibc('0000 g DF .text 0000 Base napi_register_module_v1\n'), {
    code: 1,
    stdout: '',
    stderr: 'check-glibc.sh: objdump -T lists no GLIBC_ symbol version in pty.node, so its glibc baseline cannot be checked; is it a Linux addon linked against glibc?\n',
  });
  const failed = await checkGlibc('', 1);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, 'check-glibc.sh: objdump -T could not read pty.node (see above), so its glibc baseline cannot be checked\n');
});
