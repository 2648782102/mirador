// The fixes that brought `pnpm typecheck:src` to 0 change types
// only. These pin the runtime output of the two that touched expressions: GET /api/resources (TS2783, a
// duplicated `at`) and the live card summary of a decided night question (TS18048, `choices` optional).
// Fake context, fake clock, fake decider and link; no server, no model, no socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import type { AppContext } from '../src/http/context.ts';
import { SAMPLE_MS, createResourceRoutes } from '../src/http/routes/resources.ts';
import { NightService, type NightLink } from '../src/night/service.ts';
import type { NightRecord } from '../src/night/log.ts';
import type { MiradorLine, NightQuestion } from '../src/night/protocol.ts';
import type { NightTerminalState } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

const NOW = Date.UTC(2026, 10, 13, 9, 30, 0);

/** The raw JSON text GET /api/resources sends when the sample fails (emptySnapshot at NOW): fully deterministic. */
async function resourcesBody(platform: NodeJS.Platform): Promise<string> {
  const ctx = {
    terminals: {
      list: () => {
        throw new Error('no terminals');
      },
    },
    onShutdown: () => {},
  } as unknown as AppContext;
  const routes = await createResourceRoutes({ roots: { sys: '/nonexistent/sys', proc: '/nonexistent/proc' }, platform, now: () => NOW, schedule: () => () => {} })(ctx);
  const route = routes.find((r) => r.method === 'GET' && r.path === '/api/resources');
  assert.ok(route);
  let body = '';
  const res = { headersSent: false, writeHead: () => res, end: (chunk?: unknown) => ((body = String(chunk ?? '')), res) };
  const error = console.error;
  console.error = () => {};
  try {
    await route.handler({ req: {} as never, res: res as unknown as ServerResponse, url: new URL('http://127.0.0.1/api/resources'), params: {} });
  } finally {
    console.error = error;
  }
  return body;
}

const EMPTY_SAMPLE =
  '"cpuWindowMs":null,"machine":{"memTotal":null,"memAvailable":null,"swapTotal":null,"swapFree":null},' +
  '"server":{"rss":null,"swap":null},"terminals":[],"outside":{"count":0,"memory":0,"swap":0,"processes":[],"truncated":false}';

test('GET /api/resources sends `at` (the sample time) first, then sampleMs, then the rest of the sample, byte for byte', async () => {
  const at = new Date(NOW).toISOString();
  assert.equal(await resourcesBody('linux'), `{"at":"${at}","sampleMs":${SAMPLE_MS},${EMPTY_SAMPLE}}`);
});

test('on macOS the same body ends with limits', async () => {
  const at = new Date(NOW).toISOString();
  assert.equal(await resourcesBody('darwin'), `{"at":"${at}","sampleMs":${SAMPLE_MS},${EMPTY_SAMPLE},"limits":{"available":false,"reason":"macos"}}`);
});

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function nightSetup(choices: number[]) {
  const spawn: SpawnFn = () => new FakePty();
  const terminals = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const sent: Array<[string, MiradorLine]> = [];
  const connected = new Set<string>();
  const link: NightLink = {
    send: (id, line) => (connected.has(id) ? (sent.push([id, line]), true) : false),
    isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected],
  };
  const records: NightRecord[] = [];
  const service = new NightService({
    link,
    decider: {
      decide: async () => ({ action: 'answer', choices, reason: 'The mission prefers lists.', confidence: 0.9 }),
      followUp: async () => ({ action: 'follow-up', message: 'Run the tests.', reason: 'Tests were not run.', confidence: 0.8 }),
    },
    log: { append: async (record) => void records.push(record) },
    terminals,
    workspaces: { get: (id: string) => (id === 'dev' ? { id: 'dev', name: 'Dev', root: '/dev', folders: [], expanded: [], mission: 'Ship the night shift.' } : undefined) },
    attention: () => ({ items: () => [] }),
    decideBudgetMs: 2000,
    deliveryTimeoutMs: 2000,
  });
  const id = terminals.create({ cwd: '/dev/alpha', kind: 'agent', cols: 80, rows: 24, workspaceId: 'dev', rel: 'alpha' }).id;
  connected.add(id);
  const states: NightTerminalState[] = [];
  service.onTerminalState((state) => states.push(state));
  return { service, id, sent, records, states };
}

const item = (labels: string[], text: string): NightQuestion['items'][number] => ({ question: text, header: '', multiSelect: false, options: labels.map((label) => ({ label, description: `${label} view` })) });

test('a decided question resolves its live card with the chosen labels, the same ones its record keeps', async () => {
  const s = nightSetup([1, 0]);
  s.service.setActive(true);
  const question: NightQuestion = {
    terminalId: s.id,
    toolCallId: 'call-1',
    tool: 'ask_user_choice',
    allowCustomResponse: false,
    items: [item(['Grid', 'List'], 'Which layout should the report use?'), item(['Light', 'Dark'], 'Which theme should it use?')],
  };
  await s.service.question(s.id, 'r1', question);

  assert.equal(s.sent.at(-1)?.[1].type, 'decided');
  const resolved = s.states.filter((state) => state.state === 'resolved');
  assert.deepEqual(resolved.map((state) => [state.flow, state.summary]), [['question', 'List, Light']]);
  const record = s.records.find((r) => r.outcome === 'decided');
  assert.deepEqual(record?.decision?.choices, [
    { item: 0, index: 1, label: 'List' },
    { item: 1, index: 0, label: 'Light' },
  ]);
  s.service.setActive(false);
});

test('deliverNotesNow hands back the very promise noteDelivery then reports', async () => {
  const s = nightSetup([0]);
  s.service.setActive(true);
  const delivering = s.service.deliverNotesNow();
  assert.equal(delivering, s.service.noteDelivery);
  await delivering;
  s.service.setActive(false);
});
