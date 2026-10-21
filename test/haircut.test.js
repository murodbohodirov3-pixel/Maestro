import test from 'node:test';
import assert from 'node:assert/strict';
import { botText } from '../supabase/functions/_shared/bookingCore.js';

test('«пора подстричься» in the owner\'s words, with the days counted right', () => {
  assert.equal(botText('ru').haircutReminder('Сардор', 15),
    'Сардор, прошло 15 дней с вашей прошлой стрижки. Не забудьте уделить время себе!\n\nС уважением, Maestro Barberia');
  assert.match(botText('ru').haircutReminder('Сардор', 30), /прошло 30 дней/);
  assert.match(botText('ru').haircutReminder('Сардор', 31), /прошло 31 день/);
  assert.match(botText('ru').haircutReminder('Сардор', 32), /прошло 32 дня/);
  assert.equal(botText('uz').haircutReminder('Sardor', 15),
    "Sardor, oxirgi soch olganingizdan beri 15 kun o'tdi. O'zingizga vaqt ajratishni unutmang!\n\nHurmat bilan, Maestro Barberia");
  for (const lang of ['ru', 'uz']) {
    assert.ok(botText(lang).haircutOffButton && botText(lang).haircutOff);
  }
});
