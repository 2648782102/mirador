import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, type Route } from '../src/http/router.ts';

const noop = async () => {};

function router(...routes: Array<Pick<Route, 'method' | 'path'>>): Router {
  const r = new Router();
  for (const route of routes) r.add({ ...route, handler: noop });
  return r;
}

test('matches a route by method and exact path', () => {
  const r = router({ method: 'GET', path: '/api/tree' }, { method: 'POST', path: '/api/tree' });
  assert.equal(r.match('GET', '/api/tree')?.route.method, 'GET');
  assert.equal(r.match('POST', '/api/tree')?.route.method, 'POST');
  assert.equal(r.match('DELETE', '/api/tree'), null);
  assert.equal(r.match('GET', '/api/tree/extra'), null);
});

test('captures and decodes :params, one path segment each', () => {
  const r = router({ method: 'PATCH', path: '/api/workspaces/:id' });
  assert.deepEqual(r.match('PATCH', '/api/workspaces/dev%20two')?.params, { id: 'dev two' });
  assert.equal(r.match('PATCH', '/api/workspaces/a/b'), null);
  assert.equal(r.match('PATCH', '/api/workspaces/'), null);
});

test('a malformed escape in a param does not match instead of throwing', () => {
  const r = router({ method: 'GET', path: '/api/x/:id' });
  assert.equal(r.match('GET', '/api/x/%E0%A4%A'), null);
});

test('adding the same method and path twice is refused', () => {
  const r = router({ method: 'GET', path: '/api/tree' });
  assert.throws(() => r.add({ method: 'GET', path: '/api/tree', handler: noop }), /already registered/);
});
