// Crash regression for open agents: a SIGKILLed server keeps its records and the next
// start reopens them; unauthenticated session lines are refused; SIGTERM keeps the records.
// Each server runs with its own HOME and XDG dirs under a scratch directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
let scratch: string; let port: number; let base: string; let server: ChildProcess | undefined; let output = '';
async function freePort(): Promise<number> { const p = createServer(); await new Promise<void>((r) => p.listen(0, '127.0.0.1', r)); const a = p.address(); await new Promise((r) => p.close(r)); return typeof a === 'object' && a ? a.port : 0; }
async function waitFor<T>(check: () => Promise<T | undefined>, ms = 10000): Promise<T> { const d = Date.now() + ms; while (Date.now() < d) { const v = await check().catch(() => undefined); if (v !== undefined) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); }
const statePath = () => join(scratch, 'run', 'mirador', 'state.json');
const recordsPath = () => join(scratch, 'state', 'mirador', 'open-agents.json');
const records = async () => JSON.parse(await readFile(recordsPath(), 'utf8')) as { owner: string; agents: Array<{ id: string; rel: string; sessionFile: string | null }> };
async function start() {
  output = '';
  server = spawn(process.execPath, ['src/server.ts'], { cwd: APP_DIR, env: { ...process.env, PATH: `${join(scratch, 'bin')}:${process.env.PATH}`, HOME: join(scratch, 'home'), GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'), XDG_RUNTIME_DIR: join(scratch, 'run'), XDG_CONFIG_HOME: join(scratch, 'cfg'), XDG_STATE_HOME: join(scratch, 'state'), MIRADOR_PORT: String(port), MIRADOR_SCOPES: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout?.on('data', (d) => (output += d)); server.stderr?.on('data', (d) => (output += d));
  const state = await waitFor(async () => { const s = JSON.parse(await readFile(statePath(), 'utf8')); return s.pid === server!.pid ? s : undefined; });
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const token = ((await session.json()) as { token: string }).token;
  return (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function end(signal: NodeJS.Signals) { if (!server || server.exitCode !== null) return; const exited = new Promise((r) => server!.once('exit', r)); server.kill(signal); await exited; }
const agentArgs = (id: string) => waitFor(async () => (await readFile(join(scratch, 'home', `args-${id}`), 'utf8')).split('\n').slice(0, -1));
before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-open-agents-crash-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'alpha'), { recursive: true }); await mkdir(join(root, 'beta'), { recursive: true }); await mkdir(join(scratch, 'home'), { recursive: true }); await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'gentle-shell'), ['#!/bin/sh', 'printf \'%s\\n\' "$@" > "$HOME/args-$HERDR_PANE_ID"', 'printf \'%s\\n\' "${MIRADOR_NIGHT_SOCKET:-none}" "${MIRADOR_NIGHT_TOKEN:-none}" > "$HOME/night-$HERDR_PANE_ID"', 'while kill -0 $PPID 2>/dev/null; do sleep 1; done', ''].join('\n'), { mode: 0o755 });
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ root, engramUrl: 'http://127.0.0.1:9', launches: { reserveMb: 0 } }));
  port = await freePort(); base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await end('SIGTERM');
  await rm(scratch, { recursive: true, force: true });
});
test('kill -9 keeps the records; the next start reopens them staggered, continues only still-valid files, drops a gone folder; unauthenticated session lines are refused', async () => {
  let api = await start();
  const open = async (rel: string) => { const r = await api('POST', '/api/terminals', { ws: 'dev', rel, kind: 'agent', cols: 90, rows: 33 }); assert.equal(r.status, 201); return ((await r.json()) as { id: string }).id; };
  const alpha = await open('alpha'); const beta = await open('beta');
  await waitFor(async () => ((await records()).agents.length === 2 ? true : undefined));
  const file1 = join(scratch, 'one.jsonl'); const file2 = join(scratch, 'two.jsonl'); await writeFile(file1, '{}\n'); await writeFile(file2, '{}\n');
  // The stand-in's `>` creates the file empty before printf fills it: wait until both lines are there.
  const night = async (id: string) => {
    const lines = (await readFile(join(scratch, 'home', `night-${id}`), 'utf8')).split('\n');
    return lines[0] && lines[1] ? lines : undefined;
  };
  const [socketPath, tokenA] = await waitFor(() => night(alpha)); const [, tokenB] = await waitFor(() => night(beta));
  // unauthenticated: a session line before hello closes the connection and records nothing
  const rogue = createConnection(socketPath); await new Promise((r) => rogue.once('connect', r));
  const closed = new Promise((r) => rogue.once('close', r));
  rogue.write(JSON.stringify({ type: 'session', file: file1 }) + '\n'); await closed;
  // wrong token with a session line after it: also refused
  const rogue2 = createConnection(socketPath); await new Promise((r) => rogue2.once('connect', r)); const closed2 = new Promise((r) => rogue2.once('close', r));
  rogue2.write(JSON.stringify({ type: 'hello', terminalId: alpha, token: tokenB }) + '\n' + JSON.stringify({ type: 'session', file: file1 }) + '\n'); await closed2;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await records()).agents.map((a) => a.sessionFile), [null, null], 'nothing recorded from unauthenticated bridges');
  const bridge = async (id: string, token: string, file: string) => { const c = createConnection(socketPath); await new Promise((r) => c.once('connect', r)); c.write(JSON.stringify({ type: 'hello', terminalId: id, token }) + '\n' + JSON.stringify({ type: 'session', file }) + '\n'); await waitFor(async () => ((await records()).agents.find((a) => a.id === id)?.sessionFile === file ? true : undefined)); c.destroy(); };
  await bridge(alpha, tokenA, file1); await bridge(beta, tokenB, file2);
  // crash
  await end('SIGKILL');
  await access(statePath()); // a crash leaves state.json, as at the baseline
  const afterCrash = await records();
  assert.deepEqual(afterCrash.agents.map((a) => [a.id, a.sessionFile]), [[alpha, file1], [beta, file2]]);
  // beta's session file vanishes; a third record points at a folder that no longer exists
  await rm(file2);
  afterCrash.agents.push({ id: 'ghost', rel: 'gamma', sessionFile: null, ...({ workspaceId: 'dev', cwd: join(scratch, 'root', 'gamma'), cols: 80, rows: 24, createdAt: 'x' } as object) } as never);
  await writeFile(recordsPath(), JSON.stringify(afterCrash));
  api = await start();
  const reopened = await waitFor(async () => { const l = (await (await api('GET', '/api/terminals')).json()) as Array<{ id: string; rel: string; kind: string }>; return l.length === 2 ? l : undefined; });
  assert.deepEqual(reopened.map((t) => [t.kind, t.rel]), [['agent', 'alpha'], ['agent', 'beta']]);
  const a1 = await agentArgs(reopened[0].id); const a2 = await agentArgs(reopened[1].id);
  assert.deepEqual(a1.slice(-2), ['--session', file1]); assert.equal(a2.includes('--session'), false, 'gone session file: fresh session');
  const t1 = (await stat(join(scratch, 'home', `args-${reopened[0].id}`))).mtimeMs; const t2 = (await stat(join(scratch, 'home', `args-${reopened[1].id}`))).mtimeMs;
  assert.ok(t2 - t1 >= 1500, `staggered ${t2 - t1} ms`);
  await waitFor(async () => (output.includes('reopened 2 agent(s), dropped 1') ? true : undefined));
  assert.match(output, /dropped the open agent of workspace "dev" folder "gamma"/);
  const now = await waitFor(async () => { const v = await records(); return v.agents.length === 2 && v.agents.every((a) => a.id !== alpha && a.id !== beta && a.id !== 'ghost') ? v : undefined; });
  assert.deepEqual(now.agents.map((a) => [a.rel, a.sessionFile]), [['alpha', file1], ['beta', null]]);
  // existing terminal list shape: no exitSignal on running terminals
  assert.equal('exitSignal' in (reopened[0] as object), false);
  await end('SIGTERM');
  await assert.rejects(access(statePath()));
  assert.equal((await records()).agents.length, 2, 'SIGTERM keeps the records');
  console.log('OUTPUT_TAIL', output.split('\n').filter((l) => /mirador:|reopened|dropped/.test(l)).join(' | '));
});
