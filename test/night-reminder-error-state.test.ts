// An agent stopped with an error in the bedtime reminder:
// it waits for the user like a blocked one (docs/attention.md), so the reminder gives it its own
// `error` state and counts it in `waiting`, the Telegram/desktop notice says it failed, and the
// "Antes de dormir" dialog counts it, opens its row and labels its chip "Falló" / "Failed".
// Fake bridge link, real terminal registry over fake ptys; no model, no socket, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NightService, type NightLink } from '../src/night/service.ts';
import { reminderNotice } from '../src/night/schedule.ts';
import type { AttentionItem } from '../src/attention/store.ts';
import { TerminalRegistry, type PtyProcess, type SpawnFn } from '../src/terminals/registry.ts';

// The browser models are untyped JS; a computed specifier keeps them `any` for tsc.
type Agent = { state: string };
type Translate = (language: string, key: string, vars?: Record<string, unknown>) => string;
type NightModel = {
  bedtimeView: (reminder: unknown, notes: unknown[]) => Array<{ workspaceId: string; needsYou: number }>;
  bedtimeRow: (agent: Agent, flags?: { noted?: boolean; proposed?: boolean }) => { status: string; open: boolean };
};
const publicModule = (path: string) => import(new URL(`../public/${path}`, import.meta.url).href);
const { translate } = (await publicModule('i18n.js')) as { translate: Translate };
const { bedtimeView, bedtimeRow } = (await publicModule('features/night-model.js')) as NightModel;

class FakePty implements PtyProcess {
  onData() {}
  onExit() {}
  write() {}
  resize() {}
  kill() {}
}

function setup() {
  const spawn: SpawnFn = () => new FakePty();
  const terminals = new TerminalRegistry(spawn, { shell: '/bin/bash', agentCommand: 'gentle-shell', agentRcFile: '/rc', env: {}, scrollbackLimit: 64 * 1024 });
  const connected = new Set<string>();
  const link: NightLink = {
    send: () => false,
    isConnected: (id) => connected.has(id),
    connectedTerminals: () => [...connected],
  };
  let items: AttentionItem[] = [];
  const service = new NightService({
    link,
    decider: { decide: async () => ({ action: 'defer', reason: 'not used' }), followUp: async () => ({ action: 'defer', reason: 'not used' }) },
    log: { append: async () => {} },
    terminals,
    workspaces: { get: (id: string) => (id === 'ops' ? { id: 'ops', name: 'Ops', root: '/ops', folders: [], expanded: [], mission: 'Keep it green.' } : undefined) },
    attention: () => ({ items: () => items }),
  });
  const open = (rel: string) => {
    const info = terminals.create({ cwd: `/ops/${rel}`, kind: 'agent', cols: 80, rows: 24, workspaceId: 'ops', rel });
    connected.add(info.id);
    return info.id;
  };
  const item = (terminalId: string, kind: AttentionItem['kind'], label: string, detail: string | null = null): AttentionItem => ({
    terminalId, workspaceId: 'ops', rel: terminals.get(terminalId)!.rel, title: 'agent', kind, label, detail, since: new Date().toISOString(), activity: null,
  });
  return { service, open, item, setItems: (next: AttentionItem[]) => { items = next; }, close: () => service.close() };
}

test('an agent stopped with an error is its own reminder state and waits for the user like a blocked one', () => {
  const s = setup();
  try {
    const failed = s.open('api');
    const blocked = s.open('web');
    s.open('docs');
    s.setItems([s.item(failed, 'error', 'Stopped with an error', 'npm test exited 1'), s.item(blocked, 'blocked', 'Needs you')]);
    const reminder = s.service.reminder();
    const agents = reminder.workspaces[0].agents;
    assert.deepEqual(agents.map((agent) => [agent.rel, agent.state, agent.waitingFor]), [
      ['api', 'error', 'npm test exited 1'],
      ['web', 'blocked', 'Needs you'],
      ['docs', 'working', null],
    ]);
    assert.equal(reminder.waiting, 2, 'the failed agent waits for the user like the blocked one');
  } finally {
    s.close();
  }
});

test('the bedtime notice says how many agents failed, next to the ones that wait and finished', () => {
  const agent = (state: string) => ({ terminalId: state, rel: '', title: '', state, connected: true, activity: null, waitingFor: null, closingQuestion: null, task: null });
  const notice = reminderNotice(
    {
      window: { start: '2026-10-29T02:00:00.000Z', end: '2026-10-29T10:00:00.000Z' },
      content: {
        time: '2026-10-29T01:30:00.000Z',
        waiting: 4,
        pending: [],
        workspaces: [
          { workspaceId: 'ops', name: 'Ops', hasMission: true, missionNote: null, agents: [agent('error'), agent('blocked'), agent('finished')] },
          { workspaceId: 'dev', name: 'Dev', hasMission: true, missionNote: null, agents: [agent('error'), agent('error')] },
        ],
      },
    },
    'America/Santiago',
  );
  assert.deepEqual(notice.body.split('\n').slice(1, 3), ['Ops: 3 agentes (1 te espera, 1 falló, 1 terminó)', 'Dev: 2 agentes (2 fallaron)']);
});

test('"Antes de dormir" counts a failed agent among those that need the user, opens its row and labels its chip', () => {
  const reminder = { workspaces: [{ workspaceId: 'ops', name: 'Ops', hasMission: true, agents: [{ terminalId: 'a', rel: 'api', state: 'error' }, { terminalId: 'b', rel: 'web', state: 'blocked' }, { terminalId: 'c', rel: 'docs', state: 'working' }] }] };
  assert.equal(bedtimeView(reminder, [])[0].needsYou, 2);
  assert.deepEqual(bedtimeRow({ state: 'error' }), { status: 'none', open: true });
  assert.deepEqual(bedtimeRow({ state: 'blocked' }), { status: 'none', open: true }, 'a blocked row still opens');
  assert.deepEqual(bedtimeRow({ state: 'finished' }), { status: 'none', open: false }, 'a finished row still starts closed');
  assert.equal(translate('es', 'night.bedtime.state.error'), 'Falló');
  assert.equal(translate('en', 'night.bedtime.state.error'), 'Failed');
  assert.equal(translate('es', 'night.bedtime.state.blocked'), 'Te espera', 'the sibling labels are unchanged');
  assert.match(readFileSync(new URL('../public/features/night.js', import.meta.url), 'utf8'), /night-state-\$\{agent\.state\}.*night\.bedtime\.state\.\$\{agent\.state\}/, 'the chip takes its class and label from the state');
  assert.match(readFileSync(new URL('../public/styles/night.css', import.meta.url), 'utf8'), /\.night-state-error\s*\{[^}]*var\(--danger\)/, 'the failed chip has its own colour');
});
