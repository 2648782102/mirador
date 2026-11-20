// Pure rules for memories without a title and for the memory health card
// (public/features/tracking.js). The server's health report
// (src/memory/memory-health.ts) uses the same fallbackTitle, so both sides agree.

export const FALLBACK_TITLE_CHARS = 80;

// Engram memories often start with `**What**: …` (or its Spanish form): the label is not the title.
const LABELS = '(?:what|why|where|learned|qu[eé]|por qu[eé]|d[oó]nde|aprendido)';
// `**What**`, `**What:**`, `**What**:` or a plain `What:` (never the start of "Whatever").
const FIELD_LABEL = new RegExp(`^(?:(?:\\*\\*|__)\\s*${LABELS}\\s*:?\\s*(?:\\*\\*|__)|${LABELS}\\s*:)\\s*:?\\s*`, 'i');
// Any other short bold label ending in a colon: `**Root cause**: …`, `**Fix:** …`.
const BOLD_LABEL = /^(?:\*\*|__)[^*_\n]{1,40}?(?::(?:\*\*|__)|(?:\*\*|__)\s*:)\s*/;
const HEADING = /^#{1,6}\s+/;
const MARKERS = /^(?:>\s*)+|^(?:[-*+]|\d+[.)])\s+/;
const RULE = /^(?:[-*_]\s*){3,}$/;

/** A line without Markdown: list and quote markers, labels, emphasis and code ticks removed. */
function plain(line) {
  let text = line.trim();
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(MARKERS, '').trim();
  }
  if (RULE.test(text)) return '';
  if (FIELD_LABEL.test(text)) text = text.replace(FIELD_LABEL, '');
  else text = text.replace(BOLD_LABEL, '');
  // Underscores stay: they are part of names like snake_case far more often than emphasis.
  text = text.replace(/(\*\*|\*|`)(?=\S)([^\n]*?\S)\1/g, '$2').replace(/`/g, '');
  return /[\p{L}\p{N}]/u.test(text) ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The title an untitled memory shows: the first meaningful line of its content, without
 * Markdown labels (`**What**:`), markers or emphasis, at most FALLBACK_TITLE_CHARS long.
 * Headings are structure (`## Goal`), so the first line below one wins; a heading is
 * used only when nothing else has text. Null when the content has no text at all.
 */
export function fallbackTitle(content, max = FALLBACK_TITLE_CHARS) {
  let heading = null;
  for (const line of String(content ?? '').split('\n')) {
    const isHeading = HEADING.test(line.trim());
    const text = plain(isHeading ? line.trim().replace(HEADING, '') : line);
    if (!text) continue;
    if (!isHeading) return cap(text, max);
    heading ??= text;
  }
  return heading === null ? null : cap(heading, max);
}

const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** What a memory row shows: its title, or the fallback (`fallback: true`, shown muted). */
export function displayTitle(title, content) {
  if (typeof title === 'string' && title.trim()) return { text: title, fallback: false };
  return { text: fallbackTitle(content), fallback: true };
}

/**
 * The findings of a GET /api/memory/health answer, in the order the card shows them:
 * the ones that hide memories from Mirador first. `items` are the listed entries
 * (passive captures and missing topic keys are counts only, per project in `projects`).
 */
export function healthSections(health) {
  if (!health || typeof health !== 'object' || !health.totals) return [];
  const { totals } = health;
  const list = (value) => (Array.isArray(value) ? value : []);
  return [
    { id: 'suspicious', count: totals.suspicious, items: list(health.suspiciousProjects) },
    { id: 'unmatched', count: totals.unmatched, items: list(health.unmatchedProjects) },
    { id: 'untitled', count: totals.untitled, items: list(health.untitled) },
    { id: 'duplicates', count: totals.duplicateGroups, items: list(health.duplicates) },
    { id: 'topicKey', count: totals.withoutTopicKey, items: [] },
    { id: 'passive', count: totals.passive, items: [] },
  ];
}
