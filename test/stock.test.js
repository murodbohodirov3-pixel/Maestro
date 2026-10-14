import test from 'node:test';
import assert from 'node:assert/strict';
import {
  averageUnitCost,
  goodsPaymentMix,
  pendingProductSales,
  productMatches,
  productsByRecentUse,
  productIncome,
  productSaleMargin,
  productSalesSummary,
  stockLevels,
} from '../src/utils/stock.js';

const PRODUCTS = [
  { id: 1, name: 'Шампунь', category: 'care', active: true },
  { id: 2, name: 'Воск', category: 'care', active: true },
  { id: 3, name: 'Кола', category: 'drinks', active: true },
];

// Шампунь bought twice, at 50 000 and then 60 000.
const RECEIPTS = [
  { id: 1, product_id: 1, receipt_date: '2026-10-01', qty: 10, unit_cost: 50_000, total_cost: 500_000 },
  { id: 2, product_id: 1, receipt_date: '2026-10-10', qty: 10, unit_cost: 60_000, total_cost: 600_000 },
  { id: 3, product_id: 2, receipt_date: '2026-10-01', qty: 4, unit_cost: 40_000, total_cost: 160_000 },
  { id: 4, product_id: 3, receipt_date: '2026-10-01', qty: 24, unit_cost: 7_000, total_cost: 168_000 },
];

const SALES = [
  { id: 1, product_id: 1, sale_date: '2026-10-05', qty: 2, amount: 160_000, unit_cost: 50_000, status: 'approved' },
  { id: 2, product_id: 1, sale_date: '2026-10-12', qty: 1, amount: 75_000, unit_cost: 55_000, status: 'pending' },
  { id: 3, product_id: 1, sale_date: '2026-10-12', qty: 1, amount: 70_000, unit_cost: 55_000, status: 'rejected' },
  { id: 4, product_id: 3, sale_date: '2026-09-30', qty: 3, amount: 45_000, unit_cost: 7_000, status: 'approved' },
  { id: 5, product_id: 2, sale_date: '2026-10-13', qty: 4, amount: 200_000, unit_cost: 40_000, status: 'approved' },
];

const WRITEOFFS = [
  { id: 1, product_id: 3, writeoff_date: '2026-10-02', qty: 5, reason: 'gift' },
];

test('the average purchase price weighs each delivery by its quantity', () => {
  assert.equal(averageUnitCost(RECEIPTS.filter((row) => row.product_id === 1)), 55_000);
  assert.equal(averageUnitCost([]), 0);
  assert.equal(averageUnitCost([{ qty: 3, unit_cost: 10_000 }]), 10_000, 'total_cost may be absent');
});

test('stock is received less sold (pending included) less written off', () => {
  const levels = stockLevels({ products: PRODUCTS, receipts: RECEIPTS, sales: SALES, writeoffs: WRITEOFFS });
  const byName = Object.fromEntries(levels.map((row) => [row.product.name, row]));
  // A pending sale holds its bottle; a rejected one gives it back.
  assert.equal(byName['Шампунь'].qty, 20 - 2 - 1);
  assert.equal(byName['Шампунь'].value, 17 * 55_000);
  assert.equal(byName['Кола'].qty, 24 - 3 - 5);
  assert.equal(byName['Воск'].qty, 0);
  // What is still on the shelf is listed first.
  assert.deepEqual(levels.map((row) => row.product.name), ['Кола', 'Шампунь', 'Воск']);
});

test('the margin is what the salon kept less what the units had cost', () => {
  assert.equal(productSaleMargin(SALES[0]), 160_000 - 2 * 50_000);
  const october = productSalesSummary(SALES, { from: '2026-10-01', to: '2026-10-31' });
  // Pending and rejected sales are not income yet; September's cola is outside.
  assert.deepEqual(october, { count: 2, qty: 6, amount: 360_000, cost: 260_000, margin: 100_000 });
});

test('profit takes the money a sale brought, since the purchase is already an expense', () => {
  assert.equal(productIncome(SALES, { from: '2026-10-01', to: '2026-10-31' }), 360_000);
  assert.equal(productIncome(SALES, { from: '2026-09-01', to: '2026-09-30' }), 45_000);
  assert.equal(productIncome(SALES, null), 0);
});

test('pending goods add up by payment method for the approval totals', () => {
  assert.deepEqual(goodsPaymentMix([
    { amount: 80_000, payment_method: 'cash' },
    { amount: 60_000, payment_method: 'cash' },
    { amount: 90_000, payment_method: 'card' },
    { amount: 40_000, payment_method: 'qr' },
  ]), { cash: 140_000, card: 90_000, qr: 40_000, total: 270_000 });
  assert.deepEqual(goodsPaymentMix([]), { cash: 0, card: 0, qr: 0, total: 0 });
});

test('a product is found by any pieces of its name, in any order', () => {
  const product = { name: 'Шампунь Reuzel Daily 350 мл' };
  assert.equal(productMatches(product, 'шамп'), true);
  assert.equal(productMatches(product, 'reuzel   ШАМП'), true);
  assert.equal(productMatches(product, '350 daily'), true);
  assert.equal(productMatches(product, 'воск'), false);
  assert.equal(productMatches({ name: 'Гель Ёжик' }, 'ежик'), true);
  assert.equal(productMatches(product, '   '), true);
});

test('products in daily use are offered first', () => {
  const ordered = productsByRecentUse(PRODUCTS, RECEIPTS, SALES);
  // Воск sold on the 13th, Шампунь on the 12th, Кола last moved on 1 October.
  assert.deepEqual(ordered.map((product) => product.name), ['Воск', 'Шампунь', 'Кола']);
});

test('the owner\'s queue holds only the sales waiting for him', () => {
  assert.deepEqual(pendingProductSales(SALES).map((sale) => sale.id), [2]);
});
