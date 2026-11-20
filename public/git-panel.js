// The floating lazygit panel: the tree's git mark opens lazygit for its folder over the deck,
// without a tab or a grid pane, and the panel closes (and its terminal ends) when lazygit quits.
import { api, el, errorText, t } from '/core.js';
import { showAlert } from '/dialog.js';
import { icon } from '/icons.js';
import { connectTerminal, newTerminalSize } from '/terminals.js';

/** The open panel: { key, info, record, overlay, opener }, or null. One at a time. */
let current = null;

/**
 * Opens lazygit for `folder` ({ ws, rel }) in the panel, titled with `name`. The same folder only
 * takes focus again; another folder's lazygit is closed first.
 */
export async function openGitPanel(folder, name) {
  const key = `${folder.ws}|${folder.rel}`;
  if (current?.key === key) {
    current.record?.term.focus();
    return;
  }
  closeGitPanel();
  const opener = document.activeElement;
  let info;
  try {
    info = await api('POST', '/api/terminals', { ws: folder.ws, rel: folder.rel, kind: 'git', ...newTerminalSize() });
  } catch (error) {
    showAlert(t('term.openFailed', { error: errorText(error) }));
    return;
  }
  const body = el('div', { class: 'git-panel-body' });
  const card = el(
    'div',
    { class: 'git-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('git.panelTitle', { name }) },
    el('div', { class: 'git-panel-head' }, icon('git'), el('span', { class: 'git-panel-title' }, t('git.panelTitle', { name })), el('button', { class: 'close', title: t('git.close'), 'aria-label': t('git.close'), onclick: () => closeGitPanel() }, icon('close'))),
    body,
  );
  // Escape belongs to lazygit, and a click outside does nothing: only quitting lazygit or × close it.
  const overlay = el('div', { class: 'overlay git-panel-overlay' }, card);
  document.body.append(overlay);
  // aria-modal holds only while the page behind is inert, as drawers.js does; the modals slot stays
  // live for a dialog opened over the panel. Only the nodes marked here are given back.
  for (const node of document.body.children) {
    if (node === overlay || node.inert || node.matches('[data-slot="modals"]')) continue;
    node.inert = true;
    node.dataset.gitInert = '';
  }
  const panel = { key, info, record: null, overlay, opener };
  current = panel;
  panel.record = connectTerminal(info, card, body, {
    exited: () => closeGitPanel(),
    kept: () => current === panel,
  });
  panel.record.term.focus();
}

/** Closes the panel, ends its terminal on the server and gives the focus back. */
export function closeGitPanel() {
  const panel = current;
  if (!panel) return;
  current = null;
  panel.record?.ws?.close();
  panel.record?.term.dispose();
  panel.overlay.remove();
  for (const node of document.querySelectorAll('[data-git-inert]')) {
    node.inert = false;
    delete node.dataset.gitInert;
  }
  api('DELETE', `/api/terminals/${panel.info.id}`).catch(() => {});
  if (panel.opener?.isConnected) panel.opener.focus();
}
