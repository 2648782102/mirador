// GET /api/folder/diff through the real server in plain
// mode, with no Engram running: the session check, the folder confinement, the answer's shape,
// and GET /api/folder/git answering as before next to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const fixtureEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-11-10T09:15:00-03:00',
  GIT_COMMITTER_DATE: '2026-11-10T09:15:00-03:00',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: fixtureEnv, stdio: 'pipe' }).toString();

let scratch: string;
let server: ChildProcess;
let base: string;
let token: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

const call = (path: string, auth = token) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${auth}` } });

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-git-diff-api-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, 'fresh'));
  await mkdir(join(scratch, 'outside'));
  git(join(root, 'app'), 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'app', 'index.js'), 'one\n');
  git(join(root, 'app'), 'add', '.');
  git(join(root, 'app'), 'commit', '-q', '-m', 'Start the app');
  await writeFile(join(root, 'app', 'index.js'), 'two\n');
  await writeFile(join(root, 'app', 'NOTES.md'), 'Next: wire the panel\n');
  git(join(root, 'fresh'), 'init', '-q', '-b', 'main');

  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  // Engram points at a port nothing listens on: the route must not need it.
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, mode: 'plain', agentCommand: 'bash', engramUrl: `http://127.0.0.1:${await freePort()}` }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
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
  await rm(scratch, { recursive: true, force: true });
});

test('the folder diff route needs the session token', async () => {
  assert.equal((await call('/api/folder/diff?ws=dev&rel=app', 'made-up')).status, 401);
  assert.equal((await fetch(`${base}/api/folder/diff?ws=dev&rel=app`)).status, 401);
});

test('a repo answers its stat, its diff and its untracked names, without Engram', async () => {
  const response = await call('/api/folder/diff?ws=dev&rel=app');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    cwd: join(scratch, 'root', 'app'),
    diff: {
      available: true,
      totals: { files: 1, added: 1, removed: 1 },
      files: [
        {
          path: 'index.js',
          added: 1,
          removed: 1,
          binary: false,
          patch: 'diff --git a/index.js b/index.js\nindex 5626abf..f719efd 100644\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-one\n+two\n',
          truncated: false,
        },
      ],
      complete: true,
      untracked: { count: 1, complete: true, paths: ['NOTES.md'] },
    },
  });
});

test('a folder that is no repo, and a repo without commits, answer "not available"', async () => {
  const docs = await call('/api/folder/diff?ws=dev&rel=docs');
  assert.equal(docs.status, 200);
  assert.deepEqual(await docs.json(), { cwd: join(scratch, 'root', 'docs'), diff: { available: false, reason: 'not_repo' } });
  const fresh = await call('/api/folder/diff?ws=dev&rel=fresh');
  assert.deepEqual(((await fresh.json()) as { diff: unknown }).diff, { available: false, reason: 'no_commits' });
});

test('a folder outside the workspace root, a traversal or a NUL byte is refused; an unknown workspace is 404', async () => {
  for (const rel of ['../outside', '../../', join(scratch, 'outside'), 'missing', 'app/../../outside', 'app\0x']) {
    const response = await call(`/api/folder/diff?ws=dev&rel=${encodeURIComponent(rel)}`);
    assert.equal(response.status, 400, JSON.stringify(rel));
    assert.equal(((await response.json()) as { code: string }).code, 'folder_invalid');
  }
  const unknown = await call('/api/folder/diff?ws=nope&rel=app');
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { code: string }).code, 'workspace_not_found');
});

test('GET /api/folder/git answers as before next to the diff route', async () => {
  const response = await call('/api/folder/git?ws=dev&rel=app');
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.deepEqual(Object.keys(body), ['cwd', 'git', 'notes']);
  assert.deepEqual(Object.keys(body.git), ['available', 'branch', 'head', 'lastCommit', 'recent', 'changes']);
  assert.equal(body.git.branch, 'main');
  assert.deepEqual(body.git.changes, { count: 2, complete: true, files: [{ code: ' M', path: 'index.js' }, { code: '??', path: 'NOTES.md' }] });
  assert.deepEqual(body.notes, { text: 'Next: wire the panel\n', truncated: false });
  assert.deepEqual(((await (await call('/api/folder/git?ws=dev&rel=fresh')).json()) as any).git.lastCommit, null);
});
