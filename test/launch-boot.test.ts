// public/launch-boot.js redeems the one-time launch link as the page opens, before app.js and its
// module graph load, so a slow load (WSL2, a VM) no longer outlives the launch nonce (60 s,
// LAUNCH_NONCE_TTL_MS in src/http/security.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const BOOT = readFileSync('public/launch-boot.js', 'utf8');

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

/** Runs the boot script in a page with `hash`, a fetch answering `answer`, and records what it did. */
function boot(hash: string, answer: () => Promise<unknown>) {
  const calls: Call[] = [];
  const replaced: unknown[][] = [];
  const window: Record<string, unknown> = {};
  runInNewContext(BOOT, {
    window,
    location: { hash },
    history: { replaceState: (...args: unknown[]) => replaced.push(args) },
    URLSearchParams,
    JSON,
    fetch: (url: string, init: Call['init']) => {
      calls.push({ url, init });
      return answer();
    },
  });
  return { calls, replaced, launch: window.miradorLaunch as Promise<string | null> | undefined };
}

const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

test('a launch link is redeemed at once, before app.js loads, and dropped from the address bar', async () => {
  const page = boot('#launch=abc_DEF-123', ok({ token: 'tok' }));
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, '/api/session');
  assert.equal(page.calls[0].init.method, 'POST');
  assert.equal(page.calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(page.calls[0].init.body), { nonce: 'abc_DEF-123' });
  assert.deepEqual(page.replaced, [[null, '', '/']]);
  assert.equal(await page.launch, 'tok');
});

test('a refused, malformed or failed redemption resolves to no token', async () => {
  assert.equal(await boot('#launch=used', async () => ({ ok: false, json: async () => ({ error: 'x' }) })).launch, null);
  assert.equal(await boot('#launch=odd', ok({ token: 42 })).launch, null);
  assert.equal(await boot('#launch=down', async () => { throw new TypeError('network'); }).launch, null);
});

test('without a launch link the boot script does nothing', () => {
  for (const hash of ['', '#', '#other=1']) {
    const page = boot(hash, ok({ token: 'tok' }));
    assert.deepEqual([page.calls, page.replaced, page.launch], [[], [], undefined], hash);
  }
});

test('index.html loads launch-boot.js first in <head>, and signIn takes its token', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const loads = [...head.matchAll(/<(?:script|link)\b[^>]*>/g)].map((tag) => tag[0]);
  assert.equal(loads[0], '<script src="/launch-boot.js">');

  const core = readFileSync('public/core.js', 'utf8');
  const signIn = core.slice(core.indexOf('export async function signIn'), core.indexOf('\n}\n', core.indexOf('export async function signIn')));
  assert.match(signIn, /await window\.miradorLaunch;/);
  assert.doesNotMatch(signIn, /location\.hash|\/api\/session/);
});
