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

// One master's week. `sales` are the counted ones; earned is his commission
// on them, due is what is left to hand over: earned less fines, less advances,
// less what was already paid for the week. A negative due means he took more
// in advances than the week brought.
export function masterWeek({ master, sales = [], fines = [], advances = [], payouts = [], week }) {
  const mine = (row) => belongsToMaster(row, master);
  const earned = Math.round(grossMasterPayForSales(sales.filter((sale) => mine(sale) && inWeek(rowDate(sale), week)), master));
  const fineTotal = totalFines(fines.filter((fine) => mine(fine) && inWeek(rowDate(fine), week)));
  const weekAdvances = advances
    .filter((advance) => mine(advance) && inWeek(advance.given_on, week))
    .sort((left, right) => String(left.given_on).localeCompare(String(right.given_on)));
  const advanceTotal = weekAdvances.reduce((sum, advance) => sum + (Number(advance.amount) || 0), 0);
  const weekPayouts = payouts.filter((payout) => mine(payout) && payout.week_start === week.from);
  const paid = weekPayouts.reduce((sum, payout) => sum + (Number(payout.amount) || 0), 0);
  const net = Math.max(0, earned - fineTotal);
  return {
    master,
    earned,
    fines: fineTotal,
    net,
    advances: advanceTotal,
    advanceRows: weekAdvances,
    paid,
    payoutRows: weekPayouts,
    due: net - advanceTotal - paid,
  };
}

// Every master the week concerns: the active ones, and anyone who left but has
// visits, fines, advances or a payout in it.
export function weekPayouts({ masters = [], sales = [], fines = [], advances = [], payouts = [], week }) {
  return masters
    .map((master) => masterWeek({ master, sales, fines, advances, payouts, week }))
    .filter((row) => row.master.active !== false || row.earned || row.fines || row.advances || row.paid);
}
