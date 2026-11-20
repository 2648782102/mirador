// Public release (L33): the task documents stay private, so the export names none of them. Lists the
// file names under the task folder in a checkout's committed HEAD (`git ls-tree`) and looks for each one
// in the text files of an extracted export (`git archive HEAD | tar -x`), with or without a path.
//   node scripts/export-task-names.ts <extracted-dir> <checkout>
// Prints each hit as `file:line: name` and exits 1 when there is any, 0 when there is none (2 on bad
// usage or when git fails). A checkout whose HEAD has no task folder (the public repository) lists no
// name, says so and exits 0.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './export-scan.ts';

/** The private task folder, joined from pieces so this exported file does not name it. */
const TASK_FOLDER = ['odd', 'tasks'].join('/');

export interface TaskNameHit {
  file: string;
  line: number;
  name: string;
}

/** The file names under the task folder in `checkout`'s committed HEAD, at any depth, sorted; [] without the folder. */
export function listTaskNames(checkout: string): string[] {
  const listed = spawnSync('git', ['-C', checkout, 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', `${TASK_FOLDER}/`], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) {
    throw new Error(`git ls-tree failed in ${checkout}: ${(listed.stderr || String(listed.error ?? '')).trim()}`);
  }
  return [...new Set(listed.stdout.split('\0').filter(Boolean).map((path) => basename(path)))].sort();
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One whole file name of `names`, extension included: not after a word character, `.` or `-` (a `/`
 * may come before it, so any path to it counts), and not followed by a word character, `-` or a `.`
 * that starts another extension. Longer names first, so a name never stops at a shorter one it starts with.
 */
function namePattern(names: readonly string[]): RegExp | null {
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(String.raw`(?<![\w.-])(?:${sorted.join('|')})(?![\w-]|\.\w)`, 'g');
}

/** Every place `content` (the text of `file`, relative to the export root) names one of `names`. */
export function taskNameHits(file: string, content: string, names: readonly string[]): TaskNameHit[] {
  const pattern = namePattern(names);
  if (!pattern) return [];
  const hits: TaskNameHit[] = [];
  content.split('\n').forEach((text, index) => {
    for (const m of text.matchAll(pattern)) hits.push({ file, line: index + 1, name: m[0] });
  });
  return hits;
}

/** The hits in every text file of the export extracted in `dir`; a file with a NUL byte is binary and skipped. */
export function scanTaskNames(dir: string, names: readonly string[]): { files: number; hits: TaskNameHit[] } {
  let files = 0;
  const hits: TaskNameHit[] = [];
  for (const path of walk(dir)) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    files += 1;
    hits.push(...taskNameHits(relative(dir, path).split('\\').join('/'), bytes.toString('utf8'), names));
  }
  return { files, hits };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((arg) => arg.startsWith('--'))) {
    process.stderr.write('usage: node scripts/export-task-names.ts <extracted-dir> <checkout>\n');
    process.exit(2);
  }
  const [dir, repo] = args;
  let names: string[];
  try {
    names = listTaskNames(repo);
  } catch (error) {
    process.stderr.write(`task names: ${(error as Error).message}\n`);
    process.exit(2);
  }
  if (names.length === 0) {
    process.stderr.write(`task names: none listed; HEAD has no ${TASK_FOLDER}/, so there is nothing to look for\n`);
    process.exit(0);
  }
  const { files, hits } = scanTaskNames(dir, names);
  for (const hit of hits) process.stdout.write(`${hit.file}:${hit.line}: ${hit.name}\n`);
  process.stderr.write(`task names: ${names.length} listed from ${TASK_FOLDER}/ at HEAD, ${files} text files, ${hits.length} hits\n`);
  process.exit(hits.length > 0 ? 1 : 0);
}
