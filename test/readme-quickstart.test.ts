// The README's Quickstart against the app and the installer it describes (the stranger test, L33): it says
// which language the interface starts in and where to switch it, with the labels the app shows; the
// interface text it quotes is Spanish with the English beside it, as is the panel the rest of the README
// names; and the Requirements give the build tools' install commands that install.sh prints
// (test/install-script.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The public/ modules have no type declarations; a URL import keeps them typed here.
const { MESSAGES, pickLanguage }: { MESSAGES: Record<string, Record<string, string>>; pickLanguage: (saved: unknown, browser: unknown) => string } = await import(new URL('../public/i18n.js', import.meta.url).href);
const { LANGUAGE_CHOICES }: { LANGUAGE_CHOICES: { value: string; text: string }[] } = await import(new URL('../public/settings-model.js', import.meta.url).href);

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const start = README.indexOf('\n## Quickstart\n');
const QUICKSTART = README.slice(start, README.indexOf('\n## ', start + 1));
const both = (key: string) => `${MESSAGES.es[key]} / ${MESSAGES.en[key]}`;

test('the Quickstart says the interface follows the browser\'s language until one is chosen, and names where to choose it', () => {
  assert.ok(start >= 0, 'README has a Quickstart');
  // What the sentence claims is what the app does with no saved choice.
  for (const tag of ['es', 'es-CL', 'es-419']) assert.equal(pickLanguage(null, { languages: [tag] }), 'es', tag);
  for (const tag of ['en-US', 'pt-BR', '']) assert.equal(pickLanguage(null, { languages: [tag] }), 'en', tag);
  const sentence =
    "The interface follows the browser's language (Spanish for `es-*`, English otherwise) until you choose one in " +
    `**${both('settings.label')}** (the sliders button at the top right) → **${both('settings.language')}**, with ` +
    `${LANGUAGE_CHOICES.map((choice) => `**${choice.text}**`).join(' or ')}; interface text in this README is quoted as Spanish / English.`;
  assert.ok(QUICKSTART.includes(sentence), sentence);
  assert.ok(!QUICKSTART.includes('starts in Spanish'), 'no fixed starting language');
});

test('the interface text the Quickstart quotes is the Spanish, with the English beside it', () => {
  const quoted = (key: string, end: string) => [MESSAGES.es[key], MESSAGES.en[key]].map((text: string) => text.slice(0, text.indexOf(end))).join(' / ');
  for (const text of [quoted('error.workspace_root_missing', '.'), quoted('resources.limits.macos', ':')]) assert.ok(QUICKSTART.includes(`*${text}*`), text);
  assert.ok(QUICKSTART.includes(`**${both('resources.pane')}**`));
  assert.ok(!QUICKSTART.includes('say *Limits are not available on macOS*'), 'the English alone is not quoted');
});

test('the README names the "where it left off" panel as Spanish / English, the way the Quickstart says it quotes the interface', () => {
  const panel = `**${both('overview.leftOff')}**`;
  const capability = README.split('\n').find((line) => line.startsWith('| [Where it left off](docs/attention.md#where-it-left-off) |'));
  assert.ok(capability?.includes(panel), capability);
  const howItWorks = README.split('\n').find((line) => line.startsWith('One local server, started by `mirador`'));
  assert.ok(howItWorks?.includes(panel), howItWorks);
});

test('the Requirements give the commands install.sh prints for python3, make and a C++ compiler', () => {
  for (const command of ['sudo apt install python3 make g++', 'sudo dnf install python3 make gcc-c++', 'sudo pacman -S python make gcc', 'xcode-select --install']) {
    assert.ok(QUICKSTART.includes(`\`${command}\``), command);
  }
});
