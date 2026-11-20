// Stopping Mirador does
// not wait for the background quality-11 brotli upgrade; dispose() discards it, and the upgrade that
// finishes later neither rejects unhandled nor swaps its bytes into the disposed bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants } from 'node:zlib';
import { BROTLI_BEST_QUALITY, BROTLI_BUILD_QUALITY, createWebBundle } from '../src/http/bundle.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// The /vendor/* map of src/server.ts (not exported there).
const VENDOR: Record<string, string> = {
  '/vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
};

const brotliParams = (bytes: Buffer, quality: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });

test('S27: dispose() does not wait for the pending quality-11 upgrade and discards its result', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const logs: string[] = [];
    const bundle = createWebBundle({ publicDir: join(APP_DIR, 'public'), appDir: APP_DIR, vendor: VENDOR, log: (m) => logs.push(m) });
    const fixed = await bundle.serve('/bundle/app.js'); // builds, then starts the background upgrade
    assert.ok(fixed, logs.join('\n'));
    const page = await bundle.serve('/');
    const jsUrl = page?.body.toString('utf8').match(/\/bundle\/app\.[0-9a-f]{12}\.js/)?.[0];
    assert.ok(jsUrl);
    const identity = fixed.body;
    const before = await bundle.serve(jsUrl, 'br');
    assert.ok(before);
    // The upgrade is still pending: the served copy is the build-time one, not quality 11.
    assert.ok(before.body.equals(brotliCompressSync(identity, brotliParams(identity, BROTLI_BUILD_QUALITY))), 'the build-time brotli copy');

    const started = performance.now();
    await bundle.dispose();
    const disposeMs = performance.now() - started;

    // The same quality-11 work the bundle started, timed here: the bundle's own run is done by now.
    const upgradeStarted = performance.now();
    const best = await promisify(brotliCompress)(identity, brotliParams(identity, BROTLI_BEST_QUALITY));
    const upgradeMs = performance.now() - upgradeStarted;
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(disposeMs < 400, `dispose took ${Math.round(disposeMs)} ms; one quality-11 pass takes ${Math.round(upgradeMs)} ms`);
    const after = await bundle.serve(jsUrl, 'br');
    assert.ok(after);
    assert.ok(after.body.equals(before.body), 'the late upgrade did not swap its bytes in');
    assert.ok(!after.body.equals(best), 'the quality-11 copy was discarded');
    assert.deepEqual(rejections, [], 'no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});
