// "Traer a Mirador": a project seen only through its
// Engram memories maps to a workspace folder, or says why it cannot. The pure rule first, then
// GET /api/activity/adopt through the real server against temp workspaces and a fake Engram.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptPlace } from '../src/memory/outside.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACES = [
  { id: 'dev', root: '/home/m/Dev' },
  { id: 'tools', root: '/home/m/Dev/tools' },
  { id: 'web', root: '/srv/web/' },
];

test('a directory inside a workspace maps to that workspace and its relative folder', () => {
  assert.deepEqual(adoptPlace(['/home/m/Dev/vigia/'], WORKSPACES), { ws: 'dev', rel: 'vigia' });
  assert.deepEqual(adoptPlace(['/srv/web'], WORKSPACES), { ws: 'web', rel: '' });
});

test('no known directory, or none inside a workspace, gives the reason instead', () => {
  assert.deepEqual(adoptPlace(null, WORKSPACES), { reason: 'no_directory' });
  assert.deepEqual(adoptPlace([], WORKSPACES), { reason: 'no_directory' });
  assert.deepEqual(adoptPlace(['/home/m/Downloads/x', '/home/m/Devices'], WORKSPACES), { reason: 'outside_workspaces' });
});

test('with several directories the first one inside a workspace wins', () => {
  assert.deepEqual(adoptPlace(['/opt/x', '/srv/web/shop', '/home/m/Dev/vigia'], WORKSPACES), { ws: 'web', rel: 'shop' });
});

test('when nested workspace roots both contain it, the deepest root wins', () => {
  assert.deepEqual(adoptPlace(['/home/m/Dev/tools/mirador'], WORKSPACES), { ws: 'tools', rel: 'mirador' });
  assert.deepEqual(adoptPlace(['/home/m/Dev/tools/mirador'], [...WORKSPACES].reverse()), { ws: 'tools', rel: 'mirador' });
});

test('a directory that climbs out with .. or is not absolute is never inside a workspace', () => {
  assert.deepEqual(adoptPlace(['/home/m/Dev/vigia/../../../etc'], WORKSPACES), { reason: 'outside_workspaces' });
  assert.deepEqual(adoptPlace(['home/m/Dev/vigia'], WORKSPACES), { reason: 'outside_workspaces' });
  assert.deepEqual(adoptPlace(['/home/m/Dev/../Dev/vigia', '/home/m/Dev/ok'], WORKSPACES), { ws: 'dev', rel: 'ok' });
});

/* ---------- GET /api/activity/adopt ---------- */

const LONG_STEPS = Array.from({ length: 400 }, (_, i) => `- step ${i} with some words`).join('\n');

let scratch: string;
let dev: string;
let server: ChildProcess;
let fakeEngram: Server;
let base: string;
let token: string;

function call(method: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}` } });
}

async function adopt(project: string): Promise<any> {
  const response = await call('GET', `/api/activity/adopt?project=${encodeURIComponent(project)}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-adopt-')));
  dev = join(scratch, 'dev');
  for (const dir of ['alpha', 'long', 'tools/mirador']) await mkdir(join(dev, dir), { recursive: true });
  await mkdir(join(scratch, 'outside'), { recursive: true });
  // Inside the root by name, outside it once followed.
  await symlink(join(scratch, 'outside'), join(dev, 'link'));
  // Inside the root and resolving inside it; a sibling folder whose name starts like the root.
  await symlink(join(dev, 'alpha'), join(dev, 'linkin'));
  await mkdir(join(scratch, 'dev-other', 'x'), { recursive: true });
  // A workspace whose root a test moves away while the server runs.
  await mkdir(join(scratch, 'ghost', 'proj'), { recursive: true });

  let n = 0;
  const o = (project: string, type: string, created_at: string, content = '') => ({ id: ++n, type, title: `${type} ${n}`, content, project, created_at, session_id: 's' });
  const observations = [
    o('alpha', 'decision', '2026-10-29 12:00:00'),
    o('alpha', 'session_summary', '2026-10-29 11:00:00', '## Goal\nShip it\n## Next Steps\n- write the route\n- run the tests'),
    o('alpha', 'session_summary', '2026-10-28 11:00:00', '## Next Steps\n- an older plan'),
    o('mirador', 'decision', '2026-10-29 12:00:00'),
    o('long', 'session_summary', '2026-10-29 12:00:00', `## Next Steps\n${LONG_STEPS}`),
  ];
  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/projects') {
      return void res.end(JSON.stringify({ projects: [
        { name: 'alpha', observation_count: 3, directories: [join(dev, 'alpha')] },
        { name: 'mirador', observation_count: 1, directories: ['/elsewhere/mirador', join(dev, 'tools', 'mirador'), join(dev, 'alpha')] },
        { name: 'long', observation_count: 1, directories: [join(dev, 'long')] },
        { name: 'nodir', observation_count: 1, directories: null },
        { name: 'stray', observation_count: 1, directories: ['/elsewhere/stray'] },
        { name: 'escape', observation_count: 1, directories: [join(dev, 'link')] },
        { name: 'linkin', observation_count: 1, directories: [join(dev, 'linkin')] },
        { name: 'gone', observation_count: 1, directories: [join(dev, 'gone')] },
        { name: 'ghost', observation_count: 1, directories: [join(scratch, 'ghost', 'proj')] },
        { name: 'sibling', observation_count: 1, directories: [`${dev}-other/x`] },
        { name: 'wsroot', observation_count: 1, directories: [dev] },
      ] }));
    }
    if (url.pathname === '/observations/recent') {
      const all = url.searchParams.has('all_projects');
      const own = observations.filter((entry) => all || entry.project === url.searchParams.get('project'));
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
    JSON.stringify({
      workspaces: [
        { id: 'dev', name: 'Dev', root: dev, folders: [], expanded: [] },
        { id: 'tools', name: 'Tools', root: join(dev, 'tools'), folders: [], expanded: [] },
        { id: 'ghost', name: 'Ghost', root: join(scratch, 'ghost'), folders: [], expanded: [] },
      ],
      engramUrl: `http://127.0.0.1:${engramPort}`,
      timeZone: 'America/Santiago',
    }),
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
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
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  fakeEngram?.closeAllConnections();
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

test('an adoptable project answers its workspace folder and the Next Steps of its latest session summary', async () => {
  assert.deepEqual(await adopt('alpha'), { project: 'alpha', ws: 'dev', rel: 'alpha', workspace: 'Dev', nextSteps: '- write the route\n- run the tests' });
  assert.deepEqual(
    await adopt('mirador'),
    { project: 'mirador', ws: 'tools', rel: 'mirador', workspace: 'Tools', nextSteps: null },
    'the first directory inside a workspace, under the deepest root; no session summary means no Next Steps',
  );
});

test('long Next Steps are clipped so the instruction stays within 2000 characters', async () => {
  const { nextSteps } = await adopt('long');
  assert.ok(nextSteps.length <= 1900, `clipped to ${nextSteps.length}`);
  assert.ok(nextSteps.startsWith('- step 0 with some words\n'));
  assert.ok(nextSteps.endsWith('…'));
});

test('a project that cannot be adopted answers only why', async () => {
  assert.deepEqual(await adopt('nodir'), { project: 'nodir', reason: 'no_directory' });
  assert.deepEqual(await adopt('unknown'), { project: 'unknown', reason: 'no_directory' });
  assert.deepEqual(await adopt('stray'), { project: 'stray', reason: 'outside_workspaces' });
  assert.deepEqual(await adopt('escape'), { project: 'escape', reason: 'outside_workspaces' }, 'a symlink out of the root never becomes a folder to open');
});

test('a symlink inside the root resolves to its real folder; a sibling-prefix folder is outside; the root itself maps to ""', async () => {
  assert.deepEqual(await adopt('linkin'), { project: 'linkin', ws: 'dev', rel: 'alpha', workspace: 'Dev', nextSteps: null });
  assert.deepEqual(await adopt('sibling'), { project: 'sibling', reason: 'outside_workspaces' });
  assert.deepEqual(await adopt('wsroot'), { project: 'wsroot', ws: 'dev', rel: '', workspace: 'Dev', nextSteps: null });
});

test('a folder that no longer exists answers folder_missing, also when its whole workspace root is gone', async () => {
  assert.deepEqual(await adopt('gone'), { project: 'gone', reason: 'folder_missing' });
  await rename(join(scratch, 'ghost'), join(scratch, 'ghost-moved'));
  try {
    assert.deepEqual(await adopt('ghost'), { project: 'ghost', reason: 'folder_missing' });
  } finally {
    await rename(join(scratch, 'ghost-moved'), join(scratch, 'ghost'));
  }
});

test('path-like project names are literal names, never paths', async () => {
  for (const name of ['../', '/', 'alpha/../long', 'añō 日本']) assert.deepEqual(await adopt(name), { project: name, reason: 'no_directory' });
  assert.equal((await call('POST', '/api/activity/adopt?project=alpha')).status, 404);
});

test('the project parameter is required, once, as short printable text', async () => {
  for (const query of ['', '?project=', '?project=a&project=b', `?project=${'x'.repeat(201)}`, '?project=a%0Ab']) {
    const response = await call('GET', `/api/activity/adopt${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(((await response.json()) as { code: string }).code, 'adopt_invalid');
  }
});

test('GET /api/activity keeps its fields', async () => {
  const response = await call('GET', '/api/activity?date=2026-10-29');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { projects: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(body).sort(), ['date', 'hours', 'projects', 'truncated']);
  assert.deepEqual(body.projects.map((p) => Object.keys(p).sort()), body.projects.map(() => ['count', 'lastAt', 'project', 'titles']));
});
