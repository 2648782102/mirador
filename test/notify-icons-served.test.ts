// The browser notifications' icon and badge come from Mirador's own server, as PNG images.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let scratch: string;
let port: number;
let server: ChildProcess;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitForFile(path: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await readFile(path, 'utf8').catch(() => undefined)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-notify-icons-')));
  await mkdir(join(scratch, 'root'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  port = await freePort();
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, GENTLE_AI_HOME: join(scratch, 'gentle-ai'), HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitForFile(join(scratch, 'run', 'mirador', 'state.json'));
});

after(async () => {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
  await rm(scratch, { recursive: true, force: true });
});

for (const name of ['notify-icon.png', 'notify-badge.png']) {
  test(`GET /${name} serves the PNG under public/ as image/png`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${name}`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const sniff = res.headers.get('x-content-type-options');
    if (sniff !== null) assert.equal(sniff, 'nosniff');
    assert.deepEqual(body.subarray(0, 8), PNG_SIGNATURE, 'a PNG signature');
    assert.ok(body.equals(await readFile(join(APP_DIR, 'public', name))), 'byte-identical to the file in public/');
  });
}
