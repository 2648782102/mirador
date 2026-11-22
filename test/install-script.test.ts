// ./install.sh checks the machine, prints how to install what is
// missing without installing it, then runs pnpm install, creates the config only when there is
// none, runs pnpm run doctor and links the launcher. Every run gets a scratch HOME, XDG dirs, TMPDIR,
// os-release and a PATH made of stubs, the network barrier's fake curl and wget, then a mirror of the
// system bin folder without the tools the script checks or must never run (pnpm, node, compilers, sudo,
// package managers, mise), so no test installs anything, reaches the network or reads the real home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSERS } from '../src/doctor.ts';
import { assertInstallerSandbox, writeNetworkBarrier } from './helpers/installer-sandbox.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(APP_DIR, 'install.sh');
const EXAMPLE = join(APP_DIR, 'config.example.json');

const USAGE = `usage: ./install.sh [--root <dir>]

Checks what Mirador needs, installs its dependencies with pnpm, creates
~/.config/mirador/config.json when there is none yet, runs pnpm run doctor and,
on Linux, adds the mirador launcher. It never runs sudo and never installs
system packages or Node.

  --root <dir>  the workspace folder written in a new config
  -h, --help    show this help
`;

// Tools the script looks for or must never run: the PATH mirror leaves them out. The browsers and openers
// are the ones doctor's browser check looks for (src/doctor.ts), which the installer runs before installing.
const HIDDEN = new Set(['node', 'npm', 'npx', 'corepack', 'pnpm', 'python3', 'make', 'g++', 'c++', 'uname', 'sudo', 'doas', 'pacman', 'apt', 'apt-get', 'dnf', 'zypper', 'brew', 'xcode-select', 'mise', 'gentle-shell', 'pi', 'engram', 'snap', ...BROWSERS, 'xdg-open', 'wslview', 'powershell.exe']);
const NEXT = 'install.sh: nothing was changed; install what is missing, then run ./install.sh again\n';
/** The line that asks for the config's root, for a config created from the example. */
const ROOT_HINT = 'install.sh: set "root" on line 3 of it to the full path of an existing folder of yours (~ is not expanded there); it is "/home/you/code" now';
const BUILD_LINK = 'https://github.com/nodejs/node-gyp#on-unix';

let scratch: string;
let appDir: string;
let mirror: string;
/** Fake curl and wget that fail instead of reaching the network (writeNetworkBarrier); mise stays hidden. */
let barrier: string;
let boxes = 0;
/** A stand-in Engram on 127.0.0.1 that answers anything, and a port where nothing answers. */
let engram: Server;
let engramPort: number;
let closedPort: number;

interface Box {
  dir: string;
  stubs: string;
  home: string;
  env: NodeJS.ProcessEnv;
  pnpmLog: string;
  forbiddenLog: string;
}

interface Options {
  uname?: string;
  /** What `uname -r` prints; WSL kernels contain `microsoft`. */
  kernelRelease?: string;
  osRelease?: string;
  /** Stubs present on PATH, besides the ones every box has. `node` links the real Node. */
  tools?: string[];
  nodeVersion?: string;
  /** Package managers on PATH; they record any call, which must never happen. */
  managers?: string[];
  xdgConfig?: boolean;
  installExit?: number;
  doctorExit?: number;
  /** Whether ~/.local/bin is on PATH (it is unless false). */
  localBin?: boolean;
  /** Optional programs on PATH whose absence the installer notes: both unless given. */
  extras?: string[];
  /** Whether Engram answers at the config's engramUrl (ENGRAM_PORT here); it does unless false. */
  engram?: boolean;
  /** Whether a Chromium-family browser (a `chromium` stub) is on PATH; it is unless false. */
  browser?: boolean;
  /** Whether DISPLAY is set (to :0); it is unless false. Without it, nor WAYLAND_DISPLAY, Linux has no display. */
  display?: boolean;
}

async function stub(dir: string, name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, name), 0o755);
}

async function box(options: Options = {}): Promise<Box> {
  const dir = join(scratch, `box-${++boxes}`);
  const stubs = join(dir, 'stubs');
  const home = join(dir, 'home');
  const pnpmLog = join(dir, 'pnpm.log');
  const forbiddenLog = join(dir, 'forbidden.log');
  await mkdir(stubs, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(join(dir, 'tmp'), { recursive: true });
  const kernel = options.uname ?? 'Linux';
  await stub(stubs, 'uname', `case "$1" in -r) echo ${options.kernelRelease ?? '6.1.0-test'} ;; -m) echo x86_64 ;; *) echo ${kernel} ;; esac`);
  for (const name of ['sudo', ...(options.managers ?? ['pacman', 'apt', 'apt-get', 'dnf', 'zypper'])]) {
    await stub(stubs, name, `echo "${name} $*" >> '${forbiddenLog}'\nexit 1`);
  }
  for (const tool of options.tools ?? ['node', 'pnpm', 'python3', 'make', 'g++']) {
    if (tool === 'node') {
      if (options.nodeVersion) await stub(stubs, 'node', `echo ${options.nodeVersion}`);
      else await symlink(process.execPath, join(stubs, 'node'));
    } else if (tool === 'pnpm') {
      await stub(
        stubs,
        'pnpm',
        `printf '%s|%s\\n' "$(pwd -P)" "$*" >> '${pnpmLog}'\ncase "$1" in install) [ ${options.installExit ?? 0} = 0 ] || { echo 'pnpm: ERR_PNPM_OUTDATED_LOCKFILE' >&2; exit ${options.installExit}; }; echo 'pnpm: dependencies installed' ;; run) [ "$2" = doctor ] && { echo 'doctor: all good'; exit ${options.doctorExit ?? 0}; } ;; doctor) echo "pnpm: this is pnpm's own doctor, not Mirador's" ;; esac`,
      );
    } else if (tool === 'xcode-select') {
      await stub(stubs, tool, 'echo /Library/Developer/CommandLineTools');
    } else {
      await stub(stubs, tool, 'exit 0');
    }
  }
  for (const extra of options.extras ?? ['gentle-shell', 'pi']) await stub(stubs, extra, 'exit 99');
  if (options.browser !== false) await stub(stubs, 'chromium', `echo "chromium $*" >> '${forbiddenLog}'\nexit 1`);
  const osRelease = join(dir, 'os-release');
  if (options.osRelease !== undefined) await writeFile(osRelease, options.osRelease);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: options.localBin === false ? `${stubs}:${barrier}:${mirror}` : `${stubs}:${barrier}:${mirror}:${join(home, '.local', 'bin')}`,
    TMPDIR: join(dir, 'tmp'),
    XDG_RUNTIME_DIR: join(dir, 'run'),
    XDG_STATE_HOME: join(dir, 'state'),
    MIRADOR_OS_RELEASE: osRelease,
    ENGRAM_PORT: String(options.engram === false ? closedPort : engramPort),
  };
  if (options.display !== false) env.DISPLAY = ':0';
  if (options.xdgConfig) env.XDG_CONFIG_HOME = join(dir, 'cfg');
  return { dir, stubs, home, env, pnpmLog, forbiddenLog };
}

function run(b: Box, args: string[], cwd = appDir, script = SCRIPT): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assertInstallerSandbox(b.env);
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, { cwd, env: b.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`install.sh ${args.join(' ')} did not finish`));
    }, 15000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Nothing was installed, created or run besides the checks. */
async function assertUntouched(b: Box): Promise<void> {
  assert.equal(await exists(b.pnpmLog), false, 'pnpm ran');
  assert.equal(await exists(b.forbiddenLog), false, 'sudo or a package manager ran');
  assert.deepEqual(await readdir(b.home), [], 'the home folder changed');
  assert.equal(await exists(join(b.dir, 'cfg')), false, 'a config folder was created');
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-install-')));
  appDir = await realpath(APP_DIR);
  engram = createHttpServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => engram.listen(0, '127.0.0.1', resolve));
  engramPort = (engram.address() as { port: number }).port;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPort = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  mirror = join(scratch, 'sysbin');
  await mkdir(mirror);
  for (const folder of ['/usr/bin', '/bin']) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (HIDDEN.has(name)) continue;
      await symlink(join(folder, name), join(mirror, name)).catch(() => {});
    }
  }
  // No fake mise: install.sh's Node hint changes when mise is on PATH, so it stays hidden from the mirror.
  barrier = await writeNetworkBarrier(join(scratch, 'barrier'), ['curl', 'wget']);
});

/** Runs `script` with sh in the box's folder and env; not an installer run. */
function sh(b: Box, script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { cwd: b.dir, env: b.env }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }));
  });
}

test("the box's PATH finds curl and wget in the network barrier and no mise, and a curl stub of the test's own wins over it", async () => {
  const b = await box();
  const found = await sh(b, 'for tool in mise curl wget; do command -v "$tool" || echo "no $tool"; done');
  assert.equal(found.stdout, `no mise\n${join(barrier, 'curl')}\n${join(barrier, 'wget')}\n`);
  assert.deepEqual(await sh(b, 'wget https://example.invalid'), { code: 97, stdout: '', stderr: "mirador test sandbox: 'wget' is blocked here, installer tests must not reach the network\n" });
  const stubbed = await box({ tools: ['node', 'pnpm', 'python3', 'make', 'g++', 'curl'] });
  assert.deepEqual(await sh(stubbed, 'command -v curl; curl https://example.invalid'), { code: 0, stdout: `${join(stubbed.stubs, 'curl')}\n`, stderr: '' });
  assert.deepEqual(await readdir(b.home), []);
});

after(async () => {
  await new Promise((resolve) => engram.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('--help prints the usage and changes nothing', async () => {
  const b = await box();
  const result = await run(b, ['--help']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, USAGE);
  assert.equal(result.stderr, '');
  await assertUntouched(b);
});

test('an unknown option exits 2 with the usage and changes nothing', async () => {
  const b = await box();
  const result = await run(b, ['--bogus']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `install.sh: unknown option --bogus\n${USAGE}`);
  await assertUntouched(b);
});

test('--root without a folder exits 2 with the usage and changes nothing', async () => {
  const b = await box();
  const result = await run(b, ['--root']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `install.sh: --root needs a folder\n${USAGE}`);
  await assertUntouched(b);
});

test('--root naming no folder exits 2 before changing anything', async () => {
  const b = await box();
  const missing = join(b.dir, 'nowhere');
  const result = await run(b, ['--root', missing]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `install.sh: --root ${missing} is not a folder\n`);
  await assertUntouched(b);
});

const ARCH = 'NAME="Arch Linux"\nID=arch\n';
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 13"\nID=debian\n';
const NODE_LINK = 'https://nodejs.org/en/download';
const MISE_STEPS = `curl https://mise.run | sh; echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc; then, in a new terminal: mise use -g node@24`;
const WSL_KERNEL = '5.15.167.4-microsoft-standard-WSL2';
const NO_CXX = 'install.sh: missing a C++ compiler, g++ or c++ (node-pty compiles with it); install it with: sudo apt install g++\n';

function wslWarning(dir: string): string {
  return `install.sh: warning: this clone is on a Windows drive (${dir}); under WSL its files go through a slow bridge, so installing, building node-pty and loading Mirador are much slower. Clone it in your Linux home instead: git clone https://github.com/mata-2p/mirador.git ~/mirador\n`;
}

/**
 * A copy of install.sh at <box>/drives/c/mirador, with MIRADOR_WSL_DRIVES pointing at <box>/drives, and a
 * link to src/ for doctor's browser check, which the installer runs from its own folder.
 */
async function onDrive(b: Box): Promise<string> {
  const dir = join(b.dir, 'drives', 'c', 'mirador');
  await mkdir(dir, { recursive: true });
  await copyFile(SCRIPT, join(dir, 'install.sh'));
  await chmod(join(dir, 'install.sh'), 0o755);
  await symlink(join(appDir, 'src'), join(dir, 'src'));
  b.env.MIRADOR_WSL_DRIVES = join(b.dir, 'drives');
  return dir;
}

for (const kernel of [WSL_KERNEL, '4.4.0-19041-Microsoft']) {
  test(`under WSL (${kernel}) a clone on a Windows drive gets a warning first, and the checks go on`, async () => {
    const b = await box({ osRelease: DEBIAN, kernelRelease: kernel, tools: ['node', 'pnpm', 'python3', 'make'] });
    const dir = await onDrive(b);
    const result = await run(b, [], dir, join(dir, 'install.sh'));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, wslWarning(dir) + NO_CXX + NEXT);
    await assertUntouched(b);
  });
}

test('under WSL a clone in the Linux home gets no drive warning', async () => {
  const b = await box({ osRelease: DEBIAN, kernelRelease: WSL_KERNEL, tools: ['node', 'pnpm', 'python3', 'make'] });
  await onDrive(b);
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, NO_CXX + NEXT);
  await assertUntouched(b);
});

test('outside WSL a clone under the drives folder gets no drive warning', async () => {
  const b = await box({ osRelease: DEBIAN, tools: ['node', 'pnpm', 'python3', 'make'] });
  const dir = await onDrive(b);
  const result = await run(b, [], dir, join(dir, 'install.sh'));
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, NO_CXX + NEXT);
  await assertUntouched(b);
});

test('with one apt item missing there is only its own line, and no combined command', async () => {
  const b = await box({ osRelease: DEBIAN, tools: ['node', 'pnpm', 'python3', 'g++'] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'install.sh: missing make (node-pty compiles with it); install it with: sudo apt install make\n' + NEXT);
  await assertUntouched(b);
});

test('on Debian without Node or mise it gives the mise install steps', async () => {
  const b = await box({ osRelease: DEBIAN, tools: ['pnpm', 'python3', 'make', 'g++'] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with mise: ${MISE_STEPS} (or see ${NODE_LINK})\n` + NEXT,
  );
  await assertUntouched(b);
});

test('on Debian without Node but with mise on PATH it gives only the mise use step', async () => {
  const b = await box({ osRelease: DEBIAN, tools: ['pnpm', 'python3', 'make', 'g++', 'mise'] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with mise: mise use -g node@24 (or see ${NODE_LINK})\n` + NEXT,
  );
  await assertUntouched(b);
});

test('on Linux, each missing item gets one line with the pacman command, and nothing changes', async () => {
  const b = await box({ osRelease: ARCH, tools: [] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    [
      'install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with: sudo pacman -S nodejs',
      "install.sh: missing pnpm (it installs Mirador's dependencies); install it with: sudo pacman -S pnpm",
      'install.sh: missing python3 (node-pty compiles with it); install it with: sudo pacman -S python',
      'install.sh: missing make (node-pty compiles with it); install it with: sudo pacman -S make',
      'install.sh: missing a C++ compiler, g++ or c++ (node-pty compiles with it); install it with: sudo pacman -S gcc',
      '',
    ].join('\n') + NEXT,
  );
  await assertUntouched(b);
});

test('a Node older than 24 is reported with the version found', async () => {
  const b = await box({ osRelease: DEBIAN, tools: ['node', 'pnpm', 'python3', 'make', 'g++'], nodeVersion: 'v22.3.0' });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `install.sh: missing Node 24 or newer, found v22.3.0 (Mirador runs its TypeScript sources with it); install it with mise: ${MISE_STEPS} (or see ${NODE_LINK})\n` + NEXT,
  );
  await assertUntouched(b);
});

const BUILD_CASES: { name: string; osRelease?: string; managers?: string[]; python: string; make: string; cxx: string; all?: string }[] = [
  { name: 'Debian uses apt', osRelease: DEBIAN, python: 'install it with: sudo apt install python3', make: 'install it with: sudo apt install make', cxx: 'install it with: sudo apt install g++', all: 'install.sh: or install them all at once with: sudo apt install python3 make g++' },
  {
    name: 'a distro like Ubuntu uses apt',
    osRelease: 'ID=linuxmint\nID_LIKE="ubuntu debian"\n',
    python: 'install it with: sudo apt install python3',
    make: 'install it with: sudo apt install make',
    cxx: 'install it with: sudo apt install g++',
    all: 'install.sh: or install them all at once with: sudo apt install python3 make g++',
  },
  { name: 'Fedora uses dnf', osRelease: 'ID=fedora\n', python: 'install it with: sudo dnf install python3', make: 'install it with: sudo dnf install make', cxx: 'install it with: sudo dnf install gcc-c++' },
  {
    name: 'openSUSE uses zypper',
    osRelease: "ID='opensuse-tumbleweed'\nID_LIKE='opensuse suse'",
    python: 'install it with: sudo zypper install python3',
    make: 'install it with: sudo zypper install make',
    cxx: 'install it with: sudo zypper install gcc-c++',
  },
  {
    name: 'an unknown distro uses the package manager on PATH',
    osRelease: 'ID=somethingelse\n',
    managers: ['dnf'],
    python: 'install it with: sudo dnf install python3',
    make: 'install it with: sudo dnf install make',
    cxx: 'install it with: sudo dnf install gcc-c++',
  },
  { name: 'with no os-release and no package manager it links the build docs', managers: [], python: `see ${BUILD_LINK}`, make: `see ${BUILD_LINK}`, cxx: `see ${BUILD_LINK}` },
];

// Linux is emulated with a uname stub, but bash is the host's: macOS's /bin/bash 3.2 treats an empty
// array under `set -u` as unbound (install.sh's os-release words, empty without an os-release),
// which no Linux bash (4.4 or newer) does. Kept until install.sh guards that array.
const EMPTY_ARRAY_NEEDS_BASH_44 = process.platform === 'darwin' && "emulates Linux under macOS's bash 3.2, where install.sh's empty os-release word list is unbound under set -u; Linux ships bash 4.4 or newer";

for (const c of BUILD_CASES) {
  test(`missing build tools: ${c.name}`, { skip: c.osRelease === undefined && EMPTY_ARRAY_NEEDS_BASH_44 }, async () => {
    const b = await box({ osRelease: c.osRelease, managers: c.managers, tools: ['node', 'pnpm'] });
    const result = await run(b, []);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      [
        `install.sh: missing python3 (node-pty compiles with it); ${c.python}`,
        `install.sh: missing make (node-pty compiles with it); ${c.make}`,
        `install.sh: missing a C++ compiler, g++ or c++ (node-pty compiles with it); ${c.cxx}`,
        ...(c.all ? [c.all] : []),
        '',
      ].join('\n') + NEXT,
    );
    await assertUntouched(b);
  });
}

test('on macOS without Homebrew it links Node and pnpm and asks for the Xcode Command Line Tools', async () => {
  const b = await box({ uname: 'Darwin', managers: [], tools: [] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    [
      'install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); see https://nodejs.org/en/download',
      "install.sh: missing pnpm (it installs Mirador's dependencies); see https://pnpm.io/installation",
      'install.sh: missing the Xcode Command Line Tools (node-pty compiles with them); install them with: xcode-select --install',
      '',
    ].join('\n') + NEXT,
  );
  await assertUntouched(b);
});

test('on macOS with Homebrew it gives the brew commands', async () => {
  const b = await box({ uname: 'Darwin', managers: ['brew'], tools: ['xcode-select'] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    [
      'install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with: brew install node',
      "install.sh: missing pnpm (it installs Mirador's dependencies); install it with: brew install pnpm",
      '',
    ].join('\n') + NEXT,
  );
  await assertUntouched(b);
});

test('another system is not supported and nothing changes', async () => {
  const b = await box({ uname: 'MINGW64_NT-10.0' });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'install.sh: MINGW64_NT-10.0 is not supported; Mirador runs on Linux, macOS (experimental) and WSL2\n');
  await assertUntouched(b);
});

function installed(config: string, configLines: string[], tail: string[]): string {
  return [
    'install.sh: installing the dependencies (pnpm install --frozen-lockfile)',
    'pnpm: dependencies installed',
    `install.sh: created ${config}`,
    ...configLines,
    'install.sh: checking the machine (pnpm run doctor)',
    'doctor: all good',
    ...tail,
    '',
  ].join('\n');
}

const LINUX_TAIL = [
  'install.sh: adding the launcher (bin/mirador install)',
  'mirador: installed ~/.local/bin/mirador and the Mirador app menu entry',
  'install.sh: done; start Mirador with: bin/mirador',
];

test('on Linux it installs, creates the config from the example, runs doctor and links the launcher', async () => {
  const b = await box({ osRelease: ARCH });
  const config = join(b.home, '.config', 'mirador', 'config.json');
  const result = await run(b, []);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, installed(config, [ROOT_HINT], LINUX_TAIL));
  assert.equal(result.code, 0);
  assert.equal(await readFile(config, 'utf8'), await readFile(EXAMPLE, 'utf8'));
  assert.equal(await readFile(b.pnpmLog, 'utf8'), `${appDir}|install --frozen-lockfile\n${appDir}|run doctor\n`);
  assert.equal(await readlink(join(b.home, '.local', 'bin', 'mirador')), join(appDir, 'bin', 'mirador'));
  assert.ok(await exists(join(b.home, '.local', 'share', 'applications', 'mirador.desktop')));
  assert.equal(await exists(b.forbiddenLog), false, 'sudo or a package manager ran');
});

test('--root sets the workspace folder of a new config under XDG_CONFIG_HOME, and c++ is a C++ compiler', async () => {
  const b = await box({ osRelease: DEBIAN, xdgConfig: true, tools: ['node', 'pnpm', 'python3', 'make', 'c++'] });
  const root = join(b.dir, 'my code $&');
  await mkdir(root);
  const config = join(b.dir, 'cfg', 'mirador', 'config.json');
  const result = await run(b, ['--root', root]);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, installed(`${config} with root ${root}`, [], LINUX_TAIL));
  assert.equal(result.code, 0);
  const example = await readFile(EXAMPLE, 'utf8');
  assert.equal(await readFile(config, 'utf8'), example.replace('"/home/you/code"', () => JSON.stringify(root)));
  assert.equal(JSON.parse(await readFile(config, 'utf8')).workspaces[0].root, root);
  assert.equal(await exists(join(b.home, '.config')), false, 'wrote under ~/.config despite XDG_CONFIG_HOME');
});

test('an existing config is never touched, even with --root', async () => {
  const b = await box({ osRelease: ARCH, xdgConfig: true });
  const config = join(b.dir, 'cfg', 'mirador', 'config.json');
  await mkdir(join(b.dir, 'cfg', 'mirador'), { recursive: true });
  const mine = '{ "root": "/somewhere/mine" }\n';
  await writeFile(config, mine, { mode: 0o600 });
  const before = await stat(config);
  const result = await run(b, ['--root', b.dir]);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    [
      'install.sh: installing the dependencies (pnpm install --frozen-lockfile)',
      'pnpm: dependencies installed',
      `install.sh: kept the existing config ${config}; --root was not applied to it`,
      'install.sh: checking the machine (pnpm run doctor)',
      'doctor: all good',
      ...LINUX_TAIL,
      '',
    ].join('\n'),
  );
  assert.equal(result.code, 0);
  assert.equal(await readFile(config, 'utf8'), mine);
  const after = await stat(config);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode & 0o777, 0o600);
});

test('an existing config that is a symlink is kept, and the file it points at is untouched', async () => {
  const b = await box({ osRelease: ARCH, xdgConfig: true });
  const config = join(b.dir, 'cfg', 'mirador', 'config.json');
  const target = join(b.dir, 'dotfiles', 'mirador.json');
  await mkdir(join(b.dir, 'dotfiles'));
  await mkdir(join(b.dir, 'cfg', 'mirador'), { recursive: true });
  const mine = '{ "root": "/somewhere/linked" }\n';
  await writeFile(target, mine);
  await symlink(target, config);
  const before = await stat(target);
  const result = await run(b, []);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes(`install.sh: kept the existing config ${config}\n`), result.stdout);
  assert.equal(result.code, 0);
  assert.equal(await readlink(config), target);
  assert.equal(await readFile(target, 'utf8'), mine);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
});

test('when pnpm install fails it says so on stderr and exits 1 before the config, doctor or the launcher', async () => {
  const b = await box({ osRelease: ARCH, installExit: 1 });
  const result = await run(b, []);
  assert.equal(result.stderr, 'pnpm: ERR_PNPM_OUTDATED_LOCKFILE\ninstall.sh: pnpm install failed; see the output above\n');
  assert.equal(result.stdout, 'install.sh: installing the dependencies (pnpm install --frozen-lockfile)\n');
  assert.equal(result.code, 1);
  assert.equal(await readFile(b.pnpmLog, 'utf8'), `${appDir}|install --frozen-lockfile\n`);
  assert.deepEqual(await readdir(b.home), [], 'the home folder changed');
  assert.equal(await exists(b.forbiddenLog), false, 'sudo or a package manager ran');
});

test('when pnpm run doctor finds a problem it exits 1 without linking the launcher', async () => {
  const b = await box({ osRelease: ARCH, doctorExit: 1 });
  const config = join(b.home, '.config', 'mirador', 'config.json');
  const result = await run(b, []);
  assert.equal(result.stderr, 'install.sh: pnpm run doctor found a problem; fix it, then run ./install.sh again\n');
  assert.equal(result.stdout, installed(config, [ROOT_HINT], []));
  assert.equal(result.code, 1);
  assert.equal(await exists(join(b.home, '.local')), false, 'the launcher was linked');
});

test('on macOS it skips the launcher link and, outside the clone, names the launcher by its full path', async () => {
  const b = await box({ uname: 'Darwin', managers: ['brew'], tools: ['node', 'pnpm', 'xcode-select'] });
  const config = join(b.home, '.config', 'mirador', 'config.json');
  const result = await run(b, [], b.dir);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    installed(config, [ROOT_HINT], [`install.sh: done; start Mirador with: ${join(appDir, 'bin', 'mirador')}`]),
  );
  assert.equal(result.code, 0);
  assert.equal(await readFile(b.pnpmLog, 'utf8'), `${appDir}|install --frozen-lockfile\n${appDir}|run doctor\n`);
  assert.equal(await exists(join(b.home, '.local')), false, 'the launcher was linked');
  assert.equal(await exists(b.forbiddenLog), false, 'brew ran');
});

// `pnpm doctor` is pnpm's own command; the installer runs Mirador's.
test("the installer runs Mirador's doctor script, never pnpm's builtin doctor", async () => {
  const b = await box({ osRelease: ARCH });
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readFile(b.pnpmLog, 'utf8')).split('\n').filter(Boolean).map((line) => line.split('|')[1]), ['install --frozen-lockfile', 'run doctor']);
  assert.ok(!result.stdout.includes("pnpm's own doctor"), result.stdout);
});

// apt, dnf and zypper have no pnpm package worth naming. The hint names pnpm 12, the major CI installs the lockfile with.
const PNPM_MISSING = "install.sh: missing pnpm (it installs Mirador's dependencies); install it with: ";

for (const [manager, osRelease] of [['apt', DEBIAN], ['dnf', 'ID=fedora\n'], ['zypper', 'ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n']]) {
  test(`on ${manager} a missing pnpm is enabled with corepack when corepack is on PATH, else installed with mise`, async () => {
    const withCorepack = await box({ osRelease, tools: ['node', 'corepack', 'python3', 'make', 'g++'] });
    const corepack = await run(withCorepack, []);
    assert.equal(corepack.code, 1);
    assert.equal(corepack.stdout, '');
    assert.equal(corepack.stderr, `${PNPM_MISSING}corepack enable pnpm && corepack install -g pnpm@12\n` + NEXT);
    await assertUntouched(withCorepack);

    const withoutCorepack = await box({ osRelease, tools: ['node', 'python3', 'make', 'g++'] });
    const mise = await run(withoutCorepack, []);
    assert.equal(mise.code, 1);
    assert.equal(mise.stdout, '');
    assert.equal(mise.stderr, `${PNPM_MISSING}mise use -g pnpm@12\n` + NEXT);
    await assertUntouched(withoutCorepack);
  });
}

test('on Debian with everything missing the combined apt command still names only apt packages', async () => {
  const b = await box({ osRelease: DEBIAN, tools: [] });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    [
      `install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with mise: ${MISE_STEPS} (or see ${NODE_LINK})`,
      `${PNPM_MISSING}mise use -g pnpm@12`,
      'install.sh: missing python3 (node-pty compiles with it); install it with: sudo apt install python3',
      'install.sh: missing make (node-pty compiles with it); install it with: sudo apt install make',
      'install.sh: missing a C++ compiler, g++ or c++ (node-pty compiles with it); install it with: sudo apt install g++',
      'install.sh: or install them all at once with: sudo apt install python3 make g++',
      '',
    ].join('\n') + NEXT,
  );
  await assertUntouched(b);
});

// The launcher link only works as `mirador` when ~/.local/bin is on PATH.
const LOCAL_BIN_WARNING = 'install.sh: warning: ~/.local/bin is not on your PATH, so the mirador command is not found yet; add export PATH="$HOME/.local/bin:$PATH" to your shell rc (~/.bashrc or ~/.zshrc) and open a new terminal\n';

test('on Linux without ~/.local/bin on PATH it warns once after linking the launcher, and edits no rc file', async () => {
  const b = await box({ osRelease: ARCH, localBin: false });
  const config = join(b.home, '.config', 'mirador', 'config.json');
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, LOCAL_BIN_WARNING);
  assert.equal(result.stdout, installed(config, [ROOT_HINT], LINUX_TAIL));
  assert.deepEqual((await readdir(b.home)).sort(), ['.config', '.local']);
});

test('on Linux with ~/.local/bin on PATH (also written with a trailing slash) there is no PATH warning', async () => {
  const b = await box({ osRelease: ARCH, localBin: false });
  b.env.PATH = `${b.env.PATH}:${join(b.home, '.local', 'bin')}/`;
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('on macOS, where the installer links no launcher, there is no PATH warning', async () => {
  const b = await box({ uname: 'Darwin', managers: ['brew'], tools: ['node', 'pnpm', 'xcode-select'], localBin: false });
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
});

// After a successful install, a missing gentle-shell, pi or
// Engram gets one note on stderr saying what Mirador does without it; the install still exits 0.
// The Engram note uses doctor's own check (node
// src/doctor.ts --engram): whether Engram answers at the config's engramUrl, not whether engram is on PATH.
const GENTLE_SHELL_LINK = 'https://github.com/Gentleman-Programming/gentle-shell';
const NOTE_GENTLE_SHELL = `install.sh: note: gentle-shell is not on PATH, so Mirador runs in plain mode (one bash per folder, no memory views or night shift) unless gentle-ai is set up; install it from ${GENTLE_SHELL_LINK}\n`;
const NOTE_PI = `install.sh: note: neither pi nor gentle-shell, which starts it, is on PATH, so there is no pi agent; install gentle-shell from ${GENTLE_SHELL_LINK}\n`;
const noteEngram = () => `install.sh: note: Engram does not answer at http://127.0.0.1:${closedPort}, so memory views such as "where it left off" stay empty; start it with: engram serve (pnpm run doctor above says more)\n`;

test('without gentle-shell, pi and Engram the install still succeeds, and each gets a note at the end', async () => {
  const b = await box({ osRelease: ARCH, extras: [], engram: false });
  const config = join(b.home, '.config', 'mirador', 'config.json');
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, NOTE_GENTLE_SHELL + NOTE_PI + noteEngram());
  assert.equal(result.stdout, installed(config, [ROOT_HINT], LINUX_TAIL));
  assert.equal(await readlink(join(b.home, '.local', 'bin', 'mirador')), join(appDir, 'bin', 'mirador'));
});

test('only what is missing gets a note: gentle-shell counts as pi, and pi alone is pi', async () => {
  const shell = await run(await box({ osRelease: ARCH, extras: ['gentle-shell'], engram: false }), []);
  assert.equal(shell.code, 0, shell.stderr);
  assert.equal(shell.stderr, noteEngram());

  const pi = await run(await box({ uname: 'Darwin', managers: ['brew'], tools: ['node', 'pnpm', 'xcode-select'], extras: ['pi'] }), []);
  assert.equal(pi.code, 0, pi.stderr);
  assert.equal(pi.stderr, NOTE_GENTLE_SHELL);
});

test('the notes come after the ~/.local/bin warning, and a failed doctor still stops before any note', async () => {
  const warned = await run(await box({ osRelease: ARCH, localBin: false, extras: ['gentle-shell', 'pi'], engram: false }), []);
  assert.equal(warned.code, 0, warned.stderr);
  assert.equal(warned.stderr, LOCAL_BIN_WARNING + noteEngram());

  const failed = await run(await box({ osRelease: ARCH, doctorExit: 1, extras: [], engram: false }), []);
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, 'install.sh: pnpm run doctor found a problem; fix it, then run ./install.sh again\n');
});

test("the Engram note follows doctor's check: Engram answering at the config's engramUrl, not engram on PATH", async () => {
  // Installed but not running: doctor says "no answer", so the installer notes it too.
  const stopped = await run(await box({ osRelease: ARCH, extras: ['gentle-shell', 'pi', 'engram'], engram: false }), []);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.stderr, noteEngram());

  // Answering, with no engram on PATH (another machine, a container): no note, as doctor shows it ok.
  const answering = await run(await box({ osRelease: ARCH, extras: ['gentle-shell', 'pi'] }), []);
  assert.equal(answering.code, 0, answering.stderr);
  assert.equal(answering.stderr, '');

  // An existing config's engramUrl wins over ENGRAM_PORT, as in doctor.
  const b = await box({ osRelease: ARCH, extras: ['gentle-shell', 'pi'] });
  await mkdir(join(b.home, '.config', 'mirador'), { recursive: true });
  await writeFile(join(b.home, '.config', 'mirador', 'config.json'), JSON.stringify({ engramUrl: `http://127.0.0.1:${closedPort}` }));
  const configured = await run(b, []);
  assert.equal(configured.code, 0, configured.stderr);
  assert.equal(configured.stderr, noteEngram());
});

// Run from another folder (the bootstrap runs install.sh from yours), the hints that say to run it again
// name the clone's install.sh by its full path, as the final line names the launcher.
test('run from another folder, a missing item ends with the full path of install.sh to run again', async () => {
  const b = await box({ osRelease: DEBIAN, tools: ['node', 'pnpm', 'python3', 'g++'] });
  const result = await run(b, [], b.dir);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'install.sh: missing make (node-pty compiles with it); install it with: sudo apt install make\n' +
      `install.sh: nothing was changed; install what is missing, then run ${join(appDir, 'install.sh')} again\n`,
  );
  await assertUntouched(b);
});

test('run from another folder, a failed doctor names the full path of install.sh to run again', async () => {
  const b = await box({ osRelease: ARCH, doctorExit: 1 });
  const result = await run(b, [], b.dir);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, `install.sh: pnpm run doctor found a problem; fix it, then run ${join(appDir, 'install.sh')} again\n`);
  assert.equal(await exists(join(b.home, '.local')), false, 'the launcher was linked');
});

// The browser is checked before anything is installed, with doctor's own check (node src/doctor.ts
// --browser), so a missing one no longer shows up only in doctor's output after the install.
const NO_BROWSER = `install.sh: missing a browser (Mirador opens in it; no Chromium-family browser (${BROWSERS.join(', ')}) and no xdg-open on PATH); `;

for (const [distro, osRelease, command] of [
  ['Debian', DEBIAN, 'sudo apt install chromium'],
  ['Ubuntu', 'ID=ubuntu\nID_LIKE=debian\n', 'sudo snap install chromium'],
  ['Arch', ARCH, 'sudo pacman -S chromium'],
  ['Fedora', 'ID=fedora\n', 'sudo dnf install chromium'],
  ['openSUSE', 'ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n', 'sudo zypper install chromium'],
]) {
  test(`on ${distro} without a browser it says how to install one before installing anything`, async () => {
    const b = await box({ osRelease, browser: false });
    const result = await run(b, []);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${NO_BROWSER}install it with: ${command}\n` + NEXT);
    await assertUntouched(b);
  });
}

test('on Debian the browser joins the combined apt command, and without a package manager it gets a link', async () => {
  const debian = await box({ osRelease: DEBIAN, browser: false, tools: ['node', 'pnpm', 'python3', 'g++'] });
  const both = await run(debian, []);
  assert.equal(both.code, 1);
  assert.equal(
    both.stderr,
    'install.sh: missing make (node-pty compiles with it); install it with: sudo apt install make\n' +
      `${NO_BROWSER}install it with: sudo apt install chromium\n` +
      'install.sh: or install them all at once with: sudo apt install make chromium\n' +
      NEXT,
  );
  await assertUntouched(debian);

  const bare = await box({ osRelease: 'ID=somethingelse\n', managers: [], browser: false });
  const linked = await run(bare, []);
  assert.equal(linked.code, 1);
  assert.equal(linked.stderr, `${NO_BROWSER}see https://www.chromium.org/getting-involved/download-chromium/\n` + NEXT);
  await assertUntouched(bare);
});

test('without a Chromium-family browser, xdg-open (a tab) is enough to install, as for doctor', async () => {
  const b = await box({ osRelease: DEBIAN, browser: false });
  await stub(b.stubs, 'xdg-open', 'exit 1');
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, installed(join(b.home, '.config', 'mirador', 'config.json'), [ROOT_HINT], LINUX_TAIL));
});

// Without a Node that runs doctor (none, or older than 24), the first round still lists a missing browser,
// instead of only the second run: a shell check of the same openers doctor looks for on Linux (BROWSERS,
// then wslview and powershell.exe under WSL, then xdg-open), with doctor's wording.
test('with nothing installed on Debian, the first round lists the browser too, in the combined apt command', async () => {
  const b = await box({ osRelease: DEBIAN, tools: [], browser: false });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    [
      `install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with mise: ${MISE_STEPS} (or see ${NODE_LINK})`,
      `${PNPM_MISSING}mise use -g pnpm@12`,
      'install.sh: missing python3 (node-pty compiles with it); install it with: sudo apt install python3',
      'install.sh: missing make (node-pty compiles with it); install it with: sudo apt install make',
      'install.sh: missing a C++ compiler, g++ or c++ (node-pty compiles with it); install it with: sudo apt install g++',
      `${NO_BROWSER}install it with: sudo apt install chromium`,
      'install.sh: or install them all at once with: sudo apt install python3 make g++ chromium',
      '',
    ].join('\n') + NEXT,
  );
  await assertUntouched(b);
});

test('with a Node older than 24 a missing browser is listed in the same round', async () => {
  const b = await box({ osRelease: ARCH, nodeVersion: 'v22.3.0', browser: false });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'install.sh: missing Node 24 or newer, found v22.3.0 (Mirador runs its TypeScript sources with it); install it with: sudo pacman -S nodejs\n' +
      `${NO_BROWSER}install it with: sudo pacman -S chromium\n` +
      NEXT,
  );
  await assertUntouched(b);
});

const NODE_PACMAN = 'install.sh: missing Node 24 or newer (Mirador runs its TypeScript sources with it); install it with: sudo pacman -S nodejs\n';

test("without Node, each browser of doctor's list, or xdg-open, is enough and no browser line is printed", async () => {
  for (const opener of [...BROWSERS, 'xdg-open']) {
    const b = await box({ osRelease: ARCH, tools: ['pnpm', 'python3', 'make', 'g++'], browser: false });
    await stub(b.stubs, opener, `echo "${opener} $*" >> '${b.forbiddenLog}'\nexit 1`);
    const result = await run(b, []);
    assert.equal(result.code, 1, opener);
    assert.equal(result.stdout, '', opener);
    assert.equal(result.stderr, NODE_PACMAN + NEXT, opener);
    await assertUntouched(b);
  }
});

test('without Node under WSL, wslview or powershell.exe is enough, and with neither the line names them as doctor does', async () => {
  for (const opener of ['wslview', 'powershell.exe']) {
    const b = await box({ osRelease: ARCH, kernelRelease: WSL_KERNEL, tools: ['pnpm', 'python3', 'make', 'g++'], browser: false });
    await stub(b.stubs, opener, 'exit 1');
    const result = await run(b, []);
    assert.equal(result.stderr, NODE_PACMAN + NEXT, opener);
  }
  const b = await box({ osRelease: ARCH, kernelRelease: WSL_KERNEL, tools: ['pnpm', 'python3', 'make', 'g++'], browser: false });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    NODE_PACMAN +
      `install.sh: missing a browser (Mirador opens in it; no Chromium-family browser (${BROWSERS.join(', ')}), wslview, powershell.exe or xdg-open on PATH); install it with: sudo pacman -S chromium\n` +
      NEXT,
  );
  await assertUntouched(b);
});

// On Linux without a display (not WSL, DISPLAY and WAYLAND_DISPLAY unset or empty) bin/mirador prints a
// one-time link to open in a browser elsewhere instead of opening a window, so a missing browser is a
// warning there and the install goes on. With a display, or under WSL, it still stops the install.
const NO_DISPLAY = (detail: string, add: string) =>
  `install.sh: warning: no browser found (${detail}); this machine has no display (DISPLAY and WAYLAND_DISPLAY are unset), so mirador prints a one-time link to open in a browser elsewhere instead of a window; to add a browser anyway, ${add}\n`;
const NO_LINUX_BROWSER = `no Chromium-family browser (${BROWSERS.join(', ')}) and no xdg-open on PATH`;

test('on Linux without a display a missing browser is one warning line, and the install goes on', async () => {
  const b = await box({ osRelease: ARCH, browser: false, display: false });
  const config = join(b.home, '.config', 'mirador', 'config.json');
  const result = await run(b, []);
  assert.equal(result.stderr, NO_DISPLAY(NO_LINUX_BROWSER, 'install it with: sudo pacman -S chromium'));
  assert.equal(result.stdout, installed(config, [ROOT_HINT], LINUX_TAIL));
  assert.equal(result.code, 0);
  assert.equal(await readFile(b.pnpmLog, 'utf8'), `${appDir}|install --frozen-lockfile\n${appDir}|run doctor\n`);
  assert.equal(await readlink(join(b.home, '.local', 'bin', 'mirador')), join(appDir, 'bin', 'mirador'));
  assert.equal(await exists(b.forbiddenLog), false, 'sudo or a package manager ran');
});

test('without a display, empty DISPLAY and WAYLAND_DISPLAY count as unset, and without a package manager the warning links a download', async () => {
  const b = await box({ osRelease: 'ID=somethingelse\n', managers: [], browser: false, display: false });
  b.env.DISPLAY = '';
  b.env.WAYLAND_DISPLAY = '';
  const result = await run(b, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, NO_DISPLAY(NO_LINUX_BROWSER, 'see https://www.chromium.org/getting-involved/download-chromium/'));
  assert.equal(result.stdout, installed(join(b.home, '.config', 'mirador', 'config.json'), [ROOT_HINT], LINUX_TAIL));
});

test("without a display and without Node, the shell check gives the same warning in the first round, and only Node is missing", async () => {
  const b = await box({ osRelease: ARCH, tools: ['pnpm', 'python3', 'make', 'g++'], browser: false, display: false });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, NODE_PACMAN + NO_DISPLAY(NO_LINUX_BROWSER, 'install it with: sudo pacman -S chromium') + NEXT);
  await assertUntouched(b);
});

test('with DISPLAY or WAYLAND_DISPLAY set, a missing browser still stops the install before anything changes', async () => {
  for (const variable of ['DISPLAY', 'WAYLAND_DISPLAY']) {
    const b = await box({ osRelease: ARCH, browser: false, display: false });
    b.env[variable] = variable === 'DISPLAY' ? ':0' : 'wayland-0';
    const result = await run(b, []);
    assert.equal(result.code, 1, variable);
    assert.equal(result.stdout, '', variable);
    assert.equal(result.stderr, `${NO_BROWSER}install it with: sudo pacman -S chromium\n` + NEXT, variable);
    await assertUntouched(b);
  }
});

// Only the shell check sees the stub's WSL kernel: doctor --browser reads the host's own kernel release.
test('under WSL without DISPLAY or WAYLAND_DISPLAY a missing browser is still missing, as WSL opens the Windows browser', async () => {
  const b = await box({ osRelease: ARCH, kernelRelease: WSL_KERNEL, tools: ['pnpm', 'python3', 'make', 'g++'], browser: false, display: false });
  const result = await run(b, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    NODE_PACMAN +
      `install.sh: missing a browser (Mirador opens in it; no Chromium-family browser (${BROWSERS.join(', ')}), wslview, powershell.exe or xdg-open on PATH); install it with: sudo pacman -S chromium\n` + NEXT,
  );
  await assertUntouched(b);
});
