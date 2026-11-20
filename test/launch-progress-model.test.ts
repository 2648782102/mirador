// Pure rules of the loading bar: what the bar says
// for a GET /api/terminals/launches answer, which actions wait for the launches, and when the
// result shows. Status samples as the server answers them; the real dictionaries and byte format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_ACTIONS, barText, blockedActions, launchBar } from '../public/features/launch-progress-model.js';
import { translate } from '../public/i18n.js';
import { formatBytes } from '../public/features/resources-model.js';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-10-29T21:00:00.000Z');
const words = (language: 'es' | 'en') => ({
  t: (key: string, vars?: Record<string, unknown>) => translate(language, key, vars),
  bytes: (value: number) => formatBytes(value, language),
  nameOf: (folder: { workspaceId: string; rel: string }) => folder.rel || `ws:${folder.workspaceId}`,
});
const es = words('es');
const en = words('en');

function run(over: Record<string, unknown> = {}) {
  return {
    id: 'r1', kind: 'restore', workspaceId: null, state: 'running', total: 21, opened: 9, failed: 0, skipped: 0, queued: 12,
    lowMemory: 0, cancelled: 0, startedAt: '2026-10-29T20:58:00.000Z', endedAt: null, wait: null, ...over,
  };
}
const settle = (seconds: number) => ({ reason: 'settle', until: new Date(NOW + seconds * 1000).toISOString(), memAvailable: null, reserveBytes: null, missingBytes: null });
const memory = (available: number, reserve: number) => ({ reason: 'memory', until: null, memAvailable: available, reserveBytes: reserve, missingBytes: reserve - available });

test('restoring while a batch settles: count, next batch countdown and free memory from the resources poller', () => {
  const bar = launchBar({ active: true, runs: [run({ wait: settle(31.2) })] }, { now: NOW, memAvailable: 6.8 * GB });
  assert.equal(barText(bar, es), 'Restaurando agentes: 9 de 21 · próximo lote en 32 s · memoria libre 6,8 GB');
  assert.equal(barText(bar, en), 'Restoring agents: 9 of 21 · next batch in 32 s · 6.8 GB free');
});

test('a batch waiting for memory says how much is missing and the free memory of that reading', () => {
  const bar = launchBar({ active: true, runs: [run({ id: 'b1', kind: 'batch', total: 4, opened: 1, queued: 3, wait: memory(2.4 * GB, 3.6 * GB) })] }, { now: NOW, memAvailable: 9 * GB });
  assert.equal(barText(bar, es), 'Abriendo agentes: 1 de 4 · esperando memoria libre (falta 1,2 GB) · memoria libre 2,4 GB');
});

test('two runs at once add up; the restore names the bar and a memory wait wins over a turn', () => {
  const bar = launchBar({
    active: true,
    runs: [run({ total: 6, opened: 2, queued: 4, wait: memory(1 * GB, 3 * GB) }), run({ id: 'b2', kind: 'batch', total: 3, opened: 0, skipped: 1, queued: 2, wait: { reason: 'turn', until: null, memAvailable: null, reserveBytes: null, missingBytes: null } })],
  }, { now: NOW });
  assert.equal(barText(bar, es), 'Restaurando agentes: 3 de 9 · esperando memoria libre (falta 2 GB) · memoria libre 1 GB');
  assert.deepEqual(bar!.runIds, ['r1', 'b2'], 'Pausar cancels every running run');
});

test('a run between two launches shows only its count; unknown free memory is left out', () => {
  assert.equal(barText(launchBar({ active: true, runs: [run()] }, { now: NOW }), es), 'Restaurando agentes: 9 de 21');
});

test('done: "Listo" with the count for a run this window saw; nothing for a clean run it never saw or one dismissed', () => {
  const done = run({ state: 'done', opened: 21, queued: 0, endedAt: '2026-10-29T21:05:00.000Z', notOpened: [] });
  assert.equal(barText(launchBar({ active: false, runs: [done] }, { now: NOW, seen: new Set(['r1']) }), es), 'Listo: 21 abiertos');
  assert.equal(barText(launchBar({ active: false, runs: [{ ...done, opened: 1, total: 1 }] }, { now: NOW, seen: new Set(['r1']) }), en), 'Done: 1 open');
  assert.equal(launchBar({ active: false, runs: [done] }, { now: NOW }), null);
  assert.equal(launchBar({ active: false, runs: [done] }, { now: NOW, seen: new Set(['r1']), dismissed: new Set(['r1']) }), null);
  assert.equal(launchBar({ active: false, runs: [] }, { now: NOW }), null);
  assert.equal(launchBar(null, { now: NOW }), null);
});

test('done with low memory lists the folders not opened, even when this window opened after the run', () => {
  const short = run({ state: 'done', opened: 18, queued: 0, lowMemory: 3, notOpened: [{ workspaceId: 'z', rel: 'acme-web' }, { workspaceId: 'z', rel: 'acme-base' }, { workspaceId: 'z', rel: '' }] });
  const bar = launchBar({ active: false, runs: [short] }, { now: NOW });
  assert.equal(barText(bar, es), 'Listo: 18 abiertos · no se abrieron por poca memoria: acme-web, acme-base, ws:z');
  assert.equal(barText(bar, en), 'Done: 18 open · not opened for low memory: acme-web, acme-base, ws:z');
  // An older server without notOpened: the count only.
  const none = { ...short, opened: 0, total: 2, lowMemory: 2, notOpened: [{ workspaceId: 'z', rel: 'a1' }, { workspaceId: 'z', rel: 'a2' }] };
  assert.equal(barText(launchBar({ active: false, runs: [none] }, { now: NOW }), es), 'Ningún agente abierto · no se abrieron por poca memoria: a1, a2');
  assert.equal(barText(launchBar({ active: false, runs: [none] }, { now: NOW }), en), 'No agent opened · not opened for low memory: a1, a2');
  const { notOpened: _gone, ...counted } = short;
  assert.equal(barText(launchBar({ active: false, runs: [counted] }, { now: NOW }), es), 'Listo: 18 abiertos · 3 no se abrieron por poca memoria');
});

test('paused (Pausar): the folders left to open by hand; failed starts are counted', () => {
  const paused = run({ state: 'done', opened: 9, failed: 1, queued: 0, cancelled: 2, notOpened: [{ workspaceId: 'z', rel: 'a' }, { workspaceId: 'z', rel: 'b' }] });
  const bar = launchBar({ active: false, runs: [paused] }, { now: NOW, seen: new Set(['r1']) });
  assert.equal(bar!.phase, 'done');
  assert.equal(barText(bar, es), 'Listo: 9 abiertos · en pausa, quedan por abrir a mano: a, b · 1 no pudo abrirse');
  assert.equal(barText(bar, en), 'Done: 9 open · paused, left to open by hand: a, b · 1 could not open');
});

test('blocked while any run is active: opening gentle-shell, Abrir N, Delegar, Traer a Mirador and the Claude calls; never bash', () => {
  assert.deepEqual(BLOCKED_ACTIONS, ['agent', 'batch', 'delegate', 'adopt', 'model']);
  assert.deepEqual(blockedActions({ active: true, runs: [run()] }), BLOCKED_ACTIONS);
  assert.ok(!blockedActions({ active: true, runs: [run()] }).includes('shell'));
  assert.deepEqual(blockedActions({ active: false, runs: [run({ state: 'done', queued: 0 })] }), []);
  assert.deepEqual(blockedActions(null), []);
});

test('R5a: a restore names the agents it left asleep; a wake says it wakes; the count covers only agents opened', () => {
  const bar = launchBar({ active: true, runs: [run({ total: 4, opened: 1, queued: 3, sleeping: 17 })] }, { now: NOW });
  assert.equal(barText(bar, es), 'Restaurando agentes: 1 de 4 · 17 dormidos');
  assert.equal(barText(bar, en), 'Restoring agents: 1 of 4 · 17 sleeping');
  const one = launchBar({ active: true, runs: [run({ total: 4, opened: 1, queued: 3, sleeping: 1 })] }, { now: NOW });
  assert.equal(barText(one, es), 'Restaurando agentes: 1 de 4 · 1 dormido');
  const waking = launchBar({ active: true, runs: [run({ id: 'w1', kind: 'wake', total: 2, opened: 0, queued: 2 })] }, { now: NOW });
  assert.equal(barText(waking, es), 'Despertando agentes: 0 de 2');
  assert.equal(barText(waking, en), 'Waking agents: 0 of 2');
  const done = run({ state: 'done', total: 4, opened: 4, queued: 0, sleeping: 17, endedAt: '2026-10-29T21:05:00.000Z', notOpened: [] });
  assert.equal(barText(launchBar({ active: false, runs: [done] }, { now: NOW, seen: new Set(['r1']) }), es), 'Listo: 4 abiertos · 17 dormidos');
});

test('S2 fidelity: the sleeping part names the workspace and the saved session when the sleeping list holds exactly those agents', () => {
  const done = run({ state: 'done', total: 4, opened: 4, queued: 0, sleeping: 2, endedAt: '2026-10-29T21:05:00.000Z', notOpened: [] });
  const seen = new Set(['r1']);
  const asleep = (over: Array<Record<string, unknown>>) => over.map((agent, at) => ({ id: `s${at}`, workspaceId: 'dev', rel: `f${at}`, createdAt: '2026-10-29T20:00:00.000Z', resumable: true, ...agent }));
  const text = (sleepingAgents: unknown[] | undefined, words = es, status = { active: false, runs: [done] }) => barText(launchBar(status, { now: NOW, seen, sleepingAgents }), words);
  // The artboard's line: "Listo: 4 abiertos · 2 dormidos en Dev, con su sesión guardada".
  assert.equal(text(asleep([{}, {}])), 'Listo: 4 abiertos · 2 dormidos en ws:dev, con su sesión guardada');
  assert.equal(text(asleep([{}, {}]), en), 'Done: 4 open · 2 sleeping in ws:dev, with their sessions saved');
  // Two workspaces: no place; one without a saved session: no session part.
  assert.equal(text(asleep([{}, { workspaceId: 'work' }])), 'Listo: 4 abiertos · 2 dormidos, con su sesión guardada');
  assert.equal(text(asleep([{}, { resumable: false }])), 'Listo: 4 abiertos · 2 dormidos en ws:dev');
  assert.equal(text(asleep([{ workspaceId: 'work' }, { resumable: false }])), 'Listo: 4 abiertos · 2 dormidos');
  // A list that is not those agents (one woken since, or older sleepers too) says only the count.
  assert.equal(text(asleep([{}])), 'Listo: 4 abiertos · 2 dormidos');
  assert.equal(text(asleep([{}, {}, {}])), 'Listo: 4 abiertos · 2 dormidos');
  assert.equal(text([]), 'Listo: 4 abiertos · 2 dormidos');
  assert.equal(text(undefined), 'Listo: 4 abiertos · 2 dormidos');
  // One agent, and the running phase.
  const one = { active: false, runs: [{ ...done, sleeping: 1 }] };
  assert.equal(text(asleep([{}]), es, one), 'Listo: 4 abiertos · 1 dormido en ws:dev, con su sesión guardada');
  assert.equal(text(asleep([{}]), en, one), 'Done: 4 open · 1 sleeping in ws:dev, with its session saved');
  const running = { active: true, runs: [run({ total: 4, opened: 1, queued: 3, sleeping: 2 })] };
  assert.equal(text(asleep([{}, {}]), es, running), 'Restaurando agentes: 1 de 4 · 2 dormidos en ws:dev, con su sesión guardada');
  // No sleepers: nothing about them, whatever the list holds.
  assert.equal(text(asleep([{}]), es, { active: false, runs: [{ ...done, sleeping: 0 }] }), 'Listo: 4 abiertos');
});
