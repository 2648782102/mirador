// File editor (W5): a "Files" button on every workspace and folder row opens a dialog with
// the folder's files (dotenv files first) and a plain-text editor, so the .env an agent is
// waiting for can be filled in without leaving Mirador. A save sends back the version it
// read: when an agent changed the file meanwhile, Mirador asks to reload or overwrite
// instead of silently losing either side. File text only ever goes through
// textarea.value and textContent, never HTML.
import { api, el, errorText, getLanguage, on, registerRowAction, slot, t, workspaceById } from '/core.js';
import { confirmDialog, openDialog } from '/dialog.js';
import { icon } from '/icons.js';

const ENV = '.env';
const ENV_EXAMPLE = '.env.example';

let editor = null;

registerRowAction({
  id: 'files',
  text: () => t('files.action'),
  icon: 'files',
  title: (folder, path) => t('files.actionTitle', { path }),
  run: (folder) => openFiles(folder),
});

/** Opens the editor on a folder ({ ws, rel }) and, when `name` is given, on that file. */
export async function openFiles(folder, name = null) {
  editor ??= createEditor(() => { editor = null; });
  await editor.show(folder, name);
}

/**
 * Where `files:open` points: `path` may be a file name in `rel`, a path below it,
 * or an absolute path inside the workspace root. The server checks it all again.
 */
function targetOf(detail) {
  const workspace = workspaceById(detail?.ws);
  if (!workspace) return null;
  let rel = typeof detail.rel === 'string' ? detail.rel : '';
  let path = typeof detail.path === 'string' ? detail.path : '';
  if (path.startsWith('/')) {
    const root = workspace.root.replace(/\/+$/, '');
    if (!path.startsWith(`${root}/`)) return { folder: { ws: workspace.id, rel }, name: null };
    path = path.slice(root.length + 1);
    rel = '';
  }
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? null;
  return { folder: { ws: workspace.id, rel: [rel, ...parts].filter(Boolean).join('/') }, name };
}

function folderLabel(folder) {
  return folder.rel ? folder.rel.split('/').pop() : workspaceById(folder.ws)?.name ?? folder.ws;
}

function folderPath(folder) {
  const root = workspaceById(folder.ws)?.root ?? '';
  return folder.rel ? `${root.replace(/\/+$/, '')}/${folder.rel}` : root;
}

function createEditor(onClosed) {
  const titleId = 'files-dialog-title';
  const title = el('h2', { id: titleId });
  const where = el('p', { class: 'hint files-where', translate: 'no' });
  const closeIcon = el('button', { type: 'button', class: 'btn icon' }, icon('close'));
  const createButton = el('button', { type: 'button', class: 'btn primary files-create', hidden: true });
  const listNode = el('div', { class: 'files-list' });
  const nav = el('nav', { class: 'files-nav' }, createButton, listNode);
  const fileName = el('h3', { class: 'files-name', translate: 'no' });
  const readOnlyTag = el('span', { class: 'files-tag', hidden: true });
  const empty = el('p', { class: 'files-empty' });
  const text = el('textarea', { class: 'files-text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', hidden: true });
  const status = el('p', { class: 'files-status', role: 'status' });
  const shortcut = el('span', { class: 'hint files-shortcut' });
  const saveButton = el('button', { type: 'button', class: 'btn primary', disabled: true });
  const dialog = el(
    'dialog',
    { class: 'dialog files-dialog', 'aria-labelledby': titleId },
    el('div', { class: 'files-head' }, el('div', { class: 'files-heading' }, title, where), closeIcon),
    el('div', { class: 'files-main' }, nav, el('section', { class: 'files-editor' }, el('div', { class: 'files-editor-head' }, fileName, readOnlyTag), empty, text)),
    el('div', { class: 'files-foot' }, status, shortcut, saveButton),
  );

  let folder = null;
  let files = [];
  let truncated = false;
  let listed = false;
  /** The open file: { name, version, loaded (text as the textarea shows it), eol, readOnly }. */
  let current = null;
  let busy = false;
  let closing = false;
  let wasDirty = false;
  let opener = null;
  let statusText = () => '';

  const dirty = () => !!current && text.value !== current.loaded;
  const folderQuery = (extra = {}) => new URLSearchParams({ ws: folder.ws, rel: folder.rel, ...extra }).toString();
  const canCreateEnv = () => files.some((f) => f.name === ENV_EXAMPLE) && !files.some((f) => f.name === ENV);

  function setStatus(render, kind = 'info') {
    statusText = render;
    status.textContent = render();
    status.dataset.kind = kind;
  }

  function showError(error) {
    setStatus(() => errorText(error), 'error');
  }

  function setBusy(button, active, label) {
    busy = active;
    for (const b of [saveButton, createButton, closeIcon]) b.disabled = active;
    if (active) {
      button.dataset.label = button.textContent;
      button.textContent = label;
      button.setAttribute('aria-busy', 'true');
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.removeAttribute('aria-busy');
      saveButton.disabled = !current || current.readOnly;
      // A button that was disabled while focused drops the focus; keep it in the dialog.
      if (dialog.open && !dialog.contains(document.activeElement)) (current ? text : closeIcon).focus();
    }
  }

  function item(file) {
    const open = current?.name === file.name;
    return el(
      'li',
      {},
      el(
        'button',
        {
          type: 'button',
          class: 'files-item',
          'aria-current': open ? 'true' : null,
          disabled: file.tooLarge,
          title: file.tooLarge ? t('files.tooLarge') : file.symlink ? t('files.symlink') : null,
          onclick: () => openFile(file.name),
        },
        el('span', { class: 'files-item-name', translate: 'no' }, file.name),
        file.symlink ? el('span', { class: 'files-tag' }, icon('delegate', { size: 'sm', label: t('files.symlink') })) : null,
        file.tooLarge ? el('span', { class: 'files-tag' }, t('files.tooLargeTag')) : null,
        open && dirty() ? el('span', { class: 'files-tag warn' }, t('files.unsavedMark')) : null,
      ),
    );
  }

  function renderList() {
    const group = (key, items) => (items.length ? [el('h4', { class: 'files-group' }, t(key)), el('ul', {}, items.map(item))] : []);
    listNode.replaceChildren(
      ...group('files.groupEnv', files.filter((f) => f.dotenv)),
      ...group('files.groupOther', files.filter((f) => !f.dotenv)),
      ...(files.length ? [] : [el('p', { class: 'hint' }, t('files.empty'))]),
      ...(truncated ? [el('p', { class: 'hint' }, t('files.truncated', { count: files.length }))] : []),
    );
    createButton.hidden = !canCreateEnv();
    if (!current) empty.textContent = t(!listed ? 'common.loading' : canCreateEnv() ? 'files.noEnv' : files.length ? 'files.pick' : 'files.empty');
  }

  function renderChrome() {
    title.textContent = t('files.title', { name: folderLabel(folder) });
    where.textContent = folderPath(folder);
    nav.setAttribute('aria-label', t('files.listLabel'));
    closeIcon.setAttribute('aria-label', t('files.close'));
    closeIcon.title = t('files.close');
    if (!busy) {
      createButton.textContent = t('files.createEnv');
      saveButton.textContent = t('files.save');
    }
    shortcut.textContent = t('files.shortcut');
    readOnlyTag.textContent = t('files.readOnly');
    if (current) text.setAttribute('aria-label', t('files.editorLabel', { name: current.name }));
    status.textContent = statusText();
    renderList();
  }

  function showFile(file) {
    // A textarea shows line breaks as \n; a file saved with \r\n keeps them on save.
    const eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    current = { name: file.name, version: file.version, loaded: file.content.replaceAll('\r\n', '\n'), eol, readOnly: file.readOnly };
    text.value = current.loaded;
    text.readOnly = file.readOnly;
    text.hidden = false;
    empty.hidden = true;
    fileName.textContent = file.name;
    readOnlyTag.hidden = !file.readOnly;
    saveButton.disabled = file.readOnly;
    wasDirty = false;
    renderChrome();
    setStatus(() => t(file.readOnly ? 'files.readOnlyStatus' : 'files.opened', { name: file.name }), file.readOnly ? 'error' : 'info');
  }

  function clearFile() {
    current = null;
    text.value = '';
    text.hidden = true;
    empty.hidden = false;
    fileName.textContent = '';
    readOnlyTag.hidden = true;
    saveButton.disabled = true;
    setStatus(() => '');
  }

  /**
   * Gives the editor its caret back after a nested dialog closed. Chromium can leave a
   * textarea that was focused when the nested modal opened "focused" but deaf to typing
   * until it is blurred and focused again.
   */
  function refocus() {
    if (!dialog.open || !current || text.hidden) return;
    text.blur();
    text.focus();
  }

  /** True when there is nothing unsaved, or the user chose to drop it. */
  async function discardOk() {
    if (!dirty()) return true;
    const discard = await confirmDialog({
      title: t('files.discardTitle', { name: current.name }),
      message: t('files.discardBody'),
      confirmLabel: t('files.discard'),
      cancelLabel: t('files.keepEditing'),
      danger: true,
    });
    refocus();
    return discard;
  }

  async function refreshList() {
    listNode.replaceChildren(el('p', { class: 'hint' }, t('common.loading')));
    try {
      ({ files, truncated } = await api('GET', `/api/files?${folderQuery()}`));
      listed = true;
    } catch (error) {
      files = [];
      truncated = false;
      listed = true;
      renderList();
      showError(error);
      return false;
    }
    renderList();
    return true;
  }

  async function openFile(name, { reload = false } = {}) {
    if (!reload && current?.name === name) return true;
    if (!reload && !(await discardOk())) return false;
    setStatus(() => t('files.opening', { name }));
    try {
      showFile(await api('GET', `/api/files/content?${folderQuery({ name })}`));
    } catch (error) {
      showError(error);
      return false;
    }
    text.focus();
    return true;
  }

  async function put(version) {
    const value = text.value;
    const content = current.eol === '\r\n' ? value.replaceAll('\n', '\r\n') : value;
    let conflict = false;
    setBusy(saveButton, true, t('files.saving'));
    setStatus(() => t('files.saving'));
    try {
      const saved = await api('PUT', '/api/files/content', { ws: folder.ws, rel: folder.rel, name: current.name, content, version });
      current.version = saved.version;
      current.loaded = value;
      const time = new Date().toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
      setStatus(() => t('files.saved', { time }), 'ok');
    } catch (error) {
      if (error.code === 'file_changed') conflict = true;
      showError(error);
    } finally {
      setBusy(saveButton, false);
      onInput();
    }
    if (conflict) await resolveConflict();
  }

  async function save() {
    if (!current || busy) return;
    if (current.readOnly) return setStatus(() => t('files.readOnlyStatus'), 'error');
    if (!dirty()) return setStatus(() => t('files.nothingToSave'));
    await put(current.version);
  }

  /** The file changed on disk after it was opened: reload it, or overwrite it with what is in the editor. */
  async function resolveConflict() {
    const choice = await openDialog({
      title: t('files.conflictTitle', { name: current.name }),
      body: [el('p', {}, t('files.conflictBody'))],
      actions: [
        { label: t('files.keepEditing'), value: null },
        { label: t('files.reload'), value: 'reload' },
        { label: t('files.overwrite'), value: 'overwrite', kind: 'danger' },
      ],
    });
    refocus();
    if (choice === 'reload') return openFile(current.name, { reload: true });
    if (choice !== 'overwrite') return setStatus(() => t('files.conflictKept'), 'error');
    try {
      const latest = await api('GET', `/api/files/content?${folderQuery({ name: current.name })}`);
      await put(latest.version);
    } catch (error) {
      showError(error);
    }
  }

  async function createEnv() {
    if (busy || !(await discardOk())) return;
    let message = 'files.created';
    setBusy(createButton, true, t('files.creating'));
    try {
      await api('POST', '/api/files/env', { ws: folder.ws, rel: folder.rel });
    } catch (error) {
      if (error.code !== 'file_exists') {
        setBusy(createButton, false);
        return showError(error);
      }
      message = 'files.envExists';
    }
    setBusy(createButton, false);
    await refreshList();
    if (await openFile(ENV, { reload: true })) setStatus(() => t(message), 'ok');
  }

  function onInput() {
    if (dirty() === wasDirty) return;
    wasDirty = dirty();
    renderList();
    if (wasDirty) setStatus(() => t('files.unsaved'));
  }

  async function requestClose() {
    if (busy || closing) return;
    closing = true;
    try {
      if (await discardOk()) dialog.close();
    } finally {
      closing = false;
    }
  }

  function focusStart() {
    const target = !createButton.hidden ? createButton : listNode.querySelector('button:not(:disabled)') ?? closeIcon;
    target.focus();
  }

  text.addEventListener('input', onInput);
  saveButton.addEventListener('click', save);
  createButton.addEventListener('click', createEnv);
  closeIcon.addEventListener('click', requestClose);
  dialog.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape' && !event.isComposing) {
      // Escape asks first when there are unsaved changes, instead of closing right away.
      event.preventDefault();
      requestClose();
    }
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    requestClose();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClosed();
    if (opener instanceof HTMLElement && opener.isConnected) {
      opener.focus({ preventScroll: true });
      // Row buttons only show on hover or focus: fall back to their row.
      if (document.activeElement !== opener) opener.closest('[tabindex]')?.focus({ preventScroll: true });
    }
  });
  const offLanguage = on('language', () => folder && renderChrome());
  dialog.addEventListener('close', offLanguage);

  return {
    dirty,
    async show(next, name) {
      if (!dialog.open) {
        opener = document.activeElement;
        slot('modals').append(dialog);
        dialog.showModal();
      }
      const same = folder && folder.ws === next.ws && folder.rel === (next.rel ?? '');
      if (!same) {
        if (folder && !(await discardOk())) return;
        folder = { ws: next.ws, rel: next.rel ?? '' };
        listed = false;
        clearFile();
      }
      renderChrome();
      if (!(await refreshList())) return closeIcon.focus();
      const target = name ?? (!current && files.some((f) => f.name === ENV) ? ENV : null);
      if (target) await openFile(target);
      else if (!current) focusStart();
    },
  };
}

export async function init() {
  on('files:open', (detail) => {
    const target = targetOf(detail);
    if (target) openFiles(target.folder, target.name);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!editor?.dirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
