// Regression probes from the independent verification of the terminal order
// (public/terminal-order-model.js): junk prefs, refused drops, random drags and restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTerminals } from '../public/terminal-groups.js';
import { MAX_SLOTS, MAX_WORKSPACES, moveTerminal, moveTerminalBy, readOrder, slotKey } from '../public/terminal-order-model.js';

const t = (id: string, ws: string, rel = '', kind = 'agent') => ({ id, workspaceId: ws, rel, kind });
const WS = [{ id: 'dev', name: 'Dev' }, { id: 'web', name: 'Web' }];

test('malformed terminalOrder prefs never throw and never leak non-string slots', () => {
  const bad: unknown[] = [undefined, 0, true, 'x', {}, [null], [[]], [['dev']], [['dev', null]], [['dev', {}]],
    [['dev', [null, 1, {}, [], 'ok|agent']]], [[1, ['a']]], [['', ['|shell']]], [['dev', Array(1000).fill('k|agent')]],
    Array.from({ length: 100 }, (_, i) => [`w${i}`, ['k|agent']])];
  for (const raw of bad) {
    const order = readOrder(raw);
    for (const [k, v] of order) {
      assert.equal(typeof k, 'string');
      assert.ok(v.every((s) => typeof s === 'string'));
      assert.ok(v.length <= MAX_SLOTS);
    }
    assert.ok(order.size <= MAX_WORKSPACES);
    assert.deepEqual(groupTerminals([t('a', 'web'), t('b', 'dev')], WS, order).map((g) => g.workspaceId), ['dev', 'web']);
  }
  assert.deepEqual([...readOrder([['dev', ['a|agent']], ['dev', ['b|agent']]])], [['dev', ['b|agent']]]);
});

test('a refused drop returns the same order, unchanged', () => {
  const list = [t('a', 'dev', 'api'), t('b', 'dev', 'web'), t('w', 'web', 'site')];
  const order = new Map([['dev', ['web|agent']]]);
  const snap = JSON.stringify([...order]);
  for (const [d, g, p] of [['w', 'a', 'before'], ['a', 'w', 'after'], ['a', 'a', 'before'], ['zz', 'a', 'after'], ['a', 'zz', 'after']] as const)
    assert.equal(moveTerminal(order, list, d, g, p), order);
  assert.equal(JSON.stringify([...order]), snap);
});

test('random drags match an array model, survive a restart, and the keyboard stops at the ends', () => {
  let seed = 12345;
  const rnd = (k: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % k;
  };
  for (let round = 0; round < 200; round++) {
    const size = 1 + rnd(8);
    const terms = Array.from({ length: size }, (_, i) => t(`t${i}`, 'dev', `f${i}`, i % 2 ? 'shell' : 'agent'));
    let order = new Map<string, string[]>();
    let model = terms.map((x) => x.id);
    assert.deepEqual(groupTerminals(terms, WS)[0].terminals.map((x) => x.id), model, 'no saved order keeps creation order');
    for (let m = 0; m < 10; m++) {
      const d = model[rnd(size)], g = model[rnd(size)];
      const place = rnd(2) ? 'before' : 'after';
      if (d === g) continue;
      const rest = model.filter((x) => x !== d);
      rest.splice(rest.indexOf(g) + (place === 'after' ? 1 : 0), 0, d);
      model = rest;
      order = moveTerminal(order, terms, d, g, place);
      assert.deepEqual(groupTerminals(terms, WS, order)[0].terminals.map((x) => x.id), model);
    }
    const restarted = [...terms].sort(() => rnd(3) - 1).map((x, i) => ({ ...x, id: `n${i}` }));
    const shown = groupTerminals(restarted, WS, readOrder(JSON.parse(JSON.stringify([...order]))))[0].terminals.map(slotKey);
    assert.deepEqual(shown, model.map((id) => slotKey(terms.find((x) => x.id === id)!)));
    let k = order;
    const first = model[0];
    for (let i = 0; i < size + 2; i++) k = moveTerminalBy(k, terms, first, 1);
    assert.equal(groupTerminals(terms, WS, k)[0].terminals.at(-1)!.id, first);
    for (let i = 0; i < size + 2; i++) k = moveTerminalBy(k, terms, first, -1);
    assert.equal(groupTerminals(terms, WS, k)[0].terminals[0].id, first);
  }
});
