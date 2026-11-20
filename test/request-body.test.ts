// JSON request bodies: decoded once from bytes and limited by bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let server: ChildProcess;
let port: number;
let base: string;
let launchSecret: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function login(): Promise<string> {
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  return ((await session.json()) as { token: string }).token;
}

/** Sends the body as separate writes, so the server receives them as separate chunks. */
function post(path: string, headers: Record<string, string>, parts: Buffer[]): Promise<{ status: number; body: { error?: string } }> {
  return new Promise((resolve, reject) => {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { ...headers, origin: base, 'content-type': 'application/json', 'content-length': length } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
      },
    );
    req.on('error', reject);
    (async () => {
      for (const part of parts) {
        req.write(part);
        await new Promise((r) => setTimeout(r, 50));
      }
      req.end();
    })();
  });
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-body-')));
  await mkdir(join(scratch, 'root'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  const statePath = join(scratch, 'run', 'mirador', 'state.json');
  const deadline = Date.now() + 8000;
  while (!launchSecret && Date.now() < deadline) {
    launchSecret = await readFile(statePath, 'utf8').then((t) => JSON.parse(t).launchSecret, () => undefined);
    if (!launchSecret) await new Promise((r) => setTimeout(r, 50));
  }
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('a multi-byte character split across two request chunks is decoded intact', async () => {
  const token = await login();
  const body = Buffer.from(JSON.stringify({ ws: 'dev', rel: 'café-missing', kind: 'shell' }));
  const split = body.indexOf(0xc3) + 1; // between the two bytes of "é"
  const response = await post('/api/terminals', { authorization: `Bearer ${token}` }, [body.subarray(0, split), body.subarray(split)]);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'not a folder inside the root: café-missing');
});

test('the body limit counts bytes, not characters', async () => {
  // 40,000 two-byte characters: 80,000 bytes, but only 40,000 UTF-16 code units.
  const body = Buffer.from(JSON.stringify('é'.repeat(40_000)));
  const response = await post('/api/session', {}, [body]);
  assert.equal(response.status, 413);
  assert.equal(response.body.error, 'body too large');
});
