// The calendar's arithmetic: Tashkent wall time whatever the phone's zone, the
// hours each master works on a day, and where a booking sits in the day grid.
import { scheduleRulesOn, timeToMinutes, weekdayIndex } from './reporting.js';

const OFFSET_MS = 5 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

export function tashkentParts(value) {
  const local = new Date(new Date(value).getTime() + OFFSET_MS);
  if (Number.isNaN(local.getTime())) return null;
  const iso = local.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export function tashkentMoment(date, minutes) {
  return `${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00+05:00`;
}

export function minutesLabel(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// When a master works on a date: his schedule's hours for that weekday, or
// nothing on a day off (by the schedule or set for that date).
export function masterHoursOn(master, date, scheduleRules = [], dayStatuses = []) {
  const dayOff = dayStatuses.some((status) => (
    String(status.master_id) === String(master.id) && status.work_date === date && status.status === 'day_off'
  ));
  const weekday = weekdayIndex(date);
  const rules = scheduleRulesOn(master, date, scheduleRules)
    .filter((rule) => Number(rule.iso_weekday) === weekday + 1);
  if (dayOff || !rules.length) return { dayOff, start: null, end: null };
  return {
    dayOff: false,
    start: Math.min(...rules.map((rule) => timeToMinutes(rule.starts_at))),
    end: Math.max(...rules.map((rule) => timeToMinutes(rule.ends_at))),
  };
}

// The grid's top and bottom: the earliest start and latest end of anyone
// working that day, whole hours, 09:00–22:00 when nobody does.
export function dayFrame(hours) {
  const working = hours.filter((item) => item.start != null);
  if (!working.length) return { start: 9 * 60, end: 22 * 60 };
  const start = Math.min(...working.map((item) => item.start));
  const end = Math.max(...working.map((item) => item.end));
  return { start: Math.floor(start / 60) * 60, end: Math.ceil(end / 60) * 60 };
}

// Bookings that belong in the grid: everything but cancellations and holds
// that ran out.
export function visibleBookings(appointments, date) {
  return appointments.filter((appointment) => (
    appointment.status !== 'cancelled' && tashkentParts(appointment.starts_at)?.date === date
  ));
}

export function blockPosition(appointment, frameStart, pixelsPerMinute) {
  const start = tashkentParts(appointment.starts_at).minutes;
  const end = tashkentParts(appointment.ends_at).minutes || start + Number(appointment.duration_minutes || 30);
  return {
    top: Math.max(0, (start - frameStart) * pixelsPerMinute),
    height: Math.max(22, (end - start) * pixelsPerMinute),
  };
}

// A booking still waiting for its outcome. Open means the master has not
// said yet whether the client came; overdue means its time is over.
export function isOpenBooking(appointment) {
  if (appointment.status === 'confirmed') return true;
  return appointment.status === 'pending' && appointment.source !== 'web';
}

export function isOverdueBooking(appointment, now = new Date()) {
  return isOpenBooking(appointment) && new Date(appointment.ends_at).getTime() <= new Date(now).getTime();
}

// «Пришёл» opens from half an hour before the start.
export function canRecordVisit(appointment, now = new Date()) {
  return isOpenBooking(appointment)
    && new Date(appointment.starts_at).getTime() - 30 * 60 * 1000 <= new Date(now).getTime();
}

export function clientBadge(appointment) {
  if (!appointment.client_id) return null;
  const visits = Number(appointment.client_visit_count) || 0;
  if (!visits && !appointment.client_known_before) return 'новый';
  return visits ? `${visits + 1}-й визит` : 'постоянный';
}
