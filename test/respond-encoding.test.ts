import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEncoding } from '../src/http/respond.ts';

test('pickEncoding follows q, lets * stand for both and falls back to identity', () => {
  for (const [header, want] of [
    ['br;q=0.5, gzip;q=0.8', 'gzip'], ['*;q=0, gzip', 'gzip'], ['br;q=0, *', 'gzip'], ['gzip;q=0.001', 'gzip'],
    ['gzip, br', 'br'], [' br ; q=1.0 , gzip ; q = 1', 'br'], ['identity', null], ['deflate', null], ['x-gzip', null], ['', null], [undefined, null],
  ] as const) assert.equal(pickEncoding(header), want, String(header));
});
