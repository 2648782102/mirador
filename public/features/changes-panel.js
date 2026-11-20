// The "Changes" panel view for a folder or a workspace: the
// stat of its changes against HEAD and each file's diff coloured by line kind, from
// GET /api/folder/diff (src/http/routes/git-diff.ts), which only reads the repository. It needs no
// gentle extra, so plain and gentle-deck modes both offer it. Diff text only ever becomes text
// nodes inside spans with a class (changes-model.js): el() appends strings as text, never markup.
// Only the pure model is imported: public/features/workspaces.js passes api, el and t, and
// test/changes-model.test.ts renders it in Node with a fake el.
import { classifyPatch, lineClass } from './changes-model.js';

const UNAVAILABLE = ['not_repo', 'no_commits', 'outside_root', 'git_missing', 'git_failed'];

/** The panel view (public/features/summary.js registerPanelView). `deps` = { api, el, t } from /core.js. */
export function changesView({ api, el, t }) {
  const plural = (key, count, vars = {}) => t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...vars });
  const name = (file) => (file.from ? `${file.from} → ${file.path}` : file.path);

  function counts(file) {
    if (file.binary) return [el('span', { class: 'changes-binary' }, t('changes.binary'))];
    return [el('span', { class: 'changes-added' }, `+${file.added}`), ' ', el('span', { class: 'changes-removed' }, `−${file.removed}`)];
  }

  function statPart(diff) {
    const more = diff.totals.files - diff.files.length;
    return el(
      'section',
      { class: 'changes-stat', 'aria-label': t('changes.title') },
      el('p', { class: 'changes-summary' }, plural('changes.stat', diff.totals.files, { added: diff.totals.added, removed: diff.totals.removed })),
      diff.complete ? null : el('p', { class: 'notice' }, t('changes.incomplete')),
      el('ul', { class: 'changes-files' }, diff.files.map((file) => el('li', {}, el('code', {}, name(file)), ' ', ...counts(file)))),
      more > 0 ? el('p', { class: 'changes-more' }, t('changes.moreFiles', { count: more })) : null,
    );
  }

  function filePart(file) {
    const note = file.truncated ? el('p', { class: 'changes-more' }, t(file.patch ? 'changes.fileCut' : 'changes.fileOmitted')) : null;
    // One span per line, its text a single text node; the newline keeps lines apart inside <pre>.
    const body = file.patch ? el('pre', { class: 'changes-diff' }, classifyPatch(file.patch).map((line) => el('span', { class: lineClass(line.kind) }, `${line.text}\n`))) : null;
    // «diff truncado» in the heading too, so a collapsed file still says it.
    const flag = file.truncated ? [' ', el('span', { class: 'changes-more changes-truncated' }, t('changes.truncated'))] : [];
    return el('details', { class: 'changes-file', open: true }, el('summary', {}, el('code', {}, name(file)), ' ', ...counts(file), ...flag), body, note);
  }

  function untrackedPart(untracked) {
    if (untracked.count === 0) return null;
    const more = untracked.count - untracked.paths.length;
    return el(
      'section',
      { class: 'changes-untracked' },
      el('h4', { class: 'leftoff-eyebrow' }, t('changes.untracked', { count: untracked.count })),
      el('ul', { class: 'changes-files' }, untracked.paths.map((path) => el('li', {}, el('code', {}, path)))),
      more > 0 ? el('p', { class: 'changes-more' }, t('changes.untrackedMore', { count: more })) : null,
    );
  }

  return {
    id: 'changes',
    label: 'changes.view',
    applies: (selection) => selection !== null,
    async render({ selection, setHeading }) {
      setHeading(t('changes.title'));
      const data = await api('GET', `/api/folder/diff?${new URLSearchParams({ ws: selection.ws, rel: selection.rel })}`);
      setHeading(t('changes.title'), data.cwd);
      const diff = data.diff;
      if (!diff.available) return [el('p', { class: 'notice' }, t(`changes.unavailable.${UNAVAILABLE.includes(diff.reason) ? diff.reason : 'git_failed'}`))];
      if (diff.totals.files === 0 && diff.untracked.count === 0) return [el('p', { class: 'notice' }, t('changes.clean'))];
      return [statPart(diff), ...diff.files.map(filePart), untrackedPart(diff.untracked)].filter(Boolean);
    },
  };
}
