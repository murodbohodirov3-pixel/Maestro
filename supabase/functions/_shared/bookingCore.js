// Pure pieces of online booking, shared by the booking-* functions and tested
// under Node: Tashkent time, the shapes of the page's answers
// (Maestro-Booking/docs/API_CONTRACT.md) and the bot's words in both languages.

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

// Any moment as the contract writes it: Tashkent wall time with +05:00.
export function tashkentIso(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  const local = new Date(time + TASHKENT_OFFSET_MS);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+05:00`;
}

export function tashkentDate(now = new Date(), offsetDays = 0) {
  const local = new Date(new Date(now).getTime() + TASHKENT_OFFSET_MS);
  local.setUTCDate(local.getUTCDate() + offsetDays);
  return local.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// The contract's moments carry an offset; one without is refused rather than
// read in the server's zone.
export function isZonedMoment(value) {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)
    && !Number.isNaN(Date.parse(text));
}

// Day mode: one entry per start time, with every master free at it.
export function groupDayTimes(slots) {
  const byStart = new Map();
  for (const slot of slots) {
    const startsAt = tashkentIso(slot.slot_start);
    if (!byStart.has(startsAt)) byStart.set(startsAt, new Set());
    byStart.get(startsAt).add(Number(slot.master_id));
  }
  return [...byStart.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([startsAt, masters]) => ({ starts_at: startsAt, master_ids: [...masters].sort((a, b) => a - b) }));
}

// Nearest mode: each requested master in catalog order, with the day of his
// first free time and its first starts, or nothing.
export function nearestByMaster(rows, masterIds) {
  return masterIds.map((masterId) => {
    const times = rows
      .filter((row) => Number(row.master_id) === Number(masterId))
      .map((row) => tashkentIso(row.slot_start))
      .sort();
    return { master_id: Number(masterId), date: times.length ? times[0].slice(0, 10) : null, times };
  });
}

export function servicesTotal(services) {
  return services.reduce(
    (total, service) => ({
      duration: total.duration + Number(service.duration_minutes || 0),
      price: total.price + Number(service.price_uzs || 0),
    }),
    { duration: 0, price: 0 },
  );
}

// A master can take a booking for these services if he does all of them.
export function masterOffers(master, serviceIds) {
  if (!Array.isArray(master.online_service_ids)) return true;
  return serviceIds.every((id) => master.online_service_ids.includes(id));
}

// The booking as the page sees it: the view from the database with Tashkent
// times, plus the token the page already holds.
export function bookingForPage(view, token) {
  return {
    token,
    status: view.status,
    hold_expires_at: view.hold_expires_at ? tashkentIso(view.hold_expires_at) : null,
    master_id: Number(view.master_id),
    starts_at: tashkentIso(view.starts_at),
    ends_at: tashkentIso(view.ends_at),
    service_ids: view.service_ids || [],
    total_price_uzs: Number(view.total_price_uzs),
    total_duration_minutes: Number(view.total_duration_minutes),
  };
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,40}$/;

export function telegramStartUrl(botUsername, token) {
  return `https://t.me/${botUsername}?start=b_${token}`;
}

// Allowed page origins from a comma-separated setting.
export function parseOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function corsHeaders(origin, allowedOrigins) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// ------------------------------------------------------------------ the bot

const WEEKDAYS = {
  ru: ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'],
  uz: ['dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba', 'yakshanba'],
};
const MONTHS = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
};

export function langOf(value) {
  return value === 'uz' ? 'uz' : 'ru';
}

// «среда, 15 октября, 18:00» / «15-oktabr, chorshanba, 18:00».
export function formatWhen(value, lang) {
  const local = new Date(new Date(value).getTime() + TASHKENT_OFFSET_MS);
  const weekday = WEEKDAYS[langOf(lang)][(local.getUTCDay() + 6) % 7];
  const day = local.getUTCDate();
  const month = MONTHS[langOf(lang)][local.getUTCMonth()];
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  return langOf(lang) === 'uz' ? `${day}-${month}, ${weekday}, ${time}` : `${weekday}, ${day} ${month}, ${time}`;
}

export function formatMoney(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// «+998 ** *** 12 34»: enough to recognise one's own number, not to read it.
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `+${digits.slice(0, 3)} ** *** ${digits.slice(-4, -2)} ${digits.slice(-2)}`;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TEXT = {
  ru: {
    title: 'Запись в Maestro Barberia',
    master: 'Мастер',
    price: 'сум',
    shareButton: '📱 Поделиться номером',
    askContact: 'Чтобы подтвердить запись, нажмите «Поделиться номером» внизу. Время держится за вами 10 минут.',
    knownNumber: (masked) => `Номер для связи: ${masked}`,
    confirmButton: '✅ Подтвердить запись',
    cancelButton: 'Отменить запись',
    confirmed: '✅ Вы записаны!',
    already: 'Эта запись уже подтверждена.',
    address: (address) => `Адрес: ${address}. Ждём вас!`,
    expired: (site) => `Время брони истекло. Выберите время заново: ${site}`,
    cancelledBefore: (site) => `Эта запись отменена. Записаться заново: ${site}`,
    notFound: (site) => `Запись не найдена. Записаться: ${site}`,
    notYours: 'Эта запись оформлена с другого аккаунта Telegram.',
    foreignContact: 'Пожалуйста, отправьте свой номер — кнопкой «Поделиться номером» внизу.',
    noHold: (site) => `Нет записи, которая ждёт подтверждения. Записаться: ${site}`,
    blocked: (phone) => `К сожалению, онлайн-запись для вас недоступна. Позвоните нам: ${phone}`,
    cancelled: (site) => `Запись отменена. Будем рады видеть вас в другой раз: ${site}`,
    tooLate: 'Эту запись уже нельзя отменить.',
    help: (site) => `Записаться в Maestro Barberia: ${site}`,
    reminder24: 'Напоминаем: завтра вы записаны в Maestro Barberia.',
    reminder2: 'Через 2 часа ждём вас в Maestro Barberia.',
    error: 'Что-то пошло не так. Попробуйте ещё раз через минуту.',
  },
  uz: {
    title: 'Maestro Barberia\'ga yozilish',
    master: 'Usta',
    price: 'so\'m',
    shareButton: '📱 Raqamni yuborish',
    askContact: 'Yozilishni tasdiqlash uchun pastdagi «Raqamni yuborish» tugmasini bosing. Vaqt siz uchun 10 daqiqa band turadi.',
    knownNumber: (masked) => `Aloqa raqami: ${masked}`,
    confirmButton: '✅ Yozilishni tasdiqlash',
    cancelButton: 'Yozilishni bekor qilish',
    confirmed: '✅ Siz yozildingiz!',
    already: 'Bu yozilish allaqachon tasdiqlangan.',
    address: (address) => `Manzil: ${address}. Sizni kutamiz!`,
    expired: (site) => `Band qilish vaqti tugadi. Vaqtni qaytadan tanlang: ${site}`,
    cancelledBefore: (site) => `Bu yozilish bekor qilingan. Qaytadan yozilish: ${site}`,
    notFound: (site) => `Yozilish topilmadi. Yozilish: ${site}`,
    notYours: 'Bu yozilish boshqa Telegram akkauntidan qilingan.',
    foreignContact: 'Iltimos, o\'z raqamingizni pastdagi «Raqamni yuborish» tugmasi orqali yuboring.',
    noHold: (site) => `Tasdiqlashni kutayotgan yozilish yo\'q. Yozilish: ${site}`,
    blocked: (phone) => `Afsuski, siz uchun onlayn yozilish mavjud emas. Bizga qo\'ng\'iroq qiling: ${phone}`,
    cancelled: (site) => `Yozilish bekor qilindi. Sizni yana kutamiz: ${site}`,
    tooLate: 'Bu yozilishni endi bekor qilib bo\'lmaydi.',
    help: (site) => `Maestro Barberia'ga yozilish: ${site}`,
    reminder24: 'Eslatma: ertaga siz Maestro Barberia\'ga yozilgansiz.',
    reminder2: '2 soatdan keyin sizni Maestro Barberia\'da kutamiz.',
    error: 'Xatolik yuz berdi. Bir daqiqadan so\'ng qayta urinib ko\'ring.',
  },
};

export function botText(lang) {
  return TEXT[langOf(lang)];
}

// The lines every bot message about a booking repeats.
export function bookingLines({ startsAt, masterName, serviceName, price }, lang) {
  const text = botText(lang);
  const lines = [
    `📅 ${formatWhen(startsAt, lang)}`,
    `💈 ${text.master}: ${escapeHtml(masterName)}`,
    `✂️ ${escapeHtml(serviceName)}`,
  ];
  // Reminders leave the price out.
  if (price != null) lines.push(`💵 ${formatMoney(price)} ${text.price}`);
  return lines.join('\n');
}

// For the master and the administrators, always in Russian.
export function staffNotice({ kind, startsAt, masterName, serviceName, price, clientName, clientPhone, comment }) {
  const head = kind === 'cancelled' ? '❌ Клиент отменил запись с сайта' : '🆕 Новая запись с сайта';
  const lines = [
    head,
    `📅 ${formatWhen(startsAt, 'ru')}`,
    `💈 ${escapeHtml(masterName)}`,
    `✂️ ${escapeHtml(serviceName)} · ${formatMoney(price)} сум`,
    `👤 ${escapeHtml(clientName)}${clientPhone ? `, ${escapeHtml(clientPhone)}` : ''}`,
  ];
  if (comment) lines.push(`💬 ${escapeHtml(comment)}`);
  return lines.join('\n');
}
