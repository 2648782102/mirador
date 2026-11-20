// Pure rules behind the readable layout of Engram memories: field labels, session summary
// headings, sentence and enumeration splitting, file paths and the glossary of codes (W5,
// S3, …) and recurring terms. No DOM and no imports from core.js: the browser and the
// tests import it. public/markdown.js turns the segments into DOM nodes with textContent.

const FIELDS = {
  what: ['what', 'que'],
  why: ['why', 'por que', 'porque'],
  where: ['where', 'donde'],
  learned: ['learned', 'learnings', 'aprendido', 'aprendizaje', 'aprendizajes'],
};

const HEADINGS = {
  goal: ['goal', 'objetivo'],
  instructions: ['instructions', 'instrucciones'],
  discoveries: ['discoveries', 'descubrimientos', 'hallazgos'],
  accomplished: ['accomplished', 'logrado', 'completado'],
  nextSteps: ['next steps', 'siguientes pasos', 'proximos pasos'],
  relevantFiles: ['relevant files', 'archivos relevantes'],
};

// Recurring terms with a fixed, translated definition (i18n key `memory.term.<id>`).
// Uppercase ones only match in uppercase: "red" is a colour, "RED" a test-first step.
const TERMS = [
  { id: 'odd', name: 'ODD', pattern: 'ODD' },
  { id: 'rdd', name: 'RDD', pattern: 'RDD' },
  { id: 'worktree', name: 'worktree', pattern: '[Ww]orktrees?' },
  { id: 'verifier', name: 'verifier', pattern: '[Vv]erifiers?' },
  { id: 'seamCheck', name: 'seam check', pattern: '[Ss]eam checks?' },
  { id: 'red', name: 'RED', pattern: 'RED' },
  { id: 'green', name: 'GREEN', pattern: 'GREEN' },
  { id: 'slice', name: 'slice', pattern: '[Ss]lices?' },
  { id: 'baseline', name: 'baseline', pattern: '[Bb]aselines?' },
  { id: 'fastForward', name: 'fast-forward', pattern: '[Ff]ast-forward(?:s|ed|ing)?' },
  { id: 'herdr', name: 'herdr', pattern: '[Hh]erdr' },
  { id: 'engram', name: 'Engram', pattern: '[Ee]ngram' },
  { id: 'gentleShell', name: 'gentle-shell', pattern: '[Gg]entle-shell' },
];

// Codes whose letter has a generic meaning (i18n key `memory.code.<letter>`).
const CODE_PREFIXES = new Set(['W', 'S', 'T', 'L']);
const CODE = '[A-Z]{1,2}\\d{1,2}';
const CODE_AT = new RegExp(`^${CODE}(?!\\w)`);
const WORDS = new RegExp(
  `(?<!\\w)(${CODE})(?!\\w)|(?<![\\w/.-])(?:${TERMS.map((term) => `(${term.pattern})`).join('|')})(?![\\w/-]|\\.\\w)`,
  'g',
);

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'aprox', 'p.ej', 'ej', 'no', 'nr', 'fig', 'dr', 'mr', 'mrs', 'ms', 'sr', 'sra']);
// A word after a code that makes it a sentence, not a definition ("S3 and S4", "T3 done").
const NOT_A_DEFINITION = new Set([
  'and', 'or', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'to', 'in', 'on', 'at', 'of', 'for', 'from', 'by', 'with',
  'the', 'a', 'an', 'done', 'pending', 'passed', 'failed', 'merged', 'blocked', 'completed', 'ok',
  'y', 'o', 'es', 'son', 'fue', 'está', 'en', 'de', 'del', 'con', 'por', 'para', 'el', 'la', 'los', 'las', 'un', 'una', 'que', 'se',
  'listo', 'lista', 'hecho', 'hecha', 'pendiente',
]);
// Text before a code that makes the code start an item: the line start, a list marker or a separator.
const ITEM_START = /(?:^\s*(?:(?:[-*]|\d+\.)\s+)?(?:\*\*)?|[:;,(]\s*(?:(?:and|or|y|o)\s+)?)$/;
const DEFINITION_MAX = 90;

const EXTENSIONS = 'md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonc|css|scss|html|svg|png|jpg|yml|yaml|toml|ini|sh|bash|go|py|rs|cs|csproj|sln|java|kt|swift|c|h|cpp|hpp|lua|gd|tscn|sql|xml|lock|log|env|example|conf|cfg';
const EXTENSION = new RegExp(`\\.(?:${EXTENSIONS})$`);

function normalize(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function lookup(table, text) {
  const wanted = normalize(text);
  for (const [key, names] of Object.entries(table)) if (names.includes(wanted)) return key;
  return null;
}

/** The canonical key of a memory field label (What, qué, Por qué, …), or null. */
export const fieldKey = (label) => lookup(FIELDS, label);

/** The canonical key of a session summary heading (Goal, Next Steps, Objetivo, …), or null. */
export const headingKey = (text) => lookup(HEADINGS, text);

/**
 * A field line: `**What**: x`, `**What:** x` or `What: x`. Bold labels are fields even when
 * unknown (key null, label kept as written); plain labels only when known.
 */
export function parseField(line) {
  const bold = line.match(/^\s*\*\*([^*:\n]{1,40}?)\s*(?::\*\*|\*\*\s*:)\s*(.*)$/);
  if (bold) return { key: fieldKey(bold[1]), label: bold[1].trim(), value: bold[2].trim() };
  const plain = line.match(/^\s*(\p{L}[\p{L} ]{0,20}?)\s*:(?:\s+(.*))?$/u);
  if (plain && fieldKey(plain[1])) return { key: fieldKey(plain[1]), label: plain[1], value: (plain[2] ?? '').trim() };
  return null;
}

/** Calls visit(i, char, depth, inCode) for each character: depth counts open brackets, inCode is inside backticks. */
function scan(text, visit) {
  let depth = 0;
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') inCode = !inCode;
    else if (!inCode && (c === '(' || c === '[')) depth++;
    else if (!inCode && (c === ')' || c === ']')) depth = Math.max(0, depth - 1);
    visit(i, c, depth, inCode);
  }
}

/** Whether the period at `i` closes an abbreviation (e.g., i.e., etc.) or an initial. */
function isAbbreviation(text, i) {
  const word = text.slice(0, i).match(/[^\s(]*$/)[0].toLowerCase();
  return ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word);
}

/** A period, ! or ? at `i` that ends a sentence (outside brackets and code). */
function endsSentence(text, i, c, depth, inCode) {
  if (depth || inCode || !'.!?'.includes(c)) return false;
  if (i + 1 < text.length && !/\s/.test(text[i + 1])) return false;
  return c !== '.' || !isAbbreviation(text, i);
}

/** Splits on a period (or ! ?) followed by an uppercase letter; abbreviations, brackets and code stay intact. */
export function splitSentences(text) {
  const sentences = [];
  let start = 0;
  scan(text, (i, c, depth, inCode) => {
    if (endsSentence(text, i, c, depth, inCode) && /^\s+\p{Lu}/u.test(text.slice(i + 1))) {
      sentences.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  });
  const last = text.slice(start).trim();
  if (last) sentences.push(last);
  return sentences;
}

/**
 * An enumeration of 3+ code-prefixed items (`intro: W1 a, W2 b, W3 c. Rest.`) as
 * { intro, items, rest }, or null. Items are separated by `,` or `;` outside brackets and
 * end at the end of the sentence.
 */
export function splitEnumeration(text) {
  const starts = [];
  const ends = [];
  scan(text, (i, c, depth, inCode) => {
    if (depth || inCode) return;
    if (c === '.' && endsSentence(text, i, c, depth, inCode)) ends.push(i);
    if ((i === 0 || !/\w/.test(text[i - 1])) && CODE_AT.test(text.slice(i))) {
      const separator = text.slice(0, i).match(/(?:^|([:;,])\s+(?:(?:and|or|y|o)\s+)?)$/);
      if (separator) starts.push({ at: i, separator: separator[1] ?? '' });
    }
  });
  let run = [];
  for (const start of starts) {
    const previous = run[run.length - 1];
    const continues = previous && start.separator && ',;'.includes(start.separator) && !ends.some((end) => end > previous.at && end < start.at);
    if (continues) run.push(start);
    else if (run.length >= 3) break;
    else run = [start];
  }
  if (run.length < 3) return null;
  const last = run[run.length - 1].at;
  const end = ends.find((at) => at > last) ?? text.length;
  const items = run.map((start, k) =>
    text
      .slice(start.at, k + 1 < run.length ? run[k + 1].at : end)
      .replace(/[,;]\s*(?:(?:and|or|y|o)\s+)?$/, '')
      .trim(),
  );
  return { intro: text.slice(0, run[0].at).trim(), items, rest: text.slice(end + 1).trim() };
}

/** Whether a word (punctuation already stripped) is a file path or a file name. */
export function isPathLike(token) {
  if (!/^[\w@~.+/:-]+$/.test(token) || /^[\d/:.-]+$/.test(token)) return false;
  const bare = token.replace(/(?::\d+)+$/, '');
  if (bare.includes('/')) return EXTENSION.test(bare) || /^(?:~|\.{1,2})?\//.test(bare) || bare.endsWith('/');
  return EXTENSION.test(bare) && /^(?:[a-z0-9_.][\w.-]*|[A-Z0-9_-]+)\.[a-z]+$/.test(bare);
}

/** The definitions a line gives: a code starting an item and followed by a description. */
function lineDefinitions(line) {
  const found = [];
  for (const match of line.matchAll(new RegExp(`(?<!\\w)${CODE}(?!\\w)`, 'g'))) {
    if (!ITEM_START.test(line.slice(0, match.index))) continue;
    const gap = line.slice(match.index + match[0].length).match(/^(?:\s*[:—–]\s+|\s+(?:[—–-]\s+)?)(?=\p{L})/u);
    if (!gap) continue;
    const from = match.index + match[0].length + gap[0].length;
    let to = line.length;
    let depth = 0;
    for (let i = from; i < line.length; i++) {
      const c = line[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') {
        if (depth === 0) { to = i; break; }
        depth--;
      } else if (depth === 0 && (',;:'.includes(c) || endsSentence(line, i, c, 0, false) || (!/\w/.test(line[i - 1]) && CODE_AT.test(line.slice(i))))) {
        to = i;
        break;
      }
    }
    let text = line.slice(from, to).replace(/[*`]/g, '').replace(/\s+(?:and|or|y|o|with|con)$/i, '').trim();
    // "W5 etc." or "T2 vs. T3": an abbreviation after a code is prose, not a definition.
    const firstWord = text.split(/\s/)[0].toLowerCase().replace(/\.+$/, '');
    if (!/^\p{L}/u.test(text) || NOT_A_DEFINITION.has(firstWord) || ABBREVIATIONS.has(firstWord)) continue;
    if (text.length > DEFINITION_MAX) {
      const cut = text.slice(0, DEFINITION_MAX);
      const space = cut.lastIndexOf(' ');
      text = `${(space > DEFINITION_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
    }
    found.push([match[0], text]);
  }
  return found;
}

function withoutFences(text) {
  let inFence = false;
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      if (line.trimStart().startsWith('```')) inFence = !inFence;
      else return !inFence;
      return false;
    })
    .join('\n');
}

const byCode = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * One glossary for the memories shown together: { definitions: Map(code → text) taken from
 * the memories (the first definition wins), codes: the explainable codes found, sorted,
 * terms: the term ids found, in a fixed order }.
 */
export function buildGlossary(texts) {
  const bodies = texts.map(withoutFences);
  const definitions = new Map();
  for (const body of bodies) {
    for (const line of body.split('\n')) {
      for (const [code, text] of lineDefinitions(line)) if (!definitions.has(code)) definitions.set(code, text);
    }
  }
  const glossary = { definitions, codes: [], terms: [] };
  const codes = new Set();
  const terms = new Set();
  const collect = (segments) => {
    for (const segment of segments) {
      if (segment.type === 'strong') collect(segment.children);
      else if (segment.type === 'abbr' && segment.kind === 'code') codes.add(segment.text);
      else if (segment.type === 'abbr') terms.add(segment.key.slice('term.'.length));
    }
  };
  for (const body of bodies) collect(tokenize(body, glossary));
  glossary.codes = [...codes].sort(byCode);
  glossary.terms = TERMS.map((term) => term.id).filter((id) => terms.has(id));
  return glossary;
}

/** The glossary as rows: { text, definition } for defined codes, { text, key } otherwise. */
export function glossaryEntries(glossary) {
  return [
    ...glossary.codes.map((code) => (glossary.definitions.has(code) ? { text: code, definition: glossary.definitions.get(code) } : { text: code, key: `code.${code[0]}` })),
    ...glossary.terms.map((id) => ({ text: TERMS.find((term) => term.id === id).name, key: `term.${id}` })),
  ];
}

const EMPTY_GLOSSARY = { definitions: new Map(), codes: [], terms: [] };

function pushText(out, text) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

function codeSegment(code, glossary) {
  if (glossary.definitions.has(code)) return { type: 'abbr', kind: 'code', text: code, definition: glossary.definitions.get(code) };
  if (code.length > 1 && CODE_PREFIXES.has(code[0]) && /\d/.test(code[1])) return { type: 'abbr', kind: 'code', text: code, key: `code.${code[0]}` };
  return null;
}

/** Plain text (no bold or backticks) into text, path-as-code and abbr segments. */
function plainSegments(text, glossary, seen, out) {
  const spans = [];
  for (const word of text.matchAll(/\S+/g)) {
    const core = word[0].match(/^[("'[]*(.*?)[)"'\],;:.!?]*$/);
    if (core[1] && isPathLike(core[1])) {
      const at = word.index + word[0].indexOf(core[1]);
      spans.push({ at, end: at + core[1].length, segment: { type: 'code', text: core[1] } });
    }
  }
  for (const match of text.matchAll(WORDS)) {
    const at = match.index;
    const end = at + match[0].length;
    if (spans.some((span) => at < span.end && end > span.at)) continue;
    if (match[1]) {
      const segment = codeSegment(match[1], glossary);
      if (segment) spans.push({ at, end, segment });
      continue;
    }
    const term = TERMS[match.slice(2).findIndex(Boolean)];
    if (seen.has(term.id)) continue;
    seen.add(term.id);
    spans.push({ at, end, segment: { type: 'abbr', kind: 'term', text: match[0], key: `term.${term.id}` } });
  }
  spans.sort((a, b) => a.at - b.at);
  let last = 0;
  for (const span of spans) {
    pushText(out, text.slice(last, span.at));
    out.push(span.segment);
    last = span.end;
  }
  pushText(out, text.slice(last));
}

/**
 * Text into segments: { type: 'text', text }, { type: 'code', text } (backticks and paths),
 * { type: 'strong', children } and { type: 'abbr', kind: 'code' | 'term', text, definition | key }.
 * Codes are marked on every occurrence, terms once per `seen` set (one per memory).
 */
export function tokenize(text, glossary = EMPTY_GLOSSARY, seen = new Set()) {
  const out = [];
  let last = 0;
  for (const match of String(text ?? '').matchAll(/\*\*[^*]+\*\*|`[^`]+`/g)) {
    plainSegments(text.slice(last, match.index), glossary, seen, out);
    const token = match[0];
    if (token.startsWith('`')) out.push({ type: 'code', text: token.slice(1, -1) });
    else out.push({ type: 'strong', children: tokenize(token.slice(2, -2), glossary, seen) });
    last = match.index + token.length;
  }
  plainSegments(String(text ?? '').slice(last), glossary, seen, out);
  return out;
}

// Common short words of each language, for memoryLanguage. Words both share (no, a) are left out.
const LANGUAGE_WORDS = {
  es: new Set('de la que el en los las del se por con para una un es al lo como más pero sus ya está son sin sobre también cuando y o le hay esta este ese esa'.split(' ')),
  en: new Set('the of and to in is that for with on as it are be this from by not was an or at when has its into will which'.split(' ')),
};

function languageScore(text) {
  const words = String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = { es: (String(text ?? '').match(/[áéíóúñ¿¡]/giu) ?? []).length, en: 0 };
  for (const word of words) {
    if (LANGUAGE_WORDS.es.has(word)) score.es += 1;
    if (LANGUAGE_WORDS.en.has(word)) score.en += 1;
  }
  return score;
}

/**
 * The language a memory is written in, 'es' or 'en', so the browser's translator reads it as what it
 * is: 'es' when its Spanish words (and accents) outnumber its English ones, else 'en', as Engram
 * memories mostly are. `ignored` texts (field labels, notes in the UI's language, code) do not count.
 */
export function memoryLanguage(text, ignored = []) {
  const score = languageScore(text);
  for (const part of ignored) {
    const less = languageScore(part);
    score.es -= less.es;
    score.en -= less.en;
  }
  return score.es > score.en ? 'es' : 'en';
}
