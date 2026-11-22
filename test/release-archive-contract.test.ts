// The two halves of the prebuilt install meet here: scripts/release/build-linux.sh writes the archive that
// scripts/bootstrap.sh downloads, checks and unpacks. Neither half is described by hand: build-linux.sh runs
// for real on the committed sources (pnpm and docker are stubs that do nothing, so no dependency is installed
// and node-pty is not built), with a tiny fake Node folder, and the file it writes is served, under the name
// it chose, to a copy of bootstrap.sh pinned to its sha256, through the same local curl stub as
// test/bootstrap-prebuilt.test.ts. A rename on either side, of the archive or of the folder inside it, fails
// here. Everything runs in a scratch folder: a scratch HOME and TMPDIR, stubs on PATH, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstallerSandbox, writeNetworkBarrier } from './helpers/installer-sandbox.ts';
import { withPins } from './helpers/bootstrap-pins.ts';

const BOOTSTRAP = fileURLToPath(new URL('../scripts/bootstrap.sh', import.meta.url));
const BUILD = fileURLToPath(new URL('../scripts/release/build-linux.sh', import.meta.url));
const RELEASES = 'https://github.com/mata-2p/mirador/releases/download';
const VERSION = '0.9.0';

let scratch: string;

function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => (error ? reject(new Error(`${file} ${args.join(' ')}: ${stderr}`)) : resolve({ stdout, stderr })));
  });
}

async function stub(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, name), 0o755);
}

/** Runs build-linux.sh for `arch` on a fake Node folder whose bin/node records its runs in `nodeLog`; returns the folder it wrote to. */
async function build(dir: string, arch: string, nodeLog: string): Promise<{ out: string; stdout: string }> {
  const node = join(dir, 'node-dist');
  await stub(join(node, 'bin'), 'node', `printf '%s\\n' "node $*" >> '${nodeLog}'`);
  await writeFile(join(node, 'LICENSE'), 'the fake Node license\n');
  const stubs = join(dir, 'build-stubs');
  await stub(stubs, 'pnpm', 'exit 0');
  await stub(stubs, 'docker', 'exit 0');
  const tmp = join(dir, 'tmp');
  const home = join(dir, 'build-home');
  await mkdir(tmp, { recursive: true });
  await mkdir(home, { recursive: true });
  const out = join(dir, 'out');
  const env = { PATH: `${stubs}:${process.env.PATH}`, HOME: home, TMPDIR: tmp, BUILD_IMAGE: 'almalinux:8', GIT_CONFIG_NOSYSTEM: '1' };
  const { stdout } = await exec('/bin/sh', [BUILD, VERSION, arch, node, out], dir, env);
  return { out, stdout };
}

/** Runs `script` as test/bootstrap-prebuilt.test.ts does: Linux `machine` with glibc 2.31, curl serving `served`. */
async function bootstrap(dir: string, machine: string, served: string, script: string) {
  const home = join(dir, 'home');
  const stubs = join(dir, 'stubs');
  const curlLog = join(dir, 'curl.log');
  await mkdir(home, { recursive: true });
  await stub(stubs, 'uname', `case "$1" in -m) echo '${machine}' ;; -r) echo '6.12.0' ;; *) echo Linux ;; esac`);
  await stub(stubs, 'getconf', `[ "$1" = GNU_LIBC_VERSION ] && echo 'glibc 2.31'`);
  await stub(
    stubs,
    'curl',
    [
      `printf '%s\\n' "$*" >> '${curlLog}'`,
      'out= url=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o | --proto) [ "$1" = -o ] && out="$2"; shift 2 ;;',
      '    -*) shift ;;',
      '    *) url="$1"; shift ;;',
      '  esac',
      'done',
      `file='${served}'/"\${url#${RELEASES}/}"`,
      `if [ "$file" = '${served}'/"$url" ] || [ ! -f "$file" ]; then echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; fi`,
      'cp "$file" "$out"',
    ].join('\n'),
  );
  const barrier = await writeNetworkBarrier(join(dir, 'barrier'));
  const env: NodeJS.ProcessEnv = { PATH: `${stubs}:${barrier}:${process.env.PATH}`, HOME: home, MIRADOR_REPO_URL: join(dir, 'no-such-origin.git') };
  assertInstallerSandbox(env);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('/bin/sh', [script], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('bootstrap.sh did not finish'));
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  return { ...result, home, curlLog };
}

const lines = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-release-contract-')));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

for (const [arch, machine] of [['x64', 'x86_64'], ['arm64', 'aarch64']]) {
  test(`the archive build-linux.sh writes for ${arch} is the one bootstrap.sh downloads on ${machine}, and installs from it`, async () => {
    const dir = join(scratch, arch);
    await mkdir(dir, { recursive: true });
    const nodeLog = join(dir, 'node.log');
    const { out, stdout } = await build(dir, arch, nodeLog);

    // The name and layout both halves agree on: mirador-<version>-linux-<arch>.tar.gz holding <name>/bin/mirador
    // and <name>/node/bin/node (and the src/doctor.ts that bootstrap.sh runs).
    const name = `mirador-${VERSION}-linux-${arch}`;
    assert.deepEqual(await readdir(out), [`${name}.tar.gz`]);
    assert.equal(stdout.split('\n').filter(Boolean).at(-1), `build-linux.sh: wrote ${out}/${name}.tar.gz`);
    const archive = join(out, `${name}.tar.gz`);
    const listed = (await exec('tar', ['-tzf', archive], dir, { PATH: process.env.PATH })).stdout.split('\n').filter(Boolean);
    for (const entry of [`${name}/bin/mirador`, `${name}/node/bin/node`, `${name}/src/doctor.ts`]) assert.ok(listed.includes(entry), `${entry} is not in the archive`);
    assert.deepEqual([...new Set(listed.map((entry) => entry.split('/')[0]))], [name], 'the archive holds more than its one folder');

    // Served under the name build-linux.sh chose, as the release workflow uploads it.
    const served = join(dir, 'served');
    await mkdir(join(served, `v${VERSION}`), { recursive: true });
    const [written] = await readdir(out);
    await writeFile(join(served, `v${VERSION}`, written), await readFile(archive));
    const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
    const script = join(dir, 'bootstrap.sh');
    await writeFile(script, withPins(await readFile(BOOTSTRAP, 'utf8'), { MIRADOR_VERSION: VERSION, [arch === 'x64' ? 'MIRADOR_SHA256_LINUX_X64' : 'MIRADOR_SHA256_LINUX_ARM64']: sha }));

    const result = await bootstrap(dir, machine, served, script);
    const data = join(result.home, '.local', 'share', 'mirador');
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      [
        `bootstrap.sh: downloading ${RELEASES}/v${VERSION}/${name}.tar.gz`,
        'bootstrap.sh: the download matches the sha256 pinned in this script',
        `bootstrap.sh: unpacked Mirador ${VERSION} into ${data}/${VERSION}`,
        `bootstrap.sh: ${data}/current now points at ${VERSION}`,
        'bootstrap.sh: checking the machine (doctor)',
        'bootstrap.sh: adding the launcher (bin/mirador install)',
        'mirador: installed ~/.local/bin/mirador and the Mirador app menu entry',
        `bootstrap.sh: done; start Mirador with: ${data}/current/bin/mirador`,
        '',
      ].join('\n'),
    );
    assert.equal((await lines(result.curlLog)).length, 1);
    assert.deepEqual((await readdir(data)).sort(), [VERSION, 'current']);
    assert.equal(await readlink(join(data, 'current')), VERSION);
    // The archive's own launcher and Node ran: the doctor with the bundled node, the launcher linked from the version.
    assert.deepEqual(await lines(nodeLog), [`node ${data}/current/src/doctor.ts`]);
    assert.equal(await readlink(join(result.home, '.local', 'bin', 'mirador')), join(data, VERSION, 'bin', 'mirador'));
  });
}
