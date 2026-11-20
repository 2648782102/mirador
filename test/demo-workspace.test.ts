// scripts/demo-workspace.sh builds the invented workspace the
// README screenshots are taken from: three fake git projects, a Mirador config that points only
// at them, and the command that starts the server with a HOME and XDG folders inside the target,
// so the user's real config, Engram and projects are never read or written. Every run gets a
// scratch HOME and TMPDIR beside its target; the scratch folder is removed after the tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/demo-workspace.sh', import.meta.url));
const PROJECTS = ['acme-api', 'acme-web', 'field-notes'];

let scratch: string;
let boxes = 0;

interface Box {
  dir: string;
  home: string;
  tmp: string;
  target: string;
  env: NodeJS.ProcessEnv;
}

/** A scratch HOME and TMPDIR, and a target folder that does not exist yet, side by side. */
async function box(): Promise<Box> {
  const dir = join(scratch, `box-${++boxes}`);
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  return { dir, home, tmp, target: join(dir, 'target'), env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp } };
}

function run(b: Box, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, ...args], { cwd: b.dir, env: b.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('demo-workspace.sh did not finish'));
    }, 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function git(cwd: string, args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }, (error, stdout, stderr) =>
      error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(stdout),
    );
  });
}

/** The `NAME='value'` assignments of the printed start command, and the command itself. */
function startCommand(stdout: string): { vars: Record<string, string>; line: string } {
  const line = stdout.split('\n').find((l) => l.includes('node src/server.ts'));
  assert.ok(line, `no start command in:\n${stdout}`);
  const vars = Object.fromEntries([...line.matchAll(/([A-Z_]+)='([^']*)'/g)].map((m) => [m[1], m[2]]));
  return { vars, line };
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-demo-workspace-')));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test('it creates the three demo projects, each a git repository with a README and one commit', async () => {
  const b = await box();
  const result = await run(b, [b.target]);
  assert.equal(result.code, 0, result.stderr);
  for (const name of PROJECTS) {
    const project = join(b.target, 'workspace', name);
    assert.ok((await stat(join(project, 'README.md'))).isFile(), `${name} has no README.md`);
    assert.equal((await git(project, ['rev-list', '--count', 'HEAD'], b.home)).trim(), '1', `${name} does not have exactly one commit`);
    assert.equal((await git(project, ['status', '--porcelain'], b.home)).trim(), '', `${name} has uncommitted files`);
  }
});

test('it writes a Mirador config whose only workspace is the demo folder and whose Engram is not the default one', async () => {
  const b = await box();
  const result = await run(b, [b.target]);
  assert.equal(result.code, 0, result.stderr);
  const { vars } = startCommand(result.stdout);
  const config = JSON.parse(await readFile(join(vars.XDG_CONFIG_HOME, 'mirador', 'config.json'), 'utf8'));
  assert.deepEqual(
    config.workspaces.map((w: { root: string }) => w.root),
    [join(b.target, 'workspace')],
  );
  assert.notEqual(config.engramUrl, 'http://127.0.0.1:7437', 'the demo config must never reach the real Engram');
  assert.ok(inside(config.agentCommand, b.target), `agentCommand ${config.agentCommand} is outside the target`);
});

test('it prints the start command with HOME and every XDG folder inside the target', async () => {
  const b = await box();
  const result = await run(b, [b.target]);
  assert.equal(result.code, 0, result.stderr);
  const { vars, line } = startCommand(result.stdout);
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
    assert.ok(vars[key] && inside(vars[key], b.target), `${key}=${vars[key]} is not inside ${b.target}`);
  }
  assert.equal(vars.MIRADOR_SCOPES, '0');
  assert.ok(line.trimEnd().endsWith('node src/server.ts'), line);
});

test('it exits 0 and writes nothing outside the target folder', async () => {
  const b = await box();
  const result = await run(b, [b.target]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await readdir(b.dir)).sort(), ['home', 'target', 'tmp']);
  assert.deepEqual(await readdir(b.home), [], 'wrote into the scratch HOME');
  assert.deepEqual(await readdir(b.tmp), [], 'wrote into the scratch TMPDIR');
});

test('an unknown option prints the usage and exits non-zero without creating anything', async () => {
  const b = await box();
  const result = await run(b, ['--bogus', b.target]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /^usage: scripts\/demo-workspace\.sh /m);
  assert.deepEqual((await readdir(b.dir)).sort(), ['home', 'tmp']);
});

// The demo agent's attention reports carry a seq in
// milliseconds, near the clock, on macOS too: BSD date has no %N and prints "3N" for %3N, which made
// the seq a non-number there. The stand-in date below behaves like BSD date.
async function bsdDate(dir: string, name: string): Promise<string> {
  const real = await new Promise<string>((resolve, reject) =>
    execFile('sh', ['-c', 'command -v date'], { env: { PATH: process.env.PATH } }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
  );
  const bin = join(dir, name);
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'date'), `#!/bin/sh\n# Like BSD date: no %N, so %3N comes out as a literal 3N.\ncase "$1" in +*) set -- "$(printf '%s' "$1" | sed 's/%3N/3N/g; s/%N/N/g')" ;; esac\nexec '${real}' "$@"\n`);
  await chmod(join(bin, 'date'), 0o755);
  return bin;
}

/** Runs the demo agent in field-notes (two reports, then it idles) with `path`, and returns the seq of each report. */
async function demoSeqs(b: Box, bin: string, path: string): Promise<{ seqs: string[]; start: number; end: number }> {
  const log = join(b.dir, `herdr-${basename(bin)}.log`);
  await writeFile(join(bin, 'herdr'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  await chmod(join(bin, 'herdr'), 0o755);
  const start = Date.now();
  // Its own process group, so the idle sleep dies with it.
  const agent = spawn('bash', [join(b.target, 'bin', 'demo-agent')], {
    cwd: join(b.target, 'workspace', 'field-notes'),
    env: { PATH: path, HOME: b.home, TMPDIR: b.tmp, HERDR_BIN_PATH: join(bin, 'herdr'), HERDR_PANE_ID: 'pane-1' },
    stdio: 'ignore',
    detached: true,
  });
  let lines: string[] = [];
  try {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline && lines.length < 2; await new Promise((r) => setTimeout(r, 100))) {
      lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    }
  } finally {
    process.kill(-agent.pid!, 'SIGKILL');
  }
  assert.equal(lines.length, 2, `reports: ${JSON.stringify(lines)}`);
  return { seqs: lines.map((line) => line.match(/ --seq (\S+) /)?.[1] ?? ''), start, end: Date.now() };
}

test('with BSD date (macOS) the demo agent still reports a numeric seq in ms, near the clock, rising by one', async () => {
  const b = await box();
  const result = await run(b, [b.target]);
  assert.equal(result.code, 0, result.stderr);
  const bin = await bsdDate(b.dir, 'bsd-bin');
  const { seqs, start, end } = await demoSeqs(b, bin, `${bin}:${process.env.PATH}`);
  for (const seq of seqs) assert.match(seq, /^\d+$/, `seq ${seq}`);
  const [first, second] = seqs.map(Number);
  assert.ok(first >= start && first <= end, `seq ${first} is not the clock in ms (${start}..${end})`);
  assert.equal(second, first + 1);
});

test('without node on PATH the demo agent falls back to whole seconds in ms, still numeric and rising by one', async () => {
  const b = await box();
  const result = await run(b, [b.target]);
  assert.equal(result.code, 0, result.stderr);
  const bin = await bsdDate(b.dir, 'bsd-no-node');
  // Only what the agent and the stand-ins run: no node.
  for (const tool of ['bash', 'sh', 'basename', 'sleep', 'sed']) {
    const real = await new Promise<string>((resolve, reject) =>
      execFile('sh', ['-c', `command -v ${tool}`], { env: { PATH: process.env.PATH } }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
    );
    await symlink(real, join(bin, tool));
  }
  const { seqs, start, end } = await demoSeqs(b, bin, bin);
  for (const seq of seqs) assert.match(seq, /^\d+$/, `seq ${seq}`);
  const [first, second] = seqs.map(Number);
  // Each report adds one before it is sent: the first is whole seconds in ms, plus one.
  assert.equal(first % 1000, 1, `seq ${first}`);
  assert.ok(first > Math.floor(start / 1000) * 1000 && first <= end, `seq ${first} is not the clock in whole seconds (${start}..${end})`);
  assert.equal(second, first + 1);
});

test("no script under scripts/ asks date for milliseconds with GNU's %3N (BSD date on macOS prints it literally)", async () => {
  const gnuOnly = new RegExp(['date \\+%s', '%3N'].join(''));
  const dir = fileURLToPath(new URL('../scripts/', import.meta.url));
  const found: string[] = [];
  for (const name of await readdir(dir)) if (gnuOnly.test(await readFile(join(dir, name), 'utf8').catch(() => ''))) found.push(`scripts/${name}`);
  assert.deepEqual(found, []);
});
