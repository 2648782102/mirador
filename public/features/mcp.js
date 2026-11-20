// MCP servers per project: "MCP" on each folder row
// (not on workspace rows: the user chose folders only) opens a dialog with one switch per
// server, its source and estimated memory, the saving per agent of the selection, and what saving
// does in git. Descriptions open on demand and the notes fold into "Cómo funciona".
// Saving writes only `"enabled": false` overrides into the
// folder's .pi/mcp.json (src/mcp/project-mcp.ts); agents already open keep their servers. Rules
// in mcp-model.js.
import { api, el, errorText, getLanguage, registerRowAction, t, workspaceById } from '/core.js';
import { openDialog } from '/dialog.js';
import { icon } from '/icons.js';
import { plural } from '/i18n.js';
import { isDirty, memoryLabel, noteKeys, offNames, savePayload, savingEstimate } from '/features/mcp-model.js';

registerRowAction({
  id: 'mcp',
  text: () => t('mcp.action'),
  icon: 'plug',
  // Chosen per folder: a workspace row (its root) does not show it.
  folderOnly: true,
  // Pi's MCP servers: plain mode leaves the action out (public/mode-model.js).
  extra: 'mcp',
  title: (folder, path) => t('mcp.actionTitle', { path }),
  run: (folder) => openMcp(folder),
});

/** Nothing to start: the row action is registered when the module loads, before the tree renders. */
export async function init() {}

const folderName = (folder) => (folder.rel ? folder.rel.split('/').pop() : workspaceById(folder.ws)?.name ?? folder.ws);

/** Opens the MCP servers dialog of a folder ({ ws, rel }). */
export async function openMcp(folder) {
  const list = el('div', { class: 'mcp-list', role: 'group', 'aria-label': t('mcp.listLabel') }, el('p', { class: 'hint' }, t('mcp.loading')));
  const saving = el('p', { class: 'mcp-saving' });
  const warnings = el('div', { class: 'mcp-notes' });
  const caret = () => {
    const node = icon('chev-right', { size: 'sm' });
    node.classList.add('mcp-caret');
    return node;
  };
  const howBody = el('div', { class: 'mcp-notes' }, el('p', { class: 'hint' }, t('mcp.applies')));
  // Native details/summary: Enter and Space open it; closed until the user asks.
  const how = el('details', { class: 'mcp-how' }, el('summary', {}, caret(), t('mcp.howItWorks')), howBody);
  const status = el('p', { class: 'mcp-status', role: 'status' });
  let view = null;
  let off = new Set();

  function serverRow(server) {
    const id = `mcp-${server.name}`;
    const meta = [t(`mcp.source.${server.source}`), memoryLabel(server.estimatedMb) ?? t('mcp.noEstimate')];
    if (server.locked) meta.push(t('mcp.locked'));
    const box = el('input', {
      type: 'checkbox',
      role: 'switch',
      id,
      checked: server.locked ? false : !off.has(server.name),
      disabled: server.locked,
      'aria-describedby': `${id}-meta`,
    });
    box.addEventListener('change', () => {
      if (box.checked) off.delete(server.name);
      else off.add(server.name);
      status.textContent = '';
      renderSaving();
    });
    // The description opens on demand: a button beside the name, and a tooltip on the name.
    const about = server.description ? el('p', { class: 'hint mcp-server-description', id: `${id}-about`, hidden: true }, server.description) : null;
    const describe = t('mcp.describe', { name: server.name });
    const more = about
      ? el('button', { type: 'button', class: 'btn icon-btn mcp-server-more', 'aria-expanded': 'false', 'aria-controls': `${id}-about`, 'aria-label': describe, title: describe }, icon('chev-down', { size: 'sm' }))
      : null;
    more?.addEventListener('click', () => {
      about.hidden = !about.hidden;
      more.setAttribute('aria-expanded', String(!about.hidden));
    });
    return el(
      'div',
      { class: server.locked ? 'mcp-server locked' : 'mcp-server' },
      box,
      el(
        'div',
        { class: 'mcp-server-text' },
        el('label', { for: id, class: 'mcp-server-name', title: server.description ?? undefined }, server.name),
        el('span', { class: 'hint', id: `${id}-meta` }, meta.join(' · ')),
        about,
      ),
      more,
    );
  }

  function renderSaving() {
    const estimate = savingEstimate(view.servers, off);
    if (!estimate.count) {
      saving.textContent = t('mcp.savingNone');
      return;
    }
    const unknown = estimate.unknown ? `, ${plural(getLanguage(), 'mcp.savingUnknown', estimate.unknown)}` : '';
    saving.textContent = `${t('mcp.saving', { mb: estimate.mb })}${unknown}`;
  }

  function render() {
    list.replaceChildren(...(view.servers.length ? view.servers.map(serverRow) : [el('p', { class: 'hint' }, t('mcp.empty'))]));
    renderSaving();
    const keys = noteKeys(view);
    warnings.replaceChildren(...keys.warnings.map((key) => el('p', { class: 'mcp-note warn' }, icon('error'), t(key))));
    // The git note comes first, after the file's path; then the estimate and when it applies.
    howBody.replaceChildren(...keys.howItWorks.map((key, i) => (i ? el('p', { class: 'hint' }, t(key)) : el('p', { class: 'mcp-note' }, el('code', {}, view.file), ' ', t(key)))));
  }

  api('GET', `/api/mcp?${new URLSearchParams({ ws: folder.ws, rel: folder.rel })}`)
    .then((answer) => {
      view = answer;
      off = offNames(view.servers);
      render();
    })
    .catch((error) => list.replaceChildren(el('p', { class: 'field-error' }, errorText(error))));

  async function save() {
    if (!view) return false;
    if (!isDirty(view.servers, off)) {
      status.textContent = t('mcp.unchanged');
      return false;
    }
    try {
      const answer = await api('PUT', '/api/mcp', savePayload(folder, view.servers, off));
      view = answer;
      off = offNames(view.servers);
      render();
      status.textContent = t(answer.saved.excluded ? 'mcp.savedExcluded' : answer.git === 'tracked' ? 'mcp.savedTracked' : 'mcp.saved');
    } catch (error) {
      // The switches keep what the user chose; they can try again.
      status.textContent = errorText(error);
    }
    return false;
  }

  await openDialog({
    title: t('mcp.title', { name: folderName(folder) }),
    className: 'mcp-dialog',
    body: [el('p', {}, t('mcp.intro')), list, saving, warnings, how, status],
    close: t('mcp.close'),
    actions: [
      { label: t('mcp.save'), value: 'save', kind: 'primary', busyLabel: t('mcp.saveBusy') },
    ],
    onAction: save,
  });
}
