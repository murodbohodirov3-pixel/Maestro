// The morning new-client digest for the marketing group. Everything that can
// be wrong about the message lives here: which days make up "yesterday", "this
// week" and "this month", how sales turn into client counts, and the Russian
// wording. index.ts only loads rows and talks to Telegram, so this module runs
// both inside the Edge Function (Deno) and under node in test/.

export const TIME_ZONE = 'Asia/Tashkent';

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAYS_IN = ['в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье'];
const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

// Same rule as src/utils/plural.js: 21 takes the form of 1, 11 does not.
export function pluralRu(count, one, few, many) {
  const number = Math.abs(Math.trunc(Number(count) || 0));
  const lastTwo = number % 100;
  const lastDigit = number % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}

function newClientsPhrase(count) {
  return `${count} ${pluralRu(count, 'новый клиент', 'новых клиента', 'новых клиентов')}`;
}

// ---------------------------------------------------------------------------
// Dates. Everything is an ISO string; Date is used only for arithmetic in UTC
// so the server's own timezone can never shift a day.

export function isoDateInTimeZone(now = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function split(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function join(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(iso, days) {
  const { year, month, day } = split(iso);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Monday is 1, Sunday is 7.
export function isoWeekday(iso) {
  const { year, month, day } = split(iso);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatDay(iso) {
  const { month, day } = split(iso);
  return `${day} ${MONTHS_GENITIVE[month - 1]}`;
}

export function formatShortDay(iso) {
  const { month, day } = split(iso);
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}`;
}

// "15–21 сентября", "31 августа – 6 сентября" or just "21 сентября".
export function formatRange(from, to) {
  if (from === to) return formatDay(to);
  const start = split(from);
  const end = split(to);
  if (start.month === end.month) return `${start.day}–${end.day} ${MONTHS_GENITIVE[end.month - 1]}`;
  return `${formatDay(from)} – ${formatDay(to)}`;
}

export function monthName(iso) {
  return MONTHS_NOMINATIVE[split(iso).month - 1];
}

// The digest is read in the morning about the day before, so every period
// ends on yesterday: the week is yesterday's Monday..yesterday, the month is
// the 1st..yesterday. On the 1st that makes the month range the whole
// previous month, which is exactly the recap the marketers want that day.
export function digestRanges(today) {
  if (!isValidIsoDate(today)) throw new Error('invalid_date');
  const yesterday = addDays(today, -1);
  const { year, month, day } = split(yesterday);

  const weekFrom = addDays(yesterday, -(isoWeekday(yesterday) - 1));
  const monthFrom = join(year, month, 1);
  const monthLength = daysInMonth(year, month);

  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousLength = daysInMonth(previousYear, previousMonth);

  return {
    today,
    yesterday,
    week: { from: weekFrom, to: yesterday },
    month: { from: monthFrom, to: yesterday, full: day === monthLength },
    previousMonth: {
      from: join(previousYear, previousMonth, 1),
      to: join(previousYear, previousMonth, previousLength),
      // The same stretch of days one month earlier. 31 March compares with
      // 1–28 February, since February has no 31st to reach.
      sameTo: join(previousYear, previousMonth, Math.min(day, previousLength)),
    },
    // The rows the digest needs: the previous month in full plus everything up
    // to yesterday. The week never starts earlier than that.
    load: { from: join(previousYear, previousMonth, 1), to: yesterday },
  };
}

// ---------------------------------------------------------------------------
// Sales → client counts. These mirror the app and agents-report exactly, so the
// group sees the same numbers the owner sees on the "По мастерам" screen. Only
// sales flagged as a new client are ever counted: returning clients and rows
// without the flag are the owner's business, not the marketers'.

export function rowDate(sale) {
  return String(sale.d || sale.sale_date || '');
}

export function saleClients(sale) {
  const value = Number(sale.clients_count ?? sale.cl ?? 1);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 1;
}

export function isPendingOwnerApproval(sale) {
  return sale.status === 'pending' && sale.comment === 'owner_approval_required';
}

export function isRejectedByOwner(sale) {
  return sale.status === 'rejected' && sale.comment === 'owner_approval_rejected';
}

export function isCountedSale(sale) {
  return !isPendingOwnerApproval(sale) && !isRejectedByOwner(sale);
}

function inRange(sale, from, to) {
  const date = rowDate(sale);
  return Boolean(date) && date >= from && date <= to;
}

function newClientsIn(sales, from, to) {
  return sales
    .filter((sale) => inRange(sale, from, to) && sale.is_new_client === true)
    .reduce((sum, sale) => sum + saleClients(sale), 0);
}

export function percentChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function summarizeDigest(sales, today) {
  const ranges = digestRanges(today);
  // A master's sale waits for the owner's approval and stays out of every
  // count until then, exactly as in the app. The owner chose not to mention
  // the waiting ones in the message, so a late approval simply shows up in
  // the next morning's totals.
  const counted = sales.filter(isCountedSale);

  const days = [];
  for (let date = ranges.week.from; date <= ranges.week.to; date = addDays(date, 1)) {
    days.push({ date, weekday: isoWeekday(date), newClients: newClientsIn(counted, date, date) });
  }

  const monthNewClients = newClientsIn(counted, ranges.month.from, ranges.month.to);
  const previousSamePeriod = newClientsIn(counted, ranges.previousMonth.from, ranges.previousMonth.sameTo);

  return {
    today: ranges.today,
    yesterday: {
      date: ranges.yesterday,
      weekday: isoWeekday(ranges.yesterday),
      newClients: newClientsIn(counted, ranges.yesterday, ranges.yesterday),
    },
    week: { ...ranges.week, newClients: days.reduce((sum, day) => sum + day.newClients, 0), days },
    month: { ...ranges.month, newClients: monthNewClients },
    previousMonth: {
      ...ranges.previousMonth,
      samePeriodNewClients: previousSamePeriod,
      totalNewClients: newClientsIn(counted, ranges.previousMonth.from, ranges.previousMonth.to),
    },
    changePercent: percentChange(monthNewClients, previousSamePeriod),
  };
}

// ---------------------------------------------------------------------------
// Wording. Telegram renders this with parse_mode=HTML; the only markup is <b>
// and no user-entered text reaches the message, so nothing needs escaping.

function bold(text) {
  return `<b>${text}</b>`;
}

function arrivedSentence(count) {
  if (count === 0) return 'новых клиентов не было';
  const form = pluralRu(count, 'one', 'few', 'many');
  const verb = form === 'one' ? 'пришёл' : form === 'few' ? 'пришли' : 'пришло';
  return `${verb} ${bold(newClientsPhrase(count))}`;
}

function monthLabel(month) {
  const name = monthName(month.from);
  const capitalised = name[0].toUpperCase() + name.slice(1);
  if (month.full) return `Весь ${name}`;
  const { day } = split(month.to);
  return day === 1 ? `${capitalised}, 1 число` : `${capitalised}, 1–${day} число`;
}

function comparisonLines(summary) {
  const { month, previousMonth, changePercent } = summary;
  const previousPeriod = month.full
    ? `за весь ${monthName(previousMonth.from)}`
    : `за ${formatRange(previousMonth.from, previousMonth.sameTo)}`;
  const lines = [];

  if (previousMonth.samePeriodNewClients === 0) {
    lines.push(`${previousPeriod[0].toUpperCase()}${previousPeriod.slice(1)} новых клиентов не было.`);
  } else if (changePercent === 0) {
    lines.push(`Столько же, сколько ${previousPeriod} (${previousMonth.samePeriodNewClients} новых).`);
  } else {
    const direction = changePercent > 0 ? 'больше' : 'меньше';
    lines.push(`Это на ${bold(`${Math.abs(changePercent)}% ${direction}`)}, чем ${previousPeriod} (${previousMonth.samePeriodNewClients} новых).`);
  }

  // Once the month is over, the comparison above already covers the whole of
  // the previous one, so the extra line would repeat it.
  if (!month.full) {
    lines.push(`За весь ${monthName(previousMonth.from)} — ${newClientsPhrase(previousMonth.totalNewClients)}.`);
  }
  return lines;
}

export function formatDigest(summary) {
  const { today, yesterday, week, month } = summary;
  const lines = [
    `☀️ Доброе утро! Сегодня ${WEEKDAYS[isoWeekday(today) - 1]}, ${formatDay(today)}.`,
    '',
    `Вчера, ${WEEKDAYS_IN[yesterday.weekday - 1]} ${formatDay(yesterday.date)}, ${arrivedSentence(yesterday.newClients)}.`,
  ];

  const weekTitle = yesterday.weekday === 7 ? 'Прошлая неделя' : 'Эта неделя';
  lines.push('', `📅 ${weekTitle} (${formatRange(week.from, week.to)}): ${bold(newClientsPhrase(week.newClients))}`);
  for (const day of week.days) {
    const count = day.newClients;
    const label = count === 0 ? '0' : `${count} ${pluralRu(count, 'новый', 'новых', 'новых')}`;
    lines.push(`${WEEKDAYS_SHORT[day.weekday - 1]} ${formatShortDay(day.date)} — ${label}`);
  }

  lines.push('', `📈 ${monthLabel(month)}: ${bold(newClientsPhrase(month.newClients))}.`, ...comparisonLines(summary));
  return lines.join('\n');
}

export function buildDigest(sales, today) {
  const summary = summarizeDigest(sales, today);
  return { summary, text: formatDigest(summary) };
}
