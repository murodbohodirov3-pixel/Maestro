// Дежурный по чистоте (owner's decisions of 2026-10-26): what @Maestro_uzbot
// tells the duty master, the master asked to take a day over, and the owner.
// Every text to a master is in his language (app_users.lang); kept apart from
// the functions so it can be tested under Node.

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

const WEEKDAYS = {
  ru: ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'],
  uz: ['dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba', 'yakshanba'],
};
const MONTHS = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
};

function langOf(value) {
  return value === 'uz' ? 'uz' : 'ru';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// «12:00» in Tashkent, whatever the server's zone.
export function dutyClock(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const local = new Date(time + TASHKENT_OFFSET_MS);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

// «2 ноября» / «2-noyabr».
export function dutyDateLabel(day, lang = 'ru') {
  const parsed = new Date(`${String(day).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(day ?? '');
  const month = MONTHS[langOf(lang)][parsed.getUTCMonth()];
  return langOf(lang) === 'uz' ? `${parsed.getUTCDate()}-${month}` : `${parsed.getUTCDate()} ${month}`;
}

// «среда, 29 октября» / «29-oktabr, chorshanba», from a plain date.
export function dutyDayLabel(day, lang = 'ru') {
  const parsed = new Date(`${String(day).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(day ?? '');
  const which = langOf(lang);
  const weekday = WEEKDAYS[which][(parsed.getUTCDay() + 6) % 7];
  const month = MONTHS[which][parsed.getUTCMonth()];
  return which === 'uz' ? `${parsed.getUTCDate()}-${month}, ${weekday}` : `${weekday}, ${parsed.getUTCDate()} ${month}`;
}

function capital(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function every(minutes, lang) {
  const hours = Math.round((Number(minutes) || 120) / 60);
  if (langOf(lang) === 'uz') return `har ${hours} soatda`;
  if (hours === 1) return 'каждый час';
  return `каждые ${hours} ${hours >= 2 && hours <= 4 ? 'часа' : 'часов'}`;
}

const TEXT = {
  ru: {
    eveHead: '🧹 <b>Завтра вы дежурный</b>',
    eveBody: (from, to, interval, amount) => `С ${from} до ${to} ${interval} — фото салона в приложении. Нет фото — штраф ${amount} сум.`,
    eveBodyTrial: (from, to, interval) => `С ${from} до ${to} ${interval} — фото салона в приложении.`,
    trial: 'Пока пробная неделя — без штрафов.',
    eveSwap: 'Не сможете — договоритесь с другим мастером: «Найти замену» в приложении.',
    windowHead: '🧹 <b>Нужно фото салона</b>',
    windowBody: (from, to, amount) => `До ${to} — фото за ${from}–${to}. Иначе штраф ${amount} сум.`,
    windowBodyTrial: (from, to) => `До ${to} — фото за ${from}–${to}.`,
    fineHead: (amount) => `❗ <b>Штраф ${amount} сум</b>`,
    fineBody: (from, to) => `Нет фото салона за ${from}–${to}.`,
    swapHead: (name) => `🔁 <b>${name} просит подменить его на дежурстве</b>`,
    swapWhen: (day, from) => `${day}, с ${from}.`,
    swapHint: 'Примете — дежурство станет вашим.',
    acceptButton: 'Принять',
    declineButton: 'Отказать',
    openButton: 'Открыть приложение',
    accepted: (name, day) => `✅ ${name} подменит вас на дежурстве: ${day}.`,
    declined: (name, day) => `❌ ${name} отказался подменить вас: ${day}. Попросите другого мастера — иначе дежурство остаётся за вами.`,
    replies: {
      accepted: (day) => `Принято: ${day} дежурите вы.`,
      declined: 'Вы отказались.',
      closed: 'Эта просьба уже закрыта.',
      tooLate: 'Поздно: дежурство уже началось.',
      notYours: 'Эта просьба не вам.',
    },
  },
  uz: {
    eveHead: '🧹 <b>Ertaga siz navbatchisiz</b>',
    eveBody: (from, to, interval, amount) => `${from} dan ${to} gacha ${interval} ilovada salon rasmini yuboring. Rasm boʻlmasa — ${amount} soʻm jarima.`,
    eveBodyTrial: (from, to, interval) => `${from} dan ${to} gacha ${interval} ilovada salon rasmini yuboring.`,
    trial: 'Hozircha sinov haftasi — jarimasiz.',
    eveSwap: 'Kela olmasangiz — boshqa barber bilan kelishing: ilovada «Oʻrinbosar topish».',
    windowHead: '🧹 <b>Salon rasmi kerak</b>',
    windowBody: (from, to, amount) => `${to} gacha ${from}–${to} uchun rasm yuboring. Aks holda ${amount} soʻm jarima.`,
    windowBodyTrial: (from, to) => `${to} gacha ${from}–${to} uchun rasm yuboring.`,
    fineHead: (amount) => `❗ <b>${amount} soʻm jarima</b>`,
    fineBody: (from, to) => `${from}–${to} uchun salon rasmi yoʻq.`,
    swapHead: (name) => `🔁 <b>${name} navbatchilikda oʻrniga chiqishingizni soʻrayapti</b>`,
    swapWhen: (day, from) => `${day}, ${from} dan.`,
    swapHint: 'Qabul qilsangiz, navbatchilik sizniki boʻladi.',
    acceptButton: 'Qabul qilish',
    declineButton: 'Rad etish',
    openButton: 'Ilovani ochish',
    accepted: (name, day) => `✅ ${name} navbatchilikda oʻrningizga chiqadi: ${day}.`,
    declined: (name, day) => `❌ ${name} oʻrningizga chiqishni rad etdi: ${day}. Boshqa barberdan soʻrang — aks holda navbatchilik sizda qoladi.`,
    replies: {
      accepted: (day) => `Qabul qilindi: ${day} navbatchi — siz.`,
      declined: 'Siz rad etdingiz.',
      closed: 'Bu soʻrov allaqachon yopilgan.',
      tooLate: 'Kech: navbatchilik allaqachon boshlangan.',
      notYours: 'Bu soʻrov sizga emas.',
    },
  },
};

export function dutyText(lang) {
  return TEXT[langOf(lang)];
}

// The evening before, to tomorrow's duty master. In the trial week before
// the fines start, the fine is not mentioned and the trial is.
export function dutyEveNotice({ lang = 'ru', day, startsAt, endsAt, intervalMinutes = 120, amount, trial = false }) {
  const text = dutyText(lang);
  const [from, to, interval] = [dutyClock(startsAt), dutyClock(endsAt), every(intervalMinutes, lang)];
  return [
    text.eveHead,
    capital(dutyDayLabel(day, lang)),
    trial ? text.eveBodyTrial(from, to, interval) : text.eveBody(from, to, interval, money(amount)),
    trial ? text.trial : null,
    text.eveSwap,
  ].filter(Boolean).join('\n');
}

// Twenty minutes before a window ends with no photo.
export function dutyWindowNotice({ lang = 'ru', startsAt, endsAt, amount, trial = false }) {
  const text = dutyText(lang);
  const [from, to] = [dutyClock(startsAt), dutyClock(endsAt)];
  return [
    text.windowHead,
    trial ? text.windowBodyTrial(from, to) : text.windowBody(from, to, money(amount)),
    trial ? text.trial : null,
  ].filter(Boolean).join('\n');
}

export function dutyFineNotice({ lang = 'ru', startsAt, endsAt, amount }) {
  const text = dutyText(lang);
  return [text.fineHead(money(amount)), text.fineBody(dutyClock(startsAt), dutyClock(endsAt))].join('\n');
}

// To the master asked to take the day over, with «Принять» and «Отказать».
export function dutySwapRequest({ lang = 'ru', fromName, day, startsAt }) {
  const text = dutyText(lang);
  return [
    text.swapHead(escapeHtml(fromName)),
    text.swapWhen(capital(dutyDayLabel(day, lang)), dutyClock(startsAt)),
    text.swapHint,
  ].join('\n');
}

export function dutySwapKeyboard(swapId, lang = 'ru') {
  const text = dutyText(lang);
  return {
    inline_keyboard: [[
      { text: text.acceptButton, callback_data: `d:${swapId}:1` },
      { text: text.declineButton, callback_data: `d:${swapId}:0` },
    ]],
  };
}

// «d:<swap>:<1|0>» from a button; null for anything else.
export function parseDutyTap(data) {
  const match = String(data ?? '').match(/^d:(\d{1,18}):([01])$/);
  return match ? { swapId: Number(match[1]), accept: match[2] === '1' } : null;
}

// To the master who asked, once the other has answered.
export function dutySwapAnswer({ lang = 'ru', toName, day, accepted }) {
  const text = dutyText(lang);
  const label = dutyDayLabel(day, lang);
  return accepted ? text.accepted(escapeHtml(toName), label) : text.declined(escapeHtml(toName), label);
}

// The owner hears of a day that changed hands; he takes no part in it.
export function dutySwapOwnerNotice({ fromName, toName, day }) {
  return `🔁 Подмена на дежурстве, ${dutyDayLabel(day, 'ru')}: ${escapeHtml(fromName)} → ${escapeHtml(toName)}.`;
}

// Sunday evening, when next week has a day without a duty master.
export function dutyRosterReminder({ from, missing }) {
  const count = Number(missing) || 0;
  const days = count === 1 ? 'день' : count >= 2 && count <= 4 ? 'дня' : 'дней';
  const parsed = new Date(`${String(from).slice(0, 10)}T12:00:00Z`);
  return [
    '🧹 <b>Дежурства на неделю не расписаны</b>',
    `На неделе с ${parsed.getUTCDate()} ${MONTHS.ru[parsed.getUTCMonth()]} без дежурного: ${count} ${days}.`,
    'Команда → Дежурство.',
  ].join('\n');
}
