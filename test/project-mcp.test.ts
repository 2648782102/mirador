// Per-project MCP servers: what a project folder's
// agents start, read from gentle-shell's agent dir and <folder>/.pi/mcp.json, and saving a choice as
// bare `enabled: false` overrides only. Temp folders stand in for the agent dir and the projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpFileError, MCP_MEMORY_MB, readProjectMcp, saveProjectMcp } from '../src/mcp/project-mcp.ts';

const USER_SERVERS = {
  azure: { command: 'npx', args: ['-y', '@azure/mcp@3'], env: { AZURE_TOKEN_CREDENTIALS: 'AzureCliCredential' } },
  codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
  context7: { command: 'npx', args: ['-y', 'context7-mcp'], description: 'Library docs' },
  engram: { command: 'node', args: ['-e', '0'], enabled: false },
  markitdown: { command: 'uvx', args: ['markitdown-mcp'] },
  bicep: { command: 'dnx', args: ['-y', 'Azure.Bicep.McpServer'] },
};

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString();

/** A fake agent dir and a projects root in a fresh temp dir; removed by the caller's `done`. */
async function setup(options: { trust?: Record<string, boolean | null>; settings?: unknown } = {}) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'mirador-mcp-')));
  const agentDir = join(scratch, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: USER_SERVERS }, null, 2));
  if (options.trust) await writeFile(join(agentDir, 'trust.json'), JSON.stringify(options.trust));
  if (options.settings) await writeFile(join(agentDir, 'settings.json'), JSON.stringify(options.settings));
  const project = join(scratch, 'projects', 'app');
  await mkdir(project, { recursive: true });
  return { scratch, agentDir, project, done: () => rm(scratch, { recursive: true, force: true }) };
}

async function writeProjectFile(project: string, value: unknown, raw?: string) {
  await mkdir(join(project, '.pi'), { recursive: true });
  await writeFile(join(project, '.pi', 'mcp.json'), raw ?? JSON.stringify(value, null, 2) + '\n');
}

const projectFile = async (project: string) => JSON.parse(await readFile(join(project, '.pi', 'mcp.json'), 'utf8'));

/** Every file under `dir` with its bytes, to prove a folder was left untouched. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[join(entry.parentPath, entry.name)] = await readFile(join(entry.parentPath, entry.name), 'utf8');
  }
  return files;
}

test('lists the user servers then the project-declared ones, with source, project overrides, description and estimated memory', async () => {
  const { agentDir, project, done } = await setup();
  try {
    await writeProjectFile(project, {
      mcpServers: {
        context7: { enabled: false },
        supabase: { command: 'npx', args: ['-y', '@supabase/mcp-server'], description: 'Project database' },
      },
    });
    const view = await readProjectMcp({ folder: project, agentDir });
    assert.equal(view.exists, true);
    assert.equal(view.userConfig, 'ok');
    assert.deepEqual(
      view.servers.map((s) => [s.name, s.source, s.enabled, s.locked, s.description, s.estimatedMb]),
      [
        ['azure', 'user', true, false, null, 230],
        ['codegraph', 'user', true, false, null, 180],
        ['context7', 'user', false, false, 'Library docs', 110],
        // Off for every project in the user file: Mirador cannot turn it on with `enabled: false` alone.
        ['engram', 'user', false, true, null, null],
        ['markitdown', 'user', true, false, null, 180],
        ['bicep', 'user', true, false, null, 85],
        ['supabase', 'project', true, false, 'Project database', null],
      ],
    );
    assert.deepEqual(MCP_MEMORY_MB, { markitdown: 180, azure: 230, codegraph: 180, context7: 110, bicep: 85 });
  } finally {
    await done();
  }
});

test('a folder without .pi/mcp.json lists the user servers, all on but the ones the user file turns off', async () => {
  const { agentDir, project, done } = await setup();
  try {
    const view = await readProjectMcp({ folder: project, agentDir });
    assert.equal(view.exists, false);
    assert.deepEqual(view.servers.filter((s) => !s.enabled).map((s) => s.name), ['engram']);
  } finally {
    await done();
  }
});

test('a missing or broken user mcp.json is reported and lists no user servers', async () => {
  const { agentDir, project, done } = await setup();
  try {
    await writeFile(join(agentDir, 'mcp.json'), '{ nope');
    assert.equal((await readProjectMcp({ folder: project, agentDir })).userConfig, 'invalid');
    await rm(join(agentDir, 'mcp.json'));
    const view = await readProjectMcp({ folder: project, agentDir });
    assert.equal(view.userConfig, 'missing');
    assert.deepEqual(view.servers, []);
  } finally {
    await done();
  }
});

test('turning one server off writes only its bare override and keeps every other key and server as it was', async () => {
  const { agentDir, project, done } = await setup();
  try {
    const before = {
      autoEnableCodemode: false,
      mcpServers: {
        supabase: { command: 'npx', args: ['-y', '@supabase/mcp-server'], env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_TOKEN}' } },
        azure: { exposure: 'direct' },
      },
      other: { nested: [1, 2, 3] },
    };
    await writeProjectFile(project, before);
    const agentBefore = await snapshot(agentDir);
    const result = await saveProjectMcp({ folder: project, agentDir, disabled: ['context7', 'azure'] });
    assert.equal(result.saved.written, true);
    const after = await projectFile(project);
    assert.deepEqual(after, {
      autoEnableCodemode: false,
      mcpServers: {
        supabase: before.mcpServers.supabase,
        azure: { exposure: 'direct', enabled: false },
        context7: { enabled: false },
      },
      other: { nested: [1, 2, 3] },
    });
    // Order of the existing keys is kept; new overrides go last.
    assert.deepEqual(Object.keys(after), ['autoEnableCodemode', 'mcpServers', 'other']);
    assert.deepEqual(Object.keys(after.mcpServers), ['supabase', 'azure', 'context7']);
    assert.deepEqual(result.servers.filter((s) => !s.enabled).map((s) => s.name), ['azure', 'context7', 'engram']);
    assert.deepEqual(await snapshot(agentDir), agentBefore, 'nothing under the agent dir changes');
  } finally {
    await done();
  }
});

test('turning a server back on removes its bare override and the file stays valid JSON', async () => {
  const { agentDir, project, done } = await setup();
  try {
    await saveProjectMcp({ folder: project, agentDir, disabled: ['context7'] });
    assert.deepEqual(await projectFile(project), { mcpServers: { context7: { enabled: false } } });
    const raw = await readFile(join(project, '.pi', 'mcp.json'), 'utf8');
    assert.match(raw, /^\{\n {2}"mcpServers"/, 'written as 2-space JSON');
    await saveProjectMcp({ folder: project, agentDir, disabled: [] });
    assert.deepEqual(await projectFile(project), { mcpServers: {} });
    // An override with more than `enabled` keeps the rest.
    await writeProjectFile(project, { mcpServers: { azure: { enabled: false, exposure: 'direct' } } });
    await saveProjectMcp({ folder: project, agentDir, disabled: [] });
    assert.deepEqual(await projectFile(project), { mcpServers: { azure: { exposure: 'direct' } } });
  } finally {
    await done();
  }
});

test('a project-declared server keeps all its fields when turned off and on again', async () => {
  const { agentDir, project, done } = await setup();
  try {
    const supabase = { command: 'npx', args: ['-y', '@supabase/mcp-server'], env: { TOKEN: '${T}' }, description: 'DB' };
    await writeProjectFile(project, { mcpServers: { supabase } });
    await saveProjectMcp({ folder: project, agentDir, disabled: ['supabase'] });
    assert.deepEqual(await projectFile(project), { mcpServers: { supabase: { ...supabase, enabled: false } } });
    const view = await readProjectMcp({ folder: project, agentDir });
    assert.deepEqual(view.servers.find((s) => s.name === 'supabase'), { name: 'supabase', source: 'project', enabled: false, locked: false, description: 'DB', estimatedMb: null });
    await saveProjectMcp({ folder: project, agentDir, disabled: [] });
    assert.deepEqual(await projectFile(project), { mcpServers: { supabase } });
  } finally {
    await done();
  }
});

test('a save that changes nothing does not create .pi/mcp.json', async () => {
  const { agentDir, project, done } = await setup();
  try {
    // engram is off in the user file already: listing it as off changes nothing.
    const result = await saveProjectMcp({ folder: project, agentDir, disabled: ['engram'] });
    assert.equal(result.saved.written, false);
    await assert.rejects(lstat(join(project, '.pi')), { code: 'ENOENT' });
  } finally {
    await done();
  }
});

test('an existing .pi/mcp.json that is not valid JSON, or not an object of servers, is refused and left untouched', async () => {
  const { agentDir, project, done } = await setup();
  try {
    for (const raw of ['{ "mcpServers": { "a": 1, }', '[]', '{ "mcpServers": [] }']) {
      await writeProjectFile(project, null, raw);
      await assert.rejects(readProjectMcp({ folder: project, agentDir }), (error) => error instanceof McpFileError && error.code === 'mcp_unreadable');
      await assert.rejects(saveProjectMcp({ folder: project, agentDir, disabled: ['azure'] }), (error) => error instanceof McpFileError && error.code === 'mcp_unreadable');
      assert.equal(await readFile(join(project, '.pi', 'mcp.json'), 'utf8'), raw);
      assert.deepEqual(await readdir(join(project, '.pi')), ['mcp.json'], 'no temp file is left');
    }
  } finally {
    await done();
  }
});

test('a symlinked .pi/mcp.json is refused and its target is not written', async () => {
  const { scratch, agentDir, project, done } = await setup();
  try {
    const target = join(scratch, 'elsewhere.json');
    await writeFile(target, '{"mcpServers":{}}');
    await mkdir(join(project, '.pi'));
    await symlink(target, join(project, '.pi', 'mcp.json'));
    await assert.rejects(saveProjectMcp({ folder: project, agentDir, disabled: ['azure'] }), (error) => error instanceof McpFileError && error.code === 'mcp_not_regular');
    assert.equal(await readFile(target, 'utf8'), '{"mcpServers":{}}');
  } finally {
    await done();
  }
});

test('names that are not listed servers are refused and nothing is written', async () => {
  const { agentDir, project, done } = await setup();
  try {
    await assert.rejects(saveProjectMcp({ folder: project, agentDir, disabled: ['nope'] }), (error) => error instanceof McpFileError && error.code === 'mcp_invalid');
    await assert.rejects(lstat(join(project, '.pi')), { code: 'ENOENT' });
  } finally {
    await done();
  }
});

test('in a repo where the file is untracked and not ignored, the save excludes it in .git/info/exclude once', async () => {
  const { agentDir, project, done } = await setup();
  try {
    git(project, 'init', '-q');
    const exclude = join(project, '.git', 'info', 'exclude');
    await writeFile(exclude, '# mine\n*.log');
    assert.equal((await readProjectMcp({ folder: project, agentDir })).git, 'untracked');
    const first = await saveProjectMcp({ folder: project, agentDir, disabled: ['azure'] });
    assert.equal(first.saved.excluded, true);
    assert.equal(first.git, 'ignored');
    await saveProjectMcp({ folder: project, agentDir, disabled: ['azure', 'bicep'] });
    assert.equal(await readFile(exclude, 'utf8'), '# mine\n*.log\n/.pi/mcp.json\n');
    assert.equal(git(project, 'status', '--porcelain'), '');
  } finally {
    await done();
  }
});

test('a project folder below the repo root is excluded by its path from the root', async () => {
  const { scratch, agentDir, done } = await setup();
  try {
    const repo = join(scratch, 'mono');
    const sub = join(repo, 'apps', 'web');
    await mkdir(sub, { recursive: true });
    git(repo, 'init', '-q');
    await saveProjectMcp({ folder: sub, agentDir, disabled: ['azure'] });
    assert.match(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8'), /\n\/apps\/web\/\.pi\/mcp\.json\n$/);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await done();
  }
});

test('a tracked file is not excluded, and the save says the change will show in git', async () => {
  const { agentDir, project, done } = await setup();
  try {
    git(project, 'init', '-q');
    await writeProjectFile(project, { mcpServers: {} });
    git(project, 'add', '.pi/mcp.json');
    const exclude = join(project, '.git', 'info', 'exclude');
    const excludeBefore = await readFile(exclude, 'utf8');
    const result = await saveProjectMcp({ folder: project, agentDir, disabled: ['azure'] });
    assert.equal(result.git, 'tracked');
    assert.equal(result.saved.excluded, false);
    assert.equal(await readFile(exclude, 'utf8'), excludeBefore);
  } finally {
    await done();
  }
});

test('a folder that is no git repo reports none and the save writes only .pi/mcp.json', async () => {
  const { scratch, agentDir, project, done } = await setup();
  try {
    const before = await snapshot(scratch);
    const result = await saveProjectMcp({ folder: project, agentDir, disabled: ['azure'] });
    assert.equal(result.git, 'none');
    assert.equal(result.saved.excluded, false);
    const after = await snapshot(scratch);
    const changed = Object.keys(after).filter((file) => after[file] !== before[file]);
    assert.deepEqual(changed, [join(project, '.pi', 'mcp.json')]);
  } finally {
    await done();
  }
});

test('trust comes from the nearest saved decision in trust.json, then defaultProjectTrust, else unknown', async () => {
  const check = async (options: Parameters<typeof setup>[0] & { trustFor?: (project: string, scratch: string) => Record<string, boolean | null> }, expected: string) => {
    const env = await setup({ settings: options.settings });
    try {
      if (options.trustFor) await writeFile(join(env.agentDir, 'trust.json'), JSON.stringify(options.trustFor(env.project, env.scratch)));
      assert.equal((await readProjectMcp({ folder: env.project, agentDir: env.agentDir })).trust, expected, JSON.stringify(options.settings ?? null));
    } finally {
      await env.done();
    }
  };
  await check({}, 'unknown');
  await check({ trustFor: (_project, scratch) => ({ [scratch]: true }) }, 'trusted');
  await check({ trustFor: (project, scratch) => ({ [scratch]: true, [project]: false }) }, 'untrusted');
  // null is no decision: the parent's applies.
  await check({ trustFor: (project, scratch) => ({ [scratch]: true, [project]: null }) }, 'trusted');
  await check({ settings: { defaultProjectTrust: 'always' } }, 'trusted');
  await check({ settings: { defaultProjectTrust: 'never' } }, 'untrusted');
  await check({ settings: { defaultProjectTrust: 'ask' } }, 'unknown');
});
