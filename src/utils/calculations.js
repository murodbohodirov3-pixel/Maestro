export function saleTotal(sale) {
  return (Number(sale.cash) || 0) + (Number(sale.card) || 0) + (Number(sale.qr) || 0);
}

export function totalSalesAmount(sales) {
  return sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
}

export function totalCash(sales) {
  return sales.reduce((sum, sale) => sum + (Number(sale.cash) || 0), 0);
}

export function totalCard(sales) {
  return sales.reduce((sum, sale) => sum + (Number(sale.card) || 0), 0);
}

export function totalQr(sales) {
  return sales.reduce((sum, sale) => sum + (Number(sale.qr) || 0), 0);
}

export function totalExpenses(expenses) {
  return expenses.reduce((sum, expense) => sum + (Number(expense.amount_uzs) || 0), 0);
}

export function totalFines(fines) {
  return fines.reduce((sum, fine) => sum + (Number(fine.amount) || 0), 0);
}

export function masterRevenue(sales, masterId) {
  return totalSalesAmount(sales.filter((sale) => String(sale.master_id) === String(masterId)));
}

export function masterApprovedRevenue(sales, masterId) {
  return masterRevenue(
    sales.filter((sale) => sale.status === 'approved'),
    masterId,
  );
}

function saleClientsValue(sale) {
  return Number(sale.clients_count ?? sale.cl ?? 1) || 1;
}

export function masterClientsCount(sales, masterId) {
  return sales
    .filter((sale) => String(sale.master_id) === String(masterId))
    .reduce((sum, sale) => sum + saleClientsValue(sale), 0);
}

export function masterNewClientsCount(sales, masterId) {
  return sales
    .filter((sale) => String(sale.master_id) === String(masterId) && sale.is_new_client === true)
    .reduce((sum, sale) => sum + saleClientsValue(sale), 0);
}

export function masterOldClientsCount(sales, masterId) {
  return sales
    .filter((sale) => String(sale.master_id) === String(masterId) && sale.is_new_client === false)
    .reduce((sum, sale) => sum + saleClientsValue(sale), 0);
}

export function masterGrossPay(revenue, pct) {
  return (Number(revenue) || 0) * (Number(pct) || 0) / 100;
}

export function masterFines(fines, masterId) {
  return totalFines(fines.filter((fine) => String(fine.master_id) === String(masterId)));
}

export function masterNetPay(grossPay, fines) {
  return Math.max(0, (Number(grossPay) || 0) - (Number(fines) || 0));
}

export function masterNetPayFromRevenue(revenue, pct, fines) {
  return masterNetPay(masterGrossPay(revenue, pct), fines);
}

export function grossMasterCommissions(sales, masters) {
  return masters.reduce((sum, master) => {
    const revenue = masterRevenue(sales, master.id);
    return sum + masterGrossPay(revenue, master.pct);
  }, 0);
}

export function masterPayoutSum(sales, masters, fines = []) {
  return masters.reduce((sum, master) => {
    const revenue = masterRevenue(sales, master.id);
    const grossPay = masterGrossPay(revenue, master.pct);
    const finesAmount = masterFines(fines, master.id);
    return sum + masterNetPay(grossPay, finesAmount);
  }, 0);
}

export function salonCut(sales, masters, fines = []) {
  return totalSalesAmount(sales) - masterPayoutSum(sales, masters, fines);
}

export function expensesBySection(expenses, section) {
  if (section === 'all') return expenses;
  return expenses.filter((expense) => expense.section === section);
}

export function expensesByMinusFrom(expenses, minusFrom) {
  return expenses.filter((expense) => (expense.minus_from || '') === minusFrom);
}

export function ishxonaExpenses(expenses) {
  return expensesBySection(expenses, 'ishxona');
}

export function profit(sales, masters, expenses, fines = []) {
  return salonCut(sales, masters, fines) - totalExpenses(ishxonaExpenses(expenses));
}

export function investmentSummary(expenses, ownerKey) {
  return expenses.reduce(
    (summary, expense) => {
      const amount = Number(expense.amount_uzs) || 0;
      const rate = Number(expense.usd_rate) || 0;
      const amountUsd = rate ? amount / rate : 0;

      if (expense.section === ownerKey) {
        summary.invested += amount;
        summary.investedUsd += amountUsd;
      }

      if (expense.section === 'ishxona' && expense.minus_from === ownerKey) {
        summary.returned += amount;
        summary.returnedUsd += amountUsd;
      }

      return summary;
    },
    { invested: 0, investedUsd: 0, returned: 0, returnedUsd: 0 },
  );
}

export function paymentsForDebt(payments, debtId) {
  return payments.filter((payment) => String(payment.debt_id) === String(debtId));
}

export function totalPaidForDebt(payments, debtId) {
  return paymentsForDebt(payments, debtId).reduce(
    (sum, payment) => sum + (Number(payment.amount) || 0),
    0,
  );
}

export function remainingDebtAmount(debt, payments) {
  return (Number(debt.amount) || 0) - totalPaidForDebt(payments, debt.id);
}

export function groupDebtsByCurrency(debts) {
  return debts.reduce((groups, debt) => {
    const currency = debt.currency || 'UZS';
    groups[currency] = groups[currency] || [];
    groups[currency].push(debt);
    return groups;
  }, {});
}

export function totalOpenDebtsByCurrency(debts, payments) {
  return debts.reduce((totals, debt) => {
    if (debt.is_closed) return totals;

    const currency = debt.currency || 'UZS';
    totals[currency] = (totals[currency] || 0) + remainingDebtAmount(debt, payments);
    return totals;
  }, {});
}

function formatDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function getTodayRange() {
  const today = formatDate(new Date());
  return { from: today, to: today };
}

export function getCurrentMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  return { from: formatDate(from), to: formatDate(to) };
}

export function getCurrentWeekRange() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;
  const from = new Date(now);
  from.setDate(now.getDate() - day);
  const to = new Date(from);
  to.setDate(from.getDate() + 6);

  return { from: formatDate(from), to: formatDate(to) };
}

export function getPreviousMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 0);

  return { from: formatDate(from), to: formatDate(to) };
}

export function isDateInRange(date, from, to) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}
