// The session path an agent reports is the only agent-supplied value that reaches a shell
// command line. These tests pin the validation and the quoting through the real rcfile eval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validSessionFile } from '../src/terminals/open-agents.ts';
import { shellQuote } from '../src/terminals/registry.ts';

const RC = `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\nif [ -n "$MIRADOR_AGENT_COMMAND" ]; then\n  __mirador_cmd="$MIRADOR_AGENT_COMMAND"\n  unset MIRADOR_AGENT_COMMAND\n  eval "$__mirador_cmd"\nfi\n`;

test('a session path with shell syntax reaches the agent as one argument through the rcfile eval', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'open-agents-shell-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const weird = d + "/it's `x` $(touch pwned); echo \\ .jsonl";
  writeFileSync(weird, '{}\n');
  mkdirSync(join(d, 'bin'));
  writeFileSync(join(d, 'bin', 'gentle-shell'), '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$OUT"\n', { mode: 0o755 });
  writeFileSync(join(d, 'rc'), RC);
  const cmd = ['gentle-shell', ...['-e', '/opt/b.ts', '--session', weird].map(shellQuote)].join(' ');
  execFileSync('bash', ['--rcfile', join(d, 'rc'), '-i'], {
    cwd: d,
    input: '',
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { PATH: `${join(d, 'bin')}:/usr/bin:/bin`, HOME: join(d, 'nohome'), MIRADOR_AGENT_COMMAND: cmd, OUT: join(d, 'argv') },
  });
  assert.deepEqual(readFileSync(join(d, 'argv'), 'utf8').split('\n').slice(0, -1), ['-e', '/opt/b.ts', '--session', weird]);
  assert.equal(existsSync(join(d, 'pwned')), false);
});

test('validSessionFile rejects every shape that is not an absolute existing .jsonl regular file', async (t) => {
  const d = mkdtempSync(join(tmpdir(), 'open-agents-valid-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const real = join(d, 'real.jsonl');
  writeFileSync(real, '{}\n');
  mkdirSync(join(d, 'dir.jsonl'));
  symlinkSync(real, join(d, 'link.jsonl'));
  assert.equal(await validSessionFile(real), real);
  const bad = ['real.jsonl', '--session', '-/x.jsonl', join(d, 'link.jsonl'), join(d, 'dir.jsonl'), `${real}\n`, `${real} `, `${real}\0`, join(d, '\x01real.jsonl'), join(d, 'a\tb.jsonl'), join(d, 'REAL.JSONL'), join(d, 'real.json'), join(d, 'nope.jsonl'), '/' + 'a'.repeat(4100) + '.jsonl', 42, [real], { file: real }, null, ''];
  for (const value of bad) assert.equal(await validSessionFile(value as string), null, JSON.stringify(value).slice(0, 60));
});
