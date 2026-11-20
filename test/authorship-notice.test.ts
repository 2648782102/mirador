// The copyright holder is the author as a person,
// not ZURAI SpA. NOTICE and LICENSE carry the copyright line, NOTICE keeps the ZURAI name and logo
// out of the licence, package.json names the author, and the README links NOTICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
// The name is spelled only in the allowed places, so it is read from the app credits
// (`credits.by.name`, once per language); every other place below must agree with it.
const CREDITED = [...read('public/i18n/credits.js').matchAll(/^\s*'credits\.by\.name': '([^']+)',$/gm)].map((m) => m[1]);
const AUTHOR = CREDITED[0] ?? '';
const COPYRIGHT = `Copyright 2026 ${AUTHOR}`;

test('S4: NOTICE and LICENSE say "Copyright 2026 <author>", the name the app credits', () => {
  assert.deepEqual(CREDITED, [AUTHOR, AUTHOR], 'one name, in English and in Spanish');
  assert.match(AUTHOR, /^\S+ \S+$/u, 'a first name and a surname');
  assert.ok(read('NOTICE').split('\n').includes(COPYRIGHT), 'NOTICE');
  // The appendix line of the Apache licence, filled in with its indentation; the placeholder is gone.
  assert.ok(read('LICENSE').split('\n').includes(`   ${COPYRIGHT}`), 'LICENSE');
  assert.doesNotMatch(read('LICENSE'), /\[yyyy\]|\[name of copyright owner\]/);
});

test('S4: NOTICE keeps the ZURAI name and logo out of the Apache licence', () => {
  const notice = read('NOTICE');
  assert.match(notice, /^Licensed under the Apache License, Version 2\.0 \(see LICENSE\)\.$/m);
  assert.match(notice, /^The ZURAI name and logo \(public\/brand\/\) are trademarks of ZURAI SpA\.$/m);
  assert.match(notice, /^They are not licensed under the Apache License, Version 2\.0\.$/m);
});

test('V7 (L33): NOTICE lists the third-party material and says the agents\' logos only identify them', () => {
  const lines = read('NOTICE').split('\n');
  const at = lines.indexOf('Third-party material');
  assert.ok(at > 0, 'a "Third-party material" section');
  const section = lines.slice(at + 1).join('\n');
  assert.match(section, /^- Simple Icons \(https:\/\/simpleicons\.org\), CC0 1\.0: the path data of the Claude Code, OpenCode, Google Gemini and Kimi logos in public\/icons\/agents\.js\.$/m);
  assert.match(section, /^- xterm\.js and its fit and web-links addons \(https:\/\/github\.com\/xtermjs\/xterm\.js\), MIT: the terminal, installed from npm and served from node_modules\.$/m);
  assert.match(section, /^The agents' logos are trademarks of their owners and are used only to identify each agent\.$/m);
  // Every logo AGENT_LOGOS carries (its Simple Icons title) is named in the Simple Icons line.
  const titles = [...read('public/icons/agents.js').matchAll(/^  [\w'-]+: \{ title: '([^']+)', slug:/gm)].map((m) => m[1]);
  assert.deepEqual(titles, ['Claude Code', 'OpenCode', 'Google Gemini', 'Kimi']);
  for (const title of titles) assert.ok(section.includes(title), title);
});

test('T25 (L36.4): NOTICE lists the Gentleman Sexy palette and carries its MIT licence as in gentle-shell\'s LICENSE', () => {
  const notice = read('NOTICE');
  const lines = notice.split('\n');
  const at = lines.indexOf('Third-party material');
  assert.ok(at > 0, 'a "Third-party material" section');
  const section = lines.slice(at + 1).join('\n');
  assert.match(section, /^- Gentleman Sexy palette \(https:\/\/github\.com\/Gentleman-Programming\/gentle-shell\), MIT: the colours of the Gentleman theme in public\/styles\.css, taken from themes\/Gentleman-Sexy\.json in the gentle-pi package\.$/m);
  // The LICENSE of that repository, byte for byte, after its heading, closing NOTICE.
  const licence = [
    'Gentleman Sexy palette licence:',
    '',
    'MIT License',
    '',
    'Copyright (c) 2025 Mario Zechner',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
  ].join('\n');
  assert.ok(notice.endsWith(`each agent.\n\n${licence}\n`), 'the licence block closes NOTICE, after the trademark sentence');
  assert.ok(lines.includes('Copyright (c) 2025 Mario Zechner'), 'the copyright line');
});

test('S4: package.json names the credited author, and no field names ZURAI as author or owner', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.author, `${AUTHOR} (https://github.com/mata-2p)`);
  for (const field of ['author', 'contributors', 'maintainers', 'publisher', 'owner', 'copyright']) {
    assert.doesNotMatch(JSON.stringify(pkg[field] ?? ''), /zurai/i, field);
  }
});

test('S4: the README has the author section and links NOTICE from the licence section', () => {
  const readme = read('README.md');
  const section = (heading: string) => readme.split(/^## /m).find((part) => part.startsWith(`${heading}\n`)) ?? '';
  assert.equal(
    section('Author').trim(),
    [
      'Author',
      '',
      `Mirador is created by ${AUTHOR} ([@mata-2p](https://github.com/mata-2p)), founder of [ZURAI](https://zurai.cl).`,
      'Need custom software or consulting? Get in touch with ZURAI at [zurai.cl](https://zurai.cl).',
    ].join('\n'),
  );
  assert.ok(readme.indexOf('## Author\n') > -1 && readme.indexOf('## Author\n') < readme.indexOf('## License\n'), 'Author comes before License');
  assert.match(section('License'), /\[NOTICE\]\(NOTICE\)/);
});
