import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPOINTMENT_OUTCOME_REASONS,
  appointmentOutcomeAllowed,
  reasonRequiresNote,
} from '../src/utils/appointmentOutcomes.js';

test('appointment outcome reason codes match the approved contract', () => {
  assert.deepEqual(APPOINTMENT_OUTCOME_REASONS, {
    no_show: [
      ['no_show_no_notice', 'Не предупредил'],
      ['no_show_unreachable', 'Не удалось связаться'],
      ['no_show_late_arrival', 'Сильно опоздал'],
      ['no_show_other', 'Другая причина'],
    ],
    client: [
      ['client_changed_plans', 'Изменились планы'],
      ['client_illness', 'Болезнь'],
      ['client_schedule_conflict', 'Не подошло время'],
      ['client_late_cancellation', 'Поздняя отмена'],
      ['client_other', 'Другая причина'],
    ],
    salon: [
      ['salon_master_unavailable', 'Мастер недоступен'],
      ['salon_schedule_conflict', 'Ошибка в расписании'],
      ['salon_operational_issue', 'Проблема в салоне'],
      ['salon_other', 'Другая причина'],
    ],
  });
  const codes = Object.values(APPOINTMENT_OUTCOME_REASONS).flat().map(([code]) => code);
  assert.equal(new Set(codes).size, codes.length);
});

test('only active appointments can receive an outcome and time-gated outcomes wait for the start', () => {
  const now = new Date('2026-07-22T10:00:00Z');
  assert.equal(appointmentOutcomeAllowed('pending', 'cancelled', '2026-07-23T10:00:00Z', now), true);
  assert.equal(appointmentOutcomeAllowed('confirmed', 'completed', '2026-07-22T09:59:00Z', now), true);
  assert.equal(appointmentOutcomeAllowed('confirmed', 'no_show', '2026-07-22T10:01:00Z', now), false);
  for (const status of ['completed', 'cancelled', 'no_show']) {
    assert.equal(appointmentOutcomeAllowed(status, 'cancelled', '2026-07-22T09:00:00Z', now), false);
  }
});

test('only explicit other reason codes require a note', () => {
  assert.equal(reasonRequiresNote('no_show_other'), true);
  assert.equal(reasonRequiresNote('client_other'), true);
  assert.equal(reasonRequiresNote('salon_other'), true);
  assert.equal(reasonRequiresNote('client_illness'), false);
});
