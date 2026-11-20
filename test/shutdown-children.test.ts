// Reproduces https://github.com/mata-2p/mirador/issues/1: without systemd scopes, stopping Mirador leaves
// alive a process an agent started in the background that ignores SIGHUP. On SIGTERM the server only sends
// SIGHUP to each terminal's shell and exits without waiting or escalating. The agent is a stand-in that starts
// such a child, records its pid and idles; the server runs with MIRADOR_SCOPES=0 and scratch dirs only.
// The test is skipped while the bug stands, with #1 in the reason the report prints. Not `todo`: the spec reporter
// lists a failed todo test under "failing tests" even though the run passes (test/shutdown-children-report.test.ts).
// To reproduce the bug, or once the product is fixed, drop the `skip` option so the test runs and becomes required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A port free right now. Another process can take it before the server binds it, so callers retry. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Polls `check` until it gives a value; after `ms` it throws, naming `what` it waited for. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

/** Resolves true once `child` has exited, or false after `ms`. A child that already exited resolves true at once. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Whether `pid` is still a process this test started (and not one that reused its pid): on Linux by the scratch
 * HOME in its environment, elsewhere by its command line. An exited process, or a zombie, is not.
 */
function isOurs(pid: number, home: string): boolean {
  try {
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`);
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() === 'sleep 600';
  } catch {
    return false;
  }
}

/** The pid recorded in `file`, or undefined while it is not there yet. */
async function recordedPid(file: string): Promise<number | undefined> {
  const pid = Number((await readFile(file, 'utf8')).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

test(
  'stopping the server without scopes leaves no process an agent started in the background, even one that ignores SIGHUP',
  { skip: 'known bug: Mirador without scopes leaves alive an agent child that ignores SIGHUP (#1)' },
  async () => {
    const scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-shutdown-')));
    const home = join(scratch, 'home');
    const childFile = join(home, 'child-pid');
    const agentFile = join(home, 'agent-pid');
    let server: ChildProcess | undefined;
    let stdout = '';
    let stderr = '';
    /** `message` with what the server printed to stderr so far. */
    const withStderr = (message: string) => `${message}; server stderr: ${JSON.stringify(stderr)}`;
    /** Like waitFor, with the server's stderr in the timeout message. */
    const waitForServer = <T>(what: string, check: () => Promise<T | undefined>) =>
      waitFor(what, check).catch((error: Error) => {
        throw new Error(withStderr(error.message));
      });
    try {
      const root = join(scratch, 'root');
      await mkdir(join(root, 'alpha'), { recursive: true });
      await mkdir(home, { recursive: true });
      await mkdir(join(scratch, 'bin'), { recursive: true });
      // A stand-in for gentle-shell: start a background child that ignores SIGHUP (an ignored signal stays
      // ignored across exec), record its pid and its own (each written aside, then renamed), then idle.
      await writeFile(join(scratch, 'bin', 'gentle-shell'), [
        '#!/bin/sh',
        '( trap \'\' HUP; exec sleep 600 ) &',
        'printf \'%s\\n\' "$!" > "$HOME/.child-pid.tmp" && mv "$HOME/.child-pid.tmp" "$HOME/child-pid"',
        'printf \'%s\\n\' "$$" > "$HOME/.agent-pid.tmp" && mv "$HOME/.agent-pid.tmp" "$HOME/agent-pid"',
        'exec sleep 600',
        '',
      ].join('\n'), { mode: 0o755 });
      await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
      await writeFile(join(scratch, 'cfg', 'mirador', 'config.json'), JSON.stringify({ workspaces: [{ id: 'dev', name: 'Dev', root, folders: [], expanded: [] }], engramUrl: 'http://127.0.0.1:9', launches: { reserveMb: 0 } }));
      // A non-zero port: on port 0 the server checks Host against 0 and refuses the test's requests (#2). The
      // port is picked before the server binds it, so another process can take it in between: on "already in
      // use", retry with another one, up to 3 tries.
      const tried: number[] = [];
      let port = 0;
      while (!server) {
        port = await freePort();
        tried.push(port);
        stdout = '';
        stderr = '';
        const attempt = spawn(process.execPath, ['src/server.ts'], {
          cwd: APP_DIR,
          env: {
            ...process.env,
            PATH: `${join(scratch, 'bin')}:${process.env.PATH}`,
            HOME: home,
            GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
            XDG_RUNTIME_DIR: join(scratch, 'run'),
            XDG_CONFIG_HOME: join(scratch, 'cfg'),
            XDG_STATE_HOME: join(scratch, 'state'),
            MIRADOR_PORT: String(port),
            MIRADOR_SCOPES: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // After 'close' its output is complete: 'exit' can come before the last of it.
        const closed = new Promise<void>((resolve) => attempt.once('close', () => resolve()));
        attempt.stdout?.on('data', (data) => (stdout += data));
        attempt.stderr?.on('data', (data) => (stderr += data));
        // Assigned at once, so the finally block stops it whatever happens next.
        server = attempt;
        const listening = await waitForServer('the server listening line', async () => {
          if (stdout.includes('Mirador listening')) return true;
          // The server failed to start: stop waiting (waitFor would retry) and look at why.
          if (attempt.exitCode !== null || attempt.signalCode !== null) return false;
          return undefined;
        });
        if (listening) break;
        await closed;
        if (!/is already in use/.test(stderr)) assert.fail(withStderr(`the server exited before listening (${attempt.exitCode ?? attempt.signalCode})`));
        if (tried.length >= 3) assert.fail(withStderr(`each port tried was already in use when the server bound it: ${tried.join(', ')}`));
        server = undefined;
      }
      const base = `http://127.0.0.1:${port}`;
      // The listening line comes after the state file is in place.
      const state = JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8'));
      const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
      const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
      const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
      const token = ((await session.json()) as { token: string }).token;
      const opened = await fetch(`${base}/api/terminals`, {
        method: 'POST',
        headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ws: 'dev', rel: 'alpha', kind: 'agent', cols: 80, rows: 24 }),
      });
      assert.equal(opened.status, 201, withStderr(await opened.text()));

      const child = await waitForServer("the agent's child pid file", () => recordedPid(childFile));
      await waitForServer(`the agent's child (pid ${child}) to run`, async () => (isOurs(child, home) ? true : undefined));
      await waitForServer('the agent pid file', () => recordedPid(agentFile));

      server.kill('SIGTERM');
      assert.ok(await exited(server, 10_000), withStderr(`the server (pid ${server.pid}) still ran 10 s after SIGTERM`));
      const deadline = Date.now() + 5000;
      while (isOurs(child, home) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(isOurs(child, home), false, `the agent's child (pid ${child}) that ignores SIGHUP still ran 5 s after the server exited (#1)`);
    } finally {
      // Whatever the outcome, nothing this test started outlives it.
      if (server && !(await exited(server, 0))) {
        server.kill('SIGKILL');
        await exited(server, 5000);
      }
      for (const file of [childFile, agentFile]) {
        const pid = await recordedPid(file).catch(() => undefined);
        if (pid !== undefined && isOurs(pid, home)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Gone meanwhile (ESRCH).
          }
        }
      }
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
