import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv } from '../terminals/registry.ts';

/**
 * The pi runner every Claude run goes through (the night decider, its follow-ups, the judge and
 * "Mejorar con IA"): one pi process per call through the user's Claude subscription, behind one
 * process-wide gate, a call budget and telemetry. Memory translation is the browser's own:
 * no model translates memories any more.
 *
 * The subscription reaches pi through the pi-claude-bridge extension of gentle-shell's
 * agent home (provider `claude-bridge`). pi runs in print mode with every other
 * extension, tool, skill, context file and session off; the input goes on stdin.
 */

/** The provider the Claude bridge registers: Claude Code under the subscription, never an API key. */
export const TRANSLATE_PROVIDER = 'claude-bridge';

/** Where pi and the Claude bridge live. */
export interface PiRuntime {
  node: string;
  /** pi's CLI script, run with `node`. */
  cli: string;
  /** gentle-shell's agent home: settings, sign-ins and installed packages. */
  agentDir: string;
  /** The pi-claude-bridge package, loaded with `-e`. */
  bridge: string;
  /** An empty private folder pi runs in, so no project settings or context files apply. */
  workDir: string;
}

/**
 * gentle-shell's pi and agent home, as its launcher resolves them (GENTLE_SHELL_HOME or
 * ~/.gentle-shell/agent). MIRADOR_TRANSLATE_PI replaces the pi CLI (the tests use a fake).
 */
export function gentleShellRuntime(state: string, env = process.env): PiRuntime {
  const home = env.HOME || homedir();
  const agentDir = env.GENTLE_SHELL_HOME || join(home, '.gentle-shell', 'agent');
  return {
    node: process.execPath,
    cli: env.MIRADOR_TRANSLATE_PI || join(home, '.gentle-shell', 'current', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
    agentDir,
    bridge: join(agentDir, 'npm', 'node_modules', 'pi-claude-bridge'),
    workDir: join(state, 'translate-work'),
  };
}

/** What changes between pi print runs: the model, its thinking level and a fixed system prompt. */
export interface PiPrintOptions {
  model: string;
  systemPrompt: string;
  /** pi's thinking level (off, minimal, low, …); default off. */
  thinking?: string;
}

/**
 * pi's arguments for one print run through the Claude bridge, after `node`. The system
 * prompt is visible in the process list, so it must be fixed text: the input goes on stdin.
 */
export function piPrintArgs(runtime: PiRuntime, { model, systemPrompt, thinking = 'off' }: PiPrintOptions): string[] {
  return [
    runtime.cli,
    // pi takes the word after -p as the prompt unless it is a flag, so a flag must follow.
    '-p',
    '--no-extensions',
    '-e',
    runtime.bridge,
    '--no-tools',
    '--no-session',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-mcp',
    '--provider',
    TRANSLATE_PROVIDER,
    '--model',
    model,
    '--thinking',
    thinking,
    '--system-prompt',
    systemPrompt,
  ];
}

/**
 * Mirador's environment for pi: inherited agent variables removed (as in terminals),
 * Anthropic API variables removed so Claude Code uses the subscription, and pi pointed
 * at gentle-shell's agent home without its update check.
 */
export function piEnv(runtime: PiRuntime, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const clean = cleanEnv(env);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete clean[key];
  return { ...clean, PI_CODING_AGENT_DIR: runtime.agentDir, PI_SKIP_VERSION_CHECK: '1' };
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Why a pi run failed. Its message never holds the input or pi's output. */
export class PiRunError extends Error {
  /** `budget`: the call budget of its feature is used up, so no process was started. */
  readonly kind: 'unavailable' | 'not-started' | 'timeout' | 'too-long' | 'exit' | 'aborted' | 'budget';
  constructor(kind: PiRunError['kind'], message: string) {
    super(message);
    this.name = 'PiRunError';
    this.kind = kind;
  }
}

export interface PiRunnerOptions {
  /** Longest run once started, and longest wait for a free slot of the gate. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
  /** The cap on pi processes at once; default the process-wide piGate every runner shares. */
  gate?: PiGate;
  /** The call budget and telemetry; default the process-wide meter (configureCallMeter). */
  meter?: CallMeter;
}

/** Why a run was refused when the gate's queue is full (kind `unavailable`). */
export const PI_BUSY_MESSAGE = 'too many Claude runs are waiting';
/** Why a run was refused when its feature's call budget is used up (kind `budget`). */
export const PI_BUDGET_MESSAGE = 'the Claude call budget is used up';
/** Why a run was refused while Mirador opens agents (kind `unavailable`): each run would start one more pi. */
export const PI_LAUNCHING_MESSAGE = 'Mirador is opening agents';

/** Whether no run may start now; the server sets it to "a launch run is active" (configurePiHold). */
let processHold: () => boolean = () => false;

/**
 * Holds every runner's runs while `held()` is true (the server: while agents open): a run
 * is refused at once, before it waits for a slot and again right before its process starts, so
 * no caller queues behind the launches. null releases the hold.
 */
export function configurePiHold(held: (() => boolean) | null): void {
  processHold = held ?? (() => false);
}

function refuseWhileHeld(): void {
  let held = false;
  try {
    held = processHold() === true;
  } catch {
    held = false;
  }
  if (held) throw new PiRunError('unavailable', PI_LAUNCHING_MESSAGE);
}

/* ---------- Call budget and telemetry ---------- */

/**
 * What a Claude run is for. Every run names one: it picks the budget it is charged to
 * (improvements per day; decisions, follow-ups and reviews per night) and its telemetry line.
 * `translate` is gone: an old telemetry line with it is skipped when read.
 */
export type CallFeature = 'decide' | 'follow-up' | 'judge' | 'propose';
export const CALL_FEATURES: ReadonlySet<string> = new Set<CallFeature>(['decide', 'follow-up', 'judge', 'propose']);

/** How a run ended: `budget` and `busy` never started a process. */
export type CallOutcome = 'ok' | 'timeout' | 'error' | 'aborted' | 'budget' | 'busy';

/** One telemetry line per run. Never the prompt, the answer, memory or terminal text. */
export interface CallRecord {
  /** ISO time the run ended. */
  time: string;
  feature: CallFeature;
  model: string;
  promptVersion: string;
  /** From the call to its end, waiting for a slot included. */
  ms: number;
  outcome: CallOutcome;
  /** The UTF-8 size of the input on stdin and of the answer read (0 when none). */
  inputBytes: number;
  outputBytes: number;
}

/**
 * The budget and the telemetry every run passes through. `take` is checked and charged at
 * once (synchronously, so parallel runs never both get the last call) after the run holds a
 * gate slot and right before its process starts; false refuses the run. `record` must not throw.
 */
export interface CallMeter {
  take(feature: CallFeature): boolean;
  record(call: CallRecord): void;
}

/** No budget and no telemetry: what runs get until the server configures a meter (tests, evals). */
const OPEN_METER: CallMeter = { take: () => true, record: () => undefined };
let processMeter: CallMeter = OPEN_METER;

/** Sets the meter every runner without its own uses (the server's budget and telemetry); null resets it. */
export function configureCallMeter(meter: CallMeter | null): void {
  processMeter = meter ?? OPEN_METER;
}

function outcomeOf(error: unknown): CallOutcome {
  if (!(error instanceof PiRunError)) return 'error';
  if (error.kind === 'timeout' || error.kind === 'aborted' || error.kind === 'budget') return error.kind;
  if (error.kind === 'unavailable' && (error.message === PI_BUSY_MESSAGE || error.message === PI_LAUNCHING_MESSAGE)) return 'busy';
  return 'error';
}

const VERSION_TEXT = /^[\w.-]{1,60}$/;

export interface PiGateOptions {
  /** pi processes running at once (an integer >= 1). */
  maxConcurrent?: number;
  /** Runs waiting for a slot (an integer >= 0); more are refused at once. */
  maxQueue?: number;
}

export const DEFAULT_PI_MAX_CONCURRENT = 2;
export const DEFAULT_PI_MAX_QUEUE = 32;

interface GateWaiter {
  admit(): void;
  cancel(error: PiRunError): void;
}

/**
 * A cap on Claude processes across every caller (decider, judge, "Mejorar con IA"), on top of each
 * caller's own cap. Runs beyond `maxConcurrent` wait in a FIFO queue of `maxQueue`; a run
 * that finds the queue full is refused at once with PiRunError `unavailable`.
 */
export class PiGate {
  private maxConcurrent = DEFAULT_PI_MAX_CONCURRENT;
  private maxQueue = DEFAULT_PI_MAX_QUEUE;
  private active = 0;
  private readonly waiting: GateWaiter[] = [];

  constructor(options: PiGateOptions = {}) {
    this.configure(options);
  }

  /** Changes the caps; invalid values are ignored. A higher cap admits waiting runs at once. */
  configure({ maxConcurrent, maxQueue }: PiGateOptions): void {
    if (Number.isSafeInteger(maxConcurrent) && (maxConcurrent as number) >= 1) this.maxConcurrent = maxConcurrent as number;
    if (Number.isSafeInteger(maxQueue) && (maxQueue as number) >= 0) this.maxQueue = maxQueue as number;
    this.pump();
  }

  stats(): { active: number; waiting: number; maxConcurrent: number; maxQueue: number } {
    return { active: this.active, waiting: this.waiting.length, maxConcurrent: this.maxConcurrent, maxQueue: this.maxQueue };
  }

  /**
   * Resolves with the release function once a slot is free. Rejects with `unavailable` when
   * the queue is full, `aborted` when `signal` aborts while waiting, and `timeout` after
   * `waitMs` of waiting. `onWait` receives a cancel function while the run is queued.
   */
  acquire(options: { signal?: AbortSignal; waitMs?: number; onWait?: (cancel: (error: PiRunError) => void) => () => void } = {}): Promise<() => void> {
    const { signal, waitMs, onWait } = options;
    if (signal?.aborted) return Promise.reject(new PiRunError('aborted', 'the pi run was cancelled'));
    if (this.active < this.maxConcurrent && this.waiting.length === 0) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new PiRunError('unavailable', PI_BUSY_MESSAGE));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forget = () => {};
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        forget();
      };
      const waiter: GateWaiter = {
        admit: () => {
          done();
          resolve(this.releaser());
        },
        cancel: (error) => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          done();
          reject(error);
        },
      };
      const onAbort = () => waiter.cancel(new PiRunError('aborted', 'the pi run was cancelled'));
      this.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (waitMs !== undefined) timer = setTimeout(() => waiter.cancel(new PiRunError('timeout', 'pi waited too long for a free slot')), waitMs);
      if (onWait) forget = onWait(waiter.cancel);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.waiting.length > 0) {
      this.active++;
      (this.waiting.shift() as GateWaiter).admit();
    }
  }
}

/** The gate every runner shares unless given its own. */
export const piGate = new PiGate();

/** Sets the process-wide cap (config `maxConcurrent`); invalid values are ignored. */
export function configurePiConcurrency(options: PiGateOptions): void {
  piGate.configure(options);
}

/** What one run needs besides the input: the print options, its feature and prompt version. */
export interface PiRunOptions extends PiPrintOptions {
  feature: CallFeature;
  /** The caller's prompt version, for telemetry (letters, digits, `.`, `_`, `-`). */
  promptVersion: string;
  signal?: AbortSignal;
}

export interface PiRunner {
  /**
   * pi's raw stdout for `input` (on stdin); rejects with PiRunError. A run without a known
   * `feature` is refused (`not-started`) and one whose budget is used up fails with `budget`,
   * both before any process starts.
   */
  run(input: string, options: PiRunOptions): Promise<string>;
  /** Kills running pi processes (on shutdown). */
  close(): void;
}

/** Stops a pi run and the Claude Code process it started (its own process group). */
function stop(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const force = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, 2000);
  force.unref();
}

/**
 * Runs pi in print mode through the Claude bridge, one process (group) per call, with a
 * timeout, an output cap and an optional AbortSignal. Input and output are never logged.
 * Every run first takes a slot of the gate (default the process-wide piGate), so all
 * runners together never run more than its cap of Claude processes; then the meter charges
 * the run to its feature's budget (refused: no process) and records one telemetry line
 * when it ends, whatever the outcome.
 */
export function createPiRunner(runtime: PiRuntime, options: PiRunnerOptions = {}): PiRunner {
  const { timeoutMs = 60_000, maxOutputBytes = 256 * 1024, spawn = nodeSpawn as SpawnFn, gate = piGate } = options;
  const running = new Set<ChildProcess>();
  /** This runner's runs waiting for a slot, cancelled on close(). */
  const queued = new Set<(error: PiRunError) => void>();

  const run = async (input: string, { feature, promptVersion, ...print }: PiRunOptions): Promise<string> => {
    if (!CALL_FEATURES.has(feature)) throw new PiRunError('not-started', 'a Claude run needs a known feature tag');
    const meter = options.meter ?? processMeter;
    const started = performance.now();
    const note = (outcome: CallOutcome, outputBytes = 0) => {
      try {
        meter.record({
          time: new Date().toISOString(),
          feature,
          model: print.model,
          promptVersion: VERSION_TEXT.test(promptVersion) ? promptVersion : 'unknown',
          ms: Math.max(0, Math.round(performance.now() - started)),
          outcome,
          inputBytes: Buffer.byteLength(input, 'utf8'),
          outputBytes,
        });
      } catch {
        // Telemetry never stops a run.
      }
    };
    try {
      const output = await execute(input, feature, meter, print);
      note('ok', Buffer.byteLength(output, 'utf8'));
      return output;
    } catch (error) {
      note(outcomeOf(error));
      throw error;
    }
  };

  const execute = async (input: string, feature: CallFeature, meter: CallMeter, { signal, ...print }: PiPrintOptions & { signal?: AbortSignal }): Promise<string> => {
    if (signal?.aborted) throw new PiRunError('aborted', 'the pi run was cancelled');
    refuseWhileHeld();
    try {
      await access(runtime.cli);
      await access(runtime.bridge);
    } catch {
      throw new PiRunError('unavailable', 'gentle-shell pi or its Claude bridge is not installed');
    }
    await mkdir(runtime.workDir, { recursive: true, mode: 0o700 });
    await chmod(runtime.workDir, 0o700);
    if (signal?.aborted) throw new PiRunError('aborted', 'the pi run was cancelled');
    const release = await gate.acquire({
      signal,
      waitMs: timeoutMs,
      onWait: (cancel) => {
        queued.add(cancel);
        return () => queued.delete(cancel);
      },
    });
    if (signal?.aborted) {
      release();
      throw new PiRunError('aborted', 'the pi run was cancelled');
    }
    try {
      refuseWhileHeld();
    } catch (error) {
      release();
      throw error;
    }
    // Checked and charged in one synchronous step, right before the process: fail closed.
    let granted = false;
    try {
      granted = meter.take(feature) === true;
    } catch {
      granted = false;
    }
    if (!granted) {
      release();
      throw new PiRunError('budget', PI_BUDGET_MESSAGE);
    }

    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(runtime.node, piPrintArgs(runtime, print), {
          cwd: runtime.workDir,
          env: piEnv(runtime),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          detached: true,
          windowsHide: true,
        });
      } catch (error) {
        // The slot is not held by a process that never started.
        release();
        throw error;
      }
      running.add(child);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const onAbort = () => fail(new PiRunError('aborted', 'the pi run was cancelled'));
      const finish = (error: PiRunError | null, value = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        running.delete(child);
        release();
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (error: PiRunError) => {
        if (settled) return;
        stop(child);
        finish(error);
      };
      const timer = setTimeout(() => fail(new PiRunError('timeout', 'pi timed out')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutputBytes) return fail(new PiRunError('too-long', "pi's answer was too long"));
        chunks.push(Buffer.from(chunk));
      });
      // Drained so pi never blocks on a full pipe; it may echo the input, so it is never logged.
      child.stderr?.resume();
      child.on('error', () => finish(new PiRunError('not-started', 'pi could not be started')));
      child.on('close', (code: number | null) => {
        if (code !== 0) return finish(new PiRunError('exit', `pi exited with ${code ?? 'a signal'}`));
        finish(null, Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  };

  return {
    run,
    close: () => {
      for (const cancel of [...queued]) cancel(new PiRunError('aborted', 'the pi run was cancelled'));
      for (const child of running) stop(child);
      running.clear();
    },
  };
}
