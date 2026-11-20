// The other offered agents live in a ▾ right after a row's
// agent button, a split button whose menu shares the "Más" menu's code (popupMenu: role menu, arrow
// keys, Home and End, Escape back to its button). With one offered agent there is no ▾ and the row
// is the row of before; "Más" no longer lists agents.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../public/i18n.js';

const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');
const terminalsJs = readFileSync('public/terminals.js', 'utf8');
const workspacesCss = readFileSync('public/styles/workspaces.css', 'utf8');
const en = (MESSAGES as any).en as Record<string, string>;
const es = (MESSAGES as any).es as Record<string, string>;

/** The source of `function name(…) { … }`, up to the next top-level closing brace. */
function fn(source: string, name: string): string {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

/** The declarations of the first rule whose selector starts its line and is exactly `selector`. */
function own(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body !== undefined, `rule ${selector} is missing`);
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

test('the agent button keeps its line; the ▾ comes right after it, before bash, and only while other agents are offered', () => {
  const buttons = fn(workspacesJs, 'terminalButtons');
  assert.match(buttons, /el\('button', \{ class: 'btn gs-btn', title: t\('tree\.startAgent', \{ path \}\), 'data-launch-block': 'agent', onclick: \(e\) => \{ e\.stopPropagation\(\); openTerminal\(folder, 'agent'\); \} \}, roseIcon\(\), el\('span', \{ class: 'tool-label' \}, agentLabel\(state\.config\)\)\),\n\s*agentCombo\(folder, path\),\n\s*el\('button', \{ class: 'btn', title: t\('tree\.openShell'/);
  // One offered agent: agentChoices() is empty (test/agent-picker-model.test.ts), so no ▾ at all.
  assert.match(fn(workspacesJs, 'agentCombo'), /^function agentCombo\(folder, path\) \{\n  if \(!pickerAgents\(\)\.length\) return null;\n/);
});

test('the ▾ is a menu button named "Elegir otro agente", blocked like the agent button while agents open', () => {
  const combo = fn(workspacesJs, 'agentCombo');
  assert.match(combo, /el\('div', \{ class: 'ws-more-menu agent-menu', id: `agent-menu-\$\{\+\+fieldId\}`, role: 'menu', 'aria-label': t\('tree\.chooseAgent'\), hidden: true \}\)/);
  assert.match(combo, /el\('button', \{ type: 'button', class: 'btn agent-pick', title: t\('tree\.chooseAgent'\), 'aria-label': t\('tree\.chooseAgent'\), 'data-launch-block': 'agent', onclick: \(e\) => \{ e\.stopPropagation\(\); toggle\(\); \} \}, icon\('chev-down'\)\)/);
  const popup = fn(workspacesJs, 'popupMenu');
  assert.match(popup, /button\.setAttribute\('aria-haspopup', 'menu'\);\n\s*button\.setAttribute\('aria-expanded', 'false'\);\n\s*button\.setAttribute\('aria-controls', menu\.id\);/);
  assert.match(popup, /menu\.hidden = false;\n\s*button\.setAttribute\('aria-expanded', 'true'\);/);
  assert.match(popup, /menu\.hidden = true;\n\s*button\.setAttribute\('aria-expanded', 'false'\);/);
  assert.equal(en['tree.chooseAgent'], 'Choose another agent');
  assert.equal(es['tree.chooseAgent'], 'Elegir otro agente');
});

test('the ▾ and "Más" share one menu: the same roles, keys and Escape back to their button', () => {
  const popup = fn(workspacesJs, 'popupMenu');
  assert.match(popup, /items\.forEach\(\(item\) => \{ if \(!item\.hasAttribute\('role'\)\) item\.setAttribute\('role', 'menuitem'\); item\.tabIndex = -1; \}\);/);
  assert.match(popup, /const next = menuFocusIndex\(e\.key, items\.indexOf\(document\.activeElement\), items\.length\);/);
  assert.match(popup, /else if \(closesMenu\(\{ type: 'keydown', key: e\.key \}\)\) \{\n[^\n]*\n\s*if \(e\.key === 'Escape'\) e\.preventDefault\(\);\n\s*close\(true\);/);
  assert.match(popup, /if \(closesMenu\(\{ type: 'pointerdown', inside: wrap\.contains\(e\.target\) \}\)\) close\(false\);/);
  assert.match(popup, /if \(refocus\) button\.focus\(\);/);
  assert.match(fn(workspacesJs, 'moreMenu'), /const toggle = popupMenu\(wrap, button, menu, \(close\) => \[/);
  assert.match(fn(workspacesJs, 'agentCombo'), /const toggle = popupMenu\(wrap, button, menu, \(close\) => \{/);
  // The funnel's menu and popupMenu; no third copy of the keys.
  assert.equal(workspacesJs.match(/menuFocusIndex\(e\.key/g)?.length, 2);
});

test('each choice opens its agent by id only, shown with its icon and label, out of the Tab order', () => {
  const combo = fn(workspacesJs, 'agentCombo');
  assert.match(combo, /return pickerAgents\(\)\.map\(\(agent\) => el\(\n\s*'button',\n\s*\{ type: 'button', class: 'ws-more-item', title: t\('tree\.startWithTitle', \{ agent: agent\.label, path \}\), 'data-agent': agent\.id, 'data-launch-block': 'agent', onclick: \(e\) => \{ e\.stopPropagation\(\); close\(true\); openTerminal\(folder, 'agent', agent\.id\); \} \},\n\s*agentIcon\(agent\.id\),\n\s*el\('span', \{ class: 'tool-label' \}, agent\.label\),\n\s*\)\);/);
  // The next opening lists the agents offered then.
  assert.match(combo, /loadAgents\(\);/);
  assert.match(workspacesJs, /^import \{ agentIcon \} from '\/icons\/agents\.js';$/m);
  assert.match(fn(terminalsJs, 'openTerminal'), /api\('POST', '\/api\/terminals', terminalBody\(folder, kind, newTerminalSize\(\), agent\)\)/);
});

test('"Más" lists no agents and shows only when an action left the row, as before T2 (L10)', () => {
  assert.doesNotMatch(workspacesJs, /agentItems/);
  assert.doesNotMatch(fn(workspacesJs, 'moreMenu'), /pickerAgents|loadAgents/);
  assert.match(fn(workspacesJs, 'fitRow'), /\n  const alwaysMore = more\.dataset\.always === 'true';\n/);
  for (const messages of [en, es]) assert.equal('tree.startWith' in messages, false, 'the "Iniciar <agente>" item is gone');
});

test('fitting a row: the ▾ goes with the agent button, never into "Más" on its own', () => {
  const fit = fn(workspacesJs, 'fitRow');
  assert.match(fit, /const combo = actions\.querySelector\(':scope > \.agent-combo'\);\n\s*const buttons = \[\.\.\.actions\.children\]\.filter\(\(node\) => node !== more && node !== combo\);/);
  assert.match(fit, /const widthOf = \(node\) => width\(node\) \+ \(combo && node === combo\.previousElementSibling \? gap \+ width\(combo\) : 0\);/);
  assert.match(fit, /widths: buttons\.map\(widthOf\)/);
  assert.match(fit, /if \(combo\) combo\.hidden = combo\.previousElementSibling\.hidden;/);
  assert.match(fn(workspacesJs, 'moreMenu'), /node !== wrap && node\.hidden && !node\.matches\('\.agent-combo'\)/);
});

test('rows drawn before the offered agents are known gain the ▾ once they are', () => {
  assert.match(fn(workspacesJs, 'init'), /\n  loadAgents\(\)\.then\(addAgentCombos\);\n/);
  const add = fn(workspacesJs, 'addAgentCombos');
  assert.match(add, /if \(pickerAgents\(\)\.length\) \{/);
  assert.match(add, /if \(agent\.nextElementSibling\?\.matches\('\.agent-combo'\)\) continue;/);
  assert.match(add, /agent\.after\(agentCombo\(\{ ws: row\.dataset\.ws, rel: row\.dataset\.rel \}, row\.querySelector\(':scope > \.name'\)\?\.title \?\? ''\)\);/);
  assert.match(add, /actionStops\(row, row\.matches\(':focus-within'\)\);/);
  assert.match(add, /fitShownRows\(\);/);
});

test('the ▾ is glued to the agent button, its menu opens under the actions\' right end, and it adds no motion', () => {
  assert.deepEqual(own(workspacesCss, '.agent-combo'), { display: 'flex' });
  // Like "Más", the menu opens at the right end of the row's actions: anchored at their left end it
  // passed the tree's right edge, and opening it scrolled the tree sideways, hiding the folder names.
  assert.doesNotMatch(workspacesCss, /\.agent-menu\s*\{/);
  assert.equal(own(workspacesCss, '.row-actions .btn.agent-pick').width, '18px');
  for (const rule of [...workspacesCss.matchAll(/([^{}]*agent-(?:combo|pick|menu)[^{]*)\{([^}]*)\}/g)]) {
    assert.doesNotMatch(rule[2], /transition|animation|transform/, rule[1].trim());
  }
});
