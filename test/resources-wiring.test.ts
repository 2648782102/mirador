// Wiring of the resource figures (docs/resources.md):
// the server serves GET /api/resources, and every terminal tab and pane carries the
// data-terminal-id that public/features/resources.js decorates (never guessed from order or title).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('R3: the server registers the resource routes', () => {
  const server = source('src/server.ts');
  assert.match(server, /import \{ resourceRoutes \} from '\.\/http\/routes\/resources\.ts';/);
  assert.match(server, /^\s*resourceRoutes,$/m);
});

test('R3: each terminal tab and pane carries data-terminal-id', () => {
  const terminals = source('public/terminals.js');
  assert.match(terminals, /\{ class: 'tab', 'data-terminal-id': info\.id,/);
  assert.match(terminals, /\{ class: 'pane', 'data-terminal-id': info\.id,/);
});
