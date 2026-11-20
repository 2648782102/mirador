// `curl -fsSL .../scripts/bootstrap.sh | sh` clones Mirador into
// ${XDG_DATA_HOME:-~/.local/share}/mirador (or fast-forwards a clean clone) and runs its install.sh from the
// caller's folder, so the paths install.sh prints are full ones.
// Every run gets a scratch HOME and a local bare repository as origin (MIRADOR_REPO_URL) whose
// install.sh is a stub that records where it ran and with which arguments; nothing touches the
// network, the real home or the real install.sh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstallerSandbox } from './helpers/installer-sandbox.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/bootstrap.sh', import.meta.url));

let scratch: string;
let boxes = 0;

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

function git(cwd: string, args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { PATH: process.env.PATH, HOME: home, ...GIT_ENV } }, (error, stdout, stderr) => (error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(stdout)));
  });
}

interface Box {
  dir: string;
  home: string;
  origin: string;
  work: string;
  installLog: string;
  stubs: string;
  env: NodeJS.ProcessEnv;
}

/** A bare origin holding a stub install.sh, a scratch HOME and a PATH of the system plus `stubs`. */
async function box(): Promise<Box> {
  const dir = join(scratch, `box-${++boxes}`);
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  const stubs = join(dir, 'stubs');
  const installLog = join(dir, 'install.log');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  await mkdir(stubs, { recursive: true });
  await writeFile(join(work, 'install.sh'), `#!/bin/sh\nprintf '%s|%s\\n' "$(pwd -P)" "$*" >> '${installLog}'\necho 'install.sh: stub ran'\n`);
  await chmod(join(work, 'install.sh'), 0o755);
  await writeFile(join(work, 'VERSION'), 'one\n');
  await git(work, ['init', '-q', '-b', 'main'], home);
  await git(work, ['add', '.'], home);
  await git(work, ['commit', '-qm', 'one'], home);
  await git(dir, ['clone', '-q', '--bare', work, origin], home);
  await git(work, ['remote', 'add', 'origin', origin], home);
  const env: NodeJS.ProcessEnv = { PATH: `${stubs}:${process.env.PATH}`, HOME: home, MIRADOR_REPO_URL: origin, ...GIT_ENV };
  return { dir, home, origin, work, installLog, stubs, env };
}

/**
 * Runs the script as a file, or, with `piped`, as `curl ... | sh -s -- <args>` does: `piped` on sh's stdin.
 * `shell` is /bin/sh unless given (dash on Debian and Ubuntu, bash elsewhere).
 */
function run(b: Box, args: string[] = [], piped?: string, shell = '/bin/sh'): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assertInstallerSandbox(b.env);
  return new Promise((resolve, reject) => {
    const argv = piped === undefined ? [SCRIPT, ...args] : ['-s', '--', ...args];
    const child = spawn(shell, argv, { cwd: b.dir, env: b.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // A run that refuses at once (as root, or with a folder in the way) can exit before its stdin is written;
    // that EPIPE is the script finishing early, not a failure, and its exit code and output still decide the test.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(piped ?? '');
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
const installCalls = async (b: Box) => (await readFile(b.installLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-bootstrap-')));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("it clones Mirador into ~/.local/share/mirador and runs the clone's install.sh from the caller's folder with the arguments given", async () => {
  const b = await box();
  const clone = join(b.home, '.local', 'share', 'mirador');
  const result = await run(b, ['--root', '/some/where']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `bootstrap.sh: cloning ${b.origin} into ${clone}\ninstall.sh: stub ran\n`);
  assert.equal(await readFile(join(clone, 'VERSION'), 'utf8'), 'one\n');
  assert.deepEqual(await installCalls(b), [`${b.dir}|--root /some/where`]);
});

test('it clones under XDG_DATA_HOME when set, and a clean clone is fast-forwarded on the next run', async () => {
  const b = await box();
  b.env.XDG_DATA_HOME = join(b.dir, 'data');
  const clone = join(b.dir, 'data', 'mirador');
  assert.equal((await run(b)).code, 0);
  await writeFile(join(b.work, 'VERSION'), 'two\n');
  await git(b.work, ['commit', '-qam', 'two'], b.home);
  await git(b.work, ['push', '-q', 'origin', 'main'], b.home);

  const result = await run(b);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`bootstrap.sh: updating ${clone} (git pull --ff-only)\n`), result.stdout);
  assert.ok(result.stdout.endsWith('install.sh: stub ran\n'), result.stdout);
  assert.equal(await readFile(join(clone, 'VERSION'), 'utf8'), 'two\n');
  assert.deepEqual(await installCalls(b), [`${b.dir}|`, `${b.dir}|`]);
  assert.equal(await exists(join(b.home, '.local')), false, 'wrote under ~/.local despite XDG_DATA_HOME');
});

test('a clone with local changes is not updated, says so, and still runs its install.sh', async () => {
  const b = await box();
  const clone = join(b.home, '.local', 'share', 'mirador');
  assert.equal((await run(b)).code, 0);
  await writeFile(join(clone, 'VERSION'), 'mine\n');
  await writeFile(join(b.work, 'VERSION'), 'two\n');
  await git(b.work, ['commit', '-qam', 'two'], b.home);
  await git(b.work, ['push', '-q', 'origin', 'main'], b.home);

  const result = await run(b);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, `bootstrap.sh: ${clone} has local changes, so it was not updated; commit or discard them to update\n`);
  assert.equal(await readFile(join(clone, 'VERSION'), 'utf8'), 'mine\n');
  assert.equal((await installCalls(b)).length, 2);
});

test('a folder there that is not a git clone is left alone, and nothing runs', async () => {
  const b = await box();
  const clone = join(b.home, '.local', 'share', 'mirador');
  await mkdir(clone, { recursive: true });
  await writeFile(join(clone, 'notes.txt'), 'mine\n');
  const result = await run(b);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `bootstrap.sh: ${clone} exists and is not a git clone of Mirador; move it away, then run this again\n`);
  assert.deepEqual(await readdir(clone), ['notes.txt']);
  assert.deepEqual(await installCalls(b), []);
});

test('as root it refuses before cloning or installing anything', async () => {
  const b = await box();
  await writeFile(join(b.stubs, 'id'), '#!/bin/sh\n[ "$1" = -u ] && echo 0\n');
  await chmod(join(b.stubs, 'id'), 0o755);
  const result = await run(b);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'bootstrap.sh: do not run this as root (or with sudo); run it as your own user, Mirador installs into your home folder\n');
  assert.deepEqual(await readdir(b.home), []);
  assert.deepEqual(await installCalls(b), []);
});

test('without git it says how to install it and changes nothing', async () => {
  const b = await box();
  // A PATH with only what sh needs besides git, plus a package manager stub that must never run.
  const bin = join(b.dir, 'no-git');
  await mkdir(bin);
  // /usr/bin on Linux; on macOS mkdir lives in /bin.
  for (const tool of ['id', 'mkdir', 'dirname', 'uname']) await symlink(existsSync(`/usr/bin/${tool}`) ? `/usr/bin/${tool}` : `/bin/${tool}`, join(bin, tool));
  await writeFile(join(bin, 'apt-get'), `#!/bin/sh\necho ran >> '${join(b.dir, 'forbidden.log')}'\nexit 1\n`);
  await chmod(join(bin, 'apt-get'), 0o755);
  b.env.PATH = bin;
  const result = await run(b);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  // The hint follows the real uname: apt-get on PATH on Linux, the Command Line Tools on macOS.
  const hint = process.platform === 'darwin' ? 'xcode-select --install' : 'sudo apt install git';
  assert.equal(result.stderr, `bootstrap.sh: missing git (it downloads Mirador); install it with: ${hint}\n`);
  assert.deepEqual(await readdir(b.home), []);
  assert.equal(await exists(join(b.dir, 'forbidden.log')), false, 'a package manager ran');
});

test('read from a pipe, as curl -fsSL ... | sh -s -- <args> runs it, it clones and runs install.sh as from a file', async () => {
  const b = await box();
  const clone = join(b.home, '.local', 'share', 'mirador');
  const result = await run(b, ['--root', '/some/where'], await readFile(SCRIPT, 'utf8'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `bootstrap.sh: cloning ${b.origin} into ${clone}\ninstall.sh: stub ran\n`);
  assert.equal(result.stderr, '');
  assert.deepEqual(await installCalls(b), [`${b.dir}|--root /some/where`]);
});

// curl -f sends nothing to sh when the download fails, but a connection that drops sends part of the script.
const CUT_SHORT = 'bootstrap.sh: this copy of the script is incomplete (the download was cut short), so nothing ran; download it again\n';

/** Pipes each cut copy to `shell` and checks it ran nothing, said so and exited 1. Nothing runs, so one box serves every cut. */
async function assertCutsSaySo(cuts: [string, string][], shell?: string): Promise<void> {
  const b = await box();
  for (const [where, piped] of cuts) {
    const result = await run(b, ['--root', '/some/where'], piped, shell);
    assert.equal(result.code, 1, `${where}: ${result.stderr}`);
    assert.equal(result.stdout, '', where);
    assert.ok(result.stderr.endsWith(CUT_SHORT), `${where}: ${result.stderr}`);
    assert.deepEqual(await readdir(b.home), [], `${where}: the home folder changed`);
    assert.deepEqual(await installCalls(b), [], where);
  }
}

/** The script's lines, each with its start offset. */
async function scriptLines(): Promise<{ script: string; lines: { start: number; text: string }[] }> {
  const script = await readFile(SCRIPT, 'utf8');
  let start = 0;
  const lines = script.split('\n').map((text) => {
    const line = { start, text };
    start += text.length + 1;
    return line;
  });
  return { script, lines };
}

test('a download cut short runs nothing, says so and exits 1, wherever it stops', async () => {
  const script = await readFile(SCRIPT, 'utf8');
  const lastLine = script.trimEnd().lastIndexOf('\n') + 1;
  await assertCutsSaySo([
    ['halfway', script.slice(0, Math.floor(script.length / 2))],
    ['before its last line', script.slice(0, lastLine)],
  ]);
});

// The last line calls the body in a form no part of it can run: the copy ends before main is called or
// in a syntax error. Every byte of it, with sh and with bash and dash when they are there (curl ... | bash).
// Without only its newline the line is whole, and the script runs as it should.
const SHELLS = ['/bin/sh', ...['bash', 'dash'].filter((name) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, name))))];

for (const shell of SHELLS) {
  test(`a cut at any byte of its last line runs nothing, says so and exits 1 (${shell})`, async () => {
    const { script, lines } = await scriptLines();
    const last = lines.findLast((line) => line.text !== '')!;
    assert.equal(script.slice(last.start), `${last.text}\n`, 'the last line ends the file');
    const cuts: [string, string][] = [];
    for (let length = 0; length < last.text.length; length++) cuts.push([`after ${JSON.stringify(last.text.slice(0, length))}`, script.slice(0, last.start + length)]);
    await assertCutsSaySo(cuts, shell);
  });
}

// The trap that says so is set on the line after the shebang, before the header comments, so a cut
// anywhere after it says so too. A cut inside it cannot: it still runs nothing and exits non-zero.
test('a cut in the header comments, after the trap on the second line, runs nothing, says so and exits 1', async () => {
  const { script, lines } = await scriptLines();
  const body = lines.findIndex((line) => line.text.startsWith('main() {'));
  assert.ok(body > 2, 'main() { not found after the header');
  const cuts: [string, string][] = [];
  for (const [index, line] of lines.slice(2, body).entries()) {
    cuts.push([`at the start of line ${index + 3}`, script.slice(0, line.start)]);
    cuts.push([`in the middle of line ${index + 3}`, script.slice(0, line.start + Math.floor(line.text.length / 2))]);
  }
  await assertCutsSaySo(cuts);
});

test('a cut inside the trap line runs nothing and exits non-zero', async () => {
  const { script, lines } = await scriptLines();
  const trap = lines[1];
  assert.match(trap.text, /\btrap '/, 'the trap is not on the second line');
  const b = await box();
  for (let length = 1; length <= trap.text.length; length++) {
    const where = `after ${JSON.stringify(trap.text.slice(0, length))}`;
    const result = await run(b, ['--root', '/some/where'], script.slice(0, trap.start + length));
    assert.notEqual(result.code, 0, `${where}: ${result.stderr}`);
    assert.equal(result.stdout, '', where);
    assert.deepEqual(await readdir(b.home), [], `${where}: the home folder changed`);
    assert.deepEqual(await installCalls(b), [], where);
  }
});

test('when the clone fails it says Mirador could not be downloaded, exits 1 and runs nothing', async () => {
  const b = await box();
  const clone = join(b.home, '.local', 'share', 'mirador');
  const missing = join(b.dir, 'missing.git');
  b.env.MIRADOR_REPO_URL = missing;
  const result = await run(b);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, `bootstrap.sh: cloning ${missing} into ${clone}\n`);
  assert.ok(result.stderr.endsWith(`bootstrap.sh: could not download Mirador from ${missing} (git clone failed, see above); nothing was installed\n`), result.stderr);
  assert.equal(await exists(clone), false, 'a partial clone was left');
  assert.deepEqual(await installCalls(b), []);
});
