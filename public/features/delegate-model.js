// Pure rules behind "Delegar a Mirador" (public/features/workspaces.js):
// the instruction field, the POST /api/terminals/batch body and its per-folder report.
// No DOM and no core.js: the browser and the tests import it.

/** Longest instruction, in characters after trimming; the server's MAX_INSTRUCTION_CHARS (src/terminals/open-many.ts). */
export const MAX_INSTRUCTION = 2000;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const normalize = (text) => String(text ?? '').replace(/\r\n?/g, '\n').trim();

/** The instruction's length as the server counts it, and what is wrong with it: 'empty', 'too_long', 'control' or null. */
export function checkInstruction(text) {
  const clean = normalize(text);
  const error = !clean ? 'empty' : clean.length > MAX_INSTRUCTION ? 'too_long' : CONTROL.test(clean) ? 'control' : null;
  return { count: clean.length, error };
}

/** The batch body that delegates `text` to folders `rels` of workspace `ws`. */
export function delegateBody(ws, rels, text, autopilot, size) {
  return { ws, rels: [...rels], instruction: normalize(text), autopilot: !!autopilot, cols: size.cols, rows: size.rows };
}

/** The answer as the terminals to show, one line per folder, how many got the instruction, and the autopilot outcome. */
export function summarizeDelegation({ results, autopilot }) {
  const lines = results.map((r) => ({ rel: r.rel, status: r.status, error: r.error ?? null }));
  const done = lines.filter((line) => line.status === 'opened' || line.status === 'sent').length;
  return {
    opened: results.filter((r) => r.status === 'opened').map((r) => r.terminal),
    lines,
    counts: { done, notDone: lines.length - done },
    autopilot: autopilot ?? null,
  };
}
