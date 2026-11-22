// A file path in a terminal's output is a link only when the file editor would open that file
// (public/features/file-links-model.js against the real server, temp folders only): symlinks that
// leave the workspace root, point to a folder or to nothing, and files over 1 MiB are refused by the
// editor (src/files/folder-files.ts), so they are not links; a symlink to a file inside the root is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loaded by URL: the plain-JS model has no type declarations.
const { fileChecker, findFileLinks, openableFiles, splitPath } = await import(new URL('../public/features/file-links-model.js', import.meta.url).href);

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const MiB = 1024 * 1024;

let scratch: string;
let root: string;
let outside: string;
let server: ChildProcess;
let base: string;
let origin: string;
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

async function login(launchSecret: string): Promise<string> {
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

const get = (path: string, params: Record<string, string>) =>
  fetch(`${base}${path}?${new URLSearchParams({ ws: 'dev', ...params })}`, { headers: { origin, authorization: `Bearer ${token}` } });

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-file-links-')));
  root = join(scratch, 'root');
  outside = join(scratch, 'outside');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'outside the root\n');
  await writeFile(join(root, 'shared', 'config.ts'), 'export const shared = 1;\n');
  await writeFile(join(root, 'shared', 'huge.log'), Buffer.alloc(MiB + 1, 'a'));

  await writeFile(join(root, 'app', 'real.ts'), 'export {};\n');
  // A symlink to a file inside the root: the editor opens it.
  await symlink(join('..', 'shared', 'config.ts'), join(root, 'app', 'inside.ts'));
  // A symlink to a file outside the root: the editor refuses it (file_outside).
  await symlink(join(outside, 'secret.txt'), join(root, 'app', 'escape.txt'));
  // A symlink to nothing, and one to a folder: no file to open.
  await symlink(join(root, 'app', 'gone.ts'), join(root, 'app', 'dangling.ts'));
  await symlink(join('..', 'shared'), join(root, 'app', 'folder.ts'));
  // Over 1 MiB, as a file and through a symlink inside the root: the editor refuses both (file_too_large).
  await writeFile(join(root, 'app', 'big.log'), Buffer.alloc(MiB + 1, 'a'));
  await symlink(join('..', 'shared', 'huge.log'), join(root, 'app', 'huge.log'));
  // A folder symlink out of the root, and one to a folder inside it.
  await symlink(outside, join(root, 'outlink'));
  await symlink(join(root, 'shared'), join(root, 'inlink'));

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
  token = await login(state.launchSecret);
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => server?.once('exit', resolve));
  await rm(scratch, { recursive: true, force: true });
});

/** The terminal's existence check, as public/terminals.js wires it: GET /api/files, a failed listing throws. */
function terminalCheck() {
  return fileChecker(async (ws: string, rel: string) => {
    const response = await get('/api/files', { ws, rel });
    if (!response.ok) throw new Error(`listing ${rel}: ${response.status}`);
    return openableFiles(await response.json());
  });
}

/** Whether the file editor opens `path` (relative to the root): what files:open ends in, GET /api/files/content. */
async function editorOpens(path: string): Promise<boolean> {
  const { dir, name } = splitPath(path);
  const response = await get('/api/files/content', { rel: dir, name });
  await response.body?.cancel();
  return response.status === 200;
}

/** The candidates of `line` printed in a terminal opened in `app`, split into linked and not linked. */
async function linksOf(line: string) {
  const place = { root, rel: 'app', cwd: join(root, 'app') };
  const exists = terminalCheck();
  const found = findFileLinks(line, place) as Array<{ path: string }>;
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const link of found) ((await exists('dev', link.path)) ? linked : skipped).push(link.path);
  return { found: found.map((link) => link.path), linked, skipped };
}

test('a symlink inside the workspace to a file outside it is not a link, and the editor refuses it', async () => {
  const { found, linked } = await linksOf(`see ./escape.txt and ${root}/app/escape.txt`);
  assert.deepEqual(found, ['app/escape.txt', 'app/escape.txt']);
  assert.deepEqual(linked, []);
  assert.equal(await editorOpens('app/escape.txt'), false);
  // A folder symlink out of the root takes its files out too.
  assert.deepEqual((await linksOf('../outlink/secret.txt')).linked, []);
  assert.equal(await editorOpens('outlink/secret.txt'), false);
});

test('a symlink inside the workspace to a file inside it is a link, and the editor opens it', async () => {
  const { linked } = await linksOf('see ./inside.ts and ../inlink/config.ts');
  assert.deepEqual(linked, ['app/inside.ts', 'inlink/config.ts']);
  assert.equal(await editorOpens('app/inside.ts'), true);
  assert.equal(await editorOpens('inlink/config.ts'), true);
});

test('a file over 1 MiB, also through a symlink inside the root, is not a link, as the editor refuses it', async () => {
  const { found, linked } = await linksOf('big.log ./huge.log');
  assert.deepEqual(found, ['app/big.log', 'app/huge.log']);
  assert.deepEqual(linked, []);
  assert.equal(await editorOpens('app/big.log'), false);
  assert.equal(await editorOpens('app/huge.log'), false);
});

test('every path a terminal links is one the editor opens, and every one it opens is linked', async () => {
  const line = './real.ts ./inside.ts ./escape.txt ./dangling.ts ./folder.ts ./big.log ./huge.log ../outlink/secret.txt ../inlink/config.ts ./missing.ts';
  const { found, linked } = await linksOf(line);
  assert.equal(found.length, 10);
  const opened: string[] = [];
  for (const path of found) if (await editorOpens(path)) opened.push(path);
  assert.deepEqual(linked, opened);
  assert.deepEqual(linked, ['app/real.ts', 'app/inside.ts', 'inlink/config.ts']);
});
