// Every state a tracking card can be in has the line public/features/tracking.js builds from it
// (`tracking.since.<state>`, a key made at run time, so i18n-keys-used.test.ts cannot see it), in
// English and Spanish. F2 added the `error` state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES } from '../public/i18n.js';
import { buildTracking } from '../public/features/tracking-model.js';

const NOW = Date.parse('2026-10-28T15:00:00Z');
const KINDS = ['blocked', 'prompt', 'finished', 'error'];

test('each running state a tracking card shows has its "since" line in English and Spanish', () => {
  const terminals = [...KINDS, 'none'].map((kind) => ({ id: kind, workspaceId: 'dev', rel: 'x', cwd: '/x', title: kind, kind: 'agent', status: 'running', createdAt: '2026-10-28T13:00:00Z' }));
  const items = KINDS.map((kind) => ({ terminalId: kind, workspaceId: 'dev', rel: 'x', title: kind, kind, label: kind === 'error' ? 'Error' : 'Label', detail: null, since: '2026-10-28T14:00:00Z', activity: null }));
  const model = buildTracking({ terminals, items, activity: [], now: NOW });
  const states = [...new Set(model.workspaces.flatMap((w: any) => w.folders.flatMap((f: any) => f.agents.map((a: any) => a.state))))].sort();
  assert.deepEqual(states, ['error', 'finished', 'waiting', 'working']);
  const messages = MESSAGES as Record<string, Record<string, string>>;
  for (const state of states) {
    const key = `tracking.since.${state}`;
    for (const lang of ['en', 'es']) {
      assert.equal(typeof messages[lang][key], 'string', `${key} (${lang})`);
      assert.match(messages[lang][key], /\{time\}/, `${key} (${lang}) names the time`);
    }
    assert.notEqual(messages.es[key], messages.en[key], `${key} is translated`);
  }
});

test('an agent that stopped with an error reads "failed … ago" / "falló hace …", not as a wait', () => {
  assert.equal(MESSAGES.en['tracking.since.error'], 'failed {time} ago');
  assert.equal(MESSAGES.es['tracking.since.error'], 'falló hace {time}');
  assert.notEqual(MESSAGES.es['tracking.since.error'], MESSAGES.es['tracking.since.waiting']);
});
