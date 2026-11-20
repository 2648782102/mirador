// The night decision log: append-only JSONL under the state folder, private to this user,
// bounded by rotation, and readable by time for the morning report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightLog, nightLogDir, type NightRecord } from '../src/night/log.ts';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';

let scratch: string;
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-night-log-')));
});
after(() => rm(scratch, { recursive: true, force: true }));

function record(id: string, time: string, extra: Partial<NightRecord> = {}): NightRecord {
  return {
    id, time, kind: 'question', terminalId: 't1', workspaceId: 'dev', rel: 'alpha', tool: 'ask_user_choice',
    question: null, policy: { allowed: true }, decision: null, followUp: null, sent: 'pass', delivered: null,
    outcome: 'deferred', deferral: null, error: null, ...extra,
  };
}

test('the log lives in <state>/night, folder 0700 and file 0600, one JSON record per line', async () => {
  assert.equal(nightLogDir({ XDG_STATE_HOME: '/s' }), '/s/mirador/night');
  const dir = join(scratch, 'perm', 'night');
  const log = new NightLog(dir);
  await log.append(record('r1', '2026-10-28T23:00:00.000Z'));
  await log.append(record('r2', '2026-10-28T23:05:00.000Z', { outcome: 'decided', sent: 'decided' }));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'decisions.jsonl'))).mode & 0o777, 0o600);
  const lines = (await readFile(join(dir, 'decisions.jsonl'), 'utf8')).split('\n');
  assert.equal(lines.pop(), '');
  assert.deepEqual(lines.map((line) => JSON.parse(line).id), ['r1', 'r2']);
});

test('a held question and the answer that ended it keep sent held, heldId and decidedBy, from memory and from disk', async () => {
  const dir = join(scratch, 'held');
  const log = new NightLog(dir);
  await log.append(record('h1', '2026-10-28T23:00:00.000Z', { sent: 'held', heldId: 'AbCdEfGhIjKlMnOp' }));
  await log.append(record('h2', '2026-10-28T23:01:00.000Z', { outcome: 'decided', sent: 'decided', heldId: 'AbCdEfGhIjKlMnOp', decidedBy: 'user-telegram' }));
  const pick = (records: NightRecord[]) => records.map((r) => [r.id, r.sent, r.heldId, r.decidedBy]);
  const expected = [['h1', 'held', 'AbCdEfGhIjKlMnOp', undefined], ['h2', 'decided', 'AbCdEfGhIjKlMnOp', 'user-telegram']];
  assert.deepEqual(pick(await log.recent()), expected);
  const lines = (await readFile(join(dir, 'decisions.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as NightRecord);
  assert.deepEqual(pick(lines), expected);
});

test('an old line whose decidedBy is the legacy owner value still loads, read as user-telegram, from the index and from the files; the file keeps its bytes (N1)', async () => {
  const dir = join(scratch, 'legacy-decided-by');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const old = record('o1', '2026-10-28T23:01:00.000Z', { outcome: 'decided', sent: 'decided', heldId: 'AbCdEfGhIjKlMnOp' });
  // The raw line says LEGACY_USER_VALUES.decidedBy, a value the type no longer allows.
  const bytes = [
    JSON.stringify(record('o0', '2026-10-28T23:00:00.000Z', { sent: 'held', heldId: 'AbCdEfGhIjKlMnOp' })),
    JSON.stringify({ ...old, decidedBy: LEGACY_USER_VALUES.decidedBy }),
    JSON.stringify(record('o2', '2026-10-28T23:02:00.000Z', { outcome: 'decided', sent: 'decided', decidedBy: 'user-telegram' })),
    '',
  ].join('\n');
  await writeFile(join(dir, 'decisions.jsonl'), bytes, { mode: 0o600 });
  const pick = (records: NightRecord[]) => records.map((r) => [r.id, r.decidedBy ?? null]);
  const expected = [['o0', null], ['o1', 'user-telegram'], ['o2', 'user-telegram']];
  assert.deepEqual(pick(await new NightLog(dir).recent()), expected, 'from the in-memory index');
  assert.deepEqual(await new NightLog(dir).recent(), [record('o0', '2026-10-28T23:00:00.000Z', { sent: 'held', heldId: 'AbCdEfGhIjKlMnOp' }), { ...old, decidedBy: 'user-telegram' }, record('o2', '2026-10-28T23:02:00.000Z', { outcome: 'decided', sent: 'decided', decidedBy: 'user-telegram' })], 'every other field as written');
  const filesOnly = join(scratch, 'legacy-decided-by-files');
  await mkdir(filesOnly, { recursive: true, mode: 0o700 });
  await writeFile(join(filesOnly, 'decisions.jsonl'), bytes, { mode: 0o600 });
  assert.deepEqual(pick(await new NightLog(filesOnly, { indexBytes: 0 }).recent()), expected, 'from the files, past an empty index');
  assert.equal(await readFile(join(dir, 'decisions.jsonl'), 'utf8'), bytes, 'reading never rewrites the file');
  assert.equal(await readFile(join(filesOnly, 'decisions.jsonl'), 'utf8'), bytes);
  await new NightLog(dir).append(record('o3', '2026-10-28T23:03:00.000Z'));
  assert.ok((await readFile(join(dir, 'decisions.jsonl'), 'utf8')).startsWith(bytes), 'an append keeps the old lines byte for byte');
});

test('recent({ since }) returns the records from that time on, oldest first', async () => {
  const log = new NightLog(join(scratch, 'recent'));
  for (const [id, time] of [['a', '2026-10-28T22:00:00.000Z'], ['b', '2026-10-28T23:00:00.000Z'], ['c', '2026-10-29T01:00:00.000Z']]) await log.append(record(id, time));
  assert.deepEqual((await log.recent({ since: Date.parse('2026-10-28T23:00:00.000Z') })).map((r) => r.id), ['b', 'c']);
  assert.deepEqual((await log.recent()).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual((await log.recent({ limit: 1 })).map((r) => r.id), ['c'], 'the newest within the limit');
  assert.deepEqual(await new NightLog(join(scratch, 'missing')).recent(), [], 'no log yet');
});

test('the log rotates past its size limit, keeps one previous file, and still reads both', async () => {
  const dir = join(scratch, 'rotate');
  const log = new NightLog(dir, { maxBytes: 600 });
  for (let i = 0; i < 6; i++) await log.append(record(`r${i}`, `2026-10-28T23:0${i}:00.000Z`));
  const current = await stat(join(dir, 'decisions.jsonl'));
  const previous = await stat(join(dir, 'decisions.1.jsonl'));
  assert.ok(current.size <= 600, `current ${current.size}`);
  assert.ok(previous.size <= 600, `previous ${previous.size}`);
  assert.equal(previous.mode & 0o777, 0o600);
  const ids = (await log.recent()).map((r) => r.id);
  assert.equal(ids.at(-1), 'r5');
  assert.ok(ids.length >= 2 && ids.length < 6, `older records were dropped: ${ids.join(',')}`);
});

test('concurrent appends never interleave, and a damaged line is skipped on read', async () => {
  const dir = join(scratch, 'concurrent');
  const log = new NightLog(dir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(record(`c${i}`, `2026-10-28T23:00:${String(i).padStart(2, '0')}.000Z`, { error: 'x'.repeat(2000) }))));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(dir, 'decisions.jsonl'), '{"broken\n');
  const records = await log.recent();
  assert.equal(records.length, 20);
  assert.deepEqual(new Set(records.map((r) => r.id)).size, 20);
});

test('subscribe(listener) sees each record once it is written, for every log of the same folder, until unsubscribed', async () => {
  const dir = join(scratch, 'subscribe');
  const writer = new NightLog(dir);
  // The night routes and the morning report each build their own NightLog over one folder.
  const reader = new NightLog(dir);
  const seen: Array<{ id: string; onDisk: boolean }> = [];
  const unsubscribe = reader.subscribe((value) => {
    seen.push({ id: value.id, onDisk: false });
    void readFile(join(dir, 'decisions.jsonl'), 'utf8').then((text) => {
      seen.find((entry) => entry.id === value.id)!.onDisk = text.includes(`"id":"${value.id}"`);
    });
  });
  const thrower = writer.subscribe(() => {
    throw new Error('listener failure');
  });
  const original = console.error;
  const reported: unknown[] = [];
  console.error = (...args: unknown[]) => void reported.push(args);
  try {
    await writer.append(record('s1', '2026-10-28T23:00:00.000Z'));
    await reader.append(record('s2', '2026-10-28T23:01:00.000Z'));
  } finally {
    console.error = original;
  }
  assert.equal(reported.length, 2, 'the throwing listener is reported once per record');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, [{ id: 's1', onDisk: true }, { id: 's2', onDisk: true }], 'a throwing listener never stops the others or the append');
  unsubscribe();
  thrower();
  await writer.append(record('s3', '2026-10-28T23:02:00.000Z'));
  assert.equal(seen.length, 2, 'no events after unsubscribe');
  assert.deepEqual((await reader.recent()).map((r) => r.id), ['s1', 's2', 's3'], 'the file format is unchanged');
});

test('a record that could not be written is not announced', async () => {
  const blocked = join(scratch, 'blocked-file');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(blocked, 'not a folder');
  const log = new NightLog(join(blocked, 'night'));
  const seen: string[] = [];
  log.subscribe((value) => seen.push(value.id));
  const original = console.error;
  console.error = () => undefined;
  try {
    await log.append(record('x1', '2026-10-28T23:00:00.000Z'));
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, []);
});

/** What recent() returned before the in-memory index: both files parsed, oldest first. */
async function fromFiles(dir: string, since = -Infinity): Promise<string[]> {
  const ids: string[] = [];
  for (const name of ['decisions.1.jsonl', 'decisions.jsonl']) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      try {
        const value = JSON.parse(line);
        if (Date.parse(value.time) >= since) ids.push(value.id);
      } catch {
        // skipped like recent() does
      }
    }
  }
  return ids;
}

/** Runs `fn` while both log files cannot be read, so only the in-memory index can answer. */
async function unreadable<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const { chmod } = await import('node:fs/promises');
  const names = ['decisions.jsonl', 'decisions.1.jsonl'];
  for (const name of names) await chmod(join(dir, name), 0o000).catch(() => undefined);
  try {
    return await fn();
  } finally {
    for (const name of names) await chmod(join(dir, name), 0o600).catch(() => undefined);
  }
}

test('recent() is served from memory after appends: no file is read while nothing changed on disk', async () => {
  const dir = join(scratch, 'index-memory');
  const log = new NightLog(dir);
  for (let i = 0; i < 5; i++) await log.append(record(`m${i}`, `2026-10-28T23:0${i}:00.000Z`));
  assert.deepEqual((await log.recent()).map((r) => r.id), ['m0', 'm1', 'm2', 'm3', 'm4']);
  await log.append(record('m5', '2026-10-28T23:05:00.000Z'));
  const served = await unreadable(dir, () => new NightLog(dir).recent({ since: '2026-10-28T23:03:00.000Z' }));
  assert.deepEqual(served.map((r) => r.id), ['m3', 'm4', 'm5'], 'the newest record arrives through the append, not a re-read');
  assert.deepEqual(served.at(-1), JSON.parse(JSON.stringify(record('m5', '2026-10-28T23:05:00.000Z'))), 'records read like their JSON line');
});

test('the index follows rotation: records of the dropped file leave it, and it matches the files', async () => {
  const dir = join(scratch, 'index-rotate');
  const log = new NightLog(dir, { maxBytes: 900 });
  assert.deepEqual(await log.recent(), [], 'seeded empty');
  for (let i = 0; i < 12; i++) {
    await log.append(record(`q${i}`, `2026-10-28T23:${String(i).padStart(2, '0')}:00.000Z`));
    assert.deepEqual((await log.recent()).map((r) => r.id), await fromFiles(dir), `after append ${i}`);
  }
  assert.ok(!(await fromFiles(dir)).includes('q0'), 'the oldest records were rotated away');
  const since = Date.parse('2026-10-28T23:10:00.000Z');
  assert.deepEqual((await log.recent({ since })).map((r) => r.id), await fromFiles(dir, since));
});

test('after a restart the index is seeded once from both files, damaged lines skipped', async () => {
  const dir = join(scratch, 'index-restart');
  const log = new NightLog(dir, { maxBytes: 900 });
  for (let i = 0; i < 6; i++) await log.append(record(`z${i}`, `2026-10-28T22:0${i}:00.000Z`));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(dir, 'decisions.jsonl'), '{"broken\n');
  // A fresh copy of the module has no shared folder state, like a new server process.
  const fresh = (await import('../src/night/log.ts?restart')) as typeof import('../src/night/log.ts');
  const restarted = new fresh.NightLog(dir, { maxBytes: 900 });
  const expected = await fromFiles(dir);
  assert.deepEqual((await restarted.recent()).map((r) => r.id), expected);
  await restarted.append(record('z6', '2026-10-28T22:06:00.000Z'));
  assert.deepEqual((await unreadable(dir, () => restarted.recent())).map((r) => r.id).at(-1), 'z6', 'then fed by appends');
});

test('a log changed on disk by someone else is read again', async () => {
  const dir = join(scratch, 'index-external');
  const log = new NightLog(dir);
  await log.append(record('e1', '2026-10-28T23:00:00.000Z'));
  assert.deepEqual((await log.recent()).map((r) => r.id), ['e1']);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'decisions.jsonl'), `${JSON.stringify(record('x1', '2026-10-28T23:01:00.000Z'))}\n${JSON.stringify(record('x2', '2026-10-28T23:02:00.000Z'))}\n`);
  assert.deepEqual((await log.recent()).map((r) => r.id), ['x1', 'x2']);
});

test('the index is bounded: older records come from the files, newer ones from memory', async () => {
  const dir = join(scratch, 'index-bounded');
  const log = new NightLog(dir, { indexBytes: 2000 });
  for (let i = 0; i < 10; i++) await log.append(record(`b${i}`, `2026-10-28T23:0${i}:00.000Z`));
  const all = await log.recent();
  assert.deepEqual(all.map((r) => r.id), await fromFiles(dir), 'a window older than the index reads the files');
  const since = '2026-10-28T23:08:00.000Z';
  assert.deepEqual((await unreadable(dir, () => log.recent({ since }))).map((r) => r.id), ['b8', 'b9'], 'a recent window is served from memory');
  assert.deepEqual((await unreadable(dir, () => log.recent({ limit: 2 }))).map((r) => r.id), ['b8', 'b9'], 'so are the newest few');
});
