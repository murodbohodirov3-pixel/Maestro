import test from 'node:test';
import assert from 'node:assert/strict';
import { sameWeekdayLastWeek } from '../src/utils/periods.js';

const weekday = (day) => new Date(`${day}T12:00:00`).getDay();

test('lands on the same weekday one week earlier', () => {
  assert.equal(sameWeekdayLastWeek('2026-07-23'), '2026-07-16');
  assert.equal(weekday('2026-07-23'), weekday(sameWeekdayLastWeek('2026-07-23')));
});

test('crosses a month boundary', () => {
  assert.equal(sameWeekdayLastWeek('2026-07-03'), '2026-06-26');
  assert.equal(weekday('2026-07-03'), weekday(sameWeekdayLastWeek('2026-07-03')));
});

test('crosses a year boundary', () => {
  assert.equal(sameWeekdayLastWeek('2026-01-05'), '2025-12-29');
  assert.equal(weekday('2026-01-05'), weekday(sameWeekdayLastWeek('2026-01-05')));
});

// A leap day is the case a naive "subtract a month" rule gets wrong; seven days
// back is immune to it, and this pins that down.
test('crosses the end of February in a leap year', () => {
  assert.equal(sameWeekdayLastWeek('2028-03-02'), '2028-02-24');
  assert.equal(weekday('2028-03-02'), weekday(sameWeekdayLastWeek('2028-03-02')));
});

test('every weekday maps to its own kind of day', () => {
  for (let offset = 0; offset < 7; offset += 1) {
    const day = localIso(new Date(2026, 6, 20 + offset));
    assert.equal(weekday(day), weekday(sameWeekdayLastWeek(day)));
  }
});

test('an unparseable date yields no comparison day', () => {
  assert.equal(sameWeekdayLastWeek(''), '');
  assert.equal(sameWeekdayLastWeek('не дата'), '');
});

function localIso(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
