import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeWindowedData,
  pollWindowStart,
  rowDate,
} from '../src/utils/loadWindow.js';

test('pollWindowStart reaches back to the first day of the previous month', () => {
  assert.equal(pollWindowStart(new Date(2026, 6, 23)), '2026-06-01');
  assert.equal(pollWindowStart(new Date(2026, 0, 5)), '2025-12-01');
  assert.equal(pollWindowStart(new Date(2026, 2, 31)), '2026-02-01');
});

test('rowDate falls back through the per-table date columns', () => {
  assert.equal(rowDate({ d: '2026-07-01' }), '2026-07-01');
  assert.equal(rowDate({ date: '2026-07-02' }, 'date'), '2026-07-02');
  assert.equal(rowDate({ attendance_date: '2026-07-03' }), '2026-07-03');
  assert.equal(rowDate({}), '');
});

test('a windowed refresh keeps history the response never mentioned', () => {
  const previous = {
    sales: [{ id: 1, d: '2026-01-15', cash: 100 }, { id: 2, d: '2026-07-01', cash: 200 }],
    expenses: [{ id: 9, date: '2026-01-20', amount_uzs: 50 }],
    fines: [],
    attendance: [],
    debtPayments: [],
  };
  const incoming = {
    sales: [{ id: 2, d: '2026-07-01', cash: 200 }],
    expenses: [],
    fines: [],
    attendance: [],
    debtPayments: [],
  };

  const merged = mergeWindowedData(previous, incoming, '2026-06-01');

  assert.deepEqual(merged.sales.map((row) => row.id), [1, 2]);
  assert.deepEqual(merged.expenses.map((row) => row.id), [9]);
});

test('a row edited inside the window takes the value from the response', () => {
  const previous = { sales: [{ id: 2, d: '2026-07-01', cash: 200, status: 'pending' }] };
  const incoming = { sales: [{ id: 2, d: '2026-07-01', cash: 200, status: 'approved' }] };

  const merged = mergeWindowedData(previous, incoming, '2026-06-01');

  assert.equal(merged.sales.length, 1);
  assert.equal(merged.sales[0].status, 'approved');
});

// The whole reason the window is replaced rather than appended to: an absent row
// has to read as deleted, or removing a sale would never clear it from a screen
// that stays open.
test('a row deleted inside the window disappears', () => {
  const previous = {
    sales: [{ id: 1, d: '2026-05-02' }, { id: 2, d: '2026-07-01' }, { id: 3, d: '2026-07-02' }],
  };
  const incoming = { sales: [{ id: 2, d: '2026-07-01' }] };

  const merged = mergeWindowedData(previous, incoming, '2026-06-01');

  assert.deepEqual(merged.sales.map((row) => row.id), [1, 2]);
});

test('a row outside the window is never dropped by a response that omits it', () => {
  const previous = { sales: [{ id: 1, d: '2026-05-02' }] };
  const merged = mergeWindowedData(previous, { sales: [] }, '2026-06-01');

  assert.deepEqual(merged.sales.map((row) => row.id), [1]);
});

// A bounded query cannot return a NULL date, so the window makes no claim about
// undated rows and dropping them would quietly lose money off the totals.
test('undated rows survive a windowed refresh', () => {
  const previous = { sales: [{ id: 7, cash: 500 }] };
  const merged = mergeWindowedData(previous, { sales: [] }, '2026-06-01');

  assert.deepEqual(merged.sales.map((row) => row.id), [7]);
});

test('collections outside the window contract pass through untouched', () => {
  const previous = { sales: [], debts: [{ id: 1, balance: 10 }] };
  const incoming = { sales: [], debts: [{ id: 1, balance: 4 }], masters: [{ id: 3 }] };

  const merged = mergeWindowedData(previous, incoming, '2026-06-01');

  assert.deepEqual(merged.debts, [{ id: 1, balance: 4 }]);
  assert.deepEqual(merged.masters, [{ id: 3 }]);
});
