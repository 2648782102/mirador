// No run may change the real home (R2). assertInstallerSandbox (test/helpers/installer-sandbox.ts) lets a
// test run scripts/bootstrap.sh or install.sh only in a container or with a temporary HOME. Each allow and
// reject case goes through it with a fake probe over a scratch tree: a fake temp dir and a fake real home.
// A scan then checks that every file under test/ and scripts/ that runs an installer calls it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstallerSandbox, defaultProbe, NETWORK_BARRIER_EXIT, writeNetworkBarrier, type InstallerSandboxProbe } from './helpers/installer-sandbox.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let fakeTmp: string;
let realHome: string;
let probe: InstallerSandboxProbe;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-sandbox-')));
  fakeTmp = join(scratch, 'tmp');
  realHome = join(scratch, 'users', 'me');
  await mkdir(join(fakeTmp, 'box', 'home'), { recursive: true });
  await mkdir(realHome, { recursive: true });
  probe = { inContainer: () => false, realHome: () => realHome, tmpdir: () => fakeTmp };
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const rejected = (reason: string, tmp = fakeTmp) => ({
  name: 'Error',
  message: `installer sandbox: ${reason}; run the installer in a container or with a temporary HOME inside ${tmp}`,
});

const XDG = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

test('in a container any HOME is allowed, even none or the real home', () => {
  const container = { ...probe, inContainer: () => true };
  assert.doesNotThrow(() => assertInstallerSandbox({}, container));
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: realHome }, container));
});

test('a HOME inside the temp dir is allowed, whether it exists yet or not', () => {
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: join(fakeTmp, 'box', 'home') }, probe));
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: join(fakeTmp, 'box', 'not-yet', 'home') }, probe));
});

test('a HOME inside the temp dir is allowed with every XDG dir inside it too, and an empty XDG dir counts as unset', () => {
  const env: NodeJS.ProcessEnv = { HOME: join(fakeTmp, 'box', 'home'), XDG_RUNTIME_DIR: join(scratch, 'run') };
  for (const name of XDG) env[name] = join(fakeTmp, 'box', name.toLowerCase());
  assert.doesNotThrow(() => assertInstallerSandbox(env, probe));
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: join(fakeTmp, 'box', 'home'), XDG_DATA_HOME: '' }, probe));
});

test('a HOME reached through a symlink is judged by where it really is', async () => {
  await symlink(join(fakeTmp, 'box'), join(scratch, 'into-tmp'));
  await symlink(realHome, join(fakeTmp, 'to-real-home'));
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: join(scratch, 'into-tmp', 'home') }, probe));
  const linked = join(fakeTmp, 'to-real-home');
  assert.throws(() => assertInstallerSandbox({ HOME: linked }, probe), rejected(`HOME ${linked} is the real home ${realHome}`));
  const dotted = `${fakeTmp}/../users/me`;
  assert.throws(() => assertInstallerSandbox({ HOME: dotted }, probe), rejected(`HOME ${dotted} is the real home ${realHome}`));
});

test('without HOME, or with an empty one, it refuses', () => {
  assert.throws(() => assertInstallerSandbox({}, probe), rejected('HOME is not set'));
  assert.throws(() => assertInstallerSandbox({ HOME: '' }, probe), rejected('HOME is not set'));
});

test('a relative HOME is refused', () => {
  assert.throws(() => assertInstallerSandbox({ HOME: 'box/home' }, probe), rejected('HOME box/home is not an absolute path'));
});

test('the real home, or a folder that holds it, is refused', () => {
  assert.throws(() => assertInstallerSandbox({ HOME: realHome }, probe), rejected(`HOME ${realHome} is the real home ${realHome}`));
  const parent = join(scratch, 'users');
  assert.throws(() => assertInstallerSandbox({ HOME: parent }, probe), rejected(`HOME ${parent} contains the real home ${realHome}`));
});

test('a HOME outside the temp dir, or the temp dir itself, is refused', () => {
  const outside = join(scratch, 'elsewhere', 'home');
  assert.throws(() => assertInstallerSandbox({ HOME: outside }, probe), rejected(`HOME ${outside} is not inside ${fakeTmp}`));
  assert.throws(() => assertInstallerSandbox({ HOME: fakeTmp }, probe), rejected(`HOME ${fakeTmp} is not inside ${fakeTmp}`));
});

test('an XDG dir outside the temp dir, or a relative one, is refused even with HOME inside it', () => {
  const home = join(fakeTmp, 'box', 'home');
  const outside = join(scratch, 'elsewhere', 'xdg');
  for (const name of XDG) {
    assert.throws(() => assertInstallerSandbox({ HOME: home, [name]: outside }, probe), rejected(`${name} ${outside} is not inside ${fakeTmp}`));
    assert.throws(() => assertInstallerSandbox({ HOME: home, [name]: 'xdg' }, probe), rejected(`${name} xdg is not an absolute path`));
  }
});

test('on this host the default probe refuses HOME set to the real home', { skip: defaultProbe.inContainer() && 'runs in a container, where any HOME is allowed' }, async () => {
  const home = userInfo().homedir;
  const tmp = realpathSync(tmpdir());
  assert.throws(() => assertInstallerSandbox({ HOME: home }), rejected(`HOME ${home} is the real home ${realpathSync(home)}`, tmp));
  const box = await realpath(await mkdtemp(join(tmpdir(), 'mirador-sandbox-home-')));
  try {
    assert.doesNotThrow(() => assertInstallerSandbox({ HOME: box }));
  } finally {
    await rm(box, { recursive: true, force: true });
  }
});

// The network barrier: installer tests must not reach the network (a real mise under a scratch HOME once
// downloaded Node). writeNetworkBarrier writes a fake mise, curl and wget that only say so and exit 97, and
// the guard refuses a PATH that finds any of the three outside the temp dir.

const blocked = (tool: string) => `mirador test sandbox: '${tool}' is blocked here, installer tests must not reach the network\n`;

function runIn(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, cwd }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }));
  });
}

const reaches = (tool: string, found: string, tmp = fakeTmp) => ({
  name: 'Error',
  message: `installer sandbox: PATH finds ${tool} at ${found}, outside ${tmp}; put writeNetworkBarrier's folder on PATH before any system folder, so installer tests cannot reach the network`,
});

/** A folder outside the fake temp dir holding executables named `names`, standing in for /usr/bin. */
async function systemBin(name: string, names: string[]): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  for (const tool of names) {
    await writeFile(join(dir, tool), '#!/bin/sh\nexit 0\n');
    await chmod(join(dir, tool), 0o755);
  }
  return dir;
}

test('each fake in the network barrier says it is blocked on stderr, exits 97, prints nothing on stdout and leaves no file', async () => {
  const barrier = await writeNetworkBarrier(join(fakeTmp, 'barrier-a'));
  const cwd = join(fakeTmp, 'barrier-cwd');
  const home = join(fakeTmp, 'barrier-home');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  assert.equal(NETWORK_BARRIER_EXIT, 97);
  assert.deepEqual((await readdir(barrier)).sort(), ['curl', 'mise', 'wget']);
  for (const tool of ['mise', 'curl', 'wget']) {
    const result = await runIn(join(barrier, tool), ['https://example.invalid/install.sh', '-o', 'out'], { PATH: barrier, HOME: home }, cwd);
    assert.deepEqual(result, { code: 97, stdout: '', stderr: blocked(tool) }, tool);
  }
  assert.deepEqual(await readdir(cwd), [], 'a fake wrote in its folder');
  assert.deepEqual(await readdir(home), [], 'a fake wrote in HOME');
  assert.deepEqual((await readdir(barrier)).sort(), ['curl', 'mise', 'wget'], 'a fake wrote in the barrier');
});

test('the network barrier can hold only some of the fakes', async () => {
  const barrier = await writeNetworkBarrier(join(fakeTmp, 'barrier-b'), ['curl', 'wget']);
  assert.deepEqual((await readdir(barrier)).sort(), ['curl', 'wget']);
});

test('a PATH that finds a real mise, curl or wget outside the temp dir is refused, naming the tool and where it was found', async () => {
  const home = join(fakeTmp, 'box', 'home');
  for (const tool of ['mise', 'curl', 'wget']) {
    const bin = await systemBin(`sys-${tool}`, [tool]);
    assert.throws(() => assertInstallerSandbox({ HOME: home, PATH: bin }, probe), reaches(tool, join(bin, tool)));
    assert.throws(() => assertInstallerSandbox({ HOME: home, PATH: `${join(scratch, 'nowhere')}::relative:${bin}` }, probe), reaches(tool, join(bin, tool)));
  }
  // A link inside the temp dir that points at a real one is judged by where it really is.
  const sys = await systemBin('sys-linked', ['curl']);
  const mirror = join(fakeTmp, 'mirror');
  await mkdir(mirror, { recursive: true });
  await symlink(join(sys, 'curl'), join(mirror, 'curl'));
  assert.throws(() => assertInstallerSandbox({ HOME: home, PATH: mirror }, probe), reaches('curl', `${join(mirror, 'curl')} (${join(sys, 'curl')})`));
  // It applies in a container too: the barrier is about the network, not the home.
  assert.throws(() => assertInstallerSandbox({ PATH: sys }, { ...probe, inContainer: () => true }), reaches('curl', join(sys, 'curl')));
});

test('with the network barrier before the system folders, or none of the three on PATH, the PATH is allowed', async () => {
  const home = join(fakeTmp, 'box', 'home');
  const sys = await systemBin('sys-all', ['mise', 'curl', 'wget', 'git']);
  const barrier = await writeNetworkBarrier(join(fakeTmp, 'barrier-c'));
  const gitOnly = await systemBin('sys-git', ['git']);
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: home, PATH: `${barrier}:${sys}` }, probe));
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: home, PATH: gitOnly }, probe));
  assert.doesNotThrow(() => assertInstallerSandbox({ HOME: home }, probe));
  // A barrier holding only curl and wget still refuses a mise found after it.
  const partial = await writeNetworkBarrier(join(fakeTmp, 'barrier-d'), ['curl', 'wget']);
  assert.throws(() => assertInstallerSandbox({ HOME: home, PATH: `${partial}:${sys}` }, probe), reaches('mise', join(sys, 'mise')));
});

test("a test's own curl stub before the barrier is kept: it runs, and the guard allows it", async () => {
  const home = join(fakeTmp, 'box', 'home');
  const stubs = join(fakeTmp, 'stubs-c');
  await mkdir(stubs, { recursive: true });
  await writeFile(join(stubs, 'curl'), "#!/bin/sh\necho 'curl stub ran'\n");
  await chmod(join(stubs, 'curl'), 0o755);
  const barrier = await writeNetworkBarrier(join(fakeTmp, 'barrier-e'));
  const env = { HOME: home, PATH: `${stubs}:${barrier}:${await systemBin('sys-stubbed', ['curl'])}` };
  assert.doesNotThrow(() => assertInstallerSandbox(env, probe));
  assert.deepEqual(await runIn('/bin/sh', ['-c', 'curl https://example.invalid; mise --version'], env, home), { code: 97, stdout: 'curl stub ran\n', stderr: blocked('mise') });
});

test('on this host the default probe refuses a PATH that finds the system mise, curl or wget, and allows it behind the barrier', { skip: !['mise', 'curl', 'wget'].some((tool) => existsSync(`/usr/bin/${tool}`)) && 'no mise, curl or wget in /usr/bin' }, async () => {
  const box = await realpath(await mkdtemp(join(tmpdir(), 'mirador-sandbox-barrier-')));
  try {
    const home = join(box, 'home');
    assert.throws(() => assertInstallerSandbox({ HOME: home, PATH: '/usr/bin' }), /^Error: installer sandbox: PATH finds (?:mise|curl|wget) at \/usr\/bin\/(?:mise|curl|wget)/);
    const barrier = await writeNetworkBarrier(join(box, 'barrier'));
    assert.doesNotThrow(() => assertInstallerSandbox({ HOME: home, PATH: `${barrier}:/usr/bin` }));
  } finally {
    await rm(box, { recursive: true, force: true });
  }
});

// The structural check. A file runs an installer when it can start a process (a .ts file importing
// node:child_process, or a shell script) and holds a string literal or shell word that names one as a
// word, alone or in a command line. Such a file must import and call assertInstallerSandbox, outside
// comments. A shell script cannot call it, and none under
// scripts/ runs an installer today, so one that does is simply reported: run it from a guarded test or in
// a container instead. scripts/bootstrap.sh itself runs install.sh, and is what the guard protects; this
// file is skipped too, as its installer names are the planted files below.

const INSTALLER = /(?:^|[\s"'=/])(?:install|bootstrap)\.sh(?=$|[\s"'])/;
const CHILD_PROCESS = /\bfrom\s+['"](?:node:)?child_process['"]|\b(?:require|import)\(\s*['"](?:node:)?child_process['"]\s*\)/;
const GUARD_IMPORT = /\bimport\s*\{[^}]*\bassertInstallerSandbox\b[^}]*\}\s*from\s*['"][^'"]*installer-sandbox(?:\.ts)?['"]/;
const GUARD_CALL = /\bassertInstallerSandbox\s*\(/;

/** A .ts file without its whole-line comments. */
function tsCode(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/** A .ts file's string literals, outside whole-line comments. */
function tsLiterals(text: string): string[] {
  return [...tsCode(text).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A shell script's quoted strings and bare words (which may hold "$var" quoting), outside comments. */
function shellWords(text: string): string[] {
  const code = text
    .split('\n')
    .map((line) => line.replace(/(?:^|\s)#.*$/, ''))
    .join('\n');
  const quoted = [...code.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2]);
  const bare = code.split(/[\s;&|()<>`]+/).filter((word) => word && !/['"]/.test(word.replace(/"\$\{?\w+\}?"/g, '')));
  return [...quoted, ...bare];
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Under `root`: the files that run an installer, and those of them that do not call the guard. */
async function scanInstallerRuns(root: string): Promise<{ runners: string[]; unguarded: string[] }> {
  const files = [...(await walk(join(root, 'test'))).filter((file) => file.endsWith('.ts')), ...(await walk(join(root, 'scripts')))];
  const runners: string[] = [];
  const unguarded: string[] = [];
  for (const file of files) {
    const name = relative(root, file).split('\\').join('/');
    if (name === 'scripts/bootstrap.sh' || name === 'test/installer-sandbox.test.ts') continue;
    const text = await readFile(file, 'utf8');
    if (text.includes('\0')) continue;
    const ts = name.endsWith('.ts');
    const starts = ts ? CHILD_PROCESS.test(text) : text.startsWith('#!') || name.endsWith('.sh');
    if (!starts) continue;
    if (!(ts ? tsLiterals(text) : shellWords(text)).some((value) => INSTALLER.test(value))) continue;
    runners.push(name);
    if (!(ts && GUARD_IMPORT.test(text) && GUARD_CALL.test(tsCode(text)))) unguarded.push(name);
  }
  return { runners: runners.sort(), unguarded: unguarded.sort() };
}

test('every test or script under test/ and scripts/ that runs bootstrap.sh or install.sh calls assertInstallerSandbox', async () => {
  const { runners, unguarded } = await scanInstallerRuns(ROOT);
  assert.deepEqual(unguarded, []);
  for (const file of ['test/bootstrap.test.ts', 'test/install-script.test.ts']) assert.ok(runners.includes(file), `${file} not seen as running an installer: ${runners.join(', ')}`);
});

test('the scan reports a planted file that runs an installer without the guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mirador-sandbox-scan-'));
  try {
    const files: Record<string, string> = {
      'test/planted.test.ts': "import { spawn } from 'node:child_process';\nspawn('./install.sh', [], { env: { HOME: '/nowhere' } });\n",
      'test/nested/copy.test.ts': "import { execFile } from 'node:child_process';\nexecFile(`${dir}/bootstrap.sh`);\n",
      'test/imports-only.test.ts': "import { spawn } from 'node:child_process';\nimport { assertInstallerSandbox } from './helpers/installer-sandbox.ts';\nspawn('install.sh');\n",
      'test/guarded.test.ts': "import { spawn } from 'node:child_process';\nimport { assertInstallerSandbox } from './helpers/installer-sandbox.ts';\nassertInstallerSandbox(env);\nspawn('../scripts/bootstrap.sh', { env });\n",
      'test/mentions.test.ts': "assert.equal(hint, 'install.sh');\n",
      'test/commented.test.ts': "import { spawn } from 'node:child_process';\n// spawn('install.sh')\n",
      'test/notes.md': "import { spawn } from 'node:child_process';\nspawn('install.sh');\n",
      'scripts/run-install.sh': '#!/bin/sh\n"$dir/install.sh" --root x\n',
      'scripts/hooks/pre-thing': '#!/bin/sh\ncd "$1" && ./install.sh\n',
      'scripts/comment.sh': '#!/bin/sh\n# then run ./install.sh by hand\n',
      'scripts/bootstrap.sh': '#!/bin/sh\nexec "$dir/install.sh"\n',
      'test/dq.test.ts': 'import { spawn } from "node:child_process";\nspawn(join(APP_DIR, "install.sh"));\n',
      'test/url.test.ts': "import { spawn } from 'node:child_process';\nconst s = fileURLToPath(new URL('../install.sh', import.meta.url));\nspawn(s);\n",
      'test/ns.test.ts': "import * as cp from 'node:child_process';\ncp.spawn('bootstrap.sh');\n",
      'test/exec-args.test.ts': "import { exec } from 'node:child_process';\nexec('./install.sh --help');\n",
      'test/bash-c.test.ts': "import { spawn } from 'node:child_process';\nspawn('bash', ['-c', 'cd ' + d + ' && ./install.sh --root x']);\n",
      'scripts/unquoted-dir.sh': '#!/bin/sh\nsh "$dir"/install.sh --root x\n',
      'test/commented-call.test.ts': "import { spawn } from 'node:child_process';\nimport { assertInstallerSandbox } from './helpers/installer-sandbox.ts';\n// assertInstallerSandbox(env);\nspawn('install.sh');\n",
    };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(root, name, '..'), { recursive: true });
      await writeFile(join(root, name), text);
    }
    const { runners, unguarded } = await scanInstallerRuns(root);
    assert.deepEqual(unguarded, [
      'scripts/hooks/pre-thing',
      'scripts/run-install.sh',
      'scripts/unquoted-dir.sh',
      'test/bash-c.test.ts',
      'test/commented-call.test.ts',
      'test/dq.test.ts',
      'test/exec-args.test.ts',
      'test/imports-only.test.ts',
      'test/nested/copy.test.ts',
      'test/ns.test.ts',
      'test/planted.test.ts',
      'test/url.test.ts',
    ]);
    assert.deepEqual(runners, [...unguarded, 'test/guarded.test.ts'].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
