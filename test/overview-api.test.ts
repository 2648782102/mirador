// Integration tests for the workspace overview and a folder's "where it left off",
// through the HTTP API of the real server against a temp root and a fake Engram.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SUMMARY = '## Goal\nShip the overview\n## Accomplished\n- route\n## Next Steps\n- folder block\n- review';

let scratch: string;
let root: string;
let server: ChildProcess;
let fakeEngram: Server;
let base: string;
let token: string;

/** What the fake Engram serves, and the requests it received. */
const engram = {
  down: false,
  /** Answer every all-projects read with a full window of entries from 2026-10-28. */
  fullWindow: false,
  hits: [] as string[],
  observations: [] as Array<Record<string, unknown>>,
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

function call(method: string, path: string, body?: unknown, auth = token): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: base, authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get(path: string): Promise<any> {
  const response = await call('GET', path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-overview-')));
  root = join(scratch, 'root');
  for (const dir of ['alpha/.git', 'beta', 'gamma', 'web/shop']) await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(scratch, 'outside'), { recursive: true });

  let n = 0;
  const o = (project: string, type: string, title: string, created_at: string, content = '') => ({ id: ++n, type, title, content, project, created_at, session_id: `s-${project}` });
  engram.observations = [
    o('alpha', 'decision', 'Use SQLite', '2026-10-28 15:00:00'),
    o('alpha', 'session_summary', 'Session summary', '2026-10-27 15:00:00', SUMMARY),
    o('shop', 'bugfix', 'Fixed checkout', '2026-10-25 15:00:00'),
    o('beta', 'manual', 'Wrote the README', '2026-10-20 15:00:00'),
    o('root', 'decision', 'Workspace-wide decision', '2026-10-15 15:00:00'),
    // For the memory health card: an untitled memory, a duplicate, a stray and a Downloads project.
    o('alpha', 'bugfix', '', '2026-10-10 15:00:00', '**What**: Untitled fix\nprivate body text'),
    o('beta', 'manual', 'Wrote the README', '2026-10-10 15:00:00'),
    o('downloads', 'manual', 'Notes from Downloads', '2026-10-01 15:00:00'),
    o('stray', 'manual', 'Lost note', '2026-10-01 15:00:00'),
  ];

  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    engram.hits.push(`${url.pathname}${url.searchParams.has('all_projects') ? '?all_projects' : ''}`);
    res.setHeader('content-type', 'application/json');
    if (engram.down) return void res.writeHead(500).end('{}');
    const cwd = url.searchParams.get('cwd') ?? '';
    if (url.pathname === '/project/current') {
      // Like Engram: a container of several repos has no project of its own.
      if (cwd.endsWith('/web')) return void res.end('{}');
      const name = cwd.split('/').pop();
      return void res.end(JSON.stringify({ project: name, project_source: 'git_remote', project_path: cwd }));
    }
    if (url.pathname === '/projects') {
      return void res.end(JSON.stringify({ projects: [
        { name: 'alpha', observation_count: 2, directories: [join(root, 'alpha')] },
        { name: 'beta', observation_count: 1, directories: null },
        { name: 'shop', observation_count: 1, directories: [join(root, 'web', 'shop')] },
        { name: 'gamma', observation_count: 0, directories: [join(root, 'gamma')] },
        { name: 'root', observation_count: 1, directories: [root] },
        { name: 'downloads', observation_count: 1, directories: [join(homedir(), 'Downloads')] },
        { name: 'stray', observation_count: 1, directories: ['/elsewhere/stray'] },
      ] }));
    }
    if (url.pathname === '/observations/recent') {
      const limit = Number(url.searchParams.get('limit'));
      if (url.searchParams.has('all_projects')) {
        if (!engram.fullWindow) return void res.end(JSON.stringify(engram.observations));
        const window = Array.from({ length: limit }, (_, i) => ({ id: 1000 + i, type: 'decision', title: `busy ${i}`, content: '', project: 'alpha', created_at: '2026-10-28 15:00:00' }));
        return void res.end(JSON.stringify(window));
      }
      const own = engram.observations.filter((entry) => entry.project === url.searchParams.get('project'));
      if (!own.length) return void res.writeHead(404).end(JSON.stringify({ error: 'project not found' }));
      return void res.end(JSON.stringify(own));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => fakeEngram.listen(0, '127.0.0.1', resolve));
  const engramAddress = fakeEngram.address();
  const engramPort = typeof engramAddress === 'object' && engramAddress ? engramAddress.port : 0;

  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(
    join(scratch, 'cfg', 'mirador', 'config.json'),
    JSON.stringify({ root, engramUrl: `http://127.0.0.1:${engramPort}`, timeZone: 'America/Santiago' }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    // The fake Engram's data changes between tests: read it fresh every time.
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0', MIRADOR_ENGRAM_CACHE_MS: '0' },
    stdio: 'ignore',
  });
  let launchSecret: string | undefined;
  const deadline = Date.now() + 8000;
  while (!launchSecret && Date.now() < deadline) {
    launchSecret = await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8').then((t) => JSON.parse(t).launchSecret, () => undefined);
    if (!launchSecret) await new Promise((r) => setTimeout(r, 50));
  }
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  token = ((await session.json()) as { token: string }).token;
});

beforeEach(() => {
  engram.down = false;
  engram.fullWindow = false;
  engram.hits = [];
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  fakeEngram?.closeAllConnections();
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

test('the overview routes need the session token', async () => {
  assert.equal((await call('GET', '/api/overview?ws=dev', undefined, 'made-up')).status, 401);
  assert.equal((await call('GET', '/api/overview/folder?ws=dev&rel=alpha', undefined, 'made-up')).status, 401);
});

test('an unknown workspace answers 404 with its code, and a bad date 400', async () => {
  const missing = await call('GET', '/api/overview?ws=nope');
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { code: string }).code, 'workspace_not_found');
  assert.equal((await call('GET', '/api/overview/folder?ws=nope&rel=alpha')).status, 404);
  assert.equal((await call('GET', '/api/overview?ws=dev&date=28-10-2026')).status, 400);
});

test('without chosen folders the overview covers every first-level folder, newest work first, from two Engram reads', async () => {
  const body = await get('/api/overview?ws=dev&date=2026-10-28');
  assert.deepEqual(body.workspace, { id: 'dev', name: 'Dev' });
  assert.equal(body.date, '2026-10-28');
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.rows.map((r: any) => [r.name, r.rel, r.projects, r.hasMemory, r.lastDay]),
    [
      ['alpha', 'alpha', ['alpha'], true, '2026-10-28'],
      ['web', 'web', ['shop'], true, '2026-10-25'],
      ['beta', 'beta', ['beta'], true, '2026-10-20'],
      ['Dev', '', ['root'], true, '2026-10-15'],
      ['gamma', 'gamma', [], false, null],
    ],
    'the root shows up as the workspace itself because Engram holds memory saved in it',
  );
  const alpha = body.rows[0];
  assert.equal(alpha.isRepo, true);
  assert.deepEqual(alpha.leftOff.summary, { at: '2026-10-27 15:00:00', goal: 'Ship the overview', accomplished: '- route', nextSteps: '- folder block\n- review' });
  assert.deepEqual(alpha.leftOff.memory, { title: 'Use SQLite', type: 'decision', at: '2026-10-28 15:00:00' });
  assert.deepEqual(body.rows[2].leftOff, { summary: null, memory: { title: 'Wrote the README', type: 'manual', at: '2026-10-20 15:00:00' } });
  assert.deepEqual(
    { folders: body.summary.folders, active: body.summary.activeFolders, memories: body.summary.memories, sessions: body.summary.sessions },
    { folders: 5, active: 1, memories: 1, sessions: 1 },
  );
  assert.deepEqual(body.summary.headlines.map((h: any) => [h.title, h.folder, h.rel]), [['Use SQLite', 'alpha', 'alpha']]);
  assert.deepEqual(engram.hits.sort(), ['/observations/recent?all_projects', '/projects'], 'no Engram call per folder');
});

test('with chosen folders the overview covers only those', async () => {
  assert.equal((await call('PATCH', '/api/workspaces/dev', { folders: ['beta', 'web/shop'] })).status, 200);
  try {
    const body = await get('/api/overview?ws=dev&date=2026-10-28');
    assert.deepEqual(body.rows.map((r: any) => [r.name, r.rel, r.projects]), [
      ['web/shop', 'web/shop', ['shop']],
      ['beta', 'beta', ['beta']],
      ['Dev', '', ['root']],
    ]);
  } finally {
    assert.equal((await call('PATCH', '/api/workspaces/dev', { folders: [] })).status, 200);
  }
});

test('the overview says truncated when the Engram window may cut the day off', async () => {
  engram.fullWindow = true;
  const day = await get('/api/overview?ws=dev&date=2026-10-28');
  assert.equal(day.truncated, true);
  const beta = day.rows.find((r: any) => r.name === 'beta');
  assert.deepEqual([beta.hasMemory, beta.lastAt, beta.beyondWindow], [true, null, true], 'older memory lies beyond the window');
  // The window reaches back before the 29th, so that day is complete.
  assert.equal((await get('/api/overview?ws=dev&date=2026-10-29')).truncated, false);
});

test('Engram being down answers 503, like the daily summary', async () => {
  engram.down = true;
  assert.equal((await call('GET', '/api/overview?ws=dev')).status, 503);
  assert.equal((await call('GET', '/api/overview/folder?ws=dev&rel=alpha')).status, 503);
  assert.equal((await call('GET', '/api/summary?ws=dev&rel=alpha')).status, 503);
});

test('a folder says where it left off from its own Engram project', async () => {
  const body = await get('/api/overview/folder?ws=dev&rel=alpha&date=2026-10-28');
  assert.equal(body.cwd, join(root, 'alpha'));
  assert.deepEqual(body.projects, ['alpha']);
  assert.equal(body.truncated, false);
  assert.deepEqual([body.row.name, body.row.rel, body.row.hasMemory, body.row.lastAt], ['alpha', 'alpha', true, '2026-10-28 15:00:00']);
  assert.deepEqual(body.row.leftOff.summary, { at: '2026-10-27 15:00:00', goal: 'Ship the overview', accomplished: '- route', nextSteps: '- folder block\n- review' });
  assert.deepEqual(engram.hits.sort(), ['/observations/recent', '/project/current']);
});

test('a container folder says where its projects left off, and a folder without memory says so', async () => {
  const web = await get('/api/overview/folder?ws=dev&rel=web');
  assert.deepEqual(web.projects, ['shop']);
  assert.deepEqual(web.row.leftOff, { summary: null, memory: { title: 'Fixed checkout', type: 'bugfix', at: '2026-10-25 15:00:00' } });
  const gamma = await get('/api/overview/folder?ws=dev&rel=gamma');
  assert.deepEqual([gamma.row.hasMemory, gamma.row.lastAt, gamma.row.leftOff], [false, null, { summary: null, memory: null }]);
});

test('a folder outside the workspace root is refused', async () => {
  for (const rel of ['../outside', join(scratch, 'outside')]) {
    const response = await call('GET', `/api/overview/folder?ws=dev&rel=${encodeURIComponent(rel)}`);
    assert.equal(response.status, 400, rel);
    assert.equal(((await response.json()) as { code: string }).code, 'folder_invalid');
  }
});

test('memory health needs the session token and answers 503 when Engram is down', async () => {
  assert.equal((await call('GET', '/api/memory/health', undefined, 'made-up')).status, 401);
  engram.down = true;
  assert.equal((await call('GET', '/api/memory/health')).status, 503);
});

test('memory health reports untitled memories, duplicates, stray and suspicious projects, titles only', async () => {
  const body = await get('/api/memory/health');
  assert.deepEqual(Object.keys(body).sort(), ['duplicates', 'projects', 'suspiciousProjects', 'totals', 'unmatchedProjects', 'untitled']);
  assert.deepEqual(body.untitled.map((u: any) => [u.project, u.fallbackTitle, u.type]), [['alpha', 'Untitled fix', 'bugfix']]);
  assert.deepEqual(body.duplicates.map((d: any) => [d.project, d.title, d.copies]), [['beta', 'Wrote the README', 2]]);
  assert.deepEqual(body.suspiciousProjects.map((p: any) => [p.name, p.reason]), [['downloads', 'scratch'], ['root', 'container']]);
  assert.deepEqual(body.unmatchedProjects.map((p: any) => p.name), ['stray']);
  assert.deepEqual(
    { untitled: body.totals.untitled, copies: body.totals.duplicateCopies, unmatched: body.totals.unmatched, suspicious: body.totals.suspicious, inWindow: body.totals.inWindow },
    { untitled: 1, copies: 1, unmatched: 1, suspicious: 2, inWindow: 9 },
  );
  assert.ok(!JSON.stringify(body).includes('private body text'), 'no memory content beyond titles');
  assert.equal(engram.hits.filter((hit) => hit === '/project/current').length, 5, 'one lookup per folder: the root and its four first-level folders');

  engram.hits = [];
  await get('/api/memory/health');
  assert.deepEqual(engram.hits.sort(), ['/observations/recent?all_projects', '/projects'], 'folder lookups are cached between requests');
});

test('a folder whose latest session summary is free form says where it left off with a clipped excerpt', async () => {
  const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`);
  engram.observations.push({ id: 99, type: 'session_summary', title: 'Session summary', content: `Tidied the README.\n${lines.join('\n')}`, project: 'beta', created_at: '2026-10-22 15:00:00', session_id: 's-beta' });
  try {
    const body = await get('/api/overview/folder?ws=dev&rel=beta&date=2026-10-28');
    assert.deepEqual(body.row.leftOff.summary, {
      at: '2026-10-22 15:00:00',
      goal: null,
      accomplished: null,
      nextSteps: null,
      excerpt: `Tidied the README.\n${lines.slice(0, 11).join('\n')}\n…`,
    });
  } finally {
    engram.observations.pop();
  }
});

test('a folder gets its goal and folds whole, since "Dónde quedó" pages them (no "…" on the last page)', async () => {
  const goal = ['1. Make the panel follow the tab.', `2. ${'Keep the tree still. '.repeat(30).trim()}`, '3. Close windows with an ×.'].join('\n');
  const steps = Array.from({ length: 16 }, (_, i) => (i % 2 ? `  - detail ${i}` : `- step ${i}`)).join('\n');
  engram.observations.push({ id: 98, type: 'session_summary', title: 'Session summary', content: `## Goal\n${goal}\n\n## Next Steps\n${steps}\n\n## Accomplished\n- [x] one\n- [x] two`, project: 'beta', created_at: '2026-10-22 15:00:00', session_id: 's-beta' });
  try {
    const body = await get('/api/overview/folder?ws=dev&rel=beta&date=2026-10-28');
    assert.deepEqual(body.row.leftOff.summary, { at: '2026-10-22 15:00:00', goal, accomplished: '- [x] one\n- [x] two', nextSteps: steps });
  } finally {
    engram.observations.pop();
  }
});

