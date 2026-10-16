import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNames, translate } from '../src/i18n/index.js';
import { PHRASES, TEMPLATES } from '../src/i18n/uz.js';

const uz = (text) => translate(text, 'uz');

test('Russian stays Russian for those who keep it', () => {
  assert.equal(translate('Я пришёл', 'ru'), 'Я пришёл');
});

test('buttons and headings are whole phrases', () => {
  assert.equal(uz('Я пришёл'), 'Men keldim');
  assert.equal(uz('Мои записи'), 'Mening yozuvlarim');
  assert.equal(uz('Не пришёл'), 'Kelmadi');
  assert.equal(uz('  Выходной '), '  Dam olish ', 'the spacing React put around it is kept');
});

test('a text with numbers and names is translated around them', () => {
  assert.equal(
    uz('Приход отмечен. Опоздание 15 мин — штраф 100 000 сум.'),
    'Kelish belgilandi. Kechikish 15 daq. — jarima 100 000 soʻm.',
  );
  assert.equal(uz('Этот номер уже есть: Азиз Каримов. Выбран он.'), 'Bu raqam allaqachon bor: Азиз Каримов. U tanlandi.');
  assert.equal(uz('Смена с 14:00, опоздание — после 14:10.'), 'Smena 14:00 dan, kechikish — 14:10 dan keyin.');
});

test('a Russian part inside a template is translated in turn', () => {
  assert.equal(uz('Неделя · 12–18 октября'), 'Hafta · 12–18 oktabr');
});

test('a text built from pieces is translated word by word, names kept', () => {
  assert.equal(uz('сегодня · 09:00–10:00'), 'bugun · 09:00–10:00');
  assert.equal(uz('3 визита'), '3 tashrif');
});

test('a sentence the dictionary does not know stays whole Russian', () => {
  assert.equal(uz('Чистка лица (маска)'), 'Чистка лица (маска)');
  assert.equal(uz('Азиз Каримов'), 'Азиз Каримов');
});

test('every Uzbek entry is Latin and every template keeps its slots', () => {
  for (const [ru, value] of Object.entries(PHRASES)) {
    assert.doesNotMatch(value, /[А-Яа-яЁё]/, ru);
  }
  for (const [ru, value] of Object.entries(TEMPLATES)) {
    const slots = (text) => (text.match(/\{\d+\}/g) || []).sort().join();
    assert.equal(slots(value), slots(ru), ru);
    assert.doesNotMatch(value, /[А-Яа-яЁё]/, ru);
  }
});

test('services read in Uzbek from their own names, alone or joined', () => {
  registerNames([['Мужская стрижка', 'Erkaklar soch turmagi'], ['Укладка', 'Soch turmaklash']]);
  assert.equal(uz('Мужская стрижка'), 'Erkaklar soch turmagi');
  assert.equal(uz('Мужская стрижка + Укладка'), 'Erkaklar soch turmagi + Soch turmaklash');
  assert.equal(uz('Мужская стрижка + Борода'), 'Мужская стрижка + Борода', 'a part it does not know keeps the whole Russian');
});

test('a template never half-translates data, a joined text is translated piece by piece', () => {
  assert.equal(uz('Вода для клиентов'), 'Вода для клиентов');
  assert.equal(uz('12.10.2026: пришёл вовремя'), '12.10.2026: oʻz vaqtida keldi');
  assert.equal(uz('Наличные · новый'), 'Naqd · yangi');
  assert.equal(uz('15.10.2026: не отметился — поставьте время или выходной'), '15.10.2026: belgi qoʻymadi — vaqt yoki dam olish qoʻying');
});
