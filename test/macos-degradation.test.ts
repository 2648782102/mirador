// macOS degradation: macOS has no systemd and no cgroups,
// so terminal scopes (the memory limits) are off there without probing, the machine's memory
// comes from `sysctl` and `vm_stat` instead of /proc/meminfo, GET /api/resources says the limits
// are not available, and node-pty's spawn-helper gets its execute bit. Every macOS path runs here
// on Linux through the platform and exec seams; the Linux paths are pinned next to them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../src/http/context.ts';
import { doctor } from '../src/doctor.ts';
import { createResourceRoutes } from '../src/http/routes/resources.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';
import { ensureSpawnHelper } from '../src/system/pty-helper.ts';
import { limitsFor, parseDarwinMemory, readMachineMemory, readerPlatform, ResourceSampler } from '../src/system/resources.ts';
import { decideScopes } from '../src/terminals/scopes.ts';
import { MACOS_SOCKET_PATH_MAX, scratchBase } from './helpers/scratch.ts';

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mirador-macos-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// What an Apple silicon Mac prints (16 KiB pages); the figures are made up but the layout is vm_stat's.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                            400000.
Pages inactive:                          200000.
Pages speculative:                         1000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                           9000.
"Translation faults":                 123456789.
Pages copy-on-write:                    4567890.
Pages zero filled:                     98765432.
Pages reactivated:                       345678.
Pages purged:                             12345.
File-backed pages:                       180000.
Anonymous pages:                         421000.
Pages stored in compressor:              250000.
Pages occupied by compressor:             80000.
Decompressions:                          654321.
Compressions:                           1234567.
Pageins:                                2345678.
Pageouts:                                  3456.
Swapins:                                      0.
Swapouts:                                     0.
`;
// `sysctl -n hw.memsize vm.swapusage`: 16 GiB of RAM, then the swap line.
const SYSCTL = '17179869184\ntotal = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)\n';

const MIB = 1024 * 1024;
const PAGE = 16384;

/** An exec that answers from `answers` by command name and records each call. */
function fakeExec(answers: Record<string, string | null>) {
  const calls: string[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '));
    return answers[file] ?? null;
  };
  return { exec, calls };
}

/** An exec that fails the test if anything calls it. */
const noExec = async (file: string, args: string[]): Promise<string | null> => {
  assert.fail(`exec called on Linux: ${file} ${args.join(' ')}`);
};

/* ---------- Memory: vm_stat and sysctl on macOS, /proc/meminfo on Linux ---------- */

test('parseDarwinMemory: total from hw.memsize, available = (free + inactive + speculative) pages × page size, swap from vm.swapusage', () => {
  assert.deepEqual(parseDarwinMemory(SYSCTL, VM_STAT), {
    memTotal: 17179869184,
    memAvailable: (3000 + 200000 + 1000) * PAGE,
    swapTotal: 2048 * MIB,
    swapFree: 1535.5 * MIB,
  });
});

test('parseDarwinMemory: a figure it cannot read is null, never a guess', () => {
  assert.deepEqual(parseDarwinMemory(null, null), { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null });
  // No page size line: the pages cannot become bytes.
  assert.equal(parseDarwinMemory(SYSCTL, VM_STAT.replace(/^Mach.*\n/, '')).memAvailable, null);
  // One of the three counts missing: no partial sum.
  assert.equal(parseDarwinMemory(SYSCTL, VM_STAT.replace(/^Pages speculative:.*\n/m, '')).memAvailable, null);
  // Only hw.memsize (an old sysctl without vm.swapusage): the swap is unknown, the rest stands.
  assert.deepEqual(parseDarwinMemory('17179869184\n', VM_STAT), { memTotal: 17179869184, memAvailable: 204000 * PAGE, swapTotal: null, swapFree: null });
  assert.equal(parseDarwinMemory('garbage\n', VM_STAT).memTotal, null);
  // Swap in gigabytes and kilobytes is read with its unit.
  assert.deepEqual(parseDarwinMemory('1\ntotal = 1.50G  used = 0.00M  free = 512.00K  (encrypted)\n', VM_STAT), {
    memTotal: 1,
    memAvailable: 204000 * PAGE,
    swapTotal: 1.5 * 1024 * MIB,
    swapFree: 512 * 1024,
  });
});

test('on macOS readMachineMemory asks sysctl and vm_stat, never /proc/meminfo', async () => {
  const proc = join(scratch, 'darwin-proc');
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, 'meminfo'), 'MemTotal: 1 kB\nMemAvailable: 1 kB\n');
  const { exec, calls } = fakeExec({ sysctl: SYSCTL, vm_stat: VM_STAT });
  assert.deepEqual(await readMachineMemory(proc, { platform: 'darwin', exec }), parseDarwinMemory(SYSCTL, VM_STAT));
  assert.deepEqual(calls.sort(), ['sysctl -n hw.memsize vm.swapusage', 'vm_stat']);
});

test('on macOS a sysctl or vm_stat that fails leaves those figures null; it never throws', async () => {
  const { exec } = fakeExec({});
  assert.deepEqual(await readMachineMemory(undefined, { platform: 'darwin', exec }), { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null });
  const throwing = async () => {
    throw new Error('spawn vm_stat ENOENT');
  };
  assert.deepEqual(await readMachineMemory(undefined, { platform: 'darwin', exec: throwing }), { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null });
});

test('on Linux readMachineMemory still reads <proc>/meminfo as before and runs no command', async () => {
  const proc = join(scratch, 'linux-proc');
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, 'meminfo'), 'MemTotal:       24509744 kB\nMemAvailable:    9799928 kB\nSwapTotal: 4 kB\nSwapFree: 2 kB\n');
  assert.deepEqual(await readMachineMemory(proc, { platform: 'linux', exec: noExec }), { memTotal: 24509744 * 1024, memAvailable: 9799928 * 1024, swapTotal: 4096, swapFree: 2048 });
});

test('which reader: an explicit platform wins; else injected /proc and /sys trees mean the Linux reader, also on a macOS host; else the host', () => {
  assert.equal(readerPlatform({ platform: 'darwin', injected: true, host: 'linux' }), 'darwin');
  assert.equal(readerPlatform({ platform: 'linux', injected: false, host: 'darwin' }), 'linux');
  // The tests' fake trees (roots, a proc folder) are Linux layouts: on a Mac they still test the /proc reader.
  assert.equal(readerPlatform({ injected: true, host: 'darwin' }), 'linux');
  assert.equal(readerPlatform({ injected: false, host: 'darwin' }), 'darwin');
  assert.equal(readerPlatform({ injected: false, host: 'linux' }), 'linux');
});

test('the launch gate keeps its rule on macOS: an unreadable vm_stat never blocks, a low one waits', async () => {
  const unreadable = new LaunchGate({
    limits: { batchSize: 10, settleMs: 0, reserveBytes: 1024 ** 4, maxWaitMs: 50, pollMs: 10 },
    readMemory: () => readMachineMemory(undefined, { platform: 'darwin', exec: fakeExec({}).exec }),
  });
  assert.equal(await unreadable.run().next(), 'go');
  const low = new LaunchGate({
    limits: { batchSize: 10, settleMs: 0, reserveBytes: 1024 ** 4, maxWaitMs: 50, pollMs: 10 },
    readMemory: () => readMachineMemory(undefined, { platform: 'darwin', exec: fakeExec({ sysctl: SYSCTL, vm_stat: VM_STAT }).exec }),
  });
  assert.equal(await low.run().next(), 'low_memory');
  unreadable.close();
  low.close();
});

/* ---------- The resource sampler and GET /api/resources ---------- */

test('limitsFor: on macOS the limits are not available, with the reason; elsewhere nothing is added', () => {
  assert.deepEqual(limitsFor('darwin'), { available: false, reason: 'macos' });
  assert.equal(limitsFor('linux'), null);
});

const AGENT = 'a1b2c3d4-0000-4000-8000-000000000001';

function fakeContext(shutdown: Array<() => void>): AppContext {
  return {
    terminals: { list: () => [{ id: AGENT, kind: 'agent', status: 'running' }] },
    onShutdown: (fn: () => void) => shutdown.push(fn),
  } as unknown as AppContext;
}

async function getResources(platform: NodeJS.Platform, exec: (file: string, args: string[]) => Promise<string | null>, roots: { sys: string; proc: string }) {
  const shutdown: Array<() => void> = [];
  const routes = await createResourceRoutes({ roots, uid: 1000, serverPid: 42, platform, exec, schedule: () => () => undefined })(fakeContext(shutdown));
  let status = 0;
  let body = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: unknown) {
      body = String(chunk ?? '');
      return res;
    },
  };
  await routes[0].handler({ req: {} as never, res: res as unknown as ServerResponse, url: new URL('http://127.0.0.1/api/resources'), params: {} });
  shutdown.forEach((fn) => fn());
  return { status, body: JSON.parse(body) };
}

test('on macOS GET /api/resources answers 200 with the vm_stat machine figures and limits { available: false, reason: macos }; per-terminal figures are null', async () => {
  const roots = { sys: join(scratch, 'mac-none/sys'), proc: join(scratch, 'mac-none/proc') };
  const { status, body } = await getResources('darwin', fakeExec({ sysctl: SYSCTL, vm_stat: VM_STAT }).exec, roots);
  assert.equal(status, 200);
  assert.deepEqual(body.limits, { available: false, reason: 'macos' });
  assert.deepEqual(body.machine, parseDarwinMemory(SYSCTL, VM_STAT));
  assert.deepEqual(body.terminals, [{ id: AGENT, kind: 'agent', source: null, memory: null, swap: null, peak: null, cpu: null }]);
});

test('on Linux the sampler still reads the scope cgroup and /proc as before, runs no command and adds no limits key', async () => {
  const uid = 1000;
  const scope = `user.slice/user-${uid}.slice/user@${uid}.service/app.slice/mirador-agent-${AGENT}.scope`;
  const roots = { sys: join(scratch, 'linux-sys'), proc: join(scratch, 'linux-proc2') };
  await mkdir(join(roots.sys, 'fs/cgroup', scope), { recursive: true });
  await mkdir(join(roots.proc, '42'), { recursive: true });
  await writeFile(join(roots.proc, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 100 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n');
  await writeFile(join(roots.proc, '42', 'status'), `Name:\tnode\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t 2048 kB\nVmSwap:\t 0 kB\n`);
  await writeFile(join(roots.sys, 'fs/cgroup', scope, 'memory.current'), '3000\n');
  await writeFile(join(roots.sys, 'fs/cgroup', scope, 'cpu.stat'), 'usage_usec 1000000\n');

  const sampler = new ResourceSampler({ roots, uid, serverPid: 42, platform: 'linux', exec: noExec });
  const sample = await sampler.sample([{ id: AGENT, kind: 'agent', status: 'running' }]);
  assert.deepEqual(sample.machine, { memTotal: 1000 * 1024, memAvailable: 100 * 1024, swapTotal: 2000 * 1024, swapFree: 500 * 1024 });
  assert.deepEqual(sample.terminals, [{ id: AGENT, kind: 'agent', source: 'scope', memory: 3000, swap: null, peak: null, cpu: null }]);
  assert.deepEqual(sample.server, { rss: 2048 * 1024, swap: 0 });

  const { body } = await getResources('linux', noExec, roots);
  assert.equal('limits' in body, false);
  assert.deepEqual(Object.keys(body), ['at', 'sampleMs', 'cpuWindowMs', 'machine', 'server', 'terminals', 'outside']);
});

/* ---------- Terminal scopes ---------- */

test('on macOS scopes are off without probing systemd-run, with one log line that says the limits are not available', async () => {
  let probed = 0;
  const probe = async () => {
    probed++;
    return null;
  };
  assert.deepEqual(await decideScopes({ config: {}, env: {}, probe, platform: 'darwin' }), {
    enabled: false,
    message: 'mirador: terminal scopes off: macOS has no systemd, so terminals run without memory limits (limits not available on macOS)',
  });
  assert.equal(probed, 0);
  // The opt-outs keep their own lines first.
  assert.equal((await decideScopes({ config: {}, env: { MIRADOR_SCOPES: '0' }, probe, platform: 'darwin' })).message, 'mirador: terminal scopes off (MIRADOR_SCOPES=0)');
  // On Linux the probe still decides.
  assert.equal((await decideScopes({ config: {}, env: {}, probe, platform: 'linux' })).enabled, true);
  assert.equal(probed, 1);
});

/* ---------- node-pty's spawn-helper ---------- */

async function fakePty(name: string, mode: number): Promise<{ dir: string; helper: string }> {
  const dir = join(scratch, name);
  const helper = join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  await mkdir(join(dir, 'prebuilds', 'darwin-arm64'), { recursive: true });
  await writeFile(helper, 'binary');
  await chmod(helper, mode);
  return { dir, helper };
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

test('on macOS a spawn-helper shipped without the execute bit (node-pty 1.1.0) gets it, and the server is told in one line', async () => {
  const { dir, helper } = await fakePty('pty-0644', 0o644);
  assert.deepEqual(await ensureSpawnHelper({ platform: 'darwin', arch: 'arm64', ptyDir: dir }), [
    `mirador: made node-pty's spawn-helper executable (prebuilds/darwin-arm64/spawn-helper); without it no terminal starts on macOS (posix_spawnp failed)`,
  ]);
  assert.equal(await modeOf(helper), 0o755);
  // Already executable: nothing to say, nothing changed.
  assert.deepEqual(await ensureSpawnHelper({ platform: 'darwin', arch: 'arm64', ptyDir: dir }), []);
  assert.equal(await readFile(helper, 'utf8'), 'binary');
});

test('on Linux spawn-helper is left alone, and on macOS a missing helper or a chmod that fails never throws', async () => {
  const { dir, helper } = await fakePty('pty-linux', 0o644);
  assert.deepEqual(await ensureSpawnHelper({ platform: 'linux', arch: 'arm64', ptyDir: dir }), []);
  assert.equal(await modeOf(helper), 0o644);
  assert.deepEqual(await ensureSpawnHelper({ platform: 'darwin', arch: 'x64', ptyDir: dir }), []);
  const lines = await ensureSpawnHelper({
    platform: 'darwin',
    arch: 'arm64',
    ptyDir: dir,
    chmod: async () => {
      throw new Error('EROFS: read-only file system');
    },
  });
  assert.deepEqual(lines, [
    `mirador: node-pty's spawn-helper is not executable and could not be fixed (EROFS: read-only file system); terminals will not start on macOS until you run: chmod +x ${helper}`,
  ]);
});

/* ---------- Tests that start a server ---------- */

test('server tests make their scratch under /tmp on macOS, so the deepest socket fits its 104-byte limit; elsewhere under os.tmpdir() as before', () => {
  assert.equal(scratchBase('linux'), tmpdir());
  assert.equal(scratchBase('darwin'), '/tmp');
  // /tmp resolves to /private/tmp; mkdtemp adds six characters; the longest prefix and socket path in use.
  const deepest = `/private/tmp/mirador-open-agents-server-XXXXXX/run/mirador/herdr/socket`;
  assert.ok(Buffer.byteLength(deepest) <= MACOS_SOCKET_PATH_MAX, `${deepest} is ${Buffer.byteLength(deepest)} bytes`);
  // What failed on the macOS runner (listen EINVAL): the same path under macOS's own tmpdir.
  const runner = '/private/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T/mirador-agents-choose-N1qGp9/run/mirador/herdr/socket';
  assert.ok(Buffer.byteLength(runner) > MACOS_SOCKET_PATH_MAX);
});

test("no test, launcher or server code asks date for milliseconds with GNU's %N (BSD date on macOS prints it literally)", async () => {
  // A %3N in date's format is GNU-only: macOS prints a non-number, the herdr stand-in sends seq null, and the
  // attention store drops the report (round 2: hibernate-server and open-agents-server timed out).
  const gnuOnly = new RegExp(['date \\+%s', '%3N'].join(''));
  const found: string[] = [];
  for (const dir of ['test', 'test/helpers', 'bin', 'src', 'src/system', 'src/terminals', 'src/attention']) {
    for (const name of await readdir(new URL(`../${dir}/`, import.meta.url))) {
      const text = await readFile(new URL(`../${dir}/${name}`, import.meta.url), 'utf8').catch(() => '');
      if (gnuOnly.test(text)) found.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(found, []);
});

/* ---------- Doctor ---------- */

test('doctor on macOS says the limits are not available instead of naming a missing systemd; on Linux the systemd line is as before', async () => {
  const env = { PATH: join(scratch, 'empty-path'), HOME: join(scratch, 'doctor-home'), XDG_CONFIG_HOME: join(scratch, 'doctor-cfg'), GENTLE_AI_HOME: join(scratch, 'doctor-gai') };
  const fixed = { nodeVersion: '24.1.0', loadPty: async () => ({}), probeEngram: async () => false, macAppInstalled: async () => true };
  const systemd = (lines: string[]) => lines.find((row) => /^ {2}(ok|missing) +systemd: /.test(row));
  assert.equal(systemd((await doctor({ env, ...fixed, platform: 'darwin' })).lines), '  missing  systemd: not on macOS; terminals run without memory limits (limits not available on macOS)');
  assert.equal(systemd((await doctor({ env, ...fixed, platform: 'linux', kernelRelease: '6.12.0' })).lines), '  missing  systemd: no systemd-run on PATH, no user bus; terminals run without scopes');
});

/* ---------- The window ---------- */

test('the Usage pane says the limits are not available on macOS, in English and Spanish', async () => {
  const strings = (await import('../public/i18n/resources.js')).default as { en: Record<string, string>; es: Record<string, string> };
  assert.equal(strings.en['resources.limits.macos'], 'Limits are not available on macOS: terminals run without memory limits (macOS has no systemd or cgroups). Free memory is read with vm_stat.');
  assert.equal(strings.es['resources.limits.macos'], 'Límites no disponibles en macOS: las terminales corren sin límites de memoria (macOS no tiene systemd ni cgroups). La memoria libre se lee con vm_stat.');
  const source = await readFile(new URL('../public/features/resources.js', import.meta.url), 'utf8');
  assert.match(source, /snapshot\?\.limits\?\.available === false/);
  assert.match(source, /t\('resources\.limits\.macos'\)/);
});
