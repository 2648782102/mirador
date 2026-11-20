// The tree, the workspace overview and a container folder's summary through the HTTP
// API of the real server when Engram answers 200 with a body Mirador does not expect
// (Engram encodes empty Go slices as `null`; another service may answer HTML), and
// when Engram never answers at all: the tree must not depend on Engram.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let root: string;
let fakeEngram: Server;
let engramUrl: string;

/** What the fake Engram answers: a JSON body per endpoint, HTML for everything, or nothing at all. */
const engram = {
  mode: 'json' as 'json' | 'html' | 'hang',
  projects: '{"projects":[]}',
  observations: '[]',
  /** All-projects reads received. */
  allProjectReads: 0,
};
const held: ServerResponse[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

/** Starts Mirador against the fake Engram with a fresh config, runtime dir and caches. */
async function startMirador(name: string) {
  const dir = join(scratch, name);
  await mkdir(join(dir, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(dir, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl, timeZone: 'America/Santiago' }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(dir, 'home'), XDG_RUNTIME_DIR: join(dir, 'run'), XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  let launchSecret: string | undefined;
  const deadline = Date.now() + 8000;
  while (!launchSecret && Date.now() < deadline) {
    launchSecret = await readFile(join(dir, 'run', 'mirador', 'state.json'), 'utf8').then((t) => JSON.parse(t).launchSecret, () => undefined);
    if (!launchSecret) await new Promise((r) => setTimeout(r, 50));
  }
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  const token = ((await session.json()) as { token: string }).token;
  return {
    get: (path: string) => fetch(`${base}${path}`, { headers: { origin: base, authorization: `Bearer ${token}` } }),
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-engram-bodies-')));
  root = join(scratch, 'root');
  for (const dir of ['a', 'b', 'web/shop']) await mkdir(join(root, dir), { recursive: true });

  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.searchParams.get('all_projects') === 'true') engram.allProjectReads++;
    if (engram.mode === 'hang') return void held.push(res);
    if (engram.mode === 'html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Not Engram</body></html>');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/project/current') {
      const cwd = url.searchParams.get('cwd') ?? '';
      // Like Engram: a container of several repos has no project of its own.
      if (cwd.endsWith('/web')) return void res.end('{}');
      return void res.end(JSON.stringify({ project: cwd.split('/').pop(), project_source: 'dir_basename', project_path: cwd }));
    }
    if (url.pathname === '/projects') return void res.end(engram.projects);
    if (url.pathname === '/observations/recent' || url.pathname === '/sessions/recent') return void res.end(engram.observations);
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => fakeEngram.listen(0, '127.0.0.1', resolve));
  const address = fakeEngram.address();
  engramUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  for (const res of held) res.destroy();
  fakeEngram?.closeAllConnections();
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

async function json(response: Response): Promise<any> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

const tree = async (mirador: Awaited<ReturnType<typeof startMirador>>) =>
  ((await json(await mirador.get('/api/tree?ws=dev&rel='))) as Array<{ rel: string; hasMemory: boolean | null }>).map((n) => [n.rel, n.hasMemory]);

for (const [label, projects, observations] of [
  ['an empty project list encoded as null', '{"count":0,"projects":null}', 'null'],
  ['a bare array instead of the project list', '[]', '[]'],
]) {
  test(`${label}: the tree, the overview and a container summary still answer`, async () => {
    Object.assign(engram, { mode: 'json', projects, observations });
    const mirador = await startMirador(`list-${projects.length}`);
    try {
      assert.deepEqual(await tree(mirador), [['a', false], ['b', false], ['web', false]]);
      const overview = await json(await mirador.get('/api/overview?ws=dev&date=2026-10-28'));
      assert.deepEqual(overview.rows.map((r: any) => [r.rel, r.projects, r.hasMemory]), [['a', [], false], ['b', [], false], ['web', [], false]]);
      const container = await json(await mirador.get('/api/summary?ws=dev&rel=web&date=2026-10-28'));
      assert.deepEqual(container.group, { projects: [], overview: [] });
      const folder = await json(await mirador.get('/api/summary?ws=dev&rel=a&date=2026-10-28'));
      assert.equal(folder.summary.total, 0, 'a null observation list reads as no entries');
    } finally {
      await mirador.stop();
    }
  });
}

test('a project listed with null directories still marks the folder named like it', async () => {
  Object.assign(engram, { mode: 'json', projects: '{"projects":[{"name":"a","observation_count":3,"directories":null}]}', observations: '[]' });
  const mirador = await startMirador('null-directories');
  try {
    assert.deepEqual(await tree(mirador), [['a', true], ['b', false], ['web', false]]);
    const overview = await json(await mirador.get('/api/overview?ws=dev&date=2026-10-28'));
    assert.deepEqual(overview.rows.find((r: any) => r.rel === 'a').projects, ['a']);
    const container = await json(await mirador.get('/api/summary?ws=dev&rel=web&date=2026-10-28'));
    assert.deepEqual(container.group.projects, []);
  } finally {
    await mirador.stop();
  }
});

test('an HTML answer leaves the tree without memory tags and the summaries unavailable, never a 500', async () => {
  Object.assign(engram, { mode: 'html' });
  const mirador = await startMirador('html');
  try {
    assert.deepEqual(await tree(mirador), [['a', null], ['b', null], ['web', null]]);
    assert.equal((await mirador.get('/api/overview?ws=dev')).status, 503);
    assert.equal((await mirador.get('/api/summary?ws=dev&rel=web')).status, 503);
    assert.equal((await mirador.get('/api/activity')).status, 503);
  } finally {
    await mirador.stop();
  }
});

test('an Engram that never answers slows only the first tree request, and only briefly', async () => {
  Object.assign(engram, { mode: 'hang' });
  const mirador = await startMirador('hang');
  try {
    let started = Date.now();
    assert.deepEqual(await tree(mirador), [['a', null], ['b', null], ['web', null]]);
    const first = Date.now() - started;
    assert.ok(first < 4000, `the memory tags give up after about three seconds (took ${first} ms)`);
    started = Date.now();
    assert.deepEqual(await tree(mirador), [['a', null], ['b', null], ['web', null]]);
    const second = Date.now() - started;
    assert.ok(second < 300, `the failure is remembered for a few seconds (took ${second} ms)`);
  } finally {
    await mirador.stop();
  }
});

test('the overview and the activity view share one all-projects read within a few seconds', async () => {
  Object.assign(engram, { mode: 'json', projects: '{"projects":[]}', observations: '[]', allProjectReads: 0 });
  const mirador = await startMirador('shared-window');
  try {
    await json(await mirador.get('/api/overview?ws=dev&date=2026-10-28'));
    await json(await mirador.get('/api/activity?date=2026-10-28'));
    assert.equal(engram.allProjectReads, 1);
  } finally {
    await mirador.stop();
  }
});
