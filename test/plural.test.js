import test from 'node:test';
import assert from 'node:assert/strict';
import { pluralRu } from '../src/utils/plural.js';

const form = (count) => pluralRu(count, 'продажа', 'продажи', 'продаж');

test('picks the singular form for 1 and for numbers ending in 1', () => {
  assert.equal(form(1), 'продажа');
  assert.equal(form(21), 'продажа');
  assert.equal(form(101), 'продажа');
});

test('picks the few form for 2 to 4 and their higher counterparts', () => {
  assert.equal(form(2), 'продажи');
  assert.equal(form(4), 'продажи');
  assert.equal(form(23), 'продажи');
});

// The teens are the case a naive "1 vs many" rule gets wrong.
test('the teens all take the many form', () => {
  assert.equal(form(11), 'продаж');
  assert.equal(form(12), 'продаж');
  assert.equal(form(14), 'продаж');
  assert.equal(form(111), 'продаж');
});

test('picks the many form for 5 and above, and for zero', () => {
  assert.equal(form(0), 'продаж');
  assert.equal(form(5), 'продаж');
  assert.equal(form(100), 'продаж');
});
