import { useEffect, useMemo, useRef, useState } from 'react';
import {
  callLegacyApi,
  captureTelegramOAuthCode,
  captureTelegramRedirectAuth,
  getTelegramFirstName,
  needsTelegramLogin,
  startTelegramOAuthLogin,
} from './lib/legacyApi.js';
import {
  investmentSummary,
  masterGrossPay,
  masterNetPay,
  saleClientsCount,
  saleTotal,
  totalCard,
  totalCash,
  totalExpenses,
  totalFines,
  totalPaidForDebt,
  totalQr,
  totalSalesAmount,
} from './utils/calculations.js';
import { downloadClientWorkbook } from './utils/clientExport.js';
import {
  APPOINTMENT_OUTCOME_REASONS,
  APPOINTMENT_REASON_LABELS,
  appointmentOutcomeAllowed,
  reasonRequiresNote,
} from './utils/appointmentOutcomes.js';

const APP_VERSION = 'auto-refresh-v1';
const TODAY = localDate();
const THEMES = {
  brass: {
    name: 'Латунь',
    light: { brass: '#A9742E', 'brass-soft': '#F0E4D0', bg: '#F3F0EB', surface: '#FFFFFF', 'surface-2': '#FAF8F5', ink: '#181613', muted: '#7A736B', line: '#E7E2DA' },
    dark: { brass: '#D9A75A', 'brass-soft': '#3A3326', bg: '#15140F', surface: '#211F1A', 'surface-2': '#1A1915', ink: '#F2EEE7', muted: '#9A9388', line: '#33302A' },
  },
  emerald: {
    name: 'Изумруд',
    light: { bg: '#F1F5F2', surface: '#FFFFFF', 'surface-2': '#F6FAF7', ink: '#14201A', muted: '#6B7A72', line: '#DDE8E1', brass: '#1E7A52', 'brass-soft': '#D9EFE3' },
    dark: { bg: '#0E1714', surface: '#16211C', 'surface-2': '#121B17', ink: '#EAF3EE', muted: '#8AA398', line: '#29372F', brass: '#3FB37B', 'brass-soft': '#1C3329' },
  },
  midnight: {
    name: 'Полночь',
    light: { bg: '#F1F2F8', surface: '#FFFFFF', 'surface-2': '#F6F7FC', ink: '#15172A', muted: '#6E7290', line: '#E1E3F0', brass: '#3B43B5', 'brass-soft': '#E2E4FA' },
    dark: { bg: '#0F1020', surface: '#1A1B2E', 'surface-2': '#151628', ink: '#ECEDF7', muted: '#9498BE', line: '#2C2E47', brass: '#7C84F0', 'brass-soft': '#262A52' },
  },
  barber: {
    name: 'Барбер',
    light: { bg: '#F4F2EE', surface: '#FFFFFF', 'surface-2': '#F9F7F3', ink: '#16202E', muted: '#6F7682', line: '#E4E2DC', brass: '#1F3A66', 'brass-soft': '#DBE3F0' },
    dark: { bg: '#101620', surface: '#1A2230', 'surface-2': '#151B26', ink: '#ECF0F6', muted: '#8A93A3', line: '#2A3340', brass: '#5B86C9', 'brass-soft': '#213048' },
  },
};

function localDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function usdMoney(value) {
  return `$${money(value)}`;
}

function futureMonthLabel(monthsAhead) {
  const [year, month] = TODAY.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1 + monthsAhead, 1));
}

function averageCheck(revenue, clientCount) {
  return clientCount > 0 ? money(revenue / clientCount) : '—';
}

// These are payment plans only: they never change the debt amount, balance, or payment history.
function debtPaymentPlan(debt) {
  const counterparty = String(debt.counterparty || '').toLowerCase();
  if (debt.currency === 'USD' && counterparty.includes('dyson')) return { monthly: 110, months: 2 };
  if (debt.currency === 'UZS' && counterparty.includes('alif')) return { monthly: 2431392 };
  return null;
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function formatDigits(value) {
  const digits = digitsOnly(value);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function isPendingOwnerApproval(sale) {
  return sale.status === 'pending' && sale.comment === 'owner_approval_required';
}

function getPendingSales(sales) {
  return sales.filter(isPendingOwnerApproval);
}

function isRejectedByOwner(sale) {
  return sale.status === 'rejected' && sale.comment === 'owner_approval_rejected';
}

function isCountedSale(sale) {
  return !isPendingOwnerApproval(sale) && !isRejectedByOwner(sale);
}

function rowDate(row, primary = 'd') {
  return row?.[primary] || row?.date || row?.sale_date || row?.attendance_date || row?.fine_date || '';
}

function newestFirst(left, right) {
  const leftKey = `${rowDate(left)}T${left.created_at || left.arrived_at || left.arrived || ''}`;
  const rightKey = `${rowDate(right)}T${right.created_at || right.arrived_at || right.arrived || ''}`;
  return rightKey.localeCompare(leftKey);
}

function clients(sale) {
  return saleClientsCount(sale);
}

function displayTime(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{2}:\d{2}/.test(text)) return text.slice(0, 5);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.slice(0, 5) : date.toTimeString().slice(0, 5);
}

function displayDateTime(value) {
  if (!value) return 'время не указано';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tashkent',
  });
}

function displayDate(value) {
  if (!value) return 'дата не выбрана';
  const [year, month, day] = String(value).split('-');
  return year && month && day ? `${day}.${month}.${year}` : String(value);
}

function displayRange(range) {
  if (!range?.from && !range?.to) return 'период не выбран';
  if (range.from === range.to || !range.to) return displayDate(range.from);
  return `${displayDate(range.from)}–${displayDate(range.to)}`;
}

function clientType(sale) {
  if (sale.is_new_client === true) return 'новый';
  if (sale.is_new_client === false) return 'постоянный';
  return 'тип не указан';
}

function timeToMinutes(value) {
  const time = displayTime(value);
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function minutesLate(arrived, shiftStart = '09:00') {
  const arrivedMinutes = timeToMinutes(arrived);
  const shiftMinutes = timeToMinutes(shiftStart);
  if (arrivedMinutes == null || shiftMinutes == null) return 0;
  return Math.max(0, arrivedMinutes - shiftMinutes);
}

function recentRecordCanBeDeleted(recordDate, days) {
  const cutoff = new Date(`${TODAY}T12:00:00`);
  cutoff.setDate(cutoff.getDate() - days);
  return Boolean(recordDate) && recordDate >= localDate(cutoff);
}

const recentFineCanBeDeleted = (date) => recentRecordCanBeDeleted(date, 7);
const recentSaleCanBeDeleted = (date) => recentRecordCanBeDeleted(date, 2);

function distanceMeters(lat1, lng1, lat2, lng2) {
  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function currentMonthRange() {
  const now = new Date();
  return {
    from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

function weekRange(anchor = new Date()) {
  const day = (anchor.getDay() + 6) % 7;
  const from = new Date(anchor);
  from.setDate(anchor.getDate() - day);
  const to = new Date(from);
  to.setDate(from.getDate() + 6);
  return { from: localDate(from), to: localDate(to) };
}

function allRange(rows, key = 'd') {
  const dates = rows.map((row) => rowDate(row, key)).filter(Boolean).sort();
  return { from: dates[0] || TODAY, to: dates[dates.length - 1] || TODAY };
}

function getRange(period, customFrom, customTo, rows = [], key = 'd') {
  if (period === 'day' || period === 'today') return { from: TODAY, to: TODAY };
  if (period === 'week') return weekRange();
  if (period === 'month') return currentMonthRange();
  if (period === 'all') return allRange(rows, key);
  return { from: customFrom || TODAY, to: customTo || customFrom || TODAY };
}

function previousRange(range, period) {
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

function percentageDifference(current, previous) {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;
  return previousValue
    ? Math.round(((currentValue - previousValue) / Math.abs(previousValue)) * 100)
    : currentValue ? 100 : 0;
}

function comparisonToPrevious(current, previous, comparisonRange) {
  const percent = percentageDifference(current, previous);
  return {
    secondary: `${percent > 0 ? '+' : ''}${percent}% к периоду — ${displayRange(comparisonRange)}`,
    secondaryTone: percent > 0 ? 'positive' : percent < 0 ? 'negative' : '',
  };
}

function inRange(value, from, to) {
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
}

function tashkentDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function appointmentTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('ru-RU', {
    timeZone: 'Asia/Tashkent',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function belongsToMaster(row, master) {
  if (row.master_id != null && master.id != null) {
    return String(row.master_id) === String(master.id);
  }
  return row.master === master.name;
}

function reportMastersForPeriod(data, sales, fines = []) {
  return data.masters.filter((master) => (
    master.active !== false
    || sales.some((sale) => belongsToMaster(sale, master))
    || fines.some((fine) => belongsToMaster(fine, master))
  ));
}

function masterPayoutForPeriod(data, sales, fines = []) {
  // Keep legacy id-or-name ownership matching and the 40% fallback here; the
  // generic masterPayoutSum helper intentionally has a stricter id contract.
  return reportMastersForPeriod(data, sales, fines).reduce((sum, master) => {
    const rows = sales.filter((sale) => belongsToMaster(sale, master));
    const revenue = totalSalesAmount(rows);
    const fineTotal = totalFines(fines.filter((fine) => belongsToMaster(fine, master)));
    return sum + masterNetPay(masterGrossPay(revenue, Number(master.pct || 40)), fineTotal);
  }, 0);
}

function totalOpenDebtsByCurrency(data) {
  // This dashboard is narrower than the generic helper: only i_owe debts are
  // included and every overpaid debt is clamped before currency aggregation.
  const paidByDebt = data.debtPayments.reduce((totals, payment) => {
    const key = String(payment.debt_id);
    totals[key] = (totals[key] || 0) + (Number(payment.amount) || 0);
    return totals;
  }, {});
  return data.debts
    .filter((debt) => debt.direction === 'i_owe' && !debt.is_closed)
    .reduce((totals, debt) => {
      const currency = debt.currency === 'USD' ? 'USD' : 'UZS';
      totals[currency] += Math.max(0, (Number(debt.amount) || 0) - (paidByDebt[String(debt.id)] || 0));
      return totals;
    }, { UZS: 0, USD: 0 });
}

function normalizeData(data) {
  const masters = data.masters || [];
  const byName = Object.fromEntries(masters.map((master) => [master.name, master]));
  const settings = (data.settings || [])[0] || {};

  return {
    role: data.role || 'unknown',
    appRole: data.appRole || data.role || 'unknown',
    me: data.me || '',
    masters,
    byName,
    activeMasters: masters.filter((master) => master.active !== false),
    sales: data.sales || [],
    fines: data.fines || [],
    attendance: data.attendance || [],
    bookingServices: data.booking_services || [],
    dayStatuses: data.master_day_statuses || [],
    appointments: data.appointments || [],
    scheduleRules: data.master_schedule_rules || [],
    clients: data.clients || [],
    expenses: data.expenses || [],
    debts: data.debts || [],
    debtPayments: data.debt_payments || [],
    settings,
  };
}

function emptyState() {
  return normalizeData({});
}

function MoneyInput({ value, onChange, ...props }) {
  return (
    <input
      {...props}
      inputMode="numeric"
      type="text"
      value={formatDigits(value)}
      onChange={(event) => onChange(digitsOnly(event.target.value))}
    />
  );
}

function PaymentBreakdownBar({ cash, card, qr }) {
  const [isReady, setIsReady] = useState(false);
  const values = [Number(cash) || 0, Number(card) || 0, Number(qr) || 0];
  const total = values.reduce((sum, value) => sum + value, 0);
  const items = [
    { key: 'cash', label: 'Наличные', value: values[0] },
    { key: 'card', label: 'Карта', value: values[1] },
    { key: 'qr', label: 'QR Paynet', value: values[2] },
  ].map((item) => ({ ...item, percent: total ? (item.value / total) * 100 : 0 }));

  useEffect(() => {
    const frame = requestAnimationFrame(() => setIsReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="payment-breakdown" aria-label="Разбивка выручки по способам оплаты">
      <div className="payment-breakdown-track">
        {items.map((item) => (
          <span
            className={`payment-breakdown-segment payment-breakdown-${item.key}`}
            key={item.key}
            style={{ flexBasis: isReady ? `${item.percent}%` : '0%' }}
            title={`${item.label}: ${money(item.value)} сум (${Math.round(item.percent)}%)`}
          />
        ))}
      </div>
      <div className="payment-breakdown-labels">
        {items.map((item) => (
          <span key={item.key}><i className={`payment-breakdown-dot payment-breakdown-${item.key}`} />{item.label} <strong>{Math.round(item.percent)}%</strong></span>
        ))}
      </div>
    </div>
  );
}

function MasterMetricComparison({ current, previous }) {
  const percent = percentageDifference(current, previous);
  const tone = percent > 0 ? 'positive' : percent < 0 ? 'negative' : '';
  return (
    <small className={`master-period-change ${tone}`}>
      {percent > 0 ? '+' : ''}{percent}% <span>· было {money(previous)}</span>
    </small>
  );
}

function monthWeekRanges(range) {
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

function overviewWeeklyMetrics(data, range, sales, fines) {
  const reportMasters = reportMastersForPeriod(data, sales, fines);
  const buckets = monthWeekRanges(range).map((week) => {
    const weekSales = sales.filter((sale) => inRange(rowDate(sale), week.from, week.to));
    const revenue = totalSalesAmount(weekSales);
    const grossMasterPay = reportMasters.reduce((sum, master) => {
      const masterRevenue = totalSalesAmount(weekSales.filter((sale) => belongsToMaster(sale, master)));
      return sum + masterGrossPay(masterRevenue, Number(master.pct || 40));
    }, 0);
    const expenses = totalExpenses(data.expenses
      .filter((expense) => expense.section === 'ishxona' && inRange(rowDate(expense, 'date'), week.from, week.to)));

    return { ...week, revenue, grossMasterPay, recognizedFines: 0, expenses };
  });

  // A fine reduces a master's monthly payout only down to zero. Distributing the
  // recognized part by its actual week keeps the weekly rows equal to the month total.
  reportMasters.forEach((master) => {
    const masterRevenue = totalSalesAmount(sales.filter((sale) => belongsToMaster(sale, master)));
    const grossMasterPay = masterGrossPay(masterRevenue, Number(master.pct || 40));
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
    };
  });
}

function overviewFineRanking(data, fines) {
  const mastersById = new Map(data.masters.map((master) => [String(master.id), master]));
  const totals = new Map();

  fines.forEach((fine) => {
    const master = fine.master_id != null ? mastersById.get(String(fine.master_id)) : null;
    const name = master?.name || fine.master || 'Без мастера';
    const key = master?.id != null ? `id:${master.id}` : `name:${name}`;
    const current = totals.get(key) || { key, name, amount: 0, count: 0 };
    current.amount += Number(fine.amount) || 0;
    current.count += 1;
    totals.set(key, current);
  });

  return [...totals.values()].sort((left, right) => (
    right.amount - left.amount || left.name.localeCompare(right.name, 'ru')
  ));
}

function fineCountLabel(count) {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'штрафов';
  if (mod10 === 1) return 'штраф';
  if (mod10 >= 2 && mod10 <= 4) return 'штрафа';
  return 'штрафов';
}

function OverviewMetricTile({ detailId, label, value, tone, danger, expanded, onToggle }) {
  return (
    <button
      aria-controls={expanded ? `overview-details-${detailId}` : undefined}
      aria-expanded={expanded}
      className={`tile overview-metric-tile ${expanded ? 'is-expanded' : ''} ${danger ? 'danger' : ''} ${tone ? `tile-${tone}` : ''}`}
      type="button"
      onClick={() => onToggle(expanded ? null : detailId)}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <i className="overview-metric-chevron" aria-hidden="true" />
    </button>
  );
}

function OverviewWeeklyDetails({ detailId, title, rows, valueKey }) {
  return (
    <div className="overview-details" id={`overview-details-${detailId}`} role="region" aria-label={title}>
      <div className="overview-details-heading">
        <strong>{title}</strong>
        <span>по календарным неделям</span>
      </div>
      <div className="overview-details-list">
        {rows.map((row) => (
          <div className="overview-detail-row" key={row.from}>
            <span>{displayRange(row)}</span>
            <strong>{money(row[valueKey])} сум</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewFineDetails({ rows }) {
  return (
    <div className="overview-details" id="overview-details-fines" role="region" aria-label="Штрафы по мастерам">
      <div className="overview-details-heading">
        <strong>Штрафы по мастерам</strong>
        <span>от большей суммы к меньшей</span>
      </div>
      {rows.length ? (
        <ol className="overview-fine-ranking">
          {rows.map((row, index) => (
            <li className={index === 0 ? 'is-first' : ''} key={row.key}>
              <span className="overview-rank-number">{index + 1}</span>
              <span className="overview-rank-master">
                <strong>{row.name}</strong>
                <small>{row.count} {fineCountLabel(row.count)}</small>
              </span>
              <strong className="overview-rank-amount">{money(row.amount)} сум</strong>
            </li>
          ))}
        </ol>
      ) : <p className="hint overview-details-empty">В этом месяце штрафов нет.</p>}
    </div>
  );
}

function OverviewView({ data }) {
  const [expandedDetail, setExpandedDetail] = useState(null);
  const monthRange = currentMonthRange();
  const todaySales = data.sales.filter((sale) => isCountedSale(sale) && rowDate(sale) === TODAY);
  const monthSales = data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), monthRange.from, monthRange.to),
  );
  const monthFines = data.fines.filter((fine) => inRange(rowDate(fine), monthRange.from, monthRange.to));
  const todayRevenue = totalSalesAmount(todaySales);
  const monthRevenue = totalSalesAmount(monthSales);
  const payouts = masterPayoutForPeriod(data, monthSales, monthFines);
  const salonRemainder = monthRevenue - payouts;
  const fineTotal = totalFines(monthFines);
  const operatingExpenses = totalExpenses(data.expenses
    .filter((expense) => expense.section === 'ishxona' && inRange(rowDate(expense, 'date'), monthRange.from, monthRange.to)));
  const netProfit = salonRemainder - operatingExpenses;
  const pendingSales = getPendingSales(data.sales);
  const weeklyMetrics = overviewWeeklyMetrics(data, monthRange, monthSales, monthFines);
  const visibleWeeklyMetrics = weeklyMetrics.filter((week) => (
    week.from <= TODAY || week.revenue || week.grossMasterPay || week.recognizedFines || week.expenses
  ));
  const fineRanking = overviewFineRanking(data, monthFines);

  return (
    <section className="view-grid">
      <div className="card wide overview-card">
        <SectionHeading label="Главное сегодня" range={{ from: TODAY, to: TODAY }} />
        <div className="tiles overview-tiles">
          <Tile label="Выручка сегодня" value={`${money(todayRevenue)} сум`} tone="total" />
          <OverviewMetricTile
            detailId="revenue"
            expanded={expandedDetail === 'revenue'}
            label="Выручка за месяц"
            value={`${money(monthRevenue)} сум`}
            onToggle={setExpandedDetail}
          />
          {expandedDetail === 'revenue' ? (
            <OverviewWeeklyDetails detailId="revenue" title="Выручка за месяц" rows={visibleWeeklyMetrics} valueKey="revenue" />
          ) : null}
          <OverviewMetricTile
            detailId="salon"
            expanded={expandedDetail === 'salon'}
            label="Остаток салону"
            tone="salon"
            value={`${money(salonRemainder)} сум`}
            onToggle={setExpandedDetail}
          />
          {expandedDetail === 'salon' ? (
            <OverviewWeeklyDetails detailId="salon" title="Остаток салону" rows={visibleWeeklyMetrics} valueKey="salonRemainder" />
          ) : null}
          <OverviewMetricTile
            detailId="fines"
            expanded={expandedDetail === 'fines'}
            label="Штрафы за месяц"
            value={`${money(fineTotal)} сум`}
            onToggle={setExpandedDetail}
          />
          {expandedDetail === 'fines' ? <OverviewFineDetails rows={fineRanking} /> : null}
          <OverviewMetricTile
            danger={netProfit < 0}
            detailId="profit"
            expanded={expandedDetail === 'profit'}
            label="Чистая прибыль"
            tone="total"
            value={`${money(netProfit)} сум`}
            onToggle={setExpandedDetail}
          />
          {expandedDetail === 'profit' ? (
            <OverviewWeeklyDetails detailId="profit" title="Чистая прибыль" rows={visibleWeeklyMetrics} valueKey="netProfit" />
          ) : null}
          <Tile label="Ждут подтверждения" value={pendingSales.length} />
        </div>
      </div>
    </section>
  );
}

function MasterView({ data, reload, setError }) {
  const [selectedMaster, setSelectedMaster] = useState(data.me || data.activeMasters[0]?.name || '');
  const [payType, setPayType] = useState(null);
  const [amount, setAmount] = useState('');
  const [clientCount, setClientCount] = useState(1);
  const [isNewClient, setIsNewClient] = useState(null);
  const [period, setPeriod] = useState('day');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [message, setMessage] = useState('');

  const canPickMaster = data.role === 'admin';
  const masterName = data.role === 'master' ? data.me : selectedMaster;
  const pct = Number(data.byName[masterName]?.pct ?? 40);
  const range = getRange(period, customFrom, customTo, data.sales);
  const masterSales = data.sales.filter((sale) => sale.master === masterName);
  const todaySales = masterSales.filter((sale) => rowDate(sale) === TODAY);
  const visibleSales = masterSales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const visibleFines = data.fines.filter((fine) => fine.master === masterName && inRange(rowDate(fine), range.from, range.to));
  const revenue = totalSalesAmount(visibleSales);
  const visibleClients = visibleSales.reduce((sum, sale) => sum + clients(sale), 0);
  const paymentTotals = {
    cash: totalCash(visibleSales),
    card: totalCard(visibleSales),
    qr: totalQr(visibleSales),
  };
  const fineTotal = totalFines(visibleFines);
  const pay = masterNetPay(masterGrossPay(revenue, pct), fineTotal);
  const attendanceToday = data.attendance.find((item) => item.master === masterName && rowDate(item) === TODAY);
  const shiftStart = data.settings.shift_start || '09:00';

  useEffect(() => {
    if (!masterName && data.activeMasters[0]?.name) setSelectedMaster(data.activeMasters[0].name);
  }, [data.activeMasters, masterName]);

  async function submitSale(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    const numericAmount = Number(amount);
    if (!payType) return setError('Выберите способ оплаты.');
    if (!numericAmount || numericAmount <= 0) return setError('Введите сумму продажи.');
    if (!masterName) return setError('Сначала выберите мастера.');
    if (clientCount > 0 && isNewClient == null) return setError('Отметьте, клиент новый или постоянный.');

    const payload = {
      master: masterName,
      d: TODAY,
      cash: 0,
      card: 0,
      qr: 0,
      cl: clientCount,
      clients_count: clientCount,
      is_new_client: clientCount === 0 ? null : isNewClient,
      [payType]: numericAmount,
    };

    await callLegacyApi('addSale', payload);
    setPayType(null);
    setAmount('');
    setClientCount(1);
    setIsNewClient(null);
    setMessage(data.role === 'master'
      ? 'Оплата отправлена owner на подтверждение.'
      : 'Продажа сохранена.');
    await reload();
  }

  async function deleteSale(id) {
    await callLegacyApi('delSale', { id });
    await reload();
  }

  async function markArrival() {
    setError('');
    setMessage('');

    const arrived = new Date().toTimeString().slice(0, 5);
    const salonLat = Number(data.settings.salon_lat);
    const salonLng = Number(data.settings.salon_lng);
    const salonRadius = Number(data.settings.salon_radius || 100);

    if (Number.isFinite(salonLat) && Number.isFinite(salonLng) && navigator.geolocation) {
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 7000 });
        });
        const distance = distanceMeters(
          position.coords.latitude,
          position.coords.longitude,
          salonLat,
          salonLng,
        );
        if (distance > salonRadius) {
          setError(`Вы примерно в ${Math.round(distance)} м от салона. Отметиться можно в радиусе ${salonRadius} м.`);
          return;
        }
      } catch {
        setError('Не удалось получить геолокацию. Разрешите доступ и попробуйте снова.');
        return;
      }
    }

    await callLegacyApi('setAttendance', { master: masterName, d: TODAY, arrived });
    setMessage('Приход отмечен.');
    await reload();
  }

  async function resetArrival() {
    await callLegacyApi('delAttendance', { master: masterName, d: TODAY });
    await reload();
  }

  return (
    <section className="view-grid">
      {canPickMaster ? (
        <div className="card">
          <h2>Кто работает</h2>
          <select value={selectedMaster} onChange={(event) => setSelectedMaster(event.target.value)}>
            {data.activeMasters.map((master) => (
              <option key={master.name} value={master.name}>{master.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="card">
        <SectionHeading label="Смена сегодня" range={{ from: TODAY, to: TODAY }} />
        {attendanceToday ? (
          <>
            <p className="big-line">Пришёл в {displayTime(attendanceToday.arrived || attendanceToday.arrived_at)}</p>
            <p className="hint">
              {minutesLate(attendanceToday.arrived || attendanceToday.arrived_at, shiftStart)
                ? `Опоздал на ${minutesLate(attendanceToday.arrived || attendanceToday.arrived_at, shiftStart)} мин`
                : 'Вовремя'}
            </p>
            <button className="btn ghost" type="button" onClick={resetArrival}>Изменить</button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={markArrival} disabled={!masterName}>Я пришёл</button>
            <p className="hint">Смена с {shiftStart}. Если координаты салона заданы, отметка проверяет радиус.</p>
          </>
        )}
      </div>

      <form className="card" onSubmit={submitSale}>
        <h2>Новая продажа</h2>
        <div className="pay-types">
          {[
            ['cash', 'Наличные'],
            ['card', 'Карта'],
            ['qr', 'QR Paynet'],
          ].map(([value, label]) => (
            <button
              aria-pressed={payType === value}
              className={`pay-type ${value} ${payType === value ? 'on' : ''}`}
              key={value}
              type="button"
              onClick={() => setPayType(value)}
            >
              <span className="payment-dot" />{label}
            </button>
          ))}
        </div>
        <MoneyInput
          placeholder="например, 150 000"
          value={amount}
          onChange={setAmount}
        />
        <div className="counter">
          <button type="button" onClick={() => setClientCount(Math.max(0, clientCount - 1))}>-</button>
          <strong>{clientCount}</strong>
          <button type="button" onClick={() => setClientCount(clientCount + 1)}>+</button>
        </div>
        <div className="seg">
          <button className={isNewClient === true ? 'on' : ''} type="button" onClick={() => setIsNewClient(true)}>Новый</button>
          <button className={isNewClient === false ? 'on' : ''} type="button" onClick={() => setIsNewClient(false)}>Постоянный</button>
        </div>
        {clientCount === 0 ? <p className="hint">Продажа сохранится в выручке, но не увеличит число клиентов.</p> : null}
        <button className="btn" type="submit">Добавить</button>
        {message ? <p className="success">{message}</p> : null}
      </form>

      <div className="card">
        <SectionHeading label="Сегодня" range={{ from: TODAY, to: TODAY }} />
        <Rows
          rows={[...todaySales].sort(newestFirst)}
          empty="Пока нет записей за сегодня."
          render={(sale) => (
            <div className="row" key={sale.id}>
              <div>
                <strong>{money(saleTotal(sale))} сум</strong>
                <span>{sale.cash ? 'Наличные' : sale.card ? 'Карта' : 'QR Paynet'} · клиентов {clients(sale)} · {clientType(sale)}</span>
                <span>Внесено: {displayDateTime(sale.created_at)}</span>
                {isPendingOwnerApproval(sale) ? <span className="approval pending">Ожидает owner</span> : null}
                {isRejectedByOwner(sale) ? <span className="approval rejected">Отклонено owner</span> : null}
              </div>
              {data.role === 'admin' || isPendingOwnerApproval(sale) ? (
                <button className="del" type="button" onClick={() => deleteSale(sale.id)}>×</button>
              ) : null}
            </div>
          )}
        />
      </div>

      <div className="card wide">
        <SectionHeading label="Мой заработок" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="hero">{money(pay)} <small>сум к выплате</small></div>
        <div className="tiles">
          <Tile label="Выручка" value={money(revenue)} />
          <Tile label="Мой %" value={`${pct}%`} />
          <Tile label="Штрафы" value={`-${money(fineTotal)}`} danger />
          <Tile label="Клиентов" value={visibleClients} />
          <Tile label="Средний чек" value={averageCheck(revenue, visibleClients)} />
        </div>
        <PaymentBreakdownBar cash={paymentTotals.cash} card={paymentTotals.card} qr={paymentTotals.qr} />
      </div>
    </section>
  );
}

function AdminView({ data, reload, setError }) {
  const [period, setPeriod] = useState('day');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [message, setMessage] = useState('');
  const [masterSort, setMasterSort] = useState({ key: 'revenue', direction: 'desc' });
  const range = getRange(period, customFrom, customTo, data.sales);
  const priorRange = previousRange(range, period);
  const pendingSales = getPendingSales(data.sales);
  const sales = data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const fines = data.fines.filter((fine) => inRange(rowDate(fine), range.from, range.to));
  const previousSales = priorRange ? data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), priorRange.from, priorRange.to),
  ) : [];
  const previousFines = priorRange ? data.fines.filter(
    (fine) => inRange(rowDate(fine), priorRange.from, priorRange.to),
  ) : [];
  const revenue = totalSalesAmount(sales);
  const totalClients = sales.reduce((sum, sale) => sum + clients(sale), 0);
  const paymentTotals = {
    cash: totalCash(sales),
    card: totalCard(sales),
    qr: totalQr(sales),
  };
  const newClients = sales.filter((sale) => sale.is_new_client === true).reduce((sum, sale) => sum + clients(sale), 0);
  const reportMasters = reportMastersForPeriod(
    data,
    [...sales, ...previousSales],
    [...fines, ...previousFines],
  );
  const masterSummaries = reportMasters.map((master) => {
    const rows = sales.filter((sale) => belongsToMaster(sale, master));
    const masterRevenue = totalSalesAmount(rows);
    const masterFine = totalFines(fines.filter((fine) => belongsToMaster(fine, master)));
    const previousRows = previousSales.filter((sale) => belongsToMaster(sale, master));
    const previousRevenue = totalSalesAmount(previousRows);
    const previousFine = totalFines(previousFines.filter((fine) => belongsToMaster(fine, master)));
    return {
      master,
      rows,
      revenue: masterRevenue,
      pay: masterNetPay(masterGrossPay(masterRevenue, Number(master.pct || 40)), masterFine),
      previousRevenue,
      previousPay: masterNetPay(masterGrossPay(previousRevenue, Number(master.pct || 40)), previousFine),
    };
  });
  const topMaster = [...masterSummaries].sort((left, right) => right.revenue - left.revenue)[0];
  const topMasterName = topMaster?.revenue > 0 ? topMaster.master.name : null;
  const sortedMasterSummaries = [...masterSummaries].sort((left, right) => {
    const multiplier = masterSort.direction === 'asc' ? 1 : -1;
    if (masterSort.key === 'name') return left.master.name.localeCompare(right.master.name, 'ru') * multiplier;
    return (left[masterSort.key] - right[masterSort.key]) * multiplier;
  });
  const totalMasterPayout = masterSummaries.reduce((sum, item) => sum + item.pay, 0);
  const salonRemainder = revenue - totalMasterPayout;
  const previousRevenue = totalSalesAmount(previousSales);
  const previousNewClients = previousSales.filter((sale) => sale.is_new_client === true).reduce((sum, sale) => sum + clients(sale), 0);
  const previousClients = previousSales.reduce((sum, sale) => sum + clients(sale), 0);
  const previousPayout = masterPayoutForPeriod(data, previousSales, previousFines);
  const comparison = (current, previous) => priorRange ? comparisonToPrevious(current, previous, priorRange) : {};

  async function setSaleApproval(id, status) {
    setError('');
    await callLegacyApi('setSaleApproval', { id, status });
    setMessage(status === 'approved' ? 'Оплата подтверждена.' : 'Оплата отклонена.');
    await reload();
  }

  async function deleteDetailedSale(sale) {
    if (!recentSaleCanBeDeleted(rowDate(sale))) return setError('Можно удалять только продажи не старше 2 дней.');
    if (!confirm(`Удалить продажу ${sale.master} на ${money(saleTotal(sale))} сум?`)) return;
    await callLegacyApi('delSale', { id: sale.id });
    setMessage('Продажа удалена.');
    await reload();
  }

  function changeMasterSort(key) {
    setMasterSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  }

  function sortArrow(key) {
    return masterSort.key === key ? (masterSort.direction === 'asc' ? '↑' : '↓') : '';
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <h2>Оплаты на подтверждение</h2>
        <Rows
          rows={[...pendingSales].sort(newestFirst)}
          empty="Новых оплат от мастеров на подтверждение нет."
          render={(sale) => (
            <div className="row approval-row" key={sale.id}>
              <div>
                <strong>{sale.master} · {money(saleTotal(sale))} сум</strong>
                <span>
                  {rowDate(sale)} · {sale.cash ? 'Наличные' : sale.card ? 'Карта' : 'QR Paynet'} · клиентов {clients(sale)} · {clientType(sale)}
                </span>
                <span>Внесено мастером: {displayDateTime(sale.created_at)}</span>
              </div>
              <div className="approval-actions">
                <button className="btn approval-button" type="button" onClick={() => setSaleApproval(sale.id, 'approved')}>
                  Подтвердить
                </button>
                <button className="btn ghost approval-button" type="button" onClick={() => setSaleApproval(sale.id, 'rejected')}>
                  Отклонить
                </button>
              </div>
            </div>
          )}
        />
      </div>

      <div className="card wide">
        <SectionHeading label="Период отчёта" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="tiles">
          <Tile label="Итого" value={money(revenue)} {...comparison(revenue, previousRevenue)} tone="total" />
          <Tile label="Остаток салону" value={money(salonRemainder)} {...comparison(salonRemainder, previousRevenue - previousPayout)} tone="salon" />
          <Tile label="Клиентов" value={totalClients} {...comparison(totalClients, previousClients)} />
          <Tile label="Новые" value={newClients} {...comparison(newClients, previousNewClients)} />
          <Tile label="Постоянные" value={totalClients - newClients} {...comparison(totalClients - newClients, previousClients - previousNewClients)} />
          <Tile label="Средний чек" value={averageCheck(revenue, totalClients)} />
        </div>
        <PaymentBreakdownBar cash={paymentTotals.cash} card={paymentTotals.card} qr={paymentTotals.qr} />
      </div>

      <div className="card wide">
        <h2>Выручка по дням</h2>
        <RevenueChart
          sales={sales}
          previousSales={previousSales}
          from={range.from}
          to={range.to}
          previousFrom={priorRange?.from}
          previousTo={priorRange?.to}
        />
      </div>

      <div className="card wide">
        <h2>По мастерам</h2>
        {priorRange ? <p className="master-comparison-range">Сравнение к периоду — {displayRange(priorRange)}</p> : null}
        <div className="master-table-wrap">
          <table className="master-table">
            <thead>
              <tr>
                {[
                  ['name', 'Мастер'],
                  ['revenue', 'Выручка'],
                  ['pay', 'К выплате'],
                ].map(([key, label]) => (
                  <th aria-sort={masterSort.key === key ? (masterSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} key={key}>
                    <button className="master-sort" type="button" onClick={() => changeMasterSort(key)}>
                      {label}<span aria-hidden="true">{sortArrow(key)}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedMasterSummaries.map(({ master, rows, revenue: masterRevenue, pay, previousRevenue: masterPreviousRevenue, previousPay }) => (
                <tr className={master.name === topMasterName ? 'master-top-row' : ''} key={master.name}>
                  <td>
                    <div className="master-name-line">
                      <strong>{master.name}</strong>
                      {master.name === topMasterName ? <span className="master-top-mark" aria-label="Лидер по выручке" title="Лидер по выручке">★</span> : null}
                    </div>
                    <small>{rows.reduce((sum, sale) => sum + clients(sale), 0)} клиентов</small>
                  </td>
                  <td>
                    <span className="master-metric-value">{money(masterRevenue)} сум</span>
                    {priorRange ? <MasterMetricComparison current={masterRevenue} previous={masterPreviousRevenue} /> : null}
                  </td>
                  <td>
                    <strong className="master-metric-value">{money(pay)} сум</strong>
                    {priorRange ? <MasterMetricComparison current={pay} previous={previousPay} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="payout-total"><span>Итого выплатить мастерам</span><strong>{money(totalMasterPayout)} сум</strong></div>
      </div>

      <div className="card wide detailed-report-card">
        <SectionHeading label="Детальный отчёт по мастерам" range={range} />
        <Rows
          rows={[...sales].sort((left, right) => (
            String(right.created_at || rowDate(right)).localeCompare(String(left.created_at || rowDate(left)))
          ))}
          empty="За выбранный период продаж нет."
          render={(sale) => {
            const master = data.byName[sale.master];
            const amount = saleTotal(sale);
            const masterEarning = masterGrossPay(amount, Number(master?.pct || 40));
            const payment = sale.cash ? 'Наличные' : sale.card ? 'Карта' : 'QR Paynet';
            const canDelete = recentSaleCanBeDeleted(rowDate(sale));
            return (
              <div className="row detailed-sale" key={sale.id}>
                <div>
                  <strong>{sale.master}</strong>
                  <span>{displayDateTime(sale.created_at)} · {payment}</span>
                  <span>{clientType(sale)} · клиентов: {clients(sale)}</span>
                </div>
                <div className="detailed-sale-amounts">
                  <strong>{money(amount)} сум</strong>
                  <span>мастеру: {money(masterEarning)} сум</span>
                  <button className="del detailed-sale-delete" disabled={!canDelete} title={canDelete ? 'Удалить продажу' : 'Срок удаления 2 дня истёк'} type="button" onClick={() => deleteDetailedSale(sale)}>×</button>
                </div>
              </div>
            );
          }}
        />
      </div>
    </section>
  );
}

function AttendanceView({ data, reload, setError }) {
  const [period, setPeriod] = useState('day');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [fineForm, setFineForm] = useState({
    master: data.activeMasters[0]?.name || '',
    d: TODAY,
    amount: '',
  });
  const [settings, setSettings] = useState({
    shift_start: data.settings.shift_start || '09:00',
    salon_lat: data.settings.salon_lat || '',
    salon_lng: data.settings.salon_lng || '',
    salon_radius: data.settings.salon_radius || 100,
  });
  const [message, setMessage] = useState('');
  const [savingFineKey, setSavingFineKey] = useState('');
  const [savingDayOffKey, setSavingDayOffKey] = useState('');
  const range = getRange(period, customFrom, customTo, data.attendance);
  const filteredAttendance = data.attendance
    .filter((item) => inRange(rowDate(item), range.from, range.to))
    .sort(newestFirst);
  const attendanceRows = period === 'day'
    ? data.activeMasters.map((master) => (
        data.attendance.find((item) => item.master === master.name && rowDate(item) === TODAY)
        || { master: master.name, d: TODAY, arrived: '' }
      ))
    : filteredAttendance;
  const filteredFines = data.fines
    .filter((fine) => inRange(rowDate(fine), range.from, range.to))
    .sort(newestFirst);
  const shiftStart = settings.shift_start || '09:00';

  async function saveSettings(event) {
    event.preventDefault();
    setError('');
    await callLegacyApi('setSettings', {
      shift_start: settings.shift_start,
      salon_lat: settings.salon_lat === '' ? null : Number(settings.salon_lat),
      salon_lng: settings.salon_lng === '' ? null : Number(settings.salon_lng),
      salon_radius: Number(settings.salon_radius) || 100,
    });
    setMessage('Настройки сохранены.');
    await reload();
  }

  async function useMyLocation() {
    if (!navigator.geolocation) return setError('Геолокация не поддерживается.');
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 7000 });
      });
      setSettings((current) => ({
        ...current,
        salon_lat: position.coords.latitude,
        salon_lng: position.coords.longitude,
      }));
    } catch {
      setError('Не удалось получить геолокацию.');
    }
  }

  async function saveAttendance(master, date, arrived) {
    setError('');
    if (arrived) await callLegacyApi('setAttendance', { master, d: date, arrived });
    else await callLegacyApi('delAttendance', { master, d: date });
    await reload();
  }

  async function toggleDayOff(master, date, enabled) {
    const masterRecord = data.masters.find((item) => item.name === master);
    if (!masterRecord?.id) return setError('Не найден master_id для выбранного мастера.');
    if (enabled && !confirm(`Отметить ${master} как выходного за ${displayDate(date)}? Календарь дня будет закрыт для новых записей.`)) return;
    const key = `${masterRecord.id}-${date}`;
    setSavingDayOffKey(key);
    setError('');
    setMessage('');
    try {
      await callLegacyApi('setMasterDayOff', {
        master_id: masterRecord.id,
        work_date: date,
        enabled,
      });
      setMessage(enabled ? `Выходной установлен: ${master}.` : `Выходной отменён: ${master}.`);
      await reload();
    } catch (dayOffError) {
      const conflicts = dayOffError.details?.appointments || [];
      if (dayOffError.message === 'appointments_exist') {
        const times = conflicts.map((appointment) => appointmentTime(appointment.starts_at)).join(', ');
        setError(`Выходной не установлен: есть активные записи${times ? ` на ${times}` : ''}. Сначала перенесите или отмените их.`);
      } else {
        setError(dayOffError.message || 'Не удалось изменить выходной.');
      }
    } finally {
      setSavingDayOffKey('');
    }
  }

  async function createFine(master, date, amount) {
    setError('');
    setMessage('');
    await callLegacyApi('addFine', { master, d: date || TODAY, amount });
    setMessage(`Штраф ${money(amount)} сум выставлен: ${master}.`);
    await reload();
  }

  async function addFine(event) {
    event.preventDefault();
    const amount = Number(fineForm.amount);
    if (!amount || amount <= 0) return setError('Введите сумму штрафа.');
    await createFine(fineForm.master, fineForm.d, amount);
    setFineForm((current) => ({ ...current, amount: '' }));
  }

  async function addLateFine(item) {
    const key = `${item.master}-${rowDate(item)}`;
    setSavingFineKey(key);
    try {
      await createFine(item.master, rowDate(item), 50000);
    } finally {
      setSavingFineKey('');
    }
  }

  async function deleteFine(fine) {
    if (!recentFineCanBeDeleted(rowDate(fine))) {
      setError('Можно удалять только штрафы не старше 7 дней.');
      return;
    }
    if (!confirm(`Удалить штраф ${fine.master} на ${money(fine.amount)} сум?`)) return;
    setError('');
    await callLegacyApi('delFine', { id: fine.id });
    setMessage('Штраф удалён.');
    await reload();
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <SectionHeading label="Посещаемость" range={range} />
        <PeriodPicker
          period={period}
          setPeriod={setPeriod}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
        />
        <div className="attendance-list">
          {attendanceRows.length ? attendanceRows.map((item) => {
            const masterRecord = data.masters.find((master) => master.name === item.master);
            const dayOff = data.dayStatuses.some((day) => (
              String(day.master_id) === String(masterRecord?.id) && day.work_date === rowDate(item)
            ));
            const arrived = displayTime(item.arrived || item.arrived_at);
            const lateBy = arrived ? minutesLate(arrived, shiftStart) : 0;
            const status = dayOff ? 'day-off' : !arrived ? 'missing' : lateBy > 0 ? 'late' : 'on-time';
            const fineKey = `${item.master}-${rowDate(item)}`;
            const quickFineExists = data.fines.some((fine) => (
              fine.master === item.master
              && rowDate(fine) === rowDate(item)
              && Number(fine.amount) === 50000
            ));

            return (
              <div className={`attendance-row ${status}`} key={`${item.master}-${rowDate(item)}`}>
                <div className="attendance-person">
                  <strong>{item.master}</strong>
                  <span>{displayDate(rowDate(item))}</span>
                  <span>
                    {dayOff
                      ? 'выходной · календарь закрыт'
                      : !arrived
                      ? 'нет отметки'
                      : lateBy > 0
                        ? `опоздал на ${lateBy} мин`
                        : 'пришёл вовремя'}
                  </span>
                </div>
                <div className="attendance-actions">
                  <input
                    aria-label={`Время прихода ${item.master} ${displayDate(rowDate(item))}`}
                    type="time"
                    defaultValue={arrived}
                    disabled={dayOff}
                    onBlur={(event) => saveAttendance(item.master, rowDate(item), event.target.value)}
                  />
                  <button
                    className={`day-off-button ${dayOff ? 'active' : ''}`}
                    disabled={savingDayOffKey === `${masterRecord?.id}-${rowDate(item)}`}
                    type="button"
                    onClick={() => toggleDayOff(item.master, rowDate(item), !dayOff)}
                  >
                    {savingDayOffKey === `${masterRecord?.id}-${rowDate(item)}`
                      ? 'Сохраняю…'
                      : dayOff ? 'Отменить выходной' : 'Выходной'}
                  </button>
                  {status === 'late' ? (
                    <button
                      className="fine-button"
                      disabled={quickFineExists || savingFineKey === fineKey}
                      title="Автоматически выставить штраф 50 000 сум"
                      type="button"
                      onClick={() => addLateFine(item)}
                    >
                      {quickFineExists ? 'Штраф выставлен' : savingFineKey === fineKey ? 'Сохраняю…' : 'Штраф'}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          }) : <p className="hint">За выбранный период отметок нет.</p>}
        </div>
      </div>

      <details className="card collapsible-card">
        <summary>
          <span>Настройки смены и салона</span>
          <span className="summary-action">Открыть</span>
        </summary>
        <form className="collapsible-content" onSubmit={saveSettings}>
          <label>Начало смены<input type="time" value={settings.shift_start} onChange={(event) => setSettings({ ...settings, shift_start: event.target.value })} /></label>
          <label>Широта<input type="number" step="any" value={settings.salon_lat} onChange={(event) => setSettings({ ...settings, salon_lat: event.target.value })} /></label>
          <label>Долгота<input type="number" step="any" value={settings.salon_lng} onChange={(event) => setSettings({ ...settings, salon_lng: event.target.value })} /></label>
          <label>Радиус, м<input type="number" value={settings.salon_radius} onChange={(event) => setSettings({ ...settings, salon_radius: event.target.value })} /></label>
          <button className="btn ghost" type="button" onClick={useMyLocation}>Задать по моему положению</button>
          <button className="btn" type="submit">Сохранить настройки</button>
        </form>
      </details>

      <form className="card" onSubmit={addFine}>
        <h2>Штрафы</h2>
        <select value={fineForm.master} onChange={(event) => setFineForm({ ...fineForm, master: event.target.value })}>
          {data.activeMasters.map((master) => <option key={master.name} value={master.name}>{master.name}</option>)}
        </select>
        <input type="date" value={fineForm.d} onChange={(event) => setFineForm({ ...fineForm, d: event.target.value })} />
        <MoneyInput placeholder="например, 50 000" value={fineForm.amount} onChange={(amount) => setFineForm({ ...fineForm, amount })} />
        <button className="btn" type="submit">Добавить штраф</button>
        <Rows rows={filteredFines} empty="Штрафов за период нет." render={(fine) => {
          const canDelete = recentFineCanBeDeleted(rowDate(fine));
          return (
            <div className="row fine-row" key={fine.id}>
              <div>
                <strong>{fine.master}</strong>
                <span>{displayDate(rowDate(fine))} · −{money(fine.amount)} сум</span>
              </div>
              <button
                className="del"
                disabled={!canDelete}
                title={canDelete ? 'Удалить штраф' : 'Срок удаления 7 дней истёк'}
                type="button"
                onClick={() => deleteFine(fine)}
              >
                ×
              </button>
            </div>
          );
        }} />
        {message ? <p className="success">{message}</p> : null}
      </form>
    </section>
  );
}

const APPOINTMENT_STATUS_LABELS = {
  pending: 'Ожидает',
  confirmed: 'Подтверждена',
  completed: 'Завершена',
  cancelled: 'Отменена',
  no_show: 'Неявка',
};

function CalendarView({ data, reload, setError }) {
  const canManage = ['owner', 'admin'].includes(data.appRole);
  const ownMaster = data.masters.find((master) => master.name === data.me);
  const canCreateOwnAppointment = Boolean(ownMaster?.id);
  const [date, setDate] = useState(TODAY);
  const [selectedMaster, setSelectedMaster] = useState(canManage ? 'all' : String(ownMaster?.id || ''));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcomeDialog, setOutcomeDialog] = useState(null);
  const [outcomeForm, setOutcomeForm] = useState({ reason_code: '', reason_note: '' });
  const [form, setForm] = useState({
    master_id: String(ownMaster?.id || data.activeMasters[0]?.id || ''),
    service_id: data.bookingServices[0]?.id || '',
    time: '10:00',
    client_name: '',
    client_phone: '',
    notes: '',
    status: 'confirmed',
  });

  const visibleMasters = canManage
    ? data.activeMasters.filter((master) => selectedMaster === 'all' || String(master.id) === selectedMaster)
    : data.activeMasters.filter((master) => String(master.id) === String(ownMaster?.id));
  const visibleIds = new Set(visibleMasters.map((master) => String(master.id)));
  const appointments = data.appointments
    .filter((appointment) => (
      visibleIds.has(String(appointment.master_id)) && tashkentDate(appointment.starts_at) === date
    ))
    .sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at)));

  function isDayOff(masterId) {
    return data.dayStatuses.some((day) => (
      String(day.master_id) === String(masterId) && day.work_date === date && day.status === 'day_off'
    ));
  }

  function moveDate(days) {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + days);
    setDate(localDate(next));
  }

  async function addAppointment(event) {
    event.preventDefault();
    if (!form.master_id || !form.service_id || !form.time || !form.client_name.trim() || !form.client_phone.trim()) {
      return setError('Выберите мастера, услугу, время и укажите имя и телефон клиента.');
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await callLegacyApi('addAppointment', {
        ...form,
        master_id: Number(form.master_id),
        starts_at: `${date}T${form.time}:00+05:00`,
      });
      setMessage('Запись добавлена в календарь.');
      setForm((current) => ({ ...current, client_name: '', client_phone: '', notes: '' }));
      await reload();
    } catch (appointmentError) {
      const labels = {
        slot_already_booked: 'Это время пересекается с другой активной записью.',
        master_day_off: 'У мастера выходной — запись на этот день закрыта.',
        client_blocked: 'Клиент заблокирован. Сначала разблокируйте его в CRM.',
      };
      setError(labels[appointmentError.message] || appointmentError.message || 'Не удалось создать запись.');
    } finally {
      setSaving(false);
    }
  }

  async function setAppointmentStatus(appointment, status) {
    setError('');
    setMessage('');
    await callLegacyApi('setAppointmentStatus', { id: appointment.id, status });
    setMessage(`Статус изменён: ${APPOINTMENT_STATUS_LABELS[status]}.`);
    await reload();
  }

  function openOutcomeDialog(appointment, outcome, cancelledBy = null) {
    setError('');
    setMessage('');
    setOutcomeForm({ reason_code: '', reason_note: '' });
    setOutcomeDialog({ appointment, outcome, cancelledBy });
  }

  async function submitOutcome(event) {
    event.preventDefault();
    const reasonCode = outcomeDialog.outcome === 'completed' ? null : outcomeForm.reason_code;
    const reasonNote = outcomeForm.reason_note.trim();
    if (!reasonCode) return setError('Выберите обязательную причину.');
    if (reasonRequiresNote(reasonCode) && !reasonNote) return setError('Для варианта «Другая причина» добавьте комментарий.');
    setSaving(true);
    setError('');
    try {
      await callLegacyApi('setAppointmentOutcome', {
        id: outcomeDialog.appointment.id,
        outcome: outcomeDialog.outcome,
        cancelled_by: outcomeDialog.cancelledBy,
        reason_code: reasonCode,
        reason_note: reasonNote || null,
      });
      setMessage(`Статус изменён: ${APPOINTMENT_STATUS_LABELS[outcomeDialog.outcome]}.`);
      setOutcomeDialog(null);
      await reload();
    } catch (outcomeError) {
      const labels = {
        outcome_before_start: 'Завершить запись или отметить неявку можно только после времени начала.',
        invalid_status_transition: 'Эта запись уже имеет финальный статус.',
        outcome_already_recorded: 'Для записи уже сохранён другой итог.',
      };
      setError(labels[outcomeError.message] || outcomeError.message || 'Не удалось сохранить итог записи.');
    } finally {
      setSaving(false);
    }
  }

  async function completeAppointment(appointment) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await callLegacyApi('setAppointmentOutcome', {
        id: appointment.id,
        outcome: 'completed',
        cancelled_by: null,
        reason_code: null,
        reason_note: null,
      });
      setMessage('Статус изменён: Завершена.');
      await reload();
    } catch (outcomeError) {
      setError(outcomeError.message === 'outcome_before_start'
        ? 'Завершить запись можно только после времени начала.'
        : outcomeError.message || 'Не удалось завершить запись.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleCalendarDayOff(master, enabled) {
    if (enabled && !confirm(`Поставить выходной ${master.name} на ${displayDate(date)}?`)) return;
    setError('');
    setMessage('');
    try {
      await callLegacyApi('setMasterDayOff', { master_id: master.id, work_date: date, enabled });
      setMessage(enabled ? `Календарь ${master.name} закрыт на весь день.` : `Выходной ${master.name} отменён.`);
      await reload();
    } catch (dayOffError) {
      if (dayOffError.message === 'appointments_exist') {
        const times = (dayOffError.details?.appointments || []).map((item) => appointmentTime(item.starts_at)).join(', ');
        setError(`Сначала перенесите или отмените активные записи${times ? `: ${times}` : ''}.`);
      } else setError(dayOffError.message || 'Не удалось изменить выходной.');
    }
  }

  return (
    <section className="view-grid calendar-view">
      <div className="card wide calendar-toolbar">
        <div className="calendar-date-nav">
          <button className="btn ghost" type="button" onClick={() => moveDate(-1)}>←</button>
          <label>Дата<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <button className="btn ghost" type="button" onClick={() => moveDate(1)}>→</button>
        </div>
        {canManage ? (
          <label>Мастер
            <select value={selectedMaster} onChange={(event) => setSelectedMaster(event.target.value)}>
              <option value="all">Все мастера</option>
              {data.activeMasters.map((master) => <option key={master.id} value={master.id}>{master.name}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      {visibleMasters.map((master) => {
        const masterAppointments = appointments.filter((appointment) => String(appointment.master_id) === String(master.id));
        const dayOff = isDayOff(master.id);
        return (
          <article className={`card calendar-master-card ${dayOff ? 'day-off' : ''}`} key={master.id}>
            <div className="calendar-master-heading">
              <div><h2>{master.name}</h2><span>{displayDate(date)}</span></div>
              {dayOff ? <strong className="calendar-day-off-badge">Выходной</strong> : null}
              {canManage ? (
                <button className={`day-off-button ${dayOff ? 'active' : ''}`} type="button" onClick={() => toggleCalendarDayOff(master, !dayOff)}>
                  {dayOff ? 'Отменить выходной' : 'Выходной'}
                </button>
              ) : null}
            </div>
            {dayOff ? <p className="hint">Дневной календарь закрыт для новых записей.</p> : null}
            <div className="calendar-appointments">
              {masterAppointments.length ? masterAppointments.map((appointment) => (
                <div className={`calendar-appointment status-${appointment.status}`} key={appointment.id}>
                  <time>{appointmentTime(appointment.starts_at)}–{appointmentTime(appointment.ends_at)}</time>
                  <div>
                    <strong>{appointment.client_name}</strong>
                    <span>{appointment.service_name} · {money(appointment.price_uzs)} сум</span>
                    {appointment.client_phone ? <span>{appointment.client_phone}</span> : null}
                    {appointment.client_is_blocked ? <span className="client-block-warning">Клиент заблокирован</span> : null}
                    {appointment.status_reason_code ? <span>Причина: {APPOINTMENT_REASON_LABELS[appointment.status_reason_code] || appointment.status_reason_code}</span> : null}
                    {appointment.status_reason_note ? <span>Комментарий: {appointment.status_reason_note}</span> : null}
                  </div>
                  <b>{APPOINTMENT_STATUS_LABELS[appointment.status] || appointment.status}</b>
                  {(canManage || String(appointment.master_id) === String(ownMaster?.id)) && ['pending', 'confirmed'].includes(appointment.status) ? (
                    <div className="calendar-appointment-actions">
                      {appointment.status === 'pending' ? <button type="button" onClick={() => setAppointmentStatus(appointment, 'confirmed')}>Подтвердить</button> : null}
                      <button disabled={saving || !appointmentOutcomeAllowed(appointment.status, 'completed', appointment.starts_at)} type="button" onClick={() => completeAppointment(appointment)}>Завершить</button>
                      <button className="danger" disabled={saving || !appointmentOutcomeAllowed(appointment.status, 'no_show', appointment.starts_at)} type="button" onClick={() => openOutcomeDialog(appointment, 'no_show')}>Неявка</button>
                      <button className="danger" disabled={saving} type="button" onClick={() => openOutcomeDialog(appointment, 'cancelled', 'client')}>Отменил клиент</button>
                      <button className="danger" disabled={saving} type="button" onClick={() => openOutcomeDialog(appointment, 'cancelled', 'salon')}>Отменил салон</button>
                    </div>
                  ) : null}
                </div>
              )) : <p className="hint">Записей на этот день нет.</p>}
            </div>
          </article>
        );
      })}

      {canManage || canCreateOwnAppointment ? (
        <form className="card calendar-new-form" onSubmit={addAppointment}>
          <h2>Новая запись</h2>
          {canManage ? (
            <label>Мастер<select value={form.master_id} onChange={(event) => setForm({ ...form, master_id: event.target.value })}>{data.activeMasters.map((master) => <option key={master.id} value={master.id}>{master.name}</option>)}</select></label>
          ) : <label>Барбер<input value={ownMaster?.name || ''} readOnly /></label>}
          <label>Услуга<select value={form.service_id} onChange={(event) => setForm({ ...form, service_id: event.target.value })}>{data.bookingServices.filter((service) => service.active !== false).map((service) => <option key={service.id} value={service.id}>{service.name_ru} · {money(service.price_uzs)} сум</option>)}</select></label>
          <label>Время<input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} /></label>
          <label>Имя клиента<input maxLength="120" value={form.client_name} onChange={(event) => setForm({ ...form, client_name: event.target.value })} /></label>
          <label>Телефон<input inputMode="tel" required value={form.client_phone} onChange={(event) => setForm({ ...form, client_phone: event.target.value })} /></label>
          <label>Комментарий<input maxLength="500" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          {canManage ? <label>Статус<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="confirmed">Подтверждена</option><option value="pending">Ожидает подтверждения</option></select></label> : null}
          <button className="btn" disabled={saving || !data.bookingServices.length} type="submit">{saving ? 'Сохраняю…' : 'Добавить запись'}</button>
        </form>
      ) : null}
      {message ? <p className="notice success">{message}</p> : null}
      {outcomeDialog ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) setOutcomeDialog(null);
        }}>
          <form className="card outcome-dialog" role="dialog" aria-modal="true" aria-labelledby="outcome-dialog-title" onSubmit={submitOutcome}>
            <h2 id="outcome-dialog-title">
              {outcomeDialog.outcome === 'no_show'
                ? 'Причина неявки'
                : outcomeDialog.cancelledBy === 'client' ? 'Причина отмены клиентом' : 'Причина отмены салоном'}
            </h2>
            <p className="hint">{outcomeDialog.appointment.client_name} · {appointmentTime(outcomeDialog.appointment.starts_at)}</p>
            <label>Причина
              <select required value={outcomeForm.reason_code} onChange={(event) => setOutcomeForm({ ...outcomeForm, reason_code: event.target.value })}>
                <option value="">Выберите причину</option>
                {APPOINTMENT_OUTCOME_REASONS[outcomeDialog.outcome === 'no_show' ? 'no_show' : outcomeDialog.cancelledBy].map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            <label>Комментарий{reasonRequiresNote(outcomeForm.reason_code) ? ' (обязательно)' : ''}
              <textarea maxLength="500" required={reasonRequiresNote(outcomeForm.reason_code)} rows="4" value={outcomeForm.reason_note} onChange={(event) => setOutcomeForm({ ...outcomeForm, reason_note: event.target.value })} />
            </label>
            <div className="outcome-dialog-actions">
              <button className="btn ghost" disabled={saving} type="button" onClick={() => setOutcomeDialog(null)}>Отмена</button>
              <button className="btn" disabled={saving} type="submit">{saving ? 'Сохраняю…' : 'Сохранить итог'}</button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

const CLIENT_STATUS_LABELS = {
  lead: 'Лид',
  active: 'Активный',
  inactive: 'Неактивный',
  blocked: 'Заблокирован',
};

const CLIENT_CONSENT_LABELS = {
  unknown: 'Не запрошено',
  granted: 'Разрешено',
  denied: 'Запрещено',
};

function ClientsView({ data, reload, setError }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const clients = [...data.clients].sort((left, right) => (
    String(right.last_contact_at || '').localeCompare(String(left.last_contact_at || ''))
  ));
  const normalizedQuery = query.trim().toLowerCase();
  const filteredClients = clients.filter((client) => {
    const matchesQuery = !normalizedQuery || [
      client.full_name,
      client.phone_e164,
      client.telegram_username,
    ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
    if (!matchesQuery) return false;
    if (filter === 'return') return client.days_since_last_visit == null || Number(client.days_since_last_visit) >= 45;
    if (filter === 'marketing') return client.eligible_for_marketing === true;
    if (filter === 'blocked') return Boolean(client.blocked_at);
    return true;
  });
  const returningClients = clients.filter((client) => (
    client.days_since_last_visit == null || Number(client.days_since_last_visit) >= 45
  )).length;
  const marketingClients = clients.filter((client) => client.eligible_for_marketing === true).length;
  const blockedClients = clients.filter((client) => Boolean(client.blocked_at)).length;

  async function setClientBlocked(client, blocked) {
    let reason = null;
    if (blocked) {
      reason = window.prompt(`Укажите обязательную причину блокировки клиента ${client.full_name}:`, '')?.trim();
      if (!reason) return;
      if (reason.length > 500) return setError('Причина блокировки не должна превышать 500 символов.');
    } else if (!window.confirm(`Разблокировать клиента ${client.full_name}?`)) return;
    setError('');
    try {
      await callLegacyApi('setClientBlocked', { id: client.id, blocked, reason });
      await reload();
    } catch (clientError) {
      setError(clientError.message || 'Не удалось изменить блокировку клиента.');
    }
  }

  function exportClients() {
    setError('');
    try {
      downloadClientWorkbook(clients);
    } catch (exportError) {
      setError(exportError.message || 'Не удалось подготовить Excel-файл.');
    }
  }

  return (
    <section className="view-grid clients-view">
      <div className="card wide clients-toolbar">
        <div>
          <h2>Клиентская база</h2>
          <p className="hint">Имена, телефоны и история посещений. Рассылки разрешены только клиентам с подтверждённым согласием.</p>
        </div>
        <button className="btn" disabled={!clients.length} onClick={exportClients} type="button">
          Скачать всю базу .xlsx
        </button>
      </div>

      <div className="tiles wide">
        <Tile label="Всего клиентов" value={clients.length} />
        <Tile label="Активные" value={clients.filter((client) => client.lifecycle_status === 'active').length} />
        <Tile label="Давно не были" value={returningClients} hint="45 дней и более" />
        <Tile label="Можно уведомлять" value={marketingClients} hint="есть согласие" />
        <Tile label="Заблокированы" value={blockedClients} />
      </div>

      <div className="card wide clients-filters">
        <label>
          Поиск
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Имя, телефон или Telegram"
            type="search"
            value={query}
          />
        </label>
        <label>
          Список
          <select onChange={(event) => setFilter(event.target.value)} value={filter}>
            <option value="all">Все клиенты</option>
            <option value="return">Давно не были</option>
            <option value="marketing">Можно уведомлять</option>
            <option value="blocked">Заблокированные</option>
          </select>
        </label>
      </div>

      <div className="card wide">
        <div className="section-title">
          <h2>Клиенты</h2>
          <span>{filteredClients.length} из {clients.length}</span>
        </div>
        <Rows
          empty="Клиенты по выбранному фильтру не найдены."
          rows={filteredClients}
          render={(client) => (
            <article className="client-row" key={client.id}>
              <div className="client-main">
                <strong>{client.full_name}</strong>
                <a href={`tel:${client.phone_e164}`}>{client.phone_e164}</a>
                {client.telegram_username ? <span>@{String(client.telegram_username).replace(/^@/, '')}</span> : null}
              </div>
              <div className="client-meta">
                <span>{CLIENT_STATUS_LABELS[client.lifecycle_status] || client.lifecycle_status}</span>
                <span>Визитов: {Number(client.visit_count) || 0}</span>
                <span>Последний визит: {client.last_visit_at ? displayDateTime(client.last_visit_at) : 'ещё не был'}</span>
                <span>Неявок: {Number(client.no_show_count) || 0}</span>
                <span>Последняя неявка: {client.last_no_show_at ? displayDateTime(client.last_no_show_at) : 'нет'}</span>
                <span>Рассылка: {CLIENT_CONSENT_LABELS[client.marketing_consent] || 'Не запрошено'}</span>
                {client.blocked_at ? <span className="client-blocked-detail">Блокировка: {client.blocked_reason}</span> : null}
                <button className={client.blocked_at ? 'btn ghost client-block-button' : 'btn danger client-block-button'} type="button" onClick={() => setClientBlocked(client, !client.blocked_at)}>
                  {client.blocked_at ? 'Разблокировать' : 'Заблокировать'}
                </button>
              </div>
            </article>
          )}
        />
      </div>
    </section>
  );
}

function FinanceView({ data, reload, setError }) {
  const [period, setPeriod] = useState('day');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [tab, setTab] = useState('ishxona');
  const [form, setForm] = useState({ date: TODAY, section: 'ishxona', name: '', qty: '', amount_uzs: '', usd_rate: localStorage.getItem('usdRate') || '12200', minus_from: '' });
  const financeRows = [...data.sales, ...data.expenses];
  const range = getRange(period, customFrom, customTo, financeRows);
  const priorRange = previousRange(range, period);
  const sales = data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), range.from, range.to),
  );
  const expenses = data.expenses.filter((expense) => inRange(rowDate(expense, 'date'), range.from, range.to));
  const fines = data.fines.filter((fine) => inRange(rowDate(fine), range.from, range.to));
  const previousSales = priorRange ? data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), priorRange.from, priorRange.to),
  ) : [];
  const previousExpenses = priorRange ? data.expenses.filter(
    (expense) => inRange(rowDate(expense, 'date'), priorRange.from, priorRange.to),
  ) : [];
  const previousFines = priorRange ? data.fines.filter(
    (fine) => inRange(rowDate(fine), priorRange.from, priorRange.to),
  ) : [];
  const revenue = totalSalesAmount(sales);
  const payouts = masterPayoutForPeriod(data, sales, fines);
  const salon = revenue - payouts;
  const ishxonaExpenses = totalExpenses(expenses.filter((expense) => expense.section === 'ishxona'));
  const previousRevenue = totalSalesAmount(previousSales);
  const previousPayouts = masterPayoutForPeriod(data, previousSales, previousFines);
  const previousSalon = previousRevenue - previousPayouts;
  const previousIshxonaExpenses = totalExpenses(previousExpenses.filter((expense) => expense.section === 'ishxona'));
  const comparison = (current, previous) => priorRange ? comparisonToPrevious(current, previous, priorRange) : {};
  const visibleExpenses = expenses.filter((expense) => expense.section === tab).sort(newestFirst);
  const visibleExpenseTotal = totalExpenses(visibleExpenses);

  async function addExpense(event) {
    event.preventDefault();
    const amount = Number(form.amount_uzs);
    if (!form.name.trim() || !amount) return setError('Введите название и сумму расхода.');
    await callLegacyApi('addExpense', {
      date: form.date || TODAY,
      section: form.section,
      name: form.name.trim(),
      qty: form.qty || null,
      amount_uzs: amount,
      usd_rate: Number(form.usd_rate) || null,
      minus_from: form.section === 'ishxona' ? form.minus_from || null : null,
    });
    if (form.usd_rate) localStorage.setItem('usdRate', form.usd_rate);
    setForm((current) => ({ ...current, name: '', qty: '', amount_uzs: '' }));
    await reload();
  }

  async function deleteExpense(id) {
    await callLegacyApi('delExpense', { id });
    await reload();
  }

  function sectionExpense(section) {
    return data.expenses
      .filter((expense) => expense.section === section)
      .reduce((totals, expense) => {
        const amount = Number(expense.amount_uzs) || 0;
        const rate = Number(expense.usd_rate) || 0;
        totals.uzs += amount;
        if (rate) totals.usd += amount / rate;
        return totals;
      }, { uzs: 0, usd: 0 });
  }

  return (
    <section className="view-grid">
      <div className="card wide">
        <SectionHeading label="Финансы" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="hero profit-value">{money(salon - ishxonaExpenses)} <small>сум прибыль</small></div>
        <div className="tiles">
          <Tile label="Выручка" value={money(revenue)} {...comparison(revenue, previousRevenue)} />
          <Tile label="Зарплаты мастеров" value={money(payouts)} {...comparison(payouts, previousPayouts)} />
          <Tile label="Остаток салону" value={money(salon)} {...comparison(salon, previousSalon)} tone="salon" />
          <Tile label="Расходы" value={money(ishxonaExpenses)} {...comparison(ishxonaExpenses, previousIshxonaExpenses)} danger />
          <Tile label="Прибыль" value={money(salon - ishxonaExpenses)} {...comparison(salon - ishxonaExpenses, previousSalon - previousIshxonaExpenses)} tone="total" />
        </div>
      </div>

      <div className="card wide">
        <h2>Вложения</h2>
        <div className="tiles">
          {['murod', 'jamshid'].map((owner) => {
            const item = investmentSummary(data.expenses, owner);
            const netUzs = item.invested - item.returned;
            const netUsd = item.investedUsd - item.returnedUsd;
            return (
              <Tile
                key={owner}
                label={owner === 'murod' ? 'Мурод' : 'Жамшид'}
                value={usdMoney(netUsd)}
                secondary={`${money(netUzs)} сум`}
                hint={`вложено ${usdMoney(item.investedUsd)} · возврат ${usdMoney(item.returnedUsd)}`}
              />
            );
          })}
          {(() => {
            const item = sectionExpense('ishxona');
            return (
              <Tile
                label="Расходы Ишхоны"
                value={usdMoney(item.usd)}
                secondary={`${money(item.uzs)} сум`}
                hint={`расходы ${usdMoney(item.usd)}`}
              />
            );
          })()}
        </div>
      </div>

      <div className="card wide">
        <h2>Расходы</h2>
        <div className="seg">
          {[
            ['ishxona', 'Ишхона'],
            ['murod', 'Мурод'],
            ['jamshid', 'Жамшид'],
          ].map(([value, label]) => <button className={tab === value ? 'on' : ''} key={value} type="button" onClick={() => setTab(value)}>{label}</button>)}
        </div>
        <div className="section-total">
          <span>За выбранный период: {visibleExpenses.length} записей</span>
          <strong>{money(visibleExpenseTotal)} сум</strong>
        </div>
        <Rows rows={visibleExpenses} empty="Расходов за период нет." render={(expense) => (
          <div className="row" key={expense.id}>
            <div><strong>{expense.name}</strong><span>{rowDate(expense, 'date')} · {expense.minus_from ? `минус ${expense.minus_from}` : expense.section}</span></div>
            <div><strong>{money(expense.amount_uzs)}</strong><button className="del" type="button" onClick={() => deleteExpense(expense.id)}>×</button></div>
          </div>
        )} />
      </div>

      <form className="card" onSubmit={addExpense}>
        <h2>Добавить расход</h2>
        <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
        <select value={form.section} onChange={(event) => setForm({ ...form, section: event.target.value })}>
          <option value="ishxona">Ишхона</option>
          <option value="murod">Мурод</option>
          <option value="jamshid">Жамшид</option>
        </select>
        <input placeholder="Наименование" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input placeholder="Количество" value={form.qty} onChange={(event) => setForm({ ...form, qty: event.target.value })} />
        <MoneyInput placeholder="Сумма" value={form.amount_uzs} onChange={(amount_uzs) => setForm({ ...form, amount_uzs })} />
        <MoneyInput placeholder="Курс USD" value={form.usd_rate} onChange={(usd_rate) => setForm({ ...form, usd_rate })} />
        {form.section === 'ishxona' ? (
          <select value={form.minus_from} onChange={(event) => setForm({ ...form, minus_from: event.target.value })}>
            <option value="">— нет —</option>
            <option value="murod">Мурод</option>
            <option value="jamshid">Жамшид</option>
          </select>
        ) : null}
        <button className="btn" type="submit">Добавить расход</button>
      </form>
    </section>
  );
}

function RevenueChart({ sales, previousSales = [], from, to, previousFrom, previousTo }) {
  const [selectedDay, setSelectedDay] = useState(null);
  const days = [];
  const cursor = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);

  while (cursor <= end && days.length < 370) {
    days.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const totals = Object.fromEntries(days.map((day) => [day, { revenue: 0, clients: 0 }]));
  sales.forEach((sale) => {
    const day = rowDate(sale);
    if (day in totals) {
      totals[day].revenue += saleTotal(sale);
      totals[day].clients += clients(sale);
    }
  });

  const values = days.map((day) => totals[day].revenue);
  const previousDays = [];
  if (previousFrom && previousTo) {
    const previousCursor = new Date(`${previousFrom}T12:00:00`);
    const previousEnd = new Date(`${previousTo}T12:00:00`);
    while (previousCursor <= previousEnd && previousDays.length < 370) {
      previousDays.push(localDate(previousCursor));
      previousCursor.setDate(previousCursor.getDate() + 1);
    }
  }
  const previousTotals = Object.fromEntries(previousDays.map((day) => [day, 0]));
  previousSales.forEach((sale) => {
    const day = rowDate(sale);
    if (day in previousTotals) previousTotals[day] += saleTotal(sale);
  });
  const previousValues = days.map((_, index) => previousTotals[previousDays[index]] || 0);
  const currentTotal = values.reduce((sum, value) => sum + value, 0);
  const previousTotal = previousValues.reduce((sum, value) => sum + value, 0);
  const max = Math.max(1, ...values, ...previousValues);
  const barWidth = Math.max(14, Math.min(38, Math.floor(480 / Math.max(1, days.length))));
  const gap = 6;
  const width = Math.max(170, days.length * (barWidth + gap) + 10);
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  const selectedIndex = days.indexOf(selectedDay);
  const selectedValue = selectedIndex >= 0 ? values[selectedIndex] : 0;
  const selectedPreviousDay = selectedIndex >= 0 ? previousDays[selectedIndex] : null;
  const selectedPreviousValue = selectedIndex >= 0 ? previousValues[selectedIndex] : 0;
  const selectedHeight = Math.round((selectedValue / max) * 100);
  const selectedCenter = selectedIndex >= 0
    ? 10 + selectedIndex * (barWidth + gap) + barWidth / 2
    : 0;
  const tooltipWidth = 150;
  const tooltipX = Math.max(4, Math.min(width - tooltipWidth - 4, selectedCenter - tooltipWidth / 2));
  const tooltipY = Math.max(2, 120 - selectedHeight - 40);

  return (
    <div className="revenue-chart" aria-label="Выручка по дням">
      <div className="chart-period-summary">
        <div><i className="chart-legend-current" /><span>{displayRange({ from, to })}</span><strong>{money(currentTotal)} сум</strong></div>
        {previousFrom && previousTo ? (
          <div><i className="chart-legend-previous" /><span>{displayRange({ from: previousFrom, to: previousTo })}</span><strong>{money(previousTotal)} сум</strong></div>
        ) : null}
      </div>
      <div className="chart">
        <svg height="150" viewBox={`0 0 ${width} 150`} width={width}>
        {days.map((day, index) => {
          const height = Math.round((values[index] / max) * 100);
          const previousHeight = Math.round((previousValues[index] / max) * 100);
          const x = 10 + index * (barWidth + gap);
          const isSelected = selectedDay === day;
          return (
            <g
              aria-label={`${displayDate(day)}: ${totals[day].clients} клиентов, выручка ${money(totals[day].revenue)} сум${previousDays[index] ? `; ${displayDate(previousDays[index])}: ${money(previousValues[index])} сум` : ''}`}
              className={`chart-bar ${isSelected ? 'selected' : ''}`}
              key={day}
              onClick={() => setSelectedDay((current) => current === day ? null : day)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedDay((current) => current === day ? null : day);
                }
              }}
              role="button"
              tabIndex="0"
            >
              <rect
                className="chart-bar-previous"
                fill="var(--brass)"
                height={previousHeight}
                opacity={previousValues[index] ? 0.35 : 0}
                rx="3"
                width={barWidth}
                x={x}
                y={120 - previousHeight}
              />
              <rect
                className="chart-bar-current"
                fill="var(--brass)"
                height={height}
                opacity={values[index] ? 0.95 : 0.18}
                rx="3"
                stroke={isSelected ? 'var(--ink)' : 'none'}
                strokeWidth={isSelected ? 2 : 0}
                width={barWidth}
                x={x}
                y={120 - height}
              />
              <rect fill="transparent" height="120" width={barWidth + gap} x={x - gap / 2} y="0" />
              {(days.length <= 14 || index % labelEvery === 0) ? (
                <text fill="var(--muted)" fontSize="9" textAnchor="middle" x={x + barWidth / 2} y="134">
                  {day.slice(8, 10)}.{day.slice(5, 7)}
                </text>
              ) : null}
            </g>
          );
        })}
        {selectedIndex >= 0 ? (
          <g className="chart-tooltip" pointerEvents="none">
            <rect
              fill="var(--surface)"
              height="34"
              rx="8"
              stroke="var(--line)"
              width={tooltipWidth}
              x={tooltipX}
              y={tooltipY}
            />
            <text fill="var(--muted)" fontSize="9" x={tooltipX + 9} y={tooltipY + 13}>
              {displayDate(selectedDay)} · {totals[selectedDay].clients} кл.
            </text>
            <text fill="var(--ink)" fontSize="11" fontWeight="700" x={tooltipX + 9} y={tooltipY + 27}>
              {money(totals[selectedDay].revenue)} сум
            </text>
          </g>
        ) : null}
        </svg>
      </div>
      {selectedIndex >= 0 ? (
        <div className="chart-selected-comparison" aria-live="polite">
          <div><span>{displayDate(selectedDay)} · текущий</span><strong>{money(selectedValue)} сум</strong></div>
          {selectedPreviousDay ? <div><span>{displayDate(selectedPreviousDay)} · прошлый</span><strong>{money(selectedPreviousValue)} сум</strong></div> : null}
        </div>
      ) : <p className="chart-tap-hint">Нажмите на столбец, чтобы сравнить конкретные дни.</p>}
    </div>
  );
}

function DebtsView({ data, reload, setError }) {
  const [showClosed, setShowClosed] = useState(false);
  const [openPaymentId, setOpenPaymentId] = useState(null);
  const [historyIds, setHistoryIds] = useState([]);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ counterparty: '', direction: 'i_owe', amount: '', currency: 'UZS', start_date: TODAY });
  const [payments, setPayments] = useState({});
  const [selectedDebtMonth, setSelectedDebtMonth] = useState(TODAY.slice(0, 7));
  const myDebts = data.debts.filter((debt) => debt.direction === 'i_owe');
  const activeDebts = myDebts.filter((debt) => !debt.is_closed).sort(newestFirst);
  const closedDebts = myDebts.filter((debt) => debt.is_closed).sort(newestFirst);
  const currentMonth = TODAY.slice(0, 7);
  const openDebtTotals = totalOpenDebtsByCurrency(data);

  function shiftDebtMonth(offset) {
    const [year, month] = currentMonth.split('-').map(Number);
    const date = new Date(year, month - 1 + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function debtMonthLabel(value) {
    const labels = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
    return labels[Number(value.slice(5, 7)) - 1];
  }

  function paid(debtId) {
    return totalPaidForDebt(data.debtPayments, debtId);
  }

  function currencyPayments(currency, month) {
    const ids = new Set(myDebts.filter((debt) => debt.currency === currency).map((debt) => String(debt.id)));
    return data.debtPayments
      .filter((payment) => ids.has(String(payment.debt_id)) && String(payment.date).startsWith(month))
      .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  }

  function plannedCurrencyPayment(currency) {
    return myDebts
      .filter((debt) => !debt.is_closed && debt.currency === currency)
      .reduce((sum, debt) => {
        const plan = debtPaymentPlan(debt);
        const remaining = Math.max(0, Number(debt.amount) - paid(debt.id));
        return sum + (plan ? Math.min(remaining, plan.monthly) : 0);
      }, 0);
  }

  const dashboard = ['USD', 'UZS'].map((currency) => {
    const currencyDebts = myDebts.filter((debt) => debt.currency === currency);
    const remaining = openDebtTotals[currency];
    const plannedPayment = plannedCurrencyPayment(currency);
    const forecast = Math.max(0, remaining - plannedPayment);
    const chartMonths = [-5, -4, -3, -2, -1, 0].map(shiftDebtMonth);
    const points = chartMonths.map((month) => {
      const started = currencyDebts
        .filter((debt) => !debt.start_date || String(debt.start_date).slice(0, 7) <= month)
        .reduce((sum, debt) => sum + (Number(debt.amount) || 0), 0);
      const debtIds = new Set(currencyDebts.map((debt) => String(debt.id)));
      const paidThroughMonth = data.debtPayments
        .filter((payment) => debtIds.has(String(payment.debt_id)) && String(payment.date).slice(0, 7) <= month)
        .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
      return { month, value: Math.max(0, started - paidThroughMonth) };
    });
    points.push({ month: shiftDebtMonth(1), value: forecast, forecast: true });
    return {
      currency,
      remaining,
      paidThisMonth: currencyPayments(currency, currentMonth),
      plannedPayment,
      forecast,
      points,
    };
  });
  const dashboardByCurrency = Object.fromEntries(dashboard.map((item) => [item.currency, item]));
  const selectedMonthIsForecast = selectedDebtMonth === shiftDebtMonth(1);
  const selectedDebtPayments = {
    UZS: selectedMonthIsForecast ? 0 : currencyPayments('UZS', selectedDebtMonth),
    USD: selectedMonthIsForecast ? 0 : currencyPayments('USD', selectedDebtMonth),
  };

  async function addDebt(event) {
    event.preventDefault();
    const amount = Number(form.amount);
    setError('');
    setMessage('');
    if (!form.counterparty.trim() || !amount) return setError('Укажите, кому вы должны, и сумму долга.');
    await callLegacyApi('addDebt', { ...form, amount, start_date: form.start_date || TODAY });
    setForm({ counterparty: '', direction: 'i_owe', amount: '', currency: 'UZS', start_date: TODAY });
    setMessage('Долг добавлен.');
    await reload();
  }

  async function addPayment(event, debt) {
    event.preventDefault();
    setError('');
    setMessage('');
    const payment = payments[debt.id] || {};
    const amount = Number(payment.amount);
    const remaining = Math.max(0, Number(debt.amount) - paid(debt.id));
    if (!amount) return setError('Введите сумму платежа.');
    if (amount > remaining) return setError(`Платёж больше остатка: ${money(remaining)} ${debt.currency}.`);
    await callLegacyApi('addDebtPayment', { debt_id: debt.id, date: payment.date || TODAY, amount });
    if (amount >= remaining && !debt.is_closed) {
      await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: true });
    }
    setPayments((current) => ({ ...current, [debt.id]: { date: TODAY, amount: '' } }));
    setOpenPaymentId(null);
    setMessage('Платёж сохранён. Остаток пересчитан.');
    await reload();
  }

  async function deletePayment(payment, debt) {
    await callLegacyApi('delDebtPayment', { id });
    if (debt.is_closed) await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: false });
    setMessage('Платёж удалён.');
    await reload();
  }

  async function reopenDebt(debt) {
    await callLegacyApi('setDebtClosed', { id: debt.id, is_closed: false });
    setMessage('Долг снова открыт.');
    await reload();
  }

  async function deleteDebt(id) {
    await callLegacyApi('delDebt', { id });
    await reload();
  }

  const renderDebt = (debt) => {
    const debtPayments = data.debtPayments
      .filter((payment) => String(payment.debt_id) === String(debt.id))
      .sort(newestFirst);
    const paidAmount = paid(debt.id);
    const remaining = Math.max(0, Number(debt.amount) - paidAmount);
    const progress = Math.min(100, Math.round((paidAmount / Math.max(Number(debt.amount), 1)) * 100));
    const paymentForm = payments[debt.id] || { date: TODAY, amount: '' };
    const previousMonths = [-3, -2, -1].map(shiftDebtMonth);
    const averagePayment = previousMonths.reduce((sum, month) => (
      sum + debtPayments
        .filter((payment) => String(payment.date).startsWith(month))
        .reduce((monthSum, payment) => monthSum + (Number(payment.amount) || 0), 0)
    ), 0) / 3;
    const plan = debtPaymentPlan(debt);
    const monthlyPayment = plan?.monthly || averagePayment;
    const payoffMonths = monthlyPayment > 0 ? Math.ceil(remaining / monthlyPayment) : null;
    const averagePayoffMonths = averagePayment > 0 ? Math.max(1, Math.ceil(remaining / averagePayment)) : null;
    const payoffForecast = debt.is_closed
      ? 'долг погашен'
      : averagePayoffMonths
        ? `ориентировочно закроется в ${futureMonthLabel(averagePayoffMonths)}`
        : 'нет регулярных платежей для прогноза';
    const showHistory = historyIds.includes(debt.id);
    const showPayment = openPaymentId === debt.id;

    return (
      <article className={`debt-card debt-person-card ${debt.is_closed ? 'closed' : ''}`} key={debt.id}>
        <div className="debt-person-heading">
          <div>
            <span className="debt-status">{debt.is_closed ? 'Погашен' : 'Активный долг'}</span>
            <h4>{debt.counterparty}</h4>
            <small>С {displayDate(debt.start_date)}</small>
          </div>
          <div className="debt-person-balance">
            <span>Осталось</span>
            <strong>{debt.currency === 'USD' ? usdMoney(remaining) : `${money(remaining)} сум`}</strong>
            <small className="debt-payoff-forecast">{payoffForecast}</small>
          </div>
        </div>

        <div className="debt-progress-track"><span style={{ width: `${progress}%` }} /></div>
        <div className="debt-progress-meta">
          <span>Погашено {money(paidAmount)} из {money(debt.amount)} {debt.currency}</span>
          <strong>{progress}%</strong>
        </div>

        <div className="debt-person-stats">
          <div><span>{plan ? 'Плановый платёж' : 'Средний платёж'}</span><strong>{money(monthlyPayment)} {debt.currency} / мес.{plan?.months ? ` · ${plan.months} мес.` : ''}</strong></div>
          <div><span>Последний платёж</span><strong>{debtPayments[0] ? `${money(debtPayments[0].amount)} · ${displayDate(debtPayments[0].date)}` : 'Пока нет'}</strong></div>
          <div><span>До погашения</span><strong>{debt.is_closed ? 'Погашен' : payoffMonths ? `≈ ${payoffMonths} мес.` : 'Нужны платежи'}</strong></div>
        </div>

        {showPayment ? (
          <form className="debt-payment-form" onSubmit={(event) => addPayment(event, debt)}>
            <label>Дата<input type="date" value={paymentForm.date || TODAY} onChange={(event) => setPayments({ ...payments, [debt.id]: { ...paymentForm, date: event.target.value } })} /></label>
            <label>Сумма<MoneyInput placeholder="Сумма платежа" value={paymentForm.amount || ''} onChange={(amount) => setPayments({ ...payments, [debt.id]: { ...paymentForm, amount } })} /></label>
            <button className="btn" type="submit">Сохранить платёж</button>
          </form>
        ) : null}

        {showHistory ? (
          <div className="debt-payment-history">
            {debtPayments.length ? debtPayments.map((payment) => (
              <div className="debt-payment-row" key={payment.id}>
                <div><strong>{money(payment.amount)} {debt.currency}</strong><span>Погашение долга</span></div>
                <time>{displayDate(payment.date)}</time>
                <button className="debt-delete-payment" type="button" onClick={() => deletePayment(payment, debt)}>×</button>
              </div>
            )) : <p className="hint">Платежей пока нет.</p>}
          </div>
        ) : null}

        <div className="debt-card-actions">
          {!debt.is_closed ? <button className="btn" type="button" onClick={() => setOpenPaymentId(showPayment ? null : debt.id)}>{showPayment ? 'Отменить' : 'Внести платёж'}</button> : null}
          <button className="btn ghost" type="button" onClick={() => setHistoryIds((current) => showHistory ? current.filter((id) => id !== debt.id) : [...current, debt.id])}>{showHistory ? 'Скрыть историю' : `История (${debtPayments.length})`}</button>
          {debt.is_closed ? <button className="btn ghost" type="button" onClick={() => reopenDebt(debt)}>Открыть снова</button> : null}
          {debt.is_closed && !debtPayments.length ? <button className="btn danger-btn" type="button" onClick={() => deleteDebt(debt.id)}>Удалить</button> : null}
        </div>
      </article>
    );
  };

  return (
    <section className="view-grid debt-dashboard">
      <div className="card wide debt-page-heading">
        <div>
          <p className="debt-eyebrow">Мои обязательства</p>
          <h2>Долги</h2>
          <p>Остаток, история погашений и прогноз на следующий месяц.</p>
        </div>
      </div>

      {message ? <div className="notice success">{message}</div> : null}

      <div className="debt-summary-grid wide">
        <article className="debt-summary-card debt-summary-card--combined">
          <span>Осталось выплатить</span>
          <strong>{money(dashboardByCurrency.UZS.remaining)} сум</strong>
          <b className="debt-summary-usd">{usdMoney(dashboardByCurrency.USD.remaining)}</b>
          <div>
            <p><span>Погашено в этом месяце</span><b>{money(dashboardByCurrency.UZS.paidThisMonth)} сум</b><small>{usdMoney(dashboardByCurrency.USD.paidThisMonth)}</small></p>
            <p><span>Остаток через месяц</span><b>{money(dashboardByCurrency.UZS.forecast)} сум</b><small>{usdMoney(dashboardByCurrency.USD.forecast)}</small></p>
          </div>
          <small>Прогноз по плановым платежам: {money(dashboardByCurrency.UZS.plannedPayment)} сум · {usdMoney(dashboardByCurrency.USD.plannedPayment)}</small>
        </article>
      </div>

      <div className="card wide">
        <div className="debt-section-heading">
          <div><h2>Как уменьшается долг</h2><p>Выберите свечу, чтобы увидеть сумму погашения за выбранный месяц.</p></div>
        </div>
        <div className="debt-charts">
          <article className="debt-chart-card debt-chart-card--combined">
            <div className="debt-chart-heading">
              <div><span>Остаток долгов</span><strong>{money(dashboardByCurrency.UZS.remaining)} сум</strong><b>{usdMoney(dashboardByCurrency.USD.remaining)}</b></div>
              <small>последняя свеча — прогноз</small>
            </div>
            {dashboard.map((item) => {
              const maxValue = Math.max(...item.points.map((point) => point.value), 1);
              return (
                <div className="debt-chart-currency" key={item.currency}>
                  <span>{item.currency === 'UZS' ? 'Сумы' : 'USD'}</span>
                  <div className="debt-mini-bars">
                    {item.points.map((point) => (
                      <button aria-label={`${debtMonthLabel(point.month)}: ${money(point.value)} ${item.currency}`} aria-pressed={selectedDebtMonth === point.month} className={`${point.forecast ? 'forecast ' : ''}${selectedDebtMonth === point.month ? 'selected' : ''}`} key={point.month} onClick={() => setSelectedDebtMonth(point.month)} type="button">
                        <span title={`${money(point.value)} ${item.currency}`} style={{ height: `${Math.max(5, (point.value / maxValue) * 100)}%` }} />
                        <small>{debtMonthLabel(point.month)}</small>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="debt-chart-selection">
              <span>{selectedMonthIsForecast ? `Прогноз на ${debtMonthLabel(selectedDebtMonth)}` : `Погашено за ${debtMonthLabel(selectedDebtMonth)}`}</span>
              <strong>{money(selectedDebtPayments.UZS)} сум</strong>
              <small>{usdMoney(selectedDebtPayments.USD)}</small>
            </div>
          </article>
        </div>
      </div>

      <div className="card wide">
        <div className="debt-section-heading">
          <div><h2>Кому я должен</h2><p>{activeDebts.length} активных · {closedDebts.length} погашенных</p></div>
          <button className={`btn ghost ${showClosed ? 'on' : ''}`} type="button" onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Скрыть погашенные' : 'Показать погашенные'}</button>
        </div>
        <div className="debt-card-list">
          <Rows rows={showClosed ? [...activeDebts, ...closedDebts] : activeDebts} empty="Активных долгов нет." render={renderDebt} />
        </div>
      </div>

      <form className="card wide debt-new-form" onSubmit={addDebt}>
        <div className="debt-section-heading"><div><h2>Добавить новый долг</h2><p>Выплаты будут автоматически уменьшать остаток.</p></div></div>
        <label>Кому я должен<input placeholder="Имя или организация" value={form.counterparty} onChange={(event) => setForm({ ...form, counterparty: event.target.value })} /></label>
        <label>Валюта<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}><option value="UZS">UZS — сум</option><option value="USD">USD — доллар</option></select></label>
        <label>Сумма<MoneyInput placeholder="Сумма долга" value={form.amount} onChange={(amount) => setForm({ ...form, amount })} /></label>
        <label>Дата начала<input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></label>
        <button className="btn" type="submit">Добавить долг</button>
      </form>
    </section>
  );
}

function PeriodPicker({ period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo }) {
  return (
    <>
      <div className="seg">
        {[
          ['day', 'День'],
          ['week', 'Неделя'],
          ['month', 'Месяц'],
          ['all', 'Всё'],
          ['custom', 'Период'],
        ].map(([value, label]) => (
          <button className={period === value ? 'on' : ''} key={value} type="button" onClick={() => setPeriod(value)}>
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' ? (
        <div className="date-row">
          <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} />
          <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} />
        </div>
      ) : null}
    </>
  );
}

function SectionHeading({ label, range }) {
  return (
    <div className="section-heading">
      <h2>{label}</h2>
      <span className="date-badge">{displayRange(range)}</span>
    </div>
  );
}

function Tile({ label, value, secondary, secondaryTone, hint, danger, tone }) {
  return (
    <div className={`tile ${danger ? 'danger' : ''} ${tone ? `tile-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {secondary ? <em className={secondaryTone}>{secondary}</em> : null}
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function Rows({ rows, empty, render }) {
  if (!rows.length) return <p className="hint">{empty}</p>;
  return <div className="rows">{rows.map(render)}</div>;
}

const TELEGRAM_BOT_USERNAME = 'Maestro_uzbot';
const TELEGRAM_BOT_LINK = `https://t.me/${TELEGRAM_BOT_USERNAME}`;
const VIEW_META = {
  overview: {
    title: 'Обзор',
    description: 'Ключевые показатели салона на одном экране.',
  },
  master: {
    title: 'Рабочий день',
    description: 'Смена, продажи и заработок за выбранный период.',
  },
  admin: {
    title: 'Управление салоном',
    description: 'Подтверждения, выручка и работа команды.',
  },
  attendance: {
    title: 'Посещаемость',
    description: 'Приходы мастеров, опоздания и штрафы.',
  },
  calendar: {
    title: 'Календарь записей',
    description: 'Личные и общие записи, статусы клиентов и выходные мастеров.',
  },
  clients: {
    title: 'Клиенты и CRM',
    description: 'Контакты, история посещений, согласия на уведомления и выгрузка в Excel.',
  },
  finance: {
    title: 'Финансы салона',
    description: 'Прибыль, расходы и вложения за выбранный период.',
  },
};

function viewIdsForUser(data) {
  if (data.role === 'admin') {
    const canSeeOverview = ['owner', 'admin'].includes(data.appRole);
    return [
      ...(canSeeOverview ? ['overview'] : []),
      'admin',
      'attendance',
      'finance',
      ...(['owner', 'admin'].includes(data.appRole) ? ['calendar', 'clients'] : []),
      'master',
    ];
  }
  if (data.role === 'master') return ['master', 'calendar'];
  return [];
}

function LoginGate({ error }) {
  return (
    <main className="login-gate">
      <div className="login-card">
        <img src="/icons/icon-192.png" alt="Maestro" />
        <h1>Maestro</h1>
        <p>Откройте приложение через Telegram, чтобы войти в учёт салона.</p>
        <a className="btn login-primary" href={TELEGRAM_BOT_LINK} rel="noreferrer" target="_blank">
          Открыть в Telegram
        </a>
        <button className="btn ghost" type="button" onClick={startTelegramOAuthLogin}>
          Войти на сайте через Telegram
        </button>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </main>
  );
}

function ThemeControls({ theme, setTheme, dark, setDark }) {
  return (
    <div className="themebar">
      <div className="swatches" aria-label="Цветовая тема">
        {Object.entries(THEMES).map(([key, item]) => (
          <button
            aria-label={item.name}
            className={`swatch ${theme === key ? 'on' : ''}`}
            key={key}
            onClick={() => setTheme(key)}
            title={item.name}
            type="button"
          >
            <span style={{ background: item.light.brass }} />
          </button>
        ))}
      </div>

      <button
        aria-label={dark ? 'Включить светлую тему' : 'Включить тёмную тему'}
        className="dark-toggle"
        onClick={() => setDark((current) => !current)}
        title="Светлая / тёмная тема"
        type="button"
      >
        {dark ? '☀' : '☾'}
      </button>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(emptyState);
  const [view, setView] = useState('overview');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isLoadingRef = useRef(false);
  const [error, setError] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('maestroTheme') || 'brass');
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('maestroDark');
    if (saved != null) return saved === 'true';
    return window.Telegram?.WebApp?.colorScheme === 'dark';
  });

  useEffect(() => {
    const selected = THEMES[theme] || THEMES.brass;
    const colors = selected[dark ? 'dark' : 'light'];
    Object.entries(colors).forEach(([key, value]) => document.documentElement.style.setProperty(`--${key}`, value));
    document.documentElement.style.setProperty(
      '--shadow',
      dark
        ? '0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)'
        : '0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.05)',
    );
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('maestroTheme', theme);
    localStorage.setItem('maestroDark', String(dark));
  }, [dark, theme]);

  async function load({ preserveView = true } = {}) {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setError('');
    if (preserveView) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      await captureTelegramOAuthCode();
      captureTelegramRedirectAuth();

      if (needsTelegramLogin()) {
        setLoginRequired(true);
        return;
      }

      const result = await callLegacyApi('load');
      const normalized = normalizeData(result);
      setData(normalized);
      setLoginRequired(false);
      setView((currentView) => {
        const allowed = viewIdsForUser(normalized);
        if (!preserveView) return allowed.includes('overview') ? 'overview' : normalized.role === 'admin' ? 'admin' : 'master';
        return allowed.includes(currentView) ? currentView : allowed[0];
      });
    } catch (loadError) {
      setError(loadError.message || 'Не удалось загрузить данные.');
      if (String(loadError.message).includes('unauthorized')) setLoginRequired(true);
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    load({ preserveView: false });
  }, []);

  useEffect(() => {
    if (loginRequired) return undefined;

    let intervalId;

    const refresh = () => {
      if (!document.hidden && !isLoadingRef.current) {
        load({ preserveView: true });
      }
    };

    const startInterval = () => {
      clearInterval(intervalId);
      intervalId = window.setInterval(refresh, 15000);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearInterval(intervalId);
        intervalId = undefined;
        return;
      }

      refresh();
      startInterval();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!document.hidden) startInterval();

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loginRequired]);

  const availableViews = useMemo(() => {
    return viewIdsForUser(data);
  }, [data.appRole, data.role]);
  const pendingSalesCount = getPendingSales(data.sales).length;

  if (loginRequired) return <LoginGate error={error} />;
  if (isLoading) {
    return (
      <main className="loading-splash" role="status" aria-label="Загрузка">
        <div className="loading-emblem" aria-hidden="true">
          <span className="loading-emblem-ring loading-emblem-ring-outer" />
          <span className="loading-emblem-ring loading-emblem-ring-inner" />
          <span className="loading-emblem-core">M</span>
        </div>
      </main>
    );
  }

  const CurrentView = {
    overview: OverviewView,
    master: MasterView,
    admin: AdminView,
    attendance: AttendanceView,
    calendar: CalendarView,
    clients: ClientsView,
    finance: FinanceView,
    debts: DebtsView,
  }[view] || MasterView;

  return (
    <main className="app">
      <div className="pole" />
      <header>
        <div className="topbar">
          <div className="brand">
            <div className="mark">M</div>
            <div>
              <h1>Maestro Barberia</h1>
              <p>{data.role === 'master' && data.me ? `${data.me} · ${data.byName[data.me]?.pct || 40}%` : getTelegramFirstName() ? `привет, ${getTelegramFirstName()}` : 'учёт салона'}</p>
            </div>
          </div>
        </div>
        <ThemeControls theme={theme} setTheme={setTheme} dark={dark} setDark={setDark} />
      </header>

      {availableViews.length ? (
        <nav className="seg nav">
          {(data.role === 'master' ? [
            ['master', 'Мастер'],
            ['calendar', 'Календарь'],
          ] : [
            ['overview', 'Обзор'],
            ['admin', 'Админ'],
            ['attendance', 'Посещаемость'],
            ['finance', 'Финансы'],
            ['calendar', 'Календарь'],
            ['clients', 'Клиенты'],
            ['debts', 'Долги'],
            ['master', 'Мастер'],
          ]).filter(([id]) => availableViews.includes(id)).map(([id, label]) => (
            <button className={`${view === id ? 'on ' : ''}${id === 'admin' && pendingSalesCount ? 'has-nav-badge' : ''}`} key={id} type="button" onClick={() => setView(id)}>
              {label}
              {id === 'admin' && pendingSalesCount ? (
                <span className="nav-badge" aria-label={`${pendingSalesCount} продаж ожидают подтверждения`}>
                  {pendingSalesCount > 99 ? '99+' : pendingSalesCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}

      {error && !loginRequired ? <div className="notice error">{error}</div> : null}
      {isRefreshing ? (
        <div className="loading-strip" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />Синхронизация данных...
        </div>
      ) : null}
      {VIEW_META[view] ? (
        <section className="view-intro" aria-labelledby="view-title">
          <p className="view-eyebrow">Maestro Barberia</p>
          <h2 id="view-title">{VIEW_META[view].title}</h2>
          <p>{VIEW_META[view].description}</p>
        </section>
      ) : null}
      <CurrentView data={data} reload={load} setError={setError} />

      <footer>Данные сохраняются в облаке (Supabase). <span>{APP_VERSION}</span></footer>
    </main>
  );
}
