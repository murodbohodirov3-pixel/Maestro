import { localDate } from './loadWindow.js';

// Yesterday is the wrong yardstick for a barbershop. Traffic follows the week,
// not the calendar: a Thursday next to a Wednesday compares two different kinds
// of day, and the difference says more about the weekday than about the salon.
// Seven days back is always the same weekday.
export function sameWeekdayLastWeek(day) {
  const anchor = new Date(`${day}T12:00:00`);
  if (Number.isNaN(anchor.getTime())) return '';
  anchor.setDate(anchor.getDate() - 7);
  return localDate(anchor);
}

const MONTHS_DATIVE = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// Indexed by Date#getDay, so Sunday first.
const LAST_WEEKDAY_DATIVE = [
  'прошлому воскресенью',
  'прошлому понедельнику',
  'прошлому вторнику',
  'прошлой среде',
  'прошлому четвергу',
  'прошлой пятнице',
  'прошлой субботе',
];

function parseDay(day) {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shortDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function mondayOf(date) {
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return monday;
}

// "01.08.2026–29.08.2026" under every figure read like a second, unexplained
// number. The comparison is named the way the owner would say it instead.
export function comparisonLabel(range, today) {
  const from = parseDay(range?.from);
  const to = parseDay(range?.to);
  if (!from || !to) return '';

  if (range.from === range.to) {
    if (today && range.from === sameWeekdayLastWeek(today)) return `к ${LAST_WEEKDAY_DATIVE[from.getDay()]}`;
    const yesterday = parseDay(today);
    if (yesterday) {
      yesterday.setDate(yesterday.getDate() - 1);
      if (localDate(yesterday) === range.from) return 'ко вчерашнему дню';
    }
    return `к ${shortDate(from)}`;
  }

  const sameMonth = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth();
  if (sameMonth && from.getDate() === 1) {
    const lastDay = new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate();
    if (to.getDate() === lastDay) return `к ${MONTHS_DATIVE[to.getMonth()]}`;
    return `к 1–${to.getDate()} ${MONTHS_GENITIVE[to.getMonth()]}`;
  }

  const todayDate = parseDay(today);
  if (todayDate && from.getDay() === 1) {
    const lastMonday = mondayOf(todayDate);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const spanDays = Math.round((to - from) / 86400000) + 1;
    if (localDate(from) === localDate(lastMonday) && spanDays <= 7) {
      return spanDays === 7 ? 'к прошлой неделе' : 'к тем же дням прошлой недели';
    }
  }

  return `к ${shortDate(from)}–${shortDate(to)}`;
}
