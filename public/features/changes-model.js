// Pure rules of the "Changes" panel: the kind of each line of a
// file's unified diff, and the CSS class that colours it (public/styles/overview.css). No DOM and
// no imports: public/features/changes-panel.js and test/changes-model.test.ts use it.

/**
 * The lines of one file's `patch` (from GET /api/folder/diff) with their kind: 'file' for the
 * headers before the first hunk (diff --git, index, ---, +++, rename, mode, Binary files…),
 * 'hunk' for '@@', then 'add' ('+'), 'del' ('-'), 'note' ('\ No newline…') and 'context'.
 * A '--- ' or '+++ ' inside a hunk is a removed or added line, not a header.
 */
export function classifyPatch(patch) {
  const lines = String(patch).split('\n');
  // A patch ends with a newline: the last field is empty (a cut patch keeps its last line).
  if (lines.at(-1) === '') lines.pop();
  let inHunk = false;
  return lines.map((text) => {
    if (text.startsWith('diff --git ')) inHunk = false;
    else if (text.startsWith('@@')) inHunk = true;
    if (!inHunk) return { kind: 'file', text };
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    if (text.startsWith('\\')) return { kind: 'note', text };
    return { kind: 'context', text };
  });
}

/** The class of a diff line of `kind`: 'diff-line diff-<kind>'. */
export function lineClass(kind) {
  return `diff-line diff-${kind}`;
}
