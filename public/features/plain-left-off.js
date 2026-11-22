// Plain mode's "Where it left off" for a folder: what the user last asked Claude Code and where it
// got to (the local record of its hooks, src/memory/left-off.ts, when there is one), its branch,
// last commit, changed files and recent commits, and its NOTES.md as plain text, all from
// GET /api/folder/git (src/http/routes/git-status.ts). It never calls an Engram route, so it works
// without gentle-shell, pi or Engram. It sits where gentle-deck shows the Engram "Dónde quedó"
// (public/features/overview.js, a 'memory' extra plain mode leaves out), with the same view id and
// label, so a folder still opens on it. No imports: public/features/workspaces.js passes api, el,
// t, confirm and refresh, and test/plain-left-off.test.ts renders it in Node with a fake el.
// The record's block has Forget (DELETE /api/folder/left-off), asked first with `confirm`, then
// the panel reloads (`refresh`); without both, no Forget.

/** What a two-letter porcelain v1 code means, as a word: the list shows it as text, not only as a code. */
export function changeKind(code) {
  const [x, y] = String(code);
  if (code === '??') return 'untracked';
  if (x === 'U' || y === 'U' || code === 'AA' || code === 'DD') return 'conflict';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/** 'YYYY-MM-DD HH:MM' of an ISO date, on the author's own clock (the offset git printed); anything else as it is. */
export function shortDate(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso));
  return match ? `${match[1]} ${match[2]}` : String(iso);
}

const UNAVAILABLE = ['not_repo', 'outside_root', 'git_missing', 'git_failed'];

/** 'YYYY-MM-DD HH:MM' of an ISO time on this machine's clock (the record's times are UTC). */
export function localTime(iso) {
  const date = new Date(String(iso));
  if (Number.isNaN(date.getTime())) return String(iso);
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The foot line's key for where the record's text comes from, as public/leftoff-model.js sourceKey says it. */
const SOURCE_KEYS = { lastMessage: 'overview.fromClaudeMessage', compactSummary: 'overview.fromClaudeCompact', lastUserMessage: 'overview.fromClaudePrompt' };

/**
 * The panel view (public/features/summary.js registerPanelView) for a folder in plain mode.
 * `deps` = { api, el, t } from /core.js and `isPlain()`, read on each selection: gentle-deck never
 * offers it, and it needs no gentle extra, so plain mode keeps it. `confirm` (/dialog.js
 * confirmDialog) and `refresh` (/features/summary.js refreshPanel) give the record's Forget.
 */
export function plainLeftOffView({ api, el, t, isPlain, confirm, refresh }) {
  const plural = (key, count) => t(`${key}.${count === 1 ? 'one' : 'other'}`, { count });
  const time = (iso) => el('time', { datetime: iso }, shortDate(iso));
  const line = (label, ...value) => el('p', { class: 'plain-git-line' }, el('span', { class: 'plain-git-label' }, label), ' ', ...value);

  function changesPart(changes) {
    if (changes.count === 0) return [el('p', { class: 'plain-git-line' }, t('plainLeftOff.clean'))];
    const more = changes.count - changes.files.length;
    return [
      el('h4', { class: 'leftoff-eyebrow' }, plural(changes.complete ? 'plainLeftOff.changes' : 'plainLeftOff.changesAtLeast', changes.count)),
      el(
        'ul',
        { class: 'plain-git-changes' },
        changes.files.map((file) =>
          el('li', { title: file.code }, el('span', { class: 'plain-git-kind' }, t(`plainLeftOff.kind.${changeKind(file.code)}`)), ' ', el('code', {}, file.from ? `${file.from} → ${file.path}` : file.path)),
        ),
      ),
      more > 0 ? el('p', { class: 'plain-git-more' }, t('plainLeftOff.more', { count: more })) : null,
    ];
  }

  function gitPart(git) {
    const title = el('h3', { class: 'plain-leftoff-title' }, t('plainLeftOff.gitTitle'));
    if (!git.available) {
      const reason = UNAVAILABLE.includes(git.reason) ? git.reason : 'git_failed';
      return el('section', { class: 'plain-leftoff', 'aria-label': t('plainLeftOff.gitTitle') }, title, el('p', { class: 'notice' }, t(`plainLeftOff.unavailable.${reason}`)));
    }
    const head = git.branch ? line(t('plainLeftOff.branch'), el('code', {}, git.branch)) : git.head ? line(t('plainLeftOff.detached'), el('code', {}, git.head)) : null;
    const last = git.lastCommit
      ? line(t('plainLeftOff.lastCommit'), el('code', {}, git.lastCommit.sha), ' ', el('span', { class: 'plain-git-subject' }, git.lastCommit.subject), ' · ', time(git.lastCommit.date))
      : el('p', { class: 'plain-git-line' }, t('plainLeftOff.noCommits'));
    const recent = git.recent.length
      ? [
          el('h4', { class: 'leftoff-eyebrow' }, t('plainLeftOff.recent')),
          el('ol', { class: 'plain-git-log' }, git.recent.map((c) => el('li', {}, el('code', {}, c.sha), ' ', el('span', { class: 'plain-git-subject' }, c.subject), ' · ', time(c.date)))),
        ]
      : [];
    return el('section', { class: 'plain-leftoff', 'aria-label': t('plainLeftOff.gitTitle') }, title, head, last, ...changesPart(git.changes), ...recent);
  }

  // Forget, as gentle-deck's block: asks first, removes the record, reloads the panel. A failure
  // shows in place of the button's line.
  function forgetButton(selection) {
    if (!confirm || !refresh) return null;
    let busy = false;
    const onclick = async () => {
      if (busy) return;
      const sure = await confirm({ title: t('overview.forgetTitle'), message: t('overview.forgetConfirm'), confirmLabel: t('overview.forget'), cancelLabel: t('overview.cancel'), danger: true });
      if (!sure) return;
      busy = true;
      try {
        await api('DELETE', `/api/folder/left-off?${new URLSearchParams({ ws: selection.ws, rel: selection.rel })}`);
        refresh();
      } catch (error) {
        line.replaceChildren?.(t('overview.forgetFailed', { error: error?.message ?? String(error) }));
      } finally {
        busy = false;
      }
    };
    const line = el('p', { class: 'plain-git-more', role: 'status' });
    return [el('button', { type: 'button', class: 'btn sm ghost', title: t('overview.forgetHint'), onclick }, t('overview.forget')), line];
  }

  // The local record: the user's last message, then the agent's text, both as text in a pre, never markup.
  function leftOffPart(leftOff, selection) {
    const key = SOURCE_KEYS[leftOff.from] ?? SOURCE_KEYS.lastMessage;
    return el(
      'section',
      { class: 'plain-leftoff', 'aria-label': 'Claude Code' },
      el('h3', { class: 'plain-leftoff-title', translate: 'no' }, 'Claude Code'),
      leftOff.lastUserMessage ? [el('h4', { class: 'leftoff-eyebrow' }, t('overview.lastUserMessage')), el('pre', { class: 'plain-notes' }, leftOff.lastUserMessage)] : null,
      leftOff.text ? el('pre', { class: 'plain-notes' }, leftOff.text) : null,
      el('p', { class: 'plain-git-more', title: leftOff.at }, t(key, { when: localTime(leftOff.at) })),
      forgetButton(selection),
    );
  }

  function notesPart(notes) {
    const title = el('h3', { class: 'plain-leftoff-title', translate: 'no' }, 'NOTES.md');
    if (!notes) return el('section', { class: 'plain-leftoff', 'aria-label': 'NOTES.md' }, title, el('p', { class: 'notice' }, t('plainLeftOff.noNotes')));
    // Text only: el() appends it as a text node, so markup in the file stays visible text.
    return el(
      'section',
      { class: 'plain-leftoff', 'aria-label': 'NOTES.md' },
      title,
      el('pre', { class: 'plain-notes' }, notes.text),
      notes.truncated ? el('p', { class: 'plain-git-more' }, t('plainLeftOff.notesCut')) : null,
    );
  }

  return {
    id: 'leftoff',
    label: 'overview.view.folder',
    applies: (selection) => isPlain() && selection !== null && selection.rel !== '',
    async render({ selection, setHeading }) {
      setHeading(t('overview.leftOff'));
      const data = await api('GET', `/api/folder/git?${new URLSearchParams({ ws: selection.ws, rel: selection.rel })}`);
      setHeading(t('overview.leftOff'), data.cwd);
      return [data.leftOff ? leftOffPart(data.leftOff, selection) : null, gitPart(data.git), notesPart(data.notes)].filter(Boolean);
    },
  };
}
