import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADMIN_ROLE,
  adminMayCall,
  expenseForPartner,
  maskPhoneForStaff,
  partnerMayCall,
  PARTNER_ROLE,
  stockForDesk,
} from '../supabase/functions/_shared/access.js';
import {
  investmentSummary,
  operatingExpenses,
  rentOffsetIncome,
  totalExpenses,
} from '../src/utils/calculations.js';

const apiSource = readFileSync(new URL('../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const apiActions = [...new Set([...apiSource.matchAll(/action === '(\w+)'/g)].map((match) => match[1]))];

test('the api source still names the actions this guard is checked against', () => {
  for (const action of ['load', 'addSale', 'setSaleApproval', 'delSale', 'setAttendance', 'addFine', 'setSettings', 'addExpense', 'delExpense']) {
    assert.ok(apiActions.includes(action), `api no longer has ${action}`);
  }
});

test('a partner reads and takes bookings, nothing else, including actions added later', () => {
  assert.equal(PARTNER_ROLE, 'partner');
  const allowed = ['load', 'bookingSlots', 'addBooking', 'setAppointmentOutcome', 'searchClients', 'addClient'];
  for (const action of allowed) assert.equal(partnerMayCall(action), true, action);
  const refused = apiActions.filter((action) => ![...allowed, 'telegramOAuth'].includes(action));
  assert.ok(refused.length >= 20);
  for (const action of refused) assert.equal(partnerMayCall(action), false, action);
  for (const action of ['addPayment', 'deleteEverything', 'addSale', 'setSaleApproval', 'getClient', '', undefined, null]) {
    assert.equal(partnerMayCall(action), false, String(action));
  }
});

test('the partner guard runs before any action and before the master lookup', () => {
  const guard = apiSource.indexOf("if (isPartner && !partnerMayCall(action)) return json({ error: 'forbidden' }, 403);");
  assert.ok(guard > 0, 'guard missing from the api');
  assert.ok(guard < apiSource.indexOf("if (action === 'listAuditEvents')"));
  assert.ok(guard < apiSource.indexOf("if (action === 'load')"));
  assert.ok(guard < apiSource.indexOf("if (action === 'addSale')"));
});

const EXPENSES = [
  { id: 1, date: '2026-09-02', section: 'ishxona', category: 'ishxona', name: 'Реклама Instagram', note: 'таргет', qty: '1', amount_uzs: 5_000_000, usd_rate: 12_500, minus_from: null, payment_method: 'card', created_by: 7, created_at: '2026-09-02T10:00:00Z' },
  { id: 2, date: '2026-09-05', section: 'ishxona', category: null, name: 'Вода', amount_uzs: 120_000, usd_rate: null, minus_from: 'murod' },
  { id: 3, date: '2026-09-10', section: 'ishxona', category: 'rent_offset', name: 'Взаимозачёт аренды · Жамшид', note: 'аренда за сентябрь', amount_uzs: 6_250_000, usd_rate: 12_500, minus_from: 'jamshid' },
  { id: 4, date: '2026-03-01', section: 'jamshid', category: 'jamshid', name: 'Кресла', amount_uzs: 25_000_000, usd_rate: 12_600, minus_from: null },
  { id: 5, date: '2026-04-01', section: 'murod', category: 'murod', name: 'Ремонт', amount_uzs: 40_000_000, usd_rate: 12_700, minus_from: null },
];

test('an expense reaches a partner without what it was for', () => {
  const stripped = expenseForPartner(EXPENSES[0]);
  assert.deepEqual(Object.keys(stripped).sort(), ['amount_uzs', 'category', 'date', 'id', 'minus_from', 'section', 'usd_rate']);
  for (const hidden of ['name', 'note', 'qty', 'payment_method', 'created_by', 'created_at']) {
    assert.equal(hidden in stripped, false, hidden);
  }
  assert.doesNotMatch(JSON.stringify(EXPENSES.map(expenseForPartner)), /Реклама|Вода|аренда за|Кресла|Ремонт|таргет/);
});

test('every total a partner sees is the same sum the owner sees', () => {
  const partner = EXPENSES.map(expenseForPartner);
  assert.equal(totalExpenses(operatingExpenses(partner)), totalExpenses(operatingExpenses(EXPENSES)));
  assert.equal(rentOffsetIncome(partner), rentOffsetIncome(EXPENSES));
  for (const owner of ['murod', 'jamshid']) {
    assert.deepEqual(investmentSummary(partner, owner), investmentSummary(EXPENSES, owner));
  }
});

test('the administrator sells goods and keeps the bookings, nothing else', () => {
  assert.equal(ADMIN_ROLE, 'admin');
  const allowed = ['load', 'addProductSale', 'delStockEntry', 'bookingSlots', 'addBooking', 'setAppointmentOutcome', 'searchClients', 'addClient'];
  for (const action of allowed) assert.equal(adminMayCall(action), true, action);
  const refused = apiActions.filter((action) => ![...allowed, 'telegramOAuth'].includes(action));
  assert.ok(refused.length >= 25);
  for (const action of refused) assert.equal(adminMayCall(action), false, action);
  for (const action of ['addProductReceipt', 'addProductWriteoff', 'setProductSaleApproval', 'setSaleApproval', 'addSale', 'getClient', 'addExpense', 'setSettings', 'listAuditEvents']) {
    assert.equal(adminMayCall(action), false, action);
  }
});

test('the administrator guard runs before any action, next to the partner one', () => {
  const guard = apiSource.indexOf("if (isFrontDesk && !adminMayCall(action)) return json({ error: 'forbidden' }, 403);");
  assert.ok(guard > 0, 'guard missing from the api');
  assert.ok(guard < apiSource.indexOf("if (action === 'listAuditEvents')"));
  assert.ok(guard < apiSource.indexOf("if (action === 'load' && isFrontDesk)"));
  // The role named admin no longer reads the salon's figures or decides.
  assert.match(apiSource, /const isAdmin = \['owner', 'finance'\]\.includes/);
  assert.match(apiSource, /const canApproveSales = appUserResult\.data\.role === 'owner';/);
});

test("the administrator's Склад has quantities and her own sales, never a price", () => {
  const desk = stockForDesk({
    products: [
      { id: 1, name: 'Шампунь', category: 'care', active: true },
      { id: 2, name: 'Воск', category: 'care', active: false },
      { id: 3, name: 'Кола', category: 'drinks', active: true },
    ],
    receipts: [
      { product_id: 1, qty: 10, unit_cost: 50_000, total_cost: 500_000 },
      { product_id: 2, qty: 2, unit_cost: 40_000, total_cost: 80_000 },
      { product_id: 3, qty: 24, unit_cost: 7_000, total_cost: 168_000 },
    ],
    sales: [
      { id: 1, product_id: 1, qty: 2, amount: 150_000, unit_cost: 50_000, status: 'approved', sale_date: '2026-10-15', created_by_user_id: 20, payment_method: 'cash', created_at: 'x' },
      { id: 2, product_id: 1, qty: 1, amount: 75_000, unit_cost: 50_000, status: 'pending', sale_date: '2026-10-15', created_by_user_id: 7, payment_method: 'card', created_at: 'y' },
      { id: 3, product_id: 1, qty: 1, amount: 70_000, unit_cost: 50_000, status: 'rejected', sale_date: '2026-10-14', created_by_user_id: 20, payment_method: 'qr', created_at: 'z' },
      { id: 4, product_id: 3, qty: 1, amount: 12_000, unit_cost: 7_000, status: 'approved', sale_date: '2026-10-10', created_by_user_id: 20, payment_method: 'cash', created_at: 'w' },
      { id: 5, product_id: 2, qty: 2, amount: 90_000, unit_cost: 40_000, status: 'approved', sale_date: '2026-10-11', created_by_user_id: 7, payment_method: 'cash', created_at: 'v' },
    ],
    writeoffs: [{ product_id: 3, qty: 3 }],
    userId: 20,
    since: '2026-10-14',
  });
  // A hidden product with nothing left is not listed; pending sales hold stock.
  assert.deepEqual(desk.products.map((row) => [row.name, row.stock_qty]), [['Шампунь', 7], ['Кола', 20]]);
  // Only her own sales from the window, without what the goods cost.
  assert.deepEqual(desk.product_sales.map((sale) => sale.id), [1, 3]);
  assert.doesNotMatch(JSON.stringify(desk), /unit_cost|total_cost|:50000[,}]|:500000[,}]/);
});

test('masters see a client number as its operator code and last two digits', () => {
  assert.equal(maskPhoneForStaff('+998901234522'), '+998 90 *** ** 22');
  assert.equal(maskPhoneForStaff('998 93 555 11 05'), '+998 93 *** ** 05');
  assert.equal(maskPhoneForStaff('+79161234567'), '+791 *** ** 67');
  assert.equal(maskPhoneForStaff(null), null);
  assert.equal(maskPhoneForStaff(''), null);
  assert.doesNotMatch(maskPhoneForStaff('+998901234522'), /1234/);
});
