// Pure rules of the summary panel: the view each
// kind of selection opens on, the migration of the old single-view preference, and how the view and
// the sections above it reach the panel body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../public/features/summary-model.js';

const { DEFAULT_VIEWS, chosenViewsFrom, fillPanel, pickView, selectionKind, selectionCrumb } = model;
const { storedViews } = model as any;

test('the chosen views come from the saved per-kind preference over the defaults, and the legacy one is dropped', () => {
  assert.deepEqual(chosenViewsFrom(null, null), { views: { workspace: 'overview', folder: 'leftoff', none: 'daily' }, save: false, dropLegacy: false });
  assert.deepEqual(chosenViewsFrom({ folder: 'files', v: 2 }, null), { views: { workspace: 'overview', folder: 'files', none: 'daily' }, save: false, dropLegacy: false });
  assert.deepEqual(chosenViewsFrom({ folder: 'inbox', v: 2 }, 'daily'), { views: { workspace: 'overview', folder: 'inbox', none: 'daily' }, save: false, dropLegacy: true }, 'panelViews wins');
  assert.deepEqual(chosenViewsFrom('broken', null).views, DEFAULT_VIEWS);
});

test('a folder opens on "Dónde quedó" by default; a folder view saved before it had a choice is dropped once', () => {
  assert.equal(DEFAULT_VIEWS.folder, 'leftoff');
  // Before version 2 a folder had only the daily view: its saved id was never a choice.
  assert.deepEqual(chosenViewsFrom({ workspace: 'daily', folder: 'daily', none: 'daily' }, null), { views: { workspace: 'daily', folder: 'leftoff', none: 'daily' }, save: true, dropLegacy: false });
  assert.deepEqual(chosenViewsFrom({ workspace: 'daily', folder: 'daily', none: 'daily', v: 2 }, null).views, { workspace: 'daily', folder: 'daily', none: 'daily' });
  assert.deepEqual(storedViews({ workspace: 'overview', folder: 'inbox', none: 'daily' }), { workspace: 'overview', folder: 'inbox', none: 'daily', v: 2 });
});

test('the legacy single view, once chosen for every selection, is migrated into the kinds that had a choice', () => {
  assert.deepEqual(chosenViewsFrom(null, 'daily'), { views: { workspace: 'daily', folder: 'leftoff', none: 'daily' }, save: true, dropLegacy: true });
  assert.deepEqual(chosenViewsFrom(null, 7), { views: { workspace: 'overview', folder: 'leftoff', none: 'daily' }, save: false, dropLegacy: true }, 'a legacy value that is no view id is only dropped');
  assert.deepEqual(chosenViewsFrom(null, ''), { views: { workspace: 'overview', folder: 'leftoff', none: 'daily' }, save: false, dropLegacy: true });
});

test('a selection opens on its chosen view, else on its kind default, else on the first view offered', () => {
  assert.deepEqual([selectionKind(null), selectionKind({ ws: 'dev', rel: '' }), selectionKind({ ws: 'dev', rel: 'alpha' })], ['none', 'workspace', 'folder']);
  const daily = { id: 'daily' };
  const overview = { id: 'overview' };
  const files = { id: 'files' };
  assert.equal(pickView([daily, overview, files], { workspace: 'files' }, 'workspace'), files);
  assert.equal(pickView([daily, overview], { workspace: 'leftoff' }, 'workspace'), overview, 'a chosen view no longer offered falls back to the default');
  const leftoff = { id: 'leftoff' };
  assert.equal(pickView([files, leftoff, daily], { folder: 'gone' }, 'folder'), leftoff);
  assert.equal(pickView([files, daily], { folder: 'leftoff' }, 'folder'), files);
  assert.equal(pickView([], { folder: 'daily' }, 'folder'), undefined);
});

/** A promise resolved or rejected from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A fake panel body: the order of its nodes, and every replace or insert done on it. */
function fakeBody() {
  const body = { nodes: [] as string[], calls: [] as string[] };
  return Object.assign(body, {
    show(nodes: string[]) {
      body.calls.push('show');
      body.nodes = [...nodes];
    },
    insert(nodes: string[], before: string | null) {
      body.calls.push(`insert before ${before}`);
      const at = before === null ? body.nodes.length : body.nodes.indexOf(before);
      assert.notEqual(at, -1, 'the anchor is in the body');
      body.nodes.splice(at, 0, ...nodes);
    },
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the view shows as soon as it resolves, and slower sections are inserted above it in their order', async () => {
  const view = deferred<string[]>();
  const first = deferred<string[]>();
  const second = deferred<string[]>();
  const body = fakeBody();
  const done = fillPanel(view.promise, [first.promise, second.promise], body);
  view.resolve(['v1', 'v2']);
  await done;
  assert.deepEqual(body.nodes, ['v1', 'v2'], 'the view does not wait for the sections');
  second.resolve(['s2']);
  await settle();
  assert.deepEqual(body.nodes, ['s2', 'v1', 'v2']);
  first.resolve(['s1a', 's1b']);
  await settle();
  assert.deepEqual(body.nodes, ['s1a', 's1b', 's2', 'v1', 'v2'], 'same order as registered, above the view');
  assert.deepEqual(body.calls, ['show', 'insert before v1', 'insert before s2']);
});

test('sections that resolve before the view show with it; a failed or empty section is left out', async () => {
  const view = deferred<string[]>();
  const body = fakeBody();
  const done = fillPanel(view.promise, [Promise.resolve(['s1']), Promise.reject(new Error('down')), Promise.resolve([])], body);
  await settle();
  assert.deepEqual(body.calls, [], 'nothing replaces the loading notice before the view');
  view.resolve(['v']);
  await done;
  await settle();
  assert.deepEqual(body.nodes, ['s1', 'v']);
  assert.deepEqual(body.calls, ['show']);
});

test('a section after an empty view is appended at the end', async () => {
  const section = deferred<string[]>();
  const body = fakeBody();
  await fillPanel(Promise.resolve([]), [section.promise], body);
  section.resolve(['s']);
  await settle();
  assert.deepEqual(body.nodes, ['s']);
  assert.deepEqual(body.calls, ['show', 'insert before null']);
});

test('a view that fails rejects, and no section is shown after it', async () => {
  const section = deferred<string[]>();
  const body = fakeBody();
  await assert.rejects(fillPanel(Promise.reject(Object.assign(new Error('engram down'), { status: 503 })), [section.promise], body), { status: 503 });
  section.resolve(['s']);
  await settle();
  assert.deepEqual(body.calls, []);
});

// The panel head reads as the design's, a small crumb
// with the selection's place over the 18px title.
test('the crumb is the selection place, from its workspace down to the folder, and empty with no selection', () => {
  assert.equal(selectionCrumb(null, undefined), '');
  assert.equal(selectionCrumb({ ws: 'dev', rel: '' }, 'Dev'), 'Dev');
  assert.equal(selectionCrumb({ ws: 'dev', rel: 'web/acme-clinic' }, 'Dev'), 'Dev › web › acme-clinic');
  // A workspace the client does not know yet still names its place by its id.
  assert.equal(selectionCrumb({ ws: 'dev', rel: 'tools' }, undefined), 'dev › tools');
});

// The panel follows the active tab or grid pane; the tree pins it.
const { followPanel } = model as any;
const devAlpha = { ws: 'dev', rel: 'alpha' };
const tab = (id: string, workspaceId: string, rel: string) => ({ activeId: id, active: { workspaceId, rel } });
const noTab = { activeId: null, active: null };

test('with no terminal the panel shows the selection, as before, and every selection renders it', () => {
  const start = followPanel(null, { selected: false, ...noTab, selection: devAlpha });
  assert.deepEqual(start, { place: devAlpha, terminalId: null, pinned: false, render: true });
  assert.equal(followPanel(start, { selected: false, ...noTab, selection: devAlpha }).render, false, 'nothing happened');
  assert.equal(followPanel(start, { selected: true, ...noTab, selection: devAlpha }).render, true, 'the same row clicked again renders, as before');
  const none = followPanel(start, { selected: true, ...noTab, selection: null });
  assert.equal(none.place, null);
  assert.equal(none.render, true);
});

test('a tab of another folder moves the panel to its folder without touching the selection', () => {
  const selection = { ws: 'dev', rel: 'alpha' };
  const start = followPanel(null, { selected: false, ...noTab, selection });
  const onBeta = followPanel(start, { selected: false, ...tab('t1', 'dev', 'beta'), selection });
  assert.deepEqual(onBeta, { place: { ws: 'dev', rel: 'beta' }, terminalId: 't1', pinned: false, render: true });
  assert.deepEqual(selection, { ws: 'dev', rel: 'alpha' }, 'the selection is never changed');
  const onRoot = followPanel(onBeta, { selected: false, ...tab('t2', 'ops', ''), selection });
  assert.deepEqual(onRoot.place, { ws: 'ops', rel: '' }, 'a terminal at a workspace root shows the workspace');
  assert.equal(onRoot.render, true);
});

test('a tab of the same folder, or the same tab again (mousedown, open, launch), does not re-render', () => {
  const onBeta = followPanel(null, { selected: false, ...tab('t1', 'dev', 'beta'), selection: devAlpha });
  const again = followPanel(onBeta, { selected: false, ...tab('t1', 'dev', 'beta'), selection: devAlpha });
  assert.equal(again.render, false);
  // Another agent in the same folder shows the same memory.
  const otherAgent = followPanel(again, { selected: false, ...tab('t2', 'dev', 'beta'), selection: devAlpha });
  assert.deepEqual(otherAgent.place, { ws: 'dev', rel: 'beta' });
  assert.equal(otherAgent.render, false);
});

test('a tree click still selects and shows its folder, pinned until another tab becomes active', () => {
  const onBeta = followPanel(null, { selected: false, ...tab('t1', 'dev', 'beta'), selection: null });
  const clicked = followPanel(onBeta, { selected: true, ...tab('t1', 'dev', 'beta'), selection: devAlpha });
  assert.deepEqual(clicked, { place: devAlpha, terminalId: 't1', pinned: true, render: true });
  const typing = followPanel(clicked, { selected: false, ...tab('t1', 'dev', 'beta'), selection: devAlpha });
  assert.deepEqual(typing.place, devAlpha, 'clicking into the same terminal keeps the pin');
  assert.equal(typing.render, false);
  const next = followPanel(typing, { selected: false, ...tab('t2', 'dev', 'gamma'), selection: devAlpha });
  assert.deepEqual(next, { place: { ws: 'dev', rel: 'gamma' }, terminalId: 't2', pinned: false, render: true });
});

test('a workspace row that enters its last terminal in the same turn still shows the workspace', () => {
  const onBeta = followPanel(null, { selected: false, ...tab('t1', 'dev', 'beta'), selection: null });
  const row = { ws: 'ops', rel: '' };
  const entered = followPanel(onBeta, { selected: true, ...tab('t9', 'ops', 'api'), selection: row });
  assert.deepEqual(entered, { place: row, terminalId: 't9', pinned: true, render: true });
});

test('closing the last terminal brings the panel back to the selection', () => {
  const onBeta = followPanel(null, { selected: false, ...tab('t1', 'dev', 'beta'), selection: devAlpha });
  const closed = followPanel(onBeta, { selected: false, ...noTab, selection: devAlpha });
  assert.deepEqual(closed, { place: devAlpha, terminalId: null, pinned: false, render: true });
  const same = followPanel(null, { selected: false, ...tab('t1', 'dev', 'alpha'), selection: devAlpha });
  assert.equal(followPanel(same, { selected: false, ...noTab, selection: devAlpha }).render, false, 'the same folder does not re-render');
});
