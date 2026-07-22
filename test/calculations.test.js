import test from 'node:test';
import assert from 'node:assert/strict';
import {
  masterGrossPay,
  masterNetPay,
  masterNetPayFromRevenue,
  saleTotal,
} from '../src/utils/calculations.js';

test('master gross pay retains the percentage commission formula', () => {
  assert.equal(masterGrossPay(1_250_000, 40), 500_000);
  assert.equal(masterGrossPay('1250000', '35'), 437_500);
  assert.equal(masterGrossPay(undefined, 40), 0);
});

test('master net pay never falls below zero after fines', () => {
  assert.equal(masterNetPay(500_000, 120_000), 380_000);
  assert.equal(masterNetPay(500_000, 700_000), 0);
  assert.equal(masterNetPayFromRevenue(1_250_000, 40, 120_000), 380_000);
});

test('payment-method sale totals retain all legacy channels', () => {
  assert.equal(saleTotal({ cash: 100_000, card: 200_000, qr: 50_000 }), 350_000);
  assert.equal(saleTotal({ cash: null, card: '200000', qr: undefined }), 200_000);
});
