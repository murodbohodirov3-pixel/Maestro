export const APPOINTMENT_OUTCOME_REASONS = Object.freeze({
  no_show: Object.freeze([
    ['no_show_no_notice', 'Не предупредил'],
    ['no_show_unreachable', 'Не удалось связаться'],
    ['no_show_late_arrival', 'Сильно опоздал'],
    ['no_show_other', 'Другая причина'],
  ]),
  client: Object.freeze([
    ['client_changed_plans', 'Изменились планы'],
    ['client_illness', 'Болезнь'],
    ['client_schedule_conflict', 'Не подошло время'],
    ['client_late_cancellation', 'Поздняя отмена'],
    ['client_other', 'Другая причина'],
  ]),
  salon: Object.freeze([
    ['salon_master_unavailable', 'Мастер недоступен'],
    ['salon_schedule_conflict', 'Ошибка в расписании'],
    ['salon_operational_issue', 'Проблема в салоне'],
    ['salon_other', 'Другая причина'],
  ]),
});

export const APPOINTMENT_REASON_LABELS = Object.freeze(Object.fromEntries(
  Object.values(APPOINTMENT_OUTCOME_REASONS).flat(),
));

export function appointmentOutcomeAllowed(status, outcome, startsAt, now = new Date()) {
  if (!['pending', 'confirmed'].includes(status)) return false;
  if (outcome === 'cancelled') return true;
  if (!['completed', 'no_show'].includes(outcome)) return false;
  const startsAtTime = new Date(startsAt).getTime();
  return Number.isFinite(startsAtTime) && startsAtTime <= now.getTime();
}

export function reasonRequiresNote(reasonCode) {
  return ['no_show_other', 'client_other', 'salon_other'].includes(reasonCode);
}
