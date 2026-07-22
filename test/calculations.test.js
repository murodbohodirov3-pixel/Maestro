import test from 'node:test';
import assert from 'node:assert/strict';
import {
  investmentSummary,
  masterGrossPay,
  masterNetPay,
  masterNetPayFromRevenue,
  saleTotal,
  totalCard,
  totalCash,
  totalExpenses,
  totalFines,
  totalPaidForDebt,
  totalQr,
  totalSalesAmount,
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
  const sales = [
    { cash: 100_000, card: 200_000, qr: 50_000 },
    { cash: null, card: '200000', qr: undefined },
  ];
  assert.equal(saleTotal(sales[0]), 350_000);
  assert.equal(saleTotal({ cash: null, card: '200000', qr: undefined }), 200_000);
  assert.equal(totalSalesAmount(sales), 550_000);
  assert.equal(totalCash(sales), 100_000);
  assert.equal(totalCard(sales), 400_000);
  assert.equal(totalQr(sales), 50_000);
});

test('expense and fine totals retain numeric coercion and zero fallbacks', () => {
  assert.equal(totalExpenses([{ amount_uzs: 120_000 }, { amount_uzs: '80000' }, { amount_uzs: null }]), 200_000);
  assert.equal(totalFines([{ amount: 50_000 }, { amount: '25000' }, { amount: undefined }]), 75_000);
});

test('investment summary retains lifetime UZS and USD balances', () => {
  const expenses = [
    { section: 'murod', amount_uzs: 1_220_000, usd_rate: 12_200 },
    { section: 'ishxona', minus_from: 'murod', amount_uzs: 244_000, usd_rate: 12_200 },
    { section: 'jamshid', amount_uzs: 999_999, usd_rate: 12_200 },
  ];
  assert.deepEqual(investmentSummary(expenses, 'murod'), {
    invested: 1_220_000,
    investedUsd: 100,
    returned: 244_000,
    returnedUsd: 20,
  });
});

test('debt payment total retains string id matching and numeric coercion', () => {
  const payments = [
    { debt_id: 7, amount: 300_000 },
    { debt_id: '7', amount: '125000' },
    { debt_id: 8, amount: 900_000 },
  ];
  assert.equal(totalPaidForDebt(payments, '7'), 425_000);
});
