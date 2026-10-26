import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  callLegacyApi,
  captureTelegramOAuthCode,
  captureTelegramRedirectAuth,
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
  attendanceGrid,
  attendanceTotals,
  belongsToMaster,
  clientBreakdown,
  comparisonRanges,
  firstDayOf,
  inRange,
  masterPayoutForPeriod,
  mastersForPeriod,
  lateRuleFromSettings,
  minutesLate,
  scheduleRulesOn,
  scheduleSummary,
  scheduleVersions,
  scheduledStartOn,
  shiftStartFor,
  paymentMix,
  percentageDifference,
  shiftDate,
  previousRange,
  shiftProductivity,
  startedAfter,
} from './utils/reporting.js';
import {
  localDate,
  mergeWindowedData,
  pollWindowStart,
  refreshWindowFor,
  rowDate,
} from './utils/loadWindow.js';
import { pluralRu } from './utils/plural.js';
import { applyLanguage, registerData, registerNames, tr } from './i18n/index.js';
import { masterWeek, weekOf, weekPayouts, weekStartOf } from './utils/payouts.js';
import { checkClientName, checkLastName, NAME_PART_MAX } from '../supabase/functions/_shared/clientName.js';
import { scannedAgo } from '../supabase/functions/_shared/mirror.js';
import {
  blockPosition,
  canRecordVisit,
  clientBadge,
  dayFrame,
  isControlledBooking,
  isOpenBooking,
  isOverdueBooking,
  masterHoursOn,
  minutesLabel,
  tashkentParts,
  unclosedByMaster,
  visibleBookings,
} from './utils/bookings.js';
import {
  goodsPaymentMix,
  normalizeProductSearch,
  pendingProductSales,
  productIncome,
  productMatches,
  productSaleMargin,
  productSalesSummary,
  productsByRecentUse,
  stockLevels,
} from './utils/stock.js';
import { comparisonLabel, sameWeekdayLastWeek } from './utils/periods.js';
import {
  addDaysIso,
  differenceHash,
  dutyMasterName,
  greyFromRgba,
  HASH_HEIGHT,
  HASH_WIDTH,
  mondayOf,
  currentWindow,
  masterDutyAttention,
  myDuty,
  nextWindow,
  openWindow,
  photoUntil,
  rosterChanges,
  rosterOn,
  swapCandidates,
  weekDays,
  windowsDone,
  windowStatus,
  worksOn,
} from './utils/duty.js';
import { dutyDateLabel, dutyDayLabel } from '../supabase/functions/_shared/duty.js';
import {
  attentionSignals,
  compactMoney,
  monthForecast,
  monthlySeries,
  monthsSince,
  returningShare,
  summarizeSales,
} from './utils/insights.js';

const TODAY = localDate();


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

// Everything that waits for the owner, in one queue: a master's haircut and a
// product the administrator sold. Goods are decided by the owner alone, so
// nobody else is shown them.
function approvalQueue(data) {
  const services = getPendingSales(data.sales);
  const goods = data.appRole === 'owner' ? pendingProductSales(data.productSales) : [];
  const serviceMix = paymentMix(services);
  const goodsMix = goodsPaymentMix(goods);
  const mix = {
    cash: serviceMix.cash + goodsMix.cash,
    card: serviceMix.card + goodsMix.card,
    qr: serviceMix.qr + goodsMix.qr,
  };
  const items = [
    ...services.map((sale) => ({ kind: 'service', key: `service-${sale.id}`, sale, stamp: `${rowDate(sale)}T${sale.created_at || ''}` })),
    ...goods.map((sale) => ({ kind: 'goods', key: `goods-${sale.id}`, sale, stamp: `${sale.sale_date}T${sale.created_at || ''}` })),
  ].sort((left, right) => right.stamp.localeCompare(left.stamp));
  return {
    services,
    goods,
    items,
    count: items.length,
    mix,
    total: mix.cash + mix.card + mix.qr,
  };
}

// A product sale has one payment method; the chips expect a sale's three sums.
function goodsAsPayment(sale) {
  return {
    cash: sale.payment_method === 'cash' ? sale.amount : 0,
    card: sale.payment_method === 'card' ? sale.amount : 0,
    qr: sale.payment_method === 'qr' ? sale.amount : 0,
  };
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
const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS);

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
        <span className={`pay-chip is-${part.key}`} key={part.key}>
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
  invalid_late_grace: 'Допуск — целое число минут от 0 до 120.',
  invalid_receipt: 'Проверьте приход: товар, количество, цена и дата.',
  receipt_amount_too_large: 'Сумма прихода слишком большая — похоже, лишний ноль.',
  invalid_product_sale: 'Проверьте продажу: товар, количество и сумма.',
  invalid_writeoff: 'Проверьте списание: товар, количество и причина.',
  not_enough_stock: 'На складе нет столько товара — обновите экран или внесите приход.',
  product_not_found: 'Такого товара нет — обновите экран.',
  product_sale_not_found: 'Эта продажа уже удалена — обновите экран.',
  stock_entry_not_found: 'Запись уже удалена — обновите экран.',
  stock_entry_delete_window_expired: 'Запись старше двух дней удалить нельзя.',
  receipt_already_sold: 'Часть этого прихода уже продана или списана — удалить его нельзя.',
  product_still_in_stock: 'Товар ещё есть на складе — сначала продайте или спишите остаток.',
  product_name_taken: 'Такой товар уже есть — выберите его из списка.',
  expense_belongs_to_stock: 'Это закупка товара — удалите её в «Складе», вместе с приходом.',
  invalid_schedule: 'Проверьте график: у каждого рабочего дня конец позже начала.',
  schedule_needs_work_day: 'Отметьте хотя бы один рабочий день. Отпуск ставьте выходными в «Команде».',
  schedule_date_out_of_range: 'Дату можно выбрать не раньше чем два месяца назад и не позже чем через год.',
  schedule_already_started: 'Этот график уже действует — его можно только заменить новым.',
  schedule_not_found: 'Этот график уже отменён — обновите экран.',
  not_in_list: 'Ваш доступ отключён. Обратитесь к владельцу.',
  invalid_fine: 'Проверьте сумму штрафа.',
  invalid_client_name: 'Введите имя клиента.',
  invalid_first_name: 'Введите имя клиента буквами.',
  invalid_last_name: 'Введите фамилию клиента буквами.',
  client_surname_required: 'Допишите фамилию клиента.',
  client_phone_required: 'Введите номер клиента.',
  guest_known_before_required: 'Отметьте, был ли клиент у нас раньше.',
  guest_with_booking: 'У визита по записи есть клиент — выберите его.',
  invalid_phone: 'Проверьте номер: например, 90 123 45 67.',
  invalid_merge: 'Эти карточки нельзя объединить.',
  client_not_found: 'Карточка не найдена — обновите экран.',
  slot_unavailable: 'Это время уже занято — выберите другое.',
  appointment_closed: 'Запись уже закрыта — обновите экран.',
  appointment_not_found: 'Запись не найдена — обновите экран.',
  invalid_advance: 'Проверьте сумму аванса.',
  invalid_payout: 'Проверьте сумму выплаты.',
  advance_week_paid: 'Эта неделя уже выплачена — аванс не изменить.',
  advance_not_found: 'Аванс уже удалён — обновите экран.',
  payout_not_found: 'Выплата уже удалена — обновите экран.',
  payout_delete_window_expired: 'Выплату старше трёх дней удалить нельзя.',
  duty_not_today: 'Сегодня дежурите не вы.',
  duty_no_window: 'Сейчас фото не нужно — дождитесь своего времени.',
  duty_photo_done: 'Фото за это время уже есть.',
  duty_photo_closed: 'Час для фото этого окна прошёл — ждите следующего окна.',
  duty_photo_old: 'Это старое фото. Сфотографируйте салон сейчас.',
  duty_photo_repeat: 'Это фото уже присылали. Сфотографируйте салон заново.',
  invalid_duty_photo: 'Не удалось прочитать фото. Попробуйте ещё раз.',
  duty_photo_unreadable: 'Не удалось прочитать фото. Попробуйте ещё раз.',
  duty_photo_upload_failed: 'Фото не загрузилось. Попробуйте ещё раз.',
  duty_not_yours: 'Этот день дежурите не вы.',
  duty_swap_too_late: 'Поздно: дежурство в этот день уже началось.',
  duty_swap_target: 'Выберите другого мастера.',
  duty_swap_closed: 'Эта просьба уже закрыта — обновите экран.',
  duty_swap_not_yours: 'Эта просьба не вам.',
  duty_swap_not_found: 'Просьба не найдена — обновите экран.',
  invalid_duty_swap: 'Не удалось отправить просьбу. Попробуйте ещё раз.',
  invalid_duty_roster: 'Проверьте график дежурств.',
  duty_day_out_of_range: 'Прошедшие дни дежурств не меняются.',
  invalid_duty_day: 'Фото дежурных хранятся 30 дней.',
  invalid_duty_zone: 'Такой зоны нет — обновите экран.',
};

function actionErrorText(error) {
  const code = String(error?.details?.error || error?.message || '');
  if (code === 'bookings_to_close') return unclosedText(error.details?.bookings);
  // The check found the zone dirty: what to fix, in its words.
  if (code === 'duty_photo_refused') return `Не принято: ${error.details?.reason || ''}`;
  if (ACTION_ERROR_TEXT[code]) return ACTION_ERROR_TEXT[code];
  if (code.startsWith('unauthorized')) return 'Сессия истекла. Откройте приложение через Telegram заново.';
  if (/Failed to fetch|NetworkError|network/i.test(code)) {
    return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  }
  return code ? `Не удалось выполнить: ${code}` : 'Не удалось выполнить действие.';
}

// A master with a booking that has ended and is still open records no other
// visit until he closes it (owner's decision of 2026-10-16).
function unclosedText(bookings = []) {
  const first = bookings[0];
  const which = first ? `: ${bookingTimeLine(first)} · ${first.client_name}` : '';
  return `Сначала закройте запись${which}. В «Мои записи» — «Пришёл» или «Не пришёл».`;
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

// What an action said used to land wherever its screen put it: at the top of
// a long page, at the foot of another card, under an open sheet. Out of sight,
// and the 15s poll wiped an error before anyone read it, so the next move was
// to tap again (owner's review of 2026-10-26). Every result now speaks from
// one place above the bottom bar; a screen only says what to show.
const NoticeContext = createContext(() => {});

function useNotice() {
  return useContext(NoticeContext);
}

// A sheet takes the keyboard and screen-reader focus when it opens (owner's
// review of 2026-10-26); it stayed on the button behind the dimmed page.
function useDialogFocus() {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return ref;
}

// Android's back button closed the whole app while a sheet was open, and a
// half-made booking with it (owner's review of 2026-10-26). Whatever is open
// on top registers how to close itself; Telegram's «Назад» takes one step.
const backHandlers = [];

function syncBackButton() {
  const button = window.Telegram?.WebApp?.BackButton;
  if (!button) return;
  try {
    if (backHandlers.length) button.show();
    else button.hide();
  } catch {
    // An old client without the button keeps its own behaviour.
  }
}

function goBackOneStep() {
  backHandlers[backHandlers.length - 1]?.current?.();
}

function useTelegramBack(onBack, active = true) {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!active) return undefined;
    backHandlers.push(handler);
    syncBackButton();
    return () => {
      const index = backHandlers.lastIndexOf(handler);
      if (index >= 0) backHandlers.splice(index, 1);
      syncBackButton();
    };
  }, [active]);
}

function AppNotice({ error, success, onClose }) {
  const text = error || success;
  if (!text) return null;
  return (
    <div className={`app-notice ${error ? 'is-error' : 'is-success'}`} role={error ? 'alert' : 'status'}>
      {error ? null : (
        <svg className="app-notice-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      )}
      <span>{text}</span>
      <button aria-label="Закрыть" type="button" onClick={onClose}>×</button>
    </div>
  );
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

// What the automatic fines write; not offered in the form.
const FINE_REASON_LABELS = {
  ...Object.fromEntries(FINE_REASONS.map((item) => [item.value, item.label])),
  no_mark: 'Нет отметки к 18:00',
  duty: 'Дежурство: нет фото',
};

// The automatic fines' amounts, decided by the owner on 2026-10-16.
function lateFineAmount(settings) {
  const amount = Number(settings?.late_fine_amount);
  return Number.isFinite(amount) && amount > 0 ? amount : 100000;
}

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
function confirmAction(text) {
  const question = tr(text);
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
    appointments: data.appointments || [],
    bookingServices: data.booking_services || [],
    products: data.products || [],
    productReceipts: data.product_receipts || [],
    productSales: data.product_sales || [],
    productWriteoffs: data.product_writeoffs || [],
    advances: data.master_advances || [],
    payouts: data.master_payouts || [],
    // Duty (owner's decisions of 2026-10-26): null until the server has it.
    duty: data.duty || null,
    lang: data.lang || null,
    settings,
  };
}

// Each person's language (owner's decision of 2026-10-16): what this phone
// chose last, else Telegram's own language; the server's answer wins on load.
const LANG_KEY = 'maestroLang';

function initialLanguage() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'ru' || stored === 'uz') return stored;
  } catch {
    // No storage: fall through to Telegram's language.
  }
  return window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code === 'uz' ? 'uz' : 'ru';
}

function rememberLanguage(lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // The server keeps it anyway.
  }
}

function emptyState() {
  return normalizeData({});
}

// A co-founder's account: every figure, no buttons. The server refuses his
// writes whatever the app shows (supabase/functions/_shared/access.js); this
// only keeps the app from offering them.
function isReadOnly(data) {
  return data.appRole === 'partner';
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

function MasterMetricComparison({ current, previous, format = money, inProgress = false, isNew = false }) {
  if (isNew) return <small className="master-period-change is-new">новый мастер</small>;
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

// A figure runs up to its value the first time the app shows one, and glides
// to a new value when the data refreshes. It used to run 0.9 s from zero on
// every visit to a tab, so a half-counted «18 645 051» was what the owner
// read (owner's review of 2026-10-26): once a session now, in 0.2 s, and
// from then on it opens at its value. Honors reduced motion.
let countUpPlayed = false;

function useCountUp(value, duration = 200) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(() => (countUpPlayed ? target : 0));
  const fromRef = useRef(countUpPlayed ? target : 0);
  useEffect(() => { countUpPlayed = true; }, []);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      fromRef.current = target;
      setShown(target);
      return undefined;
    }
    const from = fromRef.current;
    const start = performance.now();
    let frame;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = from + (target - from) * eased;
      fromRef.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Animation frames stop while a page is not being painted (a hidden
    // webview, a backgrounded tab). The figure must never be left stranded
    // part-way, so it is set to its value once the animation should be over.
    const settle = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      fromRef.current = target;
      setShown(target);
    }, duration + 120);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [target, duration]);

  return shown;
}

function CountUp({ value, format = money }) {
  return format(useCountUp(value));
}

// `invert` is for money going out: more spending is the bad direction.
function DeltaChip({ current, previous, inProgress, invert = false }) {
  if (!previous && !current) return null;
  if (!previous) return <span className="delta-chip flat">новое</span>;
  const change = percentageDifference(current, previous);
  if (inProgress && current <= previous) return null;
  const better = invert ? change < 0 : change > 0;
  const tone = change === 0 ? 'flat' : better ? 'up' : 'down';
  return <span className={`delta-chip ${tone}`}>{change > 0 ? '▲' : change < 0 ? '▼' : '•'} {Math.abs(change)}%</span>;
}

// «1–25 окт», «1 сен»: the days a comparison covers, as the hero names them.
function monthDaysLabel(range) {
  const from = Number(range.from.slice(8, 10));
  const to = Number(range.to.slice(8, 10));
  const month = MONTH_SHORT[Number(range.to.slice(5, 7)) - 1];
  return from === to ? `${from} ${month}` : `${from}–${to} ${month}`;
}

// The screen's one big card: the month's revenue, the months behind it, where
// the pace will end the month, and — when the owner has set one — the goal.
// The forecast only counts finished days; see monthForecast.
function RevenueHero({ monthRevenue, compare, compareRange, prior, priorRange, inProgress, series, forecast, goal, canEditGoal, onSetGoal }) {
  const months = series.slice(-6);
  const peak = Math.max(1, ...months.map((row) => row.revenue), forecast?.revenue || 0);
  const barValue = (value) => (value / 1_000_000).toFixed(1).replace('.', ',');
  const done = goal ? (monthRevenue / goal) * 100 : 0;
  const projected = goal && forecast ? (forecast.revenue / goal) * 100 : null;
  const gap = goal && forecast ? goal - forecast.revenue : null;
  const daysLeft = forecast ? forecast.daysInMonth - forecast.completedDays : 0;

  return (
    <div className="card wide hero-card revenue-hero">
      <div className="revenue-hero-top">
        <span>Выручка за {monthName(TODAY)}</span>
        {priorRange ? <DeltaChip current={compare} previous={prior} inProgress={inProgress} /> : null}
      </div>
      <div className="revenue-hero-value">
        <strong><CountUp value={monthRevenue} /></strong>
        <span>сум</span>
      </div>
      {/* The big figure runs to this minute, the percent compares finished
          days only; both sums of that comparison are named, so the figures on
          the card add up (owner's review of 2026-10-26). */}
      {priorRange ? (
        <span className="revenue-hero-note">
          {inProgress ? 'сегодня' : monthDaysLabel(compareRange)}: {compactMoney(compare)} · {monthDaysLabel(priorRange)}: {compactMoney(prior)}
        </span>
      ) : null}

      <div className="revenue-hero-bars" aria-label="Выручка по месяцам">
        {months.map((row) => {
          const ghost = row.isCurrent && forecast ? forecast.revenue : 0;
          return (
            <div className={`revenue-hero-bar ${row.isCurrent ? 'is-current' : ''}`} key={row.key}>
              <span className="revenue-hero-bar-value">{barValue(row.revenue)}</span>
              <span className="revenue-hero-bar-column">
                {ghost ? <i className="revenue-hero-bar-ghost" style={{ height: `${(ghost / peak) * 100}%` }} /> : null}
                <i className="revenue-hero-bar-fill" style={{ height: `${(row.revenue / peak) * 100}%` }} />
              </span>
              <span className="revenue-hero-bar-month">{MONTH_SHORT[Number(row.key.slice(5, 7)) - 1]}</span>
            </div>
          );
        })}
      </div>

      {forecast ? (
        <div className="revenue-hero-inset">
          <span>Прогноз на месяц</span>
          <strong>
            ≈ {compactMoney(forecast.revenue)}
            {forecast.revenueChange != null ? (
              <em className={forecast.revenueChange >= 0 ? 'up' : 'down'}>
                {' · '}{forecast.revenueChange > 0 ? '+' : ''}{forecast.revenueChange}%
              </em>
            ) : null}
            {forecast.revenueChange != null ? <small>{comparisonLabel(forecast.previous, TODAY)} целиком</small> : null}
          </strong>
        </div>
      ) : null}

      {goal ? (
        <div className="revenue-hero-goal">
          <div className="revenue-hero-goal-head">
            <span>Цель {compactMoney(goal)}</span>
            <strong>{Math.floor(done)}%</strong>
          </div>
          <div className="revenue-hero-goal-track" aria-hidden="true">
            <i className="revenue-hero-goal-fill" style={{ width: `${Math.min(100, done)}%` }} />
            {projected != null ? <i className="revenue-hero-goal-marker" style={{ left: `${Math.min(100, projected)}%` }} /> : null}
          </div>
          <span className="revenue-hero-note">
            {done >= 100
              ? `Цель выполнена${done > 100 ? `, сверху ${compactMoney(monthRevenue - goal)}` : ''}.`
              : gap == null
                ? `До цели ${compactMoney(goal - monthRevenue)}.`
                : gap > 0
                  ? `По темпу не хватит ≈ ${compactMoney(gap)} — нужно ≈ ${compactMoney((goal - monthRevenue) / Math.max(1, daysLeft))} в день.`
                  : `По темпу цель будет перевыполнена на ≈ ${compactMoney(-gap)}.`}
          </span>
        </div>
      ) : canEditGoal ? (
        <button className="revenue-hero-goal-link" type="button" onClick={onSetGoal}>+ Поставить цель на месяц</button>
      ) : null}
    </div>
  );
}

function TrendIcon({ tone }) {
  return tone === 'good' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 17l6-6 4 4 6-6" /><path d="M20 14V9h-5" /></svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7l6 6 4-4 6 6" /><path d="M20 10v5h-5" /></svg>
  );
}

function SignalsCard({ result }) {
  return (
    <div className="card wide signals-card">
      <h2>Что происходит</h2>
      {result.ready ? (
        <p className="hint signals-range">
          Законченные дни {shortRange(result.range)} против {shortRange(result.previousRange)}
        </p>
      ) : null}
      {!result.ready ? (
        <p className="hint">Сигналы появятся через несколько дней месяца — пока сравнивать не с чем.</p>
      ) : !result.signals.length ? (
        <p className="hint">Резких изменений нет: месяц идёт так же, как прошлый.</p>
      ) : (
        <ul className="signal-list">
          {result.signals.map((signal) => (
            <li className={`signal ${signal.tone}`} key={signal.title}>
              <span className="signal-icon"><TrendIcon tone={signal.tone} /></span>
              <span><strong>{signal.title}</strong><small>{signal.detail}</small></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A ranking, not a leaderboard game: place, revenue, change, and a thin bar
// showing how far each master is from the leader.
function MastersOfMonth({ rows, comparisonRange, inProgress, onOpen }) {
  const leaderRevenue = rows[0]?.revenue || 0;
  return (
    <div className="card wide masters-month-card">
      <div className="section-heading">
        <h2>Мастера месяца</h2>
      </div>
      <ol className="master-rank">
        {rows.map((row, index) => {
          const leader = index === 0 && row.revenue > 0;
          return (
            <li key={row.master.id ?? row.master.name}>
              <button type="button" onClick={() => onOpen(row.master)}>
                <span className={`master-rank-number ${leader ? 'is-leader' : ''}`}>{String(index + 1).padStart(2, '0')}</span>
                <span className="master-rank-name">
                  <strong>
                    {row.master.name}
                    {leader ? <b className="leader-tag">ЛИДЕР</b> : null}
                  </strong>
                  <small>
                    новых {row.summary.newClients} · постоянных {row.summary.returningClients}
                    {row.summary.clients > row.summary.labelledClients ? ` · без типа ${row.summary.clients - row.summary.labelledClients}` : ''}
                  </small>
                </span>
                <span className="master-rank-value">
                  <strong>{compactMoney(row.revenue)}</strong>
                  {comparisonRange ? (
                    <MasterMetricComparison current={row.compareRevenue} previous={row.previousRevenue} format={compactMoney} inProgress={inProgress} isNew={row.isNew} />
                  ) : null}
                </span>
                <span className="master-rank-bar" aria-hidden="true">
                  <i className={leader ? 'is-leader' : ''} style={{ width: `${leaderRevenue ? (row.revenue / leaderRevenue) * 100 : 0}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const TREND_METRICS = [
  { key: 'revenue', label: 'Выручка', unit: 'млн сум', bar: (value) => (value / 1_000_000).toFixed(1).replace('.', ','), full: (value) => `${money(value)} сум` },
  { key: 'profit', label: 'Прибыль', unit: 'млн сум', bar: (value) => (value / 1_000_000).toFixed(1).replace('.', ','), full: (value) => `${money(value)} сум` },
  { key: 'clients', label: 'Клиенты', unit: 'клиентов', bar: (value) => String(Math.round(value)), full: (value) => `${Math.round(value)} ${pluralRu(Math.round(value), 'клиент', 'клиента', 'клиентов')}` },
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
  useTelegramBack(onClose);
  const dialogRef = useDialogFocus();
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
  const { current: compareRange, previous: monthBefore, inProgress } = comparisonRanges(monthRange, 'month', TODAY);
  // A master who started after that window has nothing to be compared with.
  const firstDay = firstDayOf(master, data.sales, data.attendance);
  const isNew = startedAfter(firstDay, monthBefore);
  const priorRange = isNew ? null : monthBefore;
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
  // Every month since the master started, not a fixed window: a six-month
  // table hid the early months once their records were loaded.
  const history = monthlySeries({
    sales: mine,
    fines: myFines,
    today: TODAY,
    months: monthsSince(firstDay || TODAY, TODAY),
  }).reverse();
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
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
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
        <div className="hero-card revenue-hero master-hero">
          <div className="revenue-hero-top">
            <span>Выручка за {monthName(monthRange.from)}</span>
            {priorRange ? <DeltaChip current={compare.revenue} previous={before.revenue} inProgress={inProgress} /> : null}
            {isNew ? <span className="delta-chip flat">новый мастер</span> : null}
          </div>
          <div className="revenue-hero-value">
            <strong><CountUp value={now.revenue} /></strong>
            <span>сум</span>
          </div>
          {priorRange ? (
            <span className="revenue-hero-note">{comparisonLabel(priorRange, TODAY)} было {compactMoney(before.revenue)}</span>
          ) : null}
          {isNew && firstDay ? <span className="revenue-hero-note">работает с {shortRange({ from: firstDay, to: firstDay })}</span> : null}
          <div className="revenue-hero-inset">
            <span>Заработал</span>
            <strong>{money(payFor(monthRange))}</strong>
          </div>
        </div>
        <div className="tiles sheet-tiles">
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

// The booking page, day by day (owner's request of 2026-10-21): who opened
// it, who chose a time and went on to Telegram, who confirmed there. Nothing
// shows until the counter has a day to tell.
const SITE_ROWS = [
  ['visitors', 'Открыли сайт'],
  ['started', 'Выбрали время'],
  ['booked', 'Записались'],
];

function SiteCard() {
  const [days, setDays] = useState(null);
  useEffect(() => {
    let alive = true;
    callLegacyApi('siteStats', {})
      .then((result) => { if (alive) setDays(result?.days || []); })
      .catch(() => { if (alive) setDays([]); });
    return () => { alive = false; };
  }, []);
  if (!days || !days.some((day) => Number(day.visitors) || Number(day.started))) return null;
  const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const windows = [['Сегодня', days.slice(-1)], ['7 дней', days.slice(-7)], ['30 дней', days]];
  const visitors = sum(days, 'visitors');
  const booked = sum(days, 'booked');
  return (
    <div className="card wide site-card">
      <h2>Сайт записи</h2>
      <div className="site-table">
        <span />
        {windows.map(([label]) => <strong key={label}>{label}</strong>)}
        {SITE_ROWS.flatMap(([key, label]) => [
          <span key={key}>{label}</span>,
          ...windows.map(([window, rows]) => <b key={`${key}:${window}`}>{sum(rows, key)}</b>),
        ])}
      </div>
      {visitors ? (
        <p className="hint">{`За 30 дней записались ${Math.round((booked / visitors) * 100)}% открывших`}</p>
      ) : null}
    </div>
  );
}

// Обзор's cards rise in the first time it opens in a session, not on every
// visit to the tab (owner's review of 2026-10-26).
let overviewSeen = false;

function OverviewView({ data, reload, setError, setView }) {
  const [overviewEntering] = useState(() => !overviewSeen);
  useEffect(() => { overviewSeen = true; }, []);
  const [openMaster, setOpenMaster] = useState(null);
  const closeMaster = useCallback(() => setOpenMaster(null), []);
  const canEditGoal = ['owner', 'admin'].includes(data.appRole);
  const goal = Number(data.settings.monthly_revenue_goal) || null;
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
  // Revenue less master pay less operating expenses, plus what goods brought
  // in — the same chain for the headline and for every window it is compared
  // across. Goods add the money a sale left the salon, not its margin: their
  // purchase is already among the expenses.
  const profitFor = (range) => {
    const sales = within(countedSales, range);
    return totalSalesAmount(sales)
      - masterPayoutForPeriod(data.masters, sales, within(data.fines, range))
      - totalExpenses(operatingExpenses(within(data.expenses, range, 'date')))
      + productIncome(data.productSales, range);
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
  const versusPriorMonth = (current, previous, format = money) => (
    priorMonthRange
      ? { ...comparisonToPrevious(current, previous, priorMonthRange, format, { inProgress: monthInProgress }), hint: null }
      : {}
  );
  // «17,7 млн · было 3 322 500» mixed two ways of writing money in one tile.
  const profitVersusPriorMonth = versusPriorMonth(profitFor(compareRange), priorMonthRange ? profitFor(priorMonthRange) : 0, compactMoney);
  const forecast = monthForecast(countedSales, TODAY);
  const signals = attentionSignals({ sales: countedSales, masters: data.masters, today: TODAY });
  const series = monthlySeries({
    sales: countedSales,
    fines: data.fines,
    expenses: data.expenses,
    productSales: data.productSales,
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
        isNew: startedAfter(firstDayOf(master, data.sales, data.attendance), priorMonthRange),
      };
    })
    .sort((left, right) => right.revenue - left.revenue);

  const queue = approvalQueue(data);

  return (
    <section className={`view-grid${overviewEntering ? ' is-entering' : ''}`}>
      {/* An approval queue is work waiting, not a statistic. It leaves
          entirely when there is nothing to approve. */}
      {queue.count && !isReadOnly(data) ? (
        <button className="pending-banner" type="button" onClick={() => setView('admin')}>
          <span className="pending-banner-count">{queue.count}</span>
          <span className="pending-banner-text">
            <strong>Ждут подтверждения · {money(queue.total)}</strong>
            <small>
              {PAYMENT_METHODS.filter(([key]) => queue.mix[key] > 0)
                .map(([key, label]) => `${label} ${money(queue.mix[key])}`)
                .join(' · ')}
            </small>
          </span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      ) : null}

      <RevenueHero
        monthRevenue={monthRevenue}
        compare={compareMix.revenue}
        compareRange={compareRange}
        prior={priorMix.revenue}
        priorRange={priorMonthRange}
        inProgress={monthInProgress}
        series={series}
        forecast={forecast}
        goal={goal}
        canEditGoal={canEditGoal}
        onSetGoal={() => setView('settings')}
      />

      <div className="tiles overview-kpis">
        <Tile label="Чистая прибыль" value={compactMoney(netProfit)} danger={netProfit < 0} {...profitVersusPriorMonth} />
        <Tile
          label="Выручка сегодня"
          value={money(todayRevenue)}
          {...comparisonToPrevious(
            todayRevenue,
            totalSalesAmount(lastWeekSales),
            { from: lastWeekSameDay, to: lastWeekSameDay },
            money,
            { inProgress: true },
          )}
        />
        <Tile label="Клиенты" value={monthMix.clients} {...versusPriorMonth(compareMix.clients, priorMix.clients)} />
        <Tile
          label="Средний чек"
          value={averageCheck(monthRevenue, monthMix.clients)}
          {...versusPriorMonth(compareMix.averageCheck, priorMix.averageCheck)}
        />
        <Tile label="Новые" value={monthMix.newClients} {...versusPriorMonth(compareMix.newClients, priorMix.newClients)} />
        <Tile
          label="Постоянные"
          value={shareText(monthMix.returningShare)}
          {...(priorMonthRange ? shareComparison(compareMix.returningShare, priorMix.returningShare, priorMonthRange) : {})}
          hint={monthMix.labelledClients ? `${monthMix.returningClients} из ${monthMix.labelledClients} ${pluralRu(monthMix.labelledClients, 'клиента', 'клиентов', 'клиентов')}` : null}
        />
      </div>
      {priorMonthRange ? (
        <p className="hint overview-compare-note">
          {monthInProgress
            ? `Сравнение ${comparisonLabel(priorMonthRange, TODAY)}`
            : `Сравнение по законченным дням: ${shortRange(compareRange)} против ${shortRange(priorMonthRange)}`}
        </p>
      ) : null}

      <DutyTodayCard data={data} onOpen={viewIdsForUser(data).includes('duty') ? () => setView('duty') : null} />
      <SiteCard />
      <SignalsCard result={signals} />
      <MastersOfMonth
        rows={masterRows}
        comparisonRange={priorMonthRange}
        inProgress={monthInProgress}
        onOpen={setOpenMaster}
      />
      <MonthlyTrend series={series} forecast={forecast} />
      {openMaster ? <MasterSheet data={data} master={openMaster} onClose={closeMaster} /> : null}
    </section>
  );
}

const SEEN_REJECTED_KEY = 'maestroSeenRejected';

function readSeenRejected() {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_REJECTED_KEY) || '[]');
    return Array.isArray(stored) ? stored.map(String) : [];
  } catch {
    return [];
  }
}

function saleStatusClass(sale) {
  if (isRejectedByOwner(sale)) return 'sale-rejected';
  if (isPendingOwnerApproval(sale)) return 'sale-pending';
  return '';
}

// Finding the client of a visit: a few letters of the name or the last digits
// of the number, most recent visitors first, or a new card. The server masks
// numbers for masters (maskPhoneForStaff in _shared/access.js).
function useClientSearch(query, setError) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }
    const ticket = latest.current + 1;
    latest.current = ticket;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await callLegacyApi('searchClients', { query: text });
        if (latest.current === ticket) setResults(result.clients || []);
      } catch (error) {
        if (latest.current === ticket) setError(actionErrorText(error));
      } finally {
        if (latest.current === ticket) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, setError]);

  return { results, searching };
}

function clientVisitsLine(client) {
  if (!client.visit_count) return client.known_before ? 'бывал раньше' : 'ещё не был';
  const last = client.last_visit ? ` · ${displayDate(client.last_visit)}` : '';
  const master = client.last_master ? ` · ${client.last_master}` : '';
  return `${client.visit_count} ${pluralRu(client.visit_count, 'визит', 'визита', 'визитов')}${last}${master}`;
}

// A card made before the two parts (2026-10-21) has a name and no surname:
// whoever records the client's visit or booking adds it, once.
function SurnameField({ client, onDone, setError }) {
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    const checked = checkLastName(lastName);
    if (!checked.ok) return setError(ACTION_ERROR_TEXT[checked.error]);
    setSaving(true);
    setError('');
    try {
      const result = await callLegacyApi('completeClientName', { client_id: client.id, last_name: checked.last_name });
      haptic('success');
      onDone(result.client);
    } catch (error) {
      setError(actionErrorText(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="client-surname">
      <input aria-label="Фамилия" autoCapitalize="words" maxLength={NAME_PART_MAX} placeholder="Фамилия" value={lastName} onChange={(event) => setLastName(event.target.value)} />
      <button className="btn" type="button" disabled={saving} onClick={save}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
    </div>
  );
}

// One number, one card (owner's decision of 2026-10-16). A number typed on a
// new card is looked up as soon as it is whole, and the card already in the
// base is offered instead. «Был у нас раньше?» is asked only on a new card: a
// client picked from the base is new or returning by his history. A new card
// takes a name, a surname and a number (owner's decisions of 2026-10-21). A
// client who gives neither is a guest without a name: no card, only «Был у
// нас раньше?», and only for a visit (allowGuest), never for a booking.
function ClientPicker({ client, onChange, setError, allowGuest = false, scanTitle = '', scanMaster = '', onCreating }) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { onCreating?.(creating); }, [creating, onCreating]);
  // Who scanned the QR at this master's mirror (owner's decisions of
  // 2026-10-21): asked again every half minute while the form waits for a
  // client, so a scan made during the haircut is there when it ends.
  const [scans, setScans] = useState([]);
  const watchScans = Boolean(scanTitle) && allowGuest && !client && !creating;
  useEffect(() => {
    if (!watchScans) return undefined;
    let alive = true;
    const load = () => callLegacyApi('mirrorScans', { master: scanMaster })
      .then((result) => { if (alive) setScans(result?.scans || []); })
      .catch(() => {});
    load();
    const timer = setInterval(load, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [watchScans, scanMaster]);
  const [draft, setDraft] = useState({ first_name: '', last_name: '', phone: '', known_before: null, guest: false });
  const [saving, setSaving] = useState(false);
  const { results, searching } = useClientSearch(query, setError);
  const phoneDigits = draft.phone.replace(/\D/g, '');
  const wholeNumber = creating && !draft.guest && phoneDigits.length >= 9 ? phoneDigits.slice(-9) : '';
  const { results: sameNumber } = useClientSearch(wholeNumber, setError);
  const existing = wholeNumber ? sameNumber.find((found) => found.has_phone !== false) || null : null;

  function pick(next) {
    onChange(next);
    setQuery('');
    setCreating(false);
  }

  function startNew() {
    const typed = query.trim();
    const looksLikePhone = /^[0-9 +()-]+$/.test(typed);
    // What was typed in the search: the first word is the name, the rest the surname.
    const [firstWord = '', ...rest] = looksLikePhone ? [] : typed.split(/\s+/);
    setDraft({ first_name: firstWord, last_name: rest.join(' '), phone: looksLikePhone ? typed : '', known_before: null, guest: false });
    setCreating(true);
  }

  function pickGuest() {
    if (draft.known_before === null) return setError('Отметьте, был ли клиент у нас раньше.');
    setError('');
    pick({ guest: true, known_before: draft.known_before });
  }

  async function createCard() {
    const name = checkClientName(draft.first_name, draft.last_name);
    if (!name.ok) return setError(ACTION_ERROR_TEXT[name.error]);
    if (!draft.phone.trim()) {
      return setError(allowGuest ? 'Введите номер. Не даёт номер — «Гость без имени».' : ACTION_ERROR_TEXT.client_phone_required);
    }
    if (draft.known_before === null) return setError('Отметьте, был ли клиент у нас раньше.');
    setSaving(true);
    setError('');
    try {
      const result = await callLegacyApi('addClient', {
        first_name: name.first_name,
        last_name: name.last_name,
        phone: draft.phone.trim(),
        known_before: draft.known_before,
      });
      haptic('success');
      pick(result.client);
    } catch (error) {
      if (error.details?.error === 'client_exists' && error.details.client) {
        setError(`Этот номер уже есть: ${error.details.client.full_name}. Выбран он.`);
        pick(error.details.client);
      } else {
        setError(actionErrorText(error));
      }
    } finally {
      setSaving(false);
    }
  }

  if (client?.guest) {
    return (
      <div className="picker-selected">
        <span>
          <strong>Гость без имени</strong>
          <small>{client.known_before ? 'постоянный' : 'новый'}</small>
        </span>
        <button className="link-button" type="button" onClick={() => onChange(null)}>Изменить</button>
      </div>
    );
  }

  if (client) {
    return (
      <div className="client-chosen">
        <div className="picker-selected">
          <span>
            <strong>{client.full_name}</strong>
            <small>{client.phone || 'без номера'} · {clientVisitsLine(client)}{client.needs_surname ? ' · нет фамилии' : ''}</small>
          </span>
          <button className="link-button" type="button" onClick={() => onChange(null)}>Изменить</button>
        </div>
        {client.needs_surname ? <SurnameField key={client.id} client={client} onDone={onChange} setError={setError} /> : null}
      </div>
    );
  }

  if (creating) {
    return (
      <div className="client-new">
        {draft.guest ? null : (
          <>
            <input aria-label="Имя" autoCapitalize="words" maxLength={NAME_PART_MAX} placeholder="Имя" value={draft.first_name} onChange={(event) => setDraft({ ...draft, first_name: event.target.value })} />
            <input aria-label="Фамилия" autoCapitalize="words" maxLength={NAME_PART_MAX} placeholder="Фамилия" value={draft.last_name} onChange={(event) => setDraft({ ...draft, last_name: event.target.value })} />
            <input inputMode="tel" maxLength={20} placeholder="Телефон, например 90 123 45 67" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} />
          </>
        )}
        {allowGuest && !existing ? (
          <button
            aria-pressed={draft.guest}
            className={`client-guest${draft.guest ? ' on' : ''}`}
            type="button"
            onClick={() => setDraft({ ...draft, guest: !draft.guest })}
          >
            Гость без имени
          </button>
        ) : null}
        {existing ? (
          <div className="client-exists">
            <span>
              <strong>Этот номер уже есть</strong>
              <small>{existing.full_name} · {existing.phone} · {clientVisitsLine(existing)}</small>
            </span>
            <button className="btn" type="button" onClick={() => pick(existing)}>Выбрать</button>
          </div>
        ) : null}
        {existing ? (
          <div className="settings-actions">
            <button className="btn ghost" type="button" onClick={() => setCreating(false)}>Назад</button>
          </div>
        ) : (
        <>
        <div className="client-known">
          <span>Был у нас раньше?</span>
          <div className="seg">
            <button className={draft.known_before === true ? 'on' : ''} type="button" onClick={() => setDraft({ ...draft, known_before: true })}>Да</button>
            <button className={draft.known_before === false ? 'on' : ''} type="button" onClick={() => setDraft({ ...draft, known_before: false })}>Нет</button>
          </div>
        </div>
        <div className="settings-actions">
          {draft.guest ? (
            <button className="btn" type="button" onClick={pickGuest}>Готово</button>
          ) : (
            <button className="btn" type="button" disabled={saving} onClick={createCard}>{saving ? 'Сохраняем…' : 'Создать карточку'}</button>
          )}
          <button className="btn ghost" type="button" disabled={saving} onClick={() => setCreating(false)}>Назад</button>
        </div>
        </>
        )}
      </div>
    );
  }

  return (
    <div className="picker">
      {watchScans && scans.length ? (
        <div className="mirror-scans">
          <span className="mirror-scans-title">{scanTitle}</span>
          {scans.map((scan) => (
            <button key={scan.id} className="mirror-scan" type="button" onClick={() => pick(scan.client)}>
              <strong>{scan.client.full_name}</strong>
              <small>{scannedAgo(scan.scanned_at)}</small>
            </button>
          ))}
        </div>
      ) : null}
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder="Клиент: имя или последние цифры номера"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim().length >= 2 ? (
        <div className="picker-list" role="listbox">
          {results.map((found) => (
            <button key={found.id} role="option" aria-selected="false" type="button" disabled={found.blocked} onClick={() => pick(found)}>
              <span>
                {found.full_name}
                <small className="client-line">{found.phone || 'без номера'} · {clientVisitsLine(found)}</small>
              </span>
              {found.blocked ? <small>заблокирован</small> : null}
            </button>
          ))}
          {!searching && !results.length ? <p className="hint">Не найден</p> : null}
        </div>
      ) : null}
      <button className="btn ghost client-new-button" type="button" onClick={startNew}>+ Новый клиент</button>
    </div>
  );
}

// The owner's view of one client: the whole number, how to reach him, and
// every visit — when, at what time, to which master, for how much.
function ClientSheet({ clientId, onClose, setError, reload }) {
  useTelegramBack(onClose);
  const dialogRef = useDialogFocus();
  // The card shown; a merge moves it to the card that stays.
  const [currentId, setCurrentId] = useState(clientId);
  const [card, setCard] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ first_name: '', last_name: '', phone: '' });
  const [conflict, setConflict] = useState(null);
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);

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

  useEffect(() => {
    let alive = true;
    setCard(null);
    callLegacyApi('getClient', { client_id: currentId })
      .then((result) => { if (alive) setCard(result); })
      .catch((error) => { if (alive) { setError(actionErrorText(error)); onClose(); } });
    return () => { alive = false; };
  }, [currentId, onClose, setError]);

  function startEdit() {
    const current = card?.client;
    // A card from before the two parts: its whole name goes into «Имя».
    setDraft({
      first_name: current?.first_name || current?.full_name || '',
      last_name: current?.last_name || '',
      phone: current?.phone || '',
    });
    setConflict(null);
    setMessage('');
    setEditing(true);
  }

  async function saveEdit() {
    const name = checkClientName(draft.first_name, draft.last_name);
    if (!name.ok) return setError(ACTION_ERROR_TEXT[name.error]);
    setConflict(null);
    let refused = null;
    const ok = await run(async () => {
      try {
        await callLegacyApi('updateClient', {
          client_id: currentId,
          first_name: name.first_name,
          last_name: name.last_name,
          phone: draft.phone.trim() || null,
        });
      } catch (error) {
        if (error.details?.error === 'client_exists') {
          refused = error.details;
          return;
        }
        throw error;
      }
    });
    if (!ok) return;
    if (refused) {
      setConflict(refused);
      return;
    }
    setMessage('Карточка сохранена.');
    setEditing(false);
    const result = await callLegacyApi('getClient', { client_id: currentId }).catch(() => null);
    if (result) setCard(result);
    reload?.();
  }

  // The number belongs to another card: both are one person.
  async function mergeInto() {
    if (!conflict?.client_id) return;
    const ok = await run(() => callLegacyApi('mergeClients', { from_id: currentId, into_id: conflict.client_id }));
    if (!ok) return;
    setMessage(`Карточки объединены: ${conflict.full_name}.`);
    setEditing(false);
    setConflict(null);
    setCurrentId(conflict.client_id);
    reload?.();
  }

  const client = card?.client;
  const visits = (card?.visits || []).filter((visit) => !visit.rejected);
  const missed = card?.missed || [];
  // One timeline, newest first: a no-show belongs between the visits around it.
  const timeline = [
    ...visits.map((visit) => ({ kind: 'visit', at: visit.starts_at || visit.created_at, visit })),
    ...missed.map((item) => ({ kind: 'missed', at: item.starts_at, item })),
  ].sort((left, right) => String(right.at).localeCompare(String(left.at)));
  const telegramLink = client?.telegram_username
    ? `https://t.me/${client.telegram_username}`
    : client?.telegram_user_id ? `tg://user?id=${client.telegram_user_id}` : null;

  return (
    <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
      <div aria-label="Клиент" aria-modal="true" className="card master-sheet client-sheet" ref={dialogRef} role="dialog" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="master-sheet-head">
          <div>
            <strong>{client?.full_name || 'Клиент'}</strong>
            <small>
              {client ? `${client.phone || 'без номера'} · ${visits.length} ${pluralRu(visits.length, 'визит', 'визита', 'визитов')}${missed.length ? ` · неявок и отмен ${missed.length}` : ''}${client.last_name ? '' : ' · нет фамилии'}` : 'Загружаем…'}
            </small>
          </div>
          <button aria-label="Закрыть" className="sheet-close" type="button" onClick={onClose}>×</button>
        </div>
        {client ? (
          <>
            {editing ? (
              <div className="client-new client-edit">
                <input aria-label="Имя" autoCapitalize="words" maxLength={NAME_PART_MAX} placeholder="Имя" value={draft.first_name} onChange={(event) => setDraft({ ...draft, first_name: event.target.value })} />
                <input aria-label="Фамилия" autoCapitalize="words" maxLength={NAME_PART_MAX} placeholder="Фамилия" value={draft.last_name} onChange={(event) => setDraft({ ...draft, last_name: event.target.value })} />
                <input aria-label="Телефон" inputMode="tel" maxLength={20} placeholder="Телефон" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} />
                {conflict ? (
                  <div className="client-exists">
                    <span>
                      <strong>Этот номер у карточки «{conflict.full_name}»</strong>
                    </span>
                    <button className="btn" type="button" disabled={busy} onClick={mergeInto}>{busy ? 'Объединяю…' : 'Объединить'}</button>
                  </div>
                ) : null}
                <div className="settings-actions">
                  <button className="btn" type="button" disabled={busy} onClick={saveEdit}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => { setEditing(false); setConflict(null); }}>Отмена</button>
                </div>
              </div>
            ) : (
              <div className="settings-actions client-contact">
                {client.phone ? <a className="btn ghost" href={`tel:${client.phone}`}>Позвонить</a> : null}
                {telegramLink ? <a className="btn ghost" href={telegramLink} rel="noreferrer" target="_blank">Написать</a> : null}
                <button className="btn ghost" type="button" onClick={startEdit}>Изменить</button>
              </div>
            )}
            <div className="rows">
              {timeline.map((entry) => (entry.kind === 'visit' ? (
                <div className="row" key={`v-${entry.visit.id}`}>
                  <div>
                    <strong>{entry.at ? displayDateTime(entry.at) : displayDate(entry.visit.d)}</strong>
                    <span>{entry.visit.master}{entry.visit.status === 'pending' ? ' · ждёт подтверждения' : ''}{entry.visit.is_new_client ? ' · первый визит' : ''}</span>
                  </div>
                  <div><strong>{money(entry.visit.amount)}</strong></div>
                </div>
              ) : (
                <div className="row client-missed" key={`m-${entry.at}`}>
                  <div>
                    <strong>{displayDateTime(entry.at)}</strong>
                    <span>{entry.item.status === 'no_show' ? 'не пришёл' : 'отменил запись'}</span>
                  </div>
                </div>
              )))}
              {!timeline.length ? <p className="hint">Визитов пока нет.</p> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// Продажи: the owner looks a client up by name or number and opens his card.
function ClientFinder({ setError, reload }) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const { results, searching } = useClientSearch(query, setError);
  const close = useCallback(() => setOpenId(null), []);

  return (
    <div className="card wide client-finder">
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder="Найти клиента: имя или номер"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim().length >= 2 ? (
        <div className="picker-list" role="listbox">
          {results.map((found) => (
            <button key={found.id} role="option" aria-selected="false" type="button" onClick={() => setOpenId(found.id)}>
              <span>
                {found.full_name}
                <small className="client-line">{found.phone || 'без номера'} · {clientVisitsLine(found)}</small>
              </span>
            </button>
          ))}
          {!searching && !results.length ? <p className="hint">Не найден</p> : null}
        </div>
      ) : null}
      {openId ? <ClientSheet clientId={openId} onClose={close} setError={setError} reload={reload} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ bookings

const NO_SHOW_REASONS = [
  ['no_show_no_notice', 'Не предупредил'],
  ['no_show_late_arrival', 'Сильно опоздал'],
  ['no_show_unreachable', 'Не дозвонились'],
];
const CANCEL_REASONS = [
  ['client', 'client_changed_plans', 'Клиент отменил'],
  ['salon', 'salon_master_unavailable', 'Мастер не может'],
];
const BOOKING_STATUS_TEXT = {
  completed: 'Пришёл',
  no_show: 'Не пришёл',
  cancelled: 'Отменена',
};

// The client of a booking as the visit form takes him.
function clientFromBooking(appointment) {
  if (!appointment.client_id) return null;
  return {
    id: appointment.client_id,
    full_name: appointment.client_name,
    phone: appointment.client_phone,
    visit_count: Number(appointment.client_visit_count) || 0,
    known_before: appointment.client_known_before === true,
    needs_surname: appointment.client_needs_surname === true,
  };
}

function bookingTimeLine(appointment) {
  const start = tashkentParts(appointment.starts_at);
  const end = tashkentParts(appointment.ends_at);
  const day = start.date === TODAY ? 'сегодня' : start.date === shiftDate(TODAY, 1) ? 'завтра' : displayDate(start.date);
  return `${day} · ${start.time}–${end.time}`;
}

// «сегодня 18:00», «завтра 10:30», «28.10.2026 15:00»: what the desk tells
// the client on the phone once a booking is made or moved.
function bookingWhen(startsAt) {
  const start = tashkentParts(startsAt);
  const day = start.date === TODAY ? 'сегодня' : start.date === shiftDate(TODAY, 1) ? 'завтра' : displayDate(start.date);
  return `${day} ${start.time}`;
}

// «Не пришёл» and «Отменить» take one more tap for the reason, no form.
function OutcomeChooser({ appointment, reload, setError, onDone, initialMode = null }) {
  const [mode, setMode] = useState(initialMode);
  const setMessage = useNotice();
  const [savingCode, setSavingCode] = useState(null);
  // A second tap arrives before the first has re-rendered anything.
  const savingRef = useRef(false);
  const { run, busy } = useAction(setError, setMessage);
  const started = new Date(appointment.starts_at).getTime() <= Date.now();

  async function save(outcome, cancelledBy, reasonCode) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingCode(reasonCode);
    let ok = false;
    try {
      ok = await run(
        () => callLegacyApi('setAppointmentOutcome', {
          id: appointment.id,
          outcome,
          cancelled_by: cancelledBy,
          reason_code: reasonCode,
        }),
        outcome === 'no_show' ? 'Отмечено: не пришёл.' : 'Запись отменена.',
      );
    } finally {
      savingRef.current = false;
      setSavingCode(null);
    }
    if (!ok) return;
    haptic('success');
    reload();
    onDone?.();
  }

  if (mode === 'no_show') {
    return (
      <div className="outcome-chips">
        {NO_SHOW_REASONS.map(([code, label]) => (
          <button className="btn ghost" disabled={busy} key={code} type="button" onClick={() => save('no_show', null, code)}>{savingCode === code ? 'Сохраняю…' : label}</button>
        ))}
        <button className="link-button" type="button" onClick={() => (initialMode ? onDone?.() : setMode(null))}>Назад</button>
      </div>
    );
  }
  if (mode === 'cancel') {
    return (
      <div className="outcome-chips">
        {CANCEL_REASONS.map(([by, code, label]) => (
          <button className="btn ghost" disabled={busy} key={code} type="button" onClick={() => save('cancelled', by, code)}>{savingCode === code ? 'Сохраняю…' : label}</button>
        ))}
        <button className="link-button" type="button" onClick={() => (initialMode ? onDone?.() : setMode(null))}>Назад</button>
      </div>
    );
  }
  return (
    <div className="outcome-actions">
      {started ? <button className="btn ghost" type="button" onClick={() => setMode('no_show')}>Не пришёл</button> : null}
      <button className="btn ghost danger-ghost" type="button" onClick={() => setMode('cancel')}>Отменить</button>
    </div>
  );
}

// «Сегодня», «Завтра», then «Пт 23». The weekday is a text of its own: as
// one string «Ср 28» stayed Russian in Uzbek (owner's review of 2026-10-26).
function dayChipLabel(day, index) {
  if (index === 0) return 'Сегодня';
  if (index === 1) return 'Завтра';
  const weekday = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7];
  return <>{weekday} {Number(day.slice(8))}</>;
}

// Another time or another master for an open booking (owner's request of
// 2026-10-16). The master hears of it from the bot.
function MoveBooking({ data, appointment, reload, setError, onDone, onCancel }) {
  const [masterId, setMasterId] = useState(appointment.master_id);
  const [date, setDate] = useState(() => {
    const day = tashkentParts(appointment.starts_at).date;
    return day < TODAY ? TODAY : day;
  });
  const [times, setTimes] = useState(null);
  const [startsAt, setStartsAt] = useState(null);
  const { run, busy } = useAction(setError, useNotice());
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(TODAY, index));

  useEffect(() => {
    setStartsAt(null);
    setTimes(null);
    let alive = true;
    callLegacyApi('bookingSlots', { master_id: Number(masterId), date, appointment_id: appointment.id })
      .then((result) => { if (alive) setTimes(result.times || []); })
      .catch((error) => { if (alive) setError(actionErrorText(error)); });
    return () => { alive = false; };
  }, [masterId, date, appointment.id, setError]);

  async function save() {
    if (!startsAt) return setError('Выберите время.');
    const masterName = data.masters.find((master) => String(master.id) === String(masterId))?.name || '';
    const ok = await run(
      () => callLegacyApi('moveBooking', { id: appointment.id, master_id: Number(masterId), starts_at: startsAt }),
      `Перенесено: ${appointment.client_name} · ${masterName} · ${bookingWhen(startsAt)}`,
    );
    if (!ok) return;
    haptic('success');
    reload();
    onDone();
  }

  return (
    <div className="stock-form move-booking">
      <div className="seg">
        {data.activeMasters.map((master) => {
          const on = String(master.id) === String(masterId);
          return <button className={on ? 'on' : ''} key={master.id} type="button" onClick={() => setMasterId(master.id)} ref={on ? keepTabInSight : undefined}>{master.name}</button>;
        })}
      </div>
      <div className="day-chips">
        {days.map((day, index) => (
          <button className={day === date ? 'on' : ''} key={day} type="button" onClick={() => setDate(day)}>{dayChipLabel(day, index)}</button>
        ))}
        <input aria-label="Другая дата" type="date" value={date} min={TODAY} onChange={(event) => event.target.value && setDate(event.target.value)} />
      </div>
      {times ? (
        times.length ? (
          <div className="time-chips">
            {times.map((time) => (
              <button className={time === startsAt ? 'on' : ''} key={time} type="button" onClick={() => setStartsAt(time)}>{tashkentParts(time).time}</button>
            ))}
          </div>
        ) : <p className="hint">Свободного времени нет.</p>
      ) : null}
      <button className="btn" type="button" disabled={busy || !startsAt} onClick={save}>{busy ? 'Переношу…' : 'Перенести'}</button>
      {onCancel ? <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>Не переносить</button> : null}
    </div>
  );
}

function BookingSheet({ data, appointment, reload, setError, onClose, onVisit }) {
  useTelegramBack(onClose);
  const dialogRef = useDialogFocus();
  const isOwner = data.appRole === 'owner';
  const canMove = ['owner', 'admin', 'partner'].includes(data.appRole);
  const [moving, setMoving] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const closeClient = useCallback(() => setClientOpen(false), []);
  const master = data.masters.find((item) => String(item.id) === String(appointment.master_id));
  const badge = clientBadge(appointment);
  const open = isOpenBooking(appointment);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
      <div aria-label="Запись" aria-modal="true" className="card master-sheet booking-sheet" ref={dialogRef} role="dialog" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="master-sheet-head">
          <div>
            {isOwner && appointment.client_id ? (
              <button className="master-name-button booking-client" type="button" onClick={() => setClientOpen(true)}>{appointment.client_name}</button>
            ) : <strong>{appointment.client_name}</strong>}
            <small>{appointment.client_phone || 'без номера'}{badge ? ` · ${badge}` : ''}</small>
          </div>
          <button aria-label="Закрыть" className="sheet-close" type="button" onClick={onClose}>×</button>
        </div>
        {['owner', 'admin', 'partner'].includes(data.appRole) && appointment.client_phone ? (
          <div className="settings-actions client-contact">
            <a className="btn ghost" href={`tel:${appointment.client_phone}`}>Позвонить</a>
          </div>
        ) : null}
        <div className="booking-facts">
          <span>Время<strong>{bookingTimeLine(appointment)}</strong></span>
          <span>Мастер<strong>{master?.name || '—'}</strong></span>
          <span>Услуги<strong>{appointment.service_name}</strong></span>
          <span>Сумма<strong>{money(appointment.price_uzs)} · {appointment.source === 'web' ? 'сайт' : 'салон'}</strong></span>
          {appointment.notes ? <span>Комментарий<strong>{appointment.notes}</strong></span> : null}
        </div>
        {!open ? (
          <p className={`booking-outcome is-${appointment.status}`}>
            {appointment.status === 'pending' ? 'Ждёт подтверждения клиента в Telegram' : BOOKING_STATUS_TEXT[appointment.status] || appointment.status}
          </p>
        ) : (
          <>
            {(isOwner || data.role === 'master') && onVisit && canRecordVisit(appointment) && !moving ? (
              <button className="btn" type="button" onClick={() => onVisit(appointment)}>Пришёл → визит</button>
            ) : null}
            {canMove ? (
              moving
                ? <MoveBooking data={data} appointment={appointment} reload={reload} setError={setError} onDone={onClose} onCancel={() => setMoving(false)} />
                : <button className="btn ghost" type="button" onClick={() => setMoving(true)}>Перенести</button>
            ) : null}
            {moving ? null : <OutcomeChooser appointment={appointment} reload={reload} setError={setError} onDone={onClose} />}
          </>
        )}
        {clientOpen ? <ClientSheet clientId={appointment.client_id} onClose={closeClient} setError={setError} reload={reload} /> : null}
      </div>
    </div>
  );
}

// Several services, found by typing, like goods on the shelf. Once one is
// chosen the list folds away (owner's review of 2026-10-26): six services
// stayed open under the chosen one and pushed the times off the sheet.
function ServicesPicker({ services, value, onChange }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const open = !value.length || adding;
  const chosen = value.map((id) => services.find((service) => service.id === id)).filter(Boolean);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = services
    .filter((service) => service.active !== false && !value.includes(service.id))
    .filter((service) => words.every((word) => String(service.name_ru).toLowerCase().includes(word)));

  return (
    <div className="picker">
      {chosen.length ? (
        <div className="service-chips">
          {chosen.map((service) => (
            <button className="service-chip" key={service.id} type="button" onClick={() => onChange(value.filter((id) => id !== service.id))}>
              {service.name_ru} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <>
          <input type="search" autoComplete="off" placeholder="Услуга" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="picker-list">
            {matches.slice(0, query ? 8 : 5).map((service) => (
              <button key={service.id} type="button" onClick={() => { onChange([...value, service.id]); setQuery(''); setAdding(false); }}>
                <span>{service.name_ru}</span>
                <small>{money(service.price_uzs)} · {service.duration_minutes} мин</small>
              </button>
            ))}
          </div>
        </>
      ) : (
        <button className="link-button" type="button" onClick={() => setAdding(true)}>+ ещё услуга</button>
      )}
    </div>
  );
}

function NewBookingSheet({ data, draft, reload, setError, onClose }) {
  const [masterId, setMasterId] = useState(draft.masterId);
  const [serviceIds, setServiceIds] = useState([]);
  const [times, setTimes] = useState(null);
  const [startsAt, setStartsAt] = useState(null);
  const [client, setClient] = useState(null);
  const [notes, setNotes] = useState('');
  // While a new client's card is being filled, «Создать карточку» is the one
  // dark button; «Записать» waits until there is a client to book.
  const [creatingClient, setCreatingClient] = useState(false);
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const services = data.bookingServices;
  const total = serviceIds.reduce((sum, id) => sum + (Number(services.find((service) => service.id === id)?.price_uzs) || 0), 0);
  const masterName = data.masters.find((master) => String(master.id) === String(masterId))?.name || '';
  const dirty = serviceIds.length > 0 || Boolean(client) || Boolean(notes.trim()) || creatingClient;

  // A tap beside the sheet used to throw a half-made booking away. Leaving
  // with something filled in now asks first; Escape does the same.
  async function leave() {
    if (dirty && !await confirmAction('Закрыть без записи? Выбранное не сохранится.')) return;
    onClose();
  }
  useTelegramBack(leave);
  const dialogRef = useDialogFocus();

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') leave(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  });

  useEffect(() => {
    setStartsAt(null);
    if (!serviceIds.length || !masterId) {
      setTimes(null);
      return undefined;
    }
    let alive = true;
    callLegacyApi('bookingSlots', { master_id: Number(masterId), date: draft.date, service_ids: serviceIds })
      .then((result) => {
        if (!alive) return;
        const list = result.times || [];
        setTimes(list);
        // The tapped time, if it is free for these services.
        const wanted = list.find((time) => tashkentParts(time).minutes === draft.minutes);
        if (wanted) setStartsAt(wanted);
      })
      .catch((error) => { if (alive) setError(actionErrorText(error)); });
    return () => { alive = false; };
  }, [masterId, serviceIds, draft.date, draft.minutes, setError]);

  async function save() {
    if (!serviceIds.length) return setError('Выберите услугу.');
    if (!startsAt) return setError('Выберите время.');
    if (!client) return setError('Выберите клиента или создайте карточку.');
    if (client.needs_surname) return setError(ACTION_ERROR_TEXT.client_surname_required);
    const ok = await run(
      () => callLegacyApi('addBooking', {
        master_id: Number(masterId),
        service_ids: serviceIds,
        starts_at: startsAt,
        client_id: client.id,
        notes: notes.trim() || null,
      }),
      `Записан: ${client.full_name} · ${masterName} · ${bookingWhen(startsAt)}`,
    );
    if (ok) {
      haptic('success');
      reload();
      onClose();
    }
  }

  return (
    <div className="modal-backdrop sheet-backdrop" onClick={leave}>
      <div aria-label="Новая запись" aria-modal="true" className="card master-sheet booking-sheet" ref={dialogRef} role="dialog" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="master-sheet-head">
          <div>
            <strong>Новая запись</strong>
            <small>{draft.date === TODAY ? 'сегодня' : displayDate(draft.date)}</small>
          </div>
          <button aria-label="Закрыть" className="sheet-close" type="button" onClick={leave}>×</button>
        </div>
        <div className="stock-form">
          <div className="seg">
            {data.activeMasters.map((master) => {
              const on = String(master.id) === String(masterId);
              return <button className={on ? 'on' : ''} key={master.id} type="button" onClick={() => setMasterId(master.id)} ref={on ? keepTabInSight : undefined}>{master.name}</button>;
            })}
          </div>
          <ServicesPicker services={services} value={serviceIds} onChange={setServiceIds} />
          {times ? (
            times.length ? (
              <div className="time-chips">
                {times.map((time) => (
                  <button className={time === startsAt ? 'on' : ''} key={time} type="button" onClick={() => setStartsAt(time)}>{tashkentParts(time).time}</button>
                ))}
              </div>
            ) : <p className="hint">Свободного времени нет.</p>
          ) : null}
          <ClientPicker client={client} onChange={setClient} setError={setError} onCreating={setCreatingClient} />
          {creatingClient ? null : (
            <>
              <input maxLength={300} placeholder="Комментарий" value={notes} onChange={(event) => setNotes(event.target.value)} />
              {/* What the desk will say to the client, next to the button. */}
              <div className="stock-preview booking-summary">
                <span>{masterName} · {startsAt ? bookingWhen(startsAt) : 'время не выбрано'}</span>
                <strong>{money(total)} сум</strong>
              </div>
              <button className="btn" type="button" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Записать'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const MINUTE_PX = 1.1;

// Команда → «Записи»: one day, masters side by side, time down the page.
function BookingsView({ data, reload, setError, onVisit }) {
  const [date, setDate] = useState(TODAY);
  const [openId, setOpenId] = useState(null);
  const [newDraft, setNewDraft] = useState(null);
  // Days off are set by the owner and by the partner (decision of 2026-10-16).
  const canSetDayOff = ['owner', 'partner'].includes(data.appRole);
  const controlSince = data.settings.booking_control_since || null;
  const unclosed = ['owner', 'partner'].includes(data.appRole)
    ? unclosedByMaster(data.appointments, data.masters, new Date(), controlSince)
    : [];
  const closeBooking = useCallback(() => setOpenId(null), []);
  const closeNew = useCallback(() => setNewDraft(null), []);
  const { run } = useAction(setError);
  const gridRef = useRef(null);

  const masters = data.activeMasters;
  const hours = masters.map((master) => masterHoursOn(master, date, data.scheduleRules, data.dayStatuses));
  const frame = dayFrame(hours);
  const height = (frame.end - frame.start) * MINUTE_PX;
  const bookings = visibleBookings(data.appointments, date);
  const openBooking = data.appointments.find((appointment) => appointment.id === openId) || null;
  const nowMinutes = tashkentParts(new Date()).minutes;
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(TODAY, index));
  const hourMarks = [];
  for (let minute = frame.start; minute <= frame.end; minute += 60) hourMarks.push(minute);

  function tapColumn(event, master, masterHours) {
    if (masterHours.start == null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minute = frame.start + Math.floor(((event.clientY - rect.top) / MINUTE_PX) / 15) * 15;
    setNewDraft({ masterId: master.id, date, minutes: minute });
  }

  // A visible way to book (owner's review of 2026-10-26): before, only a tap
  // on an empty stretch of the grid opened the sheet, and nothing said so.
  // It starts with the first master working that day, at the next quarter
  // hour today or at the start of his shift on another day.
  function startNewBooking() {
    const index = hours.findIndex((masterHours) => masterHours.start != null);
    const master = masters[Math.max(0, index)];
    if (!master) return;
    const shiftStart = hours[Math.max(0, index)]?.start ?? frame.start;
    const minutes = date === TODAY ? Math.max(shiftStart, Math.ceil(nowMinutes / 15) * 15) : shiftStart;
    setNewDraft({ masterId: master.id, date, minutes });
  }

  // The grid opened at its first hour, in the morning, whatever the time.
  // Today it opens at the red line of now; the page itself stays where it is.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || date !== TODAY) return;
    // Now sits just under the names, with the hours ahead below it.
    const offset = (nowMinutes - frame.start) * MINUTE_PX;
    grid.scrollTop = Math.max(0, offset - 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, frame.start]);

  async function toggleDayOff(master, masterHours) {
    if (!canSetDayOff) return;
    const enable = !masterHours.dayOff;
    if (!await confirmAction(enable ? `${master.name}: выходной ${displayDate(date)}?` : `${master.name}: отменить выходной ${displayDate(date)}?`)) return;
    await run(() => callLegacyApi('setMasterDayOff', { master_id: master.id, work_date: date, enabled: enable }).then(reload));
  }

  return (
    <section className="view-grid">
      {unclosed.length ? (
        <div className="card wide unclosed-card">
          <strong>Не закрыто</strong>
          <div className="unclosed-chips">
            {unclosed.map((row) => (data.appRole === 'partner' ? (
              // The partner could only mark «Не пришёл» there; closing with a
              // visit is the master's (owner's review of 2026-10-26).
              <span className="unclosed-chip" key={row.master.id}>{row.master.name} <b>{row.count}</b></span>
            ) : (
              <button
                key={row.master.id}
                type="button"
                onClick={() => { setDate(tashkentParts(row.oldest.starts_at).date); setOpenId(row.oldest.id); }}
              >
                {row.master.name} <b>{row.count}</b>
              </button>
            )))}
          </div>
          {data.appRole === 'partner' ? <small className="unclosed-note">Закрывает мастер</small> : null}
        </div>
      ) : null}
      {/* The administrator has no Главная: who is on duty stands here. */}
      {data.role === 'frontdesk' ? <DutyTodayCard data={data} /> : null}
      <div className="wide day-chips">
        {days.map((day, index) => (
          <button className={day === date ? 'on' : ''} key={day} type="button" onClick={() => setDate(day)}>
            {dayChipLabel(day, index)}
          </button>
        ))}
        <input aria-label="Другая дата" type="date" value={date} min={TODAY} onChange={(event) => event.target.value && setDate(event.target.value)} />
      </div>

      <button className="btn wide new-booking-button" type="button" onClick={startNewBooking}>+ Новая запись</button>

      {/* Its own scroll both ways, so the masters' names stay on top and the
          hours on the left while the day is read (owner's review of
          2026-10-26: on a phone the names left with the first swipe). */}
      <div className="card wide day-grid-card" ref={gridRef}>
        <div className="day-grid" style={{ '--columns': masters.length }}>
          <div className="day-grid-corner" />
          {masters.map((master, index) => (
            <div className={`day-grid-head${hours[index].dayOff ? ' is-off' : ''}`} key={master.id}>
              {master.name}
              <small>{hours[index].start != null ? `${minutesLabel(hours[index].start)}–${minutesLabel(hours[index].end)}` : 'выходной'}</small>
              {/* A day off is its own button now: the name itself used to set
                  it for the partner and did nothing for the desk. */}
              {canSetDayOff ? (
                <button className="day-off-toggle" type="button" onClick={() => toggleDayOff(master, hours[index])}>
                  {hours[index].dayOff ? 'Вернуть день' : 'Выходной'}
                </button>
              ) : null}
            </div>
          ))}
          <div className="day-grid-axis" style={{ height }}>
            {hourMarks.map((minute) => (
              <span key={minute} style={{ top: (minute - frame.start) * MINUTE_PX }}>{minutesLabel(minute)}</span>
            ))}
          </div>
          {masters.map((master, index) => {
            const masterHours = hours[index];
            const mine = bookings.filter((appointment) => String(appointment.master_id) === String(master.id));
            return (
              <div className="day-grid-column" key={master.id} style={{ height }} onClick={(event) => tapColumn(event, master, masterHours)}>
                {hourMarks.map((minute) => <i className="day-grid-line" key={minute} style={{ top: (minute - frame.start) * MINUTE_PX }} />)}
                {masterHours.start == null ? (
                  <div className="day-grid-off" style={{ top: 0, height }} />
                ) : (
                  <>
                    {masterHours.start > frame.start ? <div className="day-grid-off" style={{ top: 0, height: (masterHours.start - frame.start) * MINUTE_PX }} /> : null}
                    {masterHours.end < frame.end ? <div className="day-grid-off" style={{ top: (masterHours.end - frame.start) * MINUTE_PX, height: (frame.end - masterHours.end) * MINUTE_PX }} /> : null}
                  </>
                )}
                {mine.map((appointment) => {
                  const position = blockPosition(appointment, frame.start, MINUTE_PX);
                  const overdue = isOverdueBooking(appointment, new Date(), controlSince);
                  return (
                    <button
                      className={`booking-block is-${appointment.status}${appointment.source === 'web' ? ' is-web' : ''}${overdue ? ' is-overdue' : ''}`}
                      key={appointment.id}
                      style={{ top: position.top, height: position.height }}
                      type="button"
                      onClick={(event) => { event.stopPropagation(); setOpenId(appointment.id); }}
                    >
                      <b>{tashkentParts(appointment.starts_at).time}</b> {appointment.client_name}
                      <small>{appointment.service_name}</small>
                    </button>
                  );
                })}
                {date === TODAY && nowMinutes >= frame.start && nowMinutes <= frame.end ? (
                  <i className="day-grid-now" style={{ top: (nowMinutes - frame.start) * MINUTE_PX }} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {openBooking ? (
        <BookingSheet
          appointment={openBooking}
          data={data}
          reload={reload}
          setError={setError}
          onClose={closeBooking}
          onVisit={onVisit ? (appointment) => { closeBooking(); onVisit(appointment); } : null}
        />
      ) : null}
      {newDraft ? <NewBookingSheet data={data} draft={newDraft} reload={reload} setError={setError} onClose={closeNew} /> : null}
    </section>
  );
}

// A master's own calendar (owner's request of 2026-10-21): two weeks ahead at
// a glance, how many bookings each day, and the chosen day as a column with
// his shift's hours left light. A booking opens its sheet: «Пришёл → визит»,
// «Не пришёл», a cancellation; booking anyone himself stays the desk's.
function MasterCalendarView({ data, reload, setError, onVisit }) {
  const [date, setDate] = useState(TODAY);
  const [openId, setOpenId] = useState(null);
  const closeBooking = useCallback(() => setOpenId(null), []);
  const master = data.byName[data.me];
  if (!master) return null;

  const mine = data.appointments.filter((appointment) => String(appointment.master_id) === String(master.id));
  const days = Array.from({ length: 14 }, (_, index) => shiftDate(TODAY, index));
  const hours = masterHoursOn(master, date, data.scheduleRules, data.dayStatuses);
  const bookings = visibleBookings(mine, date);
  // The day reaches from the shift's start to its end, and further if a
  // booking lies outside it, so none is cut off.
  const spans = bookings.map((appointment) => {
    const start = tashkentParts(appointment.starts_at).minutes;
    return { start, end: tashkentParts(appointment.ends_at).minutes || start + 30 };
  });
  const frame = dayFrame([hours, ...spans]);
  const height = (frame.end - frame.start) * MINUTE_PX;
  const controlSince = data.settings.booking_control_since || null;
  const openBooking = mine.find((appointment) => appointment.id === openId) || null;
  const nowMinutes = tashkentParts(new Date()).minutes;
  const hourMarks = [];
  for (let minute = frame.start; minute <= frame.end; minute += 60) hourMarks.push(minute);

  return (
    <section className="view-grid">
      <div className="wide day-chips my-calendar-days">
        {days.map((day, index) => {
          const count = visibleBookings(mine, day).length;
          return (
            <button className={day === date ? 'on' : ''} key={day} type="button" onClick={() => setDate(day)}>
              {dayChipLabel(day, index)}
              {count ? <b className="day-chip-count">{count}</b> : null}
            </button>
          );
        })}
        <input
          aria-label="Другая дата"
          type="date"
          value={date}
          min={shiftDate(TODAY, -60)}
          max={shiftDate(TODAY, 180)}
          onChange={(event) => event.target.value && setDate(event.target.value)}
        />
      </div>

      <div className="card wide day-grid-card my-calendar">
        <div className="my-calendar-head">
          <strong>{displayDate(date)}</strong>
          <span>{hours.start != null ? `${minutesLabel(hours.start)}–${minutesLabel(hours.end)}` : 'выходной'}</span>
        </div>
        <div className="day-grid" style={{ '--columns': 1 }}>
          <div className="day-grid-axis" style={{ height }}>
            {hourMarks.map((minute) => (
              <span key={minute} style={{ top: (minute - frame.start) * MINUTE_PX }}>{minutesLabel(minute)}</span>
            ))}
          </div>
          <div className="day-grid-column" style={{ height }}>
            {hourMarks.map((minute) => <i className="day-grid-line" key={minute} style={{ top: (minute - frame.start) * MINUTE_PX }} />)}
            {hours.start == null ? (
              <div className="day-grid-off" style={{ top: 0, height }} />
            ) : (
              <>
                {hours.start > frame.start ? <div className="day-grid-off" style={{ top: 0, height: (hours.start - frame.start) * MINUTE_PX }} /> : null}
                {hours.end < frame.end ? <div className="day-grid-off" style={{ top: (hours.end - frame.start) * MINUTE_PX, height: (frame.end - hours.end) * MINUTE_PX }} /> : null}
              </>
            )}
            {bookings.map((appointment) => {
              const position = blockPosition(appointment, frame.start, MINUTE_PX);
              const overdue = isOverdueBooking(appointment, new Date(), controlSince);
              return (
                <button
                  className={`booking-block is-${appointment.status}${appointment.source === 'web' ? ' is-web' : ''}${overdue ? ' is-overdue' : ''}`}
                  key={appointment.id}
                  style={{ top: position.top, height: position.height }}
                  type="button"
                  onClick={() => setOpenId(appointment.id)}
                >
                  <b>{tashkentParts(appointment.starts_at).time}</b> {appointment.client_name}
                  <small>{appointment.service_name}</small>
                </button>
              );
            })}
            {date === TODAY && nowMinutes >= frame.start && nowMinutes <= frame.end ? (
              <i className="day-grid-now" style={{ top: (nowMinutes - frame.start) * MINUTE_PX }} />
            ) : null}
          </div>
        </div>
        {!bookings.length ? <p className="hint">В этот день записей нет.</p> : null}
      </div>

      {openBooking ? (
        <BookingSheet
          appointment={openBooking}
          data={data}
          reload={reload}
          setError={setError}
          onClose={closeBooking}
          onVisit={onVisit ? (appointment) => { closeBooking(); onVisit(appointment); } : null}
        />
      ) : null}
    </section>
  );
}

// «Мои записи» in a master's working day: today's and the coming week's,
// with the overdue ones first and in red until he closes them.
function MyBookings({ data, masterId, reload, setError, onVisit }) {
  const [chooser, setChooser] = useState(null);
  const controlSince = data.settings.booking_control_since || null;
  const mine = data.appointments
    .filter((appointment) => String(appointment.master_id) === String(masterId) && isOpenBooking(appointment))
    .filter((appointment) => isControlledBooking(appointment, controlSince))
    .filter((appointment) => tashkentParts(appointment.starts_at).date <= shiftDate(TODAY, 7))
    .sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at)));
  if (!mine.length) return null;

  return (
    <div className="card my-bookings">
      <h2>{data.role === 'master' ? 'Мои записи' : 'Записи мастера'}</h2>
      <div className="rows">
        {mine.map((appointment) => {
          const overdue = isOverdueBooking(appointment, new Date(), controlSince);
          const visitReady = canRecordVisit(appointment);
          const started = new Date(appointment.starts_at).getTime() <= Date.now();
          return (
            <div className={`row my-booking${overdue ? ' is-overdue' : ''}`} key={appointment.id}>
              <div>
                <strong>{bookingTimeLine(appointment)} · {appointment.client_name}</strong>
                <span>{appointment.service_name} · <span className="no-wrap">{appointment.client_phone || 'без номера'}</span></span>
                {overdue ? <span className="approval rejected">Закройте запись</span> : null}
                {chooser?.id === appointment.id ? (
                  <OutcomeChooser appointment={appointment} initialMode={chooser.mode} reload={reload} setError={setError} onDone={() => setChooser(null)} />
                ) : (
                  <div className="outcome-actions">
                    {visitReady ? <button className="btn" type="button" onClick={() => onVisit(appointment)}>Пришёл</button> : null}
                    {started
                      ? <button className="btn ghost" type="button" onClick={() => setChooser({ id: appointment.id, mode: 'no_show' })}>Не пришёл</button>
                      : <button className="btn ghost" type="button" onClick={() => setChooser({ id: appointment.id, mode: 'cancel' })}>Отменить</button>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// What a master reads under «Я пришёл»: when his shift starts by the schedule,
// and from when an arrival counts as late.
function shiftStartHint(start, lateAfter) {
  if (!start) return lateAfter ? `Опоздание — после ${lateAfter}.` : 'По графику сегодня выходной.';
  if (!lateAfter || lateAfter === start) return `Смена с ${start}.`;
  return `Смена с ${start}, опоздание — после ${lateAfter}.`;
}

function MasterView({ data, reload, setError, visitDraft, onDraftUsed }) {
  const [selectedMaster, setSelectedMaster] = useState(data.me || data.activeMasters[0]?.name || '');
  const [payType, setPayType] = useState(null);
  const [amount, setAmount] = useState('');
  const [split, setSplit] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState({ cash: '', card: '', qr: '' });
  // The visit's client.
  const [visitClient, setVisitClient] = useState(null);
  // «Я пришёл» is busy from the first tap, while the phone finds its place.
  const [arriving, setArriving] = useState(false);
  const [arrivalMessage, setArrivalMessage] = useState('');
  // The booking this visit closes, when it starts from «Пришёл».
  const [visitBooking, setVisitBooking] = useState(null);
  // The overdue booking whose «Не пришёл» reasons are open in the visit card.
  const [closingId, setClosingId] = useState(null);
  const formRef = useRef(null);
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('master', 'day');
  const setMessage = useNotice();
  const [requestId, setRequestId] = useState(newRequestId);
  const { run, busy } = useAction(setError, setMessage);

  const canPickMaster = data.role === 'admin';
  const masterName = data.role === 'master' ? data.me : selectedMaster;
  const masterProfile = data.byName[masterName];
  const range = getRange(period, customFrom, customTo, data.sales);
  const masterSales = data.sales.filter((sale) => sale.master === masterName);
  const todaySales = masterSales.filter((sale) => rowDate(sale) === TODAY);
  // The owner decides on a sale the next morning, and the list below only
  // shows today, so a rejected sale never reached the master who entered it.
  // It now waits at the top until he confirms he has seen it.
  const [seenRejected, setSeenRejected] = useState(readSeenRejected);
  const recentRejected = data.role === 'master'
    ? masterSales
      .filter((sale) => (
        isRejectedByOwner(sale)
        && rowDate(sale) >= shiftDate(TODAY, -7)
        && !seenRejected.includes(String(sale.id))
      ))
      .sort(newestFirst)
    : [];

  function acknowledgeRejected() {
    const ids = [...new Set([...seenRejected, ...recentRejected.map((sale) => String(sale.id))])].slice(-200);
    try {
      localStorage.setItem(SEEN_REJECTED_KEY, JSON.stringify(ids));
    } catch {
      // Without storage the notice returns on the next launch, which is the
      // safer way for it to fail.
    }
    setSeenRejected(ids);
  }

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
  const pendingPay = Math.round(grossMasterPayForSales(
    masterSales.filter((sale) => isPendingOwnerApproval(sale) && inRange(rowDate(sale), range.from, range.to)),
    masterProfile,
  ));
  const attendanceToday = data.attendance.find((item) => item.master === masterName && rowDate(item) === TODAY);
  const shiftStart = shiftStartFor(
    masterProfile,
    TODAY,
    data.scheduleRules,
    lateRuleFromSettings(data.settings),
  );
  const scheduledStart = scheduledStartOn(masterProfile, TODAY, data.scheduleRules);
  // A master records no other visit while a booking of his has ended and is
  // still open (owner's decision of 2026-10-16). He used to learn it only
  // after filling the form in; the visit card now opens with that booking
  // and its two buttons (owner's review of 2026-10-26).
  const toClose = data.role === 'master' && !visitBooking
    ? data.appointments
      .filter((appointment) => String(appointment.master_id) === String(masterProfile?.id))
      .filter((appointment) => isOverdueBooking(appointment, new Date(), data.settings.booking_control_since || null))
      .sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at)))
    : [];

  useEffect(() => {
    if (!masterName && data.activeMasters[0]?.name) setSelectedMaster(data.activeMasters[0].name);
  }, [data.activeMasters, masterName]);

  // «Пришёл» fills the visit from the booking: the client, its master and
  // the price of its services. The master only picks how it was paid.
  function startVisit(appointment) {
    const bookingMaster = data.masters.find((master) => String(master.id) === String(appointment.master_id));
    if (bookingMaster && canPickMaster) setSelectedMaster(bookingMaster.name);
    setVisitClient(clientFromBooking(appointment));
    setSplit(false);
    setPayType(null);
    setAmount(appointment.price_uzs ? String(appointment.price_uzs) : '');
    setVisitBooking(appointment);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  useEffect(() => {
    if (!visitDraft) return;
    startVisit(visitDraft);
    onDraftUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitDraft]);

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
    if (!visitClient) return setError('Выберите клиента или создайте карточку.');
    if (visitClient.needs_surname) return setError(ACTION_ERROR_TEXT.client_surname_required);
    if (toClose.length) return setError(unclosedText(toClose));

    const payload = {
      master: masterName,
      d: TODAY,
      ...amounts,
      ...(visitClient.guest
        ? { guest: true, known_before: visitClient.known_before }
        : { client_id: visitClient.id }),
      appointment_id: visitBooking ? visitBooking.id : undefined,
      // Held across retries of this same sale, so a reply lost on a bad
      // connection cannot turn one haircut into two rows.
      client_request_id: requestId,
    };

    const ok = await run(
      () => callLegacyApi('addSale', payload),
      data.role === 'master' ? 'Визит отправлен на подтверждение.' : 'Визит сохранён.',
    );
    if (!ok) return;
    // Saved is saved: the lists catch up behind the message.
    haptic('success');
    reload();

    setRequestId(newRequestId());
    setPayType(null);
    setAmount('');
    setSplit(false);
    setSplitAmounts({ cash: '', card: '', qr: '' });
    setVisitClient(null);
    setVisitBooking(null);
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
    const ok = await run(() => callLegacyApi('delSale', { id }), 'Продажа удалена.');
    if (ok) reload();
  }

  // «Я пришёл» first asks the phone where it is, which can take seconds; the
  // button used to look untouched all that time and got tapped again, each tap
  // a check-in of its own. It now says what it is doing from the first tap,
  // and the answer appears under it.
  async function markArrival() {
    if (arriving) return;
    setArriving(true);
    setArrivalMessage('');
    try {
      await checkIn();
    } finally {
      setArriving(false);
    }
  }

  async function checkIn() {
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
    // phone clock decide whether an arrival counts as late. A late arrival is
    // fined there and then, and the master is told so.
    let fine = null;
    const ok = await run(async () => {
      const result = await callLegacyApi('setAttendance', { master: masterName, d: TODAY });
      fine = result?.fine || null;
    });
    if (!ok) return;
    haptic('success');
    setArrivalMessage(fine?.new
      ? `Приход отмечен. Опоздание ${fine.minutes} мин — штраф ${money(fine.amount)} сум.`
      : 'Приход отмечен.');
    reload();
  }

  async function resetArrival() {
    if (!await confirmAction('Убрать отметку о приходе за сегодня?')) return;
    setArrivalMessage('');
    const ok = await run(() => callLegacyApi('delAttendance', { master: masterName, d: TODAY }));
    if (!ok) return;
    setArrivalMessage('Отметка убрана.');
    reload();
  }

  return (
    <section className="view-grid">
      {recentRejected.length ? (
        <div className="card wide rejected-alert" role="alert">
          <div className="rejected-alert-head">
            <strong>
              Отклонено владельцем: {recentRejected.length} {pluralRu(recentRejected.length, 'продажа', 'продажи', 'продаж')}
            </strong>
            <span>Они не вошли ни в выручку, ни в ваш заработок.</span>
          </div>
          <Rows
            rows={recentRejected}
            empty=""
            render={(sale) => (
              <div className="row sale-rejected" key={sale.id}>
                <div>
                  <strong className="sale-amount">{money(saleTotal(sale))} сум</strong>
                  <span>{displayDate(rowDate(sale))} · {paymentLabel(sale)} · клиентов {clients(sale)}</span>
                  <span>Внесено: {displayDateTime(sale.created_at)}</span>
                </div>
              </div>
            )}
          />
          <p className="hint">Если сумма была неверной — внесите продажу заново. Если отклонили по ошибке — напишите владельцу.</p>
          <button className="btn rejected-alert-ok" type="button" onClick={acknowledgeRejected}>Понятно</button>
        </div>
      ) : null}
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
            <button className="btn ghost" type="button" onClick={resetArrival} disabled={busy}>{busy ? 'Сохраняю…' : 'Убрать отметку'}</button>
            {arrivalMessage ? <p className="success">{arrivalMessage}</p> : null}
          </>
        ) : (
          <>
            <button className="btn" type="button" onClick={markArrival} disabled={busy || arriving || !masterName}>
              {busy ? 'Отмечаю…' : arriving ? 'Проверяем место…' : data.role === 'master' ? 'Я пришёл' : 'Отметить приход'}
            </button>
            {arrivalMessage ? <p className="success">{arrivalMessage}</p> : null}
            <p className="hint">
              {shiftStartHint(scheduledStart, shiftStart)}
            </p>
          </>
        )}
      </div>

      <MyBookings data={data} masterId={masterProfile?.id} reload={reload} setError={setError} onVisit={startVisit} />

      <form className="card" onSubmit={submitSale} ref={formRef}>
        <h2>Визит</h2>
        {toClose.length ? (
          <div className="visit-blocked" role="status">
            <strong>Сначала закройте запись</strong>
            <span>{bookingTimeLine(toClose[0])} · {toClose[0].client_name}</span>
            {closingId === toClose[0].id ? (
              <OutcomeChooser appointment={toClose[0]} initialMode="no_show" reload={reload} setError={setError} onDone={() => setClosingId(null)} />
            ) : (
              <div className="outcome-actions">
                {canRecordVisit(toClose[0]) ? <button className="btn" type="button" onClick={() => startVisit(toClose[0])}>Пришёл</button> : null}
                <button className="btn ghost" type="button" onClick={() => setClosingId(toClose[0].id)}>Не пришёл</button>
              </div>
            )}
          </div>
        ) : null}
        {visitBooking ? (
          <div className="picker-selected visit-booking">
            <span>
              <strong>По записи · {tashkentParts(visitBooking.starts_at).time}</strong>
              <small>{visitBooking.service_name}</small>
            </span>
            <button className="link-button" type="button" onClick={() => setVisitBooking(null)}>Без записи</button>
          </div>
        ) : null}
        <ClientPicker
          client={visitClient}
          onChange={setVisitClient}
          setError={setError}
          allowGuest={!visitBooking}
          scanTitle={data.role === 'master' ? 'Отсканировал у вашего зеркала' : 'Отсканировал у зеркала'}
          scanMaster={masterName}
        />
        {split ? (
          <div className="split-amounts">
            {PAYMENT_METHODS.map(([key, label]) => (
              <label className={`split-amount is-${key}`} key={key}>
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
            {/* «Пришёл» knows the booking's price; what is left to place is said. */}
            {visitBooking?.price_uzs && splitTotal !== Number(visitBooking.price_uzs) ? (
              <p className="split-left">
                {splitTotal < Number(visitBooking.price_uzs)
                  ? `По записи ${money(visitBooking.price_uzs)} сум · осталось ${money(Number(visitBooking.price_uzs) - splitTotal)}`
                  : `По записи ${money(visitBooking.price_uzs)} сум · больше на ${money(splitTotal - Number(visitBooking.price_uzs))}`}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="pay-types">
              {PAYMENT_METHODS.map(([value, label]) => (
                <button
                  aria-pressed={payType === value}
                  className={`pay-type is-${value} ${payType === value ? 'on' : ''}`}
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
        <button className="btn" type="submit" disabled={busy || toClose.length > 0}>
          {busy ? 'Сохраняем…' : 'Добавить'}
        </button>
      </form>

      <div className="card">
        <SectionHeading label="Сегодня" range={{ from: TODAY, to: TODAY }} />
        <Rows
          rows={[...todaySales].sort(newestFirst)}
          empty="Пока нет записей за сегодня."
          render={(sale) => (
            <div className={`row ${saleStatusClass(sale)}`} key={sale.id}>
              <div>
                <strong className="sale-amount">{money(saleTotal(sale))} сум</strong>
                <span>{sale.client_name ? <>{sale.client_name}{' · '}</> : ''}{paymentLabel(sale)} · {clientType(sale)}</span>
                <span>Внесено: {displayDateTime(sale.created_at)}</span>
                {isPendingOwnerApproval(sale) ? <span className="approval pending">Ждёт подтверждения</span> : null}
                {isRejectedByOwner(sale) ? <span className="approval rejected">Отклонено владельцем — не засчитано</span> : null}
              </div>
              {data.role === 'admin' || isPendingOwnerApproval(sale) ? (
                <button aria-label="Удалить" className="del" type="button" onClick={() => deleteSale(sale.id)}>×</button>
              ) : null}
            </div>
          )}
        />
      </div>

      {data.role === 'master' ? <MyWeek data={data} master={masterProfile} /> : null}

      <div className="card wide hero-card master-earnings">
        <SectionHeading label={data.role === 'master' ? 'Мой заработок' : 'Заработок мастера'} range={range} />
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <div className="hero">{money(pay)} <small>сум заработано</small></div>
        {/* A visit waiting for the owner counts nowhere yet, so the figure
            did not move after «Добавить» (owner's review of 2026-10-26). */}
        {pendingPay ? <p className="pending-pay">Ещё {money(pendingPay)} сум ждёт подтверждения</p> : null}
        <div className="tiles">
          {/* The rate is already in the header next to the master's name, and it
              does not change from one period to the next. A tile for it took the
              space of a figure that moves. */}
          <Tile label="Выручка" value={money(revenue)} />
          <Tile label="Штрафы" value={fineTotal ? `−${money(fineTotal)}` : '0'} danger={fineTotal > 0} />
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

function AdminView({ data, reload, setError, setView }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('money', 'month');
  const setMessage = useNotice();
  const [masterSort, setMasterSort] = useState({ key: 'revenue', direction: 'desc' });
  const [detailLimit, setDetailLimit] = useState(50);
  const [salesListOpen, setSalesListOpen] = useState(false);
  const [openMaster, setOpenMaster] = useState(null);
  const closeMaster = useCallback(() => setOpenMaster(null), []);
  const [openClient, setOpenClient] = useState(null);
  const closeClient = useCallback(() => setOpenClient(null), []);
  const isOwner = data.appRole === 'owner';
  const { run, busy } = useAction(setError, setMessage);
  // Which approval button is working, so it can say so while the rest wait.
  const [deciding, setDeciding] = useState(null);
  const readOnly = isReadOnly(data);
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
      isNew: startedAfter(firstDayOf(master, data.sales, data.attendance), priorRange),
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
    priorRange ? { ...comparisonToPrevious(current, previous, priorRange, money, { inProgress }), hint: null } : {}
  );
  // Haircuts and goods wait in one queue, and its totals cover both.
  const queue = approvalQueue(data);
  const pendingTotal = queue.total;
  const pendingMix = queue.mix;
  const productName = (id) => data.products.find((product) => String(product.id) === String(id))?.name || 'Товар';
  // The share of cash is an operational number, not trivia: it drives what has
  // to be collected and banked. A share without its previous value is a fact
  // with nothing to compare against.
  const mix = paymentMix(sales);
  const previousMix = paymentMix(previousSales);

  // Each tap used to wait for the whole history to download again, every sale
  // since February, to change one row. A decision now refreshes only the recent
  // window it can affect.
  async function setSaleApproval(sale, status) {
    if (status === 'rejected' && !await confirmAction(`Отклонить оплату: ${sale.master}, ${money(saleTotal(sale))} сум?`)) return;
    setDeciding({ id: sale.id, status });
    try {
      await run(
        () => callLegacyApi('setSaleApproval', { id: sale.id, status })
          .then(() => reload({ since: refreshWindowFor([sale]) })),
        status === 'approved' ? 'Оплата подтверждена.' : 'Оплата отклонена.',
      );
    } finally {
      setDeciding(null);
    }
  }

  function isDeciding(id, status) {
    return deciding?.id === id && deciding?.status === status;
  }

  async function setGoodsApproval(sale, status) {
    if (status === 'rejected' && !await confirmAction(`Отклонить продажу «${productName(sale.product_id)}» на ${money(sale.amount)} сум?`)) return;
    setDeciding({ id: `goods-${sale.id}`, status });
    try {
      await run(
        () => callLegacyApi('setProductSaleApproval', { id: sale.id, status })
          .then(() => reload({ since: refreshWindowFor([]) })),
        status === 'approved' ? 'Подтверждено.' : 'Отклонено.',
      );
    } finally {
      setDeciding(null);
    }
  }

  // Monday morning used to be one tap and one full reload per sale. The queue
  // is confirmed in one pass and the data is fetched once at the end.
  async function approveAllPending() {
    const items = [...queue.items];
    if (!items.length) return;
    if (!await confirmAction(`Подтвердить все (${items.length}) на ${money(pendingTotal)} сум?`)) return;

    setDeciding({ id: 'all', status: 'approved' });
    try {
      await run(async () => {
        const failures = [];
        for (const item of items) {
          try {
            await callLegacyApi(
              item.kind === 'goods' ? 'setProductSaleApproval' : 'setSaleApproval',
              { id: item.sale.id, status: 'approved' },
            );
          } catch (error) {
            failures.push(actionErrorText(error));
          }
        }
        await reload({ since: refreshWindowFor(queue.services) });
        // Thrown after the reload so the rows that did go through are already on
        // screen when the message explains the ones that did not.
        if (failures.length) throw new Error(`Не удалось подтвердить ${failures.length} из ${items.length}: ${failures[0]}`);
      }, `Подтверждено: ${items.length}.`);
    } finally {
      setDeciding(null);
    }
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
      {!readOnly && queue.count ? (
      <div className="card wide approvals-card">
        <h2>На подтверждение</h2>
        {queue.count > 1 ? (
          <div className="approve-all">
            <span>
              {queue.count} {pluralRu(queue.count, 'оплата', 'оплаты', 'оплат')} на {money(pendingTotal)} сум
            </span>
            <button className={`btn${isDeciding('all', 'approved') ? ' is-working' : ''}`} type="button" onClick={approveAllPending} disabled={busy}>
              {isDeciding('all', 'approved') ? 'Подтверждаем…' : 'Подтвердить все'}
            </button>
          </div>
        ) : null}
        {/* Card and QR money can be checked against the bank the moment it
            lands; cash only once the till is counted. The total is split the
            same way, so neither has to be picked out of the list by eye. */}
        {queue.count > 1 ? (
          <div className="pending-mix" aria-label="Сумма на подтверждение по способам оплаты">
            {PAYMENT_METHODS.filter(([key]) => pendingMix[key] > 0).map(([key, label]) => (
              <span className={`pending-mix-item is-${key}`} key={key}>
                <i className="payment-dot" aria-hidden="true" />
                {label}
                <strong>{money(pendingMix[key])}</strong>
              </span>
            ))}
          </div>
        ) : null}
        <Rows
          rows={queue.items}
          empty="Новых оплат на подтверждение нет."
          render={({ kind, key, sale }) => (kind === 'goods' ? (
            <div className="row approval-row is-goods" key={key}>
              <div>
                <strong>{productName(sale.product_id)} × {sale.qty} · {money(sale.amount)} сум</strong>
                <PaymentChips sale={goodsAsPayment(sale)} />
                <span>Товар · маржа {signedMoney(productSaleMargin(sale))}</span>
                <span>Внесено: {displayDateTime(sale.created_at)}</span>
              </div>
              <div className="approval-actions">
                <button className={`btn approval-button${isDeciding(key, 'approved') ? ' is-working' : ''}`} type="button" disabled={busy} onClick={() => setGoodsApproval(sale, 'approved')}>
                  {isDeciding(key, 'approved') ? 'Подтверждаем…' : 'Подтвердить'}
                </button>
                <button className={`btn ghost approval-button${isDeciding(key, 'rejected') ? ' is-working' : ''}`} type="button" disabled={busy} onClick={() => setGoodsApproval(sale, 'rejected')}>
                  {isDeciding(key, 'rejected') ? 'Отклоняем…' : 'Отклонить'}
                </button>
              </div>
            </div>
          ) : (
            <div className="row approval-row" key={key}>
              <div>
                <strong>{sale.master} · {money(saleTotal(sale))} сум</strong>
                <PaymentChips sale={sale} />
                <span>
                  {sale.client_id && isOwner ? (
                    <button className="master-name-button" type="button" onClick={() => setOpenClient(sale.client_id)}>{sale.client_name}</button>
                  ) : sale.client_name || `${clients(sale)} ${pluralRu(clients(sale), 'клиент', 'клиента', 'клиентов')}`}
                  {' · '}{clientType(sale)}
                </span>
                {sale.client_no_phone && !sale.is_guest ? <span className="approval rejected">без номера</span> : null}
                <span>Внесено мастером: {displayDateTime(sale.created_at)}</span>
              </div>
              <div className="approval-actions">
                <button className={`btn approval-button${isDeciding(sale.id, 'approved') ? ' is-working' : ''}`} type="button" disabled={busy} onClick={() => setSaleApproval(sale, 'approved')}>
                  {isDeciding(sale.id, 'approved') ? 'Подтверждаем…' : 'Подтвердить'}
                </button>
                <button className={`btn ghost approval-button${isDeciding(sale.id, 'rejected') ? ' is-working' : ''}`} type="button" disabled={busy} onClick={() => setSaleApproval(sale, 'rejected')}>
                  {isDeciding(sale.id, 'rejected') ? 'Отклоняем…' : 'Отклонить'}
                </button>
              </div>
            </div>
          ))}
        />
      </div>
      ) : null}

      {isOwner ? <ClientFinder setError={setError} reload={reload} /> : null}
      {openClient ? <ClientSheet clientId={openClient} onClose={closeClient} setError={setError} reload={reload} /> : null}

      <div className="wide period-block">
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <p className="period-range">{displayRange(range)}</p>
      </div>

      {/* "Выручка" everywhere, never "Итого": one word per concept, or the
          owner cannot tell whether two screens mean the same number. */}
      <div className="tiles wide screen-kpis">
        <Tile label="Выручка" value={money(revenue)} {...comparison(compareSummary.revenue, previousSummary.revenue)} />
        <Tile label="Клиентов" value={totalClients} {...comparison(compareSummary.clients, previousSummary.clients)} />
        <Tile label="Новые" value={newClients} {...comparison(compareSummary.newClients, previousSummary.newClients)} />
        <Tile label="Средний чек" value={averageCheck(revenue, totalClients)} />
      </div>

      <div className="card wide">
        <h2>Способы оплаты</h2>
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
                  ['pay', 'Заработал'],
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
              {sortedMasterSummaries.map(({ master, revenue: masterRevenue, pay, compareRevenue, comparePay, previousRevenue: masterPreviousRevenue, previousPay, clientMix, isNew }) => (
                <tr className={master.name === topMasterName ? 'master-top-row' : ''} key={master.name}>
                  <td>
                    <div className="master-name-line">
                      <button className="master-name-button" type="button" onClick={() => setOpenMaster(master)}>
                        <strong>{master.name}</strong>
                      </button>
                      {master.name === topMasterName ? <span className="master-top-mark" aria-label="Лидер по выручке" title="Лидер по выручке">★</span> : null}
                    </div>
                    <small>
                      {clientMix.clients} {pluralRu(clientMix.clients, 'клиент', 'клиента', 'клиентов')}
                      {clientMix.unlabeled ? ` · тип не указан: ${clientMix.unlabeled}` : ''}
                    </small>
                    {/* The split is repeated here on purpose: on a phone the
                        table shows the name and the revenue without scrolling,
                        and the columns further right carry the sort and the
                        comparison. Its own line, or the name column grows to
                        fit it and pushes the revenue off the screen. */}
                    {clientMix.clients ? (
                      <small>новых&nbsp;{clientMix.newClients} · постоянных&nbsp;{clientMix.returningClients}</small>
                    ) : null}
                  </td>
                  <td>
                    <small className="master-cell-label">Выручка</small>
                    <span className="master-metric-value">{money(masterRevenue)} сум</span>
                    {priorRange ? <MasterMetricComparison current={compareRevenue} previous={masterPreviousRevenue} inProgress={inProgress} isNew={isNew} /> : null}
                  </td>
                  <td>
                    <small className="master-cell-label">Заработал</small>
                    <strong className="master-metric-value">{money(pay)} сум</strong>
                    {priorRange && !isNew ? <MasterMetricComparison current={comparePay} previous={previousPay} inProgress={inProgress} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* It said «Итого выплатить мастерам», but it is the period's gross
            earnings; what to hand over, after fines, advances and what was
            already paid, is on «Выплаты» (owner's review of 2026-10-26). */}
        <div className="payout-total"><span>Мастера заработали за период</span><strong>{money(totalMasterPayout)} сум</strong></div>
        {['owner', 'partner'].includes(data.appRole) && setView ? (
          <button className="link-button payout-total-link" type="button" onClick={() => setView('payouts')}>Сколько выдать — в «Выплатах» →</button>
        ) : null}
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
                  <span>
                    {sale.client_id && isOwner ? (
                      <button className="master-name-button" type="button" onClick={() => setOpenClient(sale.client_id)}>{sale.client_name}</button>
                    ) : sale.client_name || `${clients(sale)} ${pluralRu(clients(sale), 'клиент', 'клиента', 'клиентов')}`}
                    {' · '}{clientType(sale)}
                  </span>
                </div>
                <div className="detailed-sale-amounts">
                  <strong>{money(amount)} сум</strong>
                  <span>мастеру: {money(masterEarning)} сум</span>
                  {readOnly ? null : (
                    <button className="del detailed-sale-delete" disabled={!canDelete} title={canDelete ? 'Удалить продажу' : 'Срок удаления 2 дня истёк'} type="button" onClick={() => deleteDetailedSale(sale)}>×</button>
                  )}
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

const ATTENDANCE_STATUS_LABELS = {
  'on-time': 'пришёл вовремя',
  late: 'опоздал',
  'day-off': 'выходной',
  missing: 'не отметился — поставьте время или выходной',
  pending: 'ещё нет отметки',
};

function AttendanceView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('attendance', 'day');
  // No master is chosen for you (owner's review of 2026-10-26): the first
  // one in the list used to be, and a fine went to Жавохир unnoticed.
  const [fineForm, setFineForm] = useState({
    master: '',
    d: TODAY,
    amount: '',
    reason: FINE_REASONS[0].value,
  });
  const setMessage = useNotice();
  const [savingFineKey, setSavingFineKey] = useState('');
  const [savingDayOffKey, setSavingDayOffKey] = useState('');
  const [showAllDays, setShowAllDays] = useState(false);
  const [fineFormOpen, setFineFormOpen] = useState(false);
  const { run, busy } = useAction(setError, setMessage);
  // A read-only account gets the shift and the register, without fines and
  // without anything that changes a day.
  const readOnly = isReadOnly(data);
  const range = getRange(period, customFrom, customTo, data.attendance);
  const filteredFines = data.fines
    .filter((fine) => inRange(rowDate(fine), range.from, range.to))
    .sort(newestFirst);
  const lateRule = lateRuleFromSettings(data.settings);
  const grid = attendanceGrid({
    masters: data.masters,
    attendance: data.attendance,
    dayStatuses: data.dayStatuses,
    scheduleRules: data.scheduleRules,
    sales: data.sales,
    range,
    today: TODAY,
    lateRule,
  });
  // Per-day rows answer "who is here today"; the totals answer "who is
  // habitually late or missing, and what has it cost".
  const totals = attendanceTotals(grid);
  const finesByMaster = (master) => totalFines(filteredFines.filter((fine) => belongsToMaster(fine, master)));
  const newestRows = [...grid].sort((left, right) => right.d.localeCompare(left.d));
  const needsAttention = newestRows.filter((row) => row.status === 'missing' || row.status === 'late');
  const attendanceRows = period === 'day' ? grid : showAllDays ? newestRows : needsAttention;
  const todayRows = grid.filter((row) => row.d === TODAY && row.status !== 'day-off');
  const expectedToday = period === 'day' ? todayRows.length : 0;
  const presentToday = todayRows.filter((row) => row.status === 'on-time' || row.status === 'late').length;
  const fineTotalForPeriod = totalFines(filteredFines);
  const fineSummary = Object.values(filteredFines.reduce((groups, fine) => {
    const name = fine.master || 'Без мастера';
    const entry = groups[name] || { name, count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += Number(fine.amount) || 0;
    groups[name] = entry;
    return groups;
  }, {})).sort((left, right) => right.amount - left.amount);

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
    if (!fineForm.master) return setError('Выберите мастера.');
    if (!amount || amount <= 0) return setError('Введите сумму штрафа.');
    if (!fineForm.reason) return setError('Выберите причину штрафа.');
    // The partner cannot take a fine back, so it is said in full before it
    // is set, with a word when that master was not working that day.
    const master = data.byName[fineForm.master];
    const hours = master ? masterHoursOn(master, fineForm.d, data.scheduleRules, data.dayStatuses) : null;
    const notWorking = hours && hours.start == null ? `У мастера ${fineForm.master} в этот день выходной. ` : '';
    const reason = fineReasonLabel(fineForm.reason).toLowerCase();
    if (!await confirmAction(`${notWorking}Штраф ${money(amount)} сум — ${fineForm.master}, ${reason}, ${displayDate(fineForm.d)}?`)) return;
    const ok = await createFine(fineForm.master, fineForm.d, amount, fineForm.reason);
    if (ok) setFineForm((current) => ({ ...current, amount: '' }));
  }

  async function addLateFine(item) {
    const key = `${item.master}-${rowDate(item)}`;
    setSavingFineKey(key);
    try {
      await createFine(item.master, rowDate(item), lateFineAmount(data.settings), 'late');
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
      <div className="wide period-block">
        <PeriodPicker
          period={period}
          setPeriod={setPeriod}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
        />
        <p className="period-range">{displayRange(range)}</p>
      </div>

      <div className="card wide attendance-card">
        <div className="section-heading">
          <h2>{period === 'day' ? 'Смена сегодня' : 'Табель'}</h2>
          {period === 'day' && expectedToday ? (
            <span className={`date-badge ${presentToday === expectedToday ? 'is-positive' : ''}`}>
              {presentToday} из {expectedToday} на месте
            </span>
          ) : null}
        </div>
        {period !== 'day' && totals.length ? (
          <div className="attendance-totals" aria-label="Табель за период">
            {totals.map((total) => {
              const fineSum = finesByMaster(total.master);
              return (
                <div className="attendance-total" key={total.master.id ?? total.master.name}>
                  <div className="attendance-total-head">
                    <strong>{total.master.name}</strong>
                    {fineSum ? <span className="danger">штрафы −{money(fineSum)}</span> : null}
                  </div>
                  <div className="attendance-total-counts">
                    <span className={`on-time ${total.onTime ? '' : 'is-zero'}`}>вовремя {total.onTime}</span>
                    <span className={`late ${total.late ? '' : 'is-zero'}`}>
                      опоздал {total.late}{total.lateMinutes ? ` · ${total.lateMinutes} мин` : ''}
                    </span>
                    <span className={`day-off ${total.dayOff ? '' : 'is-zero'}`}>выходной {total.dayOff}</span>
                    <span className={`missing ${total.missing ? '' : 'is-zero'}`}>нет отметки {total.missing}</span>
                  </div>
                  {total.days.length <= 31 ? (
                    <div className="attendance-strip" aria-hidden="true">
                      {total.days.map((day) => (
                        <i className={day.status} key={day.d} title={`${displayDate(day.d)}: ${ATTENDANCE_STATUS_LABELS[day.status]}`} />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <p className="hint">
              {lateRule.since && TODAY >= lateRule.since
                ? `Опоздание считается от начала смены мастера по его графику, допуск ${lateRule.graceMinutes} мин.`
                : `Опоздание считается от начала смены мастера по графику, но не раньше ${lateRule.shiftStart}.`}{' '}
              «Нет отметки» — прошедший день без прихода и без выходного.
            </p>
          </div>
        ) : null}
        {period !== 'day' ? (
          <div className="attendance-list-heading">
            <strong>{showAllDays ? `Все дни · ${newestRows.length}` : `Требуют внимания · ${needsAttention.length}`}</strong>
            <button className="btn ghost" type="button" onClick={() => setShowAllDays((all) => !all)}>
              {showAllDays ? 'Только проблемные' : 'Показать все дни'}
            </button>
          </div>
        ) : null}
        <div className="attendance-list">
          {attendanceRows.length ? attendanceRows.map((row) => {
            const masterName = row.master.name;
            const arrived = displayTime(row.arrived);
            const dayOffKey = `${row.master.id}-${row.d}`;
            const fineKey = `${masterName}-${row.d}`;
            const quickFineExists = data.fines.some((fine) => (
              belongsToMaster(fine, row.master)
              && rowDate(fine) === row.d
              && (fine.reason === 'late' || fine.auto)
            ));
            const dayOffButton = (
              <button
                className={`day-off-button ${row.dayOff ? 'active' : ''}`}
                disabled={savingDayOffKey === dayOffKey}
                type="button"
                onClick={() => toggleDayOff(masterName, row.d, !row.dayOff)}
              >
                {savingDayOffKey === dayOffKey
                  ? 'Сохраняю…'
                  : row.dayOff ? 'Отменить выходной' : 'Выходной'}
              </button>
            );

            return (
              <div className={`attendance-row ${row.status}`} key={`${masterName}-${row.d}`}>
                <div className="attendance-person">
                  <strong>{masterName}</strong>
                  <span>{displayDate(row.d)}</span>
                  <span className="attendance-status">
                    {row.status === 'late'
                      ? `опоздал на ${row.lateBy} мин`
                      : row.status === 'day-off' && !row.dayOff
                        ? 'выходной по графику'
                        : row.status === 'missing' && readOnly
                          ? 'не отметился'
                          : ATTENDANCE_STATUS_LABELS[row.status]}
                  </span>
                </div>
                {readOnly ? (
                  // The partner sets days off (decision of 2026-10-16), and
                  // nothing else on this sheet: his fines go through «+ Выставить
                  // штраф» below, a late arrival being fined on its own.
                  <div className="attendance-actions">
                    {arrived ? <span className="attendance-time">{arrived}</span> : null}
                    {row.record ? null : dayOffButton}
                  </div>
                ) : (
                <div className="attendance-actions">
                  <input
                    aria-label={`Время прихода ${masterName} ${displayDate(row.d)}`}
                    type="time"
                    defaultValue={arrived}
                    disabled={row.dayOff}
                    onBlur={(event) => saveAttendance(masterName, row.d, event.target.value)}
                  />
                  {dayOffButton}
                  {row.status === 'late' ? (
                    <button
                      className="fine-button"
                      disabled={quickFineExists || savingFineKey === fineKey}
                      title={`Штраф ${money(lateFineAmount(data.settings))} сум`}
                      type="button"
                      onClick={() => addLateFine({ master: masterName, d: row.d })}
                    >
                      {quickFineExists ? 'Штраф выставлен' : savingFineKey === fineKey ? 'Сохраняю…' : 'Штраф'}
                    </button>
                  ) : null}
                </div>
                )}
              </div>
            );
          }) : (
            <p className="hint">
              {period === 'day' || showAllDays
                ? 'За выбранный период мастеров нет.'
                : 'Пропусков и опозданий за период нет — все дни отмечены.'}
            </p>
          )}
        </div>
      </div>

      {/* The partner fines too (owner's request of 2026-10-21); taking a
          fine back stays the owner's. */}
      <div className="card wide fines-card">
        <div className="section-heading">
          <span className="fines-heading">
            <h2>Штрафы</h2>
            <small>
              {filteredFines.length
                ? `${filteredFines.length} ${pluralRu(filteredFines.length, 'штраф', 'штрафа', 'штрафов')} за период`
                : 'за период штрафов нет'}
            </small>
          </span>
          {fineTotalForPeriod ? <strong className="fines-total">−{money(fineTotalForPeriod)}</strong> : null}
        </div>
        {fineSummary.length ? (
          <div className="fine-summary">
            {fineSummary.map((row) => (
              <div className="fine-summary-row" key={row.name}>
                <div>
                  <strong>{row.name}</strong>
                  <span>{row.count} {pluralRu(row.count, 'штраф', 'штрафа', 'штрафов')} · <b>−{money(row.amount)}</b></span>
                </div>
                <i aria-hidden="true"><b style={{ width: `${(row.amount / fineSummary[0].amount) * 100}%` }} /></i>
              </div>
            ))}
          </div>
        ) : null}
        {fineFormOpen ? (
          <form className="fine-form" onSubmit={addFine}>
            <label>
              Мастер
              <select value={fineForm.master} onChange={(event) => setFineForm({ ...fineForm, master: event.target.value })}>
                <option value="" disabled>Выберите мастера</option>
                {data.activeMasters.map((master) => <option key={master.name} value={master.name}>{master.name}</option>)}
              </select>
            </label>
            <label>
              Дата
              <input type="date" value={fineForm.d} onChange={(event) => setFineForm({ ...fineForm, d: event.target.value })} />
            </label>
            <label>
              Причина
              <select value={fineForm.reason} onChange={(event) => setFineForm({ ...fineForm, reason: event.target.value })}>
                {FINE_REASONS.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
              </select>
            </label>
            <label>
              Сумма
              <MoneyInput placeholder="например, 50 000" value={fineForm.amount} onChange={(amount) => setFineForm({ ...fineForm, amount })} />
            </label>
            <div className="fine-form-actions">
              <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Выставить штраф'}</button>
              <button className="btn ghost" type="button" onClick={() => setFineFormOpen(false)}>Отмена</button>
            </div>
          </form>
        ) : (
          <button className="btn ghost fine-open" type="button" onClick={() => setFineFormOpen(true)}>+ Выставить штраф</button>
        )}
        {filteredFines.length ? (
          <details className="fine-list">
            <summary>Все штрафы за период · {filteredFines.length}</summary>
          <Rows rows={filteredFines} empty="Штрафов за период нет." render={(fine) => {
            const canDelete = recentFineCanBeDeleted(rowDate(fine));
            return (
              <div className="row fine-row" key={fine.id}>
                <div>
                  <strong>{fine.master}</strong>
                  <span>{displayDate(rowDate(fine))} · −{money(fine.amount)} сум</span>
                  <span>{fineReasonLabel(fine.reason)}{fine.auto ? ' · авто' : ''}</span>
                </div>
                {readOnly ? null : (
                  <button
                    aria-label="Удалить штраф"
                    className="del"
                    disabled={!canDelete}
                    title={canDelete ? 'Удалить штраф' : 'Срок удаления 7 дней истёк'}
                    type="button"
                    onClick={() => deleteFine(fine)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          }} />
          </details>
        ) : null}
      </div>
    </section>
  );
}

const EXPENSE_SECTION_LABELS = { ishxona: 'Салон', murod: 'Мурод', jamshid: 'Жамшид' };

function FinanceView({ data, reload, setError }) {
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('money', 'month');
  const [tab, setTab] = useState('ishxona');
  const [form, setForm] = useState({ date: TODAY, section: 'ishxona', name: '', qty: '', amount_uzs: '', usd_rate: localStorage.getItem('usdRate') || '12200', minus_from: '' });
  // The rent offset starts with no sum (owner's review of 2026-10-26): 500 USD
  // stood there ready, and one stray «Сохранить» wrote 6,1 млн.
  const [offsetForm, setOffsetForm] = useState({ date: TODAY, owner: 'jamshid', amount_usd: '', usd_rate: localStorage.getItem('usdRate') || '12200', note: '' });
  const setMessage = useNotice();
  const [offsetsOpen, setOffsetsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { run, busy } = useAction(setError, setMessage);
  // A read-only account sees how much was spent, never on what; the server
  // does not send the names either.
  const readOnly = isReadOnly(data);
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
  const compareIshxonaExpenses = totalExpenses(operatingExpenses(expensesIn(compareRange)));
  // The one line that explains most of a month's spending.
  const biggestExpense = [...operatingExpenses(expenses)]
    .sort((left, right) => (Number(right.amount_uzs) || 0) - (Number(left.amount_uzs) || 0))[0] || null;
  const biggestShare = biggestExpense && ishxonaExpenses ? ((Number(biggestExpense.amount_uzs) || 0) / ishxonaExpenses) * 100 : 0;
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
      <div className="wide period-block">
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <p className="period-range">{displayRange(range)}</p>
      </div>

      {/* This screen is one side of the ledger: money that left. Revenue,
          payouts and profit belong on Продажи and Главная. */}
      <div className="card wide hero-card revenue-hero expense-hero">
        <div className="revenue-hero-top">
          <span>Расходы салона {period === 'month' ? `за ${monthName(TODAY)}` : period === 'day' ? 'за сегодня' : 'за период'}</span>
          {priorRange ? <DeltaChip current={compareIshxonaExpenses} previous={previousIshxonaExpenses} inProgress={inProgress} invert /> : null}
        </div>
        <div className="revenue-hero-value">
          <strong><CountUp value={ishxonaExpenses} /></strong>
          <span>сум</span>
        </div>
        {priorRange ? (
          <span className="revenue-hero-note">{comparisonLabel(priorRange, TODAY)} было {compactMoney(previousIshxonaExpenses)}</span>
        ) : null}
        {!readOnly && biggestExpense && ishxonaExpenses > 0 ? (
          <div className="expense-biggest">
            <div className="expense-biggest-head">
              <span>Крупнейшая статья</span>
              {/* The name gives way; the sum is never cut. */}
              <strong><span className="expense-biggest-name">{biggestExpense.name || 'без названия'}</span> · {compactMoney(biggestExpense.amount_uzs)}</strong>
            </div>
            <div className="expense-biggest-track" aria-hidden="true">
              <i style={{ width: `${Math.min(100, biggestShare)}%` }} />
            </div>
            <span>{`${Math.round(biggestShare)}% всех расходов ${period === 'month' ? 'месяца' : 'периода'}`}</span>
          </div>
        ) : null}
        {offsetIncome ? (
          <div className="revenue-hero-inset">
            <span>Безденежный доход · касса не меняется</span>
            <strong>{money(offsetIncome)}</strong>
          </div>
        ) : null}
      </div>


      <div className="card wide">
        <h2>Вложения</h2>
        <div className="investor-list">
          {['murod', 'jamshid'].map((owner) => {
            const item = investmentSummary(data.expenses, owner);
            const netUzs = item.invested - item.returned;
            const netUsd = item.investedUsd - item.returnedUsd;
            const returnedShare = item.investedUsd ? (item.returnedUsd / item.investedUsd) * 100 : 0;
            return (
              <div className="investor" key={owner}>
                <div className="investor-head">
                  <strong>{owner === 'murod' ? 'Мурод' : 'Жамшид'}</strong>
                  <span>{usdMoney(netUsd)}</span>
                </div>
                <div className="investor-track" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, returnedShare)}%` }} />
                </div>
                <div className="investor-meta">
                  <span>вложено {usdMoney(item.investedUsd)} · возврат {usdMoney(item.returnedUsd)}</span>
                  <b>возвращено {Math.round(returnedShare)}%</b>
                </div>
                <small>{money(netUzs)} сум</small>
              </div>
            );
          })}
          {(() => {
            const item = sectionExpense('ishxona');
            return (
              <div className="investor investor-total">
                <div className="investor-head">
                  <strong>Расходы салона за всё время</strong>
                  <span>{usdMoney(item.usd)}</span>
                </div>
                <small>{money(item.uzs)} сум</small>
              </div>
            );
          })()}
        </div>
      </div>

      {readOnly ? null : (
      <div className="card wide">
        <h2>Расходы</h2>
        <div className="seg">
          {[
            ['ishxona', 'Салон'],
            ['murod', 'Мурод'],
            ['jamshid', 'Жамшид'],
          ].map(([value, label]) => <button className={tab === value ? 'on' : ''} key={value} type="button" onClick={() => setTab(value)}>{label}</button>)}
        </div>
        <div className="section-total">
          <span>За выбранный период: {visibleExpenses.length} {pluralRu(visibleExpenses.length, 'запись', 'записи', 'записей')}</span>
          <strong>{money(visibleExpenseTotal)} сум</strong>
        </div>
        <Rows rows={visibleExpenses} empty="Записей за период нет." render={(expense) => (
          <div className="row expense-row" key={expense.id}>
            <div>
              <strong>{expense.name}{expense.category === 'stock' && expense.qty ? ` × ${expense.qty}` : ''}</strong>
              <span>
                {displayDate(rowDate(expense, 'date'))} · {expense.minus_from ? `минус ${EXPENSE_SECTION_LABELS[expense.minus_from] || expense.minus_from}` : EXPENSE_SECTION_LABELS[expense.section] || expense.section}
                {expense.category === 'stock' ? ' · закупка для склада' : ''}
              </span>
            </div>
            {/* A purchase for Склад goes with its receipt, from Склад: deleting
                the expense alone would leave paid-for goods unpaid. */}
            <div>
              <strong>{money(expense.amount_uzs)}</strong>
              {expense.category === 'stock'
                ? null
                : <button aria-label="Удалить" className="del" type="button" onClick={() => deleteExpense(expense)}>×</button>}
            </div>
          </div>
        )} />
      </div>
      )}

      {readOnly ? null : addOpen ? (
      <form className="card wide expense-form" onSubmit={addExpense}>
        <div className="section-heading">
          <h2>Добавить расход</h2>
          <button className="link-button" type="button" onClick={() => setAddOpen(false)}>Закрыть</button>
        </div>
        {/* Every field had only grey text inside it, gone once typed into, and
            the remembered dollar rate stood unnamed under the sum (owner's
            review of 2026-10-26). Short labels, as on Склад; no hints. */}
        <label>
          Дата
          <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
        </label>
        <label>
          Кто платил
          <select value={form.section} onChange={(event) => setForm({ ...form, section: event.target.value })}>
            <option value="ishxona">Салон</option>
            <option value="murod">Мурод</option>
            <option value="jamshid">Жамшид</option>
          </select>
        </label>
        <label>
          Наименование
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label>
          Количество
          <input value={form.qty} onChange={(event) => setForm({ ...form, qty: event.target.value })} />
        </label>
        <label>
          Сумма, сум
          <MoneyInput value={form.amount_uzs} onChange={(amount_uzs) => setForm({ ...form, amount_uzs })} />
        </label>
        <label>
          Курс $
          <MoneyInput value={form.usd_rate} onChange={(usd_rate) => setForm({ ...form, usd_rate })} />
        </label>
        {form.section === 'ishxona' ? (
          <label>
            Списать с вложений
            <select value={form.minus_from} onChange={(event) => setForm({ ...form, minus_from: event.target.value })}>
              <option value="">ни с кого</option>
              <option value="murod">Мурод</option>
              <option value="jamshid">Жамшид</option>
            </select>
          </label>
        ) : null}
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Добавить расход'}</button>
      </form>
      ) : (
        <button className="btn wide add-expense-button" type="button" onClick={() => setAddOpen(true)}>+ Добавить расход</button>
      )}

      {readOnly ? null : (
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
              <p className="hint">Уменьшает вложения партнёра и показывает безденежный доход. Касса и расходы салона не меняются.</p>
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
      )}

    </section>
  );
}

// The ledger, the RPCs and the listAuditEvents action were all built and the
// app never called them, so "кто это удалил" had no answer anywhere.
const PRODUCT_CATEGORIES = [['care', 'Уход'], ['drinks', 'Напитки'], ['other', 'Другое']];
const PRODUCT_CATEGORY_LABELS = Object.fromEntries(PRODUCT_CATEGORIES);
const RECEIPT_PAYERS = [['ishxona', 'Салон'], ['murod', 'Мурод'], ['jamshid', 'Жамшид'], ['opening', 'Начальный остаток']];
const RECEIPT_PAYER_LABELS = { ishxona: 'из денег салона', murod: 'деньги Мурода', jamshid: 'деньги Жамшида', opening: 'начальный остаток' };
const WRITEOFF_REASONS = [['used', 'В работу'], ['gift', 'Угостили'], ['damaged', 'Испорчен'], ['recount', 'Пересчёт']];
const WRITEOFF_REASON_LABELS = Object.fromEntries(WRITEOFF_REASONS);
const NEW_PRODUCT = 'new';

function storedUsdRate() {
  try {
    return localStorage.getItem('usdRate') || '12200';
  } catch {
    return '12200';
  }
}

function signedMoney(value) {
  const rounded = Math.round(Number(value) || 0);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${money(Math.abs(rounded))}`;
}

// Finding one product among many by typing a few letters of its name. Before
// anything is typed it offers the ones used most recently. With onCreate, a
// name that matches nothing can be added as a new product on the spot.
function ProductPicker({ options, value, onChange, onCreate, newName, placeholder = 'Найти товар' }) {
  const [query, setQuery] = useState('');
  const selected = options.find((option) => String(option.product.id) === String(value)) || null;
  const matches = options.filter((option) => productMatches(option.product, query)).slice(0, 8);
  const typed = query.trim();
  const exact = options.some((option) => normalizeProductSearch(option.product.name) === normalizeProductSearch(typed));

  function pick(option) {
    onChange(String(option.product.id));
    setQuery('');
  }

  if (selected || newName) {
    return (
      <div className="picker-selected">
        <span>
          <strong>{selected ? selected.product.name : newName}</strong>
          <small>{selected ? selected.hint : 'новый товар'}</small>
        </span>
        <button className="link-button" type="button" onClick={() => onChange('')}>Изменить</button>
      </div>
    );
  }

  return (
    <div className="picker">
      <input
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (matches.length === 1) pick(matches[0]);
        }}
      />
      <div className="picker-list" role="listbox">
        {matches.map((option) => (
          <button key={option.product.id} role="option" aria-selected="false" type="button" onClick={() => pick(option)}>
            <span>{option.product.name}</span>
            {option.hint ? <small>{option.hint}</small> : null}
          </button>
        ))}
        {onCreate && typed && !exact ? (
          <button className="picker-new" type="button" onClick={() => { onCreate(typed); setQuery(''); }}>
            + Новый товар «{typed}»
          </button>
        ) : null}
        {!matches.length && !(onCreate && typed) ? <p className="hint">Ничего не найдено</p> : null}
      </div>
    </div>
  );
}

// Склад: goods the salon resells. The owner records deliveries; the
// administrator records sales, which wait for the owner; the screen shows what
// is left and what the goods earned. A sale's amount is what the salon kept
// after the seller's share, and its margin is that amount less the average
// purchase price of the units sold (src/utils/stock.js).
function StockView({ data, reload, setError }) {
  const isOwner = data.appRole === 'owner';
  const canWrite = !isReadOnly(data) && data.appRole === 'owner';
  const { period, setPeriod, customFrom, setCustomFrom, customTo, setCustomTo } = usePeriodSelection('stock', 'month');
  const [form, setForm] = useState(null);
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);

  const emptySale = { product_id: '', qty: '1', amount: '', payment_method: null };
  const [saleForm, setSaleForm] = useState(emptySale);
  const [saleRequestId, setSaleRequestId] = useState(newRequestId);
  const [receiptForm, setReceiptForm] = useState({
    product_id: '', product_name: '', category: 'care', qty: '', unit_cost: '', paid_by: 'ishxona',
  });
  const [writeoffForm, setWriteoffForm] = useState({ product_id: '', qty: '1', reason: 'used', note: '' });

  const products = data.products;
  const levels = stockLevels({
    products,
    receipts: data.productReceipts,
    sales: data.productSales,
    writeoffs: data.productWriteoffs,
  });
  const visibleLevels = levels.filter((row) => row.product.active !== false || row.qty !== 0);
  const levelOf = (id) => levels.find((row) => String(row.product.id) === String(id)) || null;
  const nameOf = (id) => levelOf(id)?.product.name || 'товар';
  const recent = productsByRecentUse(products, data.productReceipts, data.productSales);
  const inStockOptions = recent
    .map((product) => levelOf(product.id))
    .filter((row) => row && row.qty > 0)
    .map((row) => ({ product: row.product, hint: `на складе ${row.qty}` }));
  const receiptOptions = recent.map((product) => {
    const row = levelOf(product.id);
    return { product, hint: row ? `на складе ${row.qty}` : '' };
  });
  const range = getRange(period, customFrom, customTo, data.productSales, 'sale_date');
  const summary = productSalesSummary(data.productSales, range);
  const stockValue = levels.reduce((sum, row) => sum + row.value, 0);

  const movements = [
    ...data.productReceipts.map((row) => ({ kind: 'receipt', row, date: row.receipt_date })),
    ...data.productSales.map((row) => ({ kind: 'sale', row, date: row.sale_date })),
    ...data.productWriteoffs.map((row) => ({ kind: 'writeoff', row, date: row.writeoff_date })),
  ]
    .filter((item) => inRange(item.date, range.from, range.to))
    .sort((left, right) => (
      String(right.date).localeCompare(String(left.date))
      || String(right.row.created_at || '').localeCompare(String(left.row.created_at || ''))
    ));

  function toggleForm(next) {
    setMessage('');
    setForm((current) => (current === next ? null : next));
  }

  const saleLevel = levelOf(saleForm.product_id);
  const saleQty = Number(saleForm.qty) || 0;
  const saleCost = saleLevel ? saleLevel.unitCost * saleQty : 0;
  const saleAmount = Number(saleForm.amount) || 0;

  async function submitSale(event) {
    event.preventDefault();
    if (!saleLevel) return setError('Выберите товар.');
    if (!Number.isInteger(saleQty) || saleQty < 1) return setError('Количество — целое число от 1.');
    if (saleQty > saleLevel.qty) return setError(`На складе только ${saleLevel.qty} шт. «${saleLevel.product.name}».`);
    if (!saleAmount) return setError('Введите сумму.');
    if (!saleForm.payment_method) return setError('Выберите способ оплаты.');
    const ok = await run(
      () => callLegacyApi('addProductSale', {
        product_id: saleLevel.product.id,
        qty: saleQty,
        amount: saleAmount,
        payment_method: saleForm.payment_method,
        client_request_id: saleRequestId,
      }),
      isOwner ? 'Продажа сохранена.' : 'Отправлено на подтверждение.',
    );
    if (!ok) return;
    // Saved is saved: the list catches up behind the message.
    reload();
    haptic('success');
    setSaleRequestId(newRequestId());
    setSaleForm(emptySale);
  }

  const receiptIsNew = receiptForm.product_id === NEW_PRODUCT;
  const receiptQty = Number(receiptForm.qty) || 0;
  const receiptUnitCost = Number(receiptForm.unit_cost) || 0;

  async function submitReceipt(event) {
    event.preventDefault();
    if (receiptIsNew && !receiptForm.product_name.trim()) return setError('Введите название товара.');
    if (!receiptIsNew && !receiptForm.product_id) return setError('Выберите товар.');
    if (!Number.isInteger(receiptQty) || receiptQty < 1) return setError('Количество — целое число от 1.');
    if (!receiptUnitCost) return setError('Введите цену за штуку.');
    const ok = await run(
      () => callLegacyApi('addProductReceipt', {
        product_id: receiptIsNew ? null : Number(receiptForm.product_id),
        product_name: receiptIsNew ? receiptForm.product_name.trim() : null,
        category: receiptForm.category,
        qty: receiptQty,
        unit_cost: receiptUnitCost,
        paid_by: receiptForm.paid_by,
        usd_rate: Number(storedUsdRate()) || null,
      }),
      'Приход сохранён.',
    );
    if (!ok) return;
    reload();
    haptic('success');
    setReceiptForm((current) => ({ ...current, product_id: '', product_name: '', qty: '', unit_cost: '' }));
  }

  async function submitWriteoff(event) {
    event.preventDefault();
    const level = levelOf(writeoffForm.product_id);
    const qty = Number(writeoffForm.qty) || 0;
    if (!level) return setError('Выберите товар.');
    if (!Number.isInteger(qty) || qty < 1) return setError('Количество — целое число от 1.');
    if (qty > level.qty) return setError(`На складе только ${level.qty} шт. «${level.product.name}».`);
    const ok = await run(
      () => callLegacyApi('addProductWriteoff', {
        product_id: level.product.id,
        qty,
        reason: writeoffForm.reason,
        note: writeoffForm.note.trim() || null,
      }),
      'Списано.',
    );
    if (!ok) return;
    reload();
    setWriteoffForm({ product_id: '', qty: '1', reason: 'used', note: '' });
  }

  async function deleteEntry(item) {
    const what = item.kind === 'receipt'
      ? `приход «${nameOf(item.row.product_id)}» × ${item.row.qty}`
      : item.kind === 'sale'
        ? `продажу «${nameOf(item.row.product_id)}» на ${money(item.row.amount)} сум`
        : `списание «${nameOf(item.row.product_id)}» × ${item.row.qty}`;
    if (!await confirmAction(`Удалить ${what}?`)) return;
    await run(
      () => callLegacyApi('delStockEntry', { kind: item.kind, id: item.row.id }).then(reload),
      'Удалено.',
    );
  }

  async function hideProduct(product) {
    if (!await confirmAction(`Убрать «${product.name}» из списка?`)) return;
    await run(() => callLegacyApi('setProductActive', { product_id: product.id, active: false }).then(reload), 'Убрано из списка.');
  }

  const canDelete = (item) => canWrite && (
    isOwner
      ? item.date >= shiftDate(TODAY, -2)
      : item.kind === 'sale' && item.row.status === 'pending'
  );

  return (
    <section className="view-grid">
      <div className="wide period-block">
        <PeriodPicker period={period} setPeriod={setPeriod} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} />
        <p className="period-range">{displayRange(range)}</p>
      </div>

      <div className="card wide hero-card revenue-hero stock-hero">
        <div className="revenue-hero-top">
          <span>Маржа с товаров {period === 'month' ? `за ${monthName(TODAY)}` : period === 'day' ? 'за сегодня' : 'за период'}</span>
        </div>
        <div className="revenue-hero-value">
          <strong><CountUp value={summary.margin} /></strong>
          <span>сум</span>
        </div>
        <div className="stock-hero-facts">
          <span>Продано<strong>{summary.qty} шт.</strong></span>
          <span>Сумма<strong>{compactMoney(summary.amount)}</strong></span>
          <span>Закупка<strong>{compactMoney(summary.cost)}</strong></span>
        </div>
        <span className="revenue-hero-note">Товар на складе: {compactMoney(stockValue)} сум</span>
      </div>


      {canWrite ? (
        <div className="wide stock-actions">
          <button className={`btn${form === 'sale' ? '' : ' ghost'}`} type="button" onClick={() => toggleForm('sale')}>Продажа</button>
          <button className={`btn${form === 'receipt' ? '' : ' ghost'}`} type="button" onClick={() => toggleForm('receipt')}>Приход</button>
          <button className={`btn${form === 'writeoff' ? '' : ' ghost'}`} type="button" onClick={() => toggleForm('writeoff')}>Списание</button>
        </div>
      ) : null}

      {canWrite && form === 'sale' ? (
        <form className="card wide stock-form" onSubmit={submitSale}>
          <h2>Продажа</h2>
          <ProductPicker
            options={inStockOptions}
            value={saleForm.product_id}
            onChange={(id) => setSaleForm({ ...saleForm, product_id: id })}
          />
          <div className="settings-pair">
            <label>
              Количество
              <input type="number" inputMode="numeric" min="1" step="1" value={saleForm.qty} onChange={(event) => setSaleForm({ ...saleForm, qty: event.target.value })} />
            </label>
            <label>
              Сумма
              <MoneyInput placeholder="сум" value={saleForm.amount} onChange={(value) => setSaleForm({ ...saleForm, amount: value })} />
            </label>
          </div>
          <div className="pay-types">
            {PAYMENT_METHODS.map(([value, label]) => (
              <button
                aria-pressed={saleForm.payment_method === value}
                className={`pay-type is-${value} ${saleForm.payment_method === value ? 'on' : ''}`}
                key={value}
                type="button"
                onClick={() => setSaleForm({ ...saleForm, payment_method: value })}
              >
                <span className="payment-dot" />{label}
              </button>
            ))}
          </div>
          {saleLevel && saleAmount ? (
            <div className={`stock-preview ${saleAmount - saleCost < 0 ? 'is-negative' : ''}`}>
              <span>Закупка {money(Math.round(saleCost))}</span>
              <strong>Маржа {signedMoney(saleAmount - saleCost)}</strong>
            </div>
          ) : null}
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняю…' : isOwner ? 'Сохранить' : 'Отправить на подтверждение'}</button>
        </form>
      ) : null}

      {canWrite && form === 'receipt' ? (
        <form className="card wide stock-form" onSubmit={submitReceipt}>
          <h2>Приход</h2>
          <ProductPicker
            options={receiptOptions}
            value={receiptIsNew ? '' : receiptForm.product_id}
            newName={receiptIsNew ? receiptForm.product_name : ''}
            onChange={(id) => setReceiptForm({ ...receiptForm, product_id: id, product_name: '' })}
            onCreate={(name) => setReceiptForm({ ...receiptForm, product_id: NEW_PRODUCT, product_name: name })}
            placeholder="Найти или добавить товар"
          />
          {receiptIsNew ? (
            <div className="seg" role="radiogroup" aria-label="Вид товара">
              {PRODUCT_CATEGORIES.map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={receiptForm.category === value} className={receiptForm.category === value ? 'on' : ''} onClick={() => setReceiptForm({ ...receiptForm, category: value })}>{label}</button>
              ))}
            </div>
          ) : null}
          <div className="settings-pair">
            <label>
              Количество
              <input type="number" inputMode="numeric" min="1" step="1" value={receiptForm.qty} onChange={(event) => setReceiptForm({ ...receiptForm, qty: event.target.value })} />
            </label>
            <label>
              Цена за штуку
              <MoneyInput placeholder="сум" value={receiptForm.unit_cost} onChange={(value) => setReceiptForm({ ...receiptForm, unit_cost: value })} />
            </label>
          </div>
          {receiptQty && receiptUnitCost ? (
            <div className="stock-preview"><span>Итого</span><strong>{money(receiptQty * receiptUnitCost)} сум</strong></div>
          ) : null}
          <span className="stock-label">Из чьих денег</span>
          <div className="seg" role="radiogroup" aria-label="Из чьих денег">
            {RECEIPT_PAYERS.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={receiptForm.paid_by === value} className={receiptForm.paid_by === value ? 'on' : ''} onClick={() => setReceiptForm({ ...receiptForm, paid_by: value })}>{label}</button>
            ))}
          </div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </form>
      ) : null}

      {canWrite && form === 'writeoff' ? (
        <form className="card wide stock-form" onSubmit={submitWriteoff}>
          <h2>Списание</h2>
          <ProductPicker
            options={inStockOptions}
            value={writeoffForm.product_id}
            onChange={(id) => setWriteoffForm({ ...writeoffForm, product_id: id })}
          />
          <label>
            Количество
            <input type="number" inputMode="numeric" min="1" step="1" value={writeoffForm.qty} onChange={(event) => setWriteoffForm({ ...writeoffForm, qty: event.target.value })} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Причина">
            {WRITEOFF_REASONS.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={writeoffForm.reason === value} className={writeoffForm.reason === value ? 'on' : ''} onClick={() => setWriteoffForm({ ...writeoffForm, reason: value })}>{label}</button>
            ))}
          </div>
          <input maxLength={300} placeholder="Комментарий" value={writeoffForm.note} onChange={(event) => setWriteoffForm({ ...writeoffForm, note: event.target.value })} />
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Сохраняю…' : 'Списать'}</button>
        </form>
      ) : null}

      <div className="card wide">
        <div className="section-heading">
          <h2>Остатки</h2>
          <span className="date-badge">сейчас</span>
        </div>
        <Rows
          rows={visibleLevels}
          empty="Товаров пока нет."
          render={(row) => (
            <div className={`row stock-row${row.qty <= 0 ? ' is-empty' : row.qty <= 2 ? ' is-low' : ''}`} key={row.product.id}>
              <div>
                <strong>{row.product.name}</strong>
                <span>{PRODUCT_CATEGORY_LABELS[row.product.category] || 'Товар'} · {money(Math.round(row.unitCost))} за шт.</span>
              </div>
              <div className="stock-qty">
                <strong>{row.qty} шт.</strong>
                {row.qty > 0 ? (
                  <span>{money(Math.round(row.value))}</span>
                ) : isOwner && canWrite && row.qty === 0 ? (
                  <button className="link-button" type="button" disabled={busy} onClick={() => hideProduct(row.product)}>Скрыть</button>
                ) : (
                  <span>закончился</span>
                )}
              </div>
            </div>
          )}
        />
      </div>

      <div className="card wide">
        <SectionHeading label="Движение товара" range={range} />
        <Rows
          rows={movements.slice(0, 150)}
          empty="За этот период движения не было."
          render={(item) => {
            const { row } = item;
            // The kind is a text of its own: joined with a product named in
            // Russian («Масло для бороды») the whole line stayed Russian in Uzbek.
            let title;
            let details;
            let amount;
            let status = null;
            if (item.kind === 'receipt') {
              title = 'Приход';
              details = `${money(row.unit_cost)} за шт. · ${RECEIPT_PAYER_LABELS[row.paid_by] || row.paid_by}`;
              amount = money(row.total_cost);
            } else if (item.kind === 'sale') {
              title = 'Продажа';
              details = `${PAYMENT_LABELS[row.payment_method] || '—'}${row.status === 'rejected' ? '' : ` · маржа ${signedMoney(productSaleMargin(row))}`}`;
              amount = money(row.amount);
              if (row.status === 'pending') status = <span className="approval pending">Ждёт подтверждения</span>;
              if (row.status === 'rejected') status = <span className="approval rejected">Отклонено</span>;
            } else {
              title = 'Списание';
              details = `${WRITEOFF_REASON_LABELS[row.reason] || row.reason}${row.note ? ` · ${row.note}` : ''}`;
              amount = '—';
            }
            return (
              <div className={`row stock-move is-${item.kind}${row.status === 'rejected' ? ' is-rejected' : ''}`} key={`${item.kind}-${row.id}`}>
                <div>
                  <strong>{title} · {nameOf(row.product_id)} × {row.qty}</strong>
                  <span>{displayDate(item.date)} · {details}</span>
                  {status}
                </div>
                <div>
                  <strong>{amount}</strong>
                  {canDelete(item) ? <button className="del" type="button" aria-label="Удалить" disabled={busy} onClick={() => deleteEntry(item)}>×</button> : null}
                </div>
              </div>
            );
          }}
        />
      </div>
    </section>
  );
}

// The administrator's Склад: sell, see what is left, see her own sales of
// today and yesterday and what the owner decided. The server sends names and
// quantities only (stockForDesk in supabase/functions/_shared/access.js).
function DeskStockView({ data, reload, setError }) {
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const emptySale = { product_id: '', qty: '1', amount: '', payment_method: null, amountTyped: false };
  const [saleForm, setSaleForm] = useState(emptySale);
  const [saleRequestId, setSaleRequestId] = useState(newRequestId);

  const products = data.products;
  const qtyOf = (product) => Number(product?.stock_qty) || 0;
  const nameOf = (id) => products.find((product) => String(product.id) === String(id))?.name || 'Товар';
  const inStockOptions = productsByRecentUse(products, [], data.productSales)
    .filter((product) => qtyOf(product) > 0)
    .map((product) => ({ product, hint: `на складе ${qtyOf(product)}` }));
  const selected = products.find((product) => String(product.id) === String(saleForm.product_id)) || null;
  const saleQty = Number(saleForm.qty) || 0;
  const saleAmount = Number(saleForm.amount) || 0;
  const mySales = [...data.productSales]
    .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
  // The price was typed from memory and «× 2» did not double it (owner's
  // review of 2026-10-26): the desk's own last sale of the product gives the
  // price per piece, times the quantity, until a sum is typed by hand.
  const lastUnitPrice = (productId) => {
    const last = mySales.find((sale) => String(sale.product_id) === String(productId)
      && sale.status !== 'rejected' && Number(sale.qty) > 0 && Number(sale.amount) > 0);
    return last ? Math.round(Number(last.amount) / Number(last.qty)) : 0;
  };
  const priced = (form) => {
    if (form.amountTyped) return form;
    const unit = lastUnitPrice(form.product_id);
    return { ...form, amount: unit ? String(unit * (Number(form.qty) || 0)) : '' };
  };
  const shelf = [...products].sort((left, right) => (
    Number(qtyOf(right) > 0) - Number(qtyOf(left) > 0)
    || String(left.name).localeCompare(String(right.name), 'ru')
  ));

  async function submitSale(event) {
    event.preventDefault();
    if (!selected) return setError('Выберите товар.');
    if (!Number.isInteger(saleQty) || saleQty < 1) return setError('Количество — целое число от 1.');
    if (saleQty > qtyOf(selected)) return setError(`На складе только ${qtyOf(selected)} шт. «${selected.name}».`);
    if (!saleAmount) return setError('Введите сумму.');
    if (!saleForm.payment_method) return setError('Выберите способ оплаты.');
    const ok = await run(
      () => callLegacyApi('addProductSale', {
        product_id: selected.id,
        qty: saleQty,
        amount: saleAmount,
        payment_method: saleForm.payment_method,
        client_request_id: saleRequestId,
      }),
      'Отправлено на подтверждение.',
    );
    if (!ok) return;
    reload();
    haptic('success');
    setSaleRequestId(newRequestId());
    setSaleForm(emptySale);
  }

  async function takeBack(sale) {
    if (!await confirmAction(`Удалить продажу «${nameOf(sale.product_id)}» на ${money(sale.amount)} сум?`)) return;
    await run(() => callLegacyApi('delStockEntry', { kind: 'sale', id: sale.id }).then(reload), 'Удалено.');
  }

  return (
    <section className="view-grid">

      <form className="card wide stock-form" onSubmit={submitSale}>
        <h2>Продажа</h2>
        <ProductPicker
          options={inStockOptions}
          value={saleForm.product_id}
          onChange={(id) => setSaleForm(priced({ ...saleForm, product_id: id }))}
        />
        <div className="settings-pair">
          <label>
            Количество
            <input type="number" inputMode="numeric" min="1" step="1" value={saleForm.qty} onChange={(event) => setSaleForm(priced({ ...saleForm, qty: event.target.value }))} />
          </label>
          <label>
            Сумма
            <MoneyInput placeholder="сум" value={saleForm.amount} onChange={(value) => setSaleForm({ ...saleForm, amount: value, amountTyped: Boolean(value) })} />
          </label>
        </div>
        <div className="pay-types">
          {PAYMENT_METHODS.map(([value, label]) => (
            <button
              aria-pressed={saleForm.payment_method === value}
              className={`pay-type is-${value} ${saleForm.payment_method === value ? 'on' : ''}`}
              key={value}
              type="button"
              onClick={() => setSaleForm({ ...saleForm, payment_method: value })}
            >
              <span className="payment-dot" />{label}
            </button>
          ))}
        </div>
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Отправляю…' : 'Отправить на подтверждение'}</button>
      </form>

      <div className="card wide">
        <div className="section-heading">
          <h2>Мои продажи</h2>
          <span className="date-badge">сегодня и вчера</span>
        </div>
        <Rows
          rows={mySales}
          empty="Продаж пока нет."
          render={(sale) => (
            <div className={`row stock-move${sale.status === 'rejected' ? ' is-rejected' : ''}`} key={sale.id}>
              <div>
                <strong>{nameOf(sale.product_id)} × {sale.qty}</strong>
                <span>{displayDateTime(sale.created_at)} · {PAYMENT_LABELS[sale.payment_method] || '—'}</span>
                {sale.status === 'pending' ? <span className="approval pending">Ждёт подтверждения</span> : null}
                {sale.status === 'approved' ? <span className="approval approved">Подтверждено</span> : null}
                {sale.status === 'rejected' ? <span className="approval rejected">Отклонено</span> : null}
              </div>
              <div>
                <strong>{money(sale.amount)}</strong>
                {sale.status === 'pending'
                  ? <button className="del" type="button" aria-label="Удалить" disabled={busy} onClick={() => takeBack(sale)}>×</button>
                  : null}
              </div>
            </div>
          )}
        />
      </div>

      <div className="card wide">
        <div className="section-heading">
          <h2>Остатки</h2>
          <span className="date-badge">сейчас</span>
        </div>
        <Rows
          rows={shelf}
          empty="Товаров пока нет."
          render={(product) => (
            <div className={`row stock-row${qtyOf(product) <= 0 ? ' is-empty' : qtyOf(product) <= 2 ? ' is-low' : ''}`} key={product.id}>
              <div>
                <strong>{product.name}</strong>
                <span>{PRODUCT_CATEGORY_LABELS[product.category] || 'Товар'}</span>
              </div>
              <div className="stock-qty">
                <strong>{qtyOf(product)} шт.</strong>
              </div>
            </div>
          )}
        />
      </div>
    </section>
  );
}

// Команда → «Выплаты» (owner's decisions of 2026-10-16): a week runs Monday to
// Sunday and is paid on Sunday night. An advance is the master's money paid
// early: it lowers what is owed for its week and nothing else. The partner
// reads it; only the owner gives advances and marks a week paid.
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «12–18 октября», or «29 сентября – 5 октября» across a month's end.
function weekLabel(week) {
  const [, fromMonth, fromDay] = week.from.split('-').map(Number);
  const [, toMonth, toDay] = week.to.split('-').map(Number);
  return fromMonth === toMonth
    ? `${fromDay}–${toDay} ${MONTHS_GENITIVE[toMonth - 1]}`
    : `${fromDay} ${MONTHS_GENITIVE[fromMonth - 1]} – ${toDay} ${MONTHS_GENITIVE[toMonth - 1]}`;
}

// How clients rate their visits (owner's decisions of 2026-10-21): four
// questions in the clients' bot. A master's rating is the mean of the first
// three; the comfort of the salon is the owner's alone.
const REVIEW_PARTS = [
  ['quality', 'Качество'],
  ['service', 'Сервис'],
  ['cleanliness', 'Чистота'],
  ['comfort', 'Комфорт'],
];
const REVIEW_WORDS_STATUS = { pending: 'ждёт одобрения', approved: 'на сайте', hidden: 'скрыт' };

function ratingText(value) {
  return value == null ? '—' : Number(value).toFixed(1).replace('.', ',');
}

function useReviews(setError) {
  const [state, setState] = useState({ loading: true, reviews: [], ratings: [] });
  const load = useCallback(async () => {
    try {
      const result = await callLegacyApi('reviews', {});
      setState({ loading: false, reviews: result?.reviews || [], ratings: result?.ratings || [] });
    } catch (error) {
      setError(actionErrorText(error));
      setState((current) => ({ ...current, loading: false }));
    }
  }, [setError]);
  useEffect(() => { load(); }, [load]);
  return { ...state, load };
}

function ReviewScores({ review, parts = REVIEW_PARTS }) {
  return (
    <span className="review-scores">
      {parts.filter(([key]) => review[key] != null).map(([key, label]) => (
        <span className={review[key] <= 3 ? 'is-low' : ''} key={key}>{`${label} ${review[key]}`}</span>
      ))}
    </span>
  );
}

function ReviewRow({ review, masterName, actions = null, parts }) {
  const low = REVIEW_PARTS.some(([key]) => review[key] != null && review[key] <= 3);
  return (
    <div className={`row review-row${low ? ' is-low' : ''}`}>
      <div>
        <strong>{masterName ? `${masterName} · ` : ''}{displayDate(review.d)}</strong>
        <span>{review.client_name || '—'}</span>
        <ReviewScores review={review} parts={parts} />
        {review.comment ? <p className="review-words">«{review.comment}»</p> : null}
        {review.comment && review.comment_status ? (
          <span className={`approval ${review.comment_status === 'approved' ? 'approved' : review.comment_status === 'hidden' ? 'rejected' : 'pending'}`}>
            {REVIEW_WORDS_STATUS[review.comment_status]}
          </span>
        ) : null}
      </div>
      {actions}
    </div>
  );
}

// The owner's «Отзывы»: each master's rating, the words waiting for his
// decision, and the latest ratings, a score of 3 or less marked.
function ReviewsView({ data, setError }) {
  const { loading, reviews, ratings, load } = useReviews(setError);
  const [deciding, setDeciding] = useState(null);
  const nameOf = (id) => data.masters.find((master) => String(master.id) === String(id))?.name || '—';
  const waiting = reviews.filter((review) => review.comment && review.comment_status === 'pending');

  async function decide(review, status) {
    setDeciding(`${review.id}:${status}`);
    setError('');
    try {
      await callLegacyApi('decideReview', { review_id: review.id, status });
      haptic('success');
      await load();
    } catch (error) {
      setError(actionErrorText(error));
    } finally {
      setDeciding(null);
    }
  }

  const decisionButtons = (review) => (
    <div className="approval-actions">
      {review.comment_status !== 'approved' ? (
        <button className="btn approval-button" type="button" disabled={Boolean(deciding)} onClick={() => decide(review, 'approved')}>
          {deciding === `${review.id}:approved` ? 'Сохраняем…' : 'Показать на сайте'}
        </button>
      ) : null}
      {review.comment_status !== 'hidden' ? (
        <button className="btn ghost approval-button" type="button" disabled={Boolean(deciding)} onClick={() => decide(review, 'hidden')}>
          {deciding === `${review.id}:hidden` ? 'Сохраняем…' : 'Скрыть'}
        </button>
      ) : null}
    </div>
  );

  return (
    <section className="view-grid">
      {waiting.length ? (
        <div className="card wide">
          <h2>Отзывы ждут одобрения</h2>
          <Rows rows={waiting} empty="" render={(review) => (
            <ReviewRow key={review.id} review={review} masterName={nameOf(review.master_id)} actions={decisionButtons(review)} />
          )} />
        </div>
      ) : null}
      <div className="card wide">
        <h2>Оценки мастеров</h2>
        {loading ? <p className="hint">Загружаем…</p> : ratings.length ? (
          <div className="review-ratings">
            {[...ratings].sort((left, right) => Number(right.rating) - Number(left.rating)).map((row) => (
              <div className="review-rating" key={row.master_id}>
                <strong>{nameOf(row.master_id)}</strong>
                <span className="review-rating-value">★ {ratingText(row.rating)}</span>
                <small><span>{row.ratings}</span> <span>{pluralRu(row.ratings, 'оценка', 'оценки', 'оценок')}</span></small>
                <span className="review-scores">
                  {REVIEW_PARTS.map(([key, label]) => <span key={key}>{`${label} ${ratingText(row[key])}`}</span>)}
                </span>
              </div>
            ))}
          </div>
        ) : <p className="hint">Оценок пока нет.</p>}
      </div>
      <div className="card wide">
        <h2>Последние оценки</h2>
        <Rows rows={reviews.slice(0, 60)} empty={loading ? '' : 'Оценок пока нет.'} render={(review) => (
          <ReviewRow
            key={review.id}
            review={review}
            masterName={nameOf(review.master_id)}
            actions={review.comment && review.comment_status !== 'pending' ? decisionButtons(review) : null}
          />
        )} />
      </div>
    </section>
  );
}

// A master's own «Отзывы» tab (owner's request of 2026-10-21): his rating, each
// question's mean, and every rating with its words. No comfort of the salon,
// which is not his, and no sign of which words reached the site (owner's
// decision of 2026-10-21: he is to expect them all there).
function MasterReviewsView({ setError }) {
  const { loading, reviews, ratings } = useReviews(setError);
  const mine = ratings[0];
  const parts = REVIEW_PARTS.slice(0, 3);
  return (
    <section className="view-grid">
      <div className="card wide my-ratings">
        <h2>Мой рейтинг</h2>
        {loading ? <p className="hint">Загружаем…</p> : mine ? (
          <>
            <p className="big-line">★ {ratingText(mine.rating)} <small><span>{mine.ratings}</span> <span>{pluralRu(mine.ratings, 'оценка', 'оценки', 'оценок')}</span></small></p>
            <span className="review-scores">
              {parts.map(([key, label]) => <span key={key}>{`${label} ${ratingText(mine[key])}`}</span>)}
            </span>
          </>
        ) : <p className="hint">Пока нет оценок.</p>}
      </div>
      {reviews.length ? (
        <div className="card wide">
          <h2>Отзывы клиентов</h2>
          <Rows rows={reviews} empty="" render={(review) => (
            <ReviewRow key={review.id} review={review} parts={parts} />
          )} />
        </div>
      ) : null}
    </section>
  );
}

// A week's lines that add up to what is due (owner's review of 2026-10-26).
// A fine is withheld only from what the week earned (masterWeek); the rest of
// it used to vanish without a word while the red total blamed the advance.
function PayoutLines({ row, dueLabel = 'К выплате' }) {
  const withheld = Math.min(row.fines, Math.max(0, row.earned));
  const notWithheld = row.fines - withheld;
  return (
    <>
      <div className="payout-lines">
        <span>Заработал<b>{money(row.earned)}</b></span>
        {withheld ? <span>Штрафы<b className="danger">−{money(withheld)}</b></span> : null}
        {notWithheld ? (
          <span className="payout-note">
            {`Штраф ${money(notWithheld)} не удержан: ${row.earned > 0 ? 'заработка не хватило' : 'заработка не было'}`}
          </span>
        ) : null}
        {row.advances ? <span>Авансы<b>−{money(row.advances)}</b></span> : null}
        {row.paid ? <span>Выплачено<b>−{money(row.paid)}</b></span> : null}
      </div>
      <div className={`payout-due${row.due < 0 ? ' is-negative' : ''}`}>
        <span>{row.due < 0 ? (row.advances ? 'Долг по авансу' : 'Выплачено больше') : dueLabel}</span>
        <strong>{money(Math.abs(row.due))}</strong>
      </div>
    </>
  );
}

function PayoutsView({ data, reload, setError }) {
  const isOwner = data.appRole === 'owner';
  const thisWeek = weekStartOf(TODAY);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [advanceFor, setAdvanceFor] = useState(null);
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceNote, setAdvanceNote] = useState('');
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const week = weekOf(weekStart);
  const rows = weekPayouts({
    masters: data.masters,
    sales: data.sales.filter(isCountedSale),
    fines: data.fines,
    advances: data.advances,
    payouts: data.payouts,
    week,
  });
  // The owner pays one master after another and presses «Выплатил»; a master
  // with nothing left to pay goes to the bottom, so the next one to pay is
  // always on top (owner's decision of 2026-10-26).
  const ordered = [...rows.filter((row) => row.due > 0), ...rows.filter((row) => row.due <= 0)];
  const totalDue = rows.reduce((sum, row) => sum + Math.max(0, row.due), 0);
  const totalAdvances = rows.reduce((sum, row) => sum + row.advances, 0);
  const totalPaid = rows.reduce((sum, row) => sum + row.paid, 0);

  function openAdvance(masterId) {
    setAdvanceFor(advanceFor === masterId ? null : masterId);
    setAdvanceAmount('');
    setAdvanceNote('');
    setMessage('');
  }

  async function giveAdvance(row) {
    const amount = Number(advanceAmount);
    if (!amount || amount <= 0) return setError('Введите сумму аванса.');
    const ok = await run(() => callLegacyApi('addAdvance', {
      master_id: row.master.id,
      amount,
      note: advanceNote.trim() || null,
    }), `Аванс ${money(amount)} сум: ${row.master.name}.`);
    if (!ok) return;
    haptic('success');
    setAdvanceFor(null);
    reload();
  }

  async function markPaid(row) {
    if (!await confirmAction(`${row.master.name}: выплачено ${money(row.due)} сум за ${weekLabel(week)}?`)) return;
    const ok = await run(() => callLegacyApi('markPayout', {
      master_id: row.master.id,
      week_start: week.from,
      amount: row.due,
      earned: row.earned,
      fines: row.fines,
    }), `Выплачено: ${row.master.name}, ${money(row.due)} сум.`);
    if (!ok) return;
    haptic('success');
    reload();
  }

  async function takeBack(kind, item, what) {
    if (!await confirmAction(`Удалить ${what}?`)) return;
    const ok = await run(() => callLegacyApi(kind === 'advance' ? 'delAdvance' : 'delPayout', { id: item.id }), 'Удалено.');
    if (ok) reload();
  }

  return (
    <section className="view-grid">
      <div className="wide day-chips payout-weeks">
        <button type="button" onClick={() => setWeekStart(shiftDate(weekStart, -7))}>‹</button>
        <button className={weekStart === thisWeek ? 'on' : ''} type="button" onClick={() => setWeekStart(thisWeek)}>Эта неделя</button>
        <button className={weekStart === shiftDate(thisWeek, -7) ? 'on' : ''} type="button" onClick={() => setWeekStart(shiftDate(thisWeek, -7))}>Прошлая</button>
        {weekStart < thisWeek ? <button type="button" onClick={() => setWeekStart(shiftDate(weekStart, 7))}>›</button> : null}
      </div>

      <div className="card wide hero-card revenue-hero">
        <div className="revenue-hero-top"><span>К выплате · {weekLabel(week)}</span></div>
        <div className="revenue-hero-value"><strong>{money(totalDue)}</strong><span>сум</span></div>
        <div className="stock-hero-facts">
          <span>Авансы<strong>{money(totalAdvances)}</strong></span>
          <span>Выплачено<strong>{money(totalPaid)}</strong></span>
        </div>
      </div>


      {ordered.map((row) => {
        const weekPaid = row.paid > 0 && row.due === 0;
        return (
          <div className="card payout-card" key={row.master.id}>
            <div className="payout-head">
              <strong>{row.master.name}</strong>
              {weekPaid ? <span className="date-badge is-positive">выплачено</span> : null}
            </div>
            <PayoutLines row={row} />
            {row.advanceRows.length || row.payoutRows.length ? (
              <div className="payout-history">
                {row.advanceRows.map((advance) => (
                  <div className="payout-history-row" key={`a${advance.id}`}>
                    <span>Аванс {money(advance.amount)} · {displayDate(advance.given_on)}{advance.note ? ` · ${advance.note}` : ''}</span>
                    {isOwner && !row.paid ? <button aria-label="Удалить аванс" className="del" type="button" disabled={busy} onClick={() => takeBack('advance', advance, `аванс ${row.master.name} ${money(advance.amount)} сум`)}>×</button> : null}
                  </div>
                ))}
                {row.payoutRows.map((payout) => (
                  <div className="payout-history-row" key={`p${payout.id}`}>
                    <span>Выплачено {money(payout.amount)} · {displayDate(String(payout.paid_at).slice(0, 10))}</span>
                    {isOwner ? <button aria-label="Удалить выплату" className="del" type="button" disabled={busy} onClick={() => takeBack('payout', payout, `выплату ${row.master.name} ${money(payout.amount)} сум`)}>×</button> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {isOwner ? (
              <div className="payout-actions">
                {weekStart === thisWeek ? (
                  <button className="btn ghost" type="button" onClick={() => openAdvance(row.master.id)}>+ Аванс</button>
                ) : null}
                {row.due > 0 ? (
                  <button className="btn" type="button" disabled={busy} onClick={() => markPaid(row)}>Выплатил {money(row.due)}</button>
                ) : null}
              </div>
            ) : null}
            {isOwner && advanceFor === row.master.id ? (
              <div className="payout-advance">
                <MoneyInput aria-label={`Аванс ${row.master.name}`} placeholder="Сумма аванса" value={advanceAmount} onChange={setAdvanceAmount} />
                <input maxLength={200} placeholder="Комментарий" value={advanceNote} onChange={(event) => setAdvanceNote(event.target.value)} />
                <button className="btn" type="button" disabled={busy} onClick={() => giveAdvance(row)}>{busy ? 'Сохраняю…' : 'Выдать аванс'}</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

// A master's own week in «Рабочий день»: what he gets on Sunday.
function MyWeek({ data, master }) {
  if (!master) return null;
  const week = weekOf(TODAY);
  const weekPending = Math.round(grossMasterPayForSales(
    data.sales.filter((sale) => sale.master === master.name && isPendingOwnerApproval(sale) && inRange(rowDate(sale), week.from, week.to)),
    master,
  ));
  const row = masterWeek({
    master,
    week,
    sales: data.sales.filter(isCountedSale),
    fines: data.fines,
    advances: data.advances,
    payouts: data.payouts,
  });
  return (
    <div className="card wide payout-card my-week">
      <div className="payout-head">
        <strong>Неделя · {weekLabel(week)}</strong>
        {row.paid > 0 && row.due === 0 ? <span className="date-badge is-positive">выплачено</span> : null}
      </div>
      <PayoutLines row={row} dueLabel="К выплате в воскресенье" />
      {weekPending ? <p className="pending-pay">Ещё {money(weekPending)} сум ждёт подтверждения</p> : null}
    </div>
  );
}

// ------------------------------------------------------------- дежурство
// Дежурный по чистоте (owner's decisions of 2026-10-26): one master a day,
// set by the owner a week ahead; from the start of his shift a photo of the
// salon every two hours, a window without one fined 50 000; a day off is
// arranged with another master, who takes the day over in the app.

const DUTY_WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Ticks the screen over every half minute: a window opens and closes on the
// clock, not on a load.
function useNow(step = 30000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), step);
    return () => window.clearInterval(id);
  }, [step]);
  return now;
}

function dutyDayTitle(day) {
  const text = dutyDayLabel(day, 'ru');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A window by its photo hour: «14:00–15:00» for the window 14:00–16:00.
function dutyWindowLabel(window) {
  return `${appointmentTime(window.starts_at)}–${appointmentTime(photoUntil(window))}`;
}

const DUTY_STATUS_TEXT = {
  done: 'фото есть',
  fined: 'штраф',
  open: 'сейчас',
  missed: 'нет фото',
  later: 'позже',
};

// The days before the fines start are a trial (owner's decision of
// 2026-10-26: the first week, to 2 November, without fines).
function DutyTrialNote({ duty }) {
  if (!duty?.since || String(duty.today) >= String(duty.since)) return null;
  return <p className="duty-trial">{`Пробная неделя. Штрафы начнутся с ${dutyDateLabel(duty.since, 'ru')}.`}</p>;
}

function DutyWindows({ windows, now, zoneCount = 0 }) {
  if (!windows.length) return null;
  return (
    <ol className="duty-windows">
      {windows.map((window) => {
        const status = windowStatus(window, now);
        const done = (window.zones_done || []).length;
        return (
          <li className={`duty-window is-${status}`} key={window.starts_at}>
            <strong>{dutyWindowLabel(window)}</strong>
            <span>{status === 'open' && zoneCount ? `сейчас · ${done} из ${zoneCount}` : DUTY_STATUS_TEXT[status]}</span>
          </li>
        );
      })}
    </ol>
  );
}

// The picture as the server takes it: at most 1280 px on its long side, a
// JPEG, and its fingerprint from a grey 17×16 copy (made in two steps, so a
// big photo does not alias into noise).
function decodePicture(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => decodeWithImage(file));
  }
  return decodeWithImage(file);
}

function decodeWithImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('duty_photo_unreadable')); };
    image.src = url;
  });
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('duty_photo_unreadable'));
    reader.readAsDataURL(blob);
  });
}

async function prepareDutyPhoto(file) {
  const picture = await decodePicture(file);
  const scale = Math.min(1, 1280 / Math.max(picture.width, picture.height));
  const full = canvasOf(picture.width * scale, picture.height * scale);
  const fullContext = full.getContext('2d');
  fullContext.imageSmoothingQuality = 'high';
  fullContext.drawImage(picture, 0, 0, full.width, full.height);
  picture.close?.();
  const blob = await new Promise((resolve) => full.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob) throw new Error('duty_photo_unreadable');

  const middle = canvasOf(HASH_WIDTH * 4, HASH_HEIGHT * 4);
  const middleContext = middle.getContext('2d');
  middleContext.imageSmoothingQuality = 'high';
  middleContext.drawImage(full, 0, 0, middle.width, middle.height);
  const small = canvasOf(HASH_WIDTH, HASH_HEIGHT);
  const smallContext = small.getContext('2d', { willReadFrequently: true });
  smallContext.imageSmoothingQuality = 'high';
  smallContext.drawImage(middle, 0, 0, HASH_WIDTH, HASH_HEIGHT);
  const grey = greyFromRgba(smallContext.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT).data);

  return {
    image: await blobToBase64(blob),
    phash: differenceHash(grey),
    // When the phone says the picture was made: a camera shot is «now», a
    // photo picked from the gallery is as old as it is.
    shot_at: Number(file.lastModified) || null,
  };
}

// The camera, straight away where the phone allows it.
function DutyPhotoButton({ busy, disabled = false, onPick, label = 'Сфотографировать', busyLabel = 'Готовлю фото…', ghost = false }) {
  const inputRef = useRef(null);
  return (
    <>
      <button className={`btn duty-photo-button${ghost ? ' ghost' : ''}`} type="button" disabled={busy || disabled} onClick={() => inputRef.current?.click()}>
        {busy ? busyLabel : label}
      </button>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onPick(file);
        }}
      />
    </>
  );
}

// Who is on duty today, on the owner's and the partner's Главная and on the
// administrator's screen; the owner and the partner open the duty tab from it.
function DutyTodayCard({ data, onOpen }) {
  const now = useNow();
  const duty = data.duty;
  if (!duty) return null;
  const today = rosterOn(duty, duty.today);
  const windows = duty.windows || [];
  const done = windowsDone(windows);
  const fined = windows.filter((window) => window.fined).length;
  const open = openWindow(windows, now);
  const line = !today
    ? 'Дежурный не назначен'
    : fined
      ? `Фото ${done} из ${windows.length} · штрафов ${fined}`
      : `Фото ${done} из ${windows.length}`;
  const body = (
    <>
      <span className="duty-card-text">
        <small>Дежурный сегодня</small>
        <strong>{today ? dutyMasterName(duty, today.master_id) : '—'}</strong>
        <span className={fined ? 'is-negative' : ''}>{line}</span>
        {open && !open.photo_at ? <span className="duty-card-now">{`Ждём фото до ${appointmentTime(photoUntil(open))}`}</span> : null}
      </span>
      {onOpen ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      ) : null}
    </>
  );
  return onOpen
    ? <button className="card wide duty-card" type="button" onClick={onOpen}>{body}</button>
    : <div className="card wide duty-card">{body}</div>;
}

function DutySwapSheet({ duty, day, selfId, busy, onAsk, onClose }) {
  useTelegramBack(onClose);
  const dialogRef = useDialogFocus();
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const candidates = swapCandidates(duty, day, selfId);
  return (
    <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
      <div aria-label="Кто подменит" aria-modal="true" className="card master-sheet duty-sheet" ref={dialogRef} role="dialog" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="master-sheet-head">
          <div>
            <strong>Кто подменит?</strong>
            <small>{dutyDayTitle(day)}</small>
          </div>
          <button aria-label="Закрыть" className="sheet-close" type="button" onClick={onClose}>×</button>
        </div>
        <div className="duty-candidates">
          {candidates.map((master) => (
            <button className="duty-candidate" disabled={busy} key={master.id} type="button" onClick={() => onAsk(master)}>
              <strong>{master.name}</strong>
              <span>{master.works ? 'работает' : 'выходной'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// A master's duty in «Работа»: who is on today; his photos when it is him;
// what another master asked of him; his days ahead, each with «Найти
// замену»; the answers to what he asked.
function MyDuty({ data, reload, setError }) {
  const now = useNow();
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const [asking, setAsking] = useState(null);
  const closeAsking = useCallback(() => setAsking(null), []);
  // A zone takes up to three photos before it is sent (owner's decision of
  // 2026-10-26): what is ready per zone, the zone whose photo is being
  // prepared, and the zone being checked.
  const [drafts, setDrafts] = useState({});
  const [preparingZone, setPreparingZone] = useState(null);
  const [sendingZone, setSendingZone] = useState(null);
  const duty = data.duty;
  const masterId = data.byName[data.me]?.id;
  if (!duty || !masterId) return null;
  const zones = duty.zones || [];

  const today = rosterOn(duty, duty.today);
  const mine = myDuty(duty, masterId, duty.today, now);
  const onDutyToday = today && String(today.master_id) === String(masterId);
  const windows = onDutyToday ? duty.windows || [] : [];
  const current = currentWindow(windows, now);
  const next = nextWindow(windows, now);
  const doneLine = current
    ? (next ? `Фото за ${dutyWindowLabel(current)} есть. Следующее с ${appointmentTime(next.starts_at)}` : `Фото за ${dutyWindowLabel(current)} есть`)
    : next ? `Следующее фото с ${appointmentTime(next.starts_at)}` : 'Дежурство на сегодня закончено';
  // A day can still be handed over until its duty begins.
  const ahead = mine.days.filter((row) => !row.starts_at || now < new Date(row.starts_at).getTime());
  const nameOf = (id) => dutyMasterName(duty, id);

  async function addShot(zone, file) {
    setPreparingZone(zone.id);
    try {
      const shot = await prepareDutyPhoto(file);
      setDrafts((current) => ({
        ...current,
        [zone.id]: [...(current[zone.id] || []), { ...shot, key: `${Date.now()}-${Math.random()}` }].slice(0, 3),
      }));
    } catch (error) {
      setError(actionErrorText(error));
    } finally {
      setPreparingZone(null);
    }
  }

  function dropShot(zone, key) {
    setDrafts((current) => ({ ...current, [zone.id]: (current[zone.id] || []).filter((shot) => shot.key !== key) }));
  }

  // A zone's photos, judged together: counted, or refused with what to fix
  // (owner's decision of 2026-10-26: a dirty zone is not counted until it is
  // sent again). The photos are spent either way, unless they never arrived.
  async function sendZone(zone) {
    const shots = drafts[zone.id] || [];
    if (!shots.length) return;
    setSendingZone(zone.id);
    let unsent = false;
    const ok = await run(async () => {
      let result;
      try {
        result = await callLegacyApi('addDutyPhoto', {
          zone: zone.id,
          photos: shots.map(({ image, phash, shot_at }) => ({ image, phash, shot_at })),
        });
      } catch (error) {
        unsent = /Failed to fetch|NetworkError|network/i.test(String(error?.message)) || error?.details?.error === 'duty_photo_upload_failed';
        throw error;
      }
      if (result?.accepted === false) {
        registerNames([[result.reason_ru, result.reason_uz]]);
        const refused = new Error('duty_photo_refused');
        refused.details = { error: 'duty_photo_refused', reason: result.reason_ru };
        throw refused;
      }
    }, `Фото приняты: ${zone.name_ru}.`);
    setSendingZone(null);
    if (!unsent) setDrafts((current) => ({ ...current, [zone.id]: [] }));
    haptic(ok ? 'success' : 'error');
    reload();
  }

  async function ask(master) {
    const day = asking;
    const ok = await run(
      () => callLegacyApi('askDutySwap', { day, to_master_id: master.id }),
      `Просьба отправлена: ${master.name}.`,
    );
    if (ok) setAsking(null);
    reload();
  }

  async function answer(swap, accept) {
    await run(
      () => callLegacyApi('answerDutySwap', { id: swap.id, accept }),
      accept ? 'Принято: этот день дежурите вы.' : 'Вы отказались.',
    );
    reload();
  }

  async function cancel(swap) {
    await run(() => callLegacyApi('cancelDutySwap', { id: swap.id }), 'Просьба отменена.');
    reload();
  }

  return (
    <>
      {mine.incoming.map((swap) => (
        <div className="card wide duty-request" key={swap.id} role="alert">
          <strong>{`${nameOf(swap.from_master_id)} просит подменить его на дежурстве`}</strong>
          <span>{dutyDayTitle(swap.day)}</span>
          <div className="duty-request-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => answer(swap, true)}>Принять</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => answer(swap, false)}>Отказать</button>
          </div>
        </div>
      ))}

      <div className={`card duty-mine${onDutyToday ? ' is-on-duty' : ''}`}>
        <h2>Дежурство</h2>
        <DutyTrialNote duty={duty} />
        {onDutyToday ? (
          <>
            <p className="big-line">Сегодня дежурите вы</p>
            <DutyWindows windows={windows} now={now} zoneCount={zones.length} />
            {current && !current.photo_at && zones.length ? (
              <div className="duty-zones">
                <span className="duty-zones-title">{`Фото за ${dutyWindowLabel(current)}`}</span>
                {zones.map((zone) => {
                  const done = (current.zones_done || []).includes(zone.id);
                  const refused = current.zones_rejected?.[zone.id];
                  const shots = drafts[zone.id] || [];
                  const sending = sendingZone === zone.id;
                  return (
                    <div className={`duty-zone${done ? ' is-done' : refused && !shots.length ? ' is-refused' : ''}`} key={zone.id}>
                      <div className="duty-zone-text">
                        <strong>{zone.name_ru}</strong>
                        <span>{zone.checklist_ru}</span>
                        {refused && !done ? <span className="duty-zone-reason">{`Не принято: ${refused.reason_ru}`}</span> : null}
                      </div>
                      {done ? (
                        <span className="duty-zone-ok">фото приняты</span>
                      ) : (
                        <>
                          {shots.length ? (
                            <div className="duty-shots">
                              {shots.map((shot) => (
                                <span className="duty-shot" key={shot.key}>
                                  <img alt="" src={`data:image/jpeg;base64,${shot.image}`} />
                                  <button aria-label="Убрать фото" disabled={sending} type="button" onClick={() => dropShot(zone, shot.key)}>×</button>
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <div className="duty-zone-actions">
                            {shots.length < 3 ? (
                              <DutyPhotoButton
                                busy={preparingZone === zone.id}
                                disabled={busy || Boolean(preparingZone)}
                                ghost={shots.length > 0 || Boolean(refused)}
                                label={shots.length ? 'Ещё фото' : refused ? 'Переснять' : 'Сфотографировать'}
                                onPick={(file) => addShot(zone, file)}
                              />
                            ) : null}
                            {shots.length ? (
                              <button className="btn" disabled={busy || Boolean(preparingZone)} type="button" onClick={() => sendZone(zone)}>
                                {sending ? 'Проверяю фото…' : `Отправить (${shots.length})`}
                              </button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="hint">{doneLine}</p>
            )}
          </>
        ) : (
          <p className="big-line">{today ? `Сегодня дежурит ${nameOf(today.master_id)}` : 'Сегодня дежурный не назначен'}</p>
        )}

        {ahead.length ? (
          <div className="duty-ahead">
            <span className="duty-ahead-title">Ваши дежурства</span>
            {ahead.map((row) => {
              const asked = mine.outgoing.filter((swap) => swap.day === row.day);
              return (
                <div className="duty-ahead-row" key={row.day}>
                  <div>
                    <strong>{dutyDayTitle(row.day)}</strong>
                    {row.starts_at ? <span>{`с ${appointmentTime(row.starts_at)} до ${appointmentTime(row.ends_at)}`}</span> : null}
                    {asked.map((swap) => (
                      <span className="duty-asked" key={swap.id}>
                        {`Ждём ответа: ${nameOf(swap.to_master_id)}`}
                        <button className="link-button" type="button" disabled={busy} onClick={() => cancel(swap)}>Отменить</button>
                      </span>
                    ))}
                  </div>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => setAsking(row.day)}>Найти замену</button>
                </div>
              );
            })}
          </div>
        ) : null}

        {mine.answered.map((swap) => (
          <p className={`duty-answer is-${swap.status}`} key={swap.id}>
            {swap.status === 'accepted'
              ? `${nameOf(swap.to_master_id)} подменит вас: ${dutyDayLabel(swap.day, 'ru')}`
              : `${nameOf(swap.to_master_id)} отказался: ${dutyDayLabel(swap.day, 'ru')}`}
          </p>
        ))}
      </div>

      {asking ? (
        <DutySwapSheet duty={duty} day={asking} selfId={masterId} busy={busy} onAsk={ask} onClose={closeAsking} />
      ) : null}
    </>
  );
}

// A master's own «Дежурство» tab (owner's request of 2026-10-26: beside
// Работа, Календарь and Отзывы).
function MasterDutyView({ data, reload, setError }) {
  return (
    <section className="view-grid">
      {data.duty
        ? <MyDuty data={data} reload={reload} setError={setError} />
        : <p className="hint">Дежурства появятся после обновления сервера.</p>}
    </section>
  );
}

// A day's photos for the owner and the partner: each window with a photo per
// zone, its fine, and the photos the check refused, with why.
function DutyDayPhotos({ day, zones = [], refreshKey, setError }) {
  const now = useNow();
  const [result, setResult] = useState(null);
  const [opened, setOpened] = useState(null);
  const closeOpened = useCallback(() => setOpened(null), []);
  useEffect(() => {
    let alive = true;
    callLegacyApi('dutyDay', { day })
      .then((answer) => { if (alive) setResult(answer); })
      .catch((error) => { if (alive) { setResult({ windows: [], attempts: [], fines: [] }); setError(actionErrorText(error)); } });
    return () => { alive = false; };
  }, [day, refreshKey, setError]);

  if (!result) return <p className="hint">Загружаю фото…</p>;
  const attempts = result.attempts || [];
  const fines = result.fines || [];
  const sameMoment = (left, right) => new Date(left).getTime() === new Date(right).getTime();
  const fineOf = (window) => fines.find((fine) => sameMoment(fine.duty_window, window.starts_at));
  const zoneName = (id) => zones.find((zone) => zone.id === id)?.name_ru || '';
  const windows = result.windows || [];
  if (!windows.length && !attempts.length) return <p className="hint">В этот день дежурного не было.</p>;

  return (
    <>
      <div className="duty-day-windows">
        {windows.map((window) => {
          const inWindow = attempts.filter((attempt) => sameMoment(attempt.window_starts_at, window.starts_at));
          const counted = (zone) => inWindow.find((attempt) => attempt.zone === zone.id && attempt.status === 'accepted');
          const refused = inWindow.filter((attempt) => attempt.status === 'rejected');
          const fine = fineOf(window);
          const complete = zones.length > 0 && zones.every((zone) => counted(zone));
          // Not over yet: nothing is missing.
          const status = windowStatus({ ...window, photo_at: complete ? window.ends_at : null, fined: Boolean(fine) }, now);
          return (
            <div className={`duty-day-window is-${status}`} key={window.starts_at}>
              <div className="duty-day-window-head">
                <strong>{dutyWindowLabel(window)}</strong>
                <span>{fine ? `штраф ${money(fine.amount)}` : DUTY_STATUS_TEXT[status]}</span>
              </div>
              <div className="duty-photos">
                {zones.map((zone) => {
                  const attempt = counted(zone);
                  const cover = attempt?.photos?.[0];
                  return (
                    <div className="duty-photo" key={zone.id}>
                      {cover?.url ? (
                        <button className="duty-photo-thumb" type="button" onClick={() => setOpened(attempt)}>
                          <img alt={`${zone.name_ru}, ${dutyWindowLabel(window)}`} loading="lazy" src={cover.url} />
                          {attempt.photos.length > 1 ? <b className="duty-photo-count">{attempt.photos.length}</b> : null}
                        </button>
                      ) : (
                        <span className={`duty-photo-empty is-${status}`}>
                          {status === 'open' ? 'ждём фото' : status === 'later' ? 'позже' : 'нет фото'}
                        </span>
                      )}
                      <span>{zone.name_ru}</span>
                    </div>
                  );
                })}
              </div>
              {refused.map((attempt) => (
                <button className="duty-refused" key={attempt.id} type="button" onClick={() => setOpened(attempt)}>
                  {`Не принято · ${zoneName(attempt.zone)} · ${appointmentTime(attempt.taken_at)}: ${attempt.reason_ru || ''}`}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {opened ? <DutyPhotoViewer attempt={opened} zoneName={zoneName(opened.zone)} onClose={closeOpened} /> : null}
    </>
  );
}

// A zone's photos at full size, side by side, with when they came and, for a
// refused sending, why.
function DutyPhotoViewer({ attempt, zoneName = '', onClose }) {
  useTelegramBack(onClose);
  return (
    <div className="modal-backdrop duty-viewer" onClick={onClose} role="dialog" aria-modal="true" aria-label="Фото дежурного">
      <div className="duty-viewer-strip">
        {(attempt.photos || []).map((photo) => <img alt="Фото дежурного" key={photo.id} src={photo.url} />)}
      </div>
      <span>{zoneName ? `${zoneName} · отправлено в ${appointmentTime(attempt.taken_at)}` : `Отправлено в ${appointmentTime(attempt.taken_at)}`}</span>
      {attempt.status === 'rejected' ? <span className="duty-viewer-reason">{`Не принято: ${attempt.reason_ru || ''}`}</span> : null}
    </div>
  );
}

// Команда → «Дежурство», for the owner and the partner: the week (the owner
// sets it; on Sunday the next week opens first), a day's photos, and the
// requests between masters.
function DutyView({ data, reload, setError }) {
  const duty = data.duty;
  const readOnly = isReadOnly(data);
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const today = duty?.today || TODAY;
  const thisMonday = mondayOf(today);
  const isSunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
  const [week, setWeek] = useState(isSunday ? 'next' : 'this');
  const [edits, setEdits] = useState({});
  const [photoDay, setPhotoDay] = useState(today);
  const monday = week === 'next' ? addDaysIso(thisMonday, 7) : thisMonday;
  const days = weekDays(monday);

  if (!duty) return <section className="view-grid"><p className="hint">Дежурства появятся после обновления сервера.</p></section>;

  const valueOf = (day) => (Object.prototype.hasOwnProperty.call(edits, day) ? edits[day] : String(rosterOn(duty, day)?.master_id ?? ''));
  const changes = rosterChanges(duty, Object.fromEntries(days.filter((day) => day >= today).map((day) => [day, valueOf(day)])));
  const photoDays = Array.from({ length: 7 }, (_, index) => addDaysIso(today, -index));
  // Today's photos reload as each zone is sent, not only when a window
  // closes: the count of counted and refused zones in each window.
  const todayPhotos = (duty.windows || [])
    .map((window) => `${(window.zones_done || []).length}.${Object.keys(window.zones_rejected || {}).length}`)
    .join(',');
  const swaps = (duty.swaps || []).filter((swap) => swap.status === 'pending' || swap.status === 'accepted');

  async function save() {
    const ok = await run(() => callLegacyApi('setDutyRoster', { days: changes }), 'График дежурств сохранён.');
    if (ok) setEdits({});
    reload();
  }

  return (
    <section className="view-grid">
      <div className="card wide duty-roster">
        <div className="duty-roster-head">
          <h2>Дежурства</h2>
          <div className="seg duty-week-seg" role="group" aria-label="Неделя">
            <button className={week === 'this' ? 'on' : ''} type="button" onClick={() => setWeek('this')}>Эта неделя</button>
            <button className={week === 'next' ? 'on' : ''} type="button" onClick={() => setWeek('next')}>Следующая</button>
          </div>
        </div>
        <DutyTrialNote duty={duty} />
        <div className="duty-days">
          {days.map((day) => {
            const row = rosterOn(duty, day);
            const past = day < today;
            const weekday = DUTY_WEEKDAYS[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7];
            return (
              <div className={`duty-day${day === today ? ' is-today' : ''}${past ? ' is-past' : ''}`} key={day}>
                <span className="duty-day-name">
                  {weekday} {Number(day.slice(8))}
                  {row?.source === 'swap' ? <small className="duty-day-swap">подмена</small> : null}
                </span>
                {readOnly || past ? (
                  <strong>{row ? dutyMasterName(duty, row.master_id) : '—'}</strong>
                ) : (
                  <select aria-label={`Дежурный ${dutyDayLabel(day, 'ru')}`} value={valueOf(day)} onChange={(event) => setEdits((current) => ({ ...current, [day]: event.target.value }))}>
                    <option value="">—</option>
                    {(duty.masters || []).map((master) => (
                      <option key={master.id} value={String(master.id)}>
                        {worksOn(duty, day, master.id) ? master.name : `${master.name} · выходной`}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
        {!readOnly && changes.length ? (
          <button className="btn" type="button" disabled={busy} onClick={save}>{busy ? 'Сохраняю…' : 'Сохранить график'}</button>
        ) : null}
      </div>

      <div className="card wide duty-day-card">
        <h2>Фото дежурных</h2>
        <div className="day-chips" role="group" aria-label="День">
          {photoDays.map((day, index) => (
            <button className={`chip${photoDay === day ? ' on' : ''}`} key={day} type="button" onClick={() => setPhotoDay(day)}>
              {index === 0 ? 'Сегодня' : index === 1 ? 'Вчера' : <>{DUTY_WEEKDAYS[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7]} {Number(day.slice(8))}</>}
            </button>
          ))}
        </div>
        <DutyDayPhotos day={photoDay} zones={duty.zones || []} refreshKey={photoDay === today ? todayPhotos : 0} setError={setError} />
      </div>

      {swaps.length ? (
        <div className="card wide duty-swaps">
          <h2>Подмены</h2>
          {swaps.map((swap) => (
            <p key={swap.id}>
              {`${dutyMasterName(duty, swap.from_master_id)} → ${dutyMasterName(duty, swap.to_master_id)} · ${dutyDayLabel(swap.day, 'ru')} · ${swap.status === 'pending' ? 'ждёт ответа' : 'договорились'}`}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const AUDIT_ENTITY_LABELS = {
  fine: 'Штраф',
  expense: 'Расход',
  debt: 'Долг',
  debt_payment: 'Платёж по долгу',
  sale: 'Продажа',
  attendance: 'Отметка о приходе',
  product_receipts: 'Приход товара',
  product_sales: 'Продажа товара',
  product_writeoffs: 'Списание товара',
  master_advances: 'Аванс',
  master_payouts: 'Выплата',
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
              aria-label={`${displayDate(day)}: ${totals[day].clients} ${pluralRu(totals[day].clients, 'клиент', 'клиента', 'клиентов')}, выручка ${money(totals[day].revenue)} сум${previousDays[index] ? `; ${displayDate(previousDays[index])}: ${previousClientCounts[index]} ${pluralRu(previousClientCounts[index], 'клиент', 'клиента', 'клиентов')}, ${money(previousValues[index])} сум` : ''}`}
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
                fill="#D5DEEE"
                height={previousHeight}
                opacity={previousValues[index] ? 1 : 0}
                rx="3"
                width={barWidth}
                x={x}
                y={120 - previousHeight}
              />
              <rect
                className="chart-bar-current"
                fill="var(--accent)"
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

// Four sections in a bottom bar, where a thumb reaches them. The calendar and
// the client CRM were removed in September 2026 (2 appointments in a month
// against 571 sales, a client list nobody opened); their tables and server
// actions are untouched. Settings live behind the gear, not in the bar.
const NAV_ITEMS = [
  { id: 'overview', label: 'Главная', views: ['overview'], icon: 'home' },
  { id: 'sales', label: 'Продажи', views: ['admin'], icon: 'receipt' },
  { id: 'expenses', label: 'Расходы', views: ['finance'], icon: 'wallet' },
  { id: 'stock', label: 'Склад', views: ['stock'], icon: 'box' },
  { id: 'team', label: 'Команда', views: ['attendance', 'duty', 'master', 'bookings', 'payouts', 'reviews'], icon: 'team' },
];

// A master's own bar (owner's request of 2026-10-21): his working day, his
// calendar, and how clients rate him; and his duty (2026-10-26), its own tab.
const MASTER_NAV_ITEMS = [
  { id: 'work', label: 'Работа', views: ['master'], icon: 'scissors' },
  { id: 'calendar', label: 'Календарь', views: ['mycalendar'], icon: 'calendar' },
  { id: 'myreviews', label: 'Отзывы', views: ['myreviews'], icon: 'star' },
  { id: 'myduty', label: 'Дежурство', views: ['myduty'], icon: 'broom' },
];

const TEAM_TABS = [
  ['attendance', 'Посещаемость'],
  ['master', 'Рабочий день'],
  ['bookings', 'Записи'],
  ['payouts', 'Выплаты'],
  ['reviews', 'Отзывы'],
  // Last: anywhere else it pushed the pills on a phone to a third line.
  ['duty', 'Дежурство'],
];

// The administrator has no tab bar: two sections at the top of her screen.
const DESK_TABS = [
  ['bookings', 'Записи'],
  ['stock', 'Склад'],
];

const VIEW_TITLES = {
  overview: 'MAESTRO',
  admin: 'Продажи',
  finance: 'Расходы',
  attendance: 'Команда',
  duty: 'Команда',
  master: 'Команда',
  stock: 'Склад',
  bookings: 'Команда',
  payouts: 'Команда',
  reviews: 'Команда',
  settings: 'Настройки',
};

function viewIdsForUser(data) {
  // The front-desk administrator: Склад, for selling. The calendar joins it
  // when it comes back.
  if (data.role === 'frontdesk') return ['bookings', 'stock'];
  if (data.role === 'admin') {
    // No «Рабочий день» (entering sales for a master) and no settings.
    // The partner reads everything and takes bookings in «Записи».
    if (isReadOnly(data)) return ['overview', 'admin', 'finance', 'stock', 'attendance', 'duty', 'bookings', 'payouts'];
    const canSeeOverview = ['owner', 'admin'].includes(data.appRole);
    return [
      ...(canSeeOverview ? ['overview'] : []),
      'admin',
      'finance',
      'stock',
      'attendance',
      // The duty roster is the owner's to set (owner's decision of 2026-10-26).
      ...(data.appRole === 'owner' ? ['duty'] : []),
      'master',
      'bookings',
      ...(data.appRole === 'owner' ? ['payouts', 'reviews'] : []),
      'settings',
    ];
  }
  if (data.role === 'master') return ['master', 'mycalendar', 'myreviews', 'myduty'];
  return [];
}

// Sideways only: the page itself does not move.
function keepTabInSight(button) {
  const strip = button?.parentElement;
  if (!strip) return;
  const offset = button.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  strip.scrollLeft += offset - (strip.clientWidth - button.clientWidth) / 2;
}

// A light tap under the thumb when a tab or a decision lands. Telegram only;
// elsewhere it does nothing.
function haptic(kind = 'light') {
  try {
    const feedback = window.Telegram?.WebApp?.HapticFeedback;
    if (!feedback) return;
    if (kind === 'success' || kind === 'error') feedback.notificationOccurred(kind);
    else feedback.impactOccurred(kind);
  } catch {
    // Older clients lack haptics; the tap simply stays silent.
  }
}

function todayHeading() {
  const date = new Date(`${TODAY}T12:00:00`);
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(date);
  const month = new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(date);
  const capitalized = month.charAt(0).toUpperCase() + month.slice(1);
  return `${capitalized} · ${weekday}, ${date.getDate()}`;
}

function NavIcon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
  if (name === 'home') return <svg {...common}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></svg>;
  if (name === 'receipt') return <svg {...common}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>;
  if (name === 'wallet') return <svg {...common}><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M16 15h2" /></svg>;
  if (name === 'box') return <svg {...common}><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
  if (name === 'scissors') return <svg {...common}><circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8.1 15.9 20 4M15.9 15.9 4 4" /></svg>;
  if (name === 'calendar') return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>;
  if (name === 'star') return <svg {...common}><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>;
  if (name === 'broom') return <svg {...common}><path d="M19 3l-7.5 7.5" /><path d="M9.5 9.5l5 5" /><path d="M9.5 9.5C7 10 4.5 12.5 3 17l4 4c4.5-1.5 7-4 7.5-6.5" /><path d="M6.5 15.5l2 2" /></svg>;
  return <svg {...common}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.6 3.5 6" /></svg>;
}

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const SCHEDULE_WEEKDAYS = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [7, 'Вс']];
// The version every master had before schedules were dated.
const SCHEDULE_ALWAYS = '2000-01-01';

// One shift a day: if a day ever held two, the editor shows its whole span.
function scheduleDraftFrom(rules) {
  const firstWorking = rules[0];
  const fallback = {
    starts: firstWorking ? String(firstWorking.starts_at).slice(0, 5) : '10:00',
    ends: firstWorking ? String(firstWorking.ends_at).slice(0, 5) : '22:00',
  };
  return SCHEDULE_WEEKDAYS.map(([iso]) => {
    const day = rules.filter((rule) => Number(rule.iso_weekday) === iso);
    if (!day.length) return { iso, works: false, ...fallback };
    return {
      iso,
      works: true,
      starts: day.map((rule) => String(rule.starts_at).slice(0, 5)).sort()[0],
      ends: day.map((rule) => String(rule.ends_at).slice(0, 5)).sort().pop(),
    };
  });
}

function scheduleFromLabel(from) {
  return from <= SCHEDULE_ALWAYS ? '' : `с ${displayDate(from)}`;
}

// The owner sets each master's week here instead of asking for it in SQL. A
// change is saved from a date: the days before it keep the week they were
// worked under, so lateness already counted does not move.
function MasterSchedules({ data, reload, setError }) {
  const masters = data.activeMasters;
  const [masterId, setMasterId] = useState(masters[0]?.id ?? null);
  const master = masters.find((item) => String(item.id) === String(masterId)) || masters[0] || null;
  const versions = scheduleVersions(master, data.scheduleRules);
  const current = scheduleRulesOn(master, TODAY, data.scheduleRules);
  const currentFrom = versions.filter((version) => version.from <= TODAY).pop()?.from || null;
  const upcoming = versions.filter((version) => version.from > TODAY);
  const [draft, setDraft] = useState(() => scheduleDraftFrom(current));
  const [from, setFrom] = useState(TODAY);
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const firstWorking = draft.find((day) => day.works);

  function pickMaster(id) {
    const next = masters.find((item) => String(item.id) === String(id));
    setMasterId(id);
    setDraft(scheduleDraftFrom(scheduleRulesOn(next, TODAY, data.scheduleRules)));
    setFrom(TODAY);
    setMessage('');
  }

  function editVersion(version) {
    setDraft(scheduleDraftFrom(version.rules));
    setFrom(version.from > TODAY ? version.from : TODAY);
    setMessage('');
  }

  function setDay(iso, patch) {
    setDraft((days) => days.map((day) => (day.iso === iso ? { ...day, ...patch } : day)));
  }

  // The hours typed on one day, copied to every working day: most masters
  // keep the same hours all week.
  function copyToWorkingDays(source) {
    setDraft((days) => days.map((day) => (day.works ? { ...day, starts: source.starts, ends: source.ends } : day)));
  }

  async function save(event) {
    event.preventDefault();
    if (!master) return;
    const working = draft.filter((day) => day.works);
    if (!working.length) return setError(ACTION_ERROR_TEXT.schedule_needs_work_day);
    const broken = working.find((day) => !day.starts || !day.ends || day.ends <= day.starts);
    if (broken) {
      const label = SCHEDULE_WEEKDAYS.find(([iso]) => iso === broken.iso)[1];
      return setError(`${label}: конец смены должен быть позже начала.`);
    }
    if (!from) return setError('Выберите, с какого дня действует график.');
    if (from < TODAY && !await confirmAction(
      `График начнёт действовать задним числом, с ${displayDate(from)}. Опоздания и табель за эти дни пересчитаются. Продолжить?`,
    )) return;

    const ok = await run(
      () => callLegacyApi('setMasterSchedule', {
        master_id: master.id,
        effective_from: from,
        days: working.map((day) => ({ iso_weekday: day.iso, starts_at: day.starts, ends_at: day.ends })),
      }).then(reload),
      from > TODAY
        ? `${master.name}: график сохранён. Начнёт действовать ${displayDate(from)}, до этого — прежний.`
        : `${master.name}: график сохранён и действует с ${displayDate(from)}.`,
    );
    if (ok) haptic('success');
  }

  async function cancelUpcoming(version) {
    if (!master || !await confirmAction(`${master.name}: отменить график с ${displayDate(version.from)}?`)) return;
    const ok = await run(
      () => callLegacyApi('delMasterSchedule', { master_id: master.id, effective_from: version.from }).then(reload),
      'Будущий график отменён.',
    );
    if (ok) {
      setDraft(scheduleDraftFrom(current));
      setFrom(TODAY);
    }
  }

  if (!masters.length) return null;

  return (
    <form className="card wide settings-card schedule-card" onSubmit={save}>
      <h2>График мастеров</h2>
      <div className="seg" role="tablist" aria-label="Мастер">
        {masters.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={String(item.id) === String(master?.id)}
            className={String(item.id) === String(master?.id) ? 'on' : ''}
            onClick={() => pickMaster(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>

      <div className="schedule-now">
        <span>Сейчас{currentFrom && scheduleFromLabel(currentFrom) ? ` · ${scheduleFromLabel(currentFrom)}` : ''}</span>
        <strong>{current.length ? scheduleSummary(current) : 'График не задан — опоздания не считаются'}</strong>
      </div>
      {upcoming.map((version) => (
        <div className="schedule-next" key={version.from}>
          <span>С {displayDate(version.from)}</span>
          <strong>{scheduleSummary(version.rules)}</strong>
          <div className="schedule-next-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => editVersion(version)}>Изменить</button>
            <button className="btn ghost schedule-cancel" type="button" disabled={busy} onClick={() => cancelUpcoming(version)}>Отменить</button>
          </div>
        </div>
      ))}

      <div className="schedule-days">
        {draft.map((day) => {
          const label = SCHEDULE_WEEKDAYS.find(([iso]) => iso === day.iso)[1];
          return (
            <div className={day.works ? 'schedule-day' : 'schedule-day off'} key={day.iso}>
              <button
                type="button"
                className={day.works ? 'schedule-day-toggle on' : 'schedule-day-toggle'}
                aria-pressed={day.works}
                aria-label={`${label}: ${day.works ? 'рабочий день' : 'выходной'}`}
                onClick={() => setDay(day.iso, { works: !day.works })}
              >
                {label}
              </button>
              {day.works ? (
                <>
                  <input
                    type="time"
                    aria-label={`${label}: начало`}
                    value={day.starts}
                    onChange={(event) => setDay(day.iso, { starts: event.target.value })}
                  />
                  <span className="schedule-dash">–</span>
                  <input
                    type="time"
                    aria-label={`${label}: конец`}
                    value={day.ends}
                    onChange={(event) => setDay(day.iso, { ends: event.target.value })}
                  />
                </>
              ) : (
                <span className="schedule-off-label">выходной</span>
              )}
            </div>
          );
        })}
      </div>
      {firstWorking ? (
        <button className="btn ghost" type="button" onClick={() => copyToWorkingDays(firstWorking)}>
          Часы {SCHEDULE_WEEKDAYS.find(([iso]) => iso === firstWorking.iso)[1]} — на все рабочие дни
        </button>
      ) : null}

      <label>
        Действует с
        <input
          type="date"
          value={from}
          min={shiftDate(TODAY, -62)}
          max={shiftDate(TODAY, 366)}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <button className="btn" type="submit" disabled={busy}>Сохранить график</button>
    </form>
  );
}

// Everything that is set once and rarely touched, moved out of the screens
// that are read every day: the month's goal, the masters' schedules, the
// grace for lateness and the salon's location, and the deletion log.
function SettingsView({ data, reload, setError }) {
  const canEdit = ['owner', 'admin'].includes(data.appRole);
  const setMessage = useNotice();
  const { run, busy } = useAction(setError, setMessage);
  const goal = Number(data.settings.monthly_revenue_goal) || null;
  const [goalDraft, setGoalDraft] = useState(goal ? String(goal) : '');
  const [settings, setSettings] = useState({
    late_grace_minutes: String(data.settings.late_grace_minutes ?? 10),
    late_fine_amount: String(data.settings.late_fine_amount ?? 100000),
    no_mark_fine_amount: String(data.settings.no_mark_fine_amount ?? 100000),
    salon_lat: data.settings.salon_lat || '',
    salon_lng: data.settings.salon_lng || '',
    salon_radius: data.settings.salon_radius || 100,
  });

  async function saveGoal(event) {
    event.preventDefault();
    const value = Number(goalDraft);
    if (!value || value <= 0) return setError('Введите сумму цели.');
    await run(() => callLegacyApi('setSettings', { monthly_revenue_goal: value }).then(reload), 'Цель сохранена.');
    haptic('success');
  }

  async function clearGoal() {
    const ok = await run(() => callLegacyApi('setSettings', { monthly_revenue_goal: null }).then(reload), 'Цель убрана.');
    if (ok) setGoalDraft('');
  }

  async function saveSettings(event) {
    event.preventDefault();
    const grace = Number(settings.late_grace_minutes);
    if (settings.late_grace_minutes === '' || !Number.isInteger(grace) || grace < 0 || grace > 120) {
      return setError('Допуск — целое число минут от 0 до 120.');
    }
    const lateFine = Number(settings.late_fine_amount);
    const noMarkFine = Number(settings.no_mark_fine_amount);
    if (![lateFine, noMarkFine].every((value) => Number.isInteger(value) && value >= 0 && value <= 10000000)) {
      return setError(ACTION_ERROR_TEXT.invalid_fine);
    }
    await run(() => callLegacyApi('setSettings', {
      late_grace_minutes: grace,
      late_fine_amount: lateFine,
      no_mark_fine_amount: noMarkFine,
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

  return (
    <section className="view-grid">

      {canEdit ? (
        <form className="card wide hero-card settings-goal" onSubmit={saveGoal}>
          <span className="hero-eyebrow">ЦЕЛЬ НА МЕСЯЦ</span>
          <p>
            {goal
              ? `Сейчас: ${money(goal)} сум. На главной видно, сколько уже выполнено и сколько нужно в день.`
              : 'Поставьте план по выручке — на главной появится шкала и подсказка, сколько нужно в день.'}
          </p>
          <MoneyInput aria-label="Цель по выручке на месяц" placeholder="например, 85 000 000" value={goalDraft} onChange={setGoalDraft} />
          <div className="settings-actions">
            <button className="btn light" type="submit" disabled={busy}>{goal ? 'Изменить цель' : 'Поставить цель'}</button>
            {goal ? <button className="btn ghost-light" type="button" disabled={busy} onClick={clearGoal}>Убрать</button> : null}
          </div>
        </form>
      ) : null}

      {canEdit ? <MasterSchedules data={data} reload={reload} setError={setError} /> : null}

      {canEdit ? (
        <form className="card wide settings-card" onSubmit={saveSettings}>
          <h2>Отметка прихода</h2>
          <label>
            Допуск на опоздание, мин
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="120"
              step="1"
              value={settings.late_grace_minutes}
              onChange={(event) => setSettings({ ...settings, late_grace_minutes: event.target.value })}
            />
          </label>
          <label>
            Штраф за опоздание
            <MoneyInput value={settings.late_fine_amount} onChange={(value) => setSettings({ ...settings, late_fine_amount: value })} />
          </label>
          <label>
            Штраф без отметки к 18:00
            <MoneyInput value={settings.no_mark_fine_amount} onChange={(value) => setSettings({ ...settings, no_mark_fine_amount: value })} />
          </label>
          <label>Радиус отметки, м<input type="number" value={settings.salon_radius} onChange={(event) => setSettings({ ...settings, salon_radius: event.target.value })} /></label>
          <button className="btn ghost" type="button" onClick={useMyLocation}>Задать место салона по моему положению</button>
          <details className="settings-coordinates">
            <summary>Координаты вручную</summary>
            <div className="settings-pair">
              <label>Широта<input type="number" step="any" value={settings.salon_lat} onChange={(event) => setSettings({ ...settings, salon_lat: event.target.value })} /></label>
              <label>Долгота<input type="number" step="any" value={settings.salon_lng} onChange={(event) => setSettings({ ...settings, salon_lng: event.target.value })} /></label>
            </div>
          </details>
          <button className="btn" type="submit" disabled={busy}>Сохранить</button>
        </form>
      ) : null}

      {data.appRole === 'owner' ? <DeletionLog setError={setError} /> : null}

    </section>
  );
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

// Someone whose Telegram is not on the staff list (a client who tapped the
// bot's menu, anyone at all) sees this and nothing of the app behind it. His
// own Telegram ID is shown so that a new hire can send it to the owner.
function AccessDenied() {
  const telegramId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return (
    <main className="login-gate">
      <div className="login-card">
        <img src="/icons/icon-192.png" alt="Maestro" />
        <h1>Maestro</h1>
        <p>Это приложение для сотрудников салона. Вашего Telegram нет в списке.</p>
        {telegramId ? <p className="hint">Ваш Telegram ID: {telegramId}</p> : null}
      </div>
    </main>
  );
}

export default function App() {
  const [data, setData] = useState(emptyState);
  const [accessDenied, setAccessDenied] = useState(false);
  const [view, setView] = useState('overview');
  const [previousView, setPreviousView] = useState('overview');
  const [isLoading, setIsLoading] = useState(true);
  const loadInFlightRef = useRef(null);
  const [error, setError] = useState('');
  // The error a failed load put up, so that the next good load takes back
  // only its own and never an action's.
  const loadErrorRef = useRef('');
  const [success, setSuccess] = useState({ text: '', at: 0 });
  const notify = useCallback((text) => setSuccess({ text: text || '', at: Date.now() }), []);
  const [loginRequired, setLoginRequired] = useState(false);
  const [lang, setLang] = useState(initialLanguage);
  // The server's language is taken once, on the first load; after that the
  // person's own switch decides.
  const langSettledRef = useRef(false);

  useEffect(() => {
    applyLanguage(lang);
  }, [lang]);

  function toggleLanguage() {
    const next = lang === 'uz' ? 'ru' : 'uz';
    langSettledRef.current = true;
    setLang(next);
    rememberLanguage(next);
    callLegacyApi('setLanguage', { lang: next }).catch(() => {
      // The phone remembers it; the server learns on the next switch.
    });
  }

  // Telegram paints its own header and the area behind the app; matching them
  // to the page removes the seam at the top of the screen.
  useEffect(() => {
    const telegram = window.Telegram?.WebApp;
    try {
      telegram?.setHeaderColor?.('#F4F6F9');
      telegram?.setBackgroundColor?.('#F4F6F9');
    } catch {
      // Older clients ignore the colours; nothing else depends on them.
    }
    // Opened at full height, and a swipe down while scrolling a list no
    // longer folds the app away (owner's review of 2026-10-26).
    try {
      telegram?.expand?.();
      if (telegram?.isVersionAtLeast?.('7.7')) telegram.disableVerticalSwipes?.();
    } catch {
      // Older clients: the app opens and swipes as before.
    }
    const button = telegram?.BackButton;
    try {
      button?.onClick?.(goBackOneStep);
    } catch {
      return undefined;
    }
    return () => {
      try {
        button?.offClick?.(goBackOneStep);
      } catch {
        // Nothing to undo on an old client.
      }
    };
  }, []);

  // From Настройки, «Назад» returns to the screen it was opened from.
  useTelegramBack(() => openView(previousView), view === 'settings');

  // A refresh asked for while another was running used to be dropped. After a
  // tap that kept the row just confirmed on screen: the 15s poll in flight had
  // read the table before the write, and the tap looked ignored. The refresh now
  // waits its turn and runs once the other has finished.
  function load(options) {
    if (loadInFlightRef.current) return loadInFlightRef.current.then(() => load(options));
    const pending = loadOnce(options).finally(() => {
      if (loadInFlightRef.current === pending) loadInFlightRef.current = null;
    });
    loadInFlightRef.current = pending;
    return pending;
  }

  // What a screen calls after its own write. It used to be a full load — every
  // sale since February, three pages of them — so each saved drink waited
  // seconds for history it did not change. The 15s poll's window is enough: a
  // write lands in it, and the full load still runs when the app comes back
  // into view.
  // A caller that knows its own window (an approval of an older sale) passes it.
  function reload(options = {}) {
    return load({ preserveView: true, since: pollWindowStart(), ...options });
  }

  async function loadOnce({ preserveView = true, since = null } = {}) {
    // A load no longer clears the screen's error: the 15s poll used to wipe
    // «Сначала закройте запись» before the master had read it. An action's
    // error stays until the next action, a new screen or ×.
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
      registerNames(normalized.bookingServices.map((service) => [service.name_ru, service.name_uz]));
      // Duty zones and the check's reasons come in both languages.
      registerNames([
        ...(normalized.duty?.zones || []).flatMap((zone) => [[zone.name_ru, zone.name_uz], [zone.checklist_ru, zone.checklist_uz]]),
        ...(normalized.duty?.windows || []).flatMap((window) => Object.values(window.zones_rejected || {})
          .map((refusal) => [refusal.reason_ru, refusal.reason_uz])),
      ]);
      registerData(normalized.products.map((product) => product.name));
      if (!langSettledRef.current && normalized.lang) {
        langSettledRef.current = true;
        setLang(normalized.lang);
        rememberLanguage(normalized.lang);
      }
      // Trust the window only if the server confirms it applied one; an older
      // deployment ignores `since` and answers with everything, which merges
      // correctly either way but must not discard rows it did return.
      const appliedSince = result?.windowSince === since ? since : null;
      setData((previous) => (
        appliedSince ? mergeWindowedData(previous, normalized, appliedSince) : normalized
      ));
      if (loadErrorRef.current) {
        const stale = loadErrorRef.current;
        loadErrorRef.current = '';
        setError((current) => (current === stale ? '' : current));
      }
      setLoginRequired(false);
      setView((currentView) => {
        const allowed = viewIdsForUser(normalized);
        if (!preserveView) {
          if (allowed.includes('overview')) return 'overview';
          return normalized.role === 'admin' ? 'admin' : allowed[0] || 'master';
        }
        return allowed.includes(currentView) ? currentView : allowed[0];
      });
    } catch (loadError) {
      // Not on the staff list: no app at all, not an empty one.
      if (loadError.details?.error === 'not_in_list' || loadError.message === 'not_in_list') {
        setAccessDenied(true);
        return;
      }
      const text = actionErrorText(loadError) || 'Не удалось загрузить данные.';
      loadErrorRef.current = text;
      setError(text);
      if (String(loadError.message).includes('unauthorized')) setLoginRequired(true);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    load({ preserveView: false });
  }, []);

  useEffect(() => {
    // Nobody to refresh for: signed out, or not on the staff list.
    if (loginRequired || accessDenied) return undefined;

    let intervalId;

    const refresh = ({ full = false } = {}) => {
      if (!document.hidden && !loadInFlightRef.current) {
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
  }, [loginRequired, accessDenied]);

  const availableViews = useMemo(() => viewIdsForUser(data), [data.appRole, data.role]);
  // An item is only offered if the role can reach something inside it.
  const navItems = useMemo(() => (
    (data.role === 'master' ? MASTER_NAV_ITEMS : NAV_ITEMS)
      .map((item) => ({ ...item, views: item.views.filter((id) => availableViews.includes(id)) }))
      .filter((item) => item.views.length)
  ), [availableViews, data.role]);
  // The badge is work for whoever approves; a read-only account has none.
  const pendingSalesCount = isReadOnly(data) ? 0 : approvalQueue(data).count;
  // A master's duty tab lights up for a request or a photo due now.
  const dutyBadge = data.role === 'master' && data.duty
    ? masterDutyAttention(data.duty, data.byName[data.me]?.id, data.duty.today, Date.now())
    : 0;

  // «Пришёл → визит» on a booking opens the owner's Рабочий день with the
  // visit filled in.
  const [visitDraft, setVisitDraft] = useState(null);
  const clearVisitDraft = useCallback(() => setVisitDraft(null), []);

  // A «said» line fades on its own; an error waits to be read.
  useEffect(() => {
    if (!success.text) return undefined;
    const timer = window.setTimeout(() => setSuccess({ text: '', at: 0 }), 4000);
    return () => window.clearTimeout(timer);
  }, [success]);

  function closeNotice() {
    setError('');
    setSuccess({ text: '', at: 0 });
  }

  function openView(next) {
    if (next === view) return;
    haptic('light');
    // An error belongs to the screen it was made on.
    setError('');
    if (next === 'settings') setPreviousView(view);
    setView(next);
    window.scrollTo({ top: 0 });
  }

  function startVisitFromBooking(appointment) {
    setVisitDraft(appointment);
    openView('master');
  }

  if (accessDenied) return <AccessDenied />;
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
    duty: DutyView,
    finance: FinanceView,
    stock: data.role === 'frontdesk' ? DeskStockView : StockView,
    bookings: BookingsView,
    payouts: PayoutsView,
    reviews: ReviewsView,
    mycalendar: MasterCalendarView,
    myreviews: MasterReviewsView,
    myduty: MasterDutyView,
    settings: SettingsView,
  }[view] || MasterView;

  const isMaster = data.role === 'master';
  const isFrontDesk = data.role === 'frontdesk';
  // A bar with one button is not navigation.
  const showTabbar = !isFrontDesk && navItems.length > 1;
  const masterProfile = isMaster ? data.byName[data.me] : null;
  const title = isMaster
    ? (data.me || 'Maestro')
    : isFrontDesk ? (view === 'stock' ? 'Склад' : 'Записи') : VIEW_TITLES[view] || 'Maestro';
  const subtitle = isMaster
    ? `${Number(masterProfile?.pct) || 40}% мастеру · ${todayHeading().split(' · ')[1]}`
    : isFrontDesk
      ? `Администратор · ${todayHeading().split(' · ')[1]}`
    : view === 'settings'
      ? `${data.appRole === 'owner' ? 'Владелец' : 'Администратор'} · вход через Telegram`
      : todayHeading();
  const inTeam = ['attendance', 'duty', 'master', 'bookings', 'payouts', 'reviews'].includes(view);
  const teamTabs = TEAM_TABS.filter(([id]) => availableViews.includes(id));

  return (
    <main className={`app${isMaster ? ' is-master' : ''}${showTabbar ? ' has-tabbar' : ''}`}>
      <header className="app-header">
        {view === 'settings' ? (
          <button className="back-button" type="button" onClick={() => openView(previousView)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            Назад
          </button>
        ) : null}
        <div className="app-header-row">
          <div className="app-header-titles">
            <h1 className={view === 'overview' ? 'is-wordmark' : ''}>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="app-header-actions">
            <button aria-label="Язык · Til" className="lang-button" data-no-translate type="button" onClick={toggleLanguage}>
              {lang === 'uz' ? 'RU' : 'UZ'}
            </button>
            {!isMaster && view !== 'settings' && availableViews.includes('settings') ? (
              <button aria-label="Настройки" className="gear-button" type="button" onClick={() => openView('settings')}>
                <GearIcon />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {inTeam && !isMaster && teamTabs.length > 1 ? (
        <nav className="seg team-tabs" aria-label="Команда">
          {teamTabs.map(([id, label]) => (
            <button
              className={view === id ? 'on' : ''}
              key={id}
              type="button"
              onClick={() => openView(id)}
              // Five tabs run past a phone's width: the open one is kept in sight.
              ref={view === id ? keepTabInSight : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      ) : null}

      {isFrontDesk ? (
        <nav className="seg team-tabs" aria-label="Разделы">
          {DESK_TABS.map(([id, label]) => (
            <button className={view === id ? 'on' : ''} key={id} type="button" onClick={() => openView(id)}>{label}</button>
          ))}
        </nav>
      ) : null}

      <NoticeContext.Provider value={notify}>
        <CurrentView
          data={data}
          reload={reload}
          setError={setError}
          setView={openView}
          onVisit={data.appRole === 'owner' || isMaster ? startVisitFromBooking : null}
          visitDraft={visitDraft}
          onDraftUsed={clearVisitDraft}
        />
      </NoticeContext.Provider>
      <AppNotice error={error} success={success.text} onClose={closeNotice} />

      {showTabbar ? (
        <nav className="tabbar" aria-label="Разделы" style={{ '--tabs': navItems.length }}>
          {navItems.map((item) => {
            const active = item.views.includes(view);
            const badge = item.id === 'sales' ? pendingSalesCount : item.id === 'myduty' ? dutyBadge : 0;
            return (
              <button
                aria-current={active ? 'page' : undefined}
                className={active ? 'on' : ''}
                key={item.id}
                type="button"
                onClick={() => openView(item.views.includes(view) ? view : item.views[0])}
              >
                <NavIcon name={item.icon} />
                <span>{item.label}</span>
                {badge ? (
                  <b className="tabbar-badge" aria-label={item.id === 'myduty' ? 'Дежурство ждёт вас' : `${badge} продаж ожидают подтверждения`}>
                    {badge > 99 ? '99+' : badge}
                  </b>
                ) : null}
              </button>
            );
          })}
        </nav>
      ) : null}
    </main>
  );
}
