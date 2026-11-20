// "Delegar a Sereno" without the clutter: the static hint folds into
// a closed "Cómo funciona", the autopilot hint shows only while its box is checked, and the count,
// the error and the warning stay under the field (public/features/workspaces.js, workspaces.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate } from '../public/i18n.js';

const workspacesJs = readFileSync('public/features/workspaces.js', 'utf8');
const section = workspacesJs.slice(workspacesJs.indexOf('export async function delegate('), workspacesJs.indexOf('\nfunction render()'));
const css = readFileSync('public/styles/workspaces.css', 'utf8');

test('the first-message hint lives in a closed "Cómo funciona" at the end, still describing the field', () => {
  assert.match(section, /el\('details', \{ class: 'delegate-how' \}, el\('summary', \{\}, caret, t\('delegate\.howItWorks'\)\), el\('p', \{ class: 'hint', id: `\$\{id\}-hint` \}, t\('delegate\.hint'\)\)\),\n    \],/);
  assert.doesNotMatch(section, /\bopen: true|\.open = /);
  assert.match(section, /'aria-describedby': `\$\{id\}-proposal \$\{id\}-hint \$\{id\}-count \$\{id\}-error \$\{id\}-warn`/);
  assert.equal(translate('es', 'delegate.howItWorks'), 'Cómo funciona');
  assert.equal(translate('en', 'delegate.howItWorks'), 'How it works');
});

test('the count, the error and the warning stay under the field, with the proposal bar above it', () => {
  assert.match(section, /el\('div', \{ class: 'field' \}, el\('label', \{ for: id \}, t\('delegate\.label'\)\), el\('div', \{ class: 'proposal-bar' \}, proposal, showsExtra\(state\.config, 'improve'\) \? improve\.node : null\), input, count, error, warning\),/);
});

test('the autopilot hint shows only while its box is checked', () => {
  assert.match(section, /const autoHint = el\('p', \{ class: 'hint', id: `\$\{id\}-auto-hint`, hidden: !autopilot\.checked \}, t\('delegate\.autopilotHint'\)\);/);
  assert.match(section, /autopilot\.addEventListener\('change', \(\) => \{ autoHint\.hidden = !autopilot\.checked; \}\);/);
  assert.match(section, /el\('div', \{ class: 'delegate-auto' \}, autopilot, el\('label', \{ for: `\$\{id\}-auto` \}, t\('delegate\.autopilot'\)\), autoHint\),/);
  assert.match(css, /\.delegate-auto \.hint\[hidden\] \{ display: none; \}/);
});

test('the "Cómo funciona" caret turns only when the system allows motion', () => {
  assert.match(css, /\.delegate-how\[open\] > summary \.delegate-caret \{ transform: rotate\(90deg\); \}/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\n  \.delegate-caret \{ transition: transform 0\.15s ease; \}\n\}/);
  assert.equal(css.split('.delegate-caret { transition').length - 1, 1);
});
