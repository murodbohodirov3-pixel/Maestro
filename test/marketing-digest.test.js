import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays,
  buildDigest,
  digestRanges,
  formatDigest,
  formatRange,
  isoDateInTimeZone,
  isoWeekday,
  percentChange,
  pluralRu,
  summarizeDigest,
} from '../supabase/functions/marketing-digest/digest.js';

function sale(d, overrides = {}) {
  return { id: Math.random(), d, cash: 100000, card: 0, qr: 0, clients_count: 1, is_new_client: true, status: 'approved', comment: 'owner_approval_approved', ...overrides };
}

function newClientsOn(d, count) {
  return Array.from({ length: count }, () => sale(d));
}

test('digestRanges: yesterday anchors the week and the month', () => {
  // 2026-09-22 is a Tuesday, so yesterday (Monday) starts the week by itself.
  const ranges = digestRanges('2026-09-22');
  assert.equal(ranges.yesterday, '2026-09-21');
  assert.deepEqual(ranges.week, { from: '2026-09-21', to: '2026-09-21' });
  assert.deepEqual(ranges.month, { from: '2026-09-01', to: '2026-09-21', full: false });
  assert.deepEqual(ranges.previousMonth, { from: '2026-08-01', to: '2026-08-31', sameTo: '2026-08-21' });
  assert.deepEqual(ranges.load, { from: '2026-08-01', to: '2026-09-21' });
});

test('digestRanges: on a Monday the week is the whole previous week', () => {
  const ranges = digestRanges('2026-09-21');
  assert.deepEqual(ranges.week, { from: '2026-09-14', to: '2026-09-20' });
});

test('digestRanges: on the 1st the month is the whole previous month and January looks back into the previous year', () => {
  const october = digestRanges('2026-10-01');
  assert.deepEqual(october.month, { from: '2026-09-01', to: '2026-09-30', full: true });
  assert.deepEqual(october.previousMonth, { from: '2026-08-01', to: '2026-08-31', sameTo: '2026-08-30' });

  const january = digestRanges('2027-01-02');
  assert.deepEqual(january.month, { from: '2027-01-01', to: '2027-01-01', full: false });
  assert.deepEqual(january.previousMonth, { from: '2026-12-01', to: '2026-12-31', sameTo: '2026-12-01' });
  assert.deepEqual(january.week, { from: '2026-12-28', to: '2027-01-01' });
});

test('digestRanges: the same period of a shorter previous month is clamped to its last day', () => {
  const ranges = digestRanges('2026-04-01');
  assert.deepEqual(ranges.month, { from: '2026-03-01', to: '2026-03-31', full: true });
  assert.equal(ranges.previousMonth.sameTo, '2026-02-28');
});

test('digestRanges rejects a malformed or impossible date', () => {
  assert.throws(() => digestRanges('2026-13-01'), /invalid_date/);
  assert.throws(() => digestRanges('22.09.2026'), /invalid_date/);
});

test('date helpers', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(isoWeekday('2026-09-21'), 1);
  assert.equal(isoWeekday('2026-09-20'), 7);
  assert.equal(formatRange('2026-09-15', '2026-09-21'), '15–21 сентября');
  assert.equal(formatRange('2026-08-31', '2026-09-06'), '31 августа – 6 сентября');
  assert.equal(formatRange('2026-09-21', '2026-09-21'), '21 сентября');
  // 04:30 UTC is already the 22nd in Tashkent (UTC+5).
  assert.equal(isoDateInTimeZone(new Date('2026-09-21T23:30:00Z')), '2026-09-22');
  assert.equal(isoDateInTimeZone(new Date('2026-09-21T18:30:00Z')), '2026-09-21');
});

test('pluralRu and percentChange', () => {
  assert.equal(pluralRu(1, 'клиент', 'клиента', 'клиентов'), 'клиент');
  assert.equal(pluralRu(3, 'клиент', 'клиента', 'клиентов'), 'клиента');
  assert.equal(pluralRu(11, 'клиент', 'клиента', 'клиентов'), 'клиентов');
  assert.equal(pluralRu(21, 'клиент', 'клиента', 'клиентов'), 'клиент');
  assert.equal(percentChange(124, 133), -7);
  assert.equal(percentChange(60, 50), 20);
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(0, 5), -100);
});

test('summarizeDigest counts new clients the way the app does', () => {
  const sales = [
    // Yesterday: two approved new clients in one sale, one returning, one legacy row.
    sale('2026-09-21', { clients_count: 2 }),
    sale('2026-09-21', { is_new_client: false }),
    sale('2026-09-21', { is_new_client: null, comment: null }),
    // A master's sale still waiting for approval is not counted.
    sale('2026-09-21', { status: 'pending', comment: 'owner_approval_required' }),
    // Rejected by the owner: ignored entirely.
    sale('2026-09-21', { status: 'rejected', comment: 'owner_approval_rejected' }),
    // Legacy pending rows without the marker keep their historical behaviour.
    sale('2026-09-20', { status: 'pending', comment: null }),
    // Zero-client rows add nothing even when flagged.
    sale('2026-09-20', { clients_count: 0, cl: 0 }),
    // The legacy cl column is the fallback for clients_count.
    sale('2026-09-19', { clients_count: undefined, cl: 3 }),
    ...newClientsOn('2026-09-05', 4),
    ...newClientsOn('2026-08-05', 2),
    ...newClientsOn('2026-08-21', 1),
    ...newClientsOn('2026-08-22', 10),
  ];
  const summary = summarizeDigest(sales, '2026-09-22');

  assert.equal(summary.yesterday.newClients, 2);
  assert.equal(summary.yesterday.weekday, 1);
  assert.equal('pendingNewClients' in summary, false);
  assert.equal(summary.week.newClients, 2);
  assert.deepEqual(summary.week.days, [{ date: '2026-09-21', weekday: 1, newClients: 2 }]);
  assert.equal(summary.month.newClients, 2 + 1 + 3 + 4);
  assert.equal('unlabeledClients' in summary.month, false);
  assert.equal(summary.previousMonth.samePeriodNewClients, 3);
  assert.equal(summary.previousMonth.totalNewClients, 13);
  assert.equal(summary.changePercent, 233);
});

test('summarizeDigest lists every day of the week including empty ones', () => {
  const sales = [...newClientsOn('2026-09-15', 2), ...newClientsOn('2026-09-16', 4), ...newClientsOn('2026-09-18', 1)];
  const summary = summarizeDigest(sales, '2026-09-19');
  assert.deepEqual(summary.week.days.map((day) => [day.date, day.newClients]), [
    ['2026-09-14', 0],
    ['2026-09-15', 2],
    ['2026-09-16', 4],
    ['2026-09-17', 0],
    ['2026-09-18', 1],
  ]);
  assert.equal(summary.week.newClients, 7);
});

test('formatDigest: the everyday message', () => {
  const summary = {
    today: '2026-09-22',
    yesterday: { date: '2026-09-21', weekday: 1, newClients: 1 },
    week: {
      from: '2026-09-21', to: '2026-09-21', newClients: 1,
      days: [{ date: '2026-09-21', weekday: 1, newClients: 1 }],
    },
    month: { from: '2026-09-01', to: '2026-09-21', full: false, newClients: 124 },
    previousMonth: { from: '2026-08-01', to: '2026-08-31', sameTo: '2026-08-21', samePeriodNewClients: 133, totalNewClients: 185 },
    changePercent: -7,
  };
  assert.equal(formatDigest(summary), [
    '☀️ Доброе утро! Сегодня вторник, 22 сентября.',
    '',
    'Вчера, в понедельник 21 сентября, пришёл <b>1 новый клиент</b>.',
    '',
    '📅 Эта неделя (21 сентября): <b>1 новый клиент</b>',
    'пн 21.09 — 1 новый',
    '',
    '📈 Сентябрь, 1–21 число: <b>124 новых клиента</b>.',
    'Это на <b>7% меньше</b>, чем за 1–21 августа (133 новых).',
    'За весь август — 185 новых клиентов.',
  ].join('\n'));
});

test('formatDigest: a full week, a full month and growth; unlabeled rows stay out', () => {
  const sales = [
    ...newClientsOn('2026-09-28', 2),
    ...newClientsOn('2026-09-29', 4),
    ...newClientsOn('2026-09-30', 1),
    ...newClientsOn('2026-10-01', 8),
    ...newClientsOn('2026-10-02', 11),
    ...newClientsOn('2026-10-03', 5),
    ...newClientsOn('2026-10-04', 3),
    ...newClientsOn('2026-10-15', 20),
    ...newClientsOn('2026-10-31', 6),
    sale('2026-10-31', { is_new_client: null, comment: null, clients_count: 3 }),
    ...newClientsOn('2026-09-10', 40),
  ];
  const { text, summary } = buildDigest(sales, '2026-11-01');
  assert.equal(summary.month.full, true);
  assert.equal(summary.month.newClients, 53);
  assert.equal(summary.previousMonth.samePeriodNewClients, 47);
  assert.equal(text, [
    '☀️ Доброе утро! Сегодня воскресенье, 1 ноября.',
    '',
    'Вчера, в субботу 31 октября, пришло <b>6 новых клиентов</b>.',
    '',
    '📅 Эта неделя (26–31 октября): <b>6 новых клиентов</b>',
    'пн 26.10 — 0',
    'вт 27.10 — 0',
    'ср 28.10 — 0',
    'чт 29.10 — 0',
    'пт 30.10 — 0',
    'сб 31.10 — 6 новых',
    '',
    '📈 Весь октябрь: <b>53 новых клиента</b>.',
    'Это на <b>13% больше</b>, чем за весь сентябрь (47 новых).',
  ].join('\n'));
});

test('formatDigest: Monday recap covers the previous week, and an empty previous month has no percentage', () => {
  const sales = [...newClientsOn('2026-09-15', 2), ...newClientsOn('2026-09-20', 3)];
  const { text } = buildDigest(sales, '2026-09-21');
  assert.match(text, /Вчера, в воскресенье 20 сентября, пришли <b>3 новых клиента<\/b>\./);
  assert.match(text, /📅 Прошлая неделя \(14–20 сентября\): <b>5 новых клиентов<\/b>/);
  assert.match(text, /вт 15\.09 — 2 новых\nср 16\.09 — 0\n/);
  assert.match(text, /📈 Сентябрь, 1–20 число: <b>5 новых клиентов<\/b>\.\nЗа 1–20 августа новых клиентов не было\.\nЗа весь август — 0 новых клиентов\./);
});

test('formatDigest: a day without new clients, and an equal previous period', () => {
  const sales = [...newClientsOn('2026-09-02', 4), ...newClientsOn('2026-08-02', 4)];
  const { text } = buildDigest(sales, '2026-09-04');
  assert.match(text, /Вчера, в четверг 3 сентября, новых клиентов не было\./);
  assert.match(text, /📈 Сентябрь, 1–3 число: <b>4 новых клиента<\/b>\.\nСтолько же, сколько за 1–3 августа \(4 новых\)\./);
});
