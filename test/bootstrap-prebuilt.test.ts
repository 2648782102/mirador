// With a release pinned in it (a version and the sha256 of each platform's archive), scripts/bootstrap.sh
// installs that release's prebuilt archive on Linux x64 and arm64 instead of cloning: it downloads it from
// GitHub Releases, checks it against the pinned sha256 before unpacking it, unpacks it into
// ${XDG_DATA_HOME:-~/.local/share}/mirador/<version>, points `current` there, runs the bundled doctor and adds the
// launcher. A git clone in that folder is never touched. Without a pin for the platform it installs from source.
// Every run gets a scratch HOME, a copy of the script with the pins under test, and stubs on PATH: uname and
// getconf answer for the platform under test, and curl serves a local fake archive, so nothing touches the
// network or the real home. The fake archive's node and bin/mirador only record how they were run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstallerSandbox, writeNetworkBarrier } from './helpers/installer-sandbox.ts';
import { PIN_NAMES, readPins, withPins, type Pins } from './helpers/bootstrap-pins.ts';

const SOURCE = fileURLToPath(new URL('../scripts/bootstrap.sh', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('../bin/mirador', import.meta.url));
const RELEASES = 'https://github.com/mata-2p/mirador/releases/download';
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

let scratch: string;
let source: string;
let boxes = 0;

function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env }, (error, stdout, stderr) => (error ? reject(new Error(`${file} ${args.join(' ')}: ${stderr}`)) : resolve(stdout)));
  });
}

async function stub(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, name), 0o755);
}

interface Box {
  dir: string;
  home: string;
  stubs: string;
  /** The folder the curl stub serves, laid out as GitHub's release downloads: v<version>/<archive>. */
  served: string;
  /** Each curl call's arguments, one line per call. */
  curlLog: string;
  /** Each run of a fake archive's node or bin/mirador: `<version> node|mirador <args>`. */
  runLog: string;
  env: NodeJS.ProcessEnv;
}

/** A scratch HOME, and stubs for a Linux machine of `machine` (uname -m) with glibc 2.31 and the curl stub. */
async function box(machine = 'x86_64'): Promise<Box> {
  const dir = join(scratch, `box-${++boxes}`);
  const home = join(dir, 'home');
  const stubs = join(dir, 'stubs');
  const served = join(dir, 'served');
  const curlLog = join(dir, 'curl.log');
  const runLog = join(dir, 'run.log');
  await mkdir(home, { recursive: true });
  await mkdir(served, { recursive: true });
  await uname(stubs, 'Linux', machine);
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
  // The network barrier's fake mise, curl and wget sit after the stubs (the curl stub wins) and before the system's.
  const barrier = await writeNetworkBarrier(join(dir, 'barrier'));
  const env: NodeJS.ProcessEnv = { PATH: `${stubs}:${barrier}:${process.env.PATH}`, HOME: home, MIRADOR_REPO_URL: join(dir, 'no-such-origin.git'), ...GIT_ENV };
  return { dir, home, stubs, served, curlLog, runLog, env };
}

/** A `uname` stub: `-s` the system, `-m` the machine, `-r` a kernel release. */
const uname = (stubs: string, system: string, machine: string) =>
  stub(stubs, 'uname', `case "$1" in -m) echo '${machine}' ;; -r) echo '6.12.0' ;; *) echo '${system}' ;; esac`);

/**
 * Builds mirador-<version>-linux-<arch>.tar.gz in the box's served folder, as the release workflow lays it out
 * (one folder holding bin/mirador, node/bin/node and the sources), and returns its sha256. Its node and
 * bin/mirador record their runs; node exits 1 when the box holds a file named doctor-fails, bin/mirador when it
 * holds launcher-fails; asked for its `status`, bin/mirador says no server runs. `withoutNode` leaves
 * node/bin/node out. `realLauncher` puts the repo's bin/mirador in, with a node/bin/node that runs this Node.
 */
async function release(b: Box, version: string, arch: string, { withoutNode = false, realLauncher = false } = {}): Promise<string> {
  const name = `mirador-${version}-linux-${arch}`;
  const tree = join(b.dir, 'trees', version, arch);
  const root = join(tree, name);
  if (realLauncher) {
    await stub(join(root, 'node', 'bin'), 'node', `exec '${process.execPath}' "$@"`);
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin', 'mirador'), await readFile(LAUNCHER));
    await chmod(join(root, 'bin', 'mirador'), 0o755);
  } else {
    if (!withoutNode) await stub(join(root, 'node', 'bin'), 'node', `printf '%s\\n' "${version} node $*" >> '${b.runLog}'\n[ ! -e '${join(b.dir, 'doctor-fails')}' ]`);
    await stub(
      join(root, 'bin'),
      'mirador',
      `printf '%s\\n' "${version} mirador $*" >> '${b.runLog}'\nif [ "$1" = status ]; then echo 'mirador: not running'; exit 1; fi\nif [ -e '${join(b.dir, 'launcher-fails')}' ]; then echo 'mirador: stub failed' >&2; exit 3; fi\necho 'mirador: stub ran'`,
    );
  }
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'doctor.ts'), '// the fake doctor\n');
  const archive = join(b.served, `v${version}`, `${name}.tar.gz`);
  await mkdir(join(b.served, `v${version}`), { recursive: true });
  await exec('tar', ['-czf', archive, '-C', tree, name], b.dir);
  return createHash('sha256').update(await readFile(archive)).digest('hex');
}

/** Writes a copy of the script with `pins` into the box and returns its path. */
async function pinned(b: Box, pins: Pins): Promise<string> {
  const script = join(b.dir, `bootstrap-${(pins.MIRADOR_VERSION ?? 'none').replace(/[^\w.]/g, '_')}.sh`);
  await writeFile(script, withPins(source, pins));
  return script;
}

function run(b: Box, script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assertInstallerSandbox(b.env);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [script, ...args], { cwd: b.dir, env: b.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
}

const exists = (path: string) => access(path).then(() => true, () => false);
const lines = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dataDir = (b: Box) => join(b.home, '.local', 'share', 'mirador');

/**
 * The lines a run prints when it installs `version` for `arch` into `dir`, downloading it unless `cached`:
 * `removed` first (the leftovers it removes), `notice` right after current points at the version, and
 * `launcher`, what bin/mirador install prints.
 */
function installed(
  dir: string,
  version: string,
  arch: string,
  cached = false,
  { removed = [] as string[], notice = [] as string[], launcher = 'mirador: stub ran' } = {},
): string {
  const url = `${RELEASES}/v${version}/mirador-${version}-linux-${arch}.tar.gz`;
  return [
    ...removed,
    ...(cached
      ? [`bootstrap.sh: Mirador ${version} is already in ${dir}/${version}, so nothing was downloaded`]
      : [`bootstrap.sh: downloading ${url}`, 'bootstrap.sh: the download matches the sha256 pinned in this script', `bootstrap.sh: unpacked Mirador ${version} into ${dir}/${version}`]),
    `bootstrap.sh: ${dir}/current now points at ${version}`,
    ...notice,
    'bootstrap.sh: checking the machine (doctor)',
    'bootstrap.sh: adding the launcher (bin/mirador install)',
    launcher,
    `bootstrap.sh: done; start Mirador with: ${dir}/current/bin/mirador`,
    '',
  ].join('\n');
}

/** The curl call that downloads `version`'s archive for `arch` into a temporary folder inside `dir`. */
const curlCall = (dir: string, version: string, arch: string) => {
  const name = `mirador-${version}-linux-${arch}.tar.gz`;
  return new RegExp(`^-fsSL --proto =https --tlsv1\\.2 -o ${escape(dir)}/\\.download\\.[^/ ]+/${escape(name)} ${escape(`${RELEASES}/v${version}/${name}`)}$`);
};

/** Every file, folder and link under `dir` with its mode and its content or target, to compare before and after. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    const info = await lstat(path);
    const key = path.slice(dir.length) || '/';
    if (info.isSymbolicLink()) out[key] = `link ${await readlink(path)}`;
    else if (info.isDirectory()) {
      out[key] = `dir ${info.mode.toString(8)}`;
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
    } else out[key] = `file ${info.mode.toString(8)} ${createHash('sha256').update(await readFile(path)).digest('hex')}`;
  }
  await walk(dir);
  return out;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bootstrap-prebuilt-')));
  source = await readFile(SOURCE, 'utf8');
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test('the pins in bootstrap.sh are all empty, or a version with a 64-digit lowercase hex sha256 for each platform that has one', () => {
  const pins = readPins(source);
  if (!pins.MIRADOR_VERSION) {
    assert.deepEqual(pins, { MIRADOR_VERSION: '', MIRADOR_SHA256_LINUX_X64: '', MIRADOR_SHA256_LINUX_ARM64: '' });
    return;
  }
  assert.match(pins.MIRADOR_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
  const shas = PIN_NAMES.slice(1).map((name) => pins[name]);
  assert.ok(shas.some(Boolean), 'a version is pinned without any sha256');
  for (const sha of shas) if (sha) assert.match(sha, /^[0-9a-f]{64}$/);
});

test('on Linux x64 it downloads the pinned release from GitHub Releases, checks it, unpacks it into ~/.local/share/mirador/<version>, points current at it, runs its doctor and adds the launcher', async () => {
  const b = await box('x86_64');
  const sha = await release(b, '0.9.0', 'x64');
  const script = await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha, MIRADOR_SHA256_LINUX_ARM64: 'f'.repeat(64) });
  const dir = dataDir(b);
  const result = await run(b, script);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  assert.equal(result.stdout, installed(dir, '0.9.0', 'x64'));
  const calls = await lines(b.curlLog);
  assert.equal(calls.length, 1, calls.join('\n'));
  assert.match(calls[0], curlCall(dir, '0.9.0', 'x64'));
  // The temporary download folder is gone; only the version and the current link are left.
  assert.deepEqual((await readdir(dir)).sort(), ['0.9.0', 'current']);
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
  assert.ok(existsSync(join(dir, '0.9.0', 'bin', 'mirador')));
  assert.deepEqual(await lines(b.runLog), [`0.9.0 node ${dir}/current/src/doctor.ts`, '0.9.0 mirador install']);
});

test('on Linux arm64 (aarch64) it installs the arm64 archive, under XDG_DATA_HOME when set', async () => {
  const b = await box('aarch64');
  const sha = await release(b, '0.9.0', 'arm64');
  const script = await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'f'.repeat(64), MIRADOR_SHA256_LINUX_ARM64: sha });
  b.env.XDG_DATA_HOME = join(b.dir, 'data');
  const dir = join(b.dir, 'data', 'mirador');
  const result = await run(b, script);
  assert.deepEqual([result.code, result.stderr], [0, '']);
  assert.equal(result.stdout, installed(dir, '0.9.0', 'arm64'));
  assert.match((await lines(b.curlLog))[0], curlCall(dir, '0.9.0', 'arm64'));
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
  assert.equal(await exists(join(b.home, '.local')), false, 'wrote under ~/.local despite XDG_DATA_HOME');
});

test('run again, it reuses the version it has without downloading; a newer pinned version is added and the previous one kept', async () => {
  const b = await box();
  const one = await release(b, '0.9.0', 'x64');
  const two = await release(b, '0.9.1', 'x64');
  const dir = dataDir(b);
  const first = await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: one });
  assert.equal((await run(b, first)).code, 0);

  const again = await run(b, first);
  assert.deepEqual([again.code, again.stderr], [0, '']);
  assert.equal(again.stdout, installed(dir, '0.9.0', 'x64', true));
  assert.equal((await lines(b.curlLog)).length, 1, 'the second run downloaded again');

  const update = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.1', MIRADOR_SHA256_LINUX_X64: two }));
  assert.deepEqual([update.code, update.stderr], [0, '']);
  assert.equal(update.stdout, installed(dir, '0.9.1', 'x64'));
  assert.deepEqual((await readdir(dir)).sort(), ['0.9.0', '0.9.1', 'current']);
  assert.equal(await readlink(join(dir, 'current')), '0.9.1');
  assert.deepEqual((await lines(b.runLog)).slice(-2), [`0.9.1 node ${dir}/current/src/doctor.ts`, '0.9.1 mirador install']);
});

test('an archive that does not match the pinned sha256 is not unpacked, and nothing is installed', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  const wrong = '0'.repeat(64);
  const script = await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: wrong });
  const dir = dataDir(b);
  const result = await run(b, script);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, `bootstrap.sh: downloading ${RELEASES}/v0.9.0/mirador-0.9.0-linux-x64.tar.gz\n`);
  assert.equal(
    result.stderr,
    `bootstrap.sh: mirador-0.9.0-linux-x64.tar.gz does not match the sha256 pinned in this script (expected ${wrong}, got ${sha}), so it was not unpacked and nothing was installed; download this script again, and report it if it happens again\n`,
  );
  assert.equal(await exists(dir), false, `${dir} was left behind`);
  assert.deepEqual(await lines(b.runLog), []);
});

test('when the download fails it says so and installs nothing', async () => {
  const b = await box();
  const script = await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) });
  const url = `${RELEASES}/v0.9.0/mirador-0.9.0-linux-x64.tar.gz`;
  const result = await run(b, script);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, `bootstrap.sh: downloading ${url}\n`);
  assert.equal(result.stderr, `curl: (22) The requested URL returned error: 404\nbootstrap.sh: could not download ${url} (curl failed, see above); nothing was installed\n`);
  assert.equal(await exists(dataDir(b)), false);
  // On a fresh machine ~/.local/share did not exist either: the folders this run made are gone too.
  assert.deepEqual(await readdir(b.home), []);
});

test('a failed install removes only the folders it made, and only while they are empty', async () => {
  const url = `${RELEASES}/v0.9.0/mirador-0.9.0-linux-x64.tar.gz`;
  const failed = (stderr: string) => assert.ok(stderr.endsWith(`bootstrap.sh: could not download ${url} (curl failed, see above); nothing was installed\n`), stderr);

  // ~/.local held something already: ~/.local/share, made by this run, goes; ~/.local and its file stay.
  const b = await box();
  await mkdir(join(b.home, '.local'));
  await writeFile(join(b.home, '.local', 'keep.txt'), 'mine\n');
  const one = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }));
  assert.equal(one.code, 1);
  failed(one.stderr);
  assert.deepEqual(await readdir(b.home), ['.local']);
  assert.deepEqual(await readdir(join(b.home, '.local')), ['keep.txt']);

  // An empty XDG_DATA_HOME that was there before the run stays, empty as it was.
  const c = await box();
  c.env.XDG_DATA_HOME = join(c.dir, 'data');
  await mkdir(join(c.dir, 'data'));
  const two = await run(c, await pinned(c, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }));
  assert.equal(two.code, 1);
  failed(two.stderr);
  assert.deepEqual(await readdir(join(c.dir, 'data')), []);

  // An XDG_DATA_HOME several folders deep that did not exist is removed back to the first folder that did.
  const d = await box();
  d.env.XDG_DATA_HOME = join(d.dir, 'deep', 'er', 'data');
  const three = await run(d, await pinned(d, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }));
  assert.equal(three.code, 1);
  failed(three.stderr);
  assert.equal(await exists(join(d.dir, 'deep')), false);
});

test('the environment cannot change the pinned version or sha256', async () => {
  const b = await box();
  const one = await release(b, '0.9.0', 'x64');
  const two = await release(b, '0.9.1', 'x64');
  const dir = dataDir(b);
  b.env.MIRADOR_VERSION = '0.9.1';
  b.env.MIRADOR_SHA256_LINUX_X64 = two;
  b.env.MIRADOR_SHA256_LINUX_ARM64 = two;

  // A pinned sha256 that does not match is not rescued by a matching one in the environment.
  const wrong = '0'.repeat(64);
  const refused = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: wrong }));
  assert.equal(refused.code, 1);
  assert.ok(refused.stderr.includes(`(expected ${wrong}, got ${one})`), refused.stderr);
  assert.equal(await exists(dir), false);

  // The pinned release is the one installed, whatever the environment names.
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: one }));
  assert.deepEqual([result.code, result.stderr], [0, '']);
  assert.equal(result.stdout, installed(dir, '0.9.0', 'x64'));
  for (const call of await lines(b.curlLog)) assert.match(call, curlCall(dir, '0.9.0', 'x64'));
  assert.deepEqual((await readdir(dir)).sort(), ['0.9.0', 'current']);
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
});

test('a download that matches its pinned sha256 but is no usable archive installs nothing and leaves no download folder', async () => {
  // Not a tarball at all.
  const b = await box();
  const name = 'mirador-0.9.0-linux-x64.tar.gz';
  await mkdir(join(b.served, 'v0.9.0'), { recursive: true });
  await writeFile(join(b.served, 'v0.9.0', name), 'this is not a tarball\n');
  const junk = createHash('sha256').update('this is not a tarball\n').digest('hex');
  const notTar = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: junk }));
  assert.equal(notTar.code, 1);
  assert.ok(notTar.stdout.endsWith('bootstrap.sh: the download matches the sha256 pinned in this script\n'), notTar.stdout);
  assert.ok(notTar.stderr.endsWith(`bootstrap.sh: ${name} could not be unpacked (tar failed, see above); nothing was installed\n`), notTar.stderr);
  assert.deepEqual(await readdir(b.home), []);
  assert.deepEqual(await lines(b.runLog), []);

  // A tarball without node/bin/node.
  const c = await box();
  const sha = await release(c, '0.9.0', 'x64', { withoutNode: true });
  const noNode = await run(c, await pinned(c, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }));
  assert.equal(noNode.code, 1);
  assert.equal(noNode.stderr, `bootstrap.sh: ${name} holds no mirador-0.9.0-linux-x64/bin/mirador and mirador-0.9.0-linux-x64/node/bin/node; nothing was installed\n`);
  assert.deepEqual(await readdir(c.home), []);
  assert.deepEqual(await lines(c.runLog), []);
});

test('a failed download of a newer pinned version leaves the installed one, current and the whole folder byte-identical', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  const dir = dataDir(b);
  assert.equal((await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }))).code, 0);
  const before = await snapshot(dir);
  const url = `${RELEASES}/v0.9.1/mirador-0.9.1-linux-x64.tar.gz`;
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.1', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }));
  assert.equal(result.code, 1);
  assert.equal(result.stdout, `bootstrap.sh: downloading ${url}\n`);
  assert.ok(result.stderr.endsWith(`bootstrap.sh: could not download ${url} (curl failed, see above); nothing was installed\n`), result.stderr);
  assert.deepEqual(await snapshot(dir), before);
  assert.deepEqual((await readdir(dir)).filter((entry) => entry.startsWith('.download.')), []);
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
});

test('when bin/mirador install fails it says so and exits non-zero, keeping the unpacked release', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  await writeFile(join(b.dir, 'launcher-fails'), '');
  const dir = dataDir(b);
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }));
  assert.equal(result.code, 1);
  assert.ok(result.stdout.endsWith('bootstrap.sh: adding the launcher (bin/mirador install)\n'), result.stdout);
  assert.equal(
    result.stderr,
    `mirador: stub failed\nbootstrap.sh: ${dir}/current/bin/mirador install failed (see above), so the launcher was not added; Mirador 0.9.0 is in ${dir}/0.9.0, so fix the problem, then run this again\n`,
  );
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
  assert.deepEqual(await lines(b.runLog), [`0.9.0 node ${dir}/current/src/doctor.ts`, '0.9.0 mirador install']);
});

test('when the doctor finds a problem it says so, keeps the unpacked release and adds no launcher', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  await writeFile(join(b.dir, 'doctor-fails'), '');
  const dir = dataDir(b);
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }));
  assert.equal(result.code, 1);
  assert.ok(result.stdout.endsWith('bootstrap.sh: checking the machine (doctor)\n'), result.stdout);
  assert.equal(result.stderr, 'bootstrap.sh: the doctor found a problem (see above); fix it, then run this again\n');
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
  assert.deepEqual(await lines(b.runLog), [`0.9.0 node ${dir}/current/src/doctor.ts`]);
});

test('a git clone in its folder is left byte-identical: it stops before downloading and says how to keep or move it', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  const dir = dataDir(b);
  await mkdir(dir, { recursive: true });
  const git = (args: string[]) => exec('git', args, dir, { PATH: process.env.PATH, HOME: b.home, ...GIT_ENV });
  await git(['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'VERSION'), 'one\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'one']);
  await writeFile(join(dir, 'VERSION'), 'mine\n');
  await writeFile(join(dir, 'notes.txt'), 'untracked\n');
  await symlink('VERSION', join(dir, 'link'));
  const before = await snapshot(dir);

  for (const args of [[], ['--root', b.dir]]) {
    const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }), args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `bootstrap.sh: ${dir} is a git clone of Mirador (an install from source), so this installer leaves it as it is and stops. To keep it, update it with: git -C ${dir} pull --ff-only && ${dir}/install.sh. To switch to the prebuilt release, move the clone away (for example: mv ${dir} ${dir}.clone), then run this again\n`,
    );
  }
  assert.deepEqual(await snapshot(dir), before);
  assert.deepEqual(await lines(b.curlLog), []);
  assert.deepEqual(await lines(b.runLog), []);
});

test('a folder there that is neither a prebuilt install nor a git clone is left alone, before downloading', async () => {
  const b = await box();
  const dir = dataDir(b);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'notes.txt'), 'mine\n');
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }));
  assert.deepEqual([result.code, result.stdout], [1, '']);
  assert.equal(result.stderr, `bootstrap.sh: ${dir} exists and is neither a prebuilt install of Mirador nor a git clone of it; move it away, then run this again\n`);
  assert.deepEqual(await readdir(dir), ['notes.txt']);
  assert.deepEqual(await lines(b.curlLog), []);
});

// A first install cut off abruptly (power off, SIGKILL: no trap runs) leaves only its download folders
// (mktemp's .download.XXXXXX) in the data folder. The next run removes them and installs.
test('a folder holding only the downloads an interrupted first install left half done is cleaned, and the install goes on', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  const dir = dataDir(b);
  const name = 'mirador-0.9.0-linux-x64';
  // One cut during the download, one during the unpacking.
  await mkdir(join(dir, '.download.Ab3dE9'), { recursive: true });
  await writeFile(join(dir, '.download.Ab3dE9', `${name}.tar.gz`), 'half a download');
  await mkdir(join(dir, '.download.zZ09yx', 'unpacked', name, 'bin'), { recursive: true });
  await writeFile(join(dir, '.download.zZ09yx', 'unpacked', name, 'bin', 'mirador'), 'half a file');
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }));
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    installed(dir, '0.9.0', 'x64', false, {
      removed: [
        `bootstrap.sh: removed ${dir}/.download.Ab3dE9, a download an earlier run left half done`,
        `bootstrap.sh: removed ${dir}/.download.zZ09yx, a download an earlier run left half done`,
      ],
    }),
  );
  assert.deepEqual((await readdir(dir)).sort(), ['0.9.0', 'current']);
  assert.equal(await readlink(join(dir, 'current')), '0.9.0');
  assert.deepEqual(await lines(b.runLog), [`0.9.0 node ${dir}/current/src/doctor.ts`, '0.9.0 mirador install']);
});

test('a folder holding anything besides those downloads is left byte-identical, and the refusal stays', async () => {
  const elsewhere = join(scratch, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, 'keep.txt'), 'mine\n');
  const cases: [string, (dir: string) => Promise<void>][] = [
    ['a file of mine beside a download', async (dir) => {
      await mkdir(join(dir, '.download.Ab3dE9'));
      await writeFile(join(dir, '.download.Ab3dE9', 'mirador-0.9.0-linux-x64.tar.gz'), 'half a download');
      await writeFile(join(dir, 'notes.txt'), 'mine\n');
    }],
    ['a file named like a download', (dir) => writeFile(join(dir, '.download.Ab3dE9'), 'mine\n')],
    ['a link named like a download', (dir) => symlink(elsewhere, join(dir, '.download.Ab3dE9'))],
    ['a folder of another name that starts like one', async (dir) => {
      await mkdir(join(dir, '.download.mine'));
      await writeFile(join(dir, '.download.mine', 'keep.txt'), 'mine\n');
    }],
    ['an empty folder', async () => {}],
  ];
  for (const [what, fill] of cases) {
    const b = await box();
    const dir = dataDir(b);
    await mkdir(dir, { recursive: true });
    await fill(dir);
    const before = await snapshot(dir);
    const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }));
    assert.deepEqual([result.code, result.stdout], [1, ''], what);
    assert.equal(result.stderr, `bootstrap.sh: ${dir} exists and is neither a prebuilt install of Mirador nor a git clone of it; move it away, then run this again\n`, what);
    assert.deepEqual(await snapshot(dir), before, what);
    assert.deepEqual(await lines(b.curlLog), [], what);
  }
  assert.deepEqual(await readdir(elsewhere), ['keep.txt']);
});

/** A process whose command line names src/server.ts, as bin/mirador checks, and the launcher's state file naming its pid. */
async function fakeServer(b: Box): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'src/server.ts'], { stdio: 'ignore' });
  await serverState(b, child.pid!);
  return child;
}

/** Writes bin/mirador's state file (no XDG_RUNTIME_DIR in the box: ~/.cache/mirador/state.json) naming `pid`. */
async function serverState(b: Box, pid: number): Promise<string> {
  const file = join(b.home, '.cache', 'mirador', 'state.json');
  await mkdir(join(b.home, '.cache', 'mirador'), { recursive: true });
  await writeFile(file, JSON.stringify({ pid, port: 4545, launchSecret: 'x' }));
  return file;
}

const REAL_LAUNCHER_LINE = 'mirador: installed ~/.local/bin/mirador and the Mirador app menu entry';

test('an update while a Mirador server runs says it keeps running the previous version until mirador stop && mirador', async () => {
  const b = await box();
  const one = await release(b, '0.9.0', 'x64', { realLauncher: true });
  const two = await release(b, '0.9.1', 'x64', { realLauncher: true });
  const dir = dataDir(b);
  const first = await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: one });
  assert.equal((await run(b, first)).code, 0);
  const server = await fakeServer(b);
  try {
    const state = await readFile(join(b.home, '.cache', 'mirador', 'state.json'), 'utf8');
    // Run again on the same version, it is no update: no notice.
    const again = await run(b, first);
    assert.deepEqual([again.code, again.stderr], [0, '']);
    assert.equal(again.stdout, installed(dir, '0.9.0', 'x64', true, { launcher: REAL_LAUNCHER_LINE }));

    const update = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.1', MIRADOR_SHA256_LINUX_X64: two }));
    assert.equal(update.stderr, '');
    assert.equal(update.code, 0);
    assert.equal(
      update.stdout,
      installed(dir, '0.9.1', 'x64', false, {
        launcher: REAL_LAUNCHER_LINE,
        notice: ['bootstrap.sh: a Mirador server is running, and it keeps running Mirador 0.9.0 until you restart it with: mirador stop && mirador'],
      }),
    );
    assert.deepEqual((await readdir(dir)).sort(), ['0.9.0', '0.9.1', 'current']);
    assert.equal(await readlink(join(dir, 'current')), '0.9.1');
    // The server is left running, and its state file as it was.
    assert.equal(server.exitCode, null);
    assert.equal(await readFile(join(b.home, '.cache', 'mirador', 'state.json'), 'utf8'), state);
  } finally {
    server.kill('SIGKILL');
  }
});

test('an update with no Mirador server running prints no notice, a stale state file included', async () => {
  for (const stale of [false, true]) {
    const b = await box();
    const one = await release(b, '0.9.0', 'x64', { realLauncher: true });
    const two = await release(b, '0.9.1', 'x64', { realLauncher: true });
    const dir = dataDir(b);
    assert.equal((await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: one }))).code, 0);
    // A state file left behind, naming a live process that is no Mirador server (this test's own).
    if (stale) await serverState(b, process.pid);
    const update = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.1', MIRADOR_SHA256_LINUX_X64: two }));
    assert.deepEqual([update.code, update.stderr], [0, ''], String(stale));
    assert.equal(update.stdout, installed(dir, '0.9.1', 'x64', false, { launcher: REAL_LAUNCHER_LINE }), String(stale));
    assert.equal(await readlink(join(dir, 'current')), '0.9.1');
  }
});

test('the prebuilt install takes no installer options: given one, it stops before downloading', async () => {
  const b = await box();
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) }), ['--root', '/some/where']);
  assert.deepEqual([result.code, result.stdout], [1, '']);
  assert.equal(result.stderr, 'bootstrap.sh: the prebuilt install takes no installer options (given: --root /some/where); run it without them\n');
  assert.deepEqual(await readdir(b.home), []);
  assert.deepEqual(await lines(b.curlLog), []);
});

test('a pinned sha256 that is not 64 lowercase hex digits stops before downloading', async () => {
  const b = await box();
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'ABC' }));
  assert.deepEqual([result.code, result.stdout], [1, '']);
  assert.equal(result.stderr, 'bootstrap.sh: the sha256 pinned in this script for linux-x64 is not 64 lowercase hex digits, so this copy of the script is broken; nothing was installed\n');
  assert.deepEqual(await readdir(b.home), []);
  assert.deepEqual(await lines(b.curlLog), []);
});

test('without sha256sum it checks the download with shasum -a 256', async () => {
  const b = await box();
  const sha = await release(b, '0.9.0', 'x64');
  // A PATH of only the tools the prebuilt path uses, with shasum in place of sha256sum.
  const bin = join(b.dir, 'no-sha256sum');
  await mkdir(bin);
  for (const tool of ['cp', 'gzip', 'id', 'ln', 'mkdir', 'mktemp', 'mv', 'rm', 'rmdir', 'tar']) {
    const path = [`/usr/bin/${tool}`, `/bin/${tool}`].find((candidate) => existsSync(candidate));
    assert.ok(path, `no ${tool} on this machine`);
    await symlink(path, join(bin, tool));
  }
  const real = ['/usr/bin/sha256sum', '/bin/sha256sum'].find((candidate) => existsSync(candidate));
  assert.ok(real, 'no sha256sum on this machine to stand behind the shasum stub');
  const shasumLog = join(b.dir, 'shasum.log');
  await stub(bin, 'shasum', `printf '%s\\n' "$1 $2" >> '${shasumLog}'\n[ "$1 $2" = '-a 256' ] || exit 2\nshift 2\nexec '${real}' "$@"`);
  b.env.PATH = `${b.stubs}:${bin}`;
  const dir = dataDir(b);
  const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }));
  assert.deepEqual([result.code, result.stderr], [0, '']);
  assert.equal(result.stdout, installed(dir, '0.9.0', 'x64'));
  assert.deepEqual(await lines(shasumLog), ['-a 256']);
});

// The source install, as test/bootstrap.test.ts covers it, is what runs here too: the origin does not exist,
// so the clone fails at once, and nothing is downloaded with curl.
async function assertInstallsFromSource(b: Box, script: string, note = ''): Promise<void> {
  const dir = dataDir(b);
  const origin = b.env.MIRADOR_REPO_URL!;
  const result = await run(b, script);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, `bootstrap.sh: cloning ${origin} into ${dir}\n`);
  assert.ok(result.stderr.startsWith(note), result.stderr);
  assert.ok(result.stderr.endsWith(`bootstrap.sh: could not download Mirador from ${origin} (git clone failed, see above); nothing was installed\n`), result.stderr);
  assert.deepEqual(await lines(b.curlLog), []);
}

test('with no version pinned it installs from source, even with MIRADOR_VERSION set in the environment', async () => {
  const b = await box();
  await release(b, '0.9.0', 'x64');
  b.env.MIRADOR_VERSION = '0.9.0';
  b.env.MIRADOR_SHA256_LINUX_X64 = 'a'.repeat(64);
  await assertInstallsFromSource(b, await pinned(b, {}));
});

test('a platform with no pinned archive installs from source: macOS, another CPU, or Linux arm64 when only x64 is pinned', async () => {
  const pins = { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) };
  for (const [system, machine] of [['Darwin', 'arm64'], ['Linux', 'riscv64'], ['Linux', 'aarch64']]) {
    const b = await box();
    await uname(b.stubs, system, machine);
    await assertInstallsFromSource(b, await pinned(b, pins));
  }
});

test('Linux without glibc 2.28 or newer installs from source, and says why', async () => {
  const pins = { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: 'a'.repeat(64) };
  for (const [answer, found] of [["echo 'glibc 2.27'", 'glibc 2.27'], ['exit 1', 'none'], ["echo 'glibc 1.99'", 'glibc 1.99']]) {
    const b = await box();
    await stub(b.stubs, 'getconf', answer);
    await assertInstallsFromSource(b, await pinned(b, pins), `bootstrap.sh: the prebuilt release needs glibc 2.28 or newer (found: ${found}), so Mirador installs from source\n`);
  }
  // A newer glibc, a major above 2 included, takes the prebuilt path.
  for (const version of ['2.28', '2.40', '3.0']) {
    const b = await box();
    await stub(b.stubs, 'getconf', `echo 'glibc ${version}'`);
    const sha = await release(b, '0.9.0', 'x64');
    const result = await run(b, await pinned(b, { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: sha }));
    assert.deepEqual([result.code, result.stderr], [0, ''], version);
  }
});

// A promotion PR pins a release with the lines scripts/release/pins.sh prints from the release's SHA256SUMS.
test('the lines scripts/release/pins.sh prints from SHA256SUMS, put in place of the pins, make the script install that release', async () => {
  const b = await box('x86_64');
  const x64 = await release(b, '0.9.0', 'x64');
  const arm64 = 'b'.repeat(64);
  const sums = join(b.dir, 'SHA256SUMS');
  await writeFile(sums, `${arm64}  mirador-0.9.0-linux-arm64.tar.gz\n${x64}  mirador-0.9.0-linux-x64.tar.gz\n`);
  const pinsScript = fileURLToPath(new URL('../scripts/release/pins.sh', import.meta.url));
  const printed = await exec('/bin/sh', [pinsScript, '0.9.0', sums], b.dir);
  assert.equal(printed, `  MIRADOR_VERSION="0.9.0"\n  MIRADOR_SHA256_LINUX_X64="${x64}"\n  MIRADOR_SHA256_LINUX_ARM64="${arm64}"\n`);
  let promoted = withPins(source);
  for (const line of printed.split('\n').filter(Boolean)) promoted = promoted.replace(new RegExp(`^${escape(line.slice(0, line.indexOf('=') + 1))}.*$`, 'm'), line);
  assert.deepEqual(readPins(promoted), { MIRADOR_VERSION: '0.9.0', MIRADOR_SHA256_LINUX_X64: x64, MIRADOR_SHA256_LINUX_ARM64: arm64 });
  const script = join(b.dir, 'promoted.sh');
  await writeFile(script, promoted);
  const result = await run(b, script);
  assert.deepEqual([result.code, result.stderr], [0, '']);
  assert.equal(result.stdout, installed(dataDir(b), '0.9.0', 'x64'));

  // An archive missing from SHA256SUMS leaves its pin empty.
  await writeFile(sums, `${x64}  mirador-0.9.0-linux-x64.tar.gz\n`);
  assert.equal(await exec('/bin/sh', [pinsScript, '0.9.0', sums], b.dir), `  MIRADOR_VERSION="0.9.0"\n  MIRADOR_SHA256_LINUX_X64="${x64}"\n  MIRADOR_SHA256_LINUX_ARM64=""\n`);
});
