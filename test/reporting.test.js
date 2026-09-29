import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceGrid,
  attendanceTotals,
  belongsToMaster,
  clientBreakdown,
  comparablePreviousRange,
  comparisonRanges,
  dayCount,
  finishedRange,
  firstDayOf,
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
  shiftStartFor,
  startedAfter,
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

// 2026-09-07 is a Monday and 2026-09-06 the Sunday before it.
const AFTERNOON_RULES = [
  { master_id: 3, iso_weekday: 1, starts_at: '14:00:00', active: true },
  { master_id: 3, iso_weekday: 7, starts_at: '10:00:00', active: true },
];

test('a shift that starts after the salon cutoff moves the late threshold', () => {
  const javlon = MASTERS[1];
  assert.equal(shiftStartFor(javlon, '2026-09-07', AFTERNOON_RULES, '10:10'), '14:00');
  // Sunday puts him back on the morning shift, where the salon cutoff and its
  // ten minutes of grace still rule.
  assert.equal(shiftStartFor(javlon, '2026-09-06', AFTERNOON_RULES, '10:10'), '10:10');
  // Nobody else is touched: no rule of his own means the salon cutoff.
  assert.equal(shiftStartFor(MASTERS[0], '2026-09-07', AFTERNOON_RULES, '10:10'), '10:10');
  const disabled = AFTERNOON_RULES.map((rule) => ({ ...rule, active: false }));
  assert.equal(shiftStartFor(javlon, '2026-09-07', disabled, '10:10'), '10:10');
});

test('lateness is measured against the afternoon shift, not the salon cutoff', () => {
  const attendance = [
    { master_id: 3, d: '2026-09-07', arrived: '13:55' },
    { master_id: 3, d: '2026-09-07', arrived: '14:20' },
  ];
  const scheduled = latenessSummary(MASTERS, attendance, [], '10:10', AFTERNOON_RULES)
    .find((row) => row.id === 3);
  assert.equal(scheduled.lateDays, 1);
  assert.equal(scheduled.totalLateMinutes, 20);

  // Without the schedule both arrivals read as hours of lateness.
  const blind = latenessSummary(MASTERS, attendance, [], '10:10').find((row) => row.id === 3);
  assert.equal(blind.lateDays, 2);
  assert.equal(blind.totalLateMinutes, 475);
});

test('productivity separates working more from earning more', () => {
  const sales = [
    { master_id: 1, d: '2026-08-01', cash: 3_000_000, cl: 10 },
    { master_id: 3, d: '2026-08-01', cash: 3_000_000, cl: 10 },
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
    [{ master_id: 3, d: '2026-08-01', cash: 500_000, cl: 2 }],
    [],
  );
  assert.equal(only.shifts, 0);
  assert.equal(only.revenuePerShift, 0);
  assert.equal(only.clientsPerShift, 0);
});

test('fewer check-ins than selling days makes the per-shift figure unreliable', () => {
  // Backfilled sales: eleven days of takings against a single check-in would
  // otherwise report an eleven-fold productivity and top the ranking.
  const sales = Array.from({ length: 11 }, (_, day) => ({
    master_id: 3,
    d: `2026-08-${String(day + 1).padStart(2, '0')}`,
    cash: 300_000,
    cl: 2,
  }));
  const byId = (rows, id) => rows.find((row) => row.id === id);

  const sparse = byId(shiftProductivity(MASTERS, sales, [{ master_id: 3 }]), 3);
  assert.equal(sparse.shifts, 1);
  assert.equal(sparse.saleDays, 11);
  assert.equal(sparse.reliable, false);
  assert.equal(sparse.revenuePerShift, 0);

  const covered = byId(
    shiftProductivity(MASTERS, sales, sales.map((sale) => ({ master_id: 3, d: sale.d }))),
    3,
  );
  assert.equal(covered.reliable, true);
  assert.equal(covered.revenuePerShift, 300_000);
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

test('client breakdown counts heads, not rows, and keeps unlabeled rows apart', () => {
  const sales = [
    { cash: 100, clients_count: 2, is_new_client: true },
    { cash: 100, clients_count: 1, is_new_client: true },
    { cash: 100, clients_count: 3, is_new_client: false },
    { cash: 100, clients_count: 1, is_new_client: null },
    { cash: 100, clients_count: 1 },
  ];
  assert.deepEqual(clientBreakdown(sales), {
    clients: 8,
    newClients: 3,
    returningClients: 3,
    unlabeled: 2,
  });
});

test('client breakdown of an empty period is all zeros', () => {
  assert.deepEqual(clientBreakdown([]), {
    clients: 0,
    newClients: 0,
    returningClients: 0,
    unlabeled: 0,
  });
});

test('the finished part of a period stops at yesterday', () => {
  assert.deepEqual(finishedRange({ from: '2026-09-01', to: '2026-09-30' }, '2026-09-29'), { from: '2026-09-01', to: '2026-09-28' });
  assert.deepEqual(finishedRange({ from: '2026-08-01', to: '2026-08-31' }, '2026-09-29'), { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(finishedRange({ from: '2026-09-29', to: '2026-09-29' }, '2026-09-29'), null);
});

test('a running month is compared on finished days only', () => {
  const result = comparisonRanges({ from: '2026-09-01', to: '2026-09-30' }, 'month', '2026-09-29');
  assert.deepEqual(result.current, { from: '2026-09-01', to: '2026-09-28' });
  assert.deepEqual(result.previous, { from: '2026-08-01', to: '2026-08-28' });
  assert.equal(result.inProgress, false);
});

test('a running week is compared on its finished days', () => {
  const result = comparisonRanges({ from: '2026-09-28', to: '2026-10-04' }, 'week', '2026-09-30');
  assert.deepEqual(result.current, { from: '2026-09-28', to: '2026-09-29' });
  assert.deepEqual(result.previous, { from: '2026-09-21', to: '2026-09-22' });
});

test('today alone and the first of a month have nothing finished yet', () => {
  const today = comparisonRanges({ from: '2026-09-29', to: '2026-09-29' }, 'day', '2026-09-29');
  assert.equal(today.inProgress, true);
  assert.deepEqual(today.previous, { from: '2026-09-28', to: '2026-09-28' });
  const firstDay = comparisonRanges({ from: '2026-10-01', to: '2026-10-31' }, 'month', '2026-10-01');
  assert.equal(firstDay.inProgress, true);
  assert.deepEqual(firstDay.previous, { from: '2026-09-01', to: '2026-09-01' });
});

test('a past period is compared whole', () => {
  const result = comparisonRanges({ from: '2026-08-01', to: '2026-08-31' }, 'custom', '2026-09-29');
  assert.deepEqual(result.current, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(result.previous, { from: '2026-07-01', to: '2026-07-31' });
});

test('every master has a status on every day, including a missed check-in', () => {
  const masters = [
    { id: 1, name: 'Жавохир', active: true },
    { id: 3, name: 'Жавлон', active: true },
  ];
  const attendance = [
    { master_id: 1, master: 'Жавохир', d: '2026-09-26', arrived: '09:55' },
    { master_id: 1, master: 'Жавохир', d: '2026-09-27', arrived: '10:25' },
    { master_id: 3, master: 'Жавлон', d: '2026-09-26', arrived: '13:50' },
  ];
  const dayStatuses = [{ master_id: 3, work_date: '2026-09-27', status: 'day_off' }];
  const scheduleRules = [
    ...[1, 2, 3, 4, 5, 6, 7].map((iso) => ({ master_id: 1, iso_weekday: iso, starts_at: '10:00', active: true })),
    ...[1, 2, 3, 4, 5, 6, 7].map((iso) => ({ master_id: 3, iso_weekday: iso, starts_at: '14:00', active: true })),
  ];
  const grid = attendanceGrid({
    masters,
    attendance,
    dayStatuses,
    scheduleRules,
    range: { from: '2026-09-26', to: '2026-09-30' },
    today: '2026-09-29',
    shiftStart: '09:00',
  });
  const status = (id, d) => grid.find((row) => row.master.id === id && row.d === d)?.status;
  assert.equal(status(1, '2026-09-26'), 'on-time');
  assert.equal(status(1, '2026-09-27'), 'late');
  assert.equal(status(1, '2026-09-28'), 'missing');
  assert.equal(status(1, '2026-09-29'), 'pending');
  assert.equal(status(1, '2026-09-30'), undefined, 'days after today are not listed');
  assert.equal(status(3, '2026-09-26'), 'on-time', 'judged against his own 14:00 shift');
  assert.equal(status(3, '2026-09-27'), 'day-off');
  assert.equal(status(3, '2026-09-28'), 'missing');
  assert.equal(grid.find((row) => row.master.id === 1 && row.d === '2026-09-27').lateBy, 25);

  const [javohir, javlon] = attendanceTotals(grid);
  assert.deepEqual(
    [javohir.onTime, javohir.late, javohir.lateMinutes, javohir.dayOff, javohir.missing, javohir.pending],
    [1, 1, 25, 0, 1, 1],
  );
  assert.deepEqual([javlon.onTime, javlon.dayOff, javlon.missing], [1, 1, 1]);
  assert.deepEqual(javohir.days.map((day) => day.d), ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
});

test('a master is listed only while he worked', () => {
  const masters = [
    { id: 5, name: 'Новый', active: true },
    { id: 7, name: 'Ушёл', active: false },
    { id: 8, name: 'Давно ушёл', active: false },
  ];
  const attendance = [
    { master_id: 5, d: '2026-09-27', arrived: '09:00' },
    { master_id: 7, d: '2026-09-25', arrived: '09:00' },
    { master_id: 8, d: '2026-08-01', arrived: '09:00' },
  ];
  const grid = attendanceGrid({ masters, attendance, range: { from: '2026-09-24', to: '2026-09-28' }, today: '2026-09-29' });
  const daysOf = (id) => grid.filter((row) => row.master.id === id).map((row) => row.d);
  assert.deepEqual(daysOf(5), ['2026-09-27', '2026-09-28'], 'nothing before the first check-in');
  assert.deepEqual(daysOf(7), ['2026-09-25'], 'nothing after the last one for a master who left');
  assert.deepEqual(daysOf(8), [], 'a master gone before the period does not appear');
});

test('a weekday outside the schedule is a day off, not a miss', () => {
  const masters = [{ id: 1, name: 'А', active: true }];
  const attendance = [{ master_id: 1, d: '2026-09-21', arrived: '10:00' }];
  const scheduleRules = [1, 2, 3, 4, 5, 6].map((iso) => ({ master_id: 1, iso_weekday: iso, starts_at: '10:00', active: true }));
  const grid = attendanceGrid({ masters, attendance, scheduleRules, range: { from: '2026-09-27', to: '2026-09-27' }, today: '2026-09-29' });
  assert.equal(grid[0].status, 'day-off');
});

test('a master is dated from his first sale or check-in, whichever came first', () => {
  const master = { id: 24, name: 'Салим' };
  const sales = [
    { master_id: 24, d: '2026-09-25' },
    { master_id: 1, d: '2026-09-01' },
  ];
  const attendance = [{ master_id: 24, d: '2026-09-24' }];
  assert.equal(firstDayOf(master, sales, attendance), '2026-09-24');
  assert.equal(firstDayOf(master, sales), '2026-09-25');
  assert.equal(firstDayOf({ id: 99, name: 'Никто' }, sales, attendance), null);
});

test('only a master who started after the comparison window counts as new', () => {
  const august = { from: '2026-08-01', to: '2026-08-28' };
  assert.equal(startedAfter('2026-09-24', august), true);
  assert.equal(startedAfter(null, august), true);
  // Worked the last day of the window: his zero before is a real zero.
  assert.equal(startedAfter('2026-08-28', august), false);
  assert.equal(startedAfter('2026-04-01', august), false);
  // Early October is still compared with 1–N September, before he started.
  assert.equal(startedAfter('2026-09-24', { from: '2026-09-01', to: '2026-09-04' }), true);
  assert.equal(startedAfter('2026-09-24', null), false);
});
