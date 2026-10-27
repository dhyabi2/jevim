import assert from 'node:assert/strict';
import test from 'node:test';

import { sameName } from '../src/index/samename.js';

test('a control that gains a count or a changing number is still the same control', () => {
  assert.ok(sameName('5 stars', '5 stars (128)'));
  assert.ok(sameName('Cart', 'Cart 2 items'));
  assert.ok(sameName('Updated 3 minutes ago', 'Updated 4 minutes ago'));
  assert.ok(sameName('Sort by: Price', 'Sort by: price'));
  assert.ok(sameName('Samsung (12)', 'Samsung (14)'));
});

test('a different element under the same node is still refused', () => {
  assert.equal(sameName('Buy', 'Delete account'), false);
  assert.equal(sameName('Save', 'Delete'), false);
  assert.equal(sameName('Accept', 'Accept all and delete my data'), false, 'a long extension is a different control');
  assert.ok(sameName('Filters', 'Filters applied'), 'a short extension is allowed...');
  assert.equal(sameName('Yes', 'No'), false);
  assert.equal(sameName('On', 'Only delete'), false, '...but not from a two-letter stem');
  assert.equal(sameName('Buy', ''), false);
  assert.equal(sameName('', 'Delete'), false);
});

test('a name made only of digits must match exactly', () => {
  assert.ok(sameName('2', '2'));
  assert.equal(sameName('2', '3'), false);
});
