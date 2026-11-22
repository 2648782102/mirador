// Probes of the local "where it left off" store's edges (src/memory/left-off.ts): the record path never
// leaves the store folder, refused lines write nothing, the sweep removes only what expired and drops
// empty folders, the attention report keeps its 4096-byte cap while only the socket's grows, a tie
// between Engram and the record goes to Engram, SessionEnd only marks its own session's record, and
// Forget removes one record (or one workspace's) and nothing else. The end-to-end path is
// test/left-off-local.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { listenForReports } from '../src/attention/socket.ts';
import { AttentionStore, MAX_LINE_BYTES } from '../src/attention/store.ts';
import { LEFT_OFF_MAX_LINE_BYTES, LeftOffStore, deleteLeftOff, deleteLeftOffWorkspace, recordFile, sweepLeftOff, type LeftOffRecord } from '../src/memory/left-off.ts';
import { buildWorkspaceOverview, type OverviewFolder } from '../src/memory/overview.ts';
import type { TerminalInfo } from '../src/terminals/registry.ts';
import { waitFor } from './helpers/wait.ts';

const ID = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';
const DAY = 24 * 3_600_000;

const agent = (id: string, kind: 'agent' | 'shell' = 'agent', status: 'running' | 'exited' = 'running'): TerminalInfo => ({
  id,
  workspaceId: 'dev',
  rel: 'alpha',
  cwd: '/w/alpha',
  title: id,
  kind,
  status,
  createdAt: '2026-11-20T00:00:00.000Z',
});
const line = (fields: Record<string, unknown> = {}) => JSON.stringify({ v: 1, cmd: 'left-off', pane: 'a1', agent: 'claude-code', event: 'Stop', session: ID, text: 'Done.', ...fields });

async function scratch<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mirador-left-off-probe-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the record path never leaves the store folder, whatever the workspace id or folder', () => {
  const dir = '/state/left-off';
  for (const workspaceId of ['dev', '..', '../x', '/etc', 'a/b', '', '.', 'ws\u0000nul', 'x'.repeat(65)]) {
    for (const rel of ['', 'alpha', '../../etc/passwd', '/abs', 'a/b/c', '..']) {
      const file = recordFile(dir, workspaceId, rel);
      const inside = relative(dir, file);
      assert.ok(!isAbsolute(inside) && !inside.split(sep).includes('..'), `${JSON.stringify([workspaceId, rel])} → ${file}`);
      assert.equal(inside.split(sep).length, 2, 'one workspace folder, one file');
      assert.match(inside, /\.claude-code\.json$/);
    }
  }
});

test('rejected lines write nothing and leave the record byte-identical', () =>
  scratch(async (dir) => {
    const terminals = new Map([['a1', agent('a1')], ['s1', agent('s1', 'shell')], ['x1', agent('x1', 'agent', 'exited')]]);
    const store = new LeftOffStore({ dir, days: 30, enabled: true, terminal: (id) => terminals.get(id) });
    assert.equal(store.receive(line()), true);
    await store.flush();
    const file = recordFile(dir, 'dev', 'alpha');
    const before = { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs, names: await readdir(join(file, '..')) };
    const refused = [
      line({ pane: 'nobody' }),
      line({ pane: 's1' }),
      line({ pane: 'x1' }),
      line({ pane: '../a1' }),
      line({ session: '--help' }),
      line({ session: 7 }),
      line({ text: 5 }),
      line({ text: '' }),
      line({ text: ' \n\t' }),
      // SessionEnd carries a reason and no text; a reason goes with SessionEnd only.
      line({ event: 'SessionEnd' }),
      line({ event: 'SessionEnd', reason: 'clear' }),
      line({ event: 'SessionEnd', text: undefined }),
      line({ event: 'SessionEnd', text: undefined, reason: 'Not A Reason' }),
      line({ event: 'SessionEnd', text: undefined, reason: 'x'.repeat(65) }),
      line({ event: 'SessionEnd', text: undefined, reason: 5 }),
      line({ event: 'SessionEnd', text: undefined, reason: 'clear', truncated: true }),
      line({ reason: 'clear' }),
      line({ agent: 'pi' }),
      line({ v: 2 }),
      line({ extra: true }),
      line({ truncated: 'yes' }),
      line({ text: 'x'.repeat(LEFT_OFF_MAX_LINE_BYTES) }),
      '{"v":1,"cmd":"left-off"',
    ];
    for (const sent of refused) assert.equal(store.receive(sent), false, sent.slice(0, 80));
    assert.equal(store.receive(JSON.stringify({ v: 1, cmd: 'report-metadata', pane: 'a1' })), undefined, 'an attention report is not its line');
    await store.flush();
    assert.deepEqual(await readFile(file), before.bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtime);
    assert.deepEqual(await readdir(join(file, '..')), before.names, 'no temporary or other file left');

    // Switched off (config leftOff: false), even a valid line writes nothing.
    const off = new LeftOffStore({ dir, days: 30, enabled: false, terminal: (id) => terminals.get(id) });
    assert.equal(off.receive(line({ text: 'later' })), false);
    await off.flush();
    assert.deepEqual(await readFile(file), before.bytes);
  }));

test('SessionEnd stores the end time and reason on its own session\'s record only, and keeps its texts', () =>
  scratch(async (dir) => {
    const terminals = new Map([['a1', agent('a1')]]);
    let now = Date.parse('2026-11-20T12:00:00.000Z');
    const store = new LeftOffStore({ dir, days: 30, enabled: true, terminal: (id) => terminals.get(id), now: () => now });
    const end = (fields: Record<string, unknown> = {}) => line({ event: 'SessionEnd', text: undefined, reason: 'prompt_input_exit', ...fields });
    const file = recordFile(dir, 'dev', 'alpha');

    // No record yet: an end writes nothing.
    assert.equal(store.receive(end()), true);
    await store.flush();
    assert.deepEqual(await readdir(dir).catch(() => []), [], 'nothing written');

    assert.equal(store.receive(line({ text: 'Done.' })), true);
    await store.flush();
    const texts = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(texts.endedAt, undefined, 'format v1 without an end: no endedAt or endReason');
    assert.equal(texts.endReason, undefined);

    // Another session's end leaves the record byte-identical.
    const before = await readFile(file);
    now += 60_000;
    assert.equal(store.receive(end({ session: '7c1d9e3f-5a2b-4c8d-8e6f-1a0b2c3d4e5f' })), true);
    await store.flush();
    assert.deepEqual(await readFile(file), before);

    now += 60_000;
    assert.equal(store.receive(end()), true);
    await store.flush();
    const ended = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(ended, { ...texts, at: '2026-11-20T12:02:00.000Z', endedAt: '2026-11-20T12:02:00.000Z', endReason: 'prompt_input_exit' }, 'the end, at the server\'s time; the texts as they were');

    // The session goes on (a resumed session): a new text clears the end.
    now += 60_000;
    assert.equal(store.receive(line({ event: 'UserPromptSubmit', text: 'and now?' })), true);
    await store.flush();
    const resumed = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([resumed.endedAt, resumed.endReason, resumed.lastMessage.text, resumed.lastUserMessage.text], [undefined, undefined, 'Done.', 'and now?']);
  }));

test('deleteLeftOff removes one folder\'s record and is idempotent; deleteLeftOffWorkspace removes one workspace\'s folder', () =>
  scratch(async (dir) => {
    const put = async (workspaceId: string, rel: string) => {
      const file = recordFile(dir, workspaceId, rel);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `{"rel":${JSON.stringify(rel)}}`);
      return file;
    };
    const alpha = await put('dev', 'alpha');
    const beta = await put('dev', 'beta');
    const other = await put('other', 'alpha');
    const odd = await put('../x', 'alpha');
    assert.equal(await deleteLeftOff(dir, 'dev', 'alpha'), true);
    assert.equal(await deleteLeftOff(dir, 'dev', 'alpha'), false, 'again: nothing to remove, no error');
    assert.equal(await deleteLeftOff(dir, 'nobody', '../../etc/passwd'), false);
    const exists = (path: string) => stat(path).then(() => true, () => false);
    assert.deepEqual([await exists(alpha), await exists(beta), await exists(other), await exists(odd)], [false, true, true, true]);

    await deleteLeftOffWorkspace(dir, 'dev');
    await deleteLeftOffWorkspace(dir, 'dev');
    await deleteLeftOffWorkspace(dir, '..');
    await deleteLeftOffWorkspace(dir, '../x');
    assert.deepEqual([await exists(beta), await exists(other), await exists(odd), await exists(dir)], [false, true, false, true], 'only that workspace\'s folder; an odd id maps to its hashed folder');
    assert.deepEqual(await readdir(dir), ['other']);
  }));

test('the sweep removes expired records and stale stray json, keeps the rest and drops empty folders', () =>
  scratch(async (dir) => {
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const record = (ageDays: number): LeftOffRecord => {
      const at = new Date(now - ageDays * DAY).toISOString();
      return { v: 1, agent: 'claude-code', workspaceId: 'dev', rel: 'r', sessionId: ID, at, lastUserMessage: null, lastMessage: { text: 't', at }, compactSummary: null };
    };
    const put = async (path: string, text: string, mtimeDaysAgo?: number) => {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text);
      if (mtimeDaysAgo !== undefined) await utimes(path, new Date(now - mtimeDaysAgo * DAY), new Date(now - mtimeDaysAgo * DAY));
    };
    await put(join(dir, 'dev', 'old.claude-code.json'), JSON.stringify(record(31)));
    await put(join(dir, 'dev', 'fresh.claude-code.json'), JSON.stringify(record(29)));
    await put(join(dir, 'dev', 'stray-old.json'), 'not a record', 40);
    await put(join(dir, 'dev', 'stray-new.json'), 'not a record', 1);
    await put(join(dir, 'dev', 'notes.txt'), 'not json at all', 400);
    await put(join(dir, 'gone', 'old.claude-code.json'), JSON.stringify(record(90)));
    await mkdir(join(dir, 'empty'));
    await put(join(dir, 'top-level.json'), JSON.stringify(record(90)));

    assert.equal(await sweepLeftOff(dir, { days: 30, now }), 3);
    assert.deepEqual((await readdir(join(dir, 'dev'))).sort(), ['fresh.claude-code.json', 'notes.txt', 'stray-new.json']);
    assert.deepEqual((await readdir(dir)).sort(), ['dev', 'top-level.json'], 'empty workspace folders dropped; a file outside them is not the sweep\'s');
    assert.equal(await sweepLeftOff(dir, { days: 30, now }), 0, 'a second sweep finds nothing');
    assert.equal(await sweepLeftOff(join(dir, 'missing'), { days: 30, now }), 0, 'no folder yet: nothing to do');
  }));

test('the attention report keeps its 4096-byte cap; only the socket cap grows, for left-off lines', () =>
  scratch(async (dir) => {
    assert.equal(MAX_LINE_BYTES, 4096);
    assert.ok(LEFT_OFF_MAX_LINE_BYTES > MAX_LINE_BYTES);
    const attention = new AttentionStore();
    attention.track({ type: 'created', info: agent('a1') });
    const report = (pad: number) => JSON.stringify({ v: 1, cmd: 'report-metadata', pane: 'a1', source: 'mirador:attention', seq: Date.now(), ttlMs: null, tokens: { prompt: 'x' }, clear: [], pad: 'p'.repeat(pad) });
    assert.equal(attention.receive(report(10)), true, 'a small report is applied');
    const big = report(MAX_LINE_BYTES);
    assert.ok(Buffer.byteLength(big) > MAX_LINE_BYTES);
    assert.equal(attention.receive(big), false, 'over 4096 bytes: refused by the attention store');

    // The socket bounds what one connection buffers before a newline; each reader then checks its own cap
    // (a complete long line in one chunk reaches the reader, which is why the attention store checks 4096).
    const leftOffSized = line({ text: 'y'.repeat(20 * 1024) });
    const head = leftOffSized.slice(0, 10 * 1024);
    const connect = async (path: string) => {
      const conn = createConnection(path);
      const state = { closed: false };
      conn.on('error', () => {});
      conn.on('close', () => (state.closed = true));
      await new Promise<void>((resolve) => conn.on('connect', () => resolve()));
      return { conn, state };
    };
    const servers: Array<{ close(): unknown }> = [];
    try {
      // Default cap: 10 KiB without a newline is past 4096 bytes, so the server drops the connection.
      const defaultLines: string[] = [];
      const defaultPath = join(dir, 'default', 'socket');
      servers.push(await listenForReports(defaultPath, (got) => defaultLines.push(got)));
      const dropped = await connect(defaultPath);
      dropped.conn.write(head);
      await waitFor(() => (dropped.state.closed ? true : undefined), 'the default socket to drop the connection');
      assert.deepEqual(defaultLines, []);

      // Left-off cap: the same start is kept, and the line arrives whole once it ends.
      const wideLines: string[] = [];
      const widePath = join(dir, 'wide', 'socket');
      servers.push(await listenForReports(widePath, (got) => wideLines.push(got), { maxLineBytes: LEFT_OFF_MAX_LINE_BYTES }));
      const kept = await connect(widePath);
      kept.conn.write(head);
      kept.conn.end(`${leftOffSized.slice(head.length)}\n${big}\n`);
      await waitFor(() => (wideLines.length === 2 ? true : undefined), 'both lines on the left-off socket');
      assert.deepEqual(wideLines, [leftOffSized, big]);
      assert.equal(attention.receive(wideLines[1]), false, 'a big report through the wide socket is still refused');

      // Past the left-off cap without a newline, that connection is dropped too.
      const over = await connect(widePath);
      over.conn.write('z'.repeat(LEFT_OFF_MAX_LINE_BYTES + 1));
      await waitFor(() => (over.state.closed ? true : undefined), 'the left-off socket to drop the connection');
      assert.equal(wideLines.length, 2);
    } finally {
      for (const server of servers) server.close();
    }
  }));

test('a tie between Engram\'s summary and the record goes to Engram', () => {
  const folder: OverviewFolder = { name: 'alpha', rel: 'alpha', path: '/w/alpha', isRepo: true, projects: ['alpha'], hasMemory: true };
  const engram = { id: 1, type: 'session_summary', title: 'Session summary', project: 'alpha', created_at: '2026-10-28 11:00:00', content: '## Goal\nFrom Engram' };
  const record = (at: string): LeftOffRecord => ({ v: 1, agent: 'claude-code', workspaceId: 'dev', rel: 'alpha', sessionId: ID, at, lastUserMessage: null, lastMessage: { text: 'From the record', at }, compactSummary: null });
  const row = (local: LeftOffRecord) =>
    buildWorkspaceOverview({ date: '2026-10-28', timeZone: 'UTC', folders: [folder], observations: [engram] as any, windowFull: false, localLeftOff: () => local }).rows[0].leftOff.summary;
  assert.equal(row(record('2026-10-28T11:00:00.000Z'))?.goal, 'From Engram', 'same second: Engram');
  assert.equal(row(record('2026-10-28T11:00:00.900Z'))?.goal, 'From Engram', 'within the same second Engram writes: Engram');
  assert.equal(row(record('2026-10-28T11:00:01.000Z'))?.source, 'claude-code', 'one second later: the record');
});
