// Plain mode's "Where it left off" for a folder
// (public/features/plain-left-off.js): branch, last commit, changed files, the recent log and
// NOTES.md, from GET /api/folder/git only, so no Engram route is called and nothing fails.
// The view takes api, el and t as arguments: here a fake DOM of plain objects renders it in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changeKind, plainLeftOffView, shortDate } from '../public/features/plain-left-off.js';
import { translate } from '../public/i18n.js';

type Node = { tag: string; attrs: Record<string, unknown>; children: Array<Node | string> };
const el = (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): Node => ({
  tag,
  attrs,
  children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) as Array<Node | string>,
});
/** A node's text, with runs of spaces read as one, as a browser shows them. */
const text = (node: Node | string | null): string => (node === null ? '' : typeof node === 'string' ? node : node.children.map(text).join(' ').replace(/ {2,}/g, ' '));
const all = (nodes: Array<Node | null>, tag: string): Node[] => {
  const found: Node[] = [];
  const walk = (node: Node | string | null) => {
    if (!node || typeof node === 'string') return;
    if (node.tag === tag) found.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return found;
};

const REPO = {
  cwd: '/work/dev/app',
  git: {
    available: true,
    branch: 'main',
    head: 'abc1234',
    lastCommit: { sha: 'abc1234', date: '2026-11-10T09:15:00-03:00', subject: 'Start the app' },
    recent: [
      { sha: 'abc1234', date: '2026-11-10T09:15:00-03:00', subject: 'Start the app' },
      { sha: 'def5678', date: '2026-11-09T18:00:00-03:00', subject: 'Sketch the idea' },
    ],
    changes: { count: 3, complete: true, files: [{ code: ' M', path: 'index.js' }, { code: 'R ', path: 'new.md', from: 'old.md' }, { code: '??', path: 'NOTES.md' }] },
  },
  notes: { text: 'Next: <script>alert(1)</script> wire the panel\n', truncated: false },
};

/** Renders the view for `answer` in `language`; returns the nodes, the API calls and the headings set. */
async function render(answer: unknown, { language = 'en', selection = { ws: 'dev', rel: 'app' } } = {}) {
  const calls: string[] = [];
  const headings: string[][] = [];
  const view = plainLeftOffView({
    api: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return answer;
    },
    el,
    t: (key: string, vars?: Record<string, unknown>) => translate(language, key, vars),
    isPlain: () => true,
  });
  const nodes = (await view.render({ selection, date: '2026-11-12', setHeading: (...args: string[]) => headings.push(args) })) as Node[];
  return { nodes, calls, headings, page: nodes.map(text).join(' ') };
}

test('the view is "Where it left off" of a folder, offered only in plain mode', () => {
  let plain = true;
  const view = plainLeftOffView({ api: async () => null, el, t: (key: string) => key, isPlain: () => plain });
  assert.equal(view.id, 'leftoff');
  assert.equal(view.label, 'overview.view.folder');
  assert.equal(view.extra, undefined, 'no gentle extra: plain mode must keep it');
  assert.equal(view.applies({ ws: 'dev', rel: 'app' }), true);
  assert.equal(view.applies({ ws: 'dev', rel: '' }), false, 'a workspace root has its own views');
  assert.equal(view.applies(null), false);
  plain = false;
  assert.equal(view.applies({ ws: 'dev', rel: 'app' }), false, 'gentle-deck keeps the Engram view');
});

test('it reads only GET /api/folder/git: never an Engram route', async () => {
  const { calls, headings } = await render(REPO);
  assert.deepEqual(calls, ['GET /api/folder/git?ws=dev&rel=app']);
  assert.deepEqual(headings.at(-1), ['Where it left off', '/work/dev/app']);
});

test('a repo shows its branch, last commit, changed files and recent log', async () => {
  const { nodes, page } = await render(REPO);
  assert.match(page, /Branch\s+main/);
  assert.match(page, /Last commit abc1234 Start the app · 2026-11-10 09:15/);
  assert.match(page, /3 changed files/);
  const changes = all(nodes, 'li').map(text).slice(0, 3);
  assert.deepEqual(changes, ['modified index.js', 'renamed old.md → new.md', 'untracked NOTES.md']);
  assert.match(page, /Recent commits/);
  const times = all(nodes, 'time').map((node) => node.attrs.datetime);
  assert.ok(times.includes('2026-11-09T18:00:00-03:00'));
  assert.match(page, /def5678 Sketch the idea · 2026-11-09 18:00/);
});

test('NOTES.md shows as text in a pre, never as markup', async () => {
  const { nodes } = await render(REPO);
  const pre = all(nodes, 'pre');
  assert.equal(pre.length, 1);
  assert.deepEqual(pre[0].children, ['Next: <script>alert(1)</script> wire the panel\n']);
  assert.equal(all(nodes, 'script').length, 0);
});

test('a folder that is no repo says git is not available, and the notes still show', async () => {
  const { page, nodes } = await render({ cwd: '/work/dev/docs', git: { available: false, reason: 'not_repo' }, notes: { text: 'todo', truncated: false } });
  assert.match(page, /Not available: this folder is not a git repository\./);
  assert.equal(all(nodes, 'pre').length, 1);
  for (const [reason, phrase] of [['git_missing', /git is not installed/], ['outside_root', /outside the workspace folder/], ['git_failed', /git could not read this folder/]] as const) {
    assert.match((await render({ cwd: '/x', git: { available: false, reason }, notes: null })).page, phrase, reason);
  }
});

test('no NOTES.md says how to add one; a cut one says so', async () => {
  assert.match((await render({ ...REPO, notes: null })).page, /No NOTES\.md in this folder\. Write one at its root to keep notes here\./);
  assert.match((await render({ ...REPO, notes: { text: 'long', truncated: true } })).page, /Only the first 16 KB are shown\./);
});

test('a detached HEAD, a repo without commits and a clean tree say so', async () => {
  const detached = await render({ ...REPO, git: { ...REPO.git, branch: null } });
  assert.match(detached.page, /Detached HEAD at\s+abc1234/);
  const unborn = await render({ ...REPO, git: { ...REPO.git, head: null, lastCommit: null, recent: [], changes: { count: 0, complete: true, files: [] } } });
  assert.match(unborn.page, /No commits yet/);
  assert.match(unborn.page, /No changed files/);
  assert.doesNotMatch(unborn.page, /Recent commits/);
});

test('more changes than listed say how many are left out, and a cut status is "at least"', async () => {
  const many = await render({ ...REPO, git: { ...REPO.git, changes: { count: 60, complete: true, files: REPO.git.changes.files } } });
  assert.match(many.page, /60 changed files/);
  assert.match(many.page, /and 57 more/);
  const cut = await render({ ...REPO, git: { ...REPO.git, changes: { count: 1, complete: false, files: [REPO.git.changes.files[0]] } } });
  assert.match(cut.page, /At least 1 changed file/);
});

test('Spanish has the same view', async () => {
  const { page } = await render(REPO, { language: 'es' });
  assert.match(page, /Rama\s+main/);
  assert.match(page, /Último commit\s+abc1234/);
  assert.match(page, /3 archivos modificados/);
  assert.match((await render({ cwd: '/x', git: { available: false, reason: 'not_repo' }, notes: null }, { language: 'es' })).page, /No disponible: esta carpeta no es un repositorio git\./);
});

test('porcelain codes read as words, and dates keep the author\'s clock', () => {
  assert.equal(changeKind('??'), 'untracked');
  assert.equal(changeKind(' M'), 'modified');
  assert.equal(changeKind('M '), 'modified');
  assert.equal(changeKind('A '), 'added');
  assert.equal(changeKind(' D'), 'deleted');
  assert.equal(changeKind('R '), 'renamed');
  assert.equal(changeKind('C '), 'copied');
  assert.equal(changeKind('UU'), 'conflict');
  assert.equal(changeKind('AA'), 'conflict');
  assert.equal(shortDate('2026-11-10T09:15:00-03:00'), '2026-11-10 09:15');
  assert.equal(shortDate('nonsense'), 'nonsense');
});

test('the workspaces feature registers the view, plain only, and it calls no Engram route', () => {
  const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');
  assert.match(workspacesJs, /registerPanelView\(plainLeftOffView\(\{ api, el, t, isPlain: \(\) => modeOf\(state\.config\) === 'plain' \}\)\)/);
  const viewJs = readFileSync('public/features/plain-left-off.js', 'utf8');
  assert.doesNotMatch(viewJs, /\/api\/(overview|summary|activity|memory|inbox)/);
  assert.doesNotMatch(viewJs, /^import /m, 'no browser import: tests load it in Node');
  assert.doesNotMatch(viewJs, /innerHTML|insertAdjacentHTML/);
});
