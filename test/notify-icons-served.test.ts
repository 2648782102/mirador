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
const LISTENING = /^Mirador listening on http:\/\/127\.0\.0\.1:(\d+) /m;

let scratch: string;
let port: number;
let server: ChildProcess | undefined;

/** A port free right now. Another process can take it before the server binds it, so the caller retries. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const picked = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return picked;
}

/**
 * Starts src/server.ts on `chosen` and resolves once it prints its listening line, which it prints only
 * after the bind, so it accepts connections. Rejects with the server's output when it exits first.
 * The port is a fixed one, not 0, because the server checks the Host header against its configured port.
 */
async function startServer(chosen: number, inherited: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...inherited, GENTLE_AI_HOME: join(scratch, 'gentle-ai'), HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(chosen), MIRADOR_SCOPES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const deadline = Date.now() + 8000;
  while (!LISTENING.test(output)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await closed;
      throw new Error(`server exited: ${output}`);
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server did not listen within 8 s: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(Number(LISTENING.exec(output)?.[1]), chosen, `the listening line names the configured port: ${JSON.stringify(output)}`);
  return child;
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-notify-icons-')));
  await mkdir(join(scratch, 'root'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  // No MIRADOR_* setting comes from the shell that runs the suite.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MIRADOR_')));
  // The port is picked before the server binds it, so another process can take it in between: on
  // "already in use", retry with another one.
  const tried: number[] = [];
  while (!server) {
    port = await freePort();
    tried.push(port);
    try {
      server = await startServer(port, inherited);
    } catch (error) {
      if (!/is already in use/.test((error as Error).message)) throw error;
      if (tried.length >= 3) throw new Error(`each port tried was already in use when the server bound it: ${tried.join(', ')}`);
    }
  }
});

after(async () => {
  const child = server;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
