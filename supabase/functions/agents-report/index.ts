import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const REPORT_SECRET = Deno.env.get('AGENTS_REPORT_SECRET') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const PAGE_SIZE = 1000;
const TIME_ZONE = 'Asia/Tashkent';

type ReportAction =
  | 'business_summary'
  | 'master_performance'
  | 'finance_report'
  | 'debt_summary'
  | 'attendance_report'
  | 'data_capabilities';

type Row = Record<string, unknown>;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-agents-report-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function secureEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value: unknown, fallback = 0) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowDate(row: Row, primary = 'd') {
  return String(row[primary] || row.date || row.sale_date || row.attendance_date || row.fine_date || '');
}

function saleTotal(sale: Row) {
  return number(sale.cash) + number(sale.card) + number(sale.qr);
}

function saleClients(sale: Row) {
  const raw = sale.clients_count ?? sale.cl ?? 1;
  return Math.max(0, integer(raw, 1));
}

function isCountedSale(sale: Row) {
  const pendingApproval = sale.status === 'pending' && sale.comment === 'owner_approval_required';
  const rejectedApproval = sale.status === 'rejected' && sale.comment === 'owner_approval_rejected';
  return !pendingApproval && !rejectedApproval;
}

function inRange(row: Row, from: string, to: string, primary = 'd') {
  const date = rowDate(row, primary);
  return Boolean(date && date >= from && date <= to);
}

function isoDateInTashkent() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function getPeriods(payload: Row) {
  const today = isoDateInTashkent();
  const hasCustomRange = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.from || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.to || ''));
  const to = hasCustomRange ? String(payload.to) : today;
  const requestedDays = Math.min(Math.max(integer(payload.days, 30), 1), 365);
  const from = hasCustomRange ? String(payload.from) : addDays(to, -(requestedDays - 1));
  if (from > to) throw new Error('invalid_period');
  const days = daysBetween(from, to);
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  return {
    current: { from, to, days },
    previous: { from: previousFrom, to: previousTo, days },
  };
}

async function fetchAllRows(
  table: string,
  select: string,
  orderColumn: string,
  from?: string,
  to?: string,
) {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = sb.from(table).select(select).order(orderColumn, { ascending: true });
    if (from) query = query.gte(orderColumn, from);
    if (to) query = query.lte(orderColumn, to);
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as Row[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function loadPeriodData(previousFrom: string, currentTo: string) {
  const [sales, fines, expenses, attendance, masters, settings] = await Promise.all([
    fetchAllRows('sales', 'id,master,master_id,d,sale_date,cash,card,qr,cl,clients_count,is_new_client,status,comment', 'd', previousFrom, currentTo),
    fetchAllRows('fines', 'id,master,master_id,d,fine_date,amount,reason', 'd', previousFrom, currentTo),
    fetchAllRows('expenses', 'id,date,section,name,amount_uzs,usd_rate,minus_from,category', 'date', previousFrom, currentTo),
    fetchAllRows('attendance', 'id,master,master_id,d,attendance_date,arrived,arrived_at', 'd', previousFrom, currentTo),
    fetchAllRows('masters', 'id,name,pct,active', 'id'),
    fetchAllRows('settings', 'id,shift_start', 'id'),
  ]);
  return { sales, fines, expenses, attendance, masters, settings };
}

function summarizeBusiness(sales: Row[], from: string, to: string) {
  const rows = sales.filter((sale) => isCountedSale(sale) && inRange(sale, from, to));
  const revenue = rows.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const clients = rows.reduce((sum, sale) => sum + saleClients(sale), 0);
  const newClients = rows
    .filter((sale) => sale.is_new_client === true)
    .reduce((sum, sale) => sum + saleClients(sale), 0);
  const returningClients = rows
    .filter((sale) => sale.is_new_client === false)
    .reduce((sum, sale) => sum + saleClients(sale), 0);
  return {
    revenue,
    clients,
    newClients,
    returningClients,
    unknownClientType: Math.max(0, clients - newClients - returningClients),
    transactions: rows.length,
    averagePerClient: clients ? Math.round(revenue / clients) : 0,
    averagePerTransaction: rows.length ? Math.round(revenue / rows.length) : 0,
    cash: rows.reduce((sum, sale) => sum + number(sale.cash), 0),
    card: rows.reduce((sum, sale) => sum + number(sale.card), 0),
    qr: rows.reduce((sum, sale) => sum + number(sale.qr), 0),
  };
}

function percentChange(current: number, previous: number) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function changeMap(current: Record<string, number>, previous: Record<string, number>) {
  return Object.fromEntries(Object.keys(current).map((key) => [
    key,
    percentChange(current[key] || 0, previous[key] || 0),
  ]));
}

function businessReport(data: Awaited<ReturnType<typeof loadPeriodData>>, periods: ReturnType<typeof getPeriods>) {
  const current = summarizeBusiness(data.sales, periods.current.from, periods.current.to);
  const previous = summarizeBusiness(data.sales, periods.previous.from, periods.previous.to);
  return {
    report: 'business_summary',
    period: periods.current,
    previousPeriod: periods.previous,
    current,
    previous,
    changePercent: changeMap(current, previous),
    caveats: [
      'Индивидуальные карточки клиентов и источники привлечения пока не хранятся.',
      'Новые ожидающие подтверждения и отклонённые владельцем продажи не включены; исторические legacy pending сохранены.',
    ],
  };
}

function masterReport(data: Awaited<ReturnType<typeof loadPeriodData>>, periods: ReturnType<typeof getPeriods>) {
  const currentSales = data.sales.filter((sale) => isCountedSale(sale) && inRange(sale, periods.current.from, periods.current.to));
  const previousSales = data.sales.filter((sale) => isCountedSale(sale) && inRange(sale, periods.previous.from, periods.previous.to));
  const currentFines = data.fines.filter((fine) => inRange(fine, periods.current.from, periods.current.to));
  const salonRevenue = currentSales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const masters = data.masters.filter((master) => master.active !== false).map((master) => {
    const name = String(master.name || '');
    const currentRows = currentSales.filter((sale) => sale.master === name);
    const previousRows = previousSales.filter((sale) => sale.master === name);
    const revenue = currentRows.reduce((sum, sale) => sum + saleTotal(sale), 0);
    const previousRevenue = previousRows.reduce((sum, sale) => sum + saleTotal(sale), 0);
    const clients = currentRows.reduce((sum, sale) => sum + saleClients(sale), 0);
    const fines = currentFines.filter((fine) => fine.master === name).reduce((sum, fine) => sum + number(fine.amount), 0);
    const pct = number(master.pct || 40);
    return {
      id: master.id,
      name,
      revenue,
      revenueChangePercent: percentChange(revenue, previousRevenue),
      clients,
      newClients: currentRows.filter((sale) => sale.is_new_client === true).reduce((sum, sale) => sum + saleClients(sale), 0),
      transactions: currentRows.length,
      averagePerClient: clients ? Math.round(revenue / clients) : 0,
      revenueSharePercent: salonRevenue ? Math.round((revenue / salonRevenue) * 1000) / 10 : 0,
      fines,
      calculatedPayout: Math.max(0, Math.round((revenue * pct) / 100 - fines)),
    };
  }).sort((left, right) => right.revenue - left.revenue);
  return {
    report: 'master_performance',
    period: periods.current,
    previousPeriod: periods.previous,
    masters,
    caveats: ['Рейтинг отражает записанные продажи, а не свободные часы в календаре.'],
  };
}

function financeReport(data: Awaited<ReturnType<typeof loadPeriodData>>, periods: ReturnType<typeof getPeriods>) {
  const sales = data.sales.filter((sale) => isCountedSale(sale) && inRange(sale, periods.current.from, periods.current.to));
  const fines = data.fines.filter((fine) => inRange(fine, periods.current.from, periods.current.to));
  const expenses = data.expenses.filter((expense) => inRange(expense, periods.current.from, periods.current.to, 'date'));
  const revenue = sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const masterPayouts = data.masters.filter((master) => master.active !== false).reduce((sum, master) => {
    const name = String(master.name || '');
    const masterRevenue = sales.filter((sale) => sale.master === name).reduce((total, sale) => total + saleTotal(sale), 0);
    const masterFines = fines.filter((fine) => fine.master === name).reduce((total, fine) => total + number(fine.amount), 0);
    return sum + Math.max(0, (masterRevenue * number(master.pct || 40)) / 100 - masterFines);
  }, 0);
  const expensesBySection = expenses.reduce((result: Record<string, number>, expense) => {
    const section = String(expense.section || 'unknown');
    result[section] = (result[section] || 0) + number(expense.amount_uzs);
    return result;
  }, {});
  const operatingExpenses = expensesBySection.ishxona || 0;
  const salonBeforeExpenses = revenue - masterPayouts;
  return {
    report: 'finance_report',
    period: periods.current,
    revenue,
    masterPayouts: Math.round(masterPayouts),
    salonBeforeExpenses: Math.round(salonBeforeExpenses),
    operatingExpenses,
    calculatedProfit: Math.round(salonBeforeExpenses - operatingExpenses),
    allRecordedExpenses: Object.values(expensesBySection).reduce((sum, value) => sum + value, 0),
    expensesBySection,
    caveats: [
      'Расчёт прибыли повторяет формулу Maestro: доля салона минус расходы раздела ishxona.',
      'Инвестиционные разделы Murod/Jamshid не вычитаются повторно из операционной прибыли.',
    ],
  };
}

async function debtReport() {
  const [debts, payments] = await Promise.all([
    fetchAllRows('debts', 'id,counterparty,direction,amount,currency,start_date,is_closed', 'id'),
    fetchAllRows('debt_payments', 'id,debt_id,date,amount', 'date'),
  ]);
  const entries = debts.map((debt) => {
    const paid = payments.filter((payment) => String(payment.debt_id) === String(debt.id))
      .reduce((sum, payment) => sum + number(payment.amount), 0);
    return {
      id: debt.id,
      counterparty: debt.counterparty,
      direction: debt.direction,
      currency: debt.currency || 'UZS',
      originalAmount: number(debt.amount),
      paid,
      remaining: Math.max(0, number(debt.amount) - paid),
      isClosed: Boolean(debt.is_closed),
    };
  });
  const totals = entries.filter((entry) => !entry.isClosed).reduce((result: Record<string, Record<string, number>>, entry) => {
    const direction = String(entry.direction || 'unknown');
    const currency = String(entry.currency || 'UZS');
    result[direction] ||= {};
    result[direction][currency] = (result[direction][currency] || 0) + entry.remaining;
    return result;
  }, {});
  return {
    report: 'debt_summary',
    generatedAt: new Date().toISOString(),
    totals,
    entries,
    caveats: ['UZS и USD намеренно не объединяются в одну сумму.'],
  };
}

function timeMinutes(value: unknown) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function attendanceReport(data: Awaited<ReturnType<typeof loadPeriodData>>, periods: ReturnType<typeof getPeriods>) {
  const rows = data.attendance.filter((item) => inRange(item, periods.current.from, periods.current.to));
  const fines = data.fines.filter((item) => inRange(item, periods.current.from, periods.current.to));
  const shiftStart = String(data.settings[0]?.shift_start || '09:00');
  const shiftMinutes = timeMinutes(shiftStart) ?? 540;
  const masters = data.masters.filter((master) => master.active !== false).map((master) => {
    const name = String(master.name || '');
    const records = rows.filter((item) => item.master === name);
    const lateMinutes = records.map((item) => {
      const arrived = timeMinutes(item.arrived_at || item.arrived);
      return arrived == null ? 0 : Math.max(0, arrived - shiftMinutes);
    });
    const lateDays = lateMinutes.filter((value) => value > 0).length;
    return {
      name,
      attendanceRecords: records.length,
      lateDays,
      totalLateMinutes: lateMinutes.reduce((sum, value) => sum + value, 0),
      averageLateMinutes: lateDays ? Math.round(lateMinutes.reduce((sum, value) => sum + value, 0) / lateDays) : 0,
      fines: fines.filter((fine) => fine.master === name).reduce((sum, fine) => sum + number(fine.amount), 0),
    };
  });
  return {
    report: 'attendance_report',
    period: periods.current,
    shiftStart,
    masters,
    caveats: ['Отсутствие записи посещаемости не всегда означает отсутствие мастера.'],
  };
}

function capabilitiesReport() {
  return {
    report: 'data_capabilities',
    available: [
      'Продажи, способы оплаты, количество и тип клиентов',
      'Мастера, проценты, посещаемость и штрафы',
      'Расходы, расчётная прибыль, долги и платежи',
    ],
    unavailable: [
      'Индивидуальные карточки клиентов и история повторных визитов',
      'Записи, отмены, неявки и свободные часы',
      'Instagram/TikTok просмотры, рекламные расходы, лиды и источник клиента',
      'Качество услуги, NPS и отзывы',
    ],
    rule: 'Если нужного показателя нет, агент обязан запросить его у владельца или предложить подключение источника.',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!REPORT_SECRET || !secureEqual(req.headers.get('x-agents-report-secret') || '', REPORT_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const payload = await req.json() as Row;
    const action = String(payload.action || '') as ReportAction;
    if (action === 'data_capabilities') return json(capabilitiesReport());
    if (action === 'debt_summary') return json(await debtReport());
    if (!['business_summary', 'master_performance', 'finance_report', 'attendance_report'].includes(action)) {
      return json({ error: 'unknown_action' }, 400);
    }

    const periods = getPeriods(payload);
    const data = await loadPeriodData(periods.previous.from, periods.current.to);
    if (action === 'business_summary') return json(businessReport(data, periods));
    if (action === 'master_performance') return json(masterReport(data, periods));
    if (action === 'finance_report') return json(financeReport(data, periods));
    return json(attendanceReport(data, periods));
  } catch (error) {
    console.error('[agents-report] failed', { error: String(error) });
    return json({ error: 'report_failed' }, 500);
  }
});
