// The `mode` config key and the mode GET /api/config resolves.
// `auto` looks at a scratch GENTLE_AI_HOME and a PATH of stubs that are never run: never the real home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { AppContext } from '../src/http/context.ts';
import { createConfigRoutes } from '../src/http/routes/config.ts';

let scratch: string;
let home: string;
let withState: string;
let withoutState: string;
let withShell: string;
let withoutShell: string;

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-mode-')));
  home = join(scratch, 'home');
  withState = join(scratch, 'gentle-ai');
  withoutState = join(scratch, 'no-gentle-ai');
  withShell = join(scratch, 'bin-gentle');
  withoutShell = join(scratch, 'bin-plain');
  await mkdir(withState, { recursive: true });
  await writeFile(join(withState, 'state.json'), '{}');
  for (const [dir, program] of [[withShell, 'gentle-shell'], [withoutShell, 'claude']]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, program), '#!/bin/sh\nexit 99\n');
    await chmod(join(dir, program), 0o755);
  }
});

after(() => rm(scratch, { recursive: true, force: true }));

async function configFile(name: string, saved: unknown): Promise<string> {
  await mkdir(join(scratch, name), { recursive: true });
  const path = join(scratch, name, 'config.json');
  await writeFile(path, JSON.stringify(saved));
  return path;
}

test('mode defaults to auto, keeps a valid value and turns anything else into auto with a warning', async () => {
  assert.equal((await loadConfig(join(scratch, 'missing.json'), { HOME: home })).mode, 'auto', 'no config file');
  const none = await loadConfig(await configFile('mode-none', { port: 5000 }), { HOME: home });
  assert.equal(none.mode, 'auto');
  assert.deepEqual(none.launchProblems, []);
  for (const mode of ['auto', 'gentle-deck', 'plain']) {
    const config = await loadConfig(await configFile(`mode-${mode}`, { mode }), { HOME: home });
    assert.equal(config.mode, mode);
    assert.deepEqual(config.launchProblems, []);
  }
  for (const mode of ['Plain', 'mirador', '', 1, null, true]) {
    const config = await loadConfig(await configFile(`mode-bad-${String(mode)}`, { mode }), { HOME: home });
    assert.equal(config.mode, 'auto');
    assert.deepEqual(config.launchProblems, ['mode must be "auto", "gentle-deck" or "plain"; auto applies']);
  }
});

/** Runs the GET /api/config handler with `mode` configured and `env` for auto; returns its JSON body. */
async function getConfig(mode: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const ctx = { config: { agentCommand: 'gentle-shell', timeZone: 'America/Santiago', mode }, today: () => '2026-11-09' } as unknown as AppContext;
  const routes = await createConfigRoutes({ env })(ctx);
  const route = routes.find((r) => r.method === 'GET' && r.path === '/api/config');
  assert.ok(route, 'GET /api/config is registered');
  let status = 0;
  let body = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: unknown) {
      body = String(chunk ?? '');
      return res;
    },
  };
  await route.handler({ req: {} as never, res: res as unknown as ServerResponse, url: new URL('http://127.0.0.1/api/config'), params: {} });
  assert.equal(status, 200);
  return JSON.parse(body);
}

test('GET /api/config keeps its keys and adds the resolved mode', async () => {
  const body = await getConfig('auto', { HOME: home, GENTLE_AI_HOME: withState, PATH: withoutShell });
  assert.deepEqual(body, { agentCommand: 'gentle-shell', timeZone: 'America/Santiago', today: '2026-11-09', mode: 'gentle-deck' });
});

test('auto is gentle-deck with gentle-ai\'s state.json or gentle-shell on PATH, and plain with neither', async () => {
  assert.equal((await getConfig('auto', { HOME: home, GENTLE_AI_HOME: withState, PATH: withoutShell })).mode, 'gentle-deck', 'state file only');
  assert.equal((await getConfig('auto', { HOME: home, GENTLE_AI_HOME: withoutState, PATH: withShell })).mode, 'gentle-deck', 'gentle-shell on PATH only');
  assert.equal((await getConfig('auto', { HOME: home, GENTLE_AI_HOME: withoutState, PATH: withoutShell })).mode, 'plain', 'neither');
});

test('an explicit mode wins over what auto would find', async () => {
  assert.equal((await getConfig('plain', { HOME: home, GENTLE_AI_HOME: withState, PATH: withShell })).mode, 'plain');
  assert.equal((await getConfig('gentle-deck', { HOME: home, GENTLE_AI_HOME: withoutState, PATH: withoutShell })).mode, 'gentle-deck');
});

test('auto is resolved per request: gentle-ai installed after start turns it to gentle-deck', async () => {
  const later = join(scratch, 'later');
  const env = { HOME: home, GENTLE_AI_HOME: later, PATH: withoutShell };
  assert.equal((await getConfig('auto', env)).mode, 'plain');
  await mkdir(later, { recursive: true });
  await writeFile(join(later, 'state.json'), '{}');
  assert.equal((await getConfig('auto', env)).mode, 'gentle-deck');
});
