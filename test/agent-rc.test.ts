// The agent terminals' bash rcfile (src/terminals/agent-rc.ts), run by a real `bash --rcfile … -i`
// in a real pty (node-pty), with a scratch HOME and the user's ~/.bashrc written per case.
// The test prompt is set at the top of the rcfile it writes, not through the environment: bash reads a
// system bashrc first where it has one (Debian and Ubuntu's /etc/bash.bashrc set PS1), and that would
// replace a PS1 passed in the environment.
// Every prompt that bash draws (the agent ended,
// whatever ended it) is marked with OSC 133 A, which drops the agent's working and blocked OSC 7501
// records; the user's own PROMPT_COMMAND keeps running, and keeps seeing the last exit status.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RC } from '../src/terminals/agent-rc.ts';
import { waitFor } from './helpers/wait.ts';

const pty = createRequire(import.meta.url)('node-pty') as {
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => { pid: number; onData(l: (d: string) => void): void; onExit(l: () => void): void; write(d: string): void; kill(signal?: string): void };
};
const MARK = '\x1b]133;A';
/** The prompt each test waits for, set by the rcfile itself before it loads ~/.bashrc and starts the agent. */
const PROMPT = `PS1='PS1> '\n`;
const scratch: string[] = [];
/** PROMPT_COMMAND can be an array from bash 5.1 on (macOS ships /bin/bash 3.2). */
const [major, minor] = execFileSync('/bin/bash', ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim().split(' ').map(Number);
const arrayPromptCommand = major > 5 || (major === 5 && minor >= 1);

/** Stops for the shells a test has not stopped itself; after() runs what is left. */
const running = new Set<() => Promise<void>>();

after(async () => {
  for (const stop of [...running]) await stop();
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The processes of session `sid`, from /proc (Linux; elsewhere none are listed). node-pty starts bash as
 * the leader of a new session, and everything it starts stays in that session, even a job that job
 * control moved to a process group of its own.
 */
function sessionMembers(sid: number): number[] {
  if (process.platform !== 'linux') return [];
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // After the command name: state, ppid, pgrp, session.
        return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]) === sid;
      } catch {
        return false; // gone meanwhile
      }
    })
    .map(Number);
}

const killQuietly = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone (ESRCH).
  }
};

const count = (text: string, part: string) => text.split(part).length - 1;

/** Whether `command` (its full command line) runs as a child of `pid`, by `ps` (Linux and macOS). */
const runsChild = (pid: number, command: string) =>
  execFileSync('ps', ['-A', '-o', 'ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .some((line) => {
      const [ppid, ...rest] = line.trim().split(/\s+/);
      return Number(ppid) === pid && rest.join(' ') === command;
    });

/** Starts the rcfile in bash with `bashrc` as ~/.bashrc and `command` as the agent command. */
async function start(command: string, bashrc: string | null) {
  const home = await mkdtemp(join(tmpdir(), 'mirador-agent-rc-'));
  scratch.push(home);
  const rc = join(home, 'agent.bashrc');
  await writeFile(rc, PROMPT + AGENT_RC);
  if (bashrc !== null) await writeFile(join(home, '.bashrc'), bashrc);
  const shell = pty.spawn('/bin/bash', ['--rcfile', rc, '-i'], {
    cwd: home,
    cols: 200,
    rows: 24,
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', HISTFILE: join(home, '.bash_history'), MIRADOR_AGENT_COMMAND: command },
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => shell.onExit(() => ((exited = true), resolve())));
  /**
   * Ends bash and everything it started, and resolves once they are gone, whatever the test did: a
   * hangup first (bash exits and hangs up its jobs), then SIGKILL to its process group and to every
   * process left in its session, for a bash that ignored the hangup or a job that outlived it.
   */
  const stop = async () => {
    running.delete(stop);
    if (!exited) shell.kill('SIGHUP');
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([exit, new Promise((resolve) => (grace = setTimeout(resolve, 1000)))]);
    clearTimeout(grace);
    killQuietly(-shell.pid);
    for (const pid of sessionMembers(shell.pid)) killQuietly(pid);
    const deadline = Date.now() + 5000;
    while (!exited || sessionMembers(shell.pid).length > 0) {
      if (Date.now() > deadline) throw new Error(`bash (pid ${shell.pid}) or a process of its session still runs 5 s after SIGKILL: ${sessionMembers(shell.pid).join(' ')}`);
      await sleep(20);
    }
  };
  running.add(stop);
  let out = '';
  shell.onData((data) => { out += data; });
  const until = async (check: (text: string) => boolean, what: string) => {
    const deadline = Date.now() + 5000;
    while (!check(out)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(out.slice(-400))}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return out;
  };
  return { shell, until, stop, output: () => out };
}

test('each prompt bash draws once the agent has ended is marked with OSC 133 A, after the agent output and before the prompt', async () => {
  const { shell, until, stop } = await start("printf 'agent-ran\\n'", null);
  try {
    let out = await until((text) => text.includes('PS1> '), 'the first prompt');
    assert.equal(count(out, 'agent-ran'), 1, 'the agent ran once');
    assert.equal(count(out, MARK), 1);
    assert.ok(out.indexOf('agent-ran') < out.indexOf(MARK) && out.indexOf(MARK) < out.indexOf('PS1> '), JSON.stringify(out));
    shell.write('true\r');
    out = await until((text) => count(text, 'PS1> ') === 2, 'the second prompt');
    assert.equal(count(out, MARK), 2, 'one mark per prompt');
  } finally {
    await stop();
  }
});

test("the user's PROMPT_COMMAND (a string) still runs first at every prompt and still sees the last exit status", async () => {
  const { shell, until, stop } = await start("printf 'agent-ran\\n'", `PROMPT_COMMAND='printf "user-pc:%s\\\\n" "$?"'\n`);
  try {
    await until((text) => text.includes('PS1> '), 'the first prompt');
    shell.write('(exit 7)\r');
    const out = await until((text) => count(text, 'PS1> ') === 2, 'the second prompt');
    const second = out.slice(out.indexOf('(exit 7)'));
    assert.match(second, /user-pc:7/);
    assert.ok(second.indexOf('user-pc:7') < second.indexOf(MARK), JSON.stringify(second));
    assert.equal(count(out, 'user-pc:'), 2);
    assert.equal(count(out, MARK), 2);
  } finally {
    await stop();
  }
});

test("the user's PROMPT_COMMAND (an array, bash 5.1+) keeps every element, each seeing the last exit status", { skip: !arrayPromptCommand && 'bash < 5.1 has no PROMPT_COMMAND array' }, async () => {
  const { shell, until, stop } = await start("printf 'agent-ran\\n'", `PROMPT_COMMAND=('printf "a:%s\\\\n" "$?"' 'printf "b:%s\\\\n" "$?"')\n`);
  try {
    await until((text) => text.includes('PS1> '), 'the first prompt');
    shell.write('(exit 5)\r');
    const out = await until((text) => count(text, 'PS1> ') === 2, 'the second prompt');
    const second = out.slice(out.indexOf('(exit 5)'));
    assert.match(second, /a:5/);
    assert.match(second, /b:5/, 'the mark keeps the status for the elements after it');
    assert.equal(count(out, MARK), 2);
  } finally {
    await stop();
  }
});

test('a readonly PROMPT_COMMAND is left alone, without an error on screen, and the agent still starts', async () => {
  const { shell, until, stop } = await start("printf 'agent-ran\\n'", `PROMPT_COMMAND='printf "user-pc\\\\n"'\nreadonly PROMPT_COMMAND\n`);
  try {
    const out = await until((text) => text.includes('PS1> '), 'the first prompt');
    assert.match(out, /agent-ran/);
    assert.match(out, /user-pc/);
    assert.doesNotMatch(out, /readonly/i);
  } finally {
    await stop();
  }
});

test('the agent command still runs once from the rcfile and is the newest history entry; MIRADOR_AGENT_COMMAND is gone', async () => {
  const { shell, until, stop } = await start("printf 'agent-ran\\n'", null);
  try {
    await until((text) => text.includes('PS1> '), 'the first prompt');
    shell.write('history 2; printf "var:[%s]\\n" "$MIRADOR_AGENT_COMMAND"\r');
    // The next prompt, not 'var:[': the echo of the typed line already holds that, before bash has run it.
    const out = await until((text) => count(text, 'PS1> ') === 2, 'the prompt after the history');
    assert.match(out, /\d+ {2}printf 'agent-ran\\n'/);
    assert.match(out, /var:\[\]/);
    assert.equal(count(out, 'agent-ran\r\n'), 1, 'it ran once');
  } finally {
    await stop();
  }
});

test('an agent ended by Ctrl-C still gets its prompt marked (bash then skips the rest of the rcfile)', async () => {
  const { shell, until, stop } = await start('sleep 30', null);
  try {
    // Ctrl-C once the agent runs: earlier, it would cut bash's start-up short instead of ending the agent.
    await waitFor(() => runsChild(shell.pid, 'sleep 30') || undefined, 'the agent (sleep 30) to run under bash', 5000);
    shell.write('\x03');
    const out = await until((text) => text.includes('PS1> '), 'the prompt after Ctrl-C');
    assert.equal(count(out, MARK), 1);
    assert.ok(out.indexOf(MARK) < out.indexOf('PS1> '), JSON.stringify(out));
  } finally {
    await stop();
  }
});
