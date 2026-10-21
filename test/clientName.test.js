import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClientName, checkLastName, tidyNamePart } from '../supabase/functions/_shared/clientName.js';

test('a name part gets single spaces and one capital when typed all small or all capital', () => {
  assert.equal(tidyNamePart('  sardor  '), 'Sardor');
  assert.equal(tidyNamePart('KARIMOV'), 'Karimov');
  assert.equal(tidyNamePart('g’ulomov'), 'G’ulomov');
  assert.equal(tidyNamePart('абдул   азиз'), 'Абдул Азиз');
  assert.equal(tidyNamePart('ali-xon'), 'Ali-Xon');
  assert.equal(tidyNamePart('McAllister'), 'McAllister', 'mixed case is kept as typed');
  assert.equal(tidyNamePart(null), '');
});

test('both parts are required, in letters', () => {
  assert.deepEqual(checkClientName('сардор', 'каримов'), { ok: true, first_name: 'Сардор', last_name: 'Каримов' });
  assert.deepEqual(checkClientName('Сардор', ''), { ok: false, error: 'invalid_last_name' });
  assert.deepEqual(checkClientName(' ', 'Каримов'), { ok: false, error: 'invalid_first_name' });
  assert.deepEqual(checkClientName('I', 'Karimov'), { ok: false, error: 'invalid_first_name' });
  assert.deepEqual(checkClientName('Xarun', 'Maratov 907005952'), { ok: false, error: 'invalid_last_name' });
  assert.deepEqual(checkClientName('A'.repeat(41), 'Karimov'), { ok: false, error: 'invalid_first_name' });
});

test('a surname alone, for a card that lacks it', () => {
  assert.deepEqual(checkLastName('tursunov'), { ok: true, last_name: 'Tursunov' });
  assert.deepEqual(checkLastName(''), { ok: false, error: 'invalid_last_name' });
});
