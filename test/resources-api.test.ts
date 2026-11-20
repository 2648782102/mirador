// GET /api/resources through its route handlers, with a fake context, a fake clock and
// fake /sys and /proc trees: no server, no real cgroups.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../src/http/context.ts';
import type { Route } from '../src/http/router.ts';
import { SAMPLE_MS, IDLE_MS, createResourceRoutes, resourceRoutes } from '../src/http/routes/resources.ts';

const UID = 1000;
const AGENT = 'a1b2c3d4-0000-4000-8000-000000000001';
const SCOPE = `user.slice/user-${UID}.slice/user@${UID}.service/app.slice/mirador-agent-${AGENT}.scope`;

let scratch: string;
let roots: { sys: string; proc: string };

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mirador-resources-api-'));
  roots = { sys: join(scratch, 'sys'), proc: join(scratch, 'proc') };
  await mkdir(join(roots.sys, 'fs/cgroup', SCOPE), { recursive: true });
  await mkdir(join(roots.proc, '42'), { recursive: true });
  await writeFile(join(roots.proc, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 100 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n');
  await writeFile(join(roots.proc, '42', 'status'), `Name:\tnode\nPPid:\t1\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\nVmRSS:\t 2048 kB\nVmSwap:\t 0 kB\n`);
  await cpu(1_000_000);
  await writeFile(join(roots.sys, 'fs/cgroup', SCOPE, 'memory.current'), '3000\n');
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const cpu = (usec: number) => writeFile(join(roots.sys, 'fs/cgroup', SCOPE, 'cpu.stat'), `usage_usec ${usec}\n`);

function fakeContext(shutdown: Array<() => void>): AppContext {
  return {
    terminals: { list: () => [{ id: AGENT, kind: 'agent', status: 'running' }] },
    onShutdown: (fn: () => void) => shutdown.push(fn),
  } as unknown as AppContext;
}

/** Runs the GET /api/resources handler and returns its status and JSON body. */
async function get(routes: Route[]): Promise<{ status: number; body: any }> {
  const route = routes.find((r) => r.method === 'GET' && r.path === '/api/resources');
  assert.ok(route, 'GET /api/resources is registered');
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
  await route.handler({ req: {} as never, res: res as unknown as ServerResponse, url: new URL('http://127.0.0.1/api/resources'), params: {} });
  return { status, body: JSON.parse(body) };
}

/** A scheduler the test drives: `tick()` runs the pending timer, `cancelled` says whether it stopped. */
function fakeScheduler() {
  const state = { fn: null as null | (() => void), ms: 0, starts: 0, cancelled: 0 };
  return {
    state,
    schedule(fn: () => void, ms: number) {
      state.fn = fn;
      state.ms = ms;
      state.starts++;
      return () => {
        state.cancelled++;
        state.fn = null;
      };
    },
  };
}

test('resourceRoutes is a route module with GET /api/resources only', async () => {
  const shutdown: Array<() => void> = [];
  const routes = await resourceRoutes(fakeContext(shutdown));
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ['GET /api/resources']);
  shutdown.forEach((fn) => fn());
});

test('GET /api/resources answers the documented shape; within SAMPLE_MS it reuses the last sample, after it takes a new one with CPU %', async () => {
  let now = Date.parse('2026-10-29T21:00:00Z');
  const scheduler = fakeScheduler();
  const shutdown: Array<() => void> = [];
  const routes = await createResourceRoutes({ roots, uid: UID, serverPid: 42, now: () => now, schedule: scheduler.schedule })(fakeContext(shutdown));

  const first = await get(routes);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    at: '2026-10-29T21:00:00.000Z',
    sampleMs: SAMPLE_MS,
    cpuWindowMs: null,
    machine: { memTotal: 1000 * 1024, memAvailable: 100 * 1024, swapTotal: 2000 * 1024, swapFree: 500 * 1024 },
    server: { rss: 2048 * 1024, swap: 0 },
    terminals: [{ id: AGENT, kind: 'agent', source: 'scope', memory: 3000, swap: null, peak: null, cpu: null }],
    outside: { count: 0, memory: 0, swap: 0, processes: [], truncated: false },
  });

  now += SAMPLE_MS - 1;
  await cpu(1_500_000);
  assert.equal((await get(routes)).body.at, first.body.at, 'a poll inside the window reads the same sample');

  now += 1;
  const second = await get(routes);
  assert.equal(second.body.at, new Date(now).toISOString());
  assert.equal(second.body.cpuWindowMs, SAMPLE_MS);
  assert.equal(second.body.terminals[0].cpu, 10);
  shutdown.forEach((fn) => fn());
});

test('while a client polls, the sampler keeps sampling every SAMPLE_MS; IDLE_MS after the last poll it stops, and shutdown stops it', async () => {
  let now = 0;
  const scheduler = fakeScheduler();
  const shutdown: Array<() => void> = [];
  const routes = await createResourceRoutes({ roots, uid: UID, serverPid: 42, now: () => now, schedule: scheduler.schedule })(fakeContext(shutdown));
  assert.equal(scheduler.state.starts, 0, 'nothing runs before a client asks');

  await get(routes);
  assert.equal(scheduler.state.starts, 1);
  assert.equal(scheduler.state.ms, SAMPLE_MS);
  await get(routes);
  assert.equal(scheduler.state.starts, 1, 'one sampler however many polls');

  now += SAMPLE_MS;
  scheduler.state.fn!();
  // The tick's sample is what the next poll reads.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await get(routes)).body.at, new Date(now).toISOString());

  now += IDLE_MS + 1;
  scheduler.state.fn!();
  assert.equal(scheduler.state.cancelled, 1, 'no poll for IDLE_MS: the sampler stops');

  await get(routes);
  assert.equal(scheduler.state.starts, 2, 'the next poll starts it again');
  shutdown.forEach((fn) => fn());
  assert.equal(scheduler.state.cancelled, 2, 'shutdown stops it');
});

test('unreadable /sys and /proc answer 200 with null figures, never an error', async () => {
  const shutdown: Array<() => void> = [];
  const missing = { sys: join(scratch, 'none/sys'), proc: join(scratch, 'none/proc') };
  const routes = await createResourceRoutes({ roots: missing, uid: UID, serverPid: 42, schedule: fakeScheduler().schedule })(fakeContext(shutdown));
  const { status, body } = await get(routes);
  assert.equal(status, 200);
  assert.deepEqual(body.machine, { memTotal: null, memAvailable: null, swapTotal: null, swapFree: null });
  assert.deepEqual(body.terminals, [{ id: AGENT, kind: 'agent', source: null, memory: null, swap: null, peak: null, cpu: null }]);
  shutdown.forEach((fn) => fn());
});
