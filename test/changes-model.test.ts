// The "Changes" panel view (public/features/changes-panel.js)
// and its pure rules (public/features/changes-model.js): each diff line gets a kind (file header,
// hunk header, added, removed, context, note) that becomes a CSS class on a span whose only child
// is the line's text, so diff content never becomes markup. The view takes api, el and t as
// arguments: here a fake DOM of plain objects renders it in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyPatch, lineClass } from '../public/features/changes-model.js';
import { changesView } from '../public/features/changes-panel.js';
import { translate } from '../public/i18n.js';

type Node = { tag: string; attrs: Record<string, unknown>; children: Array<Node | string> };
const el = (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): Node => ({
  tag,
  attrs,
  children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) as Array<Node | string>,
});
const text = (node: Node | string | null): string => (node === null ? '' : typeof node === 'string' ? node : node.children.map(text).join(' ').replace(/ {2,}/g, ' '));
const all = (nodes: Array<Node | null>, test: (node: Node) => boolean): Node[] => {
  const found: Node[] = [];
  const walk = (node: Node | string | null) => {
    if (!node || typeof node === 'string') return;
    if (test(node)) found.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return found;
};

const PATCH = [
  'diff --git a/app.js b/app.js',
  'index 5626abf..f719efd 100644',
  '--- a/app.js',
  '+++ b/app.js',
  '@@ -1,4 +1,4 @@ function start() {',
  ' keep',
  '--- a removed line that looks like a header',
  '+++ an added line that looks like a header',
  '-<script>alert(1)</script>',
  '+<img src=x onerror=alert(1)>',
  '@@ -10 +10 @@',
  '-old',
  '\\ No newline at end of file',
  '+new',
  '',
].join('\n');

test('every line of a patch gets its kind; headers only before the first hunk', () => {
  assert.deepEqual(classifyPatch(PATCH), [
    { kind: 'file', text: 'diff --git a/app.js b/app.js' },
    { kind: 'file', text: 'index 5626abf..f719efd 100644' },
    { kind: 'file', text: '--- a/app.js' },
    { kind: 'file', text: '+++ b/app.js' },
    { kind: 'hunk', text: '@@ -1,4 +1,4 @@ function start() {' },
    { kind: 'context', text: ' keep' },
    { kind: 'del', text: '--- a removed line that looks like a header' },
    { kind: 'add', text: '+++ an added line that looks like a header' },
    { kind: 'del', text: '-<script>alert(1)</script>' },
    { kind: 'add', text: '+<img src=x onerror=alert(1)>' },
    { kind: 'hunk', text: '@@ -10 +10 @@' },
    { kind: 'del', text: '-old' },
    { kind: 'note', text: '\\ No newline at end of file' },
    { kind: 'add', text: '+new' },
  ]);
});

test('rename, mode and binary headers are file lines; an empty patch has no line', () => {
  const rename = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n';
  assert.deepEqual(classifyPatch(rename).map((line: { kind: string }) => line.kind), ['file', 'file', 'file', 'file']);
  const binary = 'diff --git a/img.bin b/img.bin\nindex 1..2 100644\nBinary files a/img.bin and b/img.bin differ\n';
  assert.deepEqual(classifyPatch(binary).map((line: { kind: string }) => line.kind), ['file', 'file', 'file']);
  assert.deepEqual(classifyPatch(''), []);
  // A cut patch without its final newline keeps its last line.
  assert.deepEqual(classifyPatch('@@ -1 +1 @@\n+half'), [{ kind: 'hunk', text: '@@ -1 +1 @@' }, { kind: 'add', text: '+half' }]);
});

test('each kind has its own CSS class', () => {
  assert.deepEqual(['file', 'hunk', 'add', 'del', 'context', 'note'].map(lineClass), ['diff-line diff-file', 'diff-line diff-hunk', 'diff-line diff-add', 'diff-line diff-del', 'diff-line diff-context', 'diff-line diff-note']);
});

const DIFF = {
  cwd: '/work/dev/app',
  diff: {
    available: true,
    totals: { files: 3, added: 3, removed: 2 },
    files: [
      { path: 'app.js', added: 3, removed: 2, binary: false, patch: PATCH, truncated: false },
      { path: 'new.txt', from: 'old.txt', added: 0, removed: 0, binary: false, patch: 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n', truncated: true },
      { path: 'img.bin', added: null, removed: null, binary: true, patch: '', truncated: true },
    ],
    complete: false,
    untracked: { count: 4, complete: true, paths: ['NOTES.md', 'tmp/'] },
  },
};

async function render(answer: unknown, { language = 'en', selection = { ws: 'dev', rel: 'app' } } = {}) {
  const calls: string[] = [];
  const headings: string[][] = [];
  const view = changesView({
    api: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return answer;
    },
    el,
    t: (key: string, vars?: Record<string, unknown>) => translate(language, key, vars),
  });
  const nodes = (await view.render({ selection, date: '2026-11-12', setHeading: (...args: string[]) => headings.push(args) })) as Node[];
  return { view, nodes, calls, headings, page: nodes.map(text).join(' ') };
}

test('the view applies to any selected folder or workspace, in both modes, and calls only the diff route', async () => {
  const { view, calls, headings } = await render(DIFF);
  assert.equal(view.id, 'changes');
  assert.equal(view.label, 'changes.view');
  assert.equal('extra' in view, false, 'no gentle extra: plain mode keeps it');
  assert.equal(view.applies({ ws: 'dev', rel: 'app' }), true);
  assert.equal(view.applies({ ws: 'dev', rel: '' }), true);
  assert.equal(view.applies(null), false);
  assert.deepEqual(calls, ['GET /api/folder/diff?ws=dev&rel=app']);
  assert.deepEqual(headings.at(-1), ['Changes', '/work/dev/app']);
});

test('the stat summary, each file with its counts, and the coloured diff as text in classed spans', async () => {
  const { nodes, page } = await render(DIFF);
  assert.match(page, /3 files changed: \+3 −2/);
  assert.match(page, /old\.txt → new\.txt/);
  assert.match(page, /img\.bin binary/);
  const lines = all(nodes, (node) => node.tag === 'span' && String(node.attrs.class ?? '').startsWith('diff-line'));
  assert.equal(lines.length, 14 + 3);
  // One text child per span: the line itself, never markup.
  for (const line of lines) assert.ok(line.children.length === 1 && typeof line.children[0] === 'string', JSON.stringify(line));
  const script = lines.find((line) => String(line.children[0]).includes('<script>'));
  assert.equal(script?.attrs.class, 'diff-line diff-del');
  assert.equal(script?.children[0], '-<script>alert(1)</script>\n');
  assert.equal(lines.find((line) => String(line.children[0]).startsWith('+<img'))?.attrs.class, 'diff-line diff-add');
  assert.equal(lines[4].attrs.class, 'diff-line diff-hunk');
  assert.equal(lines[0].attrs.class, 'diff-line diff-file');
  assert.equal(all(nodes, (node) => node.tag === 'script' || node.tag === 'img').length, 0);
  assert.equal(all(nodes, (node) => node.tag === 'pre').length, 2, 'one pre per file with a patch');
});

test('cut files, a file past the cap, an incomplete diff and untracked names are visible', async () => {
  const { page } = await render(DIFF);
  assert.match(page, /Not everything is shown/);
  assert.match(page, /Cut: this file's diff is too large to show whole\./);
  assert.match(page, /Not shown: the diff reached its size limit before this file\./);
  assert.match(page, /Untracked, by name \(4\)/);
  assert.match(page, /NOTES\.md/);
  assert.match(page, /tmp\//);
  assert.match(page, /and 2 more/);
});

// Every truncated file says «diff truncado» on its own line.
test('each truncated file, cut or left without a patch, shows "diff truncated" in its heading; a whole one does not', async () => {
  for (const [language, notice] of [['en', 'diff truncated'], ['es', 'diff truncado']]) {
    const { nodes } = await render(DIFF, { language });
    const headings = all(nodes, (node) => node.tag === 'details').map((details) => details.children.find((child) => typeof child !== 'string' && child.tag === 'summary') as Node);
    assert.deepEqual(
      headings.map((summary) => all([summary], (node) => node.tag === 'span' && String(node.attrs.class ?? '').split(' ').includes('changes-truncated')).map(text)),
      [[], [notice], [notice]],
      language,
    );
    assert.match(text(headings[1]), new RegExp(`^old\\.txt → new\\.txt \\+0 −0 ${notice}$`), language);
  }
});

test('a clean folder, the "not available" reasons and Spanish', async () => {
  const clean = { cwd: '/w/a', diff: { available: true, totals: { files: 0, added: 0, removed: 0 }, files: [], complete: true, untracked: { count: 0, complete: true, paths: [] } } };
  assert.match((await render(clean)).page, /No changes against the last commit\./);
  const reasons: Record<string, RegExp> = {
    not_repo: /Not available: this folder is not a git repository\./,
    no_commits: /Not available: this repository has no commits yet\./,
    outside_root: /Not available: this folder's repository lies outside the workspace folder\./,
    git_missing: /Not available: git is not installed or not on PATH\./,
    git_failed: /Not available: git could not read this folder\./,
    surprise: /Not available: git could not read this folder\./,
  };
  for (const [reason, expected] of Object.entries(reasons)) assert.match((await render({ cwd: '/w/a', diff: { available: false, reason } })).page, expected, reason);
  const es = await render(DIFF, { language: 'es' });
  assert.match(es.page, /3 archivos modificados: \+3 −2/);
  assert.match(es.page, /binario/);
  assert.deepEqual(es.headings.at(-1), ['Cambios', '/work/dev/app']);
  assert.match((await render({ cwd: '/w/a', diff: { available: false, reason: 'no_commits' } }, { language: 'es' })).page, /No disponible: este repositorio todavía no tiene commits\./);
});

test('the view is registered for both modes in workspaces.js and never writes HTML', () => {
  const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');
  assert.match(workspacesJs, /registerPanelView\(changesView\(\{ api, el, t \}\)\);/);
  for (const file of ['public/features/changes-panel.js', 'public/features/changes-model.js']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    // Only the pure model, by a relative path: Node and the browser both load it.
    assert.deepEqual(source.match(/^import .*$/gm) ?? [], file.endsWith('panel.js') ? ["import { classifyPatch, lineClass } from './changes-model.js';"] : [], file);
  }
});
