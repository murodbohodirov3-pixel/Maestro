import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths,
  attentionSignals,
  compactMoney,
  monthEnd,
  monthForecast,
  monthlySeries,
  returningShare,
} from '../src/utils/insights.js';

const sale = (d, amount, extra = {}) => ({ d, cash: amount, cl: 1, clients_count: 1, ...extra });

// One sale a day for every day of a range, so pace and totals are easy to read.
function daily(from, to, amount, extra = {}) {
  const rows = [];
  const cursor = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (cursor <= end) {
    const local = new Date(cursor.getTime() - cursor.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    rows.push(sale(local, amount, extra));
    cursor.setDate(cursor.getDate() + 1);
  }
  return rows;
}

test('month helpers land on the right days', () => {
  assert.equal(monthEnd('2026-09-29'), '2026-09-30');
  assert.equal(monthEnd('2028-02-10'), '2028-02-29');
  assert.equal(addMonths('2026-09-29', -1), '2026-08-01');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-01');
});

test('the forecast scales finished days only, not the running one', () => {
  const sales = [
    ...daily('2026-09-01', '2026-09-28', 1_000_000),
    sale('2026-09-29', 50_000),
    ...daily('2026-08-01', '2026-08-31', 800_000),
  ];
  const forecast = monthForecast(sales, '2026-09-29');
  assert.equal(forecast.completedDays, 28);
  assert.equal(forecast.revenueSoFar, 28_000_000);
  assert.equal(Math.round(forecast.revenue), 30_000_000);
  assert.equal(forecast.previous.revenue, 24_800_000);
  assert.equal(forecast.revenueChange, 21);
});

test('there is no forecast on the first day of a month', () => {
  assert.equal(monthForecast([sale('2026-10-01', 100_000)], '2026-10-01'), null);
});

test('monthly series starts at the first sale and ends with the current month', () => {
  const sales = [
    ...daily('2026-07-10', '2026-07-12', 100_000),
    ...daily('2026-09-01', '2026-09-02', 200_000, { is_new_client: true }),
  ];
  const series = monthlySeries({ sales, today: '2026-09-29', months: 12 });
  assert.deepEqual(series.map((row) => row.key), ['2026-07', '2026-08', '2026-09']);
  assert.equal(series[0].revenue, 300_000);
  assert.equal(series[1].revenue, 0);
  assert.equal(series[2].isCurrent, true);
  assert.equal(series[2].newClients, 2);
});

test('monthly profit is revenue less master pay and operating expenses', () => {
  const masters = [{ id: 1, name: 'A', pct: 40 }];
  const sales = [sale('2026-09-05', 1_000_000, { master_id: 1, master: 'A' })];
  const expenses = [
    { date: '2026-09-10', section: 'ishxona', amount_uzs: 100_000 },
    { date: '2026-09-11', section: 'murod', amount_uzs: 999_000 },
  ];
  const [row] = monthlySeries({ sales, expenses, masters, today: '2026-09-29', months: 1 });
  assert.equal(row.profit, 1_000_000 - 400_000 - 100_000);
});

test('returning share ignores clients whose type was never recorded', () => {
  assert.equal(returningShare([
    sale('2026-09-01', 1, { is_new_client: true }),
    sale('2026-09-01', 1, { is_new_client: false }),
    sale('2026-09-01', 1, { is_new_client: false }),
    sale('2026-09-01', 1, { is_new_client: false }),
    sale('2026-09-01', 1),
  ]), 75);
  assert.equal(returningShare([sale('2026-09-01', 1)]), null);
});

test('signals wait for enough finished days', () => {
  const result = attentionSignals({ sales: [], today: '2026-09-04' });
  assert.equal(result.ready, false);
  assert.equal(result.completedDays, 3);
});

test('signals compare finished days with the same days of last month', () => {
  const masters = [{ id: 1, name: 'Жавохир', active: true }, { id: 2, name: 'Жавлон', active: true }];
  const sales = [
    ...daily('2026-08-01', '2026-08-31', 500_000, { master_id: 1, is_new_client: true }),
    ...daily('2026-08-01', '2026-08-31', 200_000, { master_id: 2, is_new_client: false }),
    ...daily('2026-09-01', '2026-09-28', 300_000, { master_id: 1, is_new_client: false }),
    ...daily('2026-09-01', '2026-09-28', 400_000, { master_id: 2, is_new_client: false }),
  ];
  const result = attentionSignals({ sales, masters, today: '2026-09-29' });
  assert.equal(result.ready, true);
  assert.deepEqual(result.previousRange, { from: '2026-08-01', to: '2026-08-28' });
  const titles = result.signals.map((signal) => signal.title);
  assert.ok(titles.includes('Новых клиентов меньше на 100%'));
  assert.ok(titles.includes('Жавохир: выручка −40%'));
  assert.ok(titles.includes('Жавлон: выручка +100%'));
  assert.ok(titles.includes('Клиенты чаще возвращаются'));
  assert.ok(!titles.some((title) => title.startsWith('Выручка')), 'total revenue is flat');
  const firstGood = result.signals.findIndex((signal) => signal.tone === 'good');
  assert.ok(result.signals.slice(0, firstGood).every((signal) => signal.tone === 'bad'));
});

test('a master who left raises no alarm about his own drop', () => {
  const masters = [{ id: 7, name: 'Ушёл', active: false }];
  const sales = daily('2026-08-01', '2026-08-31', 500_000, { master_id: 7 });
  const result = attentionSignals({ sales, masters, today: '2026-09-29' });
  assert.ok(!result.signals.some((signal) => signal.title.startsWith('Ушёл')));
});

test('compact money reads in millions above a million', () => {
  assert.equal(compactMoney(77_482_000), '77,5 млн');
  assert.equal(compactMoney(155_586), (155_586).toLocaleString('ru-RU'));
});
