// The "Servidores MCP" dialog without the clutter: the notes and
// "Aplica a…" fold into one closed "Cómo funciona", and each server's description opens on demand
// from a keyboard-reachable toggle (public/features/mcp.js, public/styles/mcp.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mcpJs = readFileSync('public/features/mcp.js', 'utf8');
const mcpCss = readFileSync('public/styles/mcp.css', 'utf8');

test('the notes and "Aplica a…" live in one closed "Cómo funciona"; the warnings stay outside it', () => {
  assert.match(mcpJs, /const how = el\('details', \{ class: 'mcp-how' \}, el\('summary', \{\}, caret\(\), t\('mcp\.howItWorks'\)\), howBody\);/);
  assert.match(mcpJs, /body: \[el\('p', \{\}, t\('mcp\.intro'\)\), list, saving, warnings, how, status\],/);
  assert.doesNotMatch(mcpJs, /class: 'mcp-applies'/);
  assert.doesNotMatch(mcpJs, /\bopen: true|\.open = /);
  assert.match(mcpJs, /const keys = noteKeys\(view\);/);
  assert.match(mcpJs, /warnings\.replaceChildren\(\.\.\.keys\.warnings\.map/);
  assert.match(mcpJs, /howBody\.replaceChildren\(\.\.\.keys\.howItWorks\.map/);
  // The file the git note names keeps its <code>.
  assert.match(mcpJs, /el\('code', \{\}, view\.file\)/);
});

test('a server description opens on demand: hidden, with a button that says what it shows and its state', () => {
  assert.match(mcpJs, /el\('p', \{ class: 'hint mcp-server-description', id: `\$\{id\}-about`, hidden: true \}, server\.description\)/);
  assert.match(mcpJs, /el\('button', \{ type: 'button', class: 'btn icon-btn mcp-server-more', 'aria-expanded': 'false', 'aria-controls': `\$\{id\}-about`, 'aria-label': describe, title: describe \}/);
  assert.match(mcpJs, /about\.hidden = !about\.hidden;\n\s*more\.setAttribute\('aria-expanded', String\(!about\.hidden\)\);/);
  // The name still shows it on hover.
  assert.match(mcpJs, /el\('label', \{ for: id, class: 'mcp-server-name', title: server\.description \?\? undefined \}, server\.name\)/);
  assert.doesNotMatch(mcpJs, /server\.description \? el\('span'/);
});

test('the new carets turn only when the system allows motion', () => {
  const motion = mcpCss.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/);
  assert.ok(motion, 'a no-preference block');
  assert.match(motion[1], /\.mcp-how > summary \.mcp-caret, \.mcp-server-more \.icon \{ transition: transform 0\.15s ease; \}/);
  assert.equal(mcpCss.split(/transition: transform/).length - 1, 1);
  assert.match(mcpCss, /\.mcp-how\[open\] > summary \.mcp-caret \{ transform: rotate\(90deg\); \}/);
  assert.match(mcpCss, /\.mcp-server-more\[aria-expanded="true"\] \.icon \{ transform: rotate\(180deg\); \}/);
  assert.match(mcpCss, /\.mcp-server-description\[hidden\] \{ display: none; \}/);
});
