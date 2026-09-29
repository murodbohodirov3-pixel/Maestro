import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expenseForPartner, partnerMayCall, PARTNER_ROLE } from '../supabase/functions/_shared/access.js';
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

test('a partner may load and nothing else, including actions added later', () => {
  assert.equal(PARTNER_ROLE, 'partner');
  assert.equal(partnerMayCall('load'), true);
  const refused = apiActions.filter((action) => action !== 'load' && action !== 'telegramOAuth');
  assert.ok(refused.length >= 20);
  for (const action of refused) assert.equal(partnerMayCall(action), false, action);
  for (const action of ['addPayment', 'deleteEverything', '', undefined, null]) {
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
