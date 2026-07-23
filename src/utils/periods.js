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
