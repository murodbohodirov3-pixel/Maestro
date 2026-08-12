import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appointmentOutcomeSummary,
  belongsToMaster,
  comparablePreviousRange,
  dayCount,
  latenessSummary,
  masterPayoutForPeriod,
  mastersForPeriod,
  minutesLate,
  monthWeekRanges,
  overviewWeeklyMetrics,
  paymentMix,
  percentageDifference,
  previousRange,
  recognizedFinesTotal,
  shiftProductivity,
  weekdayBreakdown,
  weekdayIndex,
} from '../src/utils/reporting.js';

const MASTERS = [
  { id: 1, name: 'Жавохир', pct: 50, active: true },
  { id: 3, name: 'Жавлон', pct: 40, active: true },
  { id: 5, name: 'Махмуд', pct: 45, active: false },
];

test('master ownership survives a rename because the id wins over the name', () => {
  const master = { id: 3, name: 'Javlon' };
  assert.equal(belongsToMaster({ master_id: 3, master: 'Жавлон' }, master), true);
  assert.equal(belongsToMaster({ master_id: 9, master: 'Javlon' }, master), false);
});

test('a legacy row without an id still matches on the name', () => {
  assert.equal(belongsToMaster({ master: 'Жавлон' }, { id: 3, name: 'Жавлон' }), true);
  assert.equal(belongsToMaster({ master_id: null, master: 'Жавлон' }, { id: 3, name: 'Иброхим' }), false);
});

test('a deactivated master stays in the period he actually worked', () => {
  const sales = [{ master_id: 5, cash: 1_000_000, commission_pct: 45 }];
  assert.deepEqual(mastersForPeriod(MASTERS, sales).map((m) => m.id), [1, 3, 5]);
  assert.deepEqual(mastersForPeriod(MASTERS, []).map((m) => m.id), [1, 3]);
});

test('payout of a deactivated master is still owed and still counted', () => {
  const sales = [{ master_id: 5, cash: 1_000_000, commission_pct: 45 }];
  assert.equal(masterPayoutForPeriod(MASTERS, sales, []), 450_000);
});

test('payout uses the per-sale snapshot, not the current profile rate', () => {
  const sales = [
    { master_id: 3, cash: 1_000_000, commission_pct: 50 },
    { master_id: 3, card: 1_000_000, commission_pct: 40 },
  ];
  assert.equal(masterPayoutForPeriod(MASTERS, sales, []), 900_000);
});

test('a fine reduces the payout but never past zero', () => {
  const sales = [{ master_id: 3, cash: 1_000_000, commission_pct: 40 }];
  assert.equal(masterPayoutForPeriod(MASTERS, sales, [{ master_id: 3, amount: 100_000 }]), 300_000);
  assert.equal(masterPayoutForPeriod(MASTERS, sales, [{ master_id: 3, amount: 900_000 }]), 0);
});

test('a partial month is compared against the same number of elapsed days', () => {
  const august = { from: '2026-08-01', to: '2026-08-31' };
  assert.deepEqual(
    comparablePreviousRange(august, 'month', '2026-08-12'),
    { from: '2026-07-01', to: '2026-07-12' },
  );
});

test('a month that has fully elapsed is compared against the whole previous month', () => {
  const july = { from: '2026-07-01', to: '2026-07-31' };
  assert.deepEqual(
    comparablePreviousRange(july, 'month', '2026-08-12'),
    { from: '2026-06-01', to: '2026-06-30' },
  );
});

test('a trimmed comparison never runs past the end of the shorter previous month', () => {
  const march = { from: '2026-03-01', to: '2026-03-31' };
  assert.deepEqual(
    comparablePreviousRange(march, 'month', '2026-03-31'),
    { from: '2026-02-01', to: '2026-02-28' },
  );
});

test('previousRange keeps its original behaviour for whole periods', () => {
  assert.deepEqual(
    previousRange({ from: '2026-08-01', to: '2026-08-31' }, 'month'),
    { from: '2026-07-01', to: '2026-07-31' },
  );
  assert.deepEqual(
    previousRange({ from: '2026-08-10', to: '2026-08-16' }, 'week'),
    { from: '2026-08-03', to: '2026-08-09' },
  );
  assert.equal(previousRange({ from: '2026-01-01', to: '2026-01-31' }, 'all'), null);
});

test('day counting is inclusive on both ends', () => {
  assert.equal(dayCount('2026-08-01', '2026-08-12'), 12);
  assert.equal(dayCount('2026-08-01', '2026-08-01'), 1);
  assert.equal(dayCount('2026-02-01', '2026-03-01'), 29);
});

test('percentage growth from nothing is reported as a full gain, not a division by zero', () => {
  assert.equal(percentageDifference(120, 100), 20);
  assert.equal(percentageDifference(80, 100), -20);
  assert.equal(percentageDifference(500, 0), 100);
  assert.equal(percentageDifference(0, 0), 0);
});

test('weekly buckets cover the month exactly once', () => {
  const weeks = monthWeekRanges({ from: '2026-08-01', to: '2026-08-31' });
  assert.equal(weeks[0].from, '2026-08-01');
  assert.equal(weeks[weeks.length - 1].to, '2026-08-31');
  weeks.slice(1).forEach((week, index) => {
    const previousEnd = new Date(`${weeks[index].to}T12:00:00Z`);
    previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
    assert.equal(week.from, previousEnd.toISOString().slice(0, 10));
  });
});

test('weekly rows still add up to the month total after fines are distributed', () => {
  const data = {
    masters: MASTERS,
    expenses: [{ date: '2026-08-05', section: 'ishxona', amount_uzs: 300_000 }],
  };
  const sales = [
    { master_id: 3, d: '2026-08-03', cash: 2_000_000, commission_pct: 40 },
    { master_id: 1, d: '2026-08-18', card: 1_000_000, commission_pct: 50 },
  ];
  const fines = [
    { master_id: 3, d: '2026-08-04', amount: 200_000 },
    { master_id: 1, d: '2026-08-19', amount: 9_000_000 },
  ];
  const weeks = overviewWeeklyMetrics(data, { from: '2026-08-01', to: '2026-08-31' }, sales, fines);

  const weeklySum = weeks.reduce((sum, week) => sum + week.salonRemainder, 0);
  const revenue = 3_000_000;
  const payout = masterPayoutForPeriod(MASTERS, sales, fines);
  assert.equal(Math.round(weeklySum), Math.round(revenue - payout));
});

test('only the absorbable part of a fine is recognized', () => {
  const sales = [{ master_id: 3, cash: 1_000_000, commission_pct: 40 }];
  assert.equal(recognizedFinesTotal(MASTERS, sales, [{ master_id: 3, amount: 100_000 }]), 100_000);
  assert.equal(recognizedFinesTotal(MASTERS, sales, [{ master_id: 3, amount: 900_000 }]), 400_000);
});

test('weekday index is Monday-based and immune to the local timezone', () => {
  assert.equal(weekdayIndex('2026-08-10'), 0);
  assert.equal(weekdayIndex('2026-08-16'), 6);
  assert.equal(weekdayIndex('not-a-date'), null);
});

test('weekday revenue averages per occurrence, not per month', () => {
  const sales = [
    { d: '2026-08-01', cash: 300_000, cl: 2 },
    { d: '2026-08-08', cash: 500_000, cl: 3 },
    { d: '2026-08-03', cash: 100_000, cl: 1 },
  ];
  const breakdown = weekdayBreakdown(sales);
  const saturday = breakdown[5];
  assert.equal(saturday.occurrences, 2);
  assert.equal(saturday.revenue, 800_000);
  assert.equal(saturday.averageRevenue, 400_000);
  assert.equal(saturday.averageClients, 2.5);
  assert.equal(breakdown[0].occurrences, 1);
  assert.equal(breakdown[1].occurrences, 0);
  assert.equal(breakdown[1].averageRevenue, 0);
});

test('lateness is measured against the shift start and never goes negative', () => {
  assert.equal(minutesLate('09:25', '09:00'), 25);
  assert.equal(minutesLate('08:40', '09:00'), 0);
  assert.equal(minutesLate('', '09:00'), 0);
});

test('lateness summary counts only the days that were actually late', () => {
  const attendance = [
    { master_id: 3, arrived: '09:30' },
    { master_id: 3, arrived: '10:00' },
    { master_id: 3, arrived: '08:55' },
  ];
  const [worst] = latenessSummary(MASTERS, attendance, [{ master_id: 3, amount: 50_000 }], '09:00');
  assert.equal(worst.name, 'Жавлон');
  assert.equal(worst.shifts, 3);
  assert.equal(worst.lateDays, 2);
  assert.equal(worst.totalLateMinutes, 90);
  assert.equal(worst.averageLateMinutes, 45);
  assert.equal(worst.fines, 50_000);
});

test('productivity separates working more from earning more', () => {
  const sales = [
    { master_id: 1, cash: 3_000_000, cl: 10 },
    { master_id: 3, cash: 3_000_000, cl: 10 },
  ];
  const attendance = [
    ...Array.from({ length: 20 }, () => ({ master_id: 1 })),
    ...Array.from({ length: 10 }, () => ({ master_id: 3 })),
  ];
  const [best, second] = shiftProductivity(MASTERS, sales, attendance);
  assert.equal(best.name, 'Жавлон');
  assert.equal(best.revenuePerShift, 300_000);
  assert.equal(second.revenuePerShift, 150_000);
});

test('a master with no attendance rows does not divide by zero', () => {
  const [only] = shiftProductivity(
    [{ id: 3, name: 'Жавлон', active: true }],
    [{ master_id: 3, cash: 500_000, cl: 2 }],
    [],
  );
  assert.equal(only.shifts, 0);
  assert.equal(only.revenuePerShift, 0);
  assert.equal(only.clientsPerShift, 0);
});

test('no-show rate ignores appointments that have not happened yet', () => {
  const summary = appointmentOutcomeSummary([
    { status: 'completed', price_uzs: 150_000 },
    { status: 'completed', price_uzs: 150_000 },
    { status: 'no_show', price_uzs: 200_000 },
    { status: 'cancelled', price_uzs: 100_000, cancelled_by: 'client' },
    { status: 'confirmed', price_uzs: 150_000 },
    { status: 'pending', price_uzs: 150_000 },
  ]);
  assert.equal(summary.total, 6);
  assert.equal(summary.resolved, 4);
  assert.equal(summary.upcoming, 2);
  assert.equal(summary.noShow, 1);
  assert.equal(summary.noShowRate, 25);
  assert.equal(summary.cancelledByClient, 1);
  assert.equal(summary.lostAmount, 300_000);
});

test('an empty calendar reports zero rates rather than NaN', () => {
  const summary = appointmentOutcomeSummary([]);
  assert.equal(summary.noShowRate, 0);
  assert.equal(summary.cancelledRate, 0);
  assert.equal(summary.lostAmount, 0);
});

test('payment mix shares add up and survive an empty period', () => {
  const mix = paymentMix([
    { cash: 600_000 },
    { card: 300_000 },
    { qr: 100_000 },
  ]);
  assert.equal(mix.total, 1_000_000);
  assert.equal(mix.cashShare, 60);
  assert.equal(mix.cardShare, 30);
  assert.equal(mix.qrShare, 10);

  const empty = paymentMix([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.cashShare, 0);
});
