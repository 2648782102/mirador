// A record the
// restore left after Pausar must not reopen a folder that the user opened by hand meanwhile, or the
// next restart runs two agents there. Real OpenAgents and registry, fake pty, real files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAgents } from '../src/terminals/open-agents.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';
import { LaunchGate } from '../src/system/memory-gate.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-paused-folder-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function registry() {
  const spawn: SpawnFn = () => new FakePty();
  return new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/run/mirador/agent.bashrc', env: {}, scrollbackLimit: 1000 });
}

const agent = (rel: string) => ({ cwd: `/w/${rel}`, kind: 'agent' as const, cols: 100, rows: 30, workspaceId: 'dev', rel });
const resolveFolder = async (workspaceId: string, rel: string) => ({ workspace: { id: workspaceId }, rel, path: `/w/${rel}` });
const openRels = (r: TerminalRegistry) => r.list().filter((t) => t.kind === 'agent' && t.status === 'running').map((t) => t.rel).sort();

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('after Pausar, a folder opened by hand is not reopened a second time by the next restore', async () => {
  const owner = join(scratch, 'config.json');
  await writeFile(owner, '{}');
  await mkdir(join(scratch, 'state'), { recursive: true });
  const file = join(scratch, 'state', 'open-agents.json');
  const log = () => undefined;

  // Run 1: three agents open, then the server stops (records kept).
  const first = await OpenAgents.load(file, { owner, log });
  const r1 = registry();
  first.track(r1);
  for (const rel of ['p1', 'p2', 'p3']) r1.create(agent(rel));
  first.keep();
  await first.flush();

  // Run 2: the restore opens one agent per settle; the user presses Pausar after the first.
  const second = await OpenAgents.load(file, { owner, log });
  const r2 = registry();
  second.track(r2);
  const gate = new LaunchGate({
    limits: { batchSize: 1, settleMs: 60_000, reserveBytes: 0 },
    readMemory: async () => ({ memTotal: 1, memAvailable: 1 }),
    sleep: (_ms, signal) => new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }))),
  });
  const restoring = second.restore({ registry: r2, resolveFolder, sessionArgs: () => [], sleep: async () => undefined, gate });
  await waitFor(() => openRels(r2).length === 1);
  assert.equal(gate.cancel(gate.status().runs[0].id), true);
  assert.deepEqual(await restoring, { restored: 1, dropped: 0 });
  assert.deepEqual(openRels(r2), ['p1']);
  // The user opens p2 by hand, as Pausar invites ("quedan por abrir a mano"), then stops Mirador.
  r2.create(agent('p2'));
  second.keep();
  await second.flush();

  // Run 3: the restore must give p2 one agent, not the paused record plus the hand-opened one.
  const third = await OpenAgents.load(file, { owner, log });
  const r3 = registry();
  third.track(r3);
  await third.restore({ registry: r3, resolveFolder, sessionArgs: () => [], sleep: async () => undefined });
  await third.flush();
  assert.deepEqual(openRels(r3), ['p1', 'p2', 'p3']);
});
