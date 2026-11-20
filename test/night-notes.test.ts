// Execution notes: what the user leaves for an agent terminal or a workspace before
// sleeping. Input validation, the 0600 file, delivered / pending bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_NOTE_CHARS, MAX_NOTES, NoteError, NoteStore, parseNoteInput, type NoteLookup } from '../src/night/notes.ts';

const lookup: NoteLookup = {
  workspace: (id) => id === 'dev' || id === 'ops',
  terminal: (id) =>
    id === 't-agent' ? { workspaceId: 'dev', kind: 'agent', status: 'running' }
    : id === 't-shell' ? { workspaceId: 'dev', kind: 'shell', status: 'running' }
    : id === 't-exited' ? { workspaceId: 'dev', kind: 'agent', status: 'exited' }
    : undefined,
};

async function scratch() {
  const base = await mkdtemp(join(tmpdir(), 'mirador-notes-'));
  return { dir: join(base, 'night'), cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('parseNoteInput accepts a workspace note and a terminal note of that workspace, text trimmed', () => {
  assert.deepEqual(parseNoteInput({ workspaceId: 'dev', text: '  Finish the report tests.\nThen stop.  ' }, lookup), { workspaceId: 'dev', text: 'Finish the report tests.\nThen stop.' });
  assert.deepEqual(parseNoteInput({ workspaceId: 'dev', terminalId: 't-agent', text: 'Go on with N5.' }, lookup), { workspaceId: 'dev', terminalId: 't-agent', text: 'Go on with N5.' });
  assert.deepEqual(parseNoteInput({ workspaceId: 'dev', text: 'x'.repeat(MAX_NOTE_CHARS) }, lookup).text.length, MAX_NOTE_CHARS);
  assert.equal(parseNoteInput({ workspaceId: 'dev', text: 'ñ'.repeat(MAX_NOTE_CHARS) }, lookup).text.length, MAX_NOTE_CHARS, 'counted in characters');
});

test('parseNoteInput rejects bad bodies with stable codes', () => {
  const cases: Array<[unknown, string, RegExp]> = [
    [null, 'night_note', /object/],
    [{ workspaceId: 'dev', text: 'a', extra: 1 }, 'night_note', /unknown field extra/],
    [{ text: 'a' }, 'night_note', /workspaceId/],
    [{ workspaceId: 3, text: 'a' }, 'night_note', /workspaceId/],
    [{ workspaceId: 'dev' }, 'night_note', /text/],
    [{ workspaceId: 'dev', text: '   ' }, 'night_note', /text/],
    [{ workspaceId: 'dev', text: 'x'.repeat(MAX_NOTE_CHARS + 1) }, 'night_note', /2000/],
    [{ workspaceId: 'dev', text: 'bad \u0000 byte' }, 'night_note', /control/],
    [{ workspaceId: 'dev', text: 'a', terminalId: 5 }, 'night_note', /terminalId/],
    [{ workspaceId: 'nope', text: 'a' }, 'night_note_workspace', /workspace/],
    [{ workspaceId: 'dev', terminalId: 'missing', text: 'a' }, 'night_note_terminal', /terminal/],
    [{ workspaceId: 'dev', terminalId: 't-shell', text: 'a' }, 'night_note_terminal', /agent/],
    [{ workspaceId: 'dev', terminalId: 't-exited', text: 'a' }, 'night_note_terminal', /running/],
    [{ workspaceId: 'ops', terminalId: 't-agent', text: 'a' }, 'night_note_terminal', /workspace/],
  ];
  for (const [body, code, message] of cases) {
    assert.throws(() => parseNoteInput(body, lookup), (error: unknown) => error instanceof NoteError && error.code === code && message.test(error.message), JSON.stringify(body)?.slice(0, 80));
  }
});

test('NoteStore adds, lists, delivers, keeps pending with a reason and removes notes in a 0600 file', async () => {
  const { dir, cleanup } = await scratch();
  try {
    let clock = Date.parse('2026-10-28T22:00:00Z');
    const store = new NoteStore(dir, { now: () => clock });
    assert.deepEqual(await store.list(), []);
    const ws = await store.add({ workspaceId: 'dev', text: 'Keep going with the panel.' });
    clock += 1000;
    const term = await store.add({ workspaceId: 'dev', terminalId: 't-agent', text: 'Run the tests first.' });
    assert.match(ws.id, /^[\w-]{8,64}$/);
    assert.deepEqual(ws, { id: ws.id, workspaceId: 'dev', text: 'Keep going with the panel.', createdAt: '2026-10-28T22:00:00.000Z' });
    assert.equal(term.terminalId, 't-agent');
    assert.deepEqual((await store.pending()).map((note) => note.id), [ws.id, term.id], 'oldest first');

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'notes.json'))).mode & 0o777, 0o600);

    clock += 1000;
    await store.markDelivered(ws.id, ['t-agent', 't-other']);
    await store.markPending(term.id, 'the terminal is closed');
    // The same clock: a fresh store drops delivered notes older than DELIVERED_KEEP_MS from now.
    const after = await new NoteStore(dir, { now: () => clock }).list();
    assert.deepEqual(after.find((note) => note.id === ws.id), { ...ws, deliveredAt: '2026-10-28T22:00:02.000Z', deliveredTo: ['t-agent', 't-other'] });
    assert.deepEqual(after.find((note) => note.id === term.id), { ...term, pendingReason: 'the terminal is closed' });
    assert.deepEqual((await store.pending()).map((note) => note.id), [term.id], 'a delivered note is never delivered again');

    assert.equal(await store.remove(term.id), true);
    assert.equal(await store.remove(term.id), false);
    assert.deepEqual((await new NoteStore(dir, { now: () => clock }).list()).map((note) => note.id), [ws.id]);
  } finally {
    await cleanup();
  }
});

test('NoteStore caps the pending notes and ignores an unreadable file', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const store = new NoteStore(dir);
    for (let i = 0; i < MAX_NOTES; i++) await store.add({ workspaceId: 'dev', text: `note ${i}` });
    await assert.rejects(store.add({ workspaceId: 'dev', text: 'one too many' }), (error: unknown) => error instanceof NoteError && error.code === 'night_note_full');
    await writeFile(join(dir, 'notes.json'), '{broken');
    assert.deepEqual(await new NoteStore(dir).list(), []);
    // Entries that do not fit the shape are dropped on read.
    await writeFile(join(dir, 'notes.json'), JSON.stringify({ notes: [{ id: 'ok-1', workspaceId: 'dev', text: 'fine', createdAt: '2026-10-28T22:00:00.000Z' }, { id: 5, text: 'bad' }] }));
    assert.deepEqual((await new NoteStore(dir).list()).map((note) => note.id), ['ok-1']);
    assert.ok(!(await readFile(join(dir, 'notes.json'), 'utf8')).includes('one too many'));
  } finally {
    await cleanup();
  }
});
