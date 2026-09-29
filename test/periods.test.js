import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonLabel, sameWeekdayLastWeek } from '../src/utils/periods.js';

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

test('names the comparison the way the owner would say it', () => {
  const today = '2026-09-29';
  assert.equal(comparisonLabel({ from: '2026-09-22', to: '2026-09-22' }, today), 'к прошлому вторнику');
  assert.equal(comparisonLabel({ from: '2026-09-28', to: '2026-09-28' }, today), 'ко вчерашнему дню');
  assert.equal(comparisonLabel({ from: '2026-09-10', to: '2026-09-10' }, today), 'к 10.09');
  assert.equal(comparisonLabel({ from: '2026-08-01', to: '2026-08-31' }, today), 'к августу');
  assert.equal(comparisonLabel({ from: '2026-08-01', to: '2026-08-29' }, today), 'к 1–29 августа');
  assert.equal(comparisonLabel({ from: '2026-09-21', to: '2026-09-27' }, today), 'к прошлой неделе');
  assert.equal(comparisonLabel({ from: '2026-09-21', to: '2026-09-22' }, today), 'к тем же дням прошлой недели');
  assert.equal(comparisonLabel({ from: '2026-07-15', to: '2026-08-14' }, today), 'к 15.07–14.08');
});

test('feminine weekdays take the feminine form', () => {
  assert.equal(comparisonLabel({ from: '2026-09-23', to: '2026-09-23' }, '2026-09-30'), 'к прошлой среде');
  assert.equal(comparisonLabel({ from: '2026-09-26', to: '2026-09-26' }, '2026-10-03'), 'к прошлой субботе');
});

test('a missing range yields no label', () => {
  assert.equal(comparisonLabel(null, '2026-09-29'), '');
  assert.equal(comparisonLabel({ from: '', to: '' }, '2026-09-29'), '');
});

function localIso(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
