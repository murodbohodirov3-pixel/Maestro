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

// Who is systematically late and what it cost. The bot already computed this;
// the app never showed it.
export function latenessSummary(masters, attendance, fines, shiftStart = '09:00') {
  return mastersForPeriod(masters, attendance, fines).map((master) => {
    const records = attendance.filter((row) => belongsToMaster(row, master));
    const lateMinutes = records.map((row) => minutesLate(row.arrived_at || row.arrived, shiftStart));
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

// Separates working more from earning more: two masters with equal revenue and
// unequal shift counts are not equally productive.
export function shiftProductivity(masters, sales, attendance, fines = []) {
  return mastersForPeriod(masters, sales, fines).map((master) => {
    const rows = sales.filter((sale) => belongsToMaster(sale, master));
    const shifts = attendance.filter((row) => belongsToMaster(row, master)).length;
    const revenue = totalSalesAmount(rows);
    const clientCount = rows.reduce((sum, sale) => sum + saleClientsCount(sale), 0);
    return {
      id: master.id,
      name: master.name,
      shifts,
      revenue,
      clients: clientCount,
      revenuePerShift: shifts ? revenue / shifts : 0,
      clientsPerShift: shifts ? clientCount / shifts : 0,
    };
  }).sort((left, right) => right.revenuePerShift - left.revenuePerShift);
}

// Empty chair time and what it cost. Every field here is already written by the
// calendar; none of it was ever aggregated.
export function appointmentOutcomeSummary(appointments) {
  const counts = { total: 0, completed: 0, noShow: 0, cancelled: 0, upcoming: 0 };
  let lostAmount = 0;
  let cancelledByClient = 0;
  let cancelledBySalon = 0;

  appointments.forEach((appointment) => {
    counts.total += 1;
    const price = Number(appointment.price_uzs) || 0;
    if (appointment.status === 'completed') counts.completed += 1;
    else if (appointment.status === 'no_show') {
      counts.noShow += 1;
      lostAmount += price;
    } else if (appointment.status === 'cancelled') {
      counts.cancelled += 1;
      lostAmount += price;
      if (appointment.cancelled_by === 'client') cancelledByClient += 1;
      if (appointment.cancelled_by === 'salon') cancelledBySalon += 1;
    } else counts.upcoming += 1;
  });

  // Pending visits have not failed yet, so they must stay out of the rate or a
  // busy upcoming week would look like an improvement.
  const resolved = counts.completed + counts.noShow + counts.cancelled;
  return {
    ...counts,
    resolved,
    cancelledByClient,
    cancelledBySalon,
    lostAmount,
    noShowRate: resolved ? (counts.noShow / resolved) * 100 : 0,
    cancelledRate: resolved ? (counts.cancelled / resolved) * 100 : 0,
  };
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
