// Sereno's owl is option 2b of design/sereno-owl/01-opciones-de-buho.html: an owl perched on the
// rose's stem, with its leaves and spark, drawn with a body and eyes big enough for 14–18px.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYMBOLS } from '../public/icons.js';
import { NO_DESIGN, readArtboard } from './helpers/design.ts';

type Shape = [string, Record<string, string>];
const markup = (shapes: Shape[]) => shapes.map(([tag, attrs]) => `<${tag}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`).join('');
const symbol = (source: string, id: string) => source.match(new RegExp(`<symbol id="${id}" viewBox="0 0 24 24">(.*?)</symbol>`))?.[1];

test('the sereno icon is the chosen owl, option 2b of the sereno-owl artboard', { skip: NO_DESIGN }, () => {
  const chosen = symbol(readArtboard('design/sereno-owl/01-opciones-de-buho.html'), 'owl-2b');
  assert.ok(chosen, 'owl-2b is not in the artboard');
  assert.equal(markup((SYMBOLS as Record<string, Shape[]>).sereno), chosen);
});
