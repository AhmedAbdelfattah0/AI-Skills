import test from 'node:test';
import assert from 'node:assert/strict';
import { selectorChainsFromHtml, selectorPathFromChain } from './lib/selector.mjs';

test('selector paths use a unique ancestor and nth-of-type', () => {
  assert.equal(selectorPathFromChain([
    { tag: 'button', sameTagCount: 2, sameTagIndex: 2 },
    { tag: 'nav', id: 'main nav', idUnique: true, sameTagCount: 1, sameTagIndex: 1 },
  ]), '#main\\ nav > button:nth-of-type(2)');
});

test('selectors generated for repeated elements in a small HTML tree are unique', () => {
  const selectors = selectorChainsFromHtml('<body><nav id="main"><a></a><a></a></nav><footer><a></a><a></a></footer></body>')
    .filter((selector) => selector.endsWith('a') || selector.includes('a:nth-of-type'));
  assert.equal(selectors.length, 4);
  assert.equal(new Set(selectors).size, selectors.length);
  assert.ok(selectors.includes('#main > a:nth-of-type(1)'));
});
