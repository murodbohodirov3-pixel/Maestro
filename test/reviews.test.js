import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botText,
  REVIEW_QUESTIONS,
  reviewDots,
  reviewKeyboard,
  reviewOwnerNotice,
  reviewQuestion,
  reviewSummary,
} from '../supabase/functions/_shared/bookingCore.js';

test('four questions, and the client always sees how far he is', () => {
  assert.equal(REVIEW_QUESTIONS, 4);
  assert.deepEqual([1, 2, 3, 4].map(reviewDots), ['●○○○', '●●○○', '●●●○', '●●●●']);
  const first = reviewQuestion({ lang: 'ru', master: 'Жавохир', step: 1 });
  assert.match(first, /визит к мастеру Жавохир — 4 коротких вопроса/);
  assert.match(first, /<b>Вопрос 1 из 4<\/b> ●○○○\nКак вам результат стрижки\?$/);
  assert.match(reviewQuestion({ lang: 'ru', master: 'Жавохир', step: 4 }), /<b>Последний вопрос<\/b> ●●●●\nУдобно ли вам было в салоне/);
  assert.match(reviewQuestion({ lang: 'uz', master: 'Javohir', step: 2 }), /<b>Savol 2 \/ 4<\/b> ●●○○/);
  assert.match(reviewQuestion({ lang: 'ru', master: '<b>', step: 1 }), /мастеру &lt;b&gt;/);
});

test('each question has its own five buttons, and the words their own', () => {
  assert.deepEqual(reviewKeyboard(17, 3).inline_keyboard[0].map((button) => button.callback_data),
    ['v:17:3:1', 'v:17:3:2', 'v:17:3:3', 'v:17:3:4', 'v:17:3:5']);
  for (const lang of ['ru', 'uz']) {
    const text = botText(lang);
    assert.equal(text.reviewQuestions.length, 4);
    assert.equal(text.reviewLabels.length, 4);
    assert.ok(text.reviewAskWords && text.reviewWordsThanks);
    assert.doesNotMatch(text.reviewAskWords, /необязательн|majburiy emas/);
  }
});

test('after the fourth: his scores, and the owner reads a low one with the number', () => {
  assert.equal(
    reviewSummary({ lang: 'ru', quality: 5, service: 4, cleanliness: 2, comfort: 5 }),
    'Спасибо! Ваши оценки:\n\nКачество работы — 5 ⭐\nСервис и общение — 4 ⭐\nЧистота и гигиена — 2 ⭐\nКомфорт в салоне — 5 ⭐',
  );
  const facts = {
    master_name: 'Жавохир', visit_date: '2026-10-22', client_name: 'Сардор Каримов', client_phone: '+998901234567',
    quality: 5, service: 4, cleanliness: 2, comfort: 5, comment: 'Волосы <на> столе',
  };
  assert.equal(reviewOwnerNotice('low', facts), [
    '⚠️ <b>Низкая оценка</b>',
    '💈 Жавохир · визит 22.10',
    '👤 Сардор Каримов · +998901234567',
    'Качество 5 · Сервис 4 · Чистота 2 · Комфорт 5',
  ].join('\n'));
  assert.match(reviewOwnerNotice('words', facts), /ждёт одобрения[\s\S]*«Волосы &lt;на&gt; столе»$/);
});

test('the QR text asks for the rating and no longer speaks of a mirror', () => {
  assert.equal(botText('ru').mirrorAskContact('Жавохир'),
    'Ваш мастер сегодня — Жавохир. Нажмите «Поделиться номером» внизу, а после стрижки, пожалуйста, оцените работу мастера.');
  assert.equal(botText('uz').mirrorAskContact('Javohir'),
    'Bugungi barberingiz — Javohir. Pastdagi «Raqamni yuborish» tugmasini bosing, soch olingandan keyin esa, iltimos, barberning ishini baholang.');
  for (const lang of ['ru', 'uz']) {
    for (const [key, value] of Object.entries(botText(lang))) {
      if (!key.startsWith('mirror')) continue;
      const text = typeof value === 'function' ? value('X', 'Y') : value;
      assert.doesNotMatch(text, /зеркал|oyna/i, key);
    }
  }
});
