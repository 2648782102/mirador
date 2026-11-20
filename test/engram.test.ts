import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { DEFAULT_ENGRAM_CACHE_MS, EngramClient, EngramUnavailableError, engramCacheMsFrom } from '../src/memory/engram.ts';

let server: Server;
let baseUrl: string;
/** Entries the fake Engram holds for the project "busy" and across all projects. */
const BUSY_HISTORY = 3000;
/** The body the fake Engram answers GET /projects with (always 200). */
let projectsBody = '{"projects":[]}';
/** All-projects reads the fake Engram received. */
let allProjectReads = 0;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.searchParams.get('all_projects') === 'true') allProjectReads++;
    const project = url.searchParams.get('project');
    if (url.pathname === '/broken') {
      res.writeHead(500).end('boom');
    } else if (url.pathname === '/projects') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(projectsBody);
    } else if (project === 'nil' || url.searchParams.get('cwd') === '/nil') {
      // Engram encodes an empty Go slice (or a missing answer) as null.
      res.writeHead(200, { 'content-type': 'application/json' }).end('null');
    } else if (project === 'unknown') {
      // What engram serve answers for a project it holds no data for.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'project_not_found', error: 'project "unknown" not found', available_projects: ['vigia'] }));
    } else if ((project === 'busy' || url.searchParams.get('all_projects') === 'true') && url.pathname.endsWith('/recent')) {
      // Like engram serve: the newest `limit` entries (20 when missing), no paging.
      const limit = Number(url.searchParams.get('limit')) || 20;
      const entries = Array.from({ length: Math.min(limit, BUSY_HISTORY) }, (_, i) => ({ id: i }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(entries));
    } else if (url.pathname === '/observations/recent') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ id: 1 }]));
    } else if (url.pathname === '/sessions/recent') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ id: 's' }]));
    } else {
      res.writeHead(500).end('unexpected');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

test('a project Engram has no data for reads as empty, not as Engram being down', async () => {
  const engram = new EngramClient(baseUrl);
  assert.deepEqual(await engram.observations('unknown'), []);
  assert.deepEqual(await engram.sessions('unknown'), []);
});

test('known projects still return their data', async () => {
  const engram = new EngramClient(baseUrl);
  assert.deepEqual(await engram.observations('vigia'), [{ id: 1 }]);
  assert.deepEqual(await engram.sessions('vigia'), [{ id: 's' }]);
});

test('summaries read more than the latest 1000 Engram entries', async () => {
  const engram = new EngramClient(baseUrl);
  assert.equal((await engram.observations('busy')).length, BUSY_HISTORY);
  assert.equal((await engram.sessions('busy')).length, BUSY_HISTORY);
  assert.equal((await engram.allObservations()).length, BUSY_HISTORY);
});

test('an unreachable Engram is reported as unavailable', async () => {
  const engram = new EngramClient('http://127.0.0.1:1', 500);
  await assert.rejects(engram.observations('vigia'), EngramUnavailableError);
});

test('a project list that is null or not a list reads as no projects', async () => {
  const engram = new EngramClient(baseUrl);
  for (const body of ['{"count":0,"projects":null}', '[]', '{"projects":{}}', 'null']) {
    projectsBody = body;
    assert.deepEqual(await engram.projects(), [], body);
  }
});

test('project entries keep only what Mirador reads, and entries without a name are skipped', async () => {
  projectsBody = JSON.stringify({ projects: [
    { name: 'a', observation_count: 3, directories: null },
    null,
    { observation_count: 1, directories: ['/x'] },
    { name: 'b', observation_count: '2', directories: ['/srv/b', 7] },
  ] });
  assert.deepEqual(await new EngramClient(baseUrl).projects(), [
    { name: 'a', observation_count: 3, directories: null },
    { name: 'b', directories: ['/srv/b'] },
  ]);
});

test('a 200 answer that is not JSON reads as Engram being unavailable', async () => {
  projectsBody = '<html><body>Not Engram</body></html>';
  await assert.rejects(new EngramClient(baseUrl).projects(), EngramUnavailableError);
});

test('null lists and a null project answer read as empty', async () => {
  const engram = new EngramClient(baseUrl);
  assert.deepEqual(await engram.observations('nil'), []);
  assert.deepEqual(await engram.sessions('nil'), []);
  assert.equal(await engram.projectFor('/nil'), null);
});

test('the all-projects window is read once for every caller within a few seconds', async () => {
  let now = 1_000_000;
  const engram = new EngramClient(baseUrl, 4000, { cacheMs: 3000, now: () => now });
  allProjectReads = 0;
  const [first, second] = await Promise.all([engram.allObservations(), engram.allObservations()]);
  assert.equal(first.length, BUSY_HISTORY);
  assert.deepEqual(second, first);
  now += 2000;
  await engram.allObservations();
  assert.equal(allProjectReads, 1, 'concurrent and later calls within the TTL share one read');
  now += 1500;
  await engram.allObservations();
  assert.equal(allProjectReads, 2, 'after the TTL Engram is read again');
});

test('with the default TTL (20 s) a tracking poll every 15 s reads Engram once per window', async () => {
  assert.equal(DEFAULT_ENGRAM_CACHE_MS, 20_000);
  let now = 5_000_000;
  const engram = new EngramClient(baseUrl, 4000, { cacheMs: DEFAULT_ENGRAM_CACHE_MS, now: () => now });
  allProjectReads = 0;
  const first = await engram.allObservations();
  now += 15_000;
  assert.equal(await engram.allObservations(), first, 'the same window object within the TTL');
  now += 4_999;
  await engram.allObservations();
  assert.equal(allProjectReads, 1, 'one read for every call inside the window');
  now += 1;
  const second = await engram.allObservations();
  assert.equal(allProjectReads, 2, 'the window expires at exactly the TTL');
  assert.notEqual(second, first, 'a new window is a new object');
});

test('the window TTL comes from MIRADOR_ENGRAM_CACHE_MS, then the engramCacheMs option, then 20 s', () => {
  assert.equal(engramCacheMsFrom({}, undefined), 20_000);
  assert.equal(engramCacheMsFrom({}, 60_000), 60_000);
  assert.equal(engramCacheMsFrom({ MIRADOR_ENGRAM_CACHE_MS: '0' }, 60_000), 0, 'the environment wins (tests set 0)');
  assert.equal(engramCacheMsFrom({ MIRADOR_ENGRAM_CACHE_MS: '' }, 10_000), 10_000);
  assert.equal(engramCacheMsFrom({ MIRADOR_ENGRAM_CACHE_MS: 'soon' }, undefined), 20_000);
  for (const bad of [-1, Number.NaN, Infinity, '30000', null]) assert.equal(engramCacheMsFrom({}, bad), 20_000, String(bad));
});

test('a failed all-projects read is not remembered', async () => {
  let fail = true;
  const engram = new EngramClient(baseUrl, 4000, { cacheMs: 3000 });
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => (fail ? Promise.reject(new Error('refused')) : real(...args))) as typeof fetch;
  try {
    await assert.rejects(engram.allObservations(), EngramUnavailableError);
    fail = false;
    assert.equal((await engram.allObservations()).length, BUSY_HISTORY);
  } finally {
    globalThis.fetch = real;
  }
});

/** A fake Engram that accepts writes: POST /sessions, then POST /observations with that session. */
async function writableEngram(options: { sessionStatus?: number; observationStatus?: () => number } = {}) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const sessions = new Set<string>();
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    requests.push({ method: req.method ?? '', path, body });
    const send = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'POST' && path === '/sessions') {
      if (options.sessionStatus && options.sessionStatus !== 200) return send(options.sessionStatus, { code: 'session_project_mismatch', error: 'no' });
      if (!body.directory) return send(400, { error: 'directory is required' });
      sessions.add(String(body.id));
      return send(200, { id: body.id, status: 'created' });
    }
    if (req.method === 'POST' && path === '/observations') {
      const status = options.observationStatus?.() ?? 200;
      if (status !== 200) return send(status, { code: 'session_not_found', error: 'session not found' });
      if (!sessions.has(String(body.session_id))) return send(404, { code: 'session_not_found', error: 'session not found' });
      return send(200, { id: 77, status: 'saved' });
    }
    send(404, { error: 'unexpected' });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const address = fake.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { url, requests, close: () => new Promise((resolve) => fake.close(resolve)) };
}

test('saveObservation registers one session for the project, then saves with its topic key', async () => {
  const fake = await writableEngram();
  try {
    const engram = new EngramClient(fake.url);
    const input = { project: 'mirador-night', topicKey: 'night-feedback/dev/r1', title: 'Night feedback', content: 'The user marked it wrong.', type: 'preference', directory: '/state/mirador-night' };
    assert.deepEqual(await engram.saveObservation(input), { id: 77 });
    await engram.saveObservation({ ...input, topicKey: 'night-feedback/dev/r2' });
    const sessions = fake.requests.filter((r) => r.path === '/sessions');
    assert.equal(sessions.length, 1, 'the session is registered once');
    assert.equal(sessions[0].body.project, 'mirador-night');
    assert.equal(sessions[0].body.directory, '/state/mirador-night');
    assert.match(String(sessions[0].body.id), /^mirador-night-/);
    const saves = fake.requests.filter((r) => r.path === '/observations');
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[0].body, {
      session_id: sessions[0].body.id,
      title: 'Night feedback',
      content: 'The user marked it wrong.',
      type: 'preference',
      project: 'mirador-night',
      scope: 'project',
      topic_key: 'night-feedback/dev/r1',
    });
  } finally {
    await fake.close();
  }
});

test('a session Engram forgot is registered again once; other failures are EngramUnavailableError without the content', async () => {
  let failures = 1;
  const fake = await writableEngram({ observationStatus: () => (failures-- > 0 ? 404 : 200) });
  try {
    const engram = new EngramClient(fake.url);
    const input = { project: 'p', topicKey: 'k', title: 't', content: 'PRIVATE-CONTENT', type: 'preference', directory: '/d' };
    assert.deepEqual(await engram.saveObservation(input), { id: 77 });
    assert.equal(fake.requests.filter((r) => r.path === '/sessions').length, 2);
  } finally {
    await fake.close();
  }
  const refused = await writableEngram({ sessionStatus: 409 });
  try {
    const engram = new EngramClient(refused.url);
    await assert.rejects(engram.saveObservation({ project: 'p', topicKey: 'k', title: 't', content: 'PRIVATE-CONTENT', type: 'preference', directory: '/d' }), (error: unknown) => {
      assert.ok(error instanceof EngramUnavailableError);
      assert.equal(error.status, 409);
      assert.ok(!error.message.includes('PRIVATE-CONTENT'));
      return true;
    });
  } finally {
    await refused.close();
  }
  await assert.rejects(new EngramClient('http://127.0.0.1:1', 500).saveObservation({ project: 'p', topicKey: 'k', title: 't', content: 'c', type: 'preference', directory: '/d' }), EngramUnavailableError);
});

test('saveObservation validates its input before any request', async () => {
  const engram = new EngramClient('http://127.0.0.1:1', 500);
  for (const bad of [
    { project: '', topicKey: 'k', title: 't', content: 'c', type: 'preference', directory: '/d' },
    { project: 'p', topicKey: '', title: 't', content: 'c', type: 'preference', directory: '/d' },
    { project: 'p', topicKey: 'k', title: '', content: 'c', type: 'preference', directory: '/d' },
    { project: 'p', topicKey: 'k', title: 't', content: '', type: 'preference', directory: '/d' },
    { project: 'p', topicKey: 'k', title: 't', content: 'c', type: 'preference', directory: 'relative' },
    { project: 'p', topicKey: 'k', title: 't', content: 'x'.repeat(20_001), type: 'preference', directory: '/d' },
  ]) {
    await assert.rejects(engram.saveObservation(bad), TypeError, JSON.stringify(bad).slice(0, 80));
  }
});
