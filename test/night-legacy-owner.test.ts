import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_USER_VALUES } from '../src/night/legacy-owner.ts';
import { ScheduleStore } from '../src/night/schedule.ts';
import { NightLog } from '../src/night/log.ts';

/** A legacy value with its first letter in upper case: a near miss that must not be read as the user. */
const capitalized = (value: string) => value[0].toUpperCase() + value.slice(1);

test('legacy values are the exact pre-F5/N1 strings, read only on an exact match (S3 risk item 1)', async (t) => {
  // The exact stored bytes, assembled from letters like the constant, so this file never spells the name.
  const owner = ['m', 'a', 't', 'i', 'a', 's'].join('');
  assert.deepEqual(LEGACY_USER_VALUES, { cause: owner, decidedBy: `${owner}-telegram` });
  const { cause, decidedBy } = LEGACY_USER_VALUES;
  const dir = await mkdtemp(join(tmpdir(), 'legacy-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const OFF = { active: false, source: null, until: null };
  const ON = { active: true, source: 'manual', until: null };
  const acts = [cause, capitalized(cause), `${cause} `, decidedBy, 'user'].map((value, i) => ({
    time: `2026-11-01T0${i}:00:00.000Z`,
    from: OFF,
    to: ON,
    cause: value,
  }));
  const bytes = acts.map((a) => JSON.stringify(a)).join('\n') + '\n';
  await writeFile(join(dir, 'activations.jsonl'), bytes);
  assert.deepEqual(
    (await new ScheduleStore(dir).activations()).map((c) => c.cause),
    ['user', decidedBy, `${cause} `, capitalized(cause), 'user'],
  );
  assert.equal(await readFile(join(dir, 'activations.jsonl'), 'utf8'), bytes, 'never rewritten');
  const rec = (id: string, by?: string) => ({
    id,
    time: `2026-10-28T23:0${id.length}:00.000Z`,
    terminalId: 't',
    workspaceId: 'w',
    kind: 'question',
    outcome: 'decided',
    deferral: null,
    sent: 'decided',
    followUp: null,
    delivered: null,
    error: null,
    ...(by ? { decidedBy: by } : {}),
  });
  await writeFile(
    join(dir, 'decisions.jsonl'),
    [rec('a', decidedBy), rec('ab', capitalized(decidedBy)), rec('abc', cause), rec('abcd')].map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  assert.deepEqual(
    (await new NightLog(dir).recent()).map((r) => r.decidedBy ?? null),
    ['user-telegram', capitalized(decidedBy), cause, null],
  );
});
