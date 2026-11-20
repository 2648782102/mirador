// Pure rules of the "Servidores MCP" dialog: the
// estimated saving of a selection, the git and trust notes, and what a save sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitNoteKey, isDirty, memoryLabel, noteKeys, offNames, savePayload, savingEstimate, trustNoteKey } from '../public/features/mcp-model.js';
import { translate } from '../public/i18n.js';

const server = (name: string, estimatedMb: number | null, extra: Record<string, unknown> = {}) => ({
  name,
  source: 'user',
  enabled: true,
  locked: false,
  description: null,
  estimatedMb,
  ...extra,
});

const SERVERS = [
  server('azure', 230),
  server('context7', 110, { enabled: false }),
  server('engram', null, { enabled: false, locked: true }),
  server('markitdown', 180),
  server('supabase', null, { source: 'project' }),
];

test('the selection starts from the servers off in this project; servers off for every project are not part of it', () => {
  assert.deepEqual([...offNames(SERVERS)], ['context7']);
});

test('the saving per agent adds the estimates of the servers turned off and counts the ones without one', () => {
  assert.deepEqual(savingEstimate(SERVERS, new Set(['context7'])), { mb: 110, unknown: 0, count: 1 });
  assert.deepEqual(savingEstimate(SERVERS, new Set(['azure', 'context7', 'supabase', 'engram'])), { mb: 340, unknown: 1, count: 3 });
  assert.deepEqual(savingEstimate(SERVERS, new Set()), { mb: 0, unknown: 0, count: 0 });
  assert.equal(memoryLabel(110), '~110 MB');
  assert.equal(memoryLabel(null), null);
});

test('the save sends the folder and the servers off, in list order, without the ones off for every project', () => {
  assert.deepEqual(savePayload({ ws: 'dev', rel: 'app' }, SERVERS, new Set(['supabase', 'engram', 'azure'])), { ws: 'dev', rel: 'app', disabled: ['azure', 'supabase'] });
  assert.equal(isDirty(SERVERS, new Set(['context7'])), false);
  assert.equal(isDirty(SERVERS, new Set(['context7', 'engram'])), false);
  assert.equal(isDirty(SERVERS, new Set(['context7', 'azure'])), true);
  assert.equal(isDirty(SERVERS, new Set()), true);
});

test('the git note says what happens to the file in each case, in both languages', () => {
  assert.equal(translate('es', gitNoteKey('untracked')), 'Al guardar, Mirador lo excluye de git solo en tu equipo (.git/info/exclude).');
  assert.equal(translate('es', gitNoteKey('ignored')), 'Git ignora este archivo: no ensucia tu repo.');
  assert.equal(translate('es', gitNoteKey('tracked')), 'Este archivo está en git: el cambio se verá en git status y en tus commits.');
  assert.equal(translate('es', gitNoteKey('none')), 'Esta carpeta no es un repositorio git.');
  for (const state of ['untracked', 'ignored', 'tracked', 'none', 'unknown']) {
    const key = gitNoteKey(state);
    for (const language of ['es', 'en']) assert.notEqual(translate(language, key), key, `${language} ${key}`);
  }
  assert.equal(translate('en', gitNoteKey('tracked')), 'This file is in git: the change will show in git status and in your commits.');
});

test('the trust note shows only when pi may not read the project file, with the steps to trust it', () => {
  assert.equal(trustNoteKey('trusted'), null);
  // pi saves a trust decision with /trust (pi-coding-agent docs/security.md).
  const steps = 'pi solo lee .pi/mcp.json en proyectos de confianza: escribe /trust en un agente de este proyecto para confiar en él';
  assert.ok(translate('en', trustNoteKey('untrusted')).includes('type /trust in an agent of this project to trust it'));
  assert.ok(translate('es', trustNoteKey('untrusted')).includes(steps));
  assert.ok(translate('es', trustNoteKey('unknown')).includes(steps));
  assert.notEqual(trustNoteKey('untrusted'), trustNoteKey('unknown'));
  assert.equal(translate('es', 'mcp.applies'), 'Aplica a los agentes que se abran o se despierten después.');
  assert.equal(translate('en', 'mcp.applies'), 'Applies to agents opened or woken from now on.');
});

// The notes and "Aplica a…" fold into "Cómo funciona"; only what may
// stop the save from working (an unreadable server list, a project pi may not trust) stays on screen.
test('the warnings stay on screen and the git note, the estimate and "Aplica a…" fold into "Cómo funciona"', () => {
  assert.deepEqual(noteKeys({ userConfig: 'ok', trust: 'trusted', git: 'tracked' }), {
    warnings: [],
    howItWorks: ['mcp.git.tracked', 'mcp.estimateHint', 'mcp.applies'],
  });
  assert.deepEqual(noteKeys({ userConfig: 'invalid', trust: 'untrusted', git: 'untracked' }), {
    warnings: ['mcp.userConfig.invalid', 'mcp.trust.untrusted'],
    howItWorks: ['mcp.git.untracked', 'mcp.estimateHint', 'mcp.applies'],
  });
  assert.deepEqual(noteKeys({ trust: 'unknown', git: 'weird' }).warnings, ['mcp.trust.unknown']);
  assert.equal(translate('es', 'mcp.howItWorks'), 'Cómo funciona');
  assert.equal(translate('en', 'mcp.howItWorks'), 'How it works');
  assert.equal(translate('es', 'mcp.describe', { name: 'azure' }), 'Ver qué hace azure');
  assert.equal(translate('en', 'mcp.describe', { name: 'azure' }), 'Show what azure does');
});

test('MCP servers are chosen per folder only: workspace rows neither show the action nor list it in "⋯ Más"', async () => {
  const { readFileSync } = await import('node:fs');
  const source = (file: string) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  assert.match(source('features/mcp.js'), /folderOnly: true/);
  const workspaces = source('features/workspaces.js');
  assert.match(workspaces, /!\(compact && action\.folderOnly\)/);
  assert.doesNotMatch(workspaces, /menuActions/);
});
