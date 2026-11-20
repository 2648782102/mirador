// Pure rules behind Mirador's proposals from memory (public/features/proposals-model.js):
// the instruction "Delegar a Mirador" opens with, built
// from each folder's latest Next Steps, and the bedtime notes proposed per open agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedtimeProposals, bedtimeSources, improveRequest, improver, proposalAsks, proposalFreshness, proposalText, refreshedProposal } from '../public/features/proposals-model.js';
import { translate } from '../public/i18n.js';
import { MAX_INSTRUCTION } from '../public/features/delegate-model.js';
import { adoptInstruction } from '../public/features/adopt-model.js';

const LEAD = 'Continúa desde los Next Steps de tu última sesión:';

test('one folder with Next Steps proposes the lead and its steps, as "Traer a Mirador" does', () => {
  const text = proposalText([{ label: 'api', steps: '- write the route\n- run the tests' }], LEAD, MAX_INSTRUCTION);
  assert.equal(text, `${LEAD}\n\n- write the route\n- run the tests`);
  assert.equal(text, adoptInstruction('- write the route\n- run the tests', LEAD));
});

test('several folders get one labelled section each, in the order given', () => {
  const text = proposalText([{ label: 'api', steps: '- route' }, { label: 'web', steps: '- page\n- tests' }], LEAD, MAX_INSTRUCTION);
  assert.equal(text, `${LEAD}\n\napi:\n- route\n\nweb:\n- page\n- tests`);
});

test('several long folders are clipped fairly so the whole proposal fits the limit', () => {
  const long = (name: string) => Array.from({ length: 300 }, (_, i) => `- ${name} step ${i}`).join('\n');
  const text = proposalText([{ label: 'api', steps: long('api') }, { label: 'short', steps: '- one step' }, { label: 'web', steps: long('web') }], LEAD, MAX_INSTRUCTION);
  assert.ok(text.length <= MAX_INSTRUCTION, `length ${text.length}`);
  const sections = text.slice(LEAD.length + 2).split('\n\n');
  assert.deepEqual(sections.map((s) => s.split('\n')[0]), ['api:', 'short:', 'web:']);
  assert.equal(sections[1], 'short:\n- one step', 'a short section is kept whole');
  const [api, web] = [sections[0], sections[2]];
  assert.ok(api.endsWith('…') && web.endsWith('…'), 'the long ones say they were clipped');
  assert.ok(Math.abs(api.length - web.length) <= 30, `fair shares: ${api.length} and ${web.length}`);
  assert.ok(api.length > 800, 'the room the short one left goes to the long ones');
});

test('a folder without Next Steps contributes nothing; no folder with steps proposes nothing', () => {
  assert.equal(proposalText([{ label: 'api', steps: null }, { label: 'web', steps: '- page' }], LEAD, MAX_INSTRUCTION), `${LEAD}\n\n- page`);
  assert.equal(proposalText([{ label: 'api', steps: null }, { label: 'web', steps: '  \n ' }], LEAD, MAX_INSTRUCTION), '');
  assert.equal(proposalText([], LEAD, MAX_INSTRUCTION), '');
});

/* ---------- Antes de dormir ---------- */

const REMINDER = {
  workspaces: [
    { workspaceId: 'dev', agents: [{ terminalId: 't1', rel: 'api' }, { terminalId: 't2', rel: 'web' }, { terminalId: 't3', rel: 'api' }] },
    { workspaceId: 'ops', agents: [{ terminalId: 't4', rel: '' }] },
    { workspaceId: 'empty', agents: [] },
  ],
};

test('proposalAsks asks each workspace once for the folders of its open agents', () => {
  assert.deepEqual(proposalAsks(REMINDER), [{ ws: 'dev', rels: ['api', 'web'] }, { ws: 'ops', rels: [''] }]);
  assert.deepEqual(proposalAsks(REMINDER, new Set(['t1', 't3', 't4'])), [{ ws: 'dev', rels: ['web'] }], 'agents already proposed are not asked again');
  assert.deepEqual(proposalAsks(null), []);
});

test('bedtime proposes one note per open agent whose folder has Next Steps', () => {
  const answers = [
    { ws: 'dev', proposals: [{ rel: 'api', nextSteps: '- finish the route' }, { rel: 'web', nextSteps: null }] },
    { ws: 'ops', proposals: [{ rel: '', nextSteps: '- rotate the logs' }] },
  ];
  assert.deepEqual(bedtimeProposals(REMINDER, answers, LEAD, 2000), [
    { terminalId: 't1', workspaceId: 'dev', rel: 'api', text: `${LEAD}\n\n- finish the route` },
    { terminalId: 't3', workspaceId: 'dev', rel: 'api', text: `${LEAD}\n\n- finish the route` },
    { terminalId: 't4', workspaceId: 'ops', rel: '', text: `${LEAD}\n\n- rotate the logs` },
  ]);
  assert.deepEqual(bedtimeProposals(REMINDER, [], LEAD, 2000), [], 'no answer, no proposal');
});

/* ---------- "Mejorar con IA" ---------- */

/** A field and a request the test controls: `answer(text)` / `fail(error)` settle the pending click. */
function harness(initial: string) {
  let value = initial;
  let settle: { resolve: (text: string) => void; reject: (error: unknown) => void } | null = null;
  const asked: string[] = [];
  const views: any[] = [];
  const control = improver({
    read: () => value,
    write: (text: string) => void (value = text),
    request: (draft: string) => {
      asked.push(draft);
      return new Promise<string>((resolve, reject) => void (settle = { resolve, reject }));
    },
    render: (view: any) => void views.push(view),
  });
  return {
    control,
    asked,
    views,
    get value() {
      return value;
    },
    type(text: string) {
      value = text;
    },
    async answer(text: string) {
      settle!.resolve(text);
      await new Promise((resolve) => setImmediate(resolve));
    },
    async fail(error: unknown) {
      settle!.reject(error);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('a click sends the current draft once and shows progress until the answer', async () => {
  const h = harness('draft');
  const click = h.control.improve();
  assert.equal(h.control.view().pending, true);
  h.control.improve();
  assert.deepEqual(h.asked, ['draft'], 'a second click while waiting asks nothing');
  await h.answer('better');
  await click;
  assert.equal(h.control.view().pending, false);
  assert.ok(h.views.some((view) => view.pending) && !h.views.at(-1).pending, 'rendered pending, then done');
});

test('the answer replaces an untouched draft, and Deshacer restores the draft as it was at the click', async () => {
  const h = harness('Continúa:\n- tests');
  const click = h.control.improve();
  await h.answer('Corre los tests focales y reporta.');
  await click;
  assert.equal(h.value, 'Corre los tests focales y reporta.');
  assert.deepEqual({ ...h.control.view(), error: null }, { pending: false, suggestion: null, undo: 'Continúa:\n- tests', error: null });
  h.control.undo();
  assert.equal(h.value, 'Continúa:\n- tests');
  assert.equal(h.control.view().undo, null, 'one undo');
});

test('a draft edited since the click is kept; the answer waits as a suggestion the user may apply (and undo) or dismiss', async () => {
  const h = harness('draft');
  const click = h.control.improve();
  h.type('draft plus what the user added');
  await h.answer('Claude version');
  await click;
  assert.equal(h.value, 'draft plus what the user added', 'their edit is never overwritten');
  assert.equal(h.control.view().suggestion, 'Claude version');
  assert.equal(h.control.view().undo, null);
  h.control.apply();
  assert.equal(h.value, 'Claude version');
  assert.equal(h.control.view().suggestion, null);
  h.control.undo();
  assert.equal(h.value, 'draft plus what the user added', 'Deshacer after applying brings their edit back');

  const d = harness('draft');
  const again = d.control.improve();
  d.type('edited');
  await d.answer('Claude version');
  await again;
  d.control.dismiss();
  assert.equal(d.control.view().suggestion, null);
  assert.equal(d.value, 'edited');
});

test('an error leaves the draft untouched and is shown; a new click clears it', async () => {
  const h = harness('draft');
  const click = h.control.improve();
  await h.fail(Object.assign(new Error('pi timed out'), { code: 'proposal_timeout' }));
  await click;
  assert.equal(h.value, 'draft');
  assert.equal(h.control.view().pending, false);
  assert.equal(h.control.view().error.code, 'proposal_timeout');
  assert.equal(h.control.view().undo, null);
  const retry = h.control.improve();
  assert.equal(h.control.view().error, null);
  await h.answer('ok');
  await retry;
  assert.equal(h.value, 'ok');
});

test('improveRequest is the POST /api/proposals/improve body for one folder and its draft', () => {
  assert.deepEqual(improveRequest('dev', 'api', 'draft'), { ws: 'dev', rel: 'api', draft: 'draft' });
  assert.deepEqual(improveRequest('dev', undefined, undefined), { ws: 'dev', rel: '', draft: '' });
});

/* ---------- Fresh proposals ---------- */

const SOURCE = { summaryAt: '2026-11-03T00:40:00.000Z', latestMemoryAt: '2026-11-03T02:10:00.000Z', newerMemories: true, lastSentAt: '2026-11-03T01:05:00.000Z' };

test('bedtimeSources gives each open agent the source of its folder\'s proposal', () => {
  const answers = [
    { ws: 'dev', proposals: [{ rel: 'api', nextSteps: '- route', ...SOURCE }, { rel: 'web', nextSteps: null, summaryAt: null, latestMemoryAt: null, newerMemories: false, lastSentAt: null }] },
  ];
  const sources = bedtimeSources(REMINDER, answers);
  assert.deepEqual([...sources.keys()], ['t1', 't2', 't3'], 'agents of answered workspaces only');
  assert.deepEqual(sources.get('t1'), SOURCE);
  assert.deepEqual(sources.get('t3'), SOURCE, 'two agents of one folder share it');
  assert.equal(sources.get('t2').summaryAt, null);
});

test('proposalFreshness dates the summary in the time zone and warns about later work and later notes', () => {
  // 2026-11-03 02:40 UTC is 02/11 23:40 in Santiago (UTC-3).
  const now = Date.parse('2026-11-03T02:40:00Z');
  const fresh = proposalFreshness(SOURCE, now, 'America/Santiago', 'es');
  assert.deepEqual(fresh, { when: '02/11 21:40', ago: { unit: 'h', count: 2 }, newerMemory: '23:10', sentAfter: '22:05' });
  const es = (key: string, vars = {}) => translate('es', key, vars);
  // The agent's note box carries the source and date in its label.
  assert.equal(es('night.proposal.label', { when: fresh.when }), 'Nota (propuesta de la memoria, 02/11 21:40)');
  assert.equal(es('night.proposal.newerMemory', { time: fresh.newerMemory }), 'Hubo actividad después de este resumen (última memoria 23:10): revisa que no esté hecho');
  assert.equal(es('night.proposal.sentAfter', { time: fresh.sentAfter }), 'Ya le enviaste una nota o delegación a las 22:05 después de este resumen');
  const en = (key: string, vars = {}) => translate('en', key, vars);
  assert.equal(en('night.proposal.label', { when: proposalFreshness(SOURCE, now, 'America/Santiago', 'en').when }), 'Note (proposed from memory, 11/02 21:40)');
});

test('proposalFreshness: no warning without later work or notes; older stamps keep their date; minutes, days and "just now"', () => {
  const now = Date.parse('2026-11-03T02:40:00Z');
  const quiet = { ...SOURCE, newerMemories: false, lastSentAt: null };
  assert.deepEqual(proposalFreshness(quiet, now, 'America/Santiago', 'es'), { when: '02/11 21:40', ago: { unit: 'h', count: 2 }, newerMemory: null, sentAfter: null });
  const old = { summaryAt: '2026-10-30T12:00:00.000Z', latestMemoryAt: '2026-11-01T13:15:00.000Z', newerMemories: true, lastSentAt: null };
  assert.deepEqual(proposalFreshness(old, now, 'America/Santiago', 'es'), { when: '30/10 09:00', ago: { unit: 'd', count: 3 }, newerMemory: '01/11 10:15', sentAfter: null });
  assert.deepEqual(proposalFreshness({ ...quiet, summaryAt: '2026-11-03T02:15:00.000Z' }, now, 'America/Santiago', 'es').ago, { unit: 'min', count: 25 });
  assert.deepEqual(proposalFreshness({ ...quiet, summaryAt: '2026-11-03T02:39:40.000Z' }, now, 'America/Santiago', 'es').ago, { unit: 'now', count: 0 });
  assert.equal(proposalFreshness({ ...quiet, summaryAt: null }, now, 'America/Santiago', 'es'), null, 'no summary time, no line');
  assert.equal(proposalFreshness(undefined, now, 'America/Santiago', 'es'), null);
});

test('refreshedProposal replaces Mirador\'s untouched text with the newer one; an edited text stays and says a newer summary exists', () => {
  const older = { summaryAt: '2026-11-02T20:00:00.000Z', latestMemoryAt: null, newerMemories: false, lastSentAt: null };
  const shown = { text: 'old steps', original: 'old steps', source: older };
  assert.deepEqual(refreshedProposal(shown, { text: 'new steps', source: SOURCE }), { text: 'new steps', original: 'new steps', source: SOURCE, newerSource: null });
  const edited = { ...shown, text: 'old steps, edited by the user' };
  assert.deepEqual(refreshedProposal(edited, { text: 'new steps', source: SOURCE }), { text: 'old steps, edited by the user', original: 'old steps', source: older, newerSource: SOURCE.summaryAt });
  assert.deepEqual(refreshedProposal(edited, { text: 'old steps', source: { ...older, newerMemories: true } }), { text: 'old steps, edited by the user', original: 'old steps', source: { ...older, newerMemories: true }, newerSource: null }, 'same source: only its warnings change');
  assert.equal(translate('es', 'night.proposal.newerSource', { when: '02/11 21:40' }), 'La memoria tiene un resumen más nuevo (del 02/11 21:40); se mantiene tu texto editado.');
});
