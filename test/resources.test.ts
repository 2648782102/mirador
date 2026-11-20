// The resource reader (src/system/resources.ts) against fake /sys and /proc trees in a temp
// directory: never the machine's own cgroups or processes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceSampler, cpuPercent, miradorScope, scopeDir } from '../src/system/resources.ts';

const UID = 1000;
const SERVER_PID = 100;
const AGENT = '034ac4c7-0239-49fc-abd9-779ab4ddf26d';
const SHELL = '11111111-2222-3333-4444-555555555555';
const APP_SLICE = `/user.slice/user-${UID}.slice/user@${UID}.service/app.slice`;
const KB = 1024;

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mirador-resources-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let treeCount = 0;

/** A fresh pair of fake roots: { sys, proc } plus helpers to fill them. */
async function fakeRoots() {
  const base = join(scratch, `tree-${++treeCount}`);
  const roots = { sys: join(base, 'sys'), proc: join(base, 'proc') };
  await mkdir(join(roots.sys, 'fs/cgroup'), { recursive: true });
  await mkdir(roots.proc, { recursive: true });
  return {
    roots,
    async scope(unit: string, files: { memory?: number; swap?: number; peak?: number; usageUsec?: number }) {
      const dir = join(roots.sys, 'fs/cgroup', APP_SLICE, unit);
      await mkdir(dir, { recursive: true });
      if (files.memory !== undefined) await writeFile(join(dir, 'memory.current'), `${files.memory}\n`);
      if (files.swap !== undefined) await writeFile(join(dir, 'memory.swap.current'), `${files.swap}\n`);
      if (files.peak !== undefined) await writeFile(join(dir, 'memory.peak'), `${files.peak}\n`);
      if (files.usageUsec !== undefined) await writeFile(join(dir, 'cpu.stat'), `usage_usec ${files.usageUsec}\nuser_usec 1\nsystem_usec 2\n`);
    },
    async meminfo(text: string) {
      await writeFile(join(roots.proc, 'meminfo'), text);
    },
    async process(pid: number, p: { ppid: number; uid?: number; rssKb?: number; swapKb?: number; ticks?: number; argv?: string[]; cgroup?: string; cwd?: string; env?: Record<string, string> }) {
      const dir = join(roots.proc, String(pid));
      await mkdir(dir, { recursive: true });
      const uid = p.uid ?? UID;
      const lines = [`Name:\tnode`, `PPid:\t${p.ppid}`, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`];
      if (p.rssKb !== undefined) lines.push(`VmRSS:\t${String(p.rssKb).padStart(8)} kB`);
      if (p.swapKb !== undefined) lines.push(`VmSwap:\t${String(p.swapKb).padStart(8)} kB`);
      await writeFile(join(dir, 'status'), lines.join('\n') + '\n');
      // utime (field 14) and stime (field 15) in clock ticks; the name may hold spaces and parentheses.
      const ticks = p.ticks ?? 0;
      await writeFile(join(dir, 'stat'), `${pid} (we ird) name) S ${p.ppid} 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0\n`);
      await writeFile(join(dir, 'cmdline'), (p.argv ?? ['bash']).join('\0') + '\0');
      await writeFile(join(dir, 'cgroup'), `0::${p.cgroup ?? `${APP_SLICE}/other.scope`}\n`);
      await writeFile(join(dir, 'environ'), Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}\0`).join(''));
      if (p.cwd) await symlink(p.cwd, join(dir, 'cwd'));
    },
  };
}

const MEMINFO = 'MemTotal:       24509744 kB\nMemFree:         6129648 kB\nMemAvailable:    8313296 kB\nSwapTotal:      40788072 kB\nSwapFree:        7393404 kB\n';
const agent = (id: string) => ({ id, kind: 'agent' as const, status: 'running' as const });

test('only a mirador-<kind>-<id>.scope leaf is a Mirador cgroup', () => {
  assert.deepEqual(miradorScope(`${APP_SLICE}/mirador-agent-${AGENT}.scope`), { kind: 'agent', id: AGENT });
  assert.deepEqual(miradorScope(`0::${APP_SLICE}/mirador-shell-${SHELL}.scope`), { kind: 'shell', id: SHELL });
  assert.deepEqual(miradorScope(`${APP_SLICE}/mirador-server-4545.scope`), { kind: 'server', id: '4545' });
  assert.deepEqual(miradorScope(`${APP_SLICE}/mirador-git-${SHELL}.scope`), { kind: 'git', id: SHELL });
  assert.equal(miradorScope(`${APP_SLICE}/tmux-spawn-6b0e.scope`), null);
  assert.equal(miradorScope(`${APP_SLICE}/app-mirador-agent-${AGENT}.scope`), null, 'only the whole leaf name counts');
  assert.equal(miradorScope(`${APP_SLICE}/mirador-agent-${AGENT}.scope/child`), null, 'a cgroup below a scope is not the scope');
  assert.equal(miradorScope(`${APP_SLICE}/mirador-other-x.scope`), null, 'unknown kinds are not Mirador');
  assert.equal(miradorScope(''), null);
});

test('CPU % is the CPU time used between two samples over the wall time between them, of one core', () => {
  assert.equal(cpuPercent({ usageUsec: 1_000_000, atMs: 0 }, { usageUsec: 1_500_000, atMs: 5000 }), 10);
  assert.equal(cpuPercent({ usageUsec: 0, atMs: 0 }, { usageUsec: 7_500_000, atMs: 5000 }), 150, 'more than one core goes over 100');
  assert.equal(cpuPercent({ usageUsec: 0, atMs: 0 }, { usageUsec: 1234, atMs: 1000 }), 0.1, 'one decimal');
  assert.equal(cpuPercent(null, { usageUsec: 1, atMs: 1 }), null, 'one sample is not a rate');
  assert.equal(cpuPercent({ usageUsec: 5, atMs: 0 }, null), null);
  assert.equal(cpuPercent({ usageUsec: 5, atMs: 1000 }, { usageUsec: 9, atMs: 1000 }), null, 'no time passed');
  assert.equal(cpuPercent({ usageUsec: 900, atMs: 0 }, { usageUsec: 100, atMs: 1000 }), null, 'a counter that went back (a process of the tree ended) is no rate');
});

test('a terminal in its scope reports the scope memory, swap and peak, and its CPU % from the second sample on', async () => {
  const fake = await fakeRoots();
  await fake.meminfo(MEMINFO);
  await fake.scope(`mirador-agent-${AGENT}.scope`, { memory: 2807791616, swap: 999153664, peak: 3730919424, usageUsec: 10_000_000 });
  let now = 1_000_000;
  const sampler = new ResourceSampler({ roots: fake.roots, uid: UID, serverPid: SERVER_PID, now: () => now });
  assert.equal(scopeDir(fake.roots, UID, `mirador-agent-${AGENT}.scope`), join(fake.roots.sys, 'fs/cgroup', APP_SLICE, `mirador-agent-${AGENT}.scope`));

  const first = await sampler.sample([agent(AGENT)]);
  assert.deepEqual(first.terminals, [{ id: AGENT, kind: 'agent', source: 'scope', memory: 2807791616, swap: 999153664, peak: 3730919424, cpu: null }]);
  assert.equal(first.cpuWindowMs, null);

  now += 5000;
  await fake.scope(`mirador-agent-${AGENT}.scope`, { usageUsec: 10_250_000, memory: 2807791616 });
  const second = await sampler.sample([agent(AGENT)]);
  assert.equal(second.terminals[0].cpu, 5);
  assert.equal(second.cpuWindowMs, 5000);
  assert.equal(second.at, new Date(now).toISOString());
});

test('without a scope, a terminal sums VmRSS and VmSwap over its process tree, found by HERDR_PANE_ID under the server', async () => {
  const fake = await fakeRoots();
  await fake.process(SERVER_PID, { ppid: 1, rssKb: 96 * 1024, swapKb: 27 * 1024 });
  await fake.process(200, { ppid: SERVER_PID, rssKb: 4000, swapKb: 0, ticks: 100, env: { HOME: '/h', HERDR_PANE_ID: AGENT } });
  await fake.process(201, { ppid: 200, rssKb: 300_000, swapKb: 50_000, ticks: 400 });
  await fake.process(202, { ppid: 201, rssKb: 100_000, ticks: 0 });
  await fake.process(300, { ppid: SERVER_PID, rssKb: 9999, env: { HERDR_PANE_ID: SHELL } });
  await fake.process(400, { ppid: 1, rssKb: 77_777 });
  let now = 0;
  const sampler = new ResourceSampler({ roots: fake.roots, uid: UID, serverPid: SERVER_PID, now: () => now });

  const first = await sampler.sample([agent(AGENT)]);
  assert.deepEqual(first.terminals, [{ id: AGENT, kind: 'agent', source: 'tree', memory: 404_000 * KB, swap: 50_000 * KB, peak: null, cpu: null }]);
  assert.deepEqual(first.server, { rss: 96 * 1024 * KB, swap: 27 * 1024 * KB });

  now += 10_000;
  // 100 more clock ticks (1 s at 100 Hz) over 10 s.
  await rm(join(fake.roots.proc, '201'), { recursive: true });
  await fake.process(201, { ppid: 200, rssKb: 300_000, swapKb: 50_000, ticks: 500 });
  const second = await sampler.sample([agent(AGENT)]);
  assert.equal(second.terminals[0].cpu, 10);
});

test('a terminal with neither a scope nor a process, or exited, reports nulls; nothing throws', async () => {
  const fake = await fakeRoots();
  const sampler = new ResourceSampler({ roots: { sys: join(fake.roots.sys, 'missing'), proc: join(fake.roots.proc, 'missing') }, uid: UID, serverPid: SERVER_PID });
  const snapshot = await sampler.sample([agent(AGENT), { id: SHELL, kind: 'shell', status: 'exited' }]);
  const empty = { source: null, memory: null, swap: null, peak: null, cpu: null };
  assert.deepEqual(snapshot.terminals, [{ id: AGENT, kind: 'agent', ...empty }, { id: SHELL, kind: 'shell', ...empty }]);
  assert.deepEqual(snapshot.machine, { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null });
  assert.deepEqual(snapshot.server, { rss: null, swap: null });
  assert.deepEqual(snapshot.outside, { count: 0, memory: 0, swap: 0, processes: [], truncated: false });
});

test('the machine figures come from /proc/meminfo, in bytes', async () => {
  const fake = await fakeRoots();
  await fake.meminfo(MEMINFO);
  const snapshot = await new ResourceSampler({ roots: fake.roots, uid: UID, serverPid: SERVER_PID }).sample([]);
  assert.deepEqual(snapshot.machine, { memTotal: 24509744 * KB, memAvailable: 8313296 * KB, swapTotal: 40788072 * KB, swapFree: 7393404 * KB });
});

const LAUNCHER = ['/home/u/.gentle-shell/runtime/node/bin/node', '/home/u/.gentle-shell/current/node_modules/gentle-pi/bin/gentle-shell.mjs', '-e', 'x'];

test('outside Mirador: gentle-shell launchers of the same user, not in a Mirador scope nor under this server, with cwd and process-tree memory, heaviest first', async () => {
  const fake = await fakeRoots();
  await fake.process(SERVER_PID, { ppid: 1, rssKb: 1000 });
  // tmux holds two launchers in one scope: each counts its own tree.
  await fake.process(500, { ppid: 1, argv: LAUNCHER, cgroup: `${APP_SLICE}/tmux-spawn-6b0e.scope`, cwd: '/work/acme-web', rssKb: 100_000, swapKb: 10_000 });
  await fake.process(501, { ppid: 500, rssKb: 400_000, swapKb: 90_000 });
  await fake.process(510, { ppid: 1, argv: LAUNCHER, cgroup: `${APP_SLICE}/tmux-spawn-6b0e.scope`, cwd: '/work/acme-game', rssKb: 50_000 });
  // A Mirador agent (this or another instance), a launcher under this server, another user's: not outside.
  await fake.process(600, { ppid: 1, argv: LAUNCHER, cgroup: `${APP_SLICE}/mirador-agent-${AGENT}.scope`, rssKb: 999_999 });
  await fake.process(700, { ppid: SERVER_PID, argv: ['bash'], rssKb: 1 });
  await fake.process(701, { ppid: 700, argv: LAUNCHER, cgroup: `${APP_SLICE}/mirador-server-4545.scope`, rssKb: 888_888 });
  await fake.process(702, { ppid: 700, argv: LAUNCHER, cgroup: `${APP_SLICE}/app.scope`, rssKb: 777_777 });
  await fake.process(800, { ppid: 1, uid: 1001, argv: LAUNCHER, rssKb: 666_666 });
  // Not launchers: an editor on the launcher file, a file that merely mentions the name.
  await fake.process(900, { ppid: 1, argv: ['vim', '/home/u/gentle-shell.mjs'], rssKb: 555_555 });
  await fake.process(901, { ppid: 1, argv: ['node', 'notes-gentle-shell.mjs.txt'], rssKb: 444_444 });
  // A launcher started by a launcher is already in its parent's tree.
  await fake.process(502, { ppid: 501, argv: LAUNCHER, cgroup: `${APP_SLICE}/tmux-spawn-6b0e.scope`, rssKb: 0 });

  const snapshot = await new ResourceSampler({ roots: fake.roots, uid: UID, serverPid: SERVER_PID }).sample([]);
  assert.deepEqual(snapshot.outside, {
    count: 2,
    memory: 550_000 * KB,
    swap: 100_000 * KB,
    truncated: false,
    processes: [
      { pid: 500, cwd: '/work/acme-web', memory: 500_000 * KB, swap: 100_000 * KB },
      { pid: 510, cwd: '/work/acme-game', memory: 50_000 * KB, swap: 0 },
    ],
  });
});

test('the outside list is capped: the heaviest are listed, the count and totals cover them all', async () => {
  const fake = await fakeRoots();
  for (let i = 0; i < 5; i++) await fake.process(1000 + i, { ppid: 1, argv: LAUNCHER, rssKb: (i + 1) * 1000 });
  const snapshot = await new ResourceSampler({ roots: fake.roots, uid: UID, serverPid: SERVER_PID, maxOutside: 2 }).sample([]);
  assert.equal(snapshot.outside.count, 5);
  assert.equal(snapshot.outside.memory, 15_000 * KB);
  assert.equal(snapshot.outside.truncated, true);
  assert.deepEqual(snapshot.outside.processes.map((p) => [p.pid, p.cwd]), [[1004, null], [1003, null]]);
});

test('the process scan stops at maxProcesses entries', async () => {
  const fake = await fakeRoots();
  for (let i = 0; i < 4; i++) await fake.process(2000 + i, { ppid: 1, argv: LAUNCHER, rssKb: 1 });
  const snapshot = await new ResourceSampler({ roots: fake.roots, uid: UID, serverPid: SERVER_PID, maxProcesses: 2 }).sample([]);
  assert.equal(snapshot.outside.count, 2);
  assert.equal(snapshot.outside.truncated, true, 'a capped scan may have missed launchers');
});
