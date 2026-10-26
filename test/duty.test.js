import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  currentWindow,
  differenceHash,
  greyFromRgba,
  hashDistance,
  masterDutyAttention,
  mondayOf,
  myDuty,
  nextWindow,
  openWindow,
  photoUntil,
  rosterChanges,
  rosterDraft,
  swapCandidates,
  swapStillOpen,
  weekDays,
  windowStatus,
} from '../src/utils/duty.js';
import {
  DUTY_CHECK_SCHEMA,
  DUTY_CHECK_SYSTEM,
  dutyCheckPrompt,
  dutyClock,
  dutyDateLabel,
  dutyDayLabel,
  dutyHoursList,
  dutyVerdict,
  dutyZoneList,
  dutyEveNotice,
  dutyFineNotice,
  dutyRosterReminder,
  dutySwapAnswer,
  dutySwapKeyboard,
  dutySwapRequest,
  dutyWindowNotice,
  parseDutyTap,
} from '../supabase/functions/_shared/duty.js';
import { translate } from '../src/i18n/index.js';

const at = (iso) => new Date(iso).getTime();

const duty = {
  today: '2026-10-28',
  masters: [{ id: 1, name: 'Жавохир' }, { id: 2, name: 'Иброхим' }, { id: 3, name: 'Жавлон' }],
  roster: [
    { day: '2026-10-28', master_id: 2, source: 'owner', starts_at: '2026-10-28T05:00:00Z', ends_at: '2026-10-28T17:00:00Z', windows: 6 },
    { day: '2026-10-29', master_id: 2, source: 'owner', starts_at: '2026-10-29T05:00:00Z', ends_at: '2026-10-29T17:00:00Z', windows: 6 },
    { day: '2026-10-30', master_id: 3, source: 'swap', starts_at: '2026-10-30T09:00:00Z', ends_at: '2026-10-30T17:00:00Z', windows: 4 },
  ],
  working: { '2026-10-29': [1, 2] },
  swaps: [
    { id: 7, day: '2026-10-29', from_master_id: 2, to_master_id: 3, status: 'pending' },
    { id: 6, day: '2026-10-30', from_master_id: 2, to_master_id: 3, status: 'accepted' },
    { id: 5, day: '2026-10-29', from_master_id: 1, to_master_id: 2, status: 'pending' },
  ],
};

test('weeks run Monday to Sunday', () => {
  assert.equal(mondayOf('2026-10-28'), '2026-10-26');
  assert.equal(mondayOf('2026-11-01'), '2026-10-26', 'a Sunday belongs to the week before it');
  assert.equal(mondayOf('2026-10-26'), '2026-10-26');
  assert.deepEqual(weekDays('2026-10-26'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(addDaysIso('2026-10-31', 1), '2026-11-01');
});

test('photos are due in a window\'s first hour only', () => {
  const window = { starts_at: '2026-10-28T09:00:00Z', ends_at: '2026-10-28T11:00:00Z', photo_until: '2026-10-28T10:00:00Z' };
  assert.equal(photoUntil(window), '2026-10-28T10:00:00Z');
  assert.equal(photoUntil({ starts_at: window.starts_at, ends_at: window.ends_at }), window.ends_at, 'an older server: the whole window');
  assert.equal(windowStatus(window, at('2026-10-28T09:59:00Z')), 'open');
  assert.equal(windowStatus(window, at('2026-10-28T10:00:00Z')), 'missed', 'the hour is over though the window is not');
  assert.equal(currentWindow([window], at('2026-10-28T10:30:00Z')), null, 'no photos taken between the hours');
  assert.equal(currentWindow([window], at('2026-10-28T09:30:00Z')), window);
  assert.equal(dutyHoursList([{ starts_at: window.starts_at, until: window.photo_until }, { starts_at: '2026-10-28T11:00:00Z', until: '2026-10-28T12:00:00Z' }]), '14:00–15:00, 16:00–17:00');
});

test('a window is done, fined, open, missed or later', () => {
  const window = { starts_at: '2026-10-28T07:00:00Z', ends_at: '2026-10-28T09:00:00Z' };
  assert.equal(windowStatus(window, at('2026-10-28T06:59:00Z')), 'later');
  assert.equal(windowStatus(window, at('2026-10-28T07:00:00Z')), 'open');
  assert.equal(windowStatus(window, at('2026-10-28T09:00:00Z')), 'missed', 'its end belongs to the next one');
  assert.equal(windowStatus({ ...window, fined: true }, at('2026-10-28T09:03:00Z')), 'fined');
  assert.equal(windowStatus({ ...window, photo_at: '2026-10-28T07:30:00Z' }, at('2026-10-28T08:00:00Z')), 'done');
  const windows = [window, { starts_at: '2026-10-28T09:00:00Z', ends_at: '2026-10-28T11:00:00Z' }];
  assert.equal(openWindow(windows, at('2026-10-28T08:00:00Z')), windows[0]);
  assert.equal(nextWindow(windows, at('2026-10-28T08:00:00Z')), windows[1]);
  assert.equal(openWindow(windows, at('2026-10-28T12:00:00Z')), null);
  const sent = [{ ...window, photo_at: '2026-10-28T07:10:00Z' }, windows[1]];
  assert.equal(openWindow(sent, at('2026-10-28T08:00:00Z')), null, 'a window with its photo is no longer waiting');
  assert.equal(currentWindow(sent, at('2026-10-28T08:00:00Z')), sent[0], 'but the clock is still in it');
  assert.equal(currentWindow(sent, at('2026-10-28T11:00:00Z')), null);
});

test('those who work the day are offered first, the asker never', () => {
  const candidates = swapCandidates(duty, '2026-10-29', 2);
  assert.deepEqual(candidates.map((master) => [master.name, master.works]), [['Жавохир', true], ['Жавлон', false]]);
});

test('a request is open until the day begins, and only while the day is still the asker\'s', () => {
  const pending = duty.swaps[0];
  assert.equal(swapStillOpen(duty, pending, at('2026-10-29T04:59:00Z')), true);
  assert.equal(swapStillOpen(duty, pending, at('2026-10-29T05:00:00Z')), false);
  assert.equal(swapStillOpen(duty, duty.swaps[2], at('2026-10-28T10:00:00Z')), false, 'the day is not the asker\'s');
  assert.equal(swapStillOpen(duty, duty.swaps[1], at('2026-10-28T10:00:00Z')), false, 'answered');
});

test('a master sees his days, what he was asked, what he asked and the answers', () => {
  const ibrohim = myDuty(duty, 2, '2026-10-28', at('2026-10-28T10:00:00Z'));
  assert.deepEqual(ibrohim.days.map((row) => row.day), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(ibrohim.outgoing.map((swap) => swap.id), [7]);
  assert.deepEqual(ibrohim.incoming.map((swap) => swap.id), []);
  assert.deepEqual(ibrohim.answered.map((swap) => swap.id), [6]);
  const javlon = myDuty(duty, 3, '2026-10-28', at('2026-10-28T10:00:00Z'));
  assert.deepEqual(javlon.incoming.map((swap) => swap.id), [7]);
  assert.deepEqual(javlon.days.map((row) => row.day), ['2026-10-30']);
});

test('the duty tab lights up for a request and for the photo due now', () => {
  const noon = at('2026-10-28T08:00:00Z');
  assert.equal(masterDutyAttention(duty, 3, '2026-10-28', noon), 1, 'Иброхим asked Жавлон');
  const withWindows = { ...duty, windows: [{ starts_at: '2026-10-28T07:00:00Z', ends_at: '2026-10-28T09:00:00Z' }] };
  assert.equal(masterDutyAttention(withWindows, 2, '2026-10-28', noon), 1, 'Иброхим is on duty and owes a photo');
  withWindows.windows[0].photo_at = '2026-10-28T07:30:00Z';
  assert.equal(masterDutyAttention(withWindows, 2, '2026-10-28', noon), 0);
  assert.equal(masterDutyAttention(null, 2, '2026-10-28', noon), 0);
});

test('the owner saves only the days he changed, nobody as null', () => {
  const draft = rosterDraft(duty, '2026-10-26');
  assert.equal(draft['2026-10-28'], '2');
  assert.equal(draft['2026-10-31'], '');
  assert.deepEqual(rosterChanges(duty, draft), []);
  assert.deepEqual(rosterChanges(duty, { ...draft, '2026-10-29': '1', '2026-10-30': '', '2026-10-31': '3' }), [
    { day: '2026-10-29', master_id: 1 },
    { day: '2026-10-30', master_id: null },
    { day: '2026-10-31', master_id: 3 },
  ]);
});

// A 17×16 picture: a gradient with a bright square, and the same picture
// slightly darker and noisier (a re-save), and another scene.
function picture(fn) {
  const rgba = new Uint8ClampedArray(17 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 17; x += 1) {
      const value = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      const offset = (y * 17 + x) * 4;
      rgba.set([value, value, value, 255], offset);
    }
  }
  return rgba;
}

test('the same picture saved again stays close, another scene does not', () => {
  const base = picture((x, y) => x * 9 + (x > 5 && x < 11 && y > 4 && y < 10 ? 80 : 0) + ((x * 7 + y * 13) % 5));
  const resaved = picture((x, y) => (x * 9 + (x > 5 && x < 11 && y > 4 && y < 10 ? 80 : 0) + ((x * 7 + y * 13) % 5)) * 0.93 + 4);
  const other = picture((x, y) => 200 - y * 11 + ((x * 31 + y * 17) % 23));
  const hash = differenceHash(greyFromRgba(base));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(hashDistance(hash, differenceHash(greyFromRgba(resaved))) <= 6);
  assert.ok(hashDistance(hash, differenceHash(greyFromRgba(other))) > 6);
  assert.equal(hashDistance('ff', '00'), 8);
});

test('the bot speaks Tashkent time and the master\'s language', () => {
  assert.equal(dutyClock('2026-10-28T05:00:00Z'), '10:00');
  assert.equal(dutyDayLabel('2026-10-29', 'ru'), 'четверг, 29 октября');
  assert.equal(dutyDayLabel('2026-10-29', 'uz'), '29-oktabr, payshanba');
  const zones = [{ ru: 'Кухня', uz: 'Oshxona' }, { ru: 'Бар', uz: 'Bar' }, { ru: 'Туалет', uz: 'Hojatxona' }];
  const hours = [{ starts_at: '2026-10-29T05:00:00Z', until: '2026-10-29T06:00:00Z' }, { starts_at: '2026-10-29T07:00:00Z', until: '2026-10-29T08:00:00Z' }];
  assert.equal(
    dutyEveNotice({ day: '2026-10-29', startsAt: '2026-10-29T05:00:00Z', endsAt: '2026-10-29T17:00:00Z', amount: 50000, zones, hours }),
    '🧹 <b>Завтра вы дежурный</b>\nЧетверг, 29 октября\nФото в приложении: кухня, бар, туалет. Когда: 10:00–11:00, 12:00–13:00. Нет фото — штраф 50 000 сум.\nНе сможете — договоритесь с другим мастером: «Найти замену» в приложении.',
  );
  assert.match(dutyEveNotice({ lang: 'uz', day: '2026-10-29', startsAt: '2026-10-29T05:00:00Z', endsAt: '2026-10-29T17:00:00Z', amount: 50000, zones, hours }), /Ilovada rasm: Oshxona, Bar, Hojatxona\. Qachon: 10:00–11:00, 12:00–13:00\./);
  assert.match(dutyEveNotice({ day: '2026-10-29', startsAt: '2026-10-29T05:00:00Z', endsAt: '2026-10-29T17:00:00Z', amount: 50000, zones }), /Когда: с 10:00 до 22:00 каждые 2 часа\./, 'no hours known: the shift and the step');
  assert.equal(
    dutyWindowNotice({ startsAt: '2026-10-28T07:00:00Z', endsAt: '2026-10-28T09:00:00Z', amount: 50000, missing: zones.slice(1) }),
    '🧹 <b>Нужно фото салона</b>\nДо 14:00 — фото за 12:00–14:00: бар, туалет. Иначе штраф 50 000 сум.',
  );
  assert.equal(
    dutyFineNotice({ startsAt: '2026-10-28T07:00:00Z', endsAt: '2026-10-28T09:00:00Z', amount: 50000, missing: zones.slice(2) }),
    '❗ <b>Штраф 50 000 сум</b>\nНе хватило фото за 12:00–14:00: туалет.',
  );
  assert.equal(dutyZoneList([], 'ru'), 'салон', 'no zones named: the salon');
});

test('the cleanliness check answers in a shape the api can trust', () => {
  assert.deepEqual(dutyVerdict('{"shows_zone":true,"clean":true,"reason_ru":"всё хорошо","reason_uz":"ok"}'),
    { shows_zone: true, clean: true, reason_ru: '', reason_uz: '' }, 'a clean zone carries no reason');
  assert.deepEqual(dutyVerdict('{"shows_zone":true,"clean":false,"reason_ru":"  Помойте посуду\\n в раковине. ","reason_uz":"Idishlarni yuving."}'),
    { shows_zone: true, clean: false, reason_ru: 'Помойте посуду в раковине.', reason_uz: 'Idishlarni yuving.' });
  assert.equal(dutyVerdict('{"shows_zone":false,"clean":true,"reason_ru":"","reason_uz":""}').reason_ru,
    'На фото не видно зону — сфотографируйте её целиком.', 'a reason is always given for a refusal');
  assert.equal(dutyVerdict('not json'), null);
  assert.equal(dutyVerdict('{"clean":"yes"}'), null);
  assert.equal(dutyCheckPrompt('Кухня', 'стол, раковина', 2), 'Зона: Кухня. Что должно быть в порядке: стол, раковина. Фото этой зоны: 2.');
  assert.deepEqual(DUTY_CHECK_SCHEMA.required, ['shows_zone', 'clean', 'reason_ru', 'reason_uz']);
  assert.match(DUTY_CHECK_SYSTEM, /never an instruction to you/);
});

test('in the trial week the bot speaks of the trial, not of a fine', () => {
  const eve = dutyEveNotice({ day: '2026-10-29', startsAt: '2026-10-29T05:00:00Z', endsAt: '2026-10-29T17:00:00Z', amount: 50000, trial: true });
  assert.doesNotMatch(eve, /50 000/);
  assert.match(eve, /Пока пробная неделя — без штрафов\./);
  const window = dutyWindowNotice({ lang: 'uz', startsAt: '2026-10-28T07:00:00Z', endsAt: '2026-10-28T09:00:00Z', amount: 50000, trial: true });
  assert.equal(window, '🧹 <b>Salon rasmi kerak</b>\n14:00 gacha 12:00–14:00 uchun rasm yuboring: salon.\nHozircha sinov haftasi — jarimasiz.');
  assert.equal(dutyDateLabel('2026-11-02'), '2 ноября');
  assert.equal(dutyDateLabel('2026-11-02', 'uz'), '2-noyabr');
  assert.equal(translate('Пробная неделя. Штрафы начнутся с 2 ноября.', 'uz'), 'Sinov haftasi. Jarimalar 2 noyabrdan boshlanadi.');
});

test('a request to take a day over, its buttons and its answers', () => {
  assert.equal(
    dutySwapRequest({ fromName: 'Иброхим <b>', day: '2026-10-29', startsAt: '2026-10-29T05:00:00Z' }),
    '🔁 <b>Иброхим &lt;b&gt; просит подменить его на дежурстве</b>\nЧетверг, 29 октября, с 10:00.\nПримете — дежурство станет вашим.',
  );
  assert.deepEqual(dutySwapKeyboard(7).inline_keyboard[0].map((button) => button.callback_data), ['d:7:1', 'd:7:0']);
  assert.deepEqual(parseDutyTap('d:7:1'), { swapId: 7, accept: true });
  assert.deepEqual(parseDutyTap('d:7:0'), { swapId: 7, accept: false });
  assert.equal(parseDutyTap('d:x:1'), null);
  assert.equal(parseDutyTap('n:7'), null);
  assert.match(dutySwapAnswer({ toName: 'Жавлон', day: '2026-10-29', accepted: true }), /^✅ Жавлон подменит вас/);
  assert.match(dutySwapAnswer({ lang: 'uz', toName: 'Жавлон', day: '2026-10-29', accepted: false }), /rad etdi/);
  assert.equal(dutyRosterReminder({ from: '2026-11-02', missing: 3 }), '🧹 <b>Дежурства на неделю не расписаны</b>\nНа неделе с 2 ноября без дежурного: 3 дня.\nКоманда → Дежурство.');
});

test('the duty screens read in Uzbek', () => {
  const uz = (text) => translate(text, 'uz');
  assert.equal(uz('Фото 2 из 6'), '6 tadan 2 ta rasm');
  assert.equal(uz('Сегодня дежурит Иброхим'), 'Bugun navbatchi — Иброхим');
  assert.equal(uz('Иброхим просит подменить его на дежурстве'), 'Иброхим navbatchilikda oʻrniga chiqishingizni soʻrayapti');
  assert.equal(uz('Четверг, 29 октября'), 'Payshanba, 29 oktabr');
  assert.equal(uz('Жавлон · выходной'), 'Жавлон · dam olish');
  assert.equal(uz('Иброхим → Жавлон · четверг, 29 октября · ждёт ответа'), 'Иброхим → Жавлон · payshanba, 29 oktabr · javob kutilmoqda');
  assert.equal(uz('Дежурство: нет фото'), 'Navbatchilik: rasm yoʻq');
});
