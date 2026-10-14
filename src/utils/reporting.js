// Aggregates that decide what the owner sees on every screen. They used to live
// inside App.jsx, where no test could reach them, while calculations.js held a
// parallel set of helpers the app never called. Everything the screens actually
// use belongs here, under test.
import { localDate, rowDate } from './loadWindow.js';
import {
  grossMasterPayForSales,
  masterNetPay,
  operatingExpenses,
  rentOffsetIncome,
  saleClientsCount,
  saleTotal,
  totalExpenses,
  totalFines,
  totalSalesAmount,
} from './calculations.js';

export function inRange(value, from, to) {
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
}

// Legacy rows carry a name but no id, so the name stays as a fallback. Matching
// on the name first would lose a master's whole history the day he is renamed.
export function belongsToMaster(row, master) {
  if (row.master_id != null && master.id != null) {
    return String(row.master_id) === String(master.id);
  }
  return row.master === master.name;
}

// The first day a master shows up in any of these rows (a sale, a check-in),
// or null if he never does.
export function firstDayOf(master, ...collections) {
  let first = null;
  collections.flat().forEach((row) => {
    if (!belongsToMaster(row, master)) return;
    const day = rowDate(row);
    if (day && (!first || day < first)) first = day;
  });
  return first;
}

// A master who had not started by the end of the comparison window has no
// "before": his zero there is absence, not a slump, and "+100% · было 0" would
// read as growth.
export function startedAfter(firstDay, range) {
  return Boolean(range?.to) && (!firstDay || firstDay > range.to);
}

// A master who left still has to appear for the periods he worked, otherwise
// his revenue counts while his payout silently disappears.
export function mastersForPeriod(masters, sales, fines = []) {
  return masters.filter((master) => (
    master.active !== false
    || sales.some((sale) => belongsToMaster(sale, master))
    || fines.some((fine) => belongsToMaster(fine, master))
  ));
}

export function masterPayoutForPeriod(masters, sales, fines = []) {
  return mastersForPeriod(masters, sales, fines).reduce((sum, master) => {
    const rows = sales.filter((sale) => belongsToMaster(sale, master));
    const fineTotal = totalFines(fines.filter((fine) => belongsToMaster(fine, master)));
    return sum + masterNetPay(grossMasterPayForSales(rows, master), fineTotal);
  }, 0);
}

export function percentageDifference(current, previous) {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;
  return previousValue
    ? Math.round(((currentValue - previousValue) / Math.abs(previousValue)) * 100)
    : currentValue ? 100 : 0;
}

export function dayCount(from, to) {
  if (!from || !to) return 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

export function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return localDate(value);
}

export function previousRange(range, period) {
  if (!range?.from || !range?.to || period === 'all') return null;
  const from = new Date(`${range.from}T12:00:00`);
  const to = new Date(`${range.to}T12:00:00`);

  if (period === 'month') {
    return {
      from: localDate(new Date(from.getFullYear(), from.getMonth() - 1, 1)),
      to: localDate(new Date(from.getFullYear(), from.getMonth(), 0)),
    };
  }

  const durationDays = Math.round((to - from) / 86400000) + 1;
  const previousTo = new Date(from);
  previousTo.setDate(previousTo.getDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousFrom.getDate() - durationDays + 1);
  return { from: localDate(previousFrom), to: localDate(previousTo) };
}

// A calendar month is a full month from its first day, but on the 3rd only
// three days of it have happened. Comparing that against a whole previous month
// reported a 90% collapse every time a month turned over. The comparison window
// is trimmed to the days that have actually elapsed.
export function comparablePreviousRange(range, period, today) {
  const previous = previousRange(range, period);
  if (!previous || !today) return previous;
  if (!range.to || range.to <= today) return previous;

  const elapsed = dayCount(range.from, today < range.from ? range.from : today);
  if (elapsed <= 0) return previous;

  const trimmedTo = shiftDate(previous.from, elapsed - 1);
  return { from: previous.from, to: trimmedTo < previous.to ? trimmedTo : previous.to };
}

// The part of a range that has already finished. A period that runs into today
// stops at yesterday; one that starts today has nothing finished yet.
export function finishedRange(range, today) {
  if (!range?.from || !range?.to || !today || range.to < today) return range;
  if (range.from >= today) return null;
  return { from: range.from, to: shiftDate(today, -1) };
}

// Comparisons count finished days only. With today inside the window, a few
// hours of today stood against a whole day last month: on the 29th at noon
// that turned +27% into +18%. `current` is the part of the range to measure
// against `previous`; `inProgress` means nothing has finished yet (today alone,
// or the first day of a month) and the comparison is only a target to beat.
export function comparisonRanges(range, period, today) {
  const current = finishedRange(range, today);
  if (!current) {
    return { current: range, previous: comparablePreviousRange(range, period, today), inProgress: true };
  }
  return {
    current,
    previous: comparablePreviousRange(range, period, shiftDate(today, -1)),
    inProgress: false,
  };
}

export function monthWeekRanges(range) {
  const ranges = [];
  const monthEnd = new Date(`${range.to}T12:00:00`);
  let cursor = new Date(`${range.from}T12:00:00`);

  while (cursor <= monthEnd) {
    const weekEnd = new Date(cursor);
    const mondayBasedDay = (cursor.getDay() + 6) % 7;
    weekEnd.setDate(cursor.getDate() + (6 - mondayBasedDay));
    if (weekEnd > monthEnd) weekEnd.setTime(monthEnd.getTime());

    ranges.push({ from: localDate(cursor), to: localDate(weekEnd) });
    cursor = new Date(weekEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return ranges;
}

export function overviewWeeklyMetrics(data, range, sales, fines) {
  const reportMasters = mastersForPeriod(data.masters, sales, fines);
  const buckets = monthWeekRanges(range).map((week) => {
    const weekSales = sales.filter((sale) => inRange(rowDate(sale), week.from, week.to));
    const revenue = totalSalesAmount(weekSales);
    const grossMasterPay = reportMasters.reduce((sum, master) => {
      const masterSales = weekSales.filter((sale) => belongsToMaster(sale, master));
      return sum + grossMasterPayForSales(masterSales, master);
    }, 0);
    const weekExpenses = data.expenses
      .filter((expense) => inRange(rowDate(expense, 'date'), week.from, week.to));
    const expenses = totalExpenses(operatingExpenses(weekExpenses));
    const nonCashIncome = rentOffsetIncome(weekExpenses);

    return { ...week, revenue, grossMasterPay, recognizedFines: 0, expenses, nonCashIncome };
  });

  // A fine reduces a master's monthly payout only down to zero. Distributing the
  // recognized part by its actual week keeps the weekly rows equal to the month total.
  reportMasters.forEach((master) => {
    const masterSales = sales.filter((sale) => belongsToMaster(sale, master));
    const grossMasterPay = grossMasterPayForSales(masterSales, master);
    const masterFines = fines.filter((fine) => belongsToMaster(fine, master));
    const fineTotal = totalFines(masterFines);
    let remainingRecognizedFines = Math.min(grossMasterPay, fineTotal);

    buckets.forEach((bucket) => {
      if (remainingRecognizedFines <= 0) return;
      const bucketFines = totalFines(masterFines
        .filter((fine) => inRange(rowDate(fine), bucket.from, bucket.to)));
      const recognized = Math.min(bucketFines, remainingRecognizedFines);
      bucket.recognizedFines += recognized;
      remainingRecognizedFines -= recognized;
    });
  });

  return buckets.map((bucket) => {
    const salonRemainder = bucket.revenue - bucket.grossMasterPay + bucket.recognizedFines;
    return {
      ...bucket,
      salonRemainder,
      netProfit: salonRemainder - bucket.expenses,
      totalNetProfit: salonRemainder - bucket.expenses + bucket.nonCashIncome,
    };
  });
}

// Only the part of a fine that a payout could absorb ever reaches the salon.
// The tile used to show the amount issued, which never reconciled with cash.
export function recognizedFinesTotal(masters, sales, fines) {
  return mastersForPeriod(masters, sales, fines).reduce((sum, master) => {
    const gross = grossMasterPayForSales(sales.filter((sale) => belongsToMaster(sale, master)), master);
    const fineTotal = totalFines(fines.filter((fine) => belongsToMaster(fine, master)));
    return sum + Math.min(gross, fineTotal);
  }, 0);
}

export function timeToMinutes(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(total) {
  const value = Math.max(0, Math.trunc(Number(total) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function minutesLate(arrived, shiftStart = '09:00') {
  const arrivedMinutes = timeToMinutes(arrived);
  const shiftMinutes = timeToMinutes(shiftStart);
  if (arrivedMinutes == null || shiftMinutes == null) return 0;
  return Math.max(0, arrivedMinutes - shiftMinutes);
}

const WEEKDAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Monday-indexed, read at noon UTC so no timezone can push a date onto the
// neighbouring day.
export function weekdayIndex(date) {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return (new Date(parsed).getUTCDay() + 6) % 7;
}

// Which days are worth staffing heavily. Averaged per occurrence of that
// weekday, so a month with five Saturdays does not outrank one with four.
export function weekdayBreakdown(sales) {
  const buckets = WEEKDAY_NAMES.map((name, index) => ({
    index,
    name,
    short: WEEKDAY_SHORT[index],
    revenue: 0,
    clients: 0,
    days: new Set(),
  }));

  sales.forEach((sale) => {
    const date = rowDate(sale);
    const index = weekdayIndex(date);
    if (index == null) return;
    const bucket = buckets[index];
    bucket.revenue += saleTotal(sale);
    bucket.clients += saleClientsCount(sale);
    bucket.days.add(date);
  });

  return buckets.map((bucket) => {
    const occurrences = bucket.days.size;
    return {
      index: bucket.index,
      name: bucket.name,
      short: bucket.short,
      revenue: bucket.revenue,
      clients: bucket.clients,
      occurrences,
      averageRevenue: occurrences ? bucket.revenue / occurrences : 0,
      averageClients: occurrences ? bucket.clients / occurrences : 0,
    };
  });
}

// Rows stored before schedules had dates carry none: they are the week that
// was always in force.
export function scheduleVersionOf(rule) {
  return String(rule?.effective_from || '').slice(0, 10) || '0000-00-00';
}

// A master's week as it stood on a date. A change of hours is saved as a new
// version from its own date, so a past day is judged by the hours in force
// then, and moving a shift never rewrites last month's lateness.
export function scheduleRulesOn(master, date, scheduleRules = []) {
  if (!master || !date) return [];
  const own = scheduleRules.filter((rule) => (
    String(rule.master_id) === String(master.id) && rule.active !== false
  ));
  let version = null;
  own.forEach((rule) => {
    const from = scheduleVersionOf(rule);
    if (from <= date && (version == null || from > version)) version = from;
  });
  return version == null ? [] : own.filter((rule) => scheduleVersionOf(rule) === version);
}

// Every version of a master's week, oldest first.
export function scheduleVersions(master, scheduleRules = []) {
  const byVersion = new Map();
  scheduleRules
    .filter((rule) => String(rule.master_id) === String(master?.id) && rule.active !== false)
    .forEach((rule) => {
      const from = scheduleVersionOf(rule);
      if (!byVersion.has(from)) byVersion.set(from, []);
      byVersion.get(from).push(rule);
    });
  return [...byVersion.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([from, rules]) => ({ from, rules }));
}

// One line for a week: neighbouring days with the same hours are joined, so
// «Пн–Сб 14:00–22:00 · Вс 10:00–22:00» reads at a glance.
export function scheduleSummary(rules = []) {
  const hours = WEEKDAY_SHORT.map((_, index) => {
    const day = rules.filter((rule) => Number(rule.iso_weekday) === index + 1);
    if (!day.length) return null;
    const starts = day.map((rule) => String(rule.starts_at).slice(0, 5)).sort()[0];
    const ends = day.map((rule) => String(rule.ends_at).slice(0, 5)).sort().pop();
    return `${starts}–${ends}`;
  });
  const groups = [];
  hours.forEach((value, index) => {
    const last = groups[groups.length - 1];
    if (last && last.value === value) last.to = index;
    else groups.push({ from: index, to: index, value });
  });
  return groups
    .map(({ from, to, value }) => {
      const days = from === to ? WEEKDAY_SHORT[from] : `${WEEKDAY_SHORT[from]}–${WEEKDAY_SHORT[to]}`;
      return `${days} ${value || 'выходной'}`;
    })
    .join(' · ');
}

// How lateness is measured, read from settings. Until late_rule_since the salon
// kept one cutoff for everyone (shift_start, 10:10), and a master whose shift
// began later was judged from his own start. From that date, decided by the
// owner on 2026-10-14, each master is judged from his own scheduled start plus
// the same grace for everyone. A plain time string is the old rule alone.
export function lateRuleFrom(value) {
  if (value && typeof value === 'object') {
    const grace = Number(value.graceMinutes);
    return {
      shiftStart: value.shiftStart || '09:00',
      graceMinutes: Number.isFinite(grace) && grace >= 0 ? Math.trunc(grace) : 10,
      since: value.since ? String(value.since).slice(0, 10) : null,
    };
  }
  return { shiftStart: value || '09:00', graceMinutes: 0, since: null };
}

export function lateRuleFromSettings(settings = {}) {
  return lateRuleFrom({
    shiftStart: settings.shift_start,
    graceMinutes: settings.late_grace_minutes,
    since: settings.late_rule_since,
  });
}

// The start of a master's shift on a date by his schedule, or null when the
// schedule gives him that day off or he has none.
export function scheduledStartOn(master, date, scheduleRules = []) {
  const weekday = weekdayIndex(date);
  if (!master || weekday == null) return null;
  const starts = scheduleRulesOn(master, date, scheduleRules)
    .filter((rule) => Number(rule.iso_weekday) === weekday + 1)
    .map((rule) => timeToMinutes(rule.starts_at))
    .filter((minutes) => minutes != null);
  return starts.length ? minutesToTime(Math.min(...starts)) : null;
}

// The time after which an arrival counts as late, or null when nothing is late
// that day. Under the old rule the salon cutoff holds unless the master's own
// shift starts after it; under the new one it is his start plus the grace, and
// a day his schedule does not cover has no lateness at all.
export function shiftStartFor(master, date, scheduleRules = [], lateRule = '09:00') {
  const rule = lateRuleFrom(lateRule);
  const start = scheduledStartOn(master, date, scheduleRules);

  if (rule.since && date >= rule.since) {
    return start == null ? null : minutesToTime(timeToMinutes(start) + rule.graceMinutes);
  }

  if (start == null) return rule.shiftStart;
  const cutoff = timeToMinutes(rule.shiftStart);
  return cutoff == null || timeToMinutes(start) > cutoff ? start : rule.shiftStart;
}

// Who is systematically late and what it cost. The bot already computed this;
// the app never showed it.
export function latenessSummary(masters, attendance, fines, lateRule = '09:00', scheduleRules = []) {
  return mastersForPeriod(masters, attendance, fines).map((master) => {
    const records = attendance.filter((row) => belongsToMaster(row, master));
    const lateMinutes = records.map((row) => minutesLate(
      row.arrived_at || row.arrived,
      shiftStartFor(master, rowDate(row), scheduleRules, lateRule),
    ));
    const lateDays = lateMinutes.filter((value) => value > 0).length;
    const totalLateMinutes = lateMinutes.reduce((sum, value) => sum + value, 0);
    return {
      id: master.id,
      name: master.name,
      shifts: records.length,
      lateDays,
      totalLateMinutes,
      averageLateMinutes: lateDays ? Math.round(totalLateMinutes / lateDays) : 0,
      fines: totalFines(fines.filter((fine) => belongsToMaster(fine, master))),
    };
  }).sort((left, right) => right.totalLateMinutes - left.totalLateMinutes);
}

// A status for every master on every day up to today. The list used to be built
// from check-ins alone, so a day with no check-in and no day off simply was not
// there — the one day that needed a decision was the one nobody saw.
//
// A master is listed from his first check-in or sale, so a new hire's earlier
// days are not reported as missed, and a master who left is listed only up to
// his last one. A weekday his schedule does not cover counts as a day off.
export function attendanceGrid({
  masters,
  attendance,
  dayStatuses = [],
  scheduleRules = [],
  sales = [],
  range,
  today,
  shiftStart = '09:00',
  // lateRuleFromSettings(settings); a bare shiftStart is the old cutoff rule.
  lateRule = shiftStart,
}) {
  if (!range?.from || !range?.to || !today) return [];
  const last = range.to < today ? range.to : today;
  if (last < range.from) return [];

  const days = [];
  for (let day = range.from; day <= last; day = shiftDate(day, 1)) days.push(day);

  const rows = [];
  masters.forEach((master) => {
    const records = attendance.filter((row) => belongsToMaster(row, master));
    const activityDates = [...records, ...sales.filter((sale) => belongsToMaster(sale, master))]
      .map((row) => rowDate(row))
      .filter(Boolean)
      .sort();
    const inactive = master.active === false;
    if (inactive && !activityDates.some((day) => day >= range.from && day <= last)) return;
    const first = activityDates[0] || today;
    const lastActive = activityDates[activityDates.length - 1] || today;
    const byDay = new Map(records.map((row) => [rowDate(row), row]));

    days.forEach((day) => {
      if (day < first || (inactive && day > lastActive)) return;
      const record = byDay.get(day) || null;
      const dayOff = dayStatuses.some((status) => (
        String(status.master_id) === String(master.id) && status.work_date === day
      ));
      const weekday = weekdayIndex(day);
      const rules = scheduleRulesOn(master, day, scheduleRules);
      const scheduled = !rules.length || rules.some((rule) => Number(rule.iso_weekday) === weekday + 1);
      const start = shiftStartFor(master, day, scheduleRules, lateRule);
      const arrived = record ? (record.arrived || record.arrived_at || '') : '';
      const lateBy = arrived ? minutesLate(arrived, start) : 0;

      let status;
      if (dayOff) status = 'day-off';
      else if (record) status = lateBy > 0 ? 'late' : 'on-time';
      else if (!scheduled) status = 'day-off';
      else if (day === today) status = 'pending';
      else status = 'missing';

      rows.push({ master, d: day, record, arrived, lateBy, shiftStart: start, status, dayOff });
    });
  });

  return rows;
}

// One line per master for a period: how many days of each kind, and the
// minutes lost to lateness.
export function attendanceTotals(grid) {
  const totals = new Map();
  grid.forEach((row) => {
    const key = String(row.master.id ?? row.master.name);
    const entry = totals.get(key) || {
      master: row.master,
      onTime: 0,
      late: 0,
      lateMinutes: 0,
      dayOff: 0,
      missing: 0,
      pending: 0,
      days: [],
    };
    if (row.status === 'on-time') entry.onTime += 1;
    if (row.status === 'late') {
      entry.late += 1;
      entry.lateMinutes += row.lateBy;
    }
    if (row.status === 'day-off') entry.dayOff += 1;
    if (row.status === 'missing') entry.missing += 1;
    if (row.status === 'pending') entry.pending += 1;
    entry.days.push({ d: row.d, status: row.status, lateBy: row.lateBy });
    totals.set(key, entry);
  });
  return [...totals.values()].map((entry) => ({
    ...entry,
    days: entry.days.sort((left, right) => left.d.localeCompare(right.d)),
  }));
}

// Separates working more from earning more: two masters with equal revenue and
// unequal shift counts are not equally productive.
export function shiftProductivity(masters, sales, attendance, fines = []) {
  return mastersForPeriod(masters, sales, fines).map((master) => {
    const rows = sales.filter((sale) => belongsToMaster(sale, master));
    const shifts = attendance.filter((row) => belongsToMaster(row, master)).length;
    const revenue = totalSalesAmount(rows);
    const clientCount = rows.reduce((sum, sale) => sum + saleClientsCount(sale), 0);
    // He cannot have earned on more days than he was recorded present. When he
    // has, the check-ins are missing — backfilled sales, a forgotten button —
    // and dividing by them invents a figure that outranks everyone.
    const saleDays = new Set(rows.map((sale) => rowDate(sale)).filter(Boolean)).size;
    const reliable = shifts > 0 && shifts >= saleDays;
    return {
      id: master.id,
      name: master.name,
      shifts,
      saleDays,
      reliable,
      revenue,
      clients: clientCount,
      revenuePerShift: reliable ? revenue / shifts : 0,
      clientsPerShift: reliable ? clientCount / shifts : 0,
    };
  }).sort((left, right) => right.revenuePerShift - left.revenuePerShift);
}

export function paymentMix(sales) {
  const cash = sales.reduce((sum, sale) => sum + (Number(sale.cash) || 0), 0);
  const card = sales.reduce((sum, sale) => sum + (Number(sale.card) || 0), 0);
  const qr = sales.reduce((sum, sale) => sum + (Number(sale.qr) || 0), 0);
  const total = cash + card + qr;
  return {
    cash,
    card,
    qr,
    total,
    cashShare: total ? (cash / total) * 100 : 0,
    cardShare: total ? (card / total) * 100 : 0,
    qrShare: total ? (qr / total) * 100 : 0,
  };
}

// New against returning is the only figure that says whether a master is
// building a base or living off one. The flag is null on rows written before it
// existed and on zero-client rows, so those are reported on their own rather
// than folded into either side and quietly inflating it.
export function clientBreakdown(sales) {
  return sales.reduce((summary, sale) => {
    const count = saleClientsCount(sale);
    summary.clients += count;
    if (sale.is_new_client === true) summary.newClients += count;
    else if (sale.is_new_client === false) summary.returningClients += count;
    else summary.unlabeled += count;
    return summary;
  }, { clients: 0, newClients: 0, returningClients: 0, unlabeled: 0 });
}
