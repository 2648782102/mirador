// Pure rule behind a returning window retaking the pty size.
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
