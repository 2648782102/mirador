import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryIndex, memoryLookup } from '../src/memory/folder-memory.ts';
import { EngramUnavailableError } from '../src/memory/engram.ts';

const projects = [
  { name: 'vigia', observation_count: 40, directories: ['/home/m/Dev/web/vigia', '/home/m/Dev/vigia'] },
  { name: 'dev', observation_count: 29, directories: ['/home/m/Dev'] },
  { name: 'mirador', observation_count: 3, directories: null },
  { name: 'Acmematch', observation_count: 5, directories: [] },
  { name: 'empty', observation_count: 0, directories: ['/home/m/Dev/games'] },
];

test('a folder has memory when an Engram project was used in it or below it, not above it', () => {
  const hasMemory = memoryLookup(projects);
  assert.equal(hasMemory('/home/m/Dev/web/vigia'), true);
  assert.equal(hasMemory('/home/m/Dev/web'), true, 'a container holding a project');
  assert.equal(hasMemory('/home/m/Dev/web/vigia/src'), false, 'a project above does not count');
  assert.equal(hasMemory('/home/m/Dev/webx'), false, 'a shared prefix is not a parent');
  assert.equal(hasMemory('/home/m/Dev/blender'), false);
});

test('a folder whose name is a project name has memory (Engram names projects after folders)', () => {
  const hasMemory = memoryLookup(projects);
  assert.equal(hasMemory('/home/m/Dev/tools/mirador'), true);
  assert.equal(hasMemory('/home/m/Dev/mobile/acmematch'), true, 'case-insensitive');
});

test('projects without observations do not count as memory', () => {
  assert.equal(memoryLookup(projects)('/home/m/Dev/games'), false);
});

test('MemoryIndex asks Engram once per interval and answers null while Engram is down', async () => {
  let calls = 0;
  let down = false;
  let now = 0;
  const index = new MemoryIndex(async () => {
    calls++;
    if (down) throw new EngramUnavailableError(new Error('refused'));
    return projects;
  }, 30_000, () => now);

  assert.equal((await index.lookup())?.('/home/m/Dev/web/vigia'), true);
  assert.equal((await index.lookup())?.('/home/m/Dev/web/vigia'), true);
  assert.equal(calls, 1);

  now = 31_000;
  down = true;
  assert.equal(await index.lookup(), null);
  down = false;
  assert.equal(await index.lookup(), null, 'a failure is remembered for a few seconds');
  assert.equal(calls, 2);
  now = 36_000;
  assert.equal((await index.lookup())?.('/home/m/Dev/blender'), false, 'then Engram is asked again');
  assert.equal(calls, 3);
});

test('MemoryIndex answers null on any failure, not only Engram being down', async () => {
  const index = new MemoryIndex(async () => {
    throw new TypeError('unexpected body');
  });
  assert.equal(await index.lookup(), null);
});

test('lookups that arrive while Engram is being asked share that one request', async () => {
  let calls = 0;
  let answer: (list: typeof projects) => void = () => {};
  const index = new MemoryIndex(() => {
    calls++;
    return new Promise((resolve) => { answer = resolve; });
  });
  const pending = [index.lookup(), index.lookup()];
  answer(projects);
  const [first, second] = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(first?.('/home/m/Dev/web/vigia'), true);
  assert.equal(second?.('/home/m/Dev/web/vigia'), true);
});

test('a missing project list, or entries without directories, mean no memory instead of an error', () => {
  assert.equal(memoryLookup(null as never)('/home/m/Dev/web'), false);
  assert.equal(memoryLookup([{ name: 'shop', directories: null }])('/home/m/Dev/web'), false);
});
