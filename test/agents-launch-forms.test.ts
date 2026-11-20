// Every configured agentCommand form launches, restores and wakes as at
// main 9ba935d with no agent id; a chosen agent runs its catalog line without the global bridge args.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalRequest } from '../src/terminals/registry.ts';
import { agentLaunch } from '../src/agents/catalog.ts';
import { bridgeArgs, resumeArgs } from '../src/attention/agent-args.ts';

const pty: PtyProcess = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
function launchLine(agentCommand: string, request: Partial<TerminalRequest> = {}): string | undefined {
  let env: Record<string, string> = {};
  const spawn: SpawnFn = (_file, _args, opts) => { env = opts.env; return pty; };
  const registry = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand, agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/h', PATH: '/usr/bin' }, scrollbackLimit: 100, scopes: false });
  registry.addAgentArgs(bridgeArgs(agentCommand, '/app/bridge.ts'));
  registry.create({ cwd: '/w/alpha', kind: 'agent', cols: 90, rows: 33, workspaceId: 'dev', rel: 'alpha', ...request });
  return env.MIRADOR_AGENT_COMMAND;
}
// What server.ts composes for a restore or wake: the record's agent (or none) and its session file.
const restoreLine = (agentCommand: string, file: string, agent?: string) => {
  const launch = agent ? agentLaunch(agent, agentCommand) : null;
  return launchLine(agentCommand, { agentArgs: resumeArgs(launch?.agentCommand || agentCommand, file), ...(launch ?? {}) });
};
const FORMS: [string, string][] = [
  ['gentle-shell', "gentle-shell '-e' '/app/bridge.ts'"],
  ['pi --thinking high', "pi --thinking high '-e' '/app/bridge.ts'"],
  ['/opt/gentle/bin/gentle-shell', "/opt/gentle/bin/gentle-shell '-e' '/app/bridge.ts'"],
  ['my-agent --x', 'my-agent --x'],
];

test('S3: with no agent id every agentCommand form launches and restores exactly as at the baseline', () => {
  for (const [command, line] of FORMS) {
    const resume = command === 'my-agent --x' ? '' : " '--session' '/s/old.jsonl'";
    assert.equal(launchLine(command), line, command);
    assert.equal(restoreLine(command, '/s/old.jsonl'), line + resume, `${command} restore`);
    assert.equal(restoreLine(command, '/s/old.jsonl', 'pi'), command === 'my-agent --x' ? "gentle-shell '--session' '/s/old.jsonl'" : line + resume, `${command} pi record`);
  }
});

test('S4: another chosen agent runs its catalog line without the global bridge args and never resumes', () => {
  for (const [command] of FORMS) {
    assert.equal(launchLine(command, agentLaunch('claude-code', command)!), 'claude', command);
    assert.equal(restoreLine(command, '/s/c.jsonl', 'claude-code'), 'claude', `${command} restore`);
  }
  assert.equal(agentLaunch('nope', 'gentle-shell'), null);
});

test('S3/S8: a session id never resumes a file-resumed agent, and a file never resumes an id-resumed one', () => {
  const ID = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';
  for (const command of ['gentle-shell', 'pi --thinking high', '/opt/gentle/bin/gentle-shell']) {
    assert.deepEqual(resumeArgs(command, ID), [], `${command}: an id is no session file`);
    assert.deepEqual(resumeArgs(command, '/s/old.jsonl'), ['--session', '/s/old.jsonl'], command);
  }
  assert.deepEqual(resumeArgs('claude', '/s/old.jsonl'), []);
  assert.deepEqual(resumeArgs('claude', ID), ['--resume', ID]);
});
