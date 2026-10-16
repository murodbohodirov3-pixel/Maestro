import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  bookingForPage,
  bookingLines,
  corsHeaders,
  formatWhen,
  groupDayTimes,
  isIsoDate,
  isZonedMoment,
  maskPhone,
  MASTER_REPLIES,
  masterBookingNotice,
  masterOffers,
  masterReminder,
  nearestByMaster,
  parseOrigins,
  servicesTotal,
  staffNotice,
  tashkentDate,
  tashkentIso,
  telegramStartUrl,
  TOKEN_PATTERN,
} from '../supabase/functions/_shared/bookingCore.js';

test('moments are written in Tashkent time with +05:00, whatever the input zone', () => {
  assert.equal(tashkentIso('2026-10-15T13:00:00+00:00'), '2026-10-15T18:00:00+05:00');
  assert.equal(tashkentIso('2026-10-15T18:00:00+05:00'), '2026-10-15T18:00:00+05:00');
  // 20:30 UTC is already the next day in Tashkent.
  assert.equal(tashkentIso('2026-10-15T20:30:00Z'), '2026-10-16T01:30:00+05:00');
  assert.equal(tashkentIso('nonsense'), null);
});

test('the Tashkent date turns over at Tashkent midnight, not UTC midnight', () => {
  assert.equal(tashkentDate(new Date('2026-10-15T18:59:00Z')), '2026-10-15');
  assert.equal(tashkentDate(new Date('2026-10-15T19:00:00Z')), '2026-10-16');
  assert.equal(tashkentDate(new Date('2026-10-15T10:00:00Z'), 31), '2026-11-15');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});

test('dates and moments from the page are checked strictly', () => {
  assert.equal(isIsoDate('2026-10-15'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('15.10.2026'), false);
  assert.equal(isZonedMoment('2026-10-15T18:00:00+05:00'), true);
  assert.equal(isZonedMoment('2026-10-15T13:00:00Z'), true);
  assert.equal(isZonedMoment('2026-10-15T18:00:00'), false, 'no zone, no guessing');
});

test('day mode joins the masters free at each start, in time order', () => {
  const times = groupDayTimes([
    { master_id: 3, slot_start: '2026-10-15T13:00:00+00:00' },
    { master_id: 1, slot_start: '2026-10-15T13:00:00+00:00' },
    { master_id: 1, slot_start: '2026-10-15T12:45:00+00:00' },
  ]);
  assert.deepEqual(times, [
    { starts_at: '2026-10-15T17:45:00+05:00', master_ids: [1] },
    { starts_at: '2026-10-15T18:00:00+05:00', master_ids: [1, 3] },
  ]);
});

test('nearest mode lists every requested master, free or not', () => {
  const masters = nearestByMaster([
    { master_id: 1, slot_start: '2026-10-15T13:15:00+00:00' },
    { master_id: 1, slot_start: '2026-10-15T13:00:00+00:00' },
  ], [1, 2]);
  assert.deepEqual(masters, [
    { master_id: 1, date: '2026-10-15', times: ['2026-10-15T18:00:00+05:00', '2026-10-15T18:15:00+05:00'] },
    { master_id: 2, date: null, times: [] },
  ]);
});

test('services add up, and a master who does every service takes any of them', () => {
  assert.deepEqual(servicesTotal([
    { duration_minutes: 60, price_uzs: 150_000 },
    { duration_minutes: 30, price_uzs: 70_000 },
  ]), { duration: 90, price: 220_000 });
  assert.equal(masterOffers({ online_service_ids: null }, ['mens_haircut']), true);
  assert.equal(masterOffers({ online_service_ids: ['mens_haircut'] }, ['mens_haircut', 'beard_modeling']), false);
});

test('the page gets the booking in its own shape, with its token back', () => {
  const booking = bookingForPage({
    status: 'held',
    hold_expires_at: '2026-10-15T12:10:00+00:00',
    master_id: '3',
    starts_at: '2026-10-15T13:00:00+00:00',
    ends_at: '2026-10-15T14:00:00+00:00',
    service_ids: ['mens_haircut'],
    total_price_uzs: '150000',
    total_duration_minutes: 60,
  }, 'q8Xf2kP0aZq8Xf2kP0aZq8Xf');
  assert.deepEqual(booking, {
    token: 'q8Xf2kP0aZq8Xf2kP0aZq8Xf',
    status: 'held',
    hold_expires_at: '2026-10-15T17:10:00+05:00',
    master_id: 3,
    starts_at: '2026-10-15T18:00:00+05:00',
    ends_at: '2026-10-15T19:00:00+05:00',
    service_ids: ['mens_haircut'],
    total_price_uzs: 150000,
    total_duration_minutes: 60,
  });
});

test('a token fits Telegram\'s start parameter and nothing else gets through', () => {
  assert.match('q8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8', TOKEN_PATTERN);
  assert.doesNotMatch('short', TOKEN_PATTERN);
  assert.doesNotMatch('q8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8Xf', TOKEN_PATTERN, 'over 40');
  assert.doesNotMatch('q8Xf2kP0aZ q8Xf2kP0aZq8Xf', TOKEN_PATTERN);
  const url = telegramStartUrl('Maestro_uzbot', 'q8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8');
  assert.equal(url, 'https://t.me/Maestro_uzbot?start=b_q8Xf2kP0aZq8Xf2kP0aZq8Xf2kP0aZq8');
  assert.ok(url.split('start=')[1].length <= 64);
});

test('only the page\'s own origins are allowed to read the answers', () => {
  const allowed = parseOrigins('https://maestro-booking.vercel.app/, http://localhost:5181');
  assert.deepEqual(allowed, ['https://maestro-booking.vercel.app', 'http://localhost:5181']);
  assert.equal(corsHeaders('https://maestro-booking.vercel.app', allowed)['Access-Control-Allow-Origin'], 'https://maestro-booking.vercel.app');
  assert.equal(corsHeaders('https://evil.example', allowed)['Access-Control-Allow-Origin'], undefined);
  assert.equal(corsHeaders(null, allowed)['Access-Control-Allow-Origin'], undefined);
});

test('the bot writes the date in the client\'s language, in Tashkent time', () => {
  assert.equal(formatWhen('2026-10-15T13:00:00Z', 'ru'), 'четверг, 15 октября, 18:00');
  assert.equal(formatWhen('2026-10-15T13:00:00Z', 'uz'), '15-oktabr, payshanba, 18:00');
  const lines = bookingLines({ startsAt: '2026-10-15T13:00:00Z', masterName: 'Жавохир', serviceName: 'Мужская стрижка', price: 150000 }, 'ru');
  assert.match(lines, /💈 Мастер: Жавохир/);
  assert.match(lines, /150 000 сум/);
});

test('a known number is shown masked, and staff messages carry the client in full', () => {
  assert.equal(maskPhone('+998901234567'), '+998 ** *** 45 67');
  const notice = staffNotice({
    kind: 'created', startsAt: '2026-10-15T13:00:00Z', masterName: 'Жавохир',
    serviceName: 'Мужская стрижка', price: 150000, clientName: 'Азиз <b>', clientPhone: '+998901234567', comment: '',
  });
  assert.match(notice, /Новая запись с сайта/);
  assert.match(notice, /Азиз &lt;b&gt;, \+998901234567/);
  assert.doesNotMatch(notice, /💬/);
});

test('a master hears of a booking made for him, with the number masked', () => {
  const text = masterBookingNotice({
    startsAt: '2026-10-16T10:00:00Z',
    clientName: 'Азиз <VIP>',
    clientPhone: '+998 90 *** ** 22',
    serviceName: 'Стрижка',
  });
  assert.match(text, /Новая запись/);
  assert.match(text, /15:00/);
  assert.match(text, /Азиз &lt;VIP&gt; · \+998 90 \*\*\* \*\* 22/);
  assert.match(text, /Стрижка/);
  assert.doesNotMatch(masterBookingNotice({ startsAt: '2026-10-16T10:00:00Z', clientName: 'Азиз' }), /undefined|null/);
});

test('after an open booking ends the master is reminded to close it', () => {
  const text = masterReminder({ startsAt: '2026-10-16T10:00:00Z', endsAt: '2026-10-16T11:00:00Z', clientName: 'Азиз', serviceName: 'Стрижка' });
  assert.match(text, /Закройте запись/);
  assert.match(text, /15:00–16:00 · Азиз · Стрижка/);
  assert.equal(text.split('\n').length, 3);
  assert.equal(MASTER_REPLIES.noShow, 'Отмечено: не пришёл.');
});

test('a master hears when his booking is cancelled, moved, or handed to another', () => {
  const base = { startsAt: '2026-10-16T12:00:00Z', clientName: 'Азиз', clientPhone: '+998 90 *** ** 22', serviceName: 'Стрижка' };
  assert.match(masterBookingNotice({ ...base, kind: 'cancelled' }), /Запись отменена[\s\S]*17:00/);
  const moved = masterBookingNotice({ ...base, kind: 'moved', previousStartsAt: '2026-10-16T10:00:00Z' });
  assert.match(moved, /Запись перенесена/);
  assert.match(moved, /было: .*15:00/);
  assert.match(moved, /стало: <b>.*17:00<\/b>/);
  assert.match(masterBookingNotice({ ...base, kind: 'away' }), /передана другому мастеру/);
  assert.match(masterBookingNotice(base), /Новая запись/);
});
