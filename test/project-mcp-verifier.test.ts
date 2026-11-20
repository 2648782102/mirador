// Verifier probes ("sin tocar lo que ya haya",
// local git exclude; nothing under the agent dir). Direct use of src/mcp/project-mcp.ts over
// temp git repos; the server route is covered by test/mcp-api.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpFileError, readProjectMcp, saveProjectMcp } from '../src/mcp/project-mcp.ts';

let scratch: string;
let agentDir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString();
const hashDir = async (dir: string) => {
  const names = (await readdir(dir)).sort();
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update(await readFile(join(dir, name)));
  return hash.digest('hex');
};
const parse = (raw: string) => JSON.parse(raw.replace(/^\uFEFF/, ''));
const repo = async (name: string) => {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'a'), 'a\n');
  git(dir, 'add', 'a');
  git(dir, 'commit', '-qm', 'i');
  return dir;
};

before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mcp-verifier-')));
  agentDir = join(scratch, 'agent');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { context7: { command: 'npx' }, azure: { command: 'npx' }, bicep: { command: 'b' }, engram: { command: 'e', enabled: false } } }));
  await writeFile(join(agentDir, 'trust.json'), JSON.stringify({ [scratch]: true, [join(scratch, 'untrusted')]: false, [join(scratch, 'untrusted', 'child')]: true, [join(scratch, 'nulls')]: null }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }));
});
after(() => rm(scratch, { recursive: true, force: true }));

test('S3: a save keeps every other key, declared fields, BOM, tabs and the missing final newline; turning on restores the parse', async () => {
  const folder = await repo('fmt');
  await mkdir(join(folder, '.pi'));
  const original =
    '\uFEFF{\n\t"$schema": "x",\n\t"mcpServers": {\n\t\t"supabase": {"url": "https://s", "headers": {"A": "b"}, "env": {"K": "v"}},\n\t\t"azure": {"exposure": "all"},\n\t\t"zzz": {"enabled": false}\n\t},\n\t"extra": [1, {"x": [3]}]\n}';
  await writeFile(join(folder, '.pi', 'mcp.json'), original);
  const agentBefore = await hashDir(agentDir);
  const saved = await saveProjectMcp({ folder, agentDir, disabled: ['azure', 'bicep', 'supabase'] });
  assert.deepEqual(saved.saved, { written: true, excluded: true });
  const raw = await readFile(join(folder, '.pi', 'mcp.json'), 'utf8');
  assert.ok(raw.startsWith('\uFEFF{\n\t"$schema"'), 'BOM and tab indent kept');
  assert.ok(!raw.endsWith('\n'), 'no final newline added');
  const expected = parse(original);
  expected.mcpServers.supabase.enabled = false;
  expected.mcpServers.azure.enabled = false;
  expected.mcpServers.bicep = { enabled: false };
  assert.deepEqual(parse(raw), expected);
  assert.deepEqual(Object.keys(parse(raw).mcpServers), ['supabase', 'azure', 'zzz', 'bicep']);
  await saveProjectMcp({ folder, agentDir, disabled: [] });
  assert.deepEqual(parse(await readFile(join(folder, '.pi', 'mcp.json'), 'utf8')), parse(original));
  assert.equal(await hashDir(agentDir), agentBefore, 'S4: the agent dir is never written');
  const exclude = await readFile(join(folder, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.pi/mcp.json').length, 1);
});

test('S3: a file that is not a JSON object of servers is refused byte for byte (empty, array, mcpServers not an object)', async () => {
  for (const [name, content] of [['empty', ''], ['array', '[{"mcpServers":{}}]\n'], ['notobj', '{"mcpServers":[1]}\n']] as const) {
    const folder = join(scratch, 'bad-' + name);
    await mkdir(join(folder, '.pi'), { recursive: true });
    await writeFile(join(folder, '.pi', 'mcp.json'), content);
    await assert.rejects(saveProjectMcp({ folder, agentDir, disabled: ['azure'] }), (e: McpFileError) => e.code === 'mcp_unreadable');
    assert.equal(await readFile(join(folder, '.pi', 'mcp.json'), 'utf8'), content);
    assert.deepEqual(await readdir(join(folder, '.pi')), ['mcp.json'], 'no temp file left');
  }
});

test('S3: a .pi symlink or a mcp.json symlink is refused and its target untouched', async () => {
  const elsewhere = join(scratch, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'target.json'), '{"mcpServers":{}}\n');
  const a = join(scratch, 'sym-pi');
  await mkdir(a);
  await symlink(elsewhere, join(a, '.pi'));
  const b = join(scratch, 'sym-file');
  await mkdir(join(b, '.pi'), { recursive: true });
  await symlink(join(elsewhere, 'target.json'), join(b, '.pi', 'mcp.json'));
  for (const folder of [a, b]) {
    await assert.rejects(readProjectMcp({ folder, agentDir }), (e: McpFileError) => e.code === 'mcp_not_regular');
    await assert.rejects(saveProjectMcp({ folder, agentDir, disabled: ['azure'] }), (e: McpFileError) => e.code === 'mcp_not_regular');
  }
  assert.deepEqual(await readdir(elsewhere), ['target.json']);
  assert.equal(await readFile(join(elsewhere, 'target.json'), 'utf8'), '{"mcpServers":{}}\n');
});

test('S2/S3 git: exclude appended once with the nested prefix, existing lines without a final newline kept; tracked and ignored files are not excluded; a no-change save writes nothing', async () => {
  const top = await repo('nested-repo');
  await writeFile(join(top, '.git', 'info', 'exclude'), 'keep\nno-newline');
  const nested = join(top, 'sub');
  await mkdir(nested);
  const first = await saveProjectMcp({ folder: nested, agentDir, disabled: ['bicep'] });
  assert.deepEqual(first.saved, { written: true, excluded: true });
  const again = await saveProjectMcp({ folder: nested, agentDir, disabled: ['bicep'] });
  assert.deepEqual(again.saved, { written: false, excluded: false });
  await saveProjectMcp({ folder: nested, agentDir, disabled: ['bicep', 'azure'] });
  assert.equal(await readFile(join(top, '.git', 'info', 'exclude'), 'utf8'), 'keep\nno-newline\n/sub/.pi/mcp.json\n');
  assert.equal(git(top, 'status', '--porcelain').trim(), '');

  const tracked = await repo('tracked');
  await mkdir(join(tracked, '.pi'));
  await writeFile(join(tracked, '.pi', 'mcp.json'), '{"mcpServers":{}}\n');
  git(tracked, 'add', '-A');
  git(tracked, 'commit', '-qm', 't');
  const t = await saveProjectMcp({ folder: tracked, agentDir, disabled: ['azure'] });
  assert.equal(t.git, 'tracked');
  assert.deepEqual(t.saved, { written: true, excluded: false });
  assert.ok(!(await readFile(join(tracked, '.git', 'info', 'exclude'), 'utf8')).includes('mcp.json'));

  const ignored = await repo('ignored');
  await writeFile(join(ignored, '.gitignore'), '.pi/\n');
  const i = await saveProjectMcp({ folder: ignored, agentDir, disabled: ['azure'] });
  assert.equal(i.git, 'ignored');
  assert.deepEqual(i.saved, { written: true, excluded: false });

  const fresh = await repo('fresh');
  const none = await saveProjectMcp({ folder: fresh, agentDir, disabled: [] });
  assert.deepEqual(none.saved, { written: false, excluded: false });
  await assert.rejects(lstat(join(fresh, '.pi')), { code: 'ENOENT' });
});

test('S2/S3 git: a linked worktree gets the line in the common info/exclude git reports', async () => {
  const main = await repo('wt-main');
  const linked = join(scratch, 'wt-linked');
  git(main, 'worktree', 'add', '-q', linked, '-b', 'wt');
  const saved = await saveProjectMcp({ folder: linked, agentDir, disabled: ['azure'] });
  assert.deepEqual(saved.saved, { written: true, excluded: true });
  assert.ok((await readFile(join(main, '.git', 'info', 'exclude'), 'utf8')).endsWith('/.pi/mcp.json\n'));
  assert.equal(git(linked, 'status', '--porcelain').trim(), '');
});

test('S3: two saves of one folder at once end with the later selection only, one exclude line and no temp file', async () => {
  const folder = await repo('concurrent');
  const [a, b] = await Promise.all([
    saveProjectMcp({ folder, agentDir, disabled: ['azure'] }),
    saveProjectMcp({ folder, agentDir, disabled: ['bicep', 'context7'] }),
  ]);
  assert.ok(a.saved.written && b.saved.written);
  assert.deepEqual(parse(await readFile(join(folder, '.pi', 'mcp.json'), 'utf8')), { mcpServers: { bicep: { enabled: false }, context7: { enabled: false } } });
  assert.deepEqual(await readdir(join(folder, '.pi')), ['mcp.json']);
  assert.equal((await readFile(join(folder, '.git', 'info', 'exclude'), 'utf8')).split('/.pi/mcp.json').length, 2);
});

test('S4 trust: nearest true/false wins, null is no decision, then defaultProjectTrust', async () => {
  for (const [rel, trust] of [['plain', 'trusted'], ['untrusted', 'untrusted'], ['untrusted/child', 'trusted'], ['nulls/deep', 'trusted']] as const) {
    const folder = join(scratch, rel);
    await mkdir(folder, { recursive: true });
    assert.equal((await readProjectMcp({ folder, agentDir })).trust, trust, rel);
  }
  const other = join(scratch, 'agent-never');
  await mkdir(other);
  await writeFile(join(other, 'mcp.json'), '{"mcpServers":{}}');
  await writeFile(join(other, 'settings.json'), '{"defaultProjectTrust":"never"}');
  assert.equal((await readProjectMcp({ folder: join(scratch, 'plain'), agentDir: other })).trust, 'untrusted');
  await writeFile(join(other, 'settings.json'), '{}');
  assert.equal((await readProjectMcp({ folder: join(scratch, 'plain'), agentDir: other })).trust, 'unknown');
});
