// The credits name every agent logo the ▾ menu shows, with
// its source and licence, and say the trademarks belong to their owners (credits-model.js
// CREDITS_LOGOS, public/i18n/credits.js). Only the still credits list them; the crawl stays the artboard's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CREDITS_LOGOS } from '../public/features/credits-model.js';
import { AGENT_LOGOS } from '../public/icons/agents.js';
import { MESSAGES } from '../public/i18n.js';

const creditsJs = readFileSync('public/features/credits.js', 'utf8');
const en = (MESSAGES as any).en as Record<string, string>;
const es = (MESSAGES as any).es as Record<string, string>;
const simpleIcons = (slug: string) => `https://github.com/simple-icons/simple-icons/blob/16.37.0/icons/${slug}.svg`;

test('each sourced logo has a credits entry: its agent, Simple Icons source and CC0 licence', () => {
  assert.deepEqual(CREDITS_LOGOS, [
    { id: 'claude-code', name: 'Claude Code', source: simpleIcons('claudecode'), licence: 'CC0 1.0' },
    { id: 'opencode', name: 'OpenCode', source: simpleIcons('opencode'), licence: 'CC0 1.0' },
    { id: 'gemini-cli', name: 'Google Gemini', source: simpleIcons('googlegemini'), licence: 'CC0 1.0' },
    { id: 'kimi', name: 'Kimi', source: simpleIcons('kimi'), licence: 'CC0 1.0' },
  ]);
  assert.deepEqual(CREDITS_LOGOS.map((logo: any) => logo.id), Object.keys(AGENT_LOGOS), 'no logo shows uncredited');
});

test('the copy: a heading, each source with its licence, and the trademarks note, in en and es', () => {
  assert.equal(en['credits.logos.heading'], 'Agent logos');
  assert.equal(es['credits.logos.heading'], 'Logos de los agentes');
  assert.equal(en['credits.logos.source'], 'Simple Icons, {licence}');
  assert.equal(es['credits.logos.source'], 'Simple Icons, {licence}');
  assert.equal(en['credits.logos.note'], 'The trademarks belong to their owners; each logo only shows which agent opens.');
  assert.equal(es['credits.logos.note'], 'Las marcas pertenecen a sus dueños; cada logo solo indica qué agente se abre.');
});

test('the still credits list the logos after the thanks; the crawl leaves them out', () => {
  assert.match(creditsJs, /^import \{ agentIcon \} from '\/icons\/agents\.js';$/m);
  assert.match(creditsJs, /import \{ CREDITS_CONTACTS, CREDITS_LOGOS, CREDITS_SEEN_PREF,/);
  const block = creditsJs.slice(creditsJs.indexOf("section('thanks'"), creditsJs.indexOf("el('p', { class: 'credits-foot' }"));
  assert.match(block, /\.\.\.\(ids\n\s*\? \[\n\s*section\(\n\s*'logos',\n\s*t\('credits\.logos\.heading'\),/);
  assert.match(block, /\]\n\s*: \[\]\),/);
  assert.match(block, /el\('ul', \{ class: 'credits-logos' \}, CREDITS_LOGOS\.map\(logoLine\)\),\n\s*el\('p', \{ class: 'credits-logos-note' \}, t\('credits\.logos\.note'\)\),/);
  const line = creditsJs.slice(creditsJs.indexOf('function logoLine('), creditsJs.indexOf('\n}\n', creditsJs.indexOf('function logoLine(')));
  assert.match(line, /agentIcon\(logo\.id\)/);
  assert.match(line, /el\('b', \{\}, logo\.name\)/);
  assert.match(line, /el\('a', \{ href: logo\.source, target: '_blank', rel: 'noopener' \}, t\('credits\.logos\.source', \{ licence: logo\.licence \}\)\)/);
});
