// A hand-edited config with workspace entries Mirador cannot read: the server shows the
// readable ones, logs what it skipped, and refuses to save workspace changes instead of
// dropping the rest of what the user wrote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

let scratch: string;
let configFile: string;
let written: string;
let server: ChildProcess;
let stderr = '';
let base: string;
let token: string;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-ws-config-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  configFile = join(scratch, 'cfg', 'mirador', 'config.json');
  written = JSON.stringify(
    {
      workspaces: [
        { id: 'dev', name: 'Dev', root, folders: [], expanded: [] },
        { name: 'Half written', root, note: 'kept by hand' },
      ],
      engramUrl: 'http://127.0.0.1:9',
    },
    null,
    2,
  );
  await writeFile(configFile, written);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_STATE_HOME: join(scratch, 'state'), XDG_CONFIG_HOME: join(scratch, 'cfg'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (chunk) => { stderr += chunk; });
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

test('the readable workspaces show, and the skipped entry is logged', async () => {
  const listed = (await (await call('GET', '/api/workspaces')).json()) as Array<{ id: string }>;
  assert.deepEqual(listed.map((w) => w.id), ['dev']);
  assert.match(stderr, /workspaces\[1\] has no id, name or root/);
});

test('workspace changes are refused with a clear error and the file stays as written', async () => {
  for (const [method, path, body] of [
    ['PATCH', '/api/workspaces/dev', { name: 'Renamed' }],
    ['PATCH', '/api/workspaces/dev', { expanded: ['web'] }],
    ['POST', '/api/workspaces', { root: scratch }],
    ['DELETE', '/api/workspaces/dev', undefined],
  ] as const) {
    const response = await call(method, path, body);
    assert.equal(response.status, 400, `${method} ${path}`);
    const answer = (await response.json()) as { code: string; error: string };
    assert.equal(answer.code, 'workspace_config');
    assert.match(answer.error, /workspaces\[1\] has no id, name or root/);
  }
  assert.equal(await readFile(configFile, 'utf8'), written);
  const listed = (await (await call('GET', '/api/workspaces')).json()) as Array<{ name: string }>;
  assert.deepEqual(listed.map((w) => w.name), ['Dev']);
});
