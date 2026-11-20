// README.md and docs/*.md link only to files that exist,
// and every #anchor they use (in the same file or in another local .md file) names a heading there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const docs = (): string[] => [
  join(ROOT, 'README.md'),
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(ROOT, 'docs', name)),
];

// Markdown outside fenced code blocks: links and headings inside ``` fences are not links or headings.
function prose(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (fence === null) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
      lines.push('');
      continue;
    }
    lines.push(fence === null ? line.replace(/`[^`]*`/g, '') : '');
  }
  return lines;
}

// GitHub's heading anchor: lowercase, punctuation removed, spaces to hyphens, repeats get -1, -2, …
export function slug(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

function anchors(file: string): Set<string> {
  const raw = readFileSync(file, 'utf8');
  const found = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of raw.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (fence === null) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = slug(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      found.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) found.add(m[1]);
  }
  return found;
}

type Link = { line: number; target: string };

function links(file: string): Link[] {
  const out: Link[] = [];
  prose(readFileSync(file, 'utf8')).forEach((line, i) => {
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ line: i + 1, target: m[1] });
    for (const m of line.matchAll(/\bsrc="([^"]+)"/g)) out.push({ line: i + 1, target: m[1] });
  });
  return out;
}

const external = (target: string) => /^(https?:|mailto:)/i.test(target);

function problems(file: string): string[] {
  const where = relative(ROOT, file);
  const out: string[] = [];
  for (const { line, target } of links(file)) {
    if (external(target)) continue;
    const hash = target.indexOf('#');
    const path = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? null : decodeURIComponent(target.slice(hash + 1));
    const dest = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(dest)) {
      out.push(`${where}:${line}: ${target} → missing file ${relative(ROOT, dest)}`);
      continue;
    }
    if (anchor !== null && anchor !== '' && dest.endsWith('.md') && statSync(dest).isFile() && !anchors(dest).has(anchor)) {
      out.push(`${where}:${line}: ${target} → no heading #${anchor} in ${relative(ROOT, dest)}`);
    }
  }
  return out;
}

test('the slug follows GitHub: lowercase, punctuation dropped, spaces to hyphens', () => {
  assert.equal(slug('Sleeping agents (lazy restore)'), 'sleeping-agents-lazy-restore');
  assert.equal(slug('W5 file editor (built)'), 'w5-file-editor-built');
  assert.equal(slug('6. Rules that stay'), '6-rules-that-stay');
  assert.equal(slug('Opening many agents without filling the memory'), 'opening-many-agents-without-filling-the-memory');
});

test('README.md and docs/*.md: every relative link and image points to an existing file and heading', () => {
  const files = docs();
  assert.ok(files.length > 1, 'README.md and at least one docs/*.md file');
  const found = files.flatMap(problems);
  assert.deepEqual(found, [], `broken links:\n${found.join('\n')}`);
});
