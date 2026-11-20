// The tree's memory tags through the HTTP API of the real server when Engram is slow
// but answers: a project list that arrives after about 1.5 s still tags the folders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENGRAM_DELAY_MS = 1500;

let scratch: string;
let root: string;
let slowEngram: Server;
let engramUrl: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

/** Starts Mirador against the slow Engram with a fresh config, runtime dir and caches. */
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
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-tree-memory-timeout-')));
  root = join(scratch, 'root');
  for (const dir of ['a', 'b']) await mkdir(join(root, dir), { recursive: true });

  slowEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname !== '/projects') return void res.writeHead(404).end('{}');
    setTimeout(() => res.end('{"projects":[{"name":"a","observation_count":3,"directories":null}]}'), ENGRAM_DELAY_MS);
  });
  await new Promise<void>((resolve) => slowEngram.listen(0, '127.0.0.1', resolve));
  const address = slowEngram.address();
  engramUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  slowEngram?.closeAllConnections();
  slowEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

test('an Engram that lists projects after about 1.5 s still tags the tree with memory', async () => {
  const mirador = await startMirador('slow');
  try {
    const response = await mirador.get('/api/tree?ws=dev&rel=');
    assert.equal(response.status, 200, await response.clone().text());
    const nodes = (await response.json()) as Array<{ rel: string; hasMemory: boolean | null }>;
    assert.deepEqual(nodes.map((n) => [n.rel, n.hasMemory]), [['a', true], ['b', false]]);
  } finally {
    await mirador.stop();
  }
});
