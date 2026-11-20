// The web UI bundled in memory: public/'s ~80 ES modules and 17
// stylesheets become one JS and one CSS file, so a first load makes ~6 requests instead of ~118
// (each one costs ~2 s through the Windows-to-WSL2 localhost bridge). Nothing is written to disk.
// Each build is minified, kept as identity, gzip and
// brotli bytes, and named by its content hash (/bundle/app.<hash>.js), cached for a year; `/` is
// never cached, so the next page load after an edit names the new hash.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { BuildContext, Plugin } from 'esbuild';
import { IMMUTABLE, NO_CACHE, pickEncoding, type ContentEncoding } from './respond.ts';

/** The fixed URLs, beside the hashed ones: always the current build, revalidated on every use. */
export const BUNDLE_JS = '/bundle/app.js';
export const BUNDLE_CSS = '/bundle/app.css';

/** Brotli at build time: ~45 ms for the ~780 kB JS (quality 11 takes ~1.5 s, so it follows in the background). */
export const BROTLI_BUILD_QUALITY = 9;
export const BROTLI_BEST_QUALITY = 11;

export type BundleFile = { body: Buffer; type: string; encoding: ContentEncoding | null; cacheControl: string };

export interface WebBundle {
  /** Checks public/ and rebuilds when a file changed; never throws (a failure is logged once). */
  refresh(): Promise<void>;
  /**
   * The bundled answer for `/`, the hashed bundle URLs and the fixed ones, in the encoding
   * `acceptEncoding` takes best; null: serve the file from disk as before (an old hash is a 404).
   */
  serve(pathname: string, acceptEncoding?: string): Promise<BundleFile | null>;
  dispose(): Promise<void>;
}

type Asset = { type: string; identity: Buffer; gzip: Buffer; br: Buffer };
type Built = { html: Asset; js: Asset; css: Asset; jsUrl: string; cssUrl: string };

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

// zlib's async calls run on libuv's thread pool, off the event loop.
function brotli(bytes: Buffer, quality: number): Promise<Buffer> {
  return brotliAsync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
}

async function asset(type: string, text: string): Promise<Asset> {
  const identity = Buffer.from(text, 'utf8');
  const [gz, br] = await Promise.all([gzipAsync(identity), brotli(identity, BROTLI_BUILD_QUALITY)]);
  return { type, identity, gzip: gz, br };
}

const contentHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

type Options = {
  publicDir: string;
  appDir: string;
  /** The /vendor/* URLs the server maps to node_modules files (relative to appDir). */
  vendor: Record<string, string>;
  log: (message: string) => void;
};

type Page = { html: string; entry: string; sheets: string[] };

const STYLESHEET = /^([ \t]*)<link rel="stylesheet" href="([^"]+)">\r?\n/gm;
const MODULE = /<script type="module" src="([^"]+)"><\/script>/g;

/**
 * index.html with its stylesheet links folded into one, where the first was, and its one module
 * script pointing at the JS bundle. The classic boot scripts and everything else stay as written.
 */
export function bundledPage(source: string, urls: { js: string; css: string } = { js: BUNDLE_JS, css: BUNDLE_CSS }): Page {
  const modules = [...source.matchAll(MODULE)];
  if (modules.length !== 1) throw new Error(`index.html has ${modules.length} module scripts; the bundle needs exactly one`);
  const sheets: string[] = [];
  const html = source
    .replace(STYLESHEET, (_line, indent: string, href: string) => {
      sheets.push(href);
      return sheets.length === 1 ? `${indent}<link rel="stylesheet" href="${urls.css}">\n` : '';
    })
    .replace(MODULE, `<script type="module" src="${urls.js}"></script>`);
  return { html, entry: modules[0][1], sheets };
}

/** Every file under public/ with its mtime and size: a different string means something changed. */
async function signature(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
  const stats = await Promise.all(files.map((file) => stat(file)));
  return files.map((file, i) => `${relative(dir, file)}:${stats[i].mtimeMs}:${stats[i].size}`).join('\n');
}

export function createWebBundle({ publicDir, appDir, vendor, log }: Options): WebBundle {
  let built: Built | null = null;
  let seen: string | null = null;
  let pending: Promise<void> | null = null;
  let upgrading: Promise<void> | null = null;
  // Set by dispose(); a quality-11 pass still on the zlib pool is discarded, never awaited.
  let disposed = false;
  let context: { entry: string; ctx: BuildContext } | null = null;
  let sheets: string[] = [];

  // The browser's absolute URLs (/core.js, /vendor/xterm.mjs) as the files the server answers them with.
  const plugin: Plugin = {
    name: 'mirador-public',
    setup(build) {
      build.onResolve({ filter: /^mirador:styles$/ }, () => ({ path: 'styles', namespace: 'mirador-styles' }));
      build.onLoad({ filter: /.*/, namespace: 'mirador-styles' }, () => ({
        contents: sheets.map((href) => `@import ${JSON.stringify(href)};`).join('\n'),
        loader: 'css',
        resolveDir: publicDir,
      }));
      build.onResolve({ filter: /^\// }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (args.kind === 'url-token') return { path: args.path, external: true };
        const url = args.path.replace(/[?#].*$/, '');
        if (vendor[url]) return { path: join(appDir, vendor[url]) };
        const file = normalize(join(publicDir, url));
        if (!file.startsWith(publicDir + sep)) return { errors: [{ text: `${args.path} is outside public/` }] };
        return { path: file };
      });
    },
  };

  async function build(): Promise<Built> {
    const source = await readFile(join(publicDir, 'index.html'), 'utf8');
    const page = bundledPage(source);
    sheets = page.sheets;
    if (context?.entry !== page.entry) {
      await context?.ctx.dispose();
      context = null;
      const esbuild = await import('esbuild');
      const ctx = await esbuild.context({
        entryPoints: [
          { in: join(publicDir, page.entry), out: 'app' },
          { in: 'mirador:styles', out: 'app' },
        ],
        absWorkingDir: appDir,
        bundle: true,
        format: 'esm',
        minify: true,
        charset: 'utf8',
        write: false,
        outdir: join(appDir, '.bundle'),
        logLevel: 'silent',
        plugins: [plugin],
      });
      context = { entry: page.entry, ctx };
    }
    const result = await context.ctx.rebuild();
    const out = (ext: string) => result.outputFiles?.find((file) => file.path.endsWith(ext))?.text ?? '';
    const [js, css] = await Promise.all([asset('text/javascript; charset=utf-8', out('.js')), asset('text/css; charset=utf-8', out('.css'))]);
    const jsUrl = `/bundle/app.${contentHash(js.identity)}.js`;
    const cssUrl = `/bundle/app.${contentHash(css.identity)}.css`;
    const html = await asset('text/html; charset=utf-8', bundledPage(source, { js: jsUrl, css: cssUrl }).html);
    return { html, js, css, jsUrl, cssUrl };
  }

  /** Recompresses the current build's brotli copies at the best quality, one build at a time. */
  function upgrade(): void {
    if (disposed) return;
    upgrading ??= (async () => {
      let target: Built | null = null;
      while (!disposed && built && target !== built) {
        const current: Built = built;
        target = current;
        await Promise.all(
          [current.html, current.js, current.css].map(async (file) => {
            const br = await brotli(file.identity, BROTLI_BEST_QUALITY);
            if (!disposed) file.br = br;
          }),
        );
      }
    })()
      .catch(() => undefined) // the build-time copy stays
      .finally(() => (upgrading = null));
  }

  async function check(): Promise<void> {
    const now = await signature(publicDir).catch(() => '');
    if (now === seen) return;
    seen = now;
    const started = performance.now();
    try {
      built = await build();
      log(`mirador: bundled public/ in ${Math.round(performance.now() - started)} ms`);
      upgrade();
    } catch (error) {
      built = null;
      log(`mirador: bundling public/ failed; serving its files unbundled until the next change: ${(error as Error)?.message ?? error}`);
    }
  }

  const bundle: WebBundle = {
    refresh() {
      pending ??= check().finally(() => (pending = null));
      return pending;
    },
    async serve(pathname, acceptEncoding) {
      const fixed = pathname === '/' || pathname === BUNDLE_JS || pathname === BUNDLE_CSS;
      if (!fixed && !pathname.startsWith('/bundle/')) return null;
      // `/` and the fixed URLs look for edits; a hashed URL answers the build whose page named it.
      if (fixed || !built) await bundle.refresh();
      if (!built) return null;
      const [file, cacheControl] =
        pathname === '/' ? [built.html, NO_CACHE]
        : pathname === BUNDLE_JS ? [built.js, NO_CACHE]
        : pathname === BUNDLE_CSS ? [built.css, NO_CACHE]
        : pathname === built.jsUrl ? [built.js, IMMUTABLE]
        : pathname === built.cssUrl ? [built.css, IMMUTABLE]
        : [null, ''];
      if (!file) return null;
      const encoding = pickEncoding(acceptEncoding);
      return { body: encoding ? file[encoding] : file.identity, type: file.type, encoding, cacheControl };
    },
    async dispose() {
      // The background upgrade is not awaited: shutting down never waits ~2 s for brotli quality 11.
      disposed = true;
      await pending;
      await context?.ctx.dispose();
      context = null;
    },
  };
  return bundle;
}
