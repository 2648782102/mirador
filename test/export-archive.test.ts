// Public release T1 (S2): `git archive HEAD`, the public export, leaves out odd/tasks/, design/ and
// docs/informe-2026-11-11.md, which this repository keeps. It carries
// odd/README.md, the method, and not the .gitattributes that marks the exclusions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractHead, notTheSource, trackedUnder } from './helpers/export-archive.ts';

const skip = notTheSource();
let exported: string | undefined;
after(() => {
  if (exported) rmSync(exported, { recursive: true, force: true });
});
const exportDir = () => (exported ??= extractHead());

test('the export leaves out odd/tasks/, design/ and the informe; this repository keeps them', { skip }, () => {
  const dir = exportDir();
  assert.equal(existsSync(join(dir, 'odd', 'tasks')), false, 'odd/tasks/ is not exported, not even empty');
  assert.equal(existsSync(join(dir, 'design')), false, 'design/ is not exported, not even empty');
  assert.equal(existsSync(join(dir, 'docs', 'informe-2026-11-11.md')), false, 'the informe is not exported');
  assert.ok(existsSync(join(dir, 'docs', 'attention.md')), 'the rest of docs/ is exported');

  assert.ok(trackedUnder('odd/tasks').filter((path) => path.endsWith('.md')).length > 0, 'HEAD still tracks the task files');
  assert.ok(trackedUnder('design').length > 0, 'HEAD still tracks design/');
  assert.deepEqual(trackedUnder('docs/informe-2026-11-11.md'), ['docs/informe-2026-11-11.md'], 'HEAD still tracks the informe');
});

test('.gitignore ignores /odd/tasks and /design, without a trailing slash, for the private nested clones', () => {
  const lines = readFileSync(join(import.meta.dirname, '..', '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('/odd/tasks'), '.gitignore has the line /odd/tasks');
  assert.ok(lines.includes('/design'), '.gitignore has the line /design');
});

test('the export carries odd/README.md, the method, and not the .gitattributes with the exclusions', { skip }, () => {
  const dir = exportDir();
  assert.ok(existsSync(join(dir, 'odd', 'README.md')), 'odd/README.md is exported');
  assert.equal(existsSync(join(dir, '.gitattributes')), false, '.gitattributes excludes itself');
  assert.deepEqual(trackedUnder('.gitattributes'), ['.gitattributes'], 'HEAD tracks the .gitattributes the export leaves out');
});
