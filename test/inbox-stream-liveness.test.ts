// The inbox stream's liveness (#66): public/features/inbox.js follow() reads GET /api/inbox/stream,
// where the server writes a `{}` heartbeat every HEARTBEAT_MS (src/http/routes/inbox.ts). The real
// inbox.js and inbox-model.js run in Node on a small DOM stand-in, with a fake fetch (the stream
// the test writes, or a dead tunnel), a fake clock and fake timers (node:test mock.timers).
// '/core.js', '/terminals.js' and '/icons.js' are stand-ins (data: modules). The header's state is
// what inbox.js reports: inboxStream() and the `inbox:stream` event phone.js follows.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const publicDir = new URL('../public/', import.meta.url);
const model = await import(new URL('features/inbox-model.js', publicDir).href);
const routeSource = readFileSync(new URL('../src/http/routes/inbox.ts', import.meta.url), 'utf8');
const HEARTBEAT_MS = Number(/const HEARTBEAT_MS = ([\d_]+);/.exec(routeSource)![1].replaceAll('_', ''));
/** The silence after which the stream counts as dead: two heartbeats plus 10 s (inbox-model.js STREAM_SILENCE_MS). */
const BOUND = 2 * HEARTBEAT_MS + 10_000;
const START = Date.parse('2026-11-23T10:00:00.000Z');

const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS: Record<string, string> = {
  '/core.js': stub(`
    const C = globalThis.__livenessCore;
    export const api = async () => ({});
    export const el = (...a) => C.el(...a);
    export const emit = (name, value) => C.emitted.push([name, value]);
    export const getLanguage = () => 'en';
    export const on = () => {};
    export const prefs = { read: (key, fallback) => fallback, write: () => {} };
    export const session = C.session;
    export const slot = () => C.el('section');
    export const t = (key) => key;
    export const workspaceById = (id) => ({ id, name: id });
  `),
  '/terminals.js': stub(`
    export const activateTerminal = () => {};
    export const activeTerminalId = () => null;
    export const markWaiting = () => {};
    export const terminalList = () => [];
  `),
  '/icons.js': stub('export const icon = () => null;'),
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    if (specifier.startsWith('/') && context.parentURL?.startsWith(publicDir.href)) return { url: new URL(specifier.slice(1), publicDir).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/* ---------- A DOM stand-in: what inbox.js touches ---------- */

class FakeElement {
  children: Array<FakeElement | string> = [];
  attributes = new Map<string, string>();
  className = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  textContent = '';
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  toggleAttribute(name: string, on: boolean) { if (on) this.attributes.set(name, ''); else this.attributes.delete(name); }
  addEventListener() {}
  append(...nodes: Array<FakeElement | string>) { this.children.push(...nodes); }
  replaceChildren(...nodes: Array<FakeElement | string>) { this.children = [...nodes]; }
  after() {}
  contains(node: unknown): boolean { return node === this || this.children.some((c) => typeof c !== 'string' && c.contains(node)); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
}

/** The page: its visibility and the listeners inbox.js adds (visibilitychange). */
class FakeDocument {
  title = 'Mirador';
  visibilityState: 'visible' | 'hidden' = 'visible';
  body = new FakeElement();
  activeElement: FakeElement = this.body;
  listeners = new Map<string, Array<() => unknown>>();
  addEventListener(type: string, fn: () => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  /** The browser hides or shows the tab. */
  show(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    for (const fn of this.listeners.get('visibilitychange') ?? []) fn();
  }
}

const core = {
  el(tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]) {
    const node = new FakeElement();
    for (const [key, value] of Object.entries(attrs)) if (key === 'class') node.className = String(value);
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child as FakeElement | string);
    return node;
  },
  session: { token: 'token' as string | null, expire() {} },
  emitted: [] as Array<[string, unknown]>,
};
Object.assign(globalThis, { __livenessCore: core, CSS: { escape: (s: string) => s } });

/* ---------- The server behind the tunnel ---------- */

const encoder = new TextEncoder();
const SNAPSHOT = `${JSON.stringify({ items: [], nightNotes: [] })}\n`;
type Mode = 'live' | 'dead' | 'refused';
/** One fetch of the stream: when it started, its signal and, once answered, a way to write a line. */
interface Attempt { at: number; signal: AbortSignal | undefined; send: (line: string) => void }
/**
 * More fetches than any test makes is a storm: past this, fetch() never settles, so a loop that
 * retries with no wait parks there and its test fails on the gaps instead of hanging the run.
 */
const MAX_ATTEMPTS = 100;

/**
 * The inbox stream as fetch() sees it. `live`: it answers at once with the snapshot, as the server
 * does, and the test writes more; `dead`: the local end of a dead SSH tunnel, no answer ever, only
 * the abort ends it; `refused`: nothing listens, fetch() fails at once.
 */
function server(initial: Mode) {
  const attempts: Attempt[] = [];
  const state = { mode: initial };
  (globalThis as any).fetch = (_url: string, init: { signal?: AbortSignal } = {}) => {
    const { signal } = init;
    const attempt: Attempt = { at: Date.now(), signal, send: () => assert.fail('this stream never answered') };
    attempts.push(attempt);
    if (attempts.length > MAX_ATTEMPTS) return new Promise(() => {});
    if (state.mode === 'refused') return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise((resolve, reject) => {
      const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
      if (state.mode === 'dead') {
        signal?.addEventListener('abort', () => reject(aborted()));
        return;
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      attempt.send = (line) => controller.enqueue(encoder.encode(line));
      // As a browser does: aborting the fetch errors its body, so a pending read() rejects.
      signal?.addEventListener('abort', () => controller.error(aborted()));
      attempt.send(SNAPSHOT);
      resolve({ status: 200, ok: true, body });
    });
  };
  return {
    attempts,
    state,
    /** The stream being read now. */
    current: () => attempts.at(-1)!,
  };
}

/* ---------- The page and the clock ---------- */

/** Lets the stream's promises (fetch, the decoder pipe, read()) run. */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Time passes with the page running: the fake timers fire, one second at a time. */
async function advance(t: TestContext, ms: number, step = 1000) {
  for (let done = 0; done < ms; done += step) {
    t.mock.timers.tick(Math.min(step, ms - done));
    await settle();
  }
}

/** Time passes with the page frozen (a phone suspends a background tab): the clock moves, no timer runs. */
function freeze(t: TestContext, ms: number) {
  t.mock.timers.setTime(Date.now() + ms);
}

let boots = 0;
/** A fresh page with a fresh inbox.js, a session, the fake clock at START and the server in `mode`. */
async function boot(t: TestContext, mode: Mode = 'live') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const doc = new FakeDocument();
  (globalThis as any).document = doc;
  core.session.token = 'token';
  core.emitted = [];
  const srv = server(mode);
  const inbox = await import(`${new URL('features/inbox.js', publicDir).href}?liveness=${++boots}`);
  await inbox.init();
  await settle();
  // The next boot's page must not be driven by this one's loop.
  t.after(() => { core.session.token = null; });
  return { inbox, srv, doc, states: () => core.emitted.filter(([name]) => name === 'inbox:stream').map(([, value]) => value) };
}

const gaps = (attempts: Attempt[]) => attempts.slice(1).map((attempt, i) => attempt.at - attempts[i].at);

/* ---------- The bound ---------- */

test('the silence bound is tied to the server heartbeat: two heartbeats plus 10 s of slack', () => {
  assert.equal(model.STREAM_HEARTBEAT_MS, HEARTBEAT_MS, 'the page mirrors the server heartbeat');
  assert.equal(model.STREAM_SILENCE_MS, BOUND);
  assert.ok(model.STREAM_SILENCE_MS > 2 * HEARTBEAT_MS, 'one late or lost heartbeat is not a dead stream');
});

/* ---------- 1. No line within the bound ---------- */

test('no line within the bound: the header says Reconnecting, the stream is aborted and a new one opens', async (t) => {
  const { inbox, srv, states } = await boot(t);
  assert.equal(inbox.inboxStream(), 'live');
  assert.equal(srv.attempts.length, 1);
  await advance(t, BOUND - 1000);
  assert.equal(inbox.inboxStream(), 'live', 'still within the bound');
  assert.equal(srv.attempts[0].signal?.aborted ?? false, false);
  assert.equal(srv.attempts.length, 1);
  await advance(t, 1000);
  assert.equal(inbox.inboxStream(), 'reconnecting', 'the bound passed with no line');
  assert.equal(srv.attempts[0].signal?.aborted, true, 'the silent stream is aborted');
  assert.equal(srv.attempts.length, 1, 'the new one waits for the backoff (1 s)');
  await advance(t, 1000);
  assert.equal(srv.attempts.length, 2, 'a new stream opens after the backoff');
  assert.equal(srv.attempts[1].at - srv.attempts[0].at, BOUND + 1000);
  assert.equal(srv.attempts[1].signal?.aborted, false);
  assert.equal(inbox.inboxStream(), 'live', 'and the header is Live again once it answers');
  assert.deepEqual(states(), ['live', 'reconnecting', 'live']);
});

/* ---------- 2. A heartbeat or a data line keeps Live ---------- */

test('a heartbeat or a data line within the bound keeps Live: no abort, no new stream', async (t) => {
  const { inbox, srv, states } = await boot(t);
  for (let i = 0; i < 12; i++) {
    await advance(t, HEARTBEAT_MS);
    srv.current().send(i % 3 === 2 ? SNAPSHOT : '{}\n');
  }
  // A line just inside the bound, twice: each one restarts the count.
  for (let i = 0; i < 2; i++) {
    await advance(t, BOUND - 1000);
    srv.current().send('{}\n');
  }
  assert.equal(inbox.inboxStream(), 'live');
  assert.equal(srv.attempts.length, 1);
  assert.equal(srv.attempts[0].signal?.aborted ?? false, false);
  assert.deepEqual(states(), ['live']);
});

/* ---------- 3. Becoming visible ---------- */

test('visible again after being hidden longer than the bound: the old stream is dropped and a new one opens at once', async (t) => {
  const { inbox, srv, doc, states } = await boot(t);
  doc.show('hidden');
  // Lines keep arriving while hidden, so only the time hidden decides.
  for (let i = 0; i < 3; i++) {
    await advance(t, HEARTBEAT_MS);
    srv.current().send('{}\n');
  }
  assert.equal(srv.attempts.length, 1);
  doc.show('visible');
  await settle();
  assert.equal(srv.attempts[0].signal?.aborted, true, 'the old socket is not trusted');
  assert.equal(srv.attempts.length, 2, 'a new stream opens at once, with no backoff');
  assert.equal(srv.attempts[1].at, srv.attempts[0].at + 3 * HEARTBEAT_MS);
  assert.equal(inbox.inboxStream(), 'live');
  assert.deepEqual(states(), ['live', 'reconnecting', 'live']);
});

test('visible again with no line seen for the bound (timers held while the phone slept): it reconnects at once instead of waiting for a timer', async (t) => {
  const { inbox, srv, doc } = await boot(t, 'dead');
  assert.equal(inbox.inboxStream(), 'reconnecting', 'the dead tunnel never answers');
  freeze(t, BOUND + 1000);
  doc.show('hidden');
  freeze(t, 3000);
  doc.show('visible');
  await settle();
  assert.equal(srv.attempts[0].signal?.aborted, true, 'the attempt that saw nothing is dropped');
  assert.equal(srv.attempts.length, 2, 'a new one opens at once');
  assert.equal(srv.attempts[1].at, START + BOUND + 4000);
  assert.equal(inbox.inboxStream(), 'reconnecting');
});

test('visible again during the backoff wait after a long hide over a dead stream: the wait ends and a new try opens at once', async (t) => {
  const { inbox, srv, doc } = await boot(t, 'dead');
  doc.show('hidden');
  // Five silent tries, each aborted at the bound; the fifth is followed by the 16 s backoff wait.
  await advance(t, 5 * BOUND + 20_000);
  assert.deepEqual(gaps(srv.attempts), [1000, 2000, 4000, 8000].map((delay) => BOUND + delay));
  assert.equal(srv.attempts.length, 5, 'still inside the 16 s wait');
  doc.show('visible');
  await settle();
  assert.equal(srv.attempts.length, 6, 'the pending wait ends and a new try opens at once');
  assert.equal(srv.attempts[5].at, START + 5 * BOUND + 20_000, 'not after the rest of the backoff');
  assert.equal(inbox.inboxStream(), 'reconnecting');
  // The ended wait leaves nothing behind: no second try when its time would have come.
  await advance(t, 11_000);
  assert.equal(srv.attempts.length, 6);
});

test('hidden and visible again during the backoff wait after a short hide: the backoff is not cut', async (t) => {
  const { inbox, srv, doc } = await boot(t, 'refused');
  // Tries at 0, 1, 3, 7 and 15 s; the next waits 16 s, until 31 s.
  await advance(t, 20_000);
  assert.equal(srv.attempts.length, 5);
  doc.show('hidden');
  await advance(t, 3000);
  doc.show('visible');
  await settle();
  assert.equal(srv.attempts.length, 5, 'a short hide does not end the wait');
  await advance(t, 8000);
  assert.equal(srv.attempts.length, 6, 'the try opens when the backoff ends');
  assert.deepEqual(gaps(srv.attempts), [1000, 2000, 4000, 8000, 16000]);
  assert.equal(inbox.inboxStream(), 'reconnecting');
});

/* ---------- 4. No reconnect storm ---------- */

test('hidden on a dead tunnel: each try waits the bound, then the existing backoff; no storm', async (t) => {
  const { srv, doc } = await boot(t, 'dead');
  doc.show('hidden');
  await advance(t, 10 * 60_000);
  assert.deepEqual(gaps(srv.attempts), [1000, 2000, 4000, 8000, 16000, 30000, 30000].map((delay) => BOUND + delay));
  assert.ok(srv.attempts.slice(0, -1).every((attempt) => attempt.signal?.aborted), 'each silent try was aborted');
});

test('hidden with nothing listening: the existing backoff, 1 s doubling up to 30 s, is unchanged', async (t) => {
  const { inbox, srv, doc } = await boot(t, 'refused');
  doc.show('hidden');
  await advance(t, 3 * 60_000);
  assert.deepEqual(gaps(srv.attempts), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  assert.equal(inbox.inboxStream(), 'reconnecting');
});

test('visibility flips on a fresh stream do not reconnect', async (t) => {
  const { inbox, srv, doc, states } = await boot(t);
  for (let i = 0; i < 20; i++) {
    doc.show('hidden');
    await advance(t, 1000);
    doc.show('visible');
    await advance(t, 2000);
    if (i % 8 === 7) srv.current().send('{}\n');
  }
  assert.equal(srv.attempts.length, 1);
  assert.equal(srv.attempts[0].signal?.aborted ?? false, false);
  assert.equal(inbox.inboxStream(), 'live');
  assert.deepEqual(states(), ['live']);
});
