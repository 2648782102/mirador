// Modal dialogs on <dialog> + showModal(): the page behind is inert, Escape cancels,
// and focus returns to the control that opened the dialog. Mounted in the `modals` slot.
// showAlert stands in for window.alert: an inline role=alert line, never a native box.
import { el, slot, t } from '/core.js';
import { icon } from '/icons.js';

let nextId = 0;

/**
 * Opens a modal and resolves with the value of the action that closed it, or null
 * when cancelled (Escape or an action whose value is null).
 *
 * - `body`: nodes for the dialog body (labels, inputs, lists).
 * - `actions`: [{ label, value, kind: 'primary' | 'danger' | 'secondary', busyLabel? }],
 *   in visual order; the first `secondary` with value null is the cancel button. With none,
 *   the dialog has no action bar.
 * - `close`: optional label of an × at the top right that cancels, as Escape does.
 * - `initialFocus`: an element in `body`, or 'cancel' to start on the cancel button (the × when
 *   there is none).
 * - `onAction(value)`: optional async check before closing; return false (or throw,
 *   after showing the error yourself) to keep the dialog open. While it runs, the
 *   pressed button shows `busyLabel` and every action is disabled.
 */
export function openDialog({ title, body = [], actions, close, initialFocus = 'cancel', onAction, className = '' }) {
  const opener = document.activeElement;
  const titleId = `dialog-title-${++nextId}`;
  const buttons = actions.map((action) =>
    el('button', { type: 'button', class: `btn ${action.kind ?? 'secondary'}` }, action.label),
  );
  const dialog = el(
    'dialog',
    { class: `dialog ${className}`.trim(), 'aria-labelledby': titleId },
    el('h2', { id: titleId }, title),
    el('div', { class: 'dialog-body' }, body),
    actions.length ? el('div', { class: 'dialog-actions' }, buttons) : null,
  );

  return new Promise((resolve) => {
    let result = null;
    let busy = false;
    const finish = (value) => {
      result = value;
      dialog.close();
    };
    const closeButton = close
      ? el('button', { type: 'button', class: 'dialog-close', title: close, 'aria-label': close, onclick: () => busy || finish(null) }, icon('close'))
      : null;
    if (closeButton) dialog.querySelector('h2').after(closeButton);
    actions.forEach((action, i) => {
      buttons[i].addEventListener('click', async () => {
        if (busy) return;
        if (action.value === null || !onAction) return finish(action.value);
        busy = true;
        const label = buttons[i].textContent;
        if (action.busyLabel) buttons[i].textContent = action.busyLabel;
        buttons.forEach((b) => { b.disabled = true; });
        buttons[i].setAttribute('aria-busy', 'true');
        let close = false;
        try {
          close = (await onAction(action.value)) !== false;
        } catch {
          close = false;
        } finally {
          busy = false;
          buttons[i].textContent = label;
          buttons.forEach((b) => { b.disabled = false; });
          buttons[i].removeAttribute('aria-busy');
        }
        if (close) finish(action.value);
      });
    });
    // Enter in a text field runs the primary action instead of submitting a form.
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || event.target.type === 'checkbox') return;
      const primary = actions.findIndex((a) => a.kind === 'primary' || a.kind === 'danger');
      if (primary >= 0) {
        event.preventDefault();
        buttons[primary].click();
      }
    });
    dialog.addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    });

    slot('modals').append(dialog);
    dialog.showModal();
    const cancel = buttons[actions.findIndex((a) => a.value === null)] ?? closeButton;
    const target = initialFocus === 'cancel' ? cancel : initialFocus;
    (target ?? buttons[0])?.focus();
  });
}

/** A yes/no question; resolves true only when the confirm button was pressed. Focus starts on Cancel. */
export async function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false }) {
  const value = await openDialog({
    title,
    body: [el('p', {}, message)],
    actions: [
      { label: cancelLabel, value: null },
      { label: confirmLabel, value: 'confirm', kind: danger ? 'danger' : 'primary' },
    ],
  });
  return value === 'confirm';
}

/**
 * Shows `message` inline in place of window.alert, as a role=alert line that screen readers
 * announce when it appears: at the end of the open modal's body (the page behind it is inert),
 * else in the alerts slot under the top bar, with an × that clears it. A new message replaces it.
 */
export function showAlert(message) {
  const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
  const host = modal?.querySelector('.dialog-body') ?? slot('alerts');
  host.querySelector(':scope > .inline-alert')?.remove();
  const line = el('p', { class: 'field-error inline-alert', role: 'alert' }, message);
  if (modal) return host.append(line);
  const close = el('button', { type: 'button', class: 'close', title: t('alert.dismiss'), 'aria-label': t('alert.dismiss'), onclick: () => host.replaceChildren() }, icon('close'));
  host.replaceChildren(line, close);
}
