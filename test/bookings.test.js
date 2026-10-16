import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockPosition,
  canRecordVisit,
  clientBadge,
  dayFrame,
  isOverdueBooking,
  masterHoursOn,
  tashkentMoment,
  tashkentParts,
  visibleBookings,
} from '../src/utils/bookings.js';

test('booking times are read in Tashkent, whatever the phone thinks', () => {
  assert.deepEqual(tashkentParts('2026-10-16T09:00:00Z'), { date: '2026-10-16', time: '14:00', minutes: 840 });
  assert.equal(tashkentParts('2026-10-16T20:30:00Z').date, '2026-10-17');
  assert.equal(tashkentMoment('2026-10-16', 14 * 60 + 15), '2026-10-16T14:15:00+05:00');
});

// 2026-10-16 is a Friday.
const RULES = [
  { master_id: 3, iso_weekday: 5, starts_at: '14:00:00', ends_at: '22:00:00', active: true },
  { master_id: 1, iso_weekday: 5, starts_at: '10:00:00', ends_at: '23:00:00', active: true },
];

test('a master works his schedule\'s hours, or not at all on a day off', () => {
  assert.deepEqual(masterHoursOn({ id: 3 }, '2026-10-16', RULES), { dayOff: false, start: 840, end: 1320 });
  assert.deepEqual(masterHoursOn({ id: 3 }, '2026-10-17', RULES), { dayOff: false, start: null, end: null });
  const off = [{ master_id: 1, work_date: '2026-10-16', status: 'day_off' }];
  assert.deepEqual(masterHoursOn({ id: 1 }, '2026-10-16', RULES, off), { dayOff: true, start: null, end: null });
});

test('the grid spans whole hours from the first start to the last end', () => {
  assert.deepEqual(dayFrame([{ start: 600, end: 1380 }, { start: 840, end: 1320 }]), { start: 600, end: 1380 });
  assert.deepEqual(dayFrame([{ start: 615, end: 1290 }]), { start: 600, end: 1320 });
  assert.deepEqual(dayFrame([{ start: null, end: null }]), { start: 540, end: 1320 });
});

const BOOKING = {
  id: 'a', master_id: 3, status: 'confirmed', source: 'web',
  starts_at: '2026-10-16T09:00:00Z', ends_at: '2026-10-16T10:00:00Z', duration_minutes: 60,
};

test('a booking sits at its time and lasts its length; cancellations leave the grid', () => {
  assert.deepEqual(blockPosition(BOOKING, 600, 1), { top: 240, height: 60 });
  assert.equal(blockPosition({ ...BOOKING, ends_at: '2026-10-16T09:10:00Z' }, 600, 1).height, 22, 'never thinner than a line of text');
  assert.equal(visibleBookings([BOOKING, { ...BOOKING, id: 'b', status: 'cancelled' }], '2026-10-16').length, 1);
  assert.equal(visibleBookings([BOOKING], '2026-10-17').length, 0);
});

test('«Пришёл» opens half an hour before; a booking is overdue once its time is over', () => {
  assert.equal(canRecordVisit(BOOKING, new Date('2026-10-16T08:20:00Z')), false);
  assert.equal(canRecordVisit(BOOKING, new Date('2026-10-16T08:35:00Z')), true);
  assert.equal(canRecordVisit({ ...BOOKING, status: 'completed' }, new Date('2026-10-16T09:30:00Z')), false);
  assert.equal(canRecordVisit({ ...BOOKING, status: 'pending' }, new Date('2026-10-16T09:30:00Z')), false, 'a web hold is not a booking yet');
  assert.equal(isOverdueBooking(BOOKING, new Date('2026-10-16T09:59:00Z')), false);
  assert.equal(isOverdueBooking(BOOKING, new Date('2026-10-16T10:00:00Z')), true);
});

test('the card says how well the salon knows the client', () => {
  assert.equal(clientBadge({ client_id: 'x', client_visit_count: 0, client_known_before: false }), 'новый');
  assert.equal(clientBadge({ client_id: 'x', client_visit_count: 0, client_known_before: true }), 'постоянный');
  assert.equal(clientBadge({ client_id: 'x', client_visit_count: 6 }), '7-й визит');
  assert.equal(clientBadge({ client_id: null }), null);
});
