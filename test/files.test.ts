// Integration tests for the file editor API: the real server against temp folders only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const MiB = 1024 * 1024;

let scratch: string;
let root: string;
let outside: string;
let server: ChildProcess;
let base: string;
let origin: string;
let launchSecret: string;
let token: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

async function login(): Promise<string> {
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { origin, authorization: `Bearer ${token}` }): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const query = (params: Record<string, string>) => new URLSearchParams({ ws: 'dev', ...params }).toString();
const list = (rel: string) => call('GET', `/api/files?${query({ rel })}`);
const read = (rel: string, name: string) => call('GET', `/api/files/content?${query({ rel, name })}`);
const write = (rel: string, name: string, content: unknown, version: unknown) =>
  call('PUT', '/api/files/content', { ws: 'dev', rel, name, content, version });
const createEnv = (rel: string) => call('POST', '/api/files/env', { ws: 'dev', rel });

async function expectError(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(((await response.json()) as { code?: string }).code, code);
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-files-')));
  root = join(scratch, 'root');
  outside = join(scratch, 'outside');
  await mkdir(join(root, 'listing', 'src'), { recursive: true });
  await mkdir(join(root, 'listing', '.git'), { recursive: true });
  for (const name of ['README.md', 'package.json', '.gitignore', '.env.local', '.env', '.env.example', 'docker.env']) {
    await writeFile(join(root, 'listing', name), `${name}\n`);
  }
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'outside the root\n');

  const configDir = join(scratch, 'cfg', 'mirador');
  await mkdir(configDir, { recursive: true });
  // Engram is never called by these routes; point it at a closed port.
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9' }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: 'ignore',
  });
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  launchSecret = state.launchSecret;
  token = await login();
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

test('a folder lists its files with dotenv files first, hidden files included, without folders or .git', async () => {
  const response = await list('listing');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { files: Array<{ name: string; dotenv: boolean }>; truncated: boolean };
  assert.deepEqual(
    body.files.map((f) => f.name),
    ['.env', '.env.example', '.env.local', 'docker.env', '.gitignore', 'package.json', 'README.md'],
  );
  assert.deepEqual(body.files.filter((f) => f.dotenv).map((f) => f.name), ['.env', '.env.example', '.env.local', 'docker.env']);
  assert.equal(body.truncated, false);
});

test('a file reads back as text with a version, and a write with that version saves it', async () => {
  await writeFile(join(root, 'app', 'notes.txt'), 'first línea\r\nsecond\n');
  const opened = await read('app', 'notes.txt');
  assert.equal(opened.status, 200);
  const file = (await opened.json()) as { name: string; content: string; version: string; size: number; readOnly: boolean };
  assert.equal(file.name, 'notes.txt');
  assert.equal(file.content, 'first línea\r\nsecond\n');
  assert.equal(file.size, Buffer.byteLength('first línea\r\nsecond\n'));
  assert.equal(file.readOnly, false);
  assert.ok(file.version.length > 10);

  const saved = await write('app', 'notes.txt', 'PORT=3000\nNAME=ñandú\n', file.version);
  assert.equal(saved.status, 200);
  const result = (await saved.json()) as { name: string; version: string; size: number };
  assert.equal(result.name, 'notes.txt');
  assert.notEqual(result.version, file.version);
  assert.equal(await readFile(join(root, 'app', 'notes.txt'), 'utf8'), 'PORT=3000\nNAME=ñandú\n');

  const again = (await (await read('app', 'notes.txt')).json()) as { content: string; version: string };
  assert.equal(again.content, 'PORT=3000\nNAME=ñandú\n');
  assert.equal(again.version, result.version);
});

test('a write keeps the file mode and replaces the file atomically, leaving no temp file behind', async () => {
  const path = join(root, 'app', 'run.sh');
  await writeFile(path, 'echo one\n');
  await chmod(path, 0o775); // group write is masked by a usual umask: the mode must be set explicitly
  const before = await stat(path);
  const { version } = (await (await read('app', 'run.sh')).json()) as { version: string };

  assert.equal((await write('app', 'run.sh', 'echo two\n', version)).status, 200);
  const after = await stat(path);
  assert.equal(after.mode & 0o7777, 0o775);
  // A new inode means the content arrived by rename, never by truncating the old file in place.
  assert.notEqual(after.ino, before.ino);
  assert.equal(await readFile(path, 'utf8'), 'echo two\n');
  assert.deepEqual((await readdir(join(root, 'app'))).filter((name) => name.includes('mirador')), []);
});

test('a write keeps the setuid bit, which writing a file would otherwise clear', async () => {
  const path = join(root, 'app', 'tool.sh');
  await writeFile(path, 'echo one\n');
  await chmod(path, 0o4750);
  assert.equal((await stat(path)).mode & 0o7777, 0o4750, 'this file system lets the owner set setuid');
  const { version } = (await (await read('app', 'tool.sh')).json()) as { version: string };

  assert.equal((await write('app', 'tool.sh', 'echo two\n', version)).status, 200);
  assert.equal((await stat(path)).mode & 0o7777, 0o4750);
  assert.equal(await readFile(path, 'utf8'), 'echo two\n');
});

test('content with a lone UTF-16 surrogate is refused instead of being saved as U+FFFD', async () => {
  const path = join(root, 'app', 'surrogate.env');
  await writeFile(path, 'A=1\n');
  const { version } = (await (await read('app', 'surrogate.env')).json()) as { version: string };

  for (const content of ['A=\uD800\n', 'A=\uDC00x\n', 'A=😀\uD83D\n']) {
    await expectError(await write('app', 'surrogate.env', content, version), 400, 'file_content');
  }
  assert.equal(await readFile(path, 'utf8'), 'A=1\n');
  assert.equal((await write('app', 'surrogate.env', 'A=😀ñ\n', version)).status, 200, 'paired surrogates are plain text');
});

test('a write with a stale version answers 409 and leaves the file on disk untouched', async () => {
  const path = join(root, 'app', 'stale.env');
  await writeFile(path, 'A=1\n');
  const { version } = (await (await read('app', 'stale.env')).json()) as { version: string };
  await writeFile(path, 'A=2\n'); // an agent changed it after the editor read it

  await expectError(await write('app', 'stale.env', 'A=mine\n', version), 409, 'file_changed');
  assert.equal(await readFile(path, 'utf8'), 'A=2\n');
  await expectError(await write('app', 'stale.env', 'A=mine\n', undefined), 400, 'file_version');
  await expectError(await write('app', 'stale.env', 42, version), 400, 'file_content');
});

test('two saves of the same version at once: one wins, the other gets 409', async () => {
  const path = join(root, 'app', 'race.txt');
  await writeFile(path, 'start\n');
  const { version } = (await (await read('app', 'race.txt')).json()) as { version: string };
  const answers = await Promise.all([write('app', 'race.txt', 'left\n', version), write('app', 'race.txt', 'right\n', version)]);
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
  const winner = answers[0].status === 200 ? 'left\n' : 'right\n';
  assert.equal(await readFile(path, 'utf8'), winner);
});

test('files over 1 MiB are listed as too large and refused on read and on write', async () => {
  await writeFile(join(root, 'app', 'big.log'), Buffer.alloc(MiB + 1, 'a'));
  await writeFile(join(root, 'app', 'small.txt'), 'small\n');
  const { files } = (await (await list('app')).json()) as { files: Array<{ name: string; tooLarge: boolean }> };
  assert.equal(files.find((f) => f.name === 'big.log')?.tooLarge, true);
  assert.equal(files.find((f) => f.name === 'small.txt')?.tooLarge, false);

  await expectError(await read('app', 'big.log'), 413, 'file_too_large');
  const { version } = (await (await read('app', 'small.txt')).json()) as { version: string };
  await expectError(await write('app', 'small.txt', 'a'.repeat(MiB + 1), version), 413, 'file_too_large');
  assert.equal(await readFile(join(root, 'app', 'small.txt'), 'utf8'), 'small\n');
  // Exactly 1 MiB is still text the editor handles.
  assert.equal((await write('app', 'small.txt', 'b'.repeat(MiB), version)).status, 200);
});

test('binary and non-UTF-8 files are refused, and so is content holding NUL bytes', async () => {
  await writeFile(join(root, 'app', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await writeFile(join(root, 'app', 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Latin-1
  await expectError(await read('app', 'logo.png'), 415, 'file_binary');
  await expectError(await read('app', 'latin1.txt'), 415, 'file_binary');

  await writeFile(join(root, 'app', 'plain.txt'), 'plain\n');
  const { version } = (await (await read('app', 'plain.txt')).json()) as { version: string };
  await expectError(await write('app', 'plain.txt', 'a\u0000b', version), 415, 'file_binary');
  assert.equal(await readFile(join(root, 'app', 'plain.txt'), 'utf8'), 'plain\n');
});

test('a byte-order mark survives a read and a save', async () => {
  const path = join(root, 'app', 'bom.txt');
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('X=1\n')]));
  const file = (await (await read('app', 'bom.txt')).json()) as { content: string; version: string };
  assert.equal(file.content, '﻿X=1\n');
  assert.equal((await write('app', 'bom.txt', file.content.replace('1', '2'), file.version)).status, 200);
  assert.deepEqual([...(await readFile(path)).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('file names must be plain names inside the folder: traversal, separators and absolute paths are refused', async () => {
  for (const name of ['..', '.', '../outside/secret.txt', '/etc/passwd', `${outside}/secret.txt`, 'sub/file', 'a\\b', '.git', '']) {
    await expectError(await read('app', name), 400, 'file_name');
    await expectError(await write('app', name, 'x', 'v'), 400, 'file_name');
  }
  // The folder part goes through the workspace root guard.
  await expectError(await read('../outside', 'secret.txt'), 400, 'folder_invalid');
  await expectError(await list(outside), 400, 'folder_invalid');
  await expectError(await call('GET', `/api/files?${new URLSearchParams({ ws: 'nope', rel: '' })}`), 404, 'workspace_not_found');
  await expectError(await read('app', 'missing.txt'), 404, 'file_not_found');
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside the root\n');
});

test('a symlink leaving the workspace root is hidden and refused; one inside the root stays a symlink when saved', async () => {
  await symlink(join(outside, 'secret.txt'), join(root, 'app', 'escape.txt'));
  await symlink(outside, join(root, 'outlink'));
  await writeFile(join(root, 'shared', 'config.txt'), 'shared=1\n');
  await symlink(join('..', 'shared', 'config.txt'), join(root, 'app', 'shared.txt'));

  const { files } = (await (await list('app')).json()) as { files: Array<{ name: string; symlink: boolean }> };
  assert.equal(files.some((f) => f.name === 'escape.txt'), false);
  assert.equal(files.find((f) => f.name === 'shared.txt')?.symlink, true);

  await expectError(await read('app', 'escape.txt'), 400, 'file_outside');
  await expectError(await write('app', 'escape.txt', 'stolen', 'v'), 400, 'file_outside');
  await expectError(await list('outlink'), 400, 'folder_invalid');
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside the root\n');

  const file = (await (await read('app', 'shared.txt')).json()) as { content: string; version: string };
  assert.equal(file.content, 'shared=1\n');
  assert.equal((await write('app', 'shared.txt', 'shared=2\n', file.version)).status, 200);
  assert.ok((await lstat(join(root, 'app', 'shared.txt'))).isSymbolicLink());
  assert.equal(await readlink(join(root, 'app', 'shared.txt')), join('..', 'shared', 'config.txt'));
  assert.equal(await readFile(join(root, 'shared', 'config.txt'), 'utf8'), 'shared=2\n');
});

test('only regular files open: folders and FIFOs are refused without blocking', async () => {
  execFileSync('mkfifo', [join(root, 'app', 'pipe')]);
  const { files } = (await (await list('app')).json()) as { files: Array<{ name: string }> };
  assert.equal(files.some((f) => f.name === 'pipe'), false);
  await expectError(await read('app', 'pipe'), 400, 'file_not_regular');
  await expectError(await read('listing', 'src'), 400, 'file_not_regular');
  await expectError(await write('listing', 'src', 'x', 'v'), 400, 'file_not_regular');
});

test('a file Mirador may not write is marked read-only and its save is refused', async () => {
  const path = join(root, 'app', 'locked.txt');
  await writeFile(path, 'locked\n');
  await chmod(path, 0o444);
  const file = (await (await read('app', 'locked.txt')).json()) as { readOnly: boolean; version: string };
  assert.equal(file.readOnly, true);
  await expectError(await write('app', 'locked.txt', 'changed\n', file.version), 403, 'file_permission');
  assert.equal(await readFile(path, 'utf8'), 'locked\n');
  assert.equal((await stat(path)).mode & 0o777, 0o444);
});

test('.env is created from .env.example in one call, keeping its mode, and never overwrites an existing .env', async () => {
  const folder = join(root, 'fresh');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '.env.example'), 'API_KEY=\nPORT=3000\n');
  await chmod(join(folder, '.env.example'), 0o640);

  const created = await createEnv('fresh');
  assert.equal(created.status, 201);
  const body = (await created.json()) as { name: string; version: string; size: number };
  assert.equal(body.name, '.env');
  assert.equal(await readFile(join(folder, '.env'), 'utf8'), 'API_KEY=\nPORT=3000\n');
  assert.equal((await stat(join(folder, '.env'))).mode & 0o777, 0o640);
  const opened = (await (await read('fresh', '.env')).json()) as { version: string };
  assert.equal(opened.version, body.version);
  const { files } = (await (await list('fresh')).json()) as { files: Array<{ name: string }> };
  assert.deepEqual(files.map((f) => f.name), ['.env', '.env.example']);
  assert.deepEqual((await readdir(folder)).filter((name) => name.includes('mirador')), []);

  await writeFile(join(folder, '.env'), 'API_KEY=secret\n');
  await expectError(await createEnv('fresh'), 409, 'file_exists');
  assert.equal(await readFile(join(folder, '.env'), 'utf8'), 'API_KEY=secret\n');
});

test('.env creation needs a .env.example inside the root and never follows a .env symlink', async () => {
  await mkdir(join(root, 'bare'), { recursive: true });
  await expectError(await createEnv('bare'), 404, 'file_not_found');

  const dangling = join(root, 'dangling');
  await mkdir(dangling, { recursive: true });
  await writeFile(join(dangling, '.env.example'), 'A=\n');
  await symlink(join(outside, 'planted.env'), join(dangling, '.env'));
  await expectError(await createEnv('dangling'), 409, 'file_exists');
  await assert.rejects(stat(join(outside, 'planted.env')));

  const leaking = join(root, 'leaking');
  await mkdir(leaking, { recursive: true });
  await symlink(join(outside, 'secret.txt'), join(leaking, '.env.example'));
  await expectError(await createEnv('leaking'), 400, 'file_outside');
  await assert.rejects(stat(join(leaking, '.env')));
});

test('file routes need the session token, and writes also need the app Origin', async () => {
  const path = join(root, 'app', 'guarded.txt');
  await writeFile(path, 'guarded\n');
  const { version } = (await (await read('app', 'guarded.txt')).json()) as { version: string };
  const body = { ws: 'dev', rel: 'app', name: 'guarded.txt', content: 'changed\n', version };

  assert.equal((await call('GET', `/api/files?${query({ rel: 'app' })}`, undefined, {})).status, 401);
  assert.equal((await call('GET', `/api/files/content?${query({ rel: 'app', name: 'guarded.txt' })}`, undefined, { authorization: 'Bearer made-up' })).status, 401);
  assert.equal((await call('PUT', '/api/files/content', body, { authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await call('PUT', '/api/files/content', body, { origin: 'http://127.0.0.1:1', authorization: `Bearer ${token}` })).status, 403);
  assert.equal((await call('PUT', '/api/files/content', body, { origin })).status, 401);
  assert.equal((await call('POST', '/api/files/env', { ws: 'dev', rel: 'fresh' }, { origin: 'http://evil.example', authorization: `Bearer ${token}` })).status, 403);
  assert.equal(await readFile(path, 'utf8'), 'guarded\n');
});

test('a malformed or oversized save body is refused before touching the file', async () => {
  const path = join(root, 'app', 'body.txt');
  await writeFile(path, 'body\n');
  const raw = (text: string) =>
    fetch(`${base}/api/files/content`, { method: 'PUT', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: text });
  assert.equal((await raw('{not json')).status, 400);
  assert.equal((await raw('[1,2]')).status, 400);
  const huge = await raw(JSON.stringify({ ws: 'dev', rel: 'app', name: 'body.txt', content: 'x'.repeat(4 * MiB + 1), version: 'v' })).catch(() => null);
  if (huge) assert.equal(huge.status, 413);
  assert.equal(await readFile(path, 'utf8'), 'body\n');
});
