// Where the salon is heading rather than where it stands: the month's pace,
// the months behind it, and the changes worth acting on. Every figure is built
// from the same helpers the rest of the app uses, so a month's revenue or
// profit here is the number the other screens show for that month.
import { localDate, rowDate } from './loadWindow.js';
import {
  belongsToMaster,
  clientBreakdown,
  dayCount,
  inRange,
  masterPayoutForPeriod,
  mastersForPeriod,
  percentageDifference,
  shiftDate,
} from './reporting.js';
import { operatingExpenses, totalExpenses, totalFines, totalSalesAmount } from './calculations.js';

export function monthStart(day) {
  return `${String(day).slice(0, 7)}-01`;
}

export function monthEnd(day) {
  const [year, month] = String(day).split('-').map(Number);
  return localDate(new Date(year, month, 0));
}

export function addMonths(day, count) {
  const [year, month] = String(day).split('-').map(Number);
  return localDate(new Date(year, month - 1 + count, 1));
}

export function salesIn(sales, from, to) {
  return sales.filter((sale) => inRange(rowDate(sale), from, to));
}

// Share of returning clients among the clients whose type is known. Rows from
// before the new/returning flag existed are left out rather than counted as
// either, so the share is null for months that have none labelled.
export function returningShare(sales) {
  const mix = clientBreakdown(sales);
  const labelled = mix.newClients + mix.returningClients;
  return labelled ? (mix.returningClients / labelled) * 100 : null;
}

export function summarizeSales(sales) {
  const revenue = totalSalesAmount(sales);
  const mix = clientBreakdown(sales);
  return {
    revenue,
    clients: mix.clients,
    newClients: mix.newClients,
    returningClients: mix.returningClients,
    labelledClients: mix.newClients + mix.returningClients,
    averageCheck: mix.clients ? revenue / mix.clients : 0,
    returningShare: returningShare(sales),
  };
}

// The month at its current pace. Only finished days count: at noon today is a
// fraction of a day, and scaling it up would drag the forecast down every
// morning. `sales` must already exclude pending and rejected rows.
export function monthForecast(sales, today) {
  const from = monthStart(today);
  const to = monthEnd(today);
  const daysInMonth = dayCount(from, to);
  const completedDays = dayCount(from, today) - 1;
  if (completedDays < 1) return null;

  const done = summarizeSales(salesIn(sales, from, shiftDate(today, -1)));
  const scale = daysInMonth / completedDays;
  const previousFrom = addMonths(today, -1);
  const previousTo = monthEnd(previousFrom);
  const previous = summarizeSales(salesIn(sales, previousFrom, previousTo));
  const revenue = done.revenue * scale;

  return {
    from,
    to,
    daysInMonth,
    completedDays,
    revenueSoFar: done.revenue,
    revenue,
    clients: done.clients * scale,
    previous: { from: previousFrom, to: previousTo, revenue: previous.revenue, clients: previous.clients },
    revenueChange: previous.revenue ? percentageDifference(revenue, previous.revenue) : null,
  };
}

// Month by month, oldest first, starting no earlier than the first sale. The
// current month runs to its last day, the same window Обзор uses, so its
// profit matches the headline figure exactly. Profit is only computed when the
// masters are given, because a single master's months have no profit.
export function monthlySeries({ sales, fines = [], expenses = [], masters = null, today, months = 12 }) {
  const firstSale = sales.reduce((first, sale) => {
    const day = rowDate(sale);
    return day && (!first || day < first) ? day : first;
  }, '');
  const series = [];

  for (let back = months - 1; back >= 0; back -= 1) {
    const from = addMonths(today, -back);
    if (firstSale && from < monthStart(firstSale)) continue;
    const to = monthEnd(from);
    const monthSales = salesIn(sales, from, to);
    const monthFines = fines.filter((fine) => inRange(rowDate(fine), from, to));
    const row = {
      key: from.slice(0, 7),
      from,
      to,
      isCurrent: back === 0,
      ...summarizeSales(monthSales),
      fines: totalFines(monthFines),
    };

    if (masters) {
      const monthExpenses = expenses.filter((expense) => inRange(rowDate(expense, 'date'), from, to));
      row.profit = row.revenue
        - masterPayoutForPeriod(masters, monthSales, monthFines)
        - totalExpenses(operatingExpenses(monthExpenses));
    }

    series.push(row);
  }

  return series;
}

export function compactMoney(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1).replace('.', ',')} млн`;
  }
  return Math.round(number).toLocaleString('ru-RU');
}

function signed(percent) {
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`;
}

// The changes worth acting on, in words. Finished days of this month are set
// against the same days of the last one, so a half-finished today never reads
// as a slump. Below a handful of days the comparison is noise, and the list
// says so instead of guessing.
export function attentionSignals({ sales, masters = [], today, minDays = 5 }) {
  const from = monthStart(today);
  const yesterday = shiftDate(today, -1);
  const completedDays = dayCount(from, today) - 1;
  if (completedDays < minDays) return { ready: false, completedDays, signals: [] };

  const previousFrom = addMonths(today, -1);
  const previousFullTo = monthEnd(previousFrom);
  const previousSameDay = shiftDate(previousFrom, completedDays - 1);
  const previousTo = previousSameDay < previousFullTo ? previousSameDay : previousFullTo;

  const currentSales = salesIn(sales, from, yesterday);
  const previousSales = salesIn(sales, previousFrom, previousTo);
  const now = summarizeSales(currentSales);
  const before = summarizeSales(previousSales);
  const signals = [];
  const add = (tone, weight, title, detail) => signals.push({ tone, weight, title, detail });

  if (before.revenue > 0) {
    const change = percentageDifference(now.revenue, before.revenue);
    const detail = `${compactMoney(now.revenue)} против ${compactMoney(before.revenue)} за те же дни`;
    if (change <= -5) add('bad', Math.abs(change) * 1.5, `Выручка ниже на ${Math.abs(change)}%`, detail);
    else if (change >= 10) add('good', change * 1.5, `Выручка выше на ${change}%`, detail);
  }

  if (before.newClients >= 10) {
    const change = percentageDifference(now.newClients, before.newClients);
    if (change <= -10) {
      add('bad', Math.abs(change), `Новых клиентов меньше на ${Math.abs(change)}%`,
        `${now.newClients} против ${before.newClients} — стоит усилить рекламу`);
    } else if (change >= 15) {
      add('good', change, `Новых клиентов больше на ${change}%`, `${now.newClients} против ${before.newClients}`);
    }
  }

  if (now.clients >= 20 && before.clients >= 20) {
    const change = percentageDifference(now.averageCheck, before.averageCheck);
    const detail = `${compactMoney(now.averageCheck)} против ${compactMoney(before.averageCheck)}`;
    if (change <= -5) add('bad', Math.abs(change), `Средний чек упал на ${Math.abs(change)}%`, detail);
    else if (change >= 5) add('good', change, `Средний чек вырос на ${change}%`, detail);
  }

  if (now.labelledClients >= 20 && before.labelledClients >= 20) {
    const points = Math.round(now.returningShare - before.returningShare);
    const detail = `${Math.round(now.returningShare)}% против ${Math.round(before.returningShare)}%`;
    if (points <= -5) add('bad', Math.abs(points), 'Постоянных клиентов стало меньше', detail);
    else if (points >= 5) add('good', points, 'Клиенты чаще возвращаются', detail);
  }

  const lastWeek = totalSalesAmount(salesIn(sales, shiftDate(today, -7), yesterday));
  const weekBefore = totalSalesAmount(salesIn(sales, shiftDate(today, -14), shiftDate(today, -8)));
  if (weekBefore > 0) {
    const change = percentageDifference(lastWeek, weekBefore);
    const detail = `${compactMoney(lastWeek)} против ${compactMoney(weekBefore)}`;
    if (change <= -10) add('bad', Math.abs(change), `Последние 7 дней слабее на ${Math.abs(change)}%`, detail);
    else if (change >= 10) add('good', change, `Последние 7 дней сильнее на ${change}%`, detail);
  }

  mastersForPeriod(masters, [...currentSales, ...previousSales])
    .filter((master) => master.active !== false)
    .forEach((master) => {
      const mine = summarizeSales(currentSales.filter((sale) => belongsToMaster(sale, master)));
      const earlier = summarizeSales(previousSales.filter((sale) => belongsToMaster(sale, master)));
      const change = percentageDifference(mine.revenue, earlier.revenue);
      if (earlier.revenue >= 1_500_000 && change <= -20) {
        add('bad', Math.abs(change), `${master.name}: выручка ${signed(change)}`,
          `${compactMoney(mine.revenue)} против ${compactMoney(earlier.revenue)}`);
      } else if (earlier.revenue >= 1_000_000 && change >= 30) {
        add('good', change * 0.8, `${master.name}: выручка ${signed(change)}`,
          `${compactMoney(mine.revenue)} против ${compactMoney(earlier.revenue)}`);
      }

      const newChange = percentageDifference(mine.newClients, earlier.newClients);
      if (earlier.newClients >= 5 && newChange <= -40) {
        add('bad', Math.abs(newChange) * 0.8, `${master.name}: новых клиентов ${mine.newClients} против ${earlier.newClients}`,
          `${signed(newChange)} к тем же дням прошлого месяца`);
      }
    });

  const byWeight = (left, right) => right.weight - left.weight;
  return {
    ready: true,
    completedDays,
    range: { from, to: yesterday },
    previousRange: { from: previousFrom, to: previousTo },
    signals: [
      ...signals.filter((signal) => signal.tone === 'bad').sort(byWeight).slice(0, 6),
      ...signals.filter((signal) => signal.tone === 'good').sort(byWeight).slice(0, 4),
    ],
  };
}
