// "Where it left off" without Engram, through the public interface: Claude Code's hooks (run by a fake
// claude from the settings Mirador passes it) hand the prompt, the final message and the compaction
// summary to bin/claude-hook, which sends them over Mirador's herdr socket; the server validates them
// and writes one 0600 record per folder under <state>/mirador/left-off, and GET /api/overview/folder
// and GET /api/folder/git show it, newest first against a fake Engram that can be switched off.
// Rejected lines leave the store unchanged; expired records go at start; `leftOff: false` stores
// nothing. SessionEnd marks the record's end; Forget (the block's, a sleeping agent's, a removed
// workspace) removes records; GET /api/overview's rows use the record too.
// The real server runs with a scratch HOME, runtime, state and config dir; no real agent runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchBase } from './helpers/scratch.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const S1 = '0f8e2a4c-1b7d-4e5f-9a6b-3c2d1e0f9a8b';
const S2 = '7c1d9e3f-5a2b-4c8d-8e6f-1a0b2c3d4e5f';
const S3 = '3a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';
const BOUND = 16 * 1024;

let scratch: string;
let base: string;
let server: ChildProcess | undefined;
let output = '';
let api: (method: string, path: string, body?: unknown) => Promise<Response>;
let token = '';
let fakeEngram: Server;
const engram = { down: true, observations: [] as Array<Record<string, unknown>> };

type Info = { id: string; kind: string; rel: string };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out; server output:\n${output}`);
}

const home = () => join(scratch, 'home');
const configFile = () => join(scratch, 'cfg', 'mirador', 'config.json');
const leftOffDir = () => join(scratch, 'state', 'mirador', 'left-off');
const socketPath = () => join(scratch, 'run', 'mirador', 'herdr', 'socket');
const settingsPath = () => join(scratch, 'run', 'mirador', 'herdr', 'claude-settings.json');
const exists = (path: string) => access(path).then(() => true, () => false);

/** Every file under the left-off folder, relative to it, with its bytes: what the store holds. */
async function snapshot(): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      // The store writes `.<name>.<pid>.tmp` and then renames it: a temp file is no record yet, and
      // reading one would let a test ask the server before the record is there.
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else found[rel] = await readFile(join(dir, entry.name), 'utf8');
    }
  };
  await walk(leftOffDir(), '');
  return found;
}

/** The record of the folder whose record names `rel`, read from disk. */
async function recordOf(rel: string): Promise<{ path: string; record: any } | undefined> {
  for (const [name, text] of Object.entries(await snapshot())) {
    const record = JSON.parse(text);
    if (record.rel === rel) return { path: join(leftOffDir(), name), record };
  }
  return undefined;
}

let events = 0;
/** Makes the fake claude of terminal `id` run its hooks for one event, and waits until they ran. */
async function fire(id: string, event: string, fields: object): Promise<void> {
  const done = join(home(), `done-${id}-${++events}`);
  const payload = { session_id: S1, transcript_path: join(home(), 'projects', `${S1}.jsonl`), cwd: join(scratch, 'root'), permission_mode: 'default', hook_event_name: event, ...fields };
  const trigger = join(home(), `do-${id}`);
  await writeFile(`${trigger}.tmp`, JSON.stringify({ done, payload }));
  await rename(`${trigger}.tmp`, trigger);
  await waitFor(async () => ((await exists(done)) ? true : undefined));
}

/** Sends `lines` to Mirador's herdr socket on one connection and resolves once it closed. */
function sendLines(lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    const conn = createConnection(socketPath());
    conn.on('error', () => resolve());
    conn.on('close', () => resolve());
    conn.on('connect', () => conn.end(lines.map((line) => `${line}\n`).join('')));
  });
}

const leftOffLine = (fields: Record<string, unknown>) => JSON.stringify({ v: 1, cmd: 'left-off', agent: 'claude-code', event: 'Stop', session: S1, text: 'done', ...fields });

async function start(config: Record<string, unknown> = {}): Promise<void> {
  output = '';
  const engramAddress = fakeEngram.address();
  const engramPort = typeof engramAddress === 'object' && engramAddress ? engramAddress.port : 0;
  await writeFile(configFile(), JSON.stringify({ root: join(scratch, 'root'), engramUrl: `http://127.0.0.1:${engramPort}`, timeZone: 'UTC', launches: { batchSize: 10, settleMs: 0, reserveMb: 0 }, ...config }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.ts'], {
    cwd: APP_DIR,
    env: {
      PATH: join(scratch, 'bin'),
      HOME: home(),
      GENTLE_AI_HOME: join(scratch, 'gentle-ai'),
      GENTLE_SHELL_HOME: join(scratch, 'no-gentle-shell'),
      MIRADOR_SCOPES: '0',
      XDG_RUNTIME_DIR: join(scratch, 'run'),
      XDG_CONFIG_HOME: join(scratch, 'cfg'),
      XDG_STATE_HOME: join(scratch, 'state'),
      MIRADOR_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => (output += d));
  server.stderr?.on('data', (d) => (output += d));
  const state = await waitFor(async () => JSON.parse(await readFile(join(scratch, 'run', 'mirador', 'state.json'), 'utf8')));
  const boot = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${state.launchSecret}` } });
  const nonce = new URL(((await boot.json()) as { url: string }).url).hash.replace('#launch=', '');
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  token = ((await session.json()) as { token: string }).token;
  api = (method, path, body) =>
    fetch(`${base}${path}`, { method, headers: { origin: base, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function stop(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server!.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

// The fake claude: records its argv, reads `--settings`, and runs every command hook of an event the
// test drops in `$HOME/do-<pane>` (as Claude Code does: `sh -c <command>`, the payload on stdin).
const FAKE_CLAUDE = `#!${process.execPath}
const { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const home = process.env.HOME;
const pane = process.env.HERDR_PANE_ID;
const put = (file, text) => {
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
};
put(home + '/args-' + pane, ['claude', ...process.argv.slice(2)].map((word) => word + '\\n').join(''));
const at = process.argv.indexOf('--settings');
const settings = at > 0 ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : {};
setInterval(() => {
  const trigger = home + '/do-' + pane;
  if (!existsSync(trigger)) return;
  const { done, payload } = JSON.parse(readFileSync(trigger, 'utf8'));
  unlinkSync(trigger);
  for (const group of (settings.hooks || {})[payload.hook_event_name] || []) {
    for (const hook of group.hooks || []) {
      if (hook.type === 'command') spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify(payload), env: process.env });
    }
  }
  put(done, '');
}, 30);
`;

before(async () => {
  scratch = await realpath(await mkdtemp(join(scratchBase(), 'mirador-left-off-')));
  for (const rel of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) await mkdir(join(scratch, 'root', rel), { recursive: true });
  await mkdir(join(scratch, 'other', 'one'), { recursive: true });
  await mkdir(home(), { recursive: true });
  await mkdir(join(scratch, 'bin'), { recursive: true });
  await writeFile(join(scratch, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  await mkdir(join(scratch, 'gentle-ai'), { recursive: true });
  await writeFile(join(scratch, 'gentle-ai', 'state.json'), JSON.stringify({ installed_agents: ['claude-code'] }));
  await mkdir(join(scratch, 'cfg', 'mirador'), { recursive: true });
  fakeEngram = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (engram.down) return void res.writeHead(500).end('{}');
    if (url.pathname === '/project/current') return void res.end(JSON.stringify({ project: basename(url.searchParams.get('cwd') ?? ''), project_source: 'git_remote' }));
    if (url.pathname === '/projects') {
      const names = [...new Set(engram.observations.map((o) => o.project as string))];
      return void res.end(JSON.stringify({ projects: names.map((name) => ({ name, observation_count: 1, directories: [] })) }));
    }
    if (url.pathname === '/observations/recent' && url.searchParams.get('all_projects') === 'true') return void res.end(JSON.stringify(engram.observations));
    if (url.pathname === '/observations/recent') {
      const own = engram.observations.filter((o) => o.project === url.searchParams.get('project'));
      if (!own.length) return void res.writeHead(404).end(JSON.stringify({ error: 'project not found' }));
      return void res.end(JSON.stringify(own));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => fakeEngram.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await stop();
  fakeEngram?.close();
  await rm(scratch, { recursive: true, force: true });
});

const open = async (rel: string, kind = 'agent') => {
  // After a restart the agents it reopens come first (409 launches_running until they are open).
  const response = await waitFor(async () => {
    const answer = await api('POST', '/api/terminals', { ws: 'dev', rel, kind, cols: 90, rows: 33, ...(kind === 'agent' ? { agent: 'claude-code' } : {}) });
    return answer.status === 409 ? undefined : answer;
  }, 15_000);
  assert.equal(response.status, 201);
  const info = (await response.json()) as Info;
  if (kind === 'agent') await waitFor(async () => ((await exists(join(home(), `args-${info.id}`))) ? true : undefined));
  return info;
};
const folderView = async (rel: string) => {
  const response = await api('GET', `/api/overview/folder?ws=dev&rel=${rel}`);
  return { status: response.status, body: (await response.json()) as any };
};
const plainView = async (rel: string) => ((await (await api('GET', `/api/folder/git?ws=dev&rel=${rel}`)).json()) as any).leftOff;

let alpha: Info;
let beta: Info;
let gamma: Info;

test('the hooks hand the prompt, the final message and the compaction summary to the server, which writes a 0600 record the view shows without Engram', async () => {
  await start();
  alpha = await open('alpha');
  const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  for (const event of ['UserPromptSubmit', 'Stop', 'PostCompact', 'SessionEnd']) assert.match(settings.hooks[event]?.[0]?.hooks[0]?.command ?? '', /bin\/claude-hook'?$/, event);

  // A typed command arrives as typed and is the user's last message.
  await fire(alpha.id, 'UserPromptSubmit', { prompt: '/deploy staging' });
  const asked = await waitFor(() => recordOf('alpha'));
  assert.equal((await stat(asked.path)).mode & 0o777, 0o600, 'the record is 0600');
  assert.equal((await stat(leftOffDir())).mode & 0o777, 0o700, 'its folder is 0700');
  assert.equal((await stat(join(leftOffDir(), 'dev'))).mode & 0o777, 0o700, 'the workspace folder is 0700');
  assert.deepEqual([asked.record.agent, asked.record.workspaceId, asked.record.sessionId, asked.record.lastUserMessage.text, asked.record.lastMessage, asked.record.compactSummary], ['claude-code', 'dev', S1, '/deploy staging', null, null]);

  // Engram is down: the folder view still answers, from the record.
  const first = await folderView('alpha');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.engramUnavailable, true);
  assert.deepEqual([first.body.row.leftOff.summary.source, first.body.row.leftOff.summary.from, first.body.row.leftOff.summary.lastUserMessage], ['claude-code', 'lastUserMessage', '/deploy staging']);

  await fire(alpha.id, 'Stop', { stop_hook_active: false, last_assistant_message: 'Deployed.\n\n## Accomplished\n- wired the hook\n\n## Next steps\n- write the docs' });
  await waitFor(async () => ((await recordOf('alpha'))?.record.lastMessage ? true : undefined));
  const stopped = (await folderView('alpha')).body.row.leftOff.summary;
  assert.deepEqual(
    [stopped.source, stopped.from, stopped.accomplished, stopped.nextSteps, stopped.lastUserMessage],
    ['claude-code', 'lastMessage', '- wired the hook', '- write the docs', '/deploy staging'],
    'Claude\'s final answer is parsed like a session summary, under the user\'s last message',
  );
  assert.match(stopped.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'in Engram\'s time format, so the view compares and shows it the same way');

  // A compaction after the final message is the newer text: it shows, in both modes.
  await fire(alpha.id, 'PostCompact', { trigger: 'auto', compact_summary: 'The conversation so far, compacted.' });
  await waitFor(async () => ((await recordOf('alpha'))?.record.compactSummary ? true : undefined));
  const compactedAlpha = (await folderView('alpha')).body.row.leftOff.summary;
  assert.deepEqual([compactedAlpha.from, compactedAlpha.excerpt, compactedAlpha.lastUserMessage], ['compactSummary', 'The conversation so far, compacted.', '/deploy staging'], 'the newer compaction summary wins over the final message');
  const plainCompacted = await plainView('alpha');
  assert.deepEqual([plainCompacted.source, plainCompacted.from, plainCompacted.text, plainCompacted.lastUserMessage], ['claude-code', 'compactSummary', 'The conversation so far, compacted.', '/deploy staging']);
  // A final message after the compaction wins again.
  await fire(alpha.id, 'Stop', { stop_hook_active: false, last_assistant_message: 'Deployed.\n\n## Accomplished\n- wired the hook\n\n## Next steps\n- write the docs' });
  await waitFor(async () => {
    const { record } = (await recordOf('alpha')) ?? {};
    return record && Date.parse(record.lastMessage.at) > Date.parse(record.compactSummary.at) ? true : undefined;
  });
  assert.equal((await folderView('alpha')).body.row.leftOff.summary.from, 'lastMessage', 'the newer final message wins over the compaction summary');
  const plain = await plainView('alpha');
  assert.deepEqual([plain.source, plain.from, plain.text, plain.lastUserMessage], ['claude-code', 'lastMessage', 'Deployed.\n\n## Accomplished\n- wired the hook\n\n## Next steps\n- write the docs', '/deploy staging']);

  // A session with only a compaction summary falls back to it.
  beta = await open('beta');
  await fire(beta.id, 'PostCompact', { session_id: S2, trigger: 'manual', compact_summary: '## Next Steps\n- resume the migration' });
  await waitFor(() => recordOf('beta'));
  const compacted = (await folderView('beta')).body.row.leftOff.summary;
  assert.deepEqual([compacted.from, compacted.nextSteps, compacted.lastUserMessage], ['compactSummary', '- resume the migration', null]);

  assert.equal(await exists(join(home(), '.claude')), false, 'no ~/.claude written');
  assert.equal(await exists(join(scratch, 'root', 'alpha', '.claude')), false, 'no project .claude written');
  assert.doesNotMatch(output, /deploy staging|wired the hook/, 'the text never reaches the log');
});

test('pasted content is bounded after its expansion, cut on a character boundary with a marker', async () => {
  const pasted = 'Look at this:\n<pasted_content id="1">\n' + 'é'.repeat(30_000) + '\n</pasted_content id="1">';
  await fire(alpha.id, 'UserPromptSubmit', { prompt: pasted });
  const { record } = await waitFor(async () => {
    const found = await recordOf('alpha');
    return found?.record.lastUserMessage.text.startsWith('Look at this') ? found : undefined;
  });
  const text = record.lastUserMessage.text as string;
  assert.ok(Buffer.byteLength(text) <= BOUND, `bounded to ${BOUND} bytes: ${Buffer.byteLength(text)}`);
  assert.ok(Buffer.byteLength(text) > BOUND - 8, 'kept up to the bound');
  assert.equal(record.lastUserMessage.truncated, true);
  assert.ok(text.endsWith('…'), 'ends with the marker');
  assert.equal(text.includes('�'), false, 'never cut inside a character');
  const shown = (await folderView('alpha')).body.row.leftOff.summary.lastUserMessage as string;
  assert.ok(shown.startsWith('Look at this:\n<pasted_content id="1">'), 'shown as the text it is');
  assert.ok(shown.length <= 2001, 'and clipped in the view like an excerpt');
});

test('rejected lines leave the store unchanged; an over-long text from the socket is cut by the server', async () => {
  gamma = await open('gamma');
  const shell = await open('delta', 'shell');
  const before = await snapshot();
  // A line past the socket's cap drops the connection.
  await sendLines([leftOffLine({ pane: gamma.id, text: 'z'.repeat(200 * 1024) })]);
  await sendLines([
    leftOffLine({ pane: 'no-such-terminal' }),
    leftOffLine({ pane: shell.id }),
    leftOffLine({ pane: gamma.id, session: '--help' }),
    leftOffLine({ pane: gamma.id, session: undefined }),
    leftOffLine({ pane: gamma.id, text: 42 }),
    leftOffLine({ pane: gamma.id, text: '   ' }),
    leftOffLine({ pane: gamma.id, event: 'SessionStart' }),
    leftOffLine({ pane: gamma.id, agent: 'pi' }),
    leftOffLine({ pane: gamma.id, v: 2 }),
    leftOffLine({ pane: gamma.id, extra: 'field' }),
    leftOffLine({ pane: gamma.id, truncated: 'yes' }),
    '{"v":1,"cmd":"left-off",',
    // Then one valid line, sent after them on the same connection: once it is stored, they were all read.
    leftOffLine({ pane: gamma.id, text: 'y'.repeat(20 * 1024) }),
  ]);
  const { record } = await waitFor(() => recordOf('gamma'));
  assert.equal(Buffer.byteLength(record.lastMessage.text) <= BOUND, true);
  assert.equal(record.lastMessage.truncated, true);
  assert.ok(record.lastMessage.text.endsWith('…'));
  const after = await snapshot();
  const added = Object.keys(after).filter((name) => !(name in before));
  assert.equal(added.length, 1, `only gamma's record was added: ${added}`);
  for (const [name, text] of Object.entries(before)) assert.equal(after[name], text, `${name} is unchanged`);
});

test('SessionEnd stores its time and reason on the session\'s record; another session\'s end or a bad reason changes nothing', async () => {
  const before = (await recordOf('alpha'))!;
  const bytes = await readFile(before.path, 'utf8');
  // Another session's end, then a bad reason, through the hooks; then one valid line for gamma on the socket:
  // writes run in order, so once gamma's text is stored, the two before it were handled.
  await fire(alpha.id, 'SessionEnd', { session_id: S2, reason: 'clear' });
  await sendLines([leftOffLine({ pane: alpha.id, event: 'SessionEnd', text: undefined, reason: 'Not A Reason' }), leftOffLine({ pane: gamma.id, text: 'gamma after the ends' })]);
  await waitFor(async () => ((await recordOf('gamma'))?.record.lastMessage.text === 'gamma after the ends' ? true : undefined));
  assert.equal(await readFile(before.path, 'utf8'), bytes, 'alpha\'s record is byte-identical');

  const sent = Date.now();
  await fire(alpha.id, 'SessionEnd', { reason: 'prompt_input_exit' });
  const { record } = await waitFor(async () => {
    const found = await recordOf('alpha');
    return found?.record.endReason ? found : undefined;
  });
  assert.equal(record.endReason, 'prompt_input_exit');
  assert.match(record.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO, like at');
  assert.ok(Date.parse(record.endedAt) >= sent - 1000 && record.endedAt === record.at, 'the server\'s time of the end');
  for (const field of ['sessionId', 'lastUserMessage', 'lastMessage', 'compactSummary']) assert.deepEqual(record[field], before.record[field], `${field} unchanged`);
  const shown = (await folderView('alpha')).body.row.leftOff.summary;
  assert.deepEqual([shown.from, shown.endedAt, shown.endReason], ['lastMessage', undefined, undefined], 'stored only: the view shows the same block');
});

test('a newer Engram summary wins over the record, an older one loses, and the source says which', async (t) => {
  // A failure here must not leave Engram up for the tests after it.
  t.after(() => {
    engram.down = true;
    engram.observations = [];
  });
  engram.down = false;
  engram.observations = [{ id: 1, type: 'session_summary', title: 'Session summary', project: 'alpha', created_at: '2000-01-01 10:00:00', content: '## Goal\nAn old goal\n## Next Steps\n- old step' }];
  const older = (await folderView('alpha')).body;
  assert.equal(older.engramUnavailable, undefined);
  assert.deepEqual([older.row.leftOff.summary.source, older.row.leftOff.summary.from], ['claude-code', 'lastMessage'], 'the record is newer');
  engram.observations = [{ id: 2, type: 'session_summary', title: 'Session summary', project: 'alpha', created_at: '2999-01-01 10:00:00', content: '## Goal\nThe newest goal\n## Next Steps\n- new step' }];
  const newer = (await folderView('alpha')).body.row.leftOff.summary;
  assert.deepEqual(newer, { at: '2999-01-01 10:00:00', goal: 'The newest goal', accomplished: null, nextSteps: '- new step' }, 'Engram\'s summary, as before');
  engram.down = true;
  engram.observations = [];
  const none = await folderView('delta');
  assert.equal(none.status, 503, 'Engram down and no record: unchanged');
});

test('the workspace summary rows use the record too: newest wins per row, and Engram down still answers when a record exists', async (t) => {
  t.after(() => {
    engram.down = true;
    engram.observations = [];
  });
  const rows = async (ws = 'dev') => {
    const response = await api('GET', `/api/overview?ws=${ws}`);
    return { status: response.status, body: (await response.json()) as any };
  };
  const down = await rows();
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal(down.body.engramUnavailable, true);
  const byRel = (body: any) => Object.fromEntries(body.rows.map((row: any) => [row.rel, row]));
  const fromRecord = byRel(down.body);
  assert.deepEqual(Object.keys(fromRecord).sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
  assert.deepEqual([fromRecord.alpha.leftOff.summary.source, fromRecord.alpha.leftOff.summary.from, fromRecord.alpha.leftOff.summary.nextSteps], ['claude-code', 'lastMessage', '- write the docs']);
  assert.ok(fromRecord.alpha.leftOff.summary.lastUserMessage.startsWith('Look at this:') && fromRecord.alpha.leftOff.summary.lastUserMessage.length <= 2001, 'the user\'s message, clipped like the row\'s excerpt');
  assert.deepEqual([fromRecord.beta.leftOff.summary.from, fromRecord.beta.leftOff.summary.nextSteps], ['compactSummary', '- resume the migration']);
  assert.equal(fromRecord.delta.leftOff.summary, null, 'no record: nothing, as before');
  assert.match(fromRecord.alpha.lastAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'last worked counts the record');
  assert.equal(down.body.rows[down.body.rows.length - 1].lastAt, null, 'folders without memory or record last');

  // Engram up: a newer Engram summary wins alpha's row, beta keeps its record.
  engram.down = false;
  engram.observations = [{ id: 3, type: 'session_summary', title: 'Session summary', project: 'alpha', created_at: '2999-01-01 10:00:00', content: '## Goal\nThe newest goal\n## Next Steps\n- new step' }];
  const up = await rows();
  assert.equal(up.status, 200);
  assert.equal(up.body.engramUnavailable, undefined);
  const mixed = byRel(up.body);
  assert.deepEqual(mixed.alpha.leftOff.summary, { at: '2999-01-01 10:00:00', goal: 'The newest goal', accomplished: null, nextSteps: '- new step' });
  assert.equal(mixed.beta.leftOff.summary.source, 'claude-code');
  assert.equal(mixed.alpha.day.memories, 0);
});

test('Forget on the block removes the folder\'s record only, idempotently, behind the same checks as the GET', async () => {
  const gammaRecord = (await recordOf('gamma'))!;
  const before = await snapshot();
  const forget = (query: string) => api('DELETE', `/api/folder/left-off?${query}`);
  // The origin check of every mutating route: no Origin, no delete.
  const crossSite = await fetch(`${base}/api/folder/left-off?ws=dev&rel=gamma`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(crossSite.status, 403);
  const noToken = await fetch(`${base}/api/folder/left-off?ws=dev&rel=gamma`, { method: 'DELETE', headers: { origin: base } });
  assert.equal(noToken.status, 401);
  const unknown = await forget('ws=nope&rel=gamma');
  assert.deepEqual([unknown.status, ((await unknown.json()) as any).code], [404, 'workspace_not_found']);
  const outside = await forget('ws=dev&rel=../../etc');
  assert.deepEqual([outside.status, ((await outside.json()) as any).code], [400, 'folder_invalid']);
  assert.deepEqual(await snapshot(), before, 'refused: nothing removed');

  const done = await forget('ws=dev&rel=gamma');
  assert.equal(done.status, 204);
  assert.equal(await done.text(), '');
  assert.equal(await exists(gammaRecord.path), false, 'gamma\'s record is gone');
  const { [gammaRecord.path.slice(leftOffDir().length + 1)]: _gone, ...rest } = before;
  assert.deepEqual(await snapshot(), rest, 'every other record unchanged');
  assert.equal((await forget('ws=dev&rel=gamma')).status, 204, 'again: 204, nothing to remove');
  assert.equal((await folderView('gamma')).status, 503, 'the view reloads to what Engram says: here, down and no record, as before');
  assert.equal(await plainView('gamma'), undefined, 'plain mode shows no record either');
});

test('forgetting a folder\'s sleeping Claude Code agent removes its record', async () => {
  const epsilon = await open('epsilon');
  await fire(epsilon.id, 'UserPromptSubmit', { session_id: S3, prompt: 'last task' });
  await fire(epsilon.id, 'Stop', { session_id: S3, last_assistant_message: 'All done.' });
  const { path } = await waitFor(async () => {
    const found = await recordOf('epsilon');
    return found?.record.lastMessage ? found : undefined;
  });
  // A finished agent sleeps across a restart.
  await stop();
  await start();
  const sleeper = await waitFor(async () => {
    const { agents } = (await (await api('GET', '/api/terminals/sleeping')).json()) as { agents: Array<{ id: string; rel: string; agent: string | null }> };
    return agents.find((agent) => agent.rel === 'epsilon');
  });
  assert.equal(sleeper.agent, 'claude-code');
  const before = await snapshot();
  assert.equal((await api('DELETE', `/api/terminals/sleeping/${sleeper.id}`)).status, 204);
  assert.equal(await exists(path), false, 'its record is gone');
  const { [path.slice(leftOffDir().length + 1)]: _gone, ...rest } = before;
  assert.deepEqual(await snapshot(), rest, 'every other record unchanged');
  assert.equal((await api('DELETE', `/api/terminals/sleeping/${sleeper.id}`)).status, 404, 'PRESERVE: forgetting it again is 404 as before');
});

test('removing a workspace removes its left-off folder and nothing else; its summary keeps the Engram-down 503 without records', async () => {
  const added = await api('POST', '/api/workspaces', { root: join(scratch, 'other'), name: 'other' });
  assert.equal(added.status, 201);
  const { id } = (await added.json()) as { id: string };
  const none = await api('GET', `/api/overview?ws=${id}`);
  assert.equal(none.status, 503, 'Engram down and no record in the workspace: unchanged');
  await mkdir(join(leftOffDir(), id), { recursive: true, mode: 0o700 });
  await writeFile(join(leftOffDir(), id, 'planted.claude-code.json'), '{}', { mode: 0o600 });
  const dev = Object.fromEntries(Object.entries(await snapshot()).filter(([name]) => name.startsWith('dev/')));
  assert.equal((await api('DELETE', `/api/workspaces/${id}`)).status, 204);
  assert.equal(await exists(join(leftOffDir(), id)), false, 'its folder is gone');
  assert.deepEqual(await snapshot(), dev, 'the other workspace\'s records unchanged');
  assert.equal((await api('DELETE', `/api/workspaces/${id}`)).status, 404, 'PRESERVE: an unknown workspace is 404 as before');
});

test('expired records are removed at start, by the default 30 days and by leftOffDays', async () => {
  await stop();
  const day = 24 * 3_600_000;
  const planted = (rel: string, ageDays: number) => ({ v: 1, agent: 'claude-code', workspaceId: 'dev', rel, sessionId: S1, at: new Date(Date.now() - ageDays * day).toISOString(), lastUserMessage: null, lastMessage: { text: `from ${rel}`, at: new Date(Date.now() - ageDays * day).toISOString() }, compactSummary: null });
  await writeFile(join(leftOffDir(), 'dev', 'expired.claude-code.json'), JSON.stringify(planted('old', 31)), { mode: 0o600 });
  await writeFile(join(leftOffDir(), 'dev', 'recent.claude-code.json'), JSON.stringify(planted('recent', 2)), { mode: 0o600 });
  await start();
  await waitFor(async () => (!(await exists(join(leftOffDir(), 'dev', 'expired.claude-code.json'))) ? true : undefined));
  assert.equal(await exists(join(leftOffDir(), 'dev', 'recent.claude-code.json')), true, 'younger than 30 days: kept');
  assert.ok(await recordOf('alpha'), 'the fresh record stays');
  await stop();
  await start({ leftOffDays: 1 });
  await waitFor(async () => (!(await exists(join(leftOffDir(), 'dev', 'recent.claude-code.json'))) ? true : undefined));
  assert.ok(await recordOf('alpha'), 'minutes old: kept with leftOffDays 1');
  assert.doesNotMatch(output, /leftOffDays/, 'a valid value logs nothing');
  await stop();
  await start({ leftOffDays: 'forever' });
  assert.match(output, /leftOffDays must be a whole number of days from 1 to 3650; the default \(30\) applies/);
});

test('leftOff false: the hooks forward nothing and the server stores nothing', async () => {
  await stop();
  await start({ leftOff: false });
  const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.match(settings.hooks.Stop[0].hooks[0].command, /bin\/claude-hook' '--no-left-off'$/);
  const before = await snapshot();
  const delta = await open('delta');
  const stateOf = async (id: string) => ((await (await api('GET', '/api/terminals')).json()) as Array<{ id: string; agentState?: string }>).find((t) => t.id === id)?.agentState;
  await fire(delta.id, 'UserPromptSubmit', { prompt: 'keep this to yourself' });
  // The attention report still goes: the agent is working.
  await waitFor(async () => ((await stateOf(delta.id)) === 'working' ? true : undefined));
  // A raw left-off line, then a finished report on the same connection: once the finished state shows,
  // the line before it was read (a disabled store refuses at once and queues no write).
  const finished = JSON.stringify({ v: 1, cmd: 'report-metadata', pane: delta.id, source: 'mirador:attention', seq: Date.now() + 1, ttlMs: null, tokens: { finished: 'probe' }, clear: ['blocked', 'prompt'] });
  await sendLines([leftOffLine({ pane: delta.id, text: 'nor this' }), finished]);
  await waitFor(async () => ((await stateOf(delta.id)) === 'finished' ? true : undefined));
  assert.deepEqual(await snapshot(), before, 'nothing written');
  assert.equal((await folderView('alpha')).status, 503, 'no record is read either: Engram down answers 503 as before');
});
