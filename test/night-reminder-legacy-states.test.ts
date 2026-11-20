// Pins the reminder outputs for the states that existed before `error` joined them, and that
// an agent in error is counted once: in "falló/fallaron", never also in "te espera".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderNotice } from '../src/night/schedule.ts';
const publicModule = (path: string) => import(new URL(`../public/${path}`, import.meta.url).href);
const { bedtimeView, bedtimeRow } = (await publicModule('features/night-model.js')) as any;
const agent = (state: string, connected = true) => ({ terminalId: state + connected, rel: '', title: '', state, connected, activity: null, waitingFor: null, closingQuestion: null, task: null });
const content = (agents: any[]) => ({ time: 'x', waiting: 0, pending: [], workspaces: [{ workspaceId: 'ops', name: 'Ops', hasMission: true, missionNote: null, agents }] });
const win = { start: '2026-10-29T02:00:00.000Z', end: '2026-10-29T10:00:00.000Z' };

test('notice for blocked/prompt/finished/working/offline agents is unchanged', () => {
  const body = reminderNotice({ window: win, content: content([agent('blocked'), agent('prompt'), agent('finished'), agent('working'), agent('working', false)]) } as any, 'America/Santiago').body;
  assert.equal(body.split('\n')[1], 'Ops: 5 agentes (2 te esperan, 1 terminó, 1 sin conexión)');
});

test('an error agent is counted once: failed, never te espera; needsYou = blocked + prompt + error', () => {
  const agents = [agent('blocked'), agent('blocked'), agent('prompt'), agent('error'), agent('error'), agent('error'), agent('finished')];
  const body = reminderNotice({ window: win, content: content(agents) } as any, 'America/Santiago').body;
  assert.equal(body.split('\n')[1], 'Ops: 7 agentes (3 te esperan, 3 fallaron, 1 terminó)');
  assert.equal(bedtimeView(content(agents), [])[0].needsYou, 6);
  for (const [state, open] of [['blocked', true], ['prompt', true], ['error', true], ['finished', false], ['working', false]] as const) assert.equal(bedtimeRow({ state }).open, open, state);
});
