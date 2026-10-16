import test from 'node:test';
import assert from 'node:assert/strict';
import { masterWeek, weekOf, weekPayouts, weekStartOf } from '../src/utils/payouts.js';

const JAVLON = { id: 3, name: 'Жавлон', pct: 40, active: true };
const SALIM = { id: 24, name: 'Салим', pct: 40, active: true };
const WEEK = weekOf('2026-10-16');

const sale = (master, d, cash, pct = 40) => ({ master: master.name, master_id: master.id, d, cash, card: 0, qr: 0, commission_pct: pct });

test('a week runs Monday to Sunday', () => {
  assert.deepEqual(WEEK, { from: '2026-10-12', to: '2026-10-18' });
  assert.equal(weekStartOf('2026-10-12'), '2026-10-12');
  assert.equal(weekStartOf('2026-10-18'), '2026-10-12');
  assert.equal(weekStartOf('2026-10-19'), '2026-10-19');
});

test('an advance lowers what is owed, and only that', () => {
  const row = masterWeek({
    master: JAVLON,
    week: WEEK,
    sales: [sale(JAVLON, '2026-10-13', 2_500_000), sale(JAVLON, '2026-10-17', 2_500_000), sale(JAVLON, '2026-10-11', 9_000_000)],
    fines: [{ master: 'Жавлон', master_id: 3, d: '2026-10-14', amount: 100_000 }],
    advances: [{ master: 'Жавлон', master_id: 3, given_on: '2026-10-15', amount: 500_000 }],
  });
  assert.equal(row.earned, 2_000_000, '40% of the week, not of the Saturday before');
  assert.equal(row.fines, 100_000);
  assert.equal(row.net, 1_900_000, 'earnings net of fines do not change with the advance');
  assert.equal(row.advances, 500_000);
  assert.equal(row.due, 1_400_000);
});

test('what was paid for the week is no longer owed; a later visit still is', () => {
  const sales = [sale(SALIM, '2026-10-13', 1_000_000)];
  const payouts = [{ master: 'Салим', master_id: 24, week_start: '2026-10-12', amount: 400_000 }];
  assert.equal(masterWeek({ master: SALIM, week: WEEK, sales, payouts }).due, 0);
  const later = masterWeek({ master: SALIM, week: WEEK, sales: [...sales, sale(SALIM, '2026-10-18', 250_000)], payouts });
  assert.equal(later.due, 100_000);
  assert.equal(masterWeek({ master: SALIM, week: weekOf('2026-10-19'), sales, payouts }).paid, 0, 'a payout belongs to its own week');
});

test('an advance bigger than the week shows as a negative due', () => {
  const row = masterWeek({
    master: SALIM,
    week: WEEK,
    sales: [sale(SALIM, '2026-10-13', 500_000)],
    advances: [{ master: 'Салим', master_id: 24, given_on: '2026-10-13', amount: 300_000 }],
  });
  assert.equal(row.due, -100_000);
});

test('a master who left is listed only for a week he has something in', () => {
  const gone = { id: 22, name: 'Нуриддин', pct: 40, active: false };
  const rows = weekPayouts({ masters: [JAVLON, gone], week: WEEK, sales: [] });
  assert.deepEqual(rows.map((row) => row.master.name), ['Жавлон']);
  const withAdvance = weekPayouts({ masters: [JAVLON, gone], week: WEEK, advances: [{ master_id: 22, master: 'Нуриддин', given_on: '2026-10-12', amount: 1 }] });
  assert.deepEqual(withAdvance.map((row) => row.master.name), ['Жавлон', 'Нуриддин']);
});
