import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  belongsToMaster,
  clientBreakdown,
  comparisonRanges,
  inRange,
  latenessSummary,
  masterPayoutForPeriod,
  mastersForPeriod,
  minutesLate,
  shiftStartFor,
  paymentMix,
  percentageDifference,
  previousRange,
  shiftProductivity,
} from './utils/reporting.js';
import {
  localDate,
  mergeWindowedData,
  pollWindowStart,
  rowDate,
} from './utils/loadWindow.js';
import { pluralRu } from './utils/plural.js';
import { comparisonLabel, sameWeekdayLastWeek } from './utils/periods.js';
import {
  attentionSignals,
  compactMoney,
  monthForecast,
  monthlySeries,
  returningShare,
  summarizeSales,
} from './utils/insights.js';

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

const PAYMENT_METHODS = [
  ['cash', 'Наличные'],
  ['card', 'Карта'],
  ['qr', 'QR Paynet'],
];

// A sale has always had three amount columns; the form simply only ever filled
// one. A client who paid part by card and part in cash is one sale with two
// non-zero columns, not two rows.
function paymentParts(sale) {
  return PAYMENT_METHODS
    .filter(([key]) => (Number(sale[key]) || 0) > 0)
    .map(([key, label]) => ({ key, label, amount: Number(sale[key]) }));
}

function paymentLabel(sale) {
  const parts = paymentParts(sale);
  if (parts.length <= 1) return parts[0]?.label || '—';
  return parts.map((part) => `${part.label} ${money(part.amount)}`).join(' + ');
}

function PaymentChips({ sale }) {
  const parts = paymentParts(sale);
  const split = parts.length > 1;
  return (
    <span className="pay-chips">
      {parts.map((part) => (
        <span className={`pay-chip ${part.key}`} key={part.key}>
          <i className="payment-dot" aria-hidden="true" />
          {part.label}{split ? ` ${money(part.amount)}` : ''}
        </span>
      ))}
    </span>
  );
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
  invalid_goal: 'Проверьте сумму цели.',
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
// Расходы to check one figure silently threw the chosen month away. The money
// screens share one selection; attendance and a master's own day keep theirs,
// because "who came today" and "what did the salon earn" start from different
// periods. It lasts for the session only: remembered across launches, a day
// picked once kept opening Продажи on an empty morning.
function readSessionValue(key, fallback) {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in a private webview; the choice then simply
    // does not outlive the screen.
  }
}

function usePeriodSelection(scope, defaultPeriod) {
  const key = `maestroPeriod:${scope}`;
  const [period, setPeriod] = useState(() => readSessionValue(key, defaultPeriod));
  const [customFrom, setCustomFrom] = useState(() => readSessionValue(`${key}:from`, ''));
  const [customTo, setCustomTo] = useState(() => readSessionValue(`${key}:to`, ''));

  useEffect(() => {
    writeSessionValue(key, period);
    writeSessionValue(`${key}:from`, customFrom);
    writeSessionValue(`${key}:to`, customTo);
  }, [key, period, customFrom, customTo]);

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
// and what it is compared with drops to the quiet line underneath.
//
// A day that is still running cannot have fallen behind a finished one: at
// noon "−100%" is only the morning. Until it overtakes, it states the target
// in a neutral tone instead of a red loss.
function comparisonToPrevious(current, previous, comparisonRange, formatValue = money, { inProgress = false } = {}) {
  const percent = percentageDifference(current, previous);
  const hint = comparisonLabel(comparisonRange, TODAY);
  if (inProgress && (Number(current) || 0) <= (Number(previous) || 0)) {
    return { secondary: `было ${formatValue(previous)}`, secondaryTone: '', hint };
  }
  return {
    secondary: `${percent > 0 ? '+' : ''}${percent}% · было ${formatValue(previous)}`,
    secondaryTone: percent > 0 ? 'positive' : percent < 0 ? 'negative' : '',
    hint,
  };
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
    dayStatuses: data.master_day_statuses || [],
    scheduleRules: data.master_schedule_rules || [],
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

function MasterMetricComparison({ current, previous, format = money, inProgress = false }) {
  const percent = percentageDifference(current, previous);
  const tone = percent > 0 ? 'positive' : percent < 0 ? 'negative' : '';
  if (inProgress && (Number(current) || 0) <= (Number(previous) || 0)) {
    return <small className="master-period-change"><span>было {format(previous)}</span></small>;
  }
  return (
    <small className={`master-period-change ${tone}`}>
      {percent > 0 ? '+' : ''}{percent}% <span>· было {format(previous)}</span>
    </small>
  );
}


function shortRange(range) {
  const short = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
  return range.from === range.to ? short(range.from) : `${short(range.from)}–${short(range.to)}`;
}

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function monthName(day, options = { month: 'long' }) {
  const [year, month] = String(day).split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', options).format(new Date(year, month - 1, 1));
}

function shareText(value) {
  return value == null ? '—' : `${Math.round(value)}%`;
}

// A share is compared by showing the old share, not a percent of a percent:
// "70%, было 59%" reads at a glance where "+11 п.п." needed explaining.
function shareComparison(current, previous, comparisonRange) {
  if (current == null || previous == null) return {};
  const points = Math.round(current) - Math.round(previous);
  return {
    secondary: `было ${shareText(previous)}`,
    secondaryTone: points > 0 ? 'positive' : points < 0 ? 'negative' : '',
    hint: comparisonLabel(comparisonRange, TODAY),
  };
}

// A target turns the forecast into an answer: not "about 83 million" but
// "two million short". The bar fills with what is banked; the tick marks
// where the pace would end the month.
function MonthGoal({ goal, monthRevenue, forecast, canEdit, busy, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal ? String(goal) : '');

  async function save(event) {
    event.preventDefault();
    const value = Number(draft);
    if (!value || value <= 0) return;
    if (await onSave(value)) setEditing(false);
  }

  async function clear() {
    if (await onSave(null)) {
      setDraft('');
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <form className="goal-form" onSubmit={save}>
        <label>
          Цель по выручке на месяц
          <MoneyInput placeholder="например, 85 000 000" value={draft} onChange={setDraft} />
        </label>
        <div className="goal-form-actions">
          <button className="btn" type="submit" disabled={busy || !Number(draft)}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
          {goal ? <button className="btn ghost" type="button" disabled={busy} onClick={clear}>Убрать цель</button> : null}
        </div>
      </form>
    );
  }

  if (!goal) {
    return canEdit ? (
      <button className="goal-set" type="button" onClick={() => { setDraft(''); setEditing(true); }}>
        + Поставить цель на месяц
      </button>
    ) : null;
  }

  const done = (monthRevenue / goal) * 100;
  const projected = forecast ? (forecast.revenue / goal) * 100 : null;
  const gap = forecast ? goal - forecast.revenue : null;
  return (
    <div className="goal">
      <div className="goal-heading">
        <span>Цель <strong>{compactMoney(goal)}</strong></span>
        <strong className={done >= 100 ? 'positive' : ''}>{Math.floor(done)}%</strong>
      </div>
      <div className="goal-track" aria-hidden="true">
        <i className="goal-fill" style={{ width: `${Math.min(100, done)}%` }} />
        {projected != null ? <i className="goal-marker" style={{ left: `${Math.min(100, projected)}%` }} /> : null}
      </div>
      <p className="hint">
        {done >= 100
          ? `Цель выполнена${done > 100 ? `, сверху ${compactMoney(monthRevenue - goal)}` : ''}.`
          : gap == null
            ? `До цели ${compactMoney(goal - monthRevenue)}.`
            : gap > 0
              ? `По текущему темпу не хватит ≈ ${compactMoney(gap)} — нужно ≈ ${compactMoney((goal - monthRevenue) / Math.max(1, forecast.daysInMonth - forecast.completedDays))} в день.`
              : `По текущему темпу цель будет перевыполнена на ≈ ${compactMoney(-gap)}.`}
        {canEdit ? (
          <>
            {' '}
            <button className="goal-edit" type="button" onClick={() => { setDraft(String(goal)); setEditing(true); }}>Изменить</button>
          </>
        ) : null}
      </p>
    </div>
  );
}

// Where the month will land if the pace holds — the question a month-to-date
// figure can only answer on its last day.
function ForecastCard({ forecast, monthRevenue, goal, canEdit, busy, onSaveGoal }) {
  if (!forecast && !goal && !canEdit) return null;
  const change = forecast?.revenueChange;
  const daysLeft = forecast ? forecast.daysInMonth - forecast.completedDays : 0;
  return (
    <div className="card wide forecast-card">
      <div className="section-heading">
        <h2>Прогноз на {monthName(TODAY)}</h2>
        {forecast ? (
          <span className="date-badge">по {forecast.completedDays} {pluralRu(forecast.completedDays, 'дню', 'дням', 'дням')}</span>
        ) : null}
      </div>
      {forecast ? (
        <>
          <div className="forecast-main">
            <strong>≈ {compactMoney(forecast.revenue)} <small>сум</small></strong>
            {change != null ? (
              <em className={change > 0 ? 'positive' : change < 0 ? 'negative' : ''}>
                {change > 0 ? '+' : ''}{change}% {comparisonLabel(forecast.previous, TODAY)} · там было {compactMoney(forecast.previous.revenue)}
              </em>
            ) : null}
          </div>
          <p className="hint forecast-note">
            Уже {money(monthRevenue)} сум, {daysLeft ? `осталось ${daysLeft} ${pluralRu(daysLeft, 'день', 'дня', 'дней')}` : 'последний день'}.
            {' '}Клиентов будет ≈ {Math.round(forecast.clients)}.
          </p>
        </>
      ) : (
        <p className="hint">Прогноз появится завтра, когда пройдёт первый день месяца.</p>
      )}
      <MonthGoal
        goal={goal}
        monthRevenue={monthRevenue}
        forecast={forecast}
        canEdit={canEdit}
        busy={busy}
        onSave={onSaveGoal}
      />
    </div>
  );
}

function SignalsCard({ result }) {
  const bad = result.signals.filter((signal) => signal.tone === 'bad');
  const good = result.signals.filter((signal) => signal.tone === 'good');
  return (
    <div className="card wide signals-card">
      <div className="section-heading">
        <h2>Что происходит</h2>
        {result.ready ? <span className="date-badge">{shortRange(result.range)} против {shortRange(result.previousRange)}</span> : null}
      </div>
      {!result.ready ? (
        <p className="hint">Сигналы появятся через несколько дней месяца — пока сравнивать не с чем.</p>
      ) : !result.signals.length ? (
        <p className="hint">Резких изменений нет: месяц идёт так же, как прошлый.</p>
      ) : (
        <>
          {bad.length ? (
            <ul className="signal-list">
              {bad.map((signal) => (
                <li className="signal bad" key={signal.title}>
                  <span className="signal-icon" aria-hidden="true">▼</span>
                  <span><strong>{signal.title}</strong><small>{signal.detail}</small></span>
                </li>
              ))}
            </ul>
          ) : null}
          {good.length ? (
            <ul className="signal-list">
              {good.map((signal) => (
                <li className="signal good" key={signal.title}>
                  <span className="signal-icon" aria-hidden="true">▲</span>
                  <span><strong>{signal.title}</strong><small>{signal.detail}</small></span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

function MastersOfMonth({ rows, comparisonRange, inProgress, onOpen }) {
  const leader = rows[0]?.revenue > 0 ? rows[0].master.id : null;
  return (
    <div className="card wide masters-month-card">
      <div className="section-heading">
        <h2>Мастера месяца</h2>
        <span className="date-badge">выручка {comparisonRange ? comparisonLabel(comparisonRange, TODAY) : ''}</span>
      </div>
      <ol className="master-rank">
        {rows.map((row, index) => (
          <li key={row.master.id ?? row.master.name}>
            <button type="button" className={row.master.id === leader ? 'is-leader' : ''} onClick={() => onOpen(row.master)}>
              <span className="master-rank-number">{index + 1}</span>
              <span className="master-rank-name">
                <strong>{row.master.name}{row.master.id === leader ? ' ★' : ''}</strong>
                <small>
                  новых {row.summary.newClients} · пост. {row.summary.returningClients}
                  {row.summary.clients > row.summary.labelledClients ? ` · без типа ${row.summary.clients - row.summary.labelledClients}` : ''}
                </small>
              </span>
              <span className="master-rank-value">
                <strong>{compactMoney(row.revenue)}</strong>
                {comparisonRange ? (
                  <MasterMetricComparison current={row.compareRevenue} previous={row.previousRevenue} format={compactMoney} inProgress={inProgress} />
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="hint">Нажмите на мастера, чтобы открыть его карточку.</p>
    </div>
  );
}

const TREND_METRICS = [
  { key: 'revenue', label: 'Выручка', unit: 'млн сум', bar: (value) => (value / 1_000_000).toFixed(1).replace('.', ','), full: (value) => `${money(value)} сум` },
  { key: 'profit', label: 'Прибыль', unit: 'млн сум', bar: (value) => (value / 1_000_000).toFixed(1).replace('.', ','), full: (value) => `${money(value)} сум` },
  { key: 'clients', label: 'Клиенты', unit: 'клиентов', bar: (value) => String(Math.round(value)), full: (value) => `${Math.round(value)} клиентов` },
  { key: 'newClients', label: 'Новые', unit: 'новых клиентов', bar: (value) => String(Math.round(value)), full: (value) => `${Math.round(value)} новых` },
];

// The whole trajectory, not one month against one month: whether September is
// a recovery or a continuing slide depends on the months before August.
function MonthlyTrend({ series, forecast }) {
  const [metricKey, setMetricKey] = useState('revenue');
  const [selectedIndex, setSelectedIndex] = useState(series.length - 1);
  const metric = TREND_METRICS.find((item) => item.key === metricKey);
  // The new/returning flag only exists from July 2026; earlier months have no
  // answer, which is not the same as zero.
  const valueOf = (row) => (metricKey === 'newClients' && !row.labelledClients ? null : row[metricKey]);
  const projectionOf = (row) => {
    if (!row.isCurrent || !forecast) return null;
    if (metricKey === 'revenue') return forecast.revenue;
    if (metricKey === 'clients') return forecast.clients;
    return null;
  };
  const values = series.map(valueOf);
  const peak = Math.max(1, ...values.map((value) => Math.abs(value || 0)), ...series.map((row) => projectionOf(row) || 0));
  const selected = series[selectedIndex] || series[series.length - 1];
  const selectedValue = selected ? valueOf(selected) : null;
  const previousRow = series[series.indexOf(selected) - 1];
  const previousValue = previousRow ? valueOf(previousRow) : null;
  const projection = selected ? projectionOf(selected) : null;

  if (!series.length) return null;

  return (
    <div className="card wide trend-card">
      <div className="section-heading">
        <h2>По месяцам</h2>
        <span className="date-badge">{metric.unit}</span>
      </div>
      <div className="seg trend-metrics">
        {TREND_METRICS.map((item) => (
          <button className={item.key === metricKey ? 'on' : ''} key={item.key} type="button" onClick={() => setMetricKey(item.key)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="trend-bars" role="list">
        {series.map((row, index) => {
          const value = values[index];
          const ghost = projectionOf(row);
          return (
            <button
              aria-label={`${monthName(row.from, { month: 'long', year: 'numeric' })}: ${value == null ? 'нет данных' : metric.full(value)}`}
              className={`trend-bar ${index === selectedIndex ? 'is-selected' : ''} ${row.isCurrent ? 'is-current' : ''} ${value < 0 ? 'is-negative' : ''}`}
              key={row.key}
              role="listitem"
              type="button"
              onClick={() => setSelectedIndex(index)}
            >
              <span className="trend-value">{value == null ? '—' : metric.bar(value)}</span>
              <span className="trend-column">
                {ghost ? <i className="trend-ghost" style={{ height: `${(ghost / peak) * 100}%` }} /> : null}
                <i className="trend-fill" style={{ height: `${(Math.abs(value || 0) / peak) * 100}%` }} />
              </span>
              <span className="trend-month">{MONTH_SHORT[Number(row.key.slice(5, 7)) - 1]}</span>
            </button>
          );
        })}
      </div>
      {selected ? (
        <div className="trend-detail" aria-live="polite">
          <span>{monthName(selected.from, { month: 'long', year: 'numeric' })}{selected.isCurrent ? ' · месяц идёт' : ''}</span>
          <strong>{selectedValue == null ? 'нет данных' : metric.full(selectedValue)}</strong>
          {selected.isCurrent ? (
            projection ? (
              <small>прогноз ≈ {metricKey === 'revenue' ? `${compactMoney(projection)} сум` : metric.full(projection)}</small>
            ) : <small>итог будет в конце месяца</small>
          ) : selectedValue != null && previousValue != null ? (
            <small className={selectedValue > previousValue ? 'positive' : selectedValue < previousValue ? 'negative' : ''}>
              {(() => {
                const change = percentageDifference(selectedValue, previousValue);
                return `${change > 0 ? '+' : ''}${change}% ${comparisonLabel(previousRow, TODAY)}`;
              })()}
            </small>
          ) : null}
        </div>
      ) : null}
      {forecast && (metricKey === 'revenue' || metricKey === 'clients') ? (
        <p className="hint">Светлая часть последнего столбца — прогноз до конца месяца.</p>
      ) : null}
    </div>
  );
}

// Everything about one master on one screen: this month against the same days
// of the last, and the months before it.
function MasterSheet({ data, master, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const monthRange = currentMonthRange();
  const { current: compareRange, previous: priorRange, inProgress } = comparisonRanges(monthRange, 'month', TODAY);
  const mine = data.sales.filter((sale) => isCountedSale(sale) && belongsToMaster(sale, master));
  const myFines = data.fines.filter((fine) => belongsToMaster(fine, master));
  const within = (rows, range, key = 'd') => (
    range ? rows.filter((row) => inRange(rowDate(row, key), range.from, range.to)) : []
  );
  const payFor = (range) => masterNetPay(
    grossMasterPayForSales(within(mine, range), master),
    totalFines(within(myFines, range)),
  );
  const nowSales = within(mine, monthRange);
  const monthFines = [...within(myFines, monthRange)].sort(newestFirst);
  const now = summarizeSales(nowSales);
  const compare = summarizeSales(within(mine, compareRange));
  const before = summarizeSales(within(mine, priorRange));
  const fineTotal = totalFines(monthFines);
  const productivity = shiftProductivity(
    [master],
    nowSales,
    within(data.attendance.filter((row) => belongsToMaster(row, master)), monthRange),
  )[0];
  const history = monthlySeries({ sales: mine, fines: myFines, today: TODAY, months: 6 }).reverse();
  // Every tile compares the same finished days, so that is said once in the
  // header rather than under each figure.
  const versus = (current, previous) => (
    priorRange ? { ...comparisonToPrevious(current, previous, priorRange, money, { inProgress }), hint: null } : {}
  );

  return (
    <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
      <div
        aria-label={`Мастер ${master.name}`}
        aria-modal="true"
        className="card master-sheet"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="master-sheet-head">
          <div>
            <strong>{master.name}</strong>
            <small>
              {monthName(monthRange.from)} · {Number(master.pct) || 40}% мастеру
              {priorRange
                ? inProgress
                  ? ` · сравнение ${comparisonLabel(priorRange, TODAY)}`
                  : ` · сравнение ${shortRange(compareRange)} с ${shortRange(priorRange)}`
                : ''}
            </small>
          </div>
          <button aria-label="Закрыть" className="sheet-close" type="button" onClick={onClose}>×</button>
        </div>
        <div className="tiles sheet-tiles">
          <Tile label="Выручка" value={money(now.revenue)} tone="total" {...versus(compare.revenue, before.revenue)} />
          <Tile label="К выплате" value={money(payFor(monthRange))} {...versus(payFor(compareRange), payFor(priorRange))} />
          <Tile label="Клиентов" value={now.clients} {...versus(compare.clients, before.clients)} />
          <Tile label="Средний чек" value={averageCheck(now.revenue, now.clients)} {...versus(compare.averageCheck, before.averageCheck)} />
          <Tile label="Новые" value={now.newClients} {...versus(compare.newClients, before.newClients)} />
          <Tile label="Постоянные" value={now.returningClients} {...versus(compare.returningClients, before.returningClients)} />
          <Tile
            label="Штрафы"
            value={fineTotal ? `−${money(fineTotal)}` : '0'}
            danger={Boolean(fineTotal)}
            hint={monthFines.length ? `${monthFines.length} ${pluralRu(monthFines.length, 'штраф', 'штрафа', 'штрафов')}` : 'в этом месяце нет'}
          />
          {productivity?.reliable ? (
            <Tile label="Выручка за смену" value={money(productivity.revenuePerShift)} hint={`${productivity.shifts} ${pluralRu(productivity.shifts, 'смена', 'смены', 'смен')}`} />
          ) : null}
        </div>
        {/* The payout already has the fines taken out; this is what they were. */}
        {monthFines.length ? (
          <>
            <h2 className="master-sheet-subtitle">Штрафы за {monthName(monthRange.from)}</h2>
            <Rows
              rows={monthFines}
              empty=""
              render={(fine) => (
                <div className="row" key={fine.id}>
                  <div>
                    <strong>{fineReasonLabel(fine.reason)}</strong>
                    <span>{displayDate(rowDate(fine))}</span>
                  </div>
                  <strong className="danger">−{money(fine.amount)}</strong>
                </div>
              )}
            />
          </>
        ) : null}
        <h2 className="master-sheet-subtitle">По месяцам</h2>
        <div className="table-scroll">
          <table className="master-history">
            <thead>
              <tr><th>Месяц</th><th>Выручка</th><th>Клиенты</th><th>Новые</th><th>Штрафы</th></tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.key}>
                  <td>{monthName(row.from, { month: 'short', year: '2-digit' })}{row.isCurrent ? ' ·' : ''}</td>
                  <td>{money(row.revenue)}</td>
                  <td>{row.clients}</td>
                  <td>{row.labelledClients ? row.newClients : '—'}</td>
                  <td className={row.fines ? 'danger' : ''}>{row.fines ? `−${money(row.fines)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function OverviewView({ data, reload, setError, setView }) {
  const [openMaster, setOpenMaster] = useState(null);
  const closeMaster = useCallback(() => setOpenMaster(null), []);
  const { run, busy } = useAction(setError);
  const canEditGoal = ['owner', 'admin'].includes(data.appRole);
  const goal = Number(data.settings.monthly_revenue_goal) || null;

  function saveGoal(value) {
    return run(
      () => callLegacyApi('setSettings', { monthly_revenue_goal: value }).then(reload),
    );
  }
  const monthRange = currentMonthRange();
  // The figures are the month so far; their comparisons use finished days only,
  // against the same days of the last month (see comparisonRanges).
  const {
    current: compareRange,
    previous: priorMonthRange,
    inProgress: monthInProgress,
  } = comparisonRanges(monthRange, 'month', TODAY);
  // Not yesterday: a Thursday is compared with the previous Thursday, because a
  // barbershop's week has a shape and a Wednesday is a different kind of day.
  const lastWeekSameDay = sameWeekdayLastWeek(TODAY);

  const countedSales = data.sales.filter(isCountedSale);
  const within = (rows, range, key = 'd') => (
    range ? rows.filter((row) => inRange(rowDate(row, key), range.from, range.to)) : []
  );
  // Revenue less master pay less operating expenses — the same chain for the
  // headline and for every window it is compared across.
  const profitFor = (range) => {
    const sales = within(countedSales, range);
    return totalSalesAmount(sales)
      - masterPayoutForPeriod(data.masters, sales, within(data.fines, range))
      - totalExpenses(operatingExpenses(within(data.expenses, range, 'date')));
  };

  const todaySales = countedSales.filter((sale) => rowDate(sale) === TODAY);
  const lastWeekSales = countedSales.filter((sale) => rowDate(sale) === lastWeekSameDay);
  const monthSales = within(countedSales, monthRange);
  const compareSales = within(countedSales, compareRange);
  const priorSales = within(countedSales, priorMonthRange);

  const todayRevenue = totalSalesAmount(todaySales);
  const monthRevenue = totalSalesAmount(monthSales);
  const netProfit = profitFor(monthRange);

  const monthMix = summarizeSales(monthSales);
  const compareMix = summarizeSales(compareSales);
  const priorMix = summarizeSales(priorSales);
  const pendingSales = getPendingSales(data.sales);

  // The month tiles all compare against the same days, named once under them.
  const versusPriorMonth = (current, previous) => (
    priorMonthRange
      ? { ...comparisonToPrevious(current, previous, priorMonthRange, money, { inProgress: monthInProgress }), hint: null }
      : {}
  );
  const profitVersusPriorMonth = versusPriorMonth(profitFor(compareRange), priorMonthRange ? profitFor(priorMonthRange) : 0);
  const forecast = monthForecast(countedSales, TODAY);
  const signals = attentionSignals({ sales: countedSales, masters: data.masters, today: TODAY });
  const series = monthlySeries({
    sales: countedSales,
    fines: data.fines,
    expenses: data.expenses,
    masters: data.masters,
    today: TODAY,
    months: 12,
  });
  const masterRows = mastersForPeriod(data.masters, [...monthSales, ...priorSales])
    .map((master) => {
      const mine = (rows) => rows.filter((sale) => belongsToMaster(sale, master));
      const rows = mine(monthSales);
      return {
        master,
        revenue: totalSalesAmount(rows),
        compareRevenue: totalSalesAmount(mine(compareSales)),
        previousRevenue: totalSalesAmount(mine(priorSales)),
        summary: summarizeSales(rows),
      };
    })
    .sort((left, right) => right.revenue - left.revenue);

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
              money,
              { inProgress: true },
            )}
          />
          <Tile
            label="Выручка за месяц"
            value={`${money(monthRevenue)} сум`}
            {...versusPriorMonth(compareMix.revenue, priorMix.revenue)}
          />
          <Tile
            label="Средний чек"
            value={averageCheck(monthRevenue, monthMix.clients)}
            {...versusPriorMonth(compareMix.averageCheck, priorMix.averageCheck)}
          />
          <Tile
            label="Клиентов за месяц"
            value={monthMix.clients}
            {...versusPriorMonth(compareMix.clients, priorMix.clients)}
          />
          <Tile
            label="Новые клиенты"
            value={monthMix.newClients}
            {...versusPriorMonth(compareMix.newClients, priorMix.newClients)}
          />
          <Tile
            label="Постоянные клиенты"
            value={shareText(monthMix.returningShare)}
            {...(priorMonthRange ? shareComparison(compareMix.returningShare, priorMix.returningShare, priorMonthRange) : {})}
            hint={monthMix.labelledClients ? `${monthMix.returningClients} из ${monthMix.labelledClients} клиентов` : null}
          />
        </div>
        {priorMonthRange ? (
          <p className="hint overview-compare-note">
            {monthInProgress
              ? `Сравнение ${comparisonLabel(priorMonthRange, TODAY)}`
              : `Сравнение по законченным дням: ${shortRange(compareRange)} против ${shortRange(priorMonthRange)}`}
          </p>
        ) : null}
      </div>

      <ForecastCard
        forecast={forecast}
        monthRevenue={monthRevenue}
        goal={goal}
        canEdit={canEditGoal}
        busy={busy}
        onSaveGoal={saveGoal}
      />
      <SignalsCard result={signals} />
      <MastersOfMonth rows={masterRows} comparisonRange={priorMonthRange} inProgress={monthInProgress} onOpen={setOpenMaster} />
      <MonthlyTrend series={series} forecast={forecast} />
      {openMaster ? <MasterSheet data={data} master={openMaster} onClose={closeMaster} /> : null}
    </section>
  );
}

function MasterView({ data, reload, setError }) {
  const [selectedMaster, setSelectedMaster] = useState(data.me || data.activeMasters[0]?.name || '');
  const [payType, setPayType] = useState(null);
  const [amount, setAmount] = useState('');
  const [split, setSplit] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState({ cash: '', card: '', qr: '' });
  const [clientCount, setClientCount] = useState(1);
  const [isNewClient, setIsNewClient] = useState(null);
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('master', 'day');
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
  const shiftStart = shiftStartFor(
    masterProfile,
    TODAY,
    data.scheduleRules,
    data.settings.shift_start || '09:00',
  );

  useEffect(() => {
    if (!masterName && data.activeMasters[0]?.name) setSelectedMaster(data.activeMasters[0].name);
  }, [data.activeMasters, masterName]);

  async function submitSale(event) {
    event.preventDefault();
    setError('');
    setMessage('');

    const amounts = split
      ? {
          cash: Number(splitAmounts.cash) || 0,
          card: Number(splitAmounts.card) || 0,
          qr: Number(splitAmounts.qr) || 0,
        }
      : { cash: 0, card: 0, qr: 0, ...(payType ? { [payType]: Number(amount) || 0 } : {}) };
    if (!split && !payType) return setError('Выберите способ оплаты.');
    if (amounts.cash + amounts.card + amounts.qr <= 0) {
      return setError(split ? 'Введите сумму хотя бы для одного способа оплаты.' : 'Введите сумму продажи.');
    }
    if (!masterName) return setError('Сначала выберите мастера.');
    if (clientCount > 0 && isNewClient == null) return setError('Отметьте, клиент новый или постоянный.');

    const payload = {
      master: masterName,
      d: TODAY,
      ...amounts,
      cl: clientCount,
      clients_count: clientCount,
      is_new_client: clientCount === 0 ? null : isNewClient,
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
    setSplit(false);
    setSplitAmounts({ cash: '', card: '', qr: '' });
    setClientCount(1);
    setIsNewClient(null);
  }

  // Switching carries the amount already typed across, so opening the split
  // halfway through does not make the master type it again.
  function toggleSplit() {
    if (!split) {
      setSplitAmounts({ cash: '', card: '', qr: '', ...(payType && amount ? { [payType]: amount } : {}) });
      setSplit(true);
      return;
    }
    const filled = PAYMENT_METHODS.filter(([key]) => Number(splitAmounts[key]) > 0);
    if (filled.length === 1) {
      setPayType(filled[0][0]);
      setAmount(splitAmounts[filled[0][0]]);
    }
    setSplit(false);
  }

  const splitTotal = PAYMENT_METHODS.reduce((sum, [key]) => sum + (Number(splitAmounts[key]) || 0), 0);

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
        {split ? (
          <div className="split-amounts">
            {PAYMENT_METHODS.map(([key, label]) => (
              <label className={`split-amount ${key}`} key={key}>
                <span><i className="payment-dot" aria-hidden="true" />{label}</span>
                <MoneyInput
                  aria-label={`${label}, сумма`}
                  placeholder="0"
                  value={splitAmounts[key]}
                  onChange={(value) => setSplitAmounts((current) => ({ ...current, [key]: value }))}
                />
              </label>
            ))}
            <p className="split-total">Одна продажа на <strong>{money(splitTotal)} сум</strong></p>
          </div>
        ) : (
          <>
            <div className="pay-types">
              {PAYMENT_METHODS.map(([value, label]) => (
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
          </>
        )}
        <button className="split-toggle" type="button" onClick={toggleSplit}>
          {split ? 'Одним способом' : 'Разделить оплату'}
        </button>
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
                <span>{paymentLabel(sale)} · клиентов {clients(sale)} · {clientType(sale)}</span>
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
        {/* The tile above gave a master the total and nothing else, so "за что
            эти 150 тысяч" was settled from someone's memory. His own rows were
            already loaded for him; they were simply never shown. */}
        {visibleFines.length ? (
          <details className="master-fines">
            <summary>За что штрафы<span>{visibleFines.length}</span></summary>
            <Rows
              rows={[...visibleFines].sort(newestFirst)}
              empty="Штрафов за период нет."
              render={(fine) => (
                <div className="row" key={fine.id}>
                  <div>
                    <strong>−{money(fine.amount)} сум</strong>
                    <span>{displayDate(rowDate(fine))} · {fineReasonLabel(fine.reason)}</span>
                  </div>
                </div>
              )}
            />
          </details>
        ) : null}
      </div>
    </section>
  );
}

function AdminView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('money', 'month');
  const [message, setMessage] = useState('');
  const [masterSort, setMasterSort] = useState({ key: 'revenue', direction: 'desc' });
  const [detailLimit, setDetailLimit] = useState(50);
  const [salesListOpen, setSalesListOpen] = useState(false);
  const [openMaster, setOpenMaster] = useState(null);
  const closeMaster = useCallback(() => setOpenMaster(null), []);
  const { run, busy } = useAction(setError, setMessage);
  const range = getRange(period, customFrom, customTo, data.sales);
  // The figures cover the whole period; their comparisons use its finished
  // days against the same days before it (see comparisonRanges).
  const { current: compareRange, previous: priorRange, inProgress } = comparisonRanges(range, period, TODAY);
  const pendingSales = getPendingSales(data.sales);
  const countedIn = (from, to) => data.sales.filter(
    (sale) => isCountedSale(sale) && inRange(rowDate(sale), from, to),
  );
  const finesIn = (from, to) => data.fines.filter((fine) => inRange(rowDate(fine), from, to));
  const sales = countedIn(range.from, range.to);
  const fines = finesIn(range.from, range.to);
  const compareSales = countedIn(compareRange.from, compareRange.to);
  const compareFines = finesIn(compareRange.from, compareRange.to);
  const previousSales = priorRange ? countedIn(priorRange.from, priorRange.to) : [];
  const previousFines = priorRange ? finesIn(priorRange.from, priorRange.to) : [];
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
    const mine = (rows) => rows.filter((row) => belongsToMaster(row, master));
    const payOf = (saleRows, fineRows) => masterNetPay(grossMasterPayForSales(mine(saleRows), master), totalFines(mine(fineRows)));
    const rows = mine(sales);
    return {
      master,
      rows,
      revenue: totalSalesAmount(rows),
      pay: payOf(sales, fines),
      compareRevenue: totalSalesAmount(mine(compareSales)),
      comparePay: payOf(compareSales, compareFines),
      previousRevenue: totalSalesAmount(mine(previousSales)),
      previousPay: payOf(previousSales, previousFines),
      clientMix: clientBreakdown(rows),
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
  const compareSummary = summarizeSales(compareSales);
  const previousSummary = summarizeSales(previousSales);
  // Today against the whole of yesterday is a race the morning always loses.
  const comparison = (current, previous) => (
    priorRange ? comparisonToPrevious(current, previous, priorRange, money, { inProgress }) : {}
  );
  const pendingTotal = pendingSales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const pendingMix = paymentMix(pendingSales);
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
      {/* An empty queue used to keep its card and a sentence saying it was
          empty. It now leaves, like the reminder on Обзор does. */}
      {pendingSales.length || message ? (
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
        {/* Card and QR money can be checked against the bank the moment it
            lands; cash only once the till is counted. The total is split the
            same way, so neither has to be picked out of the list by eye. */}
        {pendingSales.length > 1 ? (
          <div className="pending-mix" aria-label="Сумма на подтверждение по способам оплаты">
            {PAYMENT_METHODS.filter(([key]) => pendingMix[key] > 0).map(([key, label]) => (
              <span className={`pending-mix-item ${key}`} key={key}>
                <i className="payment-dot" aria-hidden="true" />
                {label}
                <strong>{money(pendingMix[key])}</strong>
              </span>
            ))}
          </div>
        ) : null}
        <Rows
          rows={[...pendingSales].sort(newestFirst)}
          empty="Новых оплат от мастеров на подтверждение нет."
          render={(sale) => (
            <div className="row approval-row" key={sale.id}>
              <div>
                <strong>{sale.master} · {money(saleTotal(sale))} сум</strong>
                <PaymentChips sale={sale} />
                <span>
                  {rowDate(sale)} · клиентов {clients(sale)} · {clientType(sale)}
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
      ) : null}

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
          <Tile label="Выручка" value={money(revenue)} {...comparison(compareSummary.revenue, previousSummary.revenue)} tone="total" />
          <Tile label="Клиентов" value={totalClients} {...comparison(compareSummary.clients, previousSummary.clients)} />
          <Tile label="Новые" value={newClients} {...comparison(compareSummary.newClients, previousSummary.newClients)} />
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
        {priorRange ? (
          <p className="master-comparison-range">
            {inProgress
              ? `Сравнение ${comparisonLabel(priorRange, TODAY)}`
              : `Сравнение по законченным дням: ${shortRange(compareRange)} против ${shortRange(priorRange)}`}
          </p>
        ) : null}
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
              {sortedMasterSummaries.map(({ master, revenue: masterRevenue, pay, compareRevenue, comparePay, previousRevenue: masterPreviousRevenue, previousPay, clientMix }) => (
                <tr className={master.name === topMasterName ? 'master-top-row' : ''} key={master.name}>
                  <td>
                    <div className="master-name-line">
                      <button className="master-name-button" type="button" onClick={() => setOpenMaster(master)}>
                        <strong>{master.name}</strong>
                      </button>
                      {master.name === topMasterName ? <span className="master-top-mark" aria-label="Лидер по выручке" title="Лидер по выручке">★</span> : null}
                    </div>
                    <small>
                      {clientMix.clients} клиентов
                      {clientMix.unlabeled ? ` · тип не указан: ${clientMix.unlabeled}` : ''}
                    </small>
                    {/* The split is repeated here on purpose: on a phone the
                        table shows the name and the revenue without scrolling,
                        and the columns further right carry the sort and the
                        comparison. Its own line, or the name column grows to
                        fit it and pushes the revenue off the screen. */}
                    {clientMix.clients ? (
                      <small>новых {clientMix.newClients} · постоянных {clientMix.returningClients}</small>
                    ) : null}
                    {/* Revenue alone cannot tell working more from earning
                        more. The shift count is what separates them — but only
                        when the check-ins actually cover the days he sold on. */}
                    <small className="master-shift-line">
                      {(() => {
                        const stats = productivityByMaster[String(master.id)];
                        if (!stats?.shifts) return 'нет отметок о приходе';
                        const shiftLabel = `${stats.shifts} ${pluralRu(stats.shifts, 'смена', 'смены', 'смен')}`;
                        return stats.reliable
                          ? `${shiftLabel} · ${money(stats.revenuePerShift)} за смену`
                          : `${shiftLabel} · продажи за ${stats.saleDays} ${pluralRu(stats.saleDays, 'день', 'дня', 'дней')} — отметок не хватает`;
                      })()}
                    </small>
                  </td>
                  <td>
                    <span className="master-metric-value">{money(masterRevenue)} сум</span>
                    {priorRange ? <MasterMetricComparison current={compareRevenue} previous={masterPreviousRevenue} inProgress={inProgress} /> : null}
                  </td>
                  <td>
                    <strong className="master-metric-value">{money(pay)} сум</strong>
                    {priorRange ? <MasterMetricComparison current={comparePay} previous={previousPay} inProgress={inProgress} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="payout-total"><span>Итого выплатить мастерам</span><strong>{money(totalMasterPayout)} сум</strong></div>
      </div>

      {/* Every sale of the month, one per row, used to sit open under the
          totals — five hundred rows to scroll past. It is there when a single
          sale has to be found or deleted, and folded away otherwise. */}
      <div className="card wide detailed-report-card">
        <button
          aria-expanded={salesListOpen}
          className="overview-more detailed-report-toggle"
          type="button"
          onClick={() => setSalesListOpen((open) => !open)}
        >
          {salesListOpen ? 'Свернуть список продаж' : `Все продажи за период · ${sales.length}`}
        </button>
        {salesListOpen ? (
        <>
        <SectionHeading label="Все продажи" range={range} />
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
            const payment = paymentLabel(sale);
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
        </>
        ) : null}
      </div>
      {openMaster ? <MasterSheet data={data} master={openMaster} onClose={closeMaster} /> : null}
    </section>
  );
}

function AttendanceView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('attendance', 'day');
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
  const lateness = latenessSummary(data.masters, filteredAttendance, filteredFines, shiftStart, data.scheduleRules)
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
    if (enabled && !await confirmAction(`Отметить ${master} как выходного за ${displayDate(date)}?`)) return;
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
            <p className="hint">Смена засчитывается по отметке о приходе. Опоздание — от начала смены мастера по графику, но не раньше {shiftStart}.</p>
          </details>
        ) : null}
        <div className="attendance-list">
          {attendanceRows.length ? attendanceRows.map((item) => {
            const masterRecord = data.masters.find((master) => master.name === item.master);
            const dayOff = data.dayStatuses.some((day) => (
              String(day.master_id) === String(masterRecord?.id) && day.work_date === rowDate(item)
            ));
            const arrived = displayTime(item.arrived || item.arrived_at);
            const rowShiftStart = shiftStartFor(masterRecord, rowDate(item), data.scheduleRules, shiftStart);
            const lateBy = arrived ? minutesLate(arrived, rowShiftStart) : 0;
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
                      ? 'выходной'
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
          <p className="hint">Общий порог опоздания. У мастера, чья смена по графику начинается позже, опоздание считается от его смены.</p>
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

function FinanceView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('money', 'month');
  const [tab, setTab] = useState('ishxona');
  const [form, setForm] = useState({ date: TODAY, section: 'ishxona', name: '', qty: '', amount_uzs: '', usd_rate: localStorage.getItem('usdRate') || '12200', minus_from: '' });
  const [offsetForm, setOffsetForm] = useState({ date: TODAY, owner: 'jamshid', amount_usd: '500', usd_rate: localStorage.getItem('usdRate') || '12200', note: '' });
  const [message, setMessage] = useState('');
  const [offsetsOpen, setOffsetsOpen] = useState(false);
  const { run, busy } = useAction(setError, setMessage);
  const financeRows = [...data.sales, ...data.expenses];
  const range = getRange(period, customFrom, customTo, financeRows);
  const { current: compareRange, previous: priorRange, inProgress } = comparisonRanges(range, period, TODAY);
  const expensesIn = (window) => data.expenses.filter((expense) => inRange(rowDate(expense, 'date'), window.from, window.to));
  const expenses = expensesIn(range);
  const previousExpenses = priorRange ? data.expenses.filter(
    (expense) => inRange(rowDate(expense, 'date'), priorRange.from, priorRange.to),
  ) : [];
  const ishxonaExpenses = totalExpenses(operatingExpenses(expenses));
  const previousIshxonaExpenses = totalExpenses(operatingExpenses(previousExpenses));
  const offsetIncome = rentOffsetIncome(expenses);
  const comparison = (current, previous) => (
    priorRange ? comparisonToPrevious(current, previous, priorRange, money, { inProgress }) : {}
  );
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
          <Tile label="Расходы" value={money(ishxonaExpenses)} {...comparison(totalExpenses(operatingExpenses(expensesIn(compareRange))), previousIshxonaExpenses)} danger />
          {offsetIncome ? <Tile label="Безденежный доход" value={money(offsetIncome)} hint="касса не меняется" /> : null}
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

      {data.appRole === 'owner' ? <DeletionLog setError={setError} /> : null}
    </section>
  );
}

// The ledger, the RPCs and the listAuditEvents action were all built and the
// app never called them, so "кто это удалил" had no answer anywhere.
const AUDIT_ENTITY_LABELS = {
  fine: 'Штраф',
  expense: 'Расход',
  debt: 'Долг',
  debt_payment: 'Платёж по долгу',
  sale: 'Продажа',
  attendance: 'Отметка о приходе',
};

function auditRowSummary(event) {
  const values = event.old_values || {};
  const amount = values.amount ?? values.amount_uzs
    ?? ((Number(values.cash) || 0) + (Number(values.card) || 0) + (Number(values.qr) || 0) || null);
  const parts = [];
  if (values.master || values.counterparty || values.name) parts.push(values.master || values.counterparty || values.name);
  if (amount) parts.push(`${money(amount)} сум`);
  const day = values.d || values.date || values.work_date;
  if (day) parts.push(`за ${displayDate(day)}`);
  return parts.join(' · ') || `запись #${event.entity_id}`;
}

function DeletionLog({ setError }) {
  const [events, setEvents] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const { run, busy } = useAction(setError);

  async function loadPage(nextCursor = null) {
    await run(async () => {
      const result = await callLegacyApi('listAuditEvents', nextCursor ? { cursor: nextCursor, limit: 25 } : { limit: 25 });
      setEvents((current) => (nextCursor ? [...current, ...(result.events || [])] : (result.events || [])));
      setCursor(result.nextCursor || null);
      setLoaded(true);
    });
  }

  return (
    <details
      className="card wide deletion-log"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open && !loaded && !busy) loadPage();
      }}
    >
      <summary>Журнал удалений<span>кто и что удалил</span></summary>
      {busy && !loaded ? <p className="hint">Загружаем журнал…</p> : null}
      {loaded ? (
        <Rows
          rows={events}
          empty="Удалений пока не было."
          render={(event) => (
            <div className="row" key={event.id}>
              <div>
                <strong>{AUDIT_ENTITY_LABELS[event.entity_type] || event.entity_type}: {auditRowSummary(event)}</strong>
                <span>{displayDateTime(event.occurred_at)}</span>
                <span>Удалил: {event.actor_name || 'неизвестно'}{event.actor_role ? ` (${event.actor_role})` : ''}</span>
              </div>
            </div>
          )}
        />
      ) : null}
      {cursor ? (
        <button className="btn ghost" type="button" disabled={busy} onClick={() => loadPage(cursor)}>
          {busy ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
      <p className="hint">Записи журнала нельзя изменить или удалить — он только пополняется.</p>
    </details>
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
// Grouped so a phone shows three tabs instead of six; the second row appears
// only for a group that actually holds more than one screen. The calendar and
// the client CRM were removed in September 2026: 2 appointments in a month
// against 571 sales, and a client list nobody had opened. Their tables and
// server actions are untouched.
const VIEW_GROUPS = [
  { id: 'overview', label: 'Обзор', views: ['overview'] },
  { id: 'money', label: 'Деньги', views: ['admin', 'finance'] },
  { id: 'people', label: 'Люди', views: ['attendance', 'master'] },
];

// Inside a group the shorter name is unambiguous — "Продажи" under "Деньги"
// says as much as "Управление салоном" did, in a third of the width.
const VIEW_TAB_LABELS = {
  overview: 'Обзор',
  admin: 'Продажи',
  finance: 'Расходы',
  attendance: 'Посещаемость',
  master: 'Мастера',
};

function viewIdsForUser(data) {
  if (data.role === 'admin') {
    const canSeeOverview = ['owner', 'admin'].includes(data.appRole);
    return [
      ...(canSeeOverview ? ['overview'] : []),
      'admin',
      'attendance',
      'finance',
      'master',
    ];
  }
  if (data.role === 'master') return ['master'];
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
    // Background polls stay silent: a toast every 15 seconds said nothing the
    // numbers updating on their own did not already say.
    if (!preserveView) setIsLoading(true);

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
  // A group is only offered if the role can reach something inside it, so a
  // role never sees an empty tab.
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
      <CurrentView data={data} reload={load} setError={setError} setView={setView} />
    </main>
  );
}
