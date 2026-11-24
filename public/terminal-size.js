// Pure rules behind a window retaking the pty size: when it comes back, and on typing or clicking.
// DOM-free (no core.js import) so test/terminal-size.test.ts can run it in Node.

/**
 * Resize messages a window sends when it comes back (focus, or the page shown again):
 * the pty keeps the last size any window sent, so each terminal visible here sends its
 * size even if unchanged. Hidden panes (no size of their own) and terminals whose replay
 * is still being written send nothing, nor does a size that was never measured.
 * `terminals` is [{ id, visible, replaying, cols, rows }]; returns [{ id, message }].
 */
export function returningSizes(terminals) {
  return terminals
    .filter(({ visible, replaying, cols, rows }) => visible && !replaying && cols > 0 && rows > 0)
    .map(({ id, cols, rows }) => ({ id, message: { t: 'r', c: cols, r: rows } }));
}

/** Least time, in ms, between two size resends that typing or clicking in one terminal causes. */
export const INPUT_RETAKE_GAP = 1000;

/**
 * Whether typing or clicking in a terminal resends its size: another window (a phone) may have
 * taken the pty size while this one kept the focus, so no focus event came back. At most once
 * per `gap` ms per terminal; `last` is when it last resent (undefined: never).
 */
export function inputRetakeDue(last, now, gap = INPUT_RETAKE_GAP) {
  return last === undefined || now - last >= gap;
}
