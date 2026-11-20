// kimi (Kimi Code CLI) stays launch-only. Its `[[hooks]]` come only from
// `$KIMI_CODE_HOME/config.toml` and installed plugins (https://moonshotai.github.io/kimi-code/en/customization/hooks),
// with no flag, variable or project file that adds hooks for one launch, and KIMI_CODE_HOME moves the user's config,
// credentials and sessions with it (https://moonshotai.github.io/kimi-code/en/configuration/env-vars). So kimi gets
// no bridge and no variable, configured or chosen, never resumes with `--session <id>` (no hook reports an id), and
// Pi's, claude's, opencode's and agy's forms stay exactly as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, agentLaunch, offeredAgents } from '../src/agents/catalog.ts';
import { bridgeArgs, bridgeEnvProvider, resumeArgs } from '../src/attention/agent-args.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn, type TerminalRequest } from '../src/terminals/registry.ts';

const SETTINGS = '/run/mirador/herdr/claude-settings.json';
const CONTENT = '{"plugins":["/run/mirador/herdr/opencode-plugin"]}';
const FOLDER = '/run/mirador/herdr/agy-workspace';
// A kimi entry here too: even a bridge handed in by mistake never reaches kimi, which has no bridge flag.
const BRIDGES = { pi: '/app/bridge.ts', 'claude-code': SETTINGS, opencode: CONTENT, antigravity: FOLDER, kimi: '/run/mirador/herdr/kimi-config.toml' };
// Session ids as kimi's docs show them (https://moonshotai.github.io/kimi-code/en/reference/kimi-command, /en/customization/hooks).
const IDS = ['01HZQ3V7K8M2N4P6R8T0W2Y4A6', 'abc123', 'session_abc', 'ec33ebf9-0cba-4100-8142-c61503f6c587'];

const pty: PtyProcess = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
/** The full spawn environment of a terminal, with the bridges as inbox.ts adds them. */
function spawnEnv(agentCommand: string, request: Partial<TerminalRequest> = {}, enabled = true): Record<string, string> {
  let env: Record<string, string> = {};
  const spawnPty: SpawnFn = (_file, _args, opts) => { env = opts.env; return pty; };
  const registry = new TerminalRegistry(spawnPty, { shell: '/bin/bash', agentCommand, agentRcFile: '/run/mirador/agent.bashrc', env: { HOME: '/h', PATH: '/usr/bin' }, scrollbackLimit: 100, scopes: false });
  registry.addAgentArgs(bridgeArgs(agentCommand, BRIDGES, enabled));
  registry.addEnvProvider(bridgeEnvProvider(agentCommand, BRIDGES, enabled));
  registry.addChosenAgentArgs('claude-code', bridgeArgs('claude', BRIDGES, enabled));
  registry.addChosenAgentArgs('opencode', bridgeArgs('opencode', BRIDGES, enabled));
  registry.addChosenAgentArgs('antigravity', bridgeArgs('agy', BRIDGES, enabled));
  registry.create({ cwd: '/w/alpha', kind: 'agent', cols: 90, rows: 33, workspaceId: 'dev', rel: 'alpha', ...request });
  return env;
}
const line = (agentCommand: string, request: Partial<TerminalRequest> = {}, enabled = true) => spawnEnv(agentCommand, request, enabled).MIRADOR_AGENT_COMMAND;
const restore = (agentCommand: string, key: string, agent?: string) => {
  const chosen = agent ? agentLaunch(agent, agentCommand) : null;
  return line(agentCommand, { agentArgs: resumeArgs(chosen?.agentCommand || agentCommand, key), ...(chosen ?? {}) });
};

test('kimi has no attention, no bridge and no verified resume, so no session id ever resumes it', async () => {
  const kimi = AGENTS.find((agent) => agent.id === 'kimi');
  assert.deepEqual(kimi, { id: 'kimi', label: 'Kimi', binary: 'kimi', aliases: [], launch: ['kimi'], resume: null, resumeKey: 'id', attention: 'none', bridgeFlag: null });
  for (const key of [...IDS, '/s/old.jsonl', '-c', '--continue', '--session', '']) {
    assert.deepEqual(resumeArgs('kimi', key), [], JSON.stringify(key));
    assert.deepEqual(resumeArgs('kimi --model kimi-for-coding', key), [], JSON.stringify(key));
  }
  assert.deepEqual(bridgeArgs('kimi', BRIDGES), []);
  assert.deepEqual(bridgeArgs('kimi', '/app/bridge.ts'), []);
  // GET /api/agents says so: the configured kimi neither reports nor resumes.
  const [configured] = await offeredAgents({ agentCommand: 'kimi', env: { PATH: '', GENTLE_AI_HOME: '/nonexistent' } });
  assert.deepEqual(configured, { id: 'kimi', label: 'Kimi', command: 'kimi', configured: true, attention: 'none', resume: false });
});

test('kimi starts exactly as configured or chosen, with no added words or variables, and a restore starts it fresh', () => {
  assert.equal(line('kimi'), 'kimi');
  assert.equal(line('kimi', { agent: 'kimi' }), 'kimi');
  assert.equal(line('kimi --model kimi-for-coding'), 'kimi --model kimi-for-coding');
  assert.equal(line('gentle-shell', agentLaunch('kimi', 'gentle-shell')!), 'kimi');
  assert.equal(line('claude', agentLaunch('kimi', 'claude')!), 'kimi');
  for (const id of IDS) {
    assert.equal(restore('kimi', id), 'kimi', `configured, ${id}`);
    assert.equal(restore('gentle-shell', id, 'kimi'), 'kimi', `chosen, ${id}`);
  }
  assert.equal(restore('gentle-shell', '/s/old.jsonl', 'kimi'), 'kimi', 'a pi session file is no kimi session');
  // attentionBridge: false changes nothing for kimi.
  assert.equal(line('kimi', {}, false), 'kimi');
  assert.equal(line('gentle-shell', agentLaunch('kimi', 'gentle-shell')!, false), 'kimi');
  // The spawn environment is a plain agent's: no KIMI_CODE_HOME, no config layer, nothing but the command line differs.
  const plain = spawnEnv('my-agent');
  for (const env of [spawnEnv('kimi'), spawnEnv('gentle-shell', agentLaunch('kimi', 'gentle-shell')!), spawnEnv('opencode', agentLaunch('kimi', 'opencode')!)]) {
    assert.deepEqual({ ...env, MIRADOR_AGENT_COMMAND: 'my-agent' }, plain);
    assert.equal(Object.keys(env).some((name) => name.startsWith('KIMI')), false);
  }
});

test('pi, claude, opencode and agy keep their forms beside kimi', () => {
  assert.equal(line('gentle-shell'), "gentle-shell '-e' '/app/bridge.ts'");
  assert.equal(line('pi --thinking high'), "pi --thinking high '-e' '/app/bridge.ts'");
  assert.equal(restore('gentle-shell', '/s/old.jsonl'), "gentle-shell '-e' '/app/bridge.ts' '--session' '/s/old.jsonl'");
  assert.equal(restore('kimi', '/s/old.jsonl', 'pi'), "gentle-shell '--session' '/s/old.jsonl'");
  assert.equal(restore('kimi', IDS[0], 'claude-code'), `claude '--settings' '${SETTINGS}' '--resume' '${IDS[0]}'`);
  const opencode = spawnEnv('kimi', agentLaunch('opencode', 'kimi')!);
  assert.deepEqual([opencode.MIRADOR_AGENT_COMMAND, opencode.OPENCODE_CONFIG_CONTENT], ["opencode '--standalone'", CONTENT]);
  assert.equal(restore('kimi', IDS[3], 'antigravity'), `agy '--add-dir' '${FOLDER}' '--conversation' '${IDS[3]}'`);
  assert.equal(line('kimi', { kind: 'shell' }), undefined);
});
