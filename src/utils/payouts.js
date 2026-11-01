// Weekly payouts and advances (owner's decisions of 2026-10-16). A week runs
// Monday to Sunday and is paid on Sunday night. An advance is the master's own
// money paid early: it lowers what is still owed for its week and nothing else
// — not the master's earnings, not the salon's profit.
import { grossMasterPayForSales, totalFines } from './calculations.js';
import { rowDate } from './loadWindow.js';
import { belongsToMaster, shiftDate } from './reporting.js';

// Monday of the week a date falls in, read at noon UTC so no timezone moves it.
export function weekStartOf(date) {
  const day = new Date(`${date}T12:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

export function weekOf(date) {
  const from = weekStartOf(date);
  return { from, to: shiftDate(from, 6) };
}

const inWeek = (date, week) => Boolean(date) && date >= week.from && date <= week.to;

// The first week whose remainder opens the next one (owner's «да» of
// 2026-11-01, audit №11): a debt for an advance, a fine written after the
// payout, a fine bigger than the week's earnings or a sum not handed over
// used to stay in its own week and be forgotten. Weeks before it carry nothing.
export const CARRY_FROM = '2026-10-26';

// One master's week. `sales` are the counted ones; earned is his commission
// on them, due is what is left to hand over: earned less fines, less advances,
// less what was already paid for the week, with what the week before left
// (`carried`: owed to him if positive, his debt if negative). A negative due
// is his debt, and goes on to the next week.
export function masterWeek({ master, sales = [], fines = [], advances = [], payouts = [], week }) {
  const mine = (row) => belongsToMaster(row, master);
  const own = {
    sales: sales.filter(mine),
    fines: fines.filter(mine),
    advances: advances.filter(mine),
    payouts: payouts.filter(mine),
  };
  let carried = 0;
  for (let from = CARRY_FROM; from < week.from; from = shiftDate(from, 7)) {
    carried = weekOfOwnRows(master, own, weekOf(from), carried).due;
  }
  return weekOfOwnRows(master, own, week, carried);
}

function weekOfOwnRows(master, own, week, carried) {
  const earned = Math.round(grossMasterPayForSales(own.sales.filter((sale) => inWeek(rowDate(sale), week)), master));
  const fineTotal = totalFines(own.fines.filter((fine) => inWeek(rowDate(fine), week)));
  const weekAdvances = own.advances
    .filter((advance) => inWeek(advance.given_on, week))
    .sort((left, right) => String(left.given_on).localeCompare(String(right.given_on)));
  const advanceTotal = weekAdvances.reduce((sum, advance) => sum + (Number(advance.amount) || 0), 0);
  const weekPayouts = own.payouts.filter((payout) => payout.week_start === week.from);
  const paid = weekPayouts.reduce((sum, payout) => sum + (Number(payout.amount) || 0), 0);
  const net = earned - fineTotal;
  return {
    master,
    earned,
    fines: fineTotal,
    net,
    advances: advanceTotal,
    advanceRows: weekAdvances,
    paid,
    payoutRows: weekPayouts,
    carried,
    due: net - advanceTotal - paid + carried,
  };
}

// Every master the week concerns: the active ones, and anyone who left but has
// visits, fines, advances, a payout or a remainder in it.
export function weekPayouts({ masters = [], sales = [], fines = [], advances = [], payouts = [], week }) {
  return masters
    .map((master) => masterWeek({ master, sales, fines, advances, payouts, week }))
    .filter((row) => row.master.active !== false || row.earned || row.fines || row.advances || row.paid || row.carried);
}
