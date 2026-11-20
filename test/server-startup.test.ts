// A server that cannot start must exit, not linger as a detached process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let port: number;
const started: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

function startServer(runDir: string): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: runDir, XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  return { child, output: () => output };
}

async function waitForFile(path: string, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function waitForExit(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} still running after ${ms} ms`)), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-startup-')));
  await mkdir(join(scratch, 'root'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root: join(scratch, 'root'), engramUrl: 'http://127.0.0.1:1' }));
  port = await freePort();
});

after(async () => {
  for (const child of started) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child, 5000).catch(() => child.kill('SIGKILL'));
    }
  }
  await rm(scratch, { recursive: true, force: true });
});

test('a second server on a port in use exits non-zero with a clear message and writes no state file', async () => {
  const first = startServer(join(scratch, 'run-first'));
  await waitForFile(join(scratch, 'run-first', 'mirador', 'state.json'));

  const second = startServer(join(scratch, 'run-second'));
  const code = await waitForExit(second.child, 4000);

  assert.equal(code, 1);
  assert.match(second.output(), new RegExp(`mirador: port ${port} on 127\\.0\\.0\\.1 is already in use`));
  await assert.rejects(access(join(scratch, 'run-second', 'mirador', 'state.json')));

  // The first server keeps serving.
  assert.equal(first.child.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});
