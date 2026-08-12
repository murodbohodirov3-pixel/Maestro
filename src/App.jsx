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
  commissionPctForSale,
  grossMasterPayForSales,
  investmentSummary,
  masterGrossPay,
  masterNetPay,
  operatingExpenses,
  rentOffsetIncome,
  saleClientsCount,
  saleTotal,
  totalCard,
  totalCash,
  totalExpenses,
  totalFines,
  totalQr,
  totalSalesAmount,
} from './utils/calculations.js';
import { downloadClientWorkbook } from './utils/clientExport.js';
import {
  appointmentOutcomeSummary,
  belongsToMaster,
  comparablePreviousRange,
  inRange,
  latenessSummary,
  masterPayoutForPeriod,
  mastersForPeriod,
  minutesLate,
  overviewWeeklyMetrics,
  paymentMix,
  percentageDifference,
  previousRange,
  recognizedFinesTotal,
  shiftDate,
  shiftProductivity,
  weekdayBreakdown,
} from './utils/reporting.js';
import {
  localDate,
  mergeWindowedData,
  pollWindowStart,
  rowDate,
} from './utils/loadWindow.js';
import { pluralRu } from './utils/plural.js';
import { sameWeekdayLastWeek } from './utils/periods.js';
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


function money(value) {
  return Math.round(Number(value) || 0).toLocaleString('ru-RU');
}

function usdMoney(value) {
  return `$${money(value)}`;
}

function usdMoneyPrecise(value) {
  return `$${(Number(value) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`;
}

function futureMonthLabel(monthsAhead) {
  const [year, month] = TODAY.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1 + monthsAhead, 1));
}

function averageCheck(revenue, clientCount) {
  return clientCount > 0 ? money(revenue / clientCount) : '—';
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

// Server codes are the contract; these are the sentences the owner reads. An
// unmapped code still surfaces verbatim, because a strange message beats a
// screen that shows nothing at all.
const ACTION_ERROR_TEXT = {
  forbidden: 'Недостаточно прав для этого действия.',
  invalid_sale: 'Проверьте сумму, дату и количество клиентов.',
  sale_date_out_of_range: 'Продажу можно записать только за последнюю неделю.',
  sale_amount_too_large: 'Сумма слишком большая — похоже, лишний ноль.',
  master_not_active: 'Мастер не активен — включите его в списке мастеров.',
  sale_not_found: 'Продажа уже удалена.',
  sale_delete_window_expired: 'Продажу старше двух дней удалить нельзя.',
  sale_does_not_require_owner_approval: 'Эту продажу уже обработали — обновите экран.',
  fine_not_found: 'Штраф уже удалён.',
  fine_delete_window_expired: 'Штраф старше семи дней удалить нельзя.',
  invalid_attendance: 'Не удалось отметить приход — проверьте дату и время.',
  attendance_edit_window_expired: 'Изменить отметку можно только за сегодня.',
  invalid_expense: 'Проверьте дату и сумму расхода.',
  invalid_rent_offset: 'Проверьте сумму в долларах и курс.',
  no_settings_to_update: 'Нечего сохранять — ничего не изменилось.',
  slot_already_booked: 'Это время уже занято.',
  master_day_off: 'У мастера в этот день выходной.',
  client_blocked: 'Этот клиент заблокирован.',
  not_in_list: 'Ваш доступ отключён. Обратитесь к владельцу.',
};

function actionErrorText(error) {
  const code = String(error?.details?.error || error?.message || '');
  if (ACTION_ERROR_TEXT[code]) return ACTION_ERROR_TEXT[code];
  if (code.startsWith('unauthorized')) return 'Сессия истекла. Откройте приложение через Telegram заново.';
  if (/Failed to fetch|NetworkError|network/i.test(code)) {
    return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  }
  return code ? `Не удалось выполнить: ${code}` : 'Не удалось выполнить действие.';
}

// Every mutation used to fire and forget. A failure became an unhandled
// rejection, the screen said nothing, and the natural next move was to tap
// again — which is where the duplicate sales came from. One action at a time,
// and the result is always stated.
function useAction(setError, setMessage) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function run(work, successMessage) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage?.('');
    try {
      await work();
      if (successMessage) setMessage?.(successMessage);
      return true;
    } catch (error) {
      setError(actionErrorText(error));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return { run, busy };
}

// The fines table has always had a reason column and nothing ever wrote to it,
// so "за что этот штраф" was settled from memory.
const FINE_REASONS = [
  { value: 'late', label: 'Опоздание' },
  { value: 'absence', label: 'Прогул' },
  { value: 'damage', label: 'Порча имущества' },
  { value: 'service', label: 'Качество обслуживания' },
  { value: 'other', label: 'Другое' },
];

const FINE_REASON_LABELS = Object.fromEntries(FINE_REASONS.map((item) => [item.value, item.label]));

function fineReasonLabel(reason) {
  if (!reason) return 'причина не указана';
  return FINE_REASON_LABELS[reason] || reason;
}

function newRequestId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The period lived in each view's own state, so stepping from Продажи to
// Расходы to check one figure silently threw the chosen month away. One shared,
// remembered selection instead.
const PERIOD_KEYS = { period: 'maestroPeriod', from: 'maestroPeriodFrom', to: 'maestroPeriodTo' };

function usePeriodSelection(defaultPeriod = 'day') {
  const [period, setPeriod] = useState(() => localStorage.getItem(PERIOD_KEYS.period) || defaultPeriod);
  const [customFrom, setCustomFrom] = useState(() => localStorage.getItem(PERIOD_KEYS.from) || '');
  const [customTo, setCustomTo] = useState(() => localStorage.getItem(PERIOD_KEYS.to) || '');

  useEffect(() => {
    localStorage.setItem(PERIOD_KEYS.period, period);
    localStorage.setItem(PERIOD_KEYS.from, customFrom);
    localStorage.setItem(PERIOD_KEYS.to, customTo);
  }, [period, customFrom, customTo]);

  return { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo };
}

// Telegram's own dialog: window.confirm is suppressed in some Mini App clients,
// and a destructive action that silently does nothing is worse than no guard.
function confirmAction(question) {
  const telegram = window.Telegram?.WebApp;
  if (typeof telegram?.showConfirm === 'function') {
    return new Promise((resolve) => {
      try {
        telegram.showConfirm(question, (ok) => resolve(Boolean(ok)));
      } catch {
        resolve(window.confirm(question));
      }
    });
  }
  return Promise.resolve(window.confirm(question));
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

// A percentage alone cannot be acted on: "+12%" hides whether the salon gained
// two million or twenty thousand. The figure it grew from is shown next to it,
// and the dates it came from drop to the quiet line underneath.
function comparisonToPrevious(current, previous, comparisonRange, formatValue = money) {
  const percent = percentageDifference(current, previous);
  return {
    secondary: `${percent > 0 ? '+' : ''}${percent}% · было ${formatValue(previous)}`,
    secondaryTone: percent > 0 ? 'positive' : percent < 0 ? 'negative' : '',
    hint: displayRange(comparisonRange),
  };
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

function PaymentBreakdownBar({ cash, card, qr, previous }) {
  const [isReady, setIsReady] = useState(false);
  const values = [Number(cash) || 0, Number(card) || 0, Number(qr) || 0];
  const total = values.reduce((sum, value) => sum + value, 0);
  const previousShares = previous?.total
    ? { cash: previous.cashShare, card: previous.cardShare, qr: previous.qrShare }
    : null;
  const items = [
    { key: 'cash', label: 'Наличные', value: values[0] },
    { key: 'card', label: 'Карта', value: values[1] },
    { key: 'qr', label: 'QR Paynet', value: values[2] },
  ].map((item) => ({
    ...item,
    percent: total ? (item.value / total) * 100 : 0,
    previousPercent: previousShares ? previousShares[item.key] : null,
  }));

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
          <span key={item.key}>
            <i className={`payment-breakdown-dot payment-breakdown-${item.key}`} />
            {item.label} <strong>{Math.round(item.percent)}%</strong>
            {item.previousPercent != null ? (
              <em className="payment-breakdown-previous">было {Math.round(item.previousPercent)}%</em>
            ) : null}
          </span>
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

function OverviewMetricTile({ detailId, label, value, tone, danger, expanded, hint, onToggle }) {
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
      {hint ? <em className="tile-hint">{hint}</em> : null}
      <i className="overview-metric-chevron" aria-hidden="true" />
    </button>
  );
}

// Which days deserve five masters and which deserve three. Averaged per
// occurrence of the weekday, so a month with five Saturdays does not outrank
// one with four.
function WeekdayBreakdown({ rows }) {
  const peak = Math.max(1, ...rows.map((row) => row.averageRevenue));
  const busiest = rows.reduce((best, row) => (row.averageRevenue > (best?.averageRevenue || 0) ? row : best), null);

  return (
    <div className="weekday-breakdown">
      {rows.map((row) => (
        <div className={`weekday-row ${row.index === busiest?.index && row.occurrences ? 'is-peak' : ''}`} key={row.index}>
          <span className="weekday-name">{row.short}</span>
          <span className="weekday-track">
            <i style={{ width: `${(row.averageRevenue / peak) * 100}%` }} />
          </span>
          <span className="weekday-value">
            <strong>{row.occurrences ? `${money(row.averageRevenue)}` : '—'}</strong>
            <em>
              {row.occurrences
                ? `${row.averageClients.toFixed(1).replace('.', ',')} клиента · ${row.occurrences} ${pluralRu(row.occurrences, 'день', 'дня', 'дней')}`
                : 'нет данных'}
            </em>
          </span>
        </div>
      ))}
      <p className="hint">Средняя выручка за один такой день недели в выбранном месяце.</p>
    </div>
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

function OverviewView({ data, setView }) {
  const [expandedDetail, setExpandedDetail] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const monthRange = currentMonthRange();
  // Trimmed to the days that have already happened. Comparing three days of a
  // new month against a whole previous month reported a collapse every time the
  // month turned over.
  const priorMonthRange = comparablePreviousRange(monthRange, 'month', TODAY);
  // Not yesterday: a Thursday is compared with the previous Thursday, because a
  // barbershop's week has a shape and a Wednesday is a different kind of day.
  const lastWeekSameDay = sameWeekdayLastWeek(TODAY);

  const countedSales = data.sales.filter(isCountedSale);
  const inMonth = (row, key = 'd', range = monthRange) => inRange(rowDate(row, key), range.from, range.to);

  const todaySales = countedSales.filter((sale) => rowDate(sale) === TODAY);
  const lastWeekSales = countedSales.filter((sale) => rowDate(sale) === lastWeekSameDay);
  const monthSales = countedSales.filter((sale) => inMonth(sale));
  const monthFines = data.fines.filter((fine) => inMonth(fine));
  const priorSales = priorMonthRange ? countedSales.filter((sale) => inMonth(sale, 'd', priorMonthRange)) : [];
  const priorFines = priorMonthRange ? data.fines.filter((fine) => inMonth(fine, 'd', priorMonthRange)) : [];

  const expensesFor = (range) => data.expenses.filter((expense) => inMonth(expense, 'date', range));
  const operatingFor = (range) => totalExpenses(operatingExpenses(expensesFor(range)));
  const rentOffsetsFor = (range) => rentOffsetIncome(expensesFor(range));

  const todayRevenue = totalSalesAmount(todaySales);
  const monthRevenue = totalSalesAmount(monthSales);
  const payouts = masterPayoutForPeriod(data.masters, monthSales, monthFines);
  const salonRemainder = monthRevenue - payouts;
  const fineTotal = totalFines(monthFines);
  // Issued and withheld differ whenever a fine outruns what a master earned;
  // only the withheld part ever reaches the salon.
  const recognizedFines = recognizedFinesTotal(data.masters, monthSales, monthFines);
  const netProfit = salonRemainder - operatingFor(monthRange);
  const nonCashIncome = rentOffsetsFor(monthRange);
  const totalNetProfit = netProfit + nonCashIncome;

  const priorRevenue = totalSalesAmount(priorSales);
  const priorNetProfit = priorMonthRange
    ? priorRevenue - masterPayoutForPeriod(data.masters, priorSales, priorFines) - operatingFor(priorMonthRange)
    : 0;

  // Average check is the number that moves before revenue does: the same takings
  // spread over more clients means each one is paying less.
  const monthClients = monthSales.reduce((sum, sale) => sum + clients(sale), 0);
  const priorClients = priorSales.reduce((sum, sale) => sum + clients(sale), 0);
  const monthCheck = monthClients ? monthRevenue / monthClients : 0;
  const priorCheck = priorClients ? priorRevenue / priorClients : 0;

  const pendingSales = getPendingSales(data.sales);
  const weekdayRows = weekdayBreakdown(monthSales);
  const weeklyMetrics = overviewWeeklyMetrics(data, monthRange, monthSales, monthFines);
  const visibleWeeklyMetrics = weeklyMetrics.filter((week) => (
    week.from <= TODAY || week.revenue || week.grossMasterPay || week.recognizedFines || week.expenses || week.nonCashIncome
  ));
  const fineRanking = overviewFineRanking(data, monthFines);

  const versusPriorMonth = (current, previous) => (
    priorMonthRange ? comparisonToPrevious(current, previous, priorMonthRange) : {}
  );
  const profitVersusPriorMonth = versusPriorMonth(netProfit, priorNetProfit);

  return (
    <section className="view-grid">
      {/* An approval queue is work waiting, not a statistic. It reads as a task
          and it leaves entirely when there is nothing to approve — an empty
          screen is the message that everything is settled. */}
      {pendingSales.length ? (
        <button className="card wide overview-pending" type="button" onClick={() => setView('admin')}>
          <span className="overview-pending-text">
            <strong>{pendingSales.length}</strong>
            {' '}
            {pluralRu(pendingSales.length, 'продажа ждёт', 'продажи ждут', 'продаж ждут')} подтверждения
          </span>
          <span className="overview-pending-cta">Открыть</span>
        </button>
      ) : null}

      <div className="card wide overview-card">
        {/* One figure carries the screen: the answer to the question the owner
            opened the app for. Everything else is context for it. */}
        <div className={`overview-hero ${netProfit < 0 ? 'is-negative' : ''}`}>
          <span className="overview-hero-label">Денежная чистая прибыль · {futureMonthLabel(0)}</span>
          <strong className="overview-hero-value">
            {money(netProfit)}
            <small> сум</small>
          </strong>
          {profitVersusPriorMonth.secondary ? (
            <em className={`overview-hero-delta ${profitVersusPriorMonth.secondaryTone}`}>
              {profitVersusPriorMonth.secondary}
            </em>
          ) : null}
        </div>

        <div className="tiles overview-tiles overview-tiles-supporting">
          <Tile
            label="Выручка сегодня"
            value={`${money(todayRevenue)} сум`}
            tone="total"
            {...comparisonToPrevious(
              todayRevenue,
              totalSalesAmount(lastWeekSales),
              { from: lastWeekSameDay, to: lastWeekSameDay },
            )}
          />
          <Tile
            label="Выручка за месяц"
            value={`${money(monthRevenue)} сум`}
            {...versusPriorMonth(monthRevenue, priorRevenue)}
          />
          <Tile
            label="Средний чек"
            value={averageCheck(monthRevenue, monthClients)}
            {...versusPriorMonth(monthCheck, priorCheck)}
          />
          <Tile
            label="Клиентов за месяц"
            value={monthClients}
            {...versusPriorMonth(monthClients, priorClients)}
          />
        </div>

        {/* The month's breakdowns are unchanged, just one tap down: they answer
            questions the owner asks occasionally, not on every open. */}
        <button
          aria-expanded={detailsOpen}
          className="overview-more"
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? 'Свернуть подробности' : 'Подробнее: остаток салону, взаимозачёты, по неделям'}
        </button>

        {detailsOpen ? (
          <div className="tiles overview-tiles">
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
              // Issued and withheld part company as soon as a fine outruns what
              // the master earned, and only the withheld part reaches the salon.
              hint={recognizedFines < fineTotal ? `удержано ${money(recognizedFines)}` : null}
              onToggle={setExpandedDetail}
            />
            {expandedDetail === 'fines' ? <OverviewFineDetails rows={fineRanking} /> : null}
            <OverviewMetricTile
              danger={netProfit < 0}
              detailId="cash-profit"
              expanded={expandedDetail === 'cash-profit'}
              label="Денежная чистая прибыль"
              tone="total"
              value={`${money(netProfit)} сум`}
              onToggle={setExpandedDetail}
            />
            {expandedDetail === 'cash-profit' ? (
              <OverviewWeeklyDetails detailId="cash-profit" title="Денежная чистая прибыль" rows={visibleWeeklyMetrics} valueKey="netProfit" />
            ) : null}
            <OverviewMetricTile
              detailId="rent-offsets"
              expanded={expandedDetail === 'rent-offsets'}
              label="Безденежный доход"
              value={`${money(nonCashIncome)} сум`}
              onToggle={setExpandedDetail}
            />
            {expandedDetail === 'rent-offsets' ? (
              <OverviewWeeklyDetails detailId="rent-offsets" title="Взаимозачёты аренды" rows={visibleWeeklyMetrics} valueKey="nonCashIncome" />
            ) : null}
            <OverviewMetricTile
              danger={totalNetProfit < 0}
              detailId="total-profit"
              expanded={expandedDetail === 'total-profit'}
              label="Общий результат"
              tone="total"
              value={`${money(totalNetProfit)} сум`}
              onToggle={setExpandedDetail}
            />
            {expandedDetail === 'total-profit' ? (
              <OverviewWeeklyDetails detailId="total-profit" title="Общий результат с взаимозачётами" rows={visibleWeeklyMetrics} valueKey="totalNetProfit" />
            ) : null}
            <OverviewMetricTile
              detailId="weekdays"
              expanded={expandedDetail === 'weekdays'}
              label="Сильные дни недели"
              value={weekdayRows.some((row) => row.occurrences)
                ? weekdayRows.reduce((best, row) => (row.averageRevenue > (best?.averageRevenue || 0) ? row : best), null).name
                : '—'}
              onToggle={setExpandedDetail}
            />
            {expandedDetail === 'weekdays' ? (
              <div className="overview-details" id="overview-details-weekdays" role="region" aria-label="Выручка по дням недели">
                <div className="overview-details-heading">
                  <strong>Выручка по дням недели</strong>
                  <span>в среднем за день</span>
                </div>
                <WeekdayBreakdown rows={weekdayRows} />
              </div>
            ) : null}
          </div>
        ) : null}
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
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection();
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const { run, busy } = useAction(setError, setMessage);

  const canPickMaster = data.role === 'admin';
  const masterName = data.role === 'master' ? data.me : selectedMaster;
  const masterProfile = data.byName[masterName];
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
  const pay = masterNetPay(grossMasterPayForSales(visibleSales, masterProfile), fineTotal);
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
      // Held across retries of this same sale, so a reply lost on a bad
      // connection cannot turn one haircut into two rows.
      client_request_id: requestId,
    };

    const ok = await run(
      () => callLegacyApi('addSale', payload).then(reload),
      data.role === 'master' ? 'Оплата отправлена owner на подтверждение.' : 'Продажа сохранена.',
    );
    if (!ok) return;

    setRequestId(newRequestId());
    setPayType(null);
    setAmount('');
    setClientCount(1);
    setIsNewClient(null);
  }

  async function deleteSale(id) {
    if (!await confirmAction('Удалить эту продажу?')) return;
    await run(() => callLegacyApi('delSale', { id }).then(reload), 'Продажа удалена.');
  }

  async function markArrival() {
    setError('');
    setMessage('');

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

    // The server stamps the actual Tashkent time; sending it here would let a
    // phone clock decide whether an arrival counts as late.
    await run(
      () => callLegacyApi('setAttendance', { master: masterName, d: TODAY }).then(reload),
      'Приход отмечен.',
    );
  }

  async function resetArrival() {
    if (!await confirmAction('Убрать отметку о приходе за сегодня?')) return;
    await run(
      () => callLegacyApi('delAttendance', { master: masterName, d: TODAY }).then(reload),
      'Отметка убрана.',
    );
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
            <button className="btn ghost" type="button" onClick={resetArrival} disabled={busy}>Изменить</button>
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={markArrival} disabled={busy || !masterName}>Я пришёл</button>
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
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Добавить'}
        </button>
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
          {/* The rate is already in the header next to the master's name, and it
              does not change from one period to the next. A tile for it took the
              space of a figure that moves. */}
          <Tile label="Выручка" value={money(revenue)} />
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
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection();
  const [message, setMessage] = useState('');
  const [masterSort, setMasterSort] = useState({ key: 'revenue', direction: 'desc' });
  const [detailLimit, setDetailLimit] = useState(50);
  const { run, busy } = useAction(setError, setMessage);
  const range = getRange(period, customFrom, customTo, data.sales);
  // Trimmed to the elapsed part of the period, so the first days of a month are
  // not compared against a whole one.
  const priorRange = comparablePreviousRange(range, period, TODAY);
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
  const reportMasters = mastersForPeriod(
    data.masters,
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
      pay: masterNetPay(grossMasterPayForSales(rows, master), masterFine),
      previousRevenue,
      previousPay: masterNetPay(grossMasterPayForSales(previousRows, master), previousFine),
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
  const previousRevenue = totalSalesAmount(previousSales);
  const previousNewClients = previousSales.filter((sale) => sale.is_new_client === true).reduce((sum, sale) => sum + clients(sale), 0);
  const previousClients = previousSales.reduce((sum, sale) => sum + clients(sale), 0);
  const comparison = (current, previous) => priorRange ? comparisonToPrevious(current, previous, priorRange) : {};
  const pendingTotal = pendingSales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  // The share of cash is an operational number, not trivia: it drives what has
  // to be collected and banked. A share without its previous value is a fact
  // with nothing to compare against.
  const mix = paymentMix(sales);
  const previousMix = paymentMix(previousSales);
  const periodAttendance = data.attendance.filter((row) => inRange(rowDate(row), range.from, range.to));
  const productivityByMaster = Object.fromEntries(
    shiftProductivity(data.masters, sales, periodAttendance, fines).map((row) => [String(row.id), row]),
  );

  async function setSaleApproval(id, status) {
    await run(
      () => callLegacyApi('setSaleApproval', { id, status }).then(reload),
      status === 'approved' ? 'Оплата подтверждена.' : 'Оплата отклонена.',
    );
  }

  // Monday morning used to be one tap and one full reload per sale. The queue
  // is confirmed in one pass and the data is fetched once at the end.
  async function approveAllPending() {
    const queue = [...pendingSales];
    if (!queue.length) return;
    if (!await confirmAction(`Подтвердить все оплаты (${queue.length}) на ${money(pendingTotal)} сум?`)) return;

    await run(async () => {
      const failures = [];
      for (const sale of queue) {
        try {
          await callLegacyApi('setSaleApproval', { id: sale.id, status: 'approved' });
        } catch (error) {
          failures.push(actionErrorText(error));
        }
      }
      await reload();
      // Thrown after the reload so the rows that did go through are already on
      // screen when the message explains the ones that did not.
      if (failures.length) throw new Error(`Не удалось подтвердить ${failures.length} из ${queue.length}: ${failures[0]}`);
    }, `Подтверждено оплат: ${queue.length}.`);
  }

  async function deleteDetailedSale(sale) {
    if (!recentSaleCanBeDeleted(rowDate(sale))) return setError('Можно удалять только продажи не старше 2 дней.');
    if (!await confirmAction(`Удалить продажу ${sale.master} на ${money(saleTotal(sale))} сум?`)) return;
    await run(() => callLegacyApi('delSale', { id: sale.id }).then(reload), 'Продажа удалена.');
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
        {pendingSales.length > 1 ? (
          <div className="approve-all">
            <span>
              {pendingSales.length} {pluralRu(pendingSales.length, 'оплата', 'оплаты', 'оплат')} на {money(pendingTotal)} сум
            </span>
            <button className="btn" type="button" onClick={approveAllPending} disabled={busy}>
              {busy ? 'Подтверждаем…' : 'Подтвердить все'}
            </button>
          </div>
        ) : null}
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
                <button className="btn approval-button" type="button" disabled={busy} onClick={() => setSaleApproval(sale.id, 'approved')}>
                  Подтвердить
                </button>
                <button className="btn ghost approval-button" type="button" disabled={busy} onClick={() => setSaleApproval(sale.id, 'rejected')}>
                  Отклонить
                </button>
              </div>
            </div>
          )}
        />
        {message ? <p className="success">{message}</p> : null}
      </div>

      <div className="card wide">
        <SectionHeading label="Период отчёта" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="tiles">
          {/* "Выручка" everywhere, never "Итого": one word per concept, or the
              owner cannot tell whether two screens mean the same number.
              The salon remainder lives on Финансы, at its place in the chain
              revenue → payouts → remainder → expenses → profit. Repeating it
              here only invited the question of whether the two agree.
              "Постоянные" was "Клиентов" minus "Новые" — a tile for a
              subtraction the eye does anyway. */}
          <Tile label="Выручка" value={money(revenue)} {...comparison(revenue, previousRevenue)} tone="total" />
          <Tile label="Клиентов" value={totalClients} {...comparison(totalClients, previousClients)} />
          <Tile label="Новые" value={newClients} {...comparison(newClients, previousNewClients)} />
          <Tile label="Средний чек" value={averageCheck(revenue, totalClients)} />
        </div>
        <PaymentBreakdownBar cash={mix.cash} card={mix.card} qr={mix.qr} previous={previousMix} />
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
                    {/* Revenue alone cannot tell working more from earning
                        more. The shift count is what separates them. */}
                    <small className="master-shift-line">
                      {productivityByMaster[String(master.id)]?.shifts
                        ? `${productivityByMaster[String(master.id)].shifts} ${pluralRu(productivityByMaster[String(master.id)].shifts, 'смена', 'смены', 'смен')} · ${money(productivityByMaster[String(master.id)].revenuePerShift)} за смену`
                        : 'нет отметок о приходе'}
                    </small>
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
          // Over a long period this list is thousands of rows, and rendering
          // them all locks the phone for seconds before anything appears.
          rows={[...sales].sort((left, right) => (
            String(right.created_at || rowDate(right)).localeCompare(String(left.created_at || rowDate(left)))
          )).slice(0, detailLimit)}
          empty="За выбранный период продаж нет."
          render={(sale) => {
            const master = data.byName[sale.master];
            const amount = saleTotal(sale);
            const masterEarning = masterGrossPay(amount, commissionPctForSale(sale, master));
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
        {sales.length > detailLimit ? (
          <button className="btn ghost" type="button" onClick={() => setDetailLimit((limit) => limit + 100)}>
            Показать ещё · осталось {sales.length - detailLimit}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function AttendanceView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection();
  const [fineForm, setFineForm] = useState({
    master: data.activeMasters[0]?.name || '',
    d: TODAY,
    amount: '',
    reason: FINE_REASONS[0].value,
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
  const { run, busy } = useAction(setError, setMessage);
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
  // Per-day rows answer "who is here today"; this answers "who is habitually
  // late and what has it cost", which no screen could show before.
  const lateness = latenessSummary(data.masters, filteredAttendance, filteredFines, shiftStart)
    .filter((row) => row.shifts || row.fines);

  async function saveSettings(event) {
    event.preventDefault();
    await run(() => callLegacyApi('setSettings', {
      shift_start: settings.shift_start,
      salon_lat: settings.salon_lat === '' ? null : Number(settings.salon_lat),
      salon_lng: settings.salon_lng === '' ? null : Number(settings.salon_lng),
      salon_radius: Number(settings.salon_radius) || 100,
    }).then(reload), 'Настройки сохранены.');
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
    if (!arrived && !await confirmAction(`Убрать отметку о приходе: ${master}, ${displayDate(date)}?`)) return;
    await run(
      () => (arrived
        ? callLegacyApi('setAttendance', { master, d: date, arrived })
        : callLegacyApi('delAttendance', { master, d: date })
      ).then(reload),
      arrived ? 'Приход сохранён.' : 'Отметка убрана.',
    );
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

  async function createFine(master, date, amount, reason) {
    return run(
      () => callLegacyApi('addFine', { master, d: date || TODAY, amount, reason: reason || null }).then(reload),
      `Штраф ${money(amount)} сум выставлен: ${master}.`,
    );
  }

  async function addFine(event) {
    event.preventDefault();
    const amount = Number(fineForm.amount);
    if (!amount || amount <= 0) return setError('Введите сумму штрафа.');
    if (!fineForm.reason) return setError('Выберите причину штрафа.');
    const ok = await createFine(fineForm.master, fineForm.d, amount, fineForm.reason);
    if (ok) setFineForm((current) => ({ ...current, amount: '' }));
  }

  async function addLateFine(item) {
    const key = `${item.master}-${rowDate(item)}`;
    setSavingFineKey(key);
    try {
      await createFine(item.master, rowDate(item), 50000, 'late');
    } finally {
      setSavingFineKey('');
    }
  }

  async function deleteFine(fine) {
    if (!recentFineCanBeDeleted(rowDate(fine))) {
      setError('Можно удалять только штрафы не старше 7 дней.');
      return;
    }
    if (!await confirmAction(`Удалить штраф ${fine.master} на ${money(fine.amount)} сум?`)) return;
    await run(() => callLegacyApi('delFine', { id: fine.id }).then(reload), 'Штраф удалён.');
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
        {period !== 'day' && lateness.length ? (
          <details className="lateness-summary">
            <summary>
              Сводка по опозданиям
              <span>{lateness.filter((row) => row.lateDays).length} из {lateness.length} опаздывали</span>
            </summary>
            <div className="table-scroll">
              <table className="master-table">
                <thead>
                  <tr>
                    <th>Мастер</th>
                    <th>Смен</th>
                    <th>Опозданий</th>
                    <th>Всего минут</th>
                    <th>В среднем</th>
                    <th>Штрафы</th>
                  </tr>
                </thead>
                <tbody>
                  {lateness.map((row) => (
                    <tr key={row.id ?? row.name}>
                      <td>{row.name}</td>
                      <td>{row.shifts}</td>
                      <td className={row.lateDays ? 'is-late' : ''}>{row.lateDays}</td>
                      <td>{row.totalLateMinutes}</td>
                      <td>{row.averageLateMinutes ? `${row.averageLateMinutes} мин` : '—'}</td>
                      <td>{row.fines ? `−${money(row.fines)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">Смена засчитывается по отметке о приходе. Опоздание считается от начала смены {shiftStart}.</p>
          </details>
        ) : null}
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
        <select value={fineForm.reason} onChange={(event) => setFineForm({ ...fineForm, reason: event.target.value })}>
          {FINE_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
        </select>
        <MoneyInput placeholder="например, 50 000" value={fineForm.amount} onChange={(amount) => setFineForm({ ...fineForm, amount })} />
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Добавить штраф'}</button>
        <Rows rows={filteredFines} empty="Штрафов за период нет." render={(fine) => {
          const canDelete = recentFineCanBeDeleted(rowDate(fine));
          return (
            <div className="row fine-row" key={fine.id}>
              <div>
                <strong>{fine.master}</strong>
                <span>{displayDate(rowDate(fine))} · −{money(fine.amount)} сум</span>
                <span>{fineReasonLabel(fine.reason)}</span>
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
  const { run } = useAction(setError, setMessage);
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

  // A rolling month rather than the viewed day: a no-show rate computed from a
  // single day is noise, and the owner reads this to decide about prepayment.
  const outcomeRange = { from: shiftDate(TODAY, -29), to: TODAY };
  const outcomes = appointmentOutcomeSummary(
    data.appointments.filter((appointment) => {
      const day = tashkentDate(appointment.starts_at);
      return visibleIds.has(String(appointment.master_id)) && inRange(day, outcomeRange.from, outcomeRange.to);
    }),
  );

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
    await run(
      () => callLegacyApi('setAppointmentStatus', { id: appointment.id, status }).then(reload),
      `Статус изменён: ${APPOINTMENT_STATUS_LABELS[status]}.`,
    );
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

      {/* Empty chair time and what it cost. Every field here was already being
          written; none of it was ever added up. */}
      {canManage && outcomes.resolved ? (
        <div className="card wide">
          <SectionHeading label="Неявки и отмены за 30 дней" range={outcomeRange} />
          <div className="tiles">
            <Tile label="Записей завершено" value={outcomes.completed} />
            <Tile
              label="Неявки"
              value={`${outcomes.noShow} · ${outcomes.noShowRate.toFixed(0)}%`}
              danger={outcomes.noShowRate >= 10}
            />
            <Tile
              label="Отмены"
              value={`${outcomes.cancelled} · ${outcomes.cancelledRate.toFixed(0)}%`}
              hint={outcomes.cancelled ? `клиентом ${outcomes.cancelledByClient} · салоном ${outcomes.cancelledBySalon}` : null}
            />
            <Tile label="Упущено" value={`${money(outcomes.lostAmount)} сум`} danger={outcomes.lostAmount > 0} tone="total" />
          </div>
          <p className="hint">
            Считаются только состоявшиеся исходы: {outcomes.upcoming} предстоящих {pluralRu(outcomes.upcoming, 'запись', 'записи', 'записей')} в проценты не входят.
          </p>
        </div>
      ) : null}

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
                    {/* Written by the booking form since day one and never
                        rendered, so every note the owner typed was lost. */}
                    {appointment.notes ? <span className="appointment-note">Заметка: {appointment.notes}</span> : null}
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
  const [message, setMessage] = useState('');
  const [blockTarget, setBlockTarget] = useState(null);
  const [blockReason, setBlockReason] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(60);
  const { run, busy } = useAction(setError, setMessage);
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
    if (filter === 'active') return client.lifecycle_status === 'active';
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
  const activeClients = clients.filter((client) => client.lifecycle_status === 'active').length;

  // These counts used to sit in a row of tiles above a dropdown offering the
  // very same cuts. A tile you want to tap but cannot is a dead end, so the
  // count and the filter are now one control.
  //
  // Note the groups overlap: a client can be active and still not have been in
  // for 45 days. The counts do not add up to the total, and are not meant to.
  const clientFilters = [
    { id: 'all', label: 'Все', count: clients.length },
    { id: 'active', label: 'Активные', count: activeClients },
    { id: 'return', label: 'Давно не были', count: returningClients, hint: '45 дней и более' },
    { id: 'marketing', label: 'Можно уведомлять', count: marketingClients, hint: 'есть согласие' },
    { id: 'blocked', label: 'Заблокированы', count: blockedClients },
  ];

  async function setClientBlocked(client, blocked) {
    let reason = null;
    if (blocked) {
      // window.prompt is unreliable inside the Telegram webview, so the reason
      // is collected by an in-page field instead of a native dialog.
      reason = blockReason.trim();
      if (!reason) {
        setBlockTarget(client);
        return;
      }
      if (reason.length > 500) return setError('Причина блокировки не должна превышать 500 символов.');
    } else if (!await confirmAction(`Разблокировать клиента ${client.full_name}?`)) return;

    const ok = await run(
      () => callLegacyApi('setClientBlocked', { id: client.id, blocked, reason }).then(reload),
      blocked ? 'Клиент заблокирован.' : 'Клиент разблокирован.',
    );
    if (ok) {
      setBlockTarget(null);
      setBlockReason('');
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
        <div aria-label="Фильтр списка клиентов" className="client-chips" role="group">
          {clientFilters.map((option) => (
            <button
              aria-pressed={filter === option.id}
              className={`client-chip ${filter === option.id ? 'is-on' : ''}`}
              key={option.id}
              title={option.hint || undefined}
              type="button"
              onClick={() => setFilter(option.id)}
            >
              <span>{option.label}</span>
              <strong>{option.count}</strong>
            </button>
          ))}
        </div>
      </div>

      <div className="card wide">
        <div className="section-title">
          <h2>Клиенты</h2>
          <span>{filteredClients.length} из {clients.length}</span>
        </div>
        <Rows
          empty="Клиенты по выбранному фильтру не найдены."
          rows={filteredClients.slice(0, visibleLimit)}
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
                <span>
                  Последний визит: {client.last_visit_at ? displayDateTime(client.last_visit_at) : 'ещё не был'}
                  {/* Already computed in the view, and far more actionable than
                      a bare date when deciding who to call back. */}
                  {client.days_since_last_visit != null
                    ? ` · ${Math.round(client.days_since_last_visit)} ${pluralRu(Math.round(client.days_since_last_visit), 'день', 'дня', 'дней')} назад`
                    : ''}
                </span>
                <span>Неявок: {Number(client.no_show_count) || 0}</span>
                <span>Последняя неявка: {client.last_no_show_at ? displayDateTime(client.last_no_show_at) : 'нет'}</span>
                <span>Рассылка: {CLIENT_CONSENT_LABELS[client.marketing_consent] || 'Не запрошено'}</span>
                {client.blocked_at ? <span className="client-blocked-detail">Блокировка: {client.blocked_reason}</span> : null}
                {blockTarget?.id === client.id ? (
                  <div className="client-block-form">
                    <input
                      autoFocus
                      maxLength={500}
                      placeholder="Причина блокировки (обязательно)"
                      value={blockReason}
                      onChange={(event) => setBlockReason(event.target.value)}
                    />
                    <button className="btn danger" type="button" disabled={busy || !blockReason.trim()} onClick={() => setClientBlocked(client, true)}>
                      Заблокировать
                    </button>
                    <button className="btn ghost" type="button" onClick={() => { setBlockTarget(null); setBlockReason(''); }}>
                      Отмена
                    </button>
                  </div>
                ) : (
                  <button className={client.blocked_at ? 'btn ghost client-block-button' : 'btn danger client-block-button'} type="button" disabled={busy} onClick={() => setClientBlocked(client, !client.blocked_at)}>
                    {client.blocked_at ? 'Разблокировать' : 'Заблокировать'}
                  </button>
                )}
              </div>
            </article>
          )}
        />
        {filteredClients.length > visibleLimit ? (
          <button className="btn ghost" type="button" onClick={() => setVisibleLimit((limit) => limit + 60)}>
            Показать ещё · осталось {filteredClients.length - visibleLimit}
          </button>
        ) : null}
        {message ? <p className="success">{message}</p> : null}
      </div>
    </section>
  );
}

function FinanceView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection();
  const [tab, setTab] = useState('ishxona');
  const [form, setForm] = useState({ date: TODAY, section: 'ishxona', name: '', qty: '', amount_uzs: '', usd_rate: localStorage.getItem('usdRate') || '12200', minus_from: '' });
  const [offsetForm, setOffsetForm] = useState({ date: TODAY, owner: 'jamshid', amount_usd: '500', usd_rate: localStorage.getItem('usdRate') || '12200', note: '' });
  const [message, setMessage] = useState('');
  const [offsetsOpen, setOffsetsOpen] = useState(false);
  const { run, busy } = useAction(setError, setMessage);
  const financeRows = [...data.sales, ...data.expenses];
  const range = getRange(period, customFrom, customTo, financeRows);
  const priorRange = comparablePreviousRange(range, period, TODAY);
  const expenses = data.expenses.filter((expense) => inRange(rowDate(expense, 'date'), range.from, range.to));
  const previousExpenses = priorRange ? data.expenses.filter(
    (expense) => inRange(rowDate(expense, 'date'), priorRange.from, priorRange.to),
  ) : [];
  const ishxonaExpenses = totalExpenses(operatingExpenses(expenses));
  const previousIshxonaExpenses = totalExpenses(operatingExpenses(previousExpenses));
  const offsetIncome = rentOffsetIncome(expenses);
  const comparison = (current, previous) => priorRange ? comparisonToPrevious(current, previous, priorRange) : {};
  const visibleExpenses = expenses
    .filter((expense) => expense.section === tab && expense.category !== 'rent_offset')
    .sort(newestFirst);
  const visibleOffsets = expenses
    .filter((expense) => expense.category === 'rent_offset')
    .sort(newestFirst);
  const visibleExpenseTotal = totalExpenses(visibleExpenses);

  async function addExpense(event) {
    event.preventDefault();
    const amount = Number(form.amount_uzs);
    if (!form.name.trim() || !amount) return setError('Введите название и сумму расхода.');
    const ok = await run(() => callLegacyApi('addExpense', {
      date: form.date || TODAY,
      section: form.section,
      name: form.name.trim(),
      qty: form.qty || null,
      amount_uzs: amount,
      usd_rate: Number(form.usd_rate) || null,
      minus_from: form.section === 'ishxona' ? form.minus_from || null : null,
    }).then(reload), `Расход ${money(amount)} сум сохранён.`);
    if (!ok) return;
    if (form.usd_rate) localStorage.setItem('usdRate', form.usd_rate);
    setForm((current) => ({ ...current, name: '', qty: '', amount_uzs: '' }));
  }

  async function addRentOffset(event) {
    event.preventDefault();
    const amountUsd = Number(offsetForm.amount_usd);
    const usdRate = Number(offsetForm.usd_rate);
    if (!amountUsd || !usdRate) return setError('Введите сумму аренды в USD и курс USD.');
    const ok = await run(() => callLegacyApi('addRentOffset', {
      date: offsetForm.date || TODAY,
      owner: offsetForm.owner,
      amount_usd: amountUsd,
      usd_rate: usdRate,
      note: offsetForm.note.trim() || null,
    }).then(reload), `Взаимозачёт $${money(amountUsd)} сохранён. Касса не изменилась.`);
    if (ok) localStorage.setItem('usdRate', offsetForm.usd_rate);
  }

  async function deleteExpense(expense) {
    // Deleting an expense is audited and irreversible, and the button sits a
    // few pixels from the amount.
    const label = `${expense.name || 'расход'} на ${money(expense.amount_uzs)} сум`;
    if (!await confirmAction(`Удалить ${label}?`)) return;
    await run(() => callLegacyApi('delExpense', { id: expense.id }).then(reload), 'Расход удалён.');
  }

  function sectionExpense(section) {
    return data.expenses
      .filter((expense) => expense.section === section && expense.category !== 'rent_offset')
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
        <SectionHeading label="Расходы за период" range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="tiles">
          {/* This screen is one side of the ledger: money that left. Revenue,
              master payouts and the remainder are all products of sales and
              belong on Продажи; profit is the sum of both sides and belongs on
              Обзор, which is the only screen allowed to add them up. Showing
              them here too was what made the same figures appear three times. */}
          <Tile label="Расходы" value={money(ishxonaExpenses)} {...comparison(ishxonaExpenses, previousIshxonaExpenses)} danger />
          <Tile label="Безденежный доход" value={money(offsetIncome)} hint="касса не меняется" />
        </div>
      </div>

      {message ? <div className="notice success wide">{message}</div> : null}

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
        <Rows rows={visibleExpenses} empty="Записей за период нет." render={(expense) => (
          <div className="row" key={expense.id}>
            <div>
              <strong>{expense.name}</strong>
              <span>
                {rowDate(expense, 'date')} · {expense.minus_from ? `минус ${expense.minus_from}` : expense.section}
              </span>
            </div>
            <div><strong>{money(expense.amount_uzs)}</strong><button className="del" type="button" onClick={() => deleteExpense(expense)}>×</button></div>
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
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Добавить расход'}</button>
      </form>

      <div className="card wide offset-history-card">
        <button
          aria-expanded={offsetsOpen}
          className="overview-more"
          type="button"
          onClick={() => setOffsetsOpen((open) => !open)}
        >
          {offsetsOpen ? 'Свернуть взаимозачёты' : 'Подробнее: взаимозачёты'}
        </button>

        {offsetsOpen ? (
          <div className="offset-history">
            <form className="offset-form-card" onSubmit={addRentOffset}>
              <h2>Взаимозачёт аренды</h2>
              <p className="hint">Уменьшает вложения партнёра и показывает безденежный доход. Касса и расходы Ишхоны не меняются.</p>
              <label>
                Дата
                <input type="date" value={offsetForm.date} onChange={(event) => setOffsetForm({ ...offsetForm, date: event.target.value })} />
              </label>
              <label>
                Партнёр
                <select value={offsetForm.owner} onChange={(event) => setOffsetForm({ ...offsetForm, owner: event.target.value })}>
                  <option value="jamshid">Жамшид</option>
                  <option value="murod">Мурод</option>
                </select>
              </label>
              <label>
                Аренда, USD
                <MoneyInput placeholder="500" value={offsetForm.amount_usd} onChange={(amount_usd) => setOffsetForm({ ...offsetForm, amount_usd })} />
              </label>
              <label>
                Курс USD
                <MoneyInput placeholder="Курс USD" value={offsetForm.usd_rate} onChange={(usd_rate) => setOffsetForm({ ...offsetForm, usd_rate })} />
              </label>
              <label>
                Примечание
                <input placeholder="Например: аренда за июль" value={offsetForm.note} onChange={(event) => setOffsetForm({ ...offsetForm, note: event.target.value })} />
              </label>
              <p className="hint">
                В отчёте: {money(Number(offsetForm.amount_usd || 0) * Number(offsetForm.usd_rate || 0))} сум без движения денег.
              </p>
              <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить взаимозачёт'}</button>
            </form>

            <div className="section-title">
              <div>
                <h2>Взаимозачёты</h2>
                <p className="hint">{displayRange(range)} · без движения денег</p>
              </div>
              <strong>{money(offsetIncome)} сум</strong>
            </div>
            {visibleOffsets.length ? (
              <div className="table-scroll">
                <table className="offset-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Партнёр</th>
                      <th>USD</th>
                      <th>Сум</th>
                      <th>Примечание</th>
                      <th aria-label="Действия" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOffsets.map((expense) => {
                      const rate = Number(expense.usd_rate) || 0;
                      const amount = Number(expense.amount_uzs) || 0;
                      return (
                        <tr key={expense.id}>
                          <td>{rowDate(expense, 'date')}</td>
                          <td>{expense.minus_from === 'murod' ? 'Мурод' : 'Жамшид'}</td>
                          <td>{rate ? usdMoneyPrecise(amount / rate) : '—'}</td>
                          <td>{money(amount)}</td>
                          <td className="offset-note">{expense.note || expense.name}</td>
                          <td><button aria-label={`Удалить взаимозачёт от ${rowDate(expense, 'date')}`} className="del" type="button" onClick={() => deleteExpense(expense)}>×</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="hint offset-empty">Взаимозачётов за выбранный период нет.</p>}
          </div>
        ) : null}
      </div>
    </section>
  );
}

const CHART_MAX_DAYS = 370;

function RevenueChart({ sales, previousSales = [], from, to, previousFrom, previousTo }) {
  const [selectedDay, setSelectedDay] = useState(null);
  const scrollRef = useRef(null);
  const days = [];
  const end = new Date(`${to}T12:00:00`);
  // Capped at the most recent stretch rather than the oldest: over "всё время"
  // the chart used to draw the first year the salon existed and drop the
  // present, while the legend summed only what was drawn.
  const requestedStart = new Date(`${from}T12:00:00`);
  const cappedStart = new Date(end);
  cappedStart.setDate(cappedStart.getDate() - (CHART_MAX_DAYS - 1));
  const truncated = requestedStart < cappedStart;
  const cursor = truncated ? cappedStart : requestedStart;

  while (cursor <= end) {
    days.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // A month of bars is wider than the phone, and the view started at the left
  // edge — so today, the day the owner opens this for, was off screen.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [from, to, days.length]);

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
    // Bounded by the drawn window: the two series are read by index, so a
    // longer previous period can only contribute days nothing lines up with.
    while (previousCursor <= previousEnd && previousDays.length < days.length) {
      previousDays.push(localDate(previousCursor));
      previousCursor.setDate(previousCursor.getDate() + 1);
    }
  }
  // The previous period used to carry revenue only, so a tapped bar showed how
  // many clients came this Thursday and stayed silent about the last one —
  // which is the comparison that explains the revenue difference.
  const previousTotals = Object.fromEntries(previousDays.map((day) => [day, { revenue: 0, clients: 0 }]));
  previousSales.forEach((sale) => {
    const day = rowDate(sale);
    if (day in previousTotals) {
      previousTotals[day].revenue += saleTotal(sale);
      previousTotals[day].clients += clients(sale);
    }
  });
  const previousValues = days.map((_, index) => previousTotals[previousDays[index]]?.revenue || 0);
  const previousClientCounts = days.map((_, index) => previousTotals[previousDays[index]]?.clients || 0);
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
  const selectedPreviousClients = selectedIndex >= 0 ? previousClientCounts[selectedIndex] : 0;
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
        <div>
          <i className="chart-legend-current" />
          <span>{displayRange({ from: days[0] || from, to: days[days.length - 1] || to })}</span>
          <strong>{money(currentTotal)} сум</strong>
        </div>
        {truncated ? <p className="hint">Показаны последние {CHART_MAX_DAYS} дней периода.</p> : null}
        {previousFrom && previousTo ? (
          <div><i className="chart-legend-previous" /><span>{displayRange({ from: previousFrom, to: previousTo })}</span><strong>{money(previousTotal)} сум</strong></div>
        ) : null}
      </div>
      <div className="chart" ref={scrollRef}>
        <svg height="150" viewBox={`0 0 ${width} 150`} width={width}>
        {days.map((day, index) => {
          const height = Math.round((values[index] / max) * 100);
          const previousHeight = Math.round((previousValues[index] / max) * 100);
          const x = 10 + index * (barWidth + gap);
          const isSelected = selectedDay === day;
          return (
            <g
              aria-label={`${displayDate(day)}: ${totals[day].clients} клиентов, выручка ${money(totals[day].revenue)} сум${previousDays[index] ? `; ${displayDate(previousDays[index])}: ${previousClientCounts[index]} клиентов, ${money(previousValues[index])} сум` : ''}`}
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
          <div>
            <span>{displayDate(selectedDay)} · текущий · {totals[selectedDay].clients} кл.</span>
            <strong>{money(selectedValue)} сум</strong>
          </div>
          {selectedPreviousDay ? (
            <div>
              <span>{displayDate(selectedPreviousDay)} · прошлый · {selectedPreviousClients} кл.</span>
              <strong>{money(selectedPreviousValue)} сум</strong>
            </div>
          ) : null}
        </div>
      ) : <p className="chart-tap-hint">Нажмите на столбец, чтобы сравнить конкретные дни.</p>}
    </div>
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
// Eight flat tabs on a 390px screen make the owner remember where each screen
// lives. Four groups turn that recall into recognition, and the second row only
// appears for groups that actually hold more than one screen.
// Masters see two screens in total, so grouping them would add a level of
// navigation to hide nothing.
const VIEW_GROUPS = [
  { id: 'overview', label: 'Обзор', views: ['overview'] },
  { id: 'money', label: 'Деньги', views: ['admin', 'finance'] },
  { id: 'people', label: 'Люди', views: ['attendance', 'clients', 'master'] },
  { id: 'calendar', label: 'Календарь', views: ['calendar'] },
];

// Inside a group the shorter name is unambiguous — "Продажи" under "Деньги"
// says as much as "Управление салоном" did, in a third of the width.
const VIEW_TAB_LABELS = {
  overview: 'Обзор',
  admin: 'Продажи',
  finance: 'Расходы',
  attendance: 'Посещаемость',
  clients: 'Клиенты',
  master: 'Мастера',
  calendar: 'Календарь',
};

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
    title: 'Расходы салона',
    description: 'Траты по разделам и вложения за выбранный период.',
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

  async function load({ preserveView = true, since = null } = {}) {
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

      const result = await callLegacyApi('load', since ? { since } : {});
      const normalized = normalizeData(result);
      // Trust the window only if the server confirms it applied one; an older
      // deployment ignores `since` and answers with everything, which merges
      // correctly either way but must not discard rows it did return.
      const appliedSince = result?.windowSince === since ? since : null;
      setData((previous) => (
        appliedSince ? mergeWindowedData(previous, normalized, appliedSince) : normalized
      ));
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

    const refresh = ({ full = false } = {}) => {
      if (!document.hidden && !isLoadingRef.current) {
        load({ preserveView: true, since: full ? null : pollWindowStart() });
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

      // Coming back into view is the one moment worth paying for everything:
      // it re-syncs records older than the poll window, which the windowed
      // refresh cannot see being edited or deleted.
      refresh({ full: true });
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
  // A group is only offered if the role can reach something inside it, so an
  // admin without calendar rights never sees an empty tab.
  const navGroups = useMemo(() => (
    VIEW_GROUPS
      .map((group) => ({ ...group, views: group.views.filter((id) => availableViews.includes(id)) }))
      .filter((group) => group.views.length)
  ), [availableViews]);
  const activeGroup = navGroups.find((group) => group.views.includes(view)) || navGroups[0];
  const pendingSalesCount = getPendingSales(data.sales).length;

  if (loginRequired) return <LoginGate error={error} />;
  if (isLoading) {
    return (
      <main className="loading-splash" role="status" aria-label="Загрузка">
        <div className="loading-emblem" aria-hidden="true">
          <div className="loading-coin">
            <div className="loading-coin-face">M</div>
            <div className="loading-coin-face loading-coin-back">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="18" r="3" />
                <path d="M8.1 15.9 20 4M15.9 15.9 4 4" />
              </svg>
            </div>
          </div>
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

      {availableViews.length && data.role === 'master' ? (
        <nav className="seg nav">
          {[['master', 'Мастер'], ['calendar', 'Календарь']]
            .filter(([id]) => availableViews.includes(id))
            .map(([id, label]) => (
              <button className={view === id ? 'on' : ''} key={id} type="button" onClick={() => setView(id)}>
                {label}
              </button>
            ))}
        </nav>
      ) : null}

      {availableViews.length && data.role !== 'master' ? (
        <>
          <nav className="seg nav">
            {navGroups.map((group) => {
              const showsPending = group.views.includes('admin') && pendingSalesCount;
              return (
                <button
                  className={`${activeGroup?.id === group.id ? 'on ' : ''}${showsPending ? 'has-nav-badge' : ''}`}
                  key={group.id}
                  type="button"
                  onClick={() => setView(group.views.includes(view) ? view : group.views[0])}
                >
                  {group.label}
                  {showsPending ? (
                    <span className="nav-badge" aria-label={`${pendingSalesCount} продаж ожидают подтверждения`}>
                      {pendingSalesCount > 99 ? '99+' : pendingSalesCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          {activeGroup && activeGroup.views.length > 1 ? (
            <nav className="seg nav nav-sub" aria-label={`Разделы: ${activeGroup.label}`}>
              {activeGroup.views.map((id) => (
                <button
                  className={`${view === id ? 'on ' : ''}${id === 'admin' && pendingSalesCount ? 'has-nav-badge' : ''}`}
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                >
                  {VIEW_TAB_LABELS[id]}
                  {id === 'admin' && pendingSalesCount ? (
                    <span className="nav-badge" aria-label={`${pendingSalesCount} продаж ожидают подтверждения`}>
                      {pendingSalesCount > 99 ? '99+' : pendingSalesCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>
          ) : null}
        </>
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
      <CurrentView data={data} reload={load} setError={setError} setView={setView} />

      <footer>Данные сохраняются в облаке (Supabase). <span>{APP_VERSION}</span></footer>
    </main>
  );
}
