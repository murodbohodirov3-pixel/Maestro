// booking-bot — the Telegram side of online booking.
//
// Two bots call it as their webhook, each with its own secret in the header
// X-Telegram-Bot-Api-Secret-Token (owner's decision of 2026-10-21):
// @MaestroBarberia_bot is the clients', and the site sends them there;
// @Maestro_uzbot is the app's and the staff's, and still takes the links it
// gave out before. Whatever a client does, the answer comes from the bot he
// wrote to; whatever the staff hear, from @Maestro_uzbot.
//   /start b_<token>  → the held booking, then «Поделиться номером» (or one
//                       button if this Telegram user's number is known)
//   contact           → only the user's own contact; confirms his latest hold
//   c:<id> / x:<id>   → confirm with the known number / cancel
//   p:<id>            → not that number: share another contact
//   n:<id>            → a master marks his booking «Не пришёл» (staff bot only)
// And the QR at a master's mirror, in @MaestroBarberia_bot only:
//   /start m_<code>   → «Выберите язык» (l:ru / l:uz), then «Поделиться номером»;
//                       a new number is asked its name, its surname and
//                       «Вы уже были у нас?» (k:1 / k:0), a card without a
//                       surname only that; the master sees him in the app.
// And the rating of a visit, in @MaestroBarberia_bot only: half an hour after
// it is recorded, {"action":"reviews"} asks four questions in one message
// (v:<review>:<step>:<score>), then asks for a few words.
// pg_cron calls it with x-booking-cron-secret: {"action":"reminders"} sends the
// clients' 24 h and 2 h reminders, each through the bot its booking was
// confirmed with, and the masters' «закройте запись» a quarter of an hour
// after an open booking ended; {"action":"webhook_info"}, {"action":"set_webhook"},
// {"action":"bot_info"} and {"action":"set_profile"} (with "bot": "client" or
// "staff") look after the bots without a token ever leaving the server.
import {
  bookingBotOf,
  bookingLines,
  botText,
  CLIENT_BOT_PROFILE,
  escapeHtml,
  langOf,
  maskPhone,
  masterBookingNotice,
  masterReminder,
  masterText,
  mirrorStartCode,
  reviewKeyboard,
  reviewOwnerNotice,
  reviewQuestion,
  reviewSummary,
  secretsMatch,
  staffNotice,
  webhookBot,
} from '../_shared/bookingCore.js';
import { bookingSettings, db, tokenHash } from '../_shared/bookingHttp.ts';
import { maskPhoneForStaff } from '../_shared/access.js';
import { tidyNamePart } from '../_shared/clientName.js';

type Bot = 'client' | 'staff';

const TOKENS: Record<Bot, string> = {
  client: Deno.env.get('CLIENT_BOT_TOKEN') || '',
  staff: Deno.env.get('BOT_TOKEN') || '',
};
const WEBHOOK_SECRETS: Record<Bot, string> = {
  client: Deno.env.get('CLIENT_BOT_WEBHOOK_SECRET') || '',
  staff: Deno.env.get('BOOKING_BOT_WEBHOOK_SECRET') || '',
};
const CRON_SECRET = Deno.env.get('BOOKING_CRON_SECRET') || '';
const SITE = Deno.env.get('BOOKING_SITE_URL') || 'https://maestro-booking.vercel.app';
const APP_URL = Deno.env.get('MAESTRO_APP_URL') || 'https://maestro-pied-two.vercel.app';
const WEBHOOK_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function telegram(bot: Bot, method: string, body: Record<string, unknown>) {
  if (!TOKENS[bot]) {
    console.warn('[booking-bot] no token for', bot, method);
    return { ok: false, description: 'no_token' } as { ok: boolean; description?: string; result?: unknown };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TOKENS[bot]}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
    if (!result.ok) console.warn('[booking-bot] telegram refused', bot, method, result.description);
    return result as { ok: boolean; description?: string; result?: unknown };
  } catch (error) {
    console.warn('[booking-bot] telegram unreachable', bot, method, String(error));
    return { ok: false, description: 'unreachable' };
  }
}

function send(bot: Bot, chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
  return telegram(bot, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

const cancelKeyboard = (appointmentId: string, lang: string) => ({
  inline_keyboard: [[{ text: botText(lang).cancelButton, callback_data: `x:${appointmentId}` }]],
});

type BookingFacts = {
  booking: { starts_at: string; total_price_uzs: number; status: string };
  master_name: string;
  service_name: string;
};

function linesOf(facts: BookingFacts, lang: string, withPrice = true) {
  return bookingLines({
    startsAt: facts.booking.starts_at,
    masterName: facts.master_name,
    serviceName: facts.service_name,
    price: withPrice ? facts.booking.total_price_uzs : null,
  }, lang);
}

// Those who take bookings hear of every site booking in person (owner's
// decision of 2026-10-16, no group): the owner, the administrator and the
// partner, with the number whole, since they call clients.
async function deskChats(): Promise<string[]> {
  const { data, error } = await db.from('app_users')
    .select('telegram_id')
    .in('role', ['owner', 'admin', 'partner'])
    .eq('active', true)
    .not('telegram_id', 'is', null);
  if (error) {
    console.warn('[booking-bot] desk chats', error.message);
    return [];
  }
  return [...new Set((data ?? []).map((row: { telegram_id: number | string }) => String(row.telegram_id)))];
}

// The desk, and the master in person with the number masked, as everywhere he
// sees it — always from @Maestro_uzbot, the bot they started and the one that
// opens the app. A failed delivery is logged and never stops the client's answer.
async function notifyStaff(kind: 'created' | 'cancelled', facts: Record<string, unknown>) {
  const booking = facts.booking as { starts_at: string; total_price_uzs: number };
  const phone = facts.client_phone ? String(facts.client_phone) : '';
  const textWith = (clientPhone: string) => staffNotice({
    kind,
    startsAt: booking.starts_at,
    masterName: String(facts.master_name ?? ''),
    serviceName: String(facts.service_name ?? ''),
    price: booking.total_price_uzs,
    clientName: String(facts.client_name ?? ''),
    clientPhone,
    comment: facts.comment ? String(facts.comment) : '',
  });
  const masterChat = facts.master_chat_id ? String(facts.master_chat_id) : '';
  const desk = (await deskChats()).filter((chatId) => chatId !== masterChat);
  let masterLang = 'ru';
  if (masterChat) {
    const { data: login } = await db.from('app_users').select('lang').eq('telegram_id', masterChat).maybeSingle();
    masterLang = String(login?.lang || 'ru');
  }
  await Promise.all([
    ...desk.map((chatId) => send('staff', chatId, textWith(phone))),
    masterChat ? send('staff', masterChat, masterBookingNotice({
      kind: kind === 'cancelled' ? 'cancelled' : 'new',
      startsAt: booking.starts_at,
      clientName: String(facts.client_name ?? ''),
      clientPhone: maskPhoneForStaff(phone) || '',
      serviceName: String(facts.service_name ?? ''),
      lang: masterLang,
    }), { reply_markup: { inline_keyboard: [[{ text: masterText(masterLang).openButton, web_app: { url: APP_URL } }]] } }) : null,
  ]);
}

// The owner in person hears of a low score and of words to approve.
async function ownerChats(): Promise<string[]> {
  const { data, error } = await db.from('app_users')
    .select('telegram_id')
    .eq('role', 'owner')
    .eq('active', true)
    .not('telegram_id', 'is', null);
  if (error) {
    console.warn('[booking-bot] owner chats', error.message);
    return [];
  }
  return [...new Set((data ?? []).map((row: { telegram_id: number | string }) => String(row.telegram_id)))];
}

async function confirm(bot: Bot, appointmentId: string, tgUserId: string, phone: string | null, username: string | null, chatId: number, fallbackLang: string) {
  const { data, error } = await db.rpc('maestro_confirm_booking', {
    p_appointment_id: appointmentId,
    p_tg_user_id: tgUserId,
    p_phone: phone,
    p_tg_username: username,
  });
  if (error) throw error;
  const lang = langOf(data?.lang || fallbackLang);
  const text = botText(lang);

  if (!data?.ok) {
    const code = String(data?.error);
    if (code === 'expired') return send(bot, chatId, text.expired(SITE), { reply_markup: { remove_keyboard: true } });
    if (code === 'client_blocked') {
      const settings = await bookingSettings();
      return send(bot, chatId, text.blocked(settings.salon_phone || ''), { reply_markup: { remove_keyboard: true } });
    }
    if (code === 'forbidden') return send(bot, chatId, text.notYours);
    if (code === 'not_found') return send(bot, chatId, text.notFound(SITE));
    if (code === 'invalid_phone') return send(bot, chatId, text.foreignContact);
    if (code === 'staff_account') return send(bot, chatId, text.staffAccount, { reply_markup: { remove_keyboard: true } });
    return send(bot, chatId, text.error);
  }
  if (data.already_confirmed) return send(bot, chatId, text.already);

  // The reminders follow the bot the client confirmed with.
  const remembered = await db.from('appointments').update({ booking_bot: bot }).eq('id', String(data.appointment_id));
  if (remembered.error) console.error('[booking-bot] booking bot not kept', remembered.error.message);

  const settings = await bookingSettings();
  const address = lang === 'uz' ? (settings.salon_address_uz || settings.salon_address_ru) : settings.salon_address_ru;
  await send(bot, chatId, `${text.confirmed}\n\n${linesOf(data, lang)}\n\n${text.address(address || '')}`, {
    reply_markup: cancelKeyboard(String(data.appointment_id), lang),
  });
  await notifyStaff('created', data);
}

// Staff do not book clients on the site from their own phone: the card would
// take the staff member's number and Telegram (Жамолиддин, 2026-10-18). The
// administrator books them (owner's decision of 2026-10-19).
async function isStaff(tgUserId: string) {
  const { data, error } = await db.from('app_users').select('id').eq('telegram_id', tgUserId).eq('active', true).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function handleStart(bot: Bot, chatId: number, tgUserId: string, token: string, fallbackLang: string) {
  // A site booking now: a number he shares confirms it, not the mirror.
  const dropped = await db.rpc('maestro_mirror_drop', { p_tg_user_id: tgUserId });
  if (dropped.error) console.warn('[booking-bot] mirror session not dropped', dropped.error.message);
  const { data, error } = await db.rpc('maestro_booking_for_bot', {
    p_token_hash: await tokenHash(token),
    p_appointment_id: null,
    p_tg_user_id: tgUserId,
  });
  if (error) throw error;
  if (!data?.ok) return send(bot, chatId, botText(fallbackLang).notFound(SITE));

  const lang = langOf(data.lang);
  const text = botText(lang);
  const status = data.booking.status;
  if (status === 'expired') return send(bot, chatId, text.expired(SITE));
  if (status === 'cancelled') return send(bot, chatId, text.cancelledBefore(SITE));
  if (status === 'confirmed') {
    if (!data.mine) return send(bot, chatId, text.notYours);
    return send(bot, chatId, `${text.already}\n\n${linesOf(data, lang)}`, {
      reply_markup: cancelKeyboard(String(data.appointment_id), lang),
    });
  }

  // Said at once rather than after the number is shared; the confirmation
  // itself refuses a staff account and gives the time back to the site.
  if (await isStaff(tgUserId)) return confirm(bot, String(data.appointment_id), tgUserId, null, null, chatId, lang);

  const head = `<b>${text.title}</b>\n\n${linesOf(data, lang)}`;
  if (data.known_phone) {
    // A returning client: one button, no contact again. The number this
    // Telegram account is known by may be someone else's (a shared phone, a
    // card linked by mistake), so another one is a tap away.
    return send(bot, chatId, `${head}\n\n${text.knownNumber(maskPhone(data.known_phone))}`, {
      reply_markup: { inline_keyboard: [
        [{ text: text.confirmButton, callback_data: `c:${data.appointment_id}` }],
        [{ text: text.otherNumberButton, callback_data: `p:${data.appointment_id}` }],
      ] },
    });
  }
  return askForContact(bot, chatId, text, head);
}

function askForContact(bot: Bot, chatId: number, text: ReturnType<typeof botText>, head = '') {
  return send(bot, chatId, `${head ? `${head}\n\n` : ''}${text.askContact}`, {
    reply_markup: {
      keyboard: [[{ text: text.shareButton, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function handleContact(bot: Bot, message: Record<string, any>) {
  const chatId = message.chat.id;
  const tgUserId = String(message.from.id);
  const fallbackLang = langOf(message.from.language_code);
  // Only the user's own number: a contact forwarded from the address book
  // carries someone else's user_id, or none.
  if (String(message.contact?.user_id ?? '') !== tgUserId) {
    return send(bot, chatId, botText(fallbackLang).foreignContact);
  }
  if (bot === 'client') {
    const session = await mirrorSession(tgUserId);
    if (session) return mirrorContact(chatId, tgUserId, String(message.contact.phone_number ?? ''), session, fallbackLang);
  }
  const { data: appointmentId, error } = await db.rpc('maestro_latest_hold_for_telegram', { p_tg_user_id: tgUserId });
  if (error) throw error;
  if (!appointmentId) {
    return send(bot, chatId, botText(fallbackLang).noHold(SITE), { reply_markup: { remove_keyboard: true } });
  }
  return confirm(bot, String(appointmentId), tgUserId, String(message.contact.phone_number ?? ''), message.from.username ?? null, chatId, fallbackLang);
}

async function handleCallback(bot: Bot, query: Record<string, any>) {
  await telegram(bot, 'answerCallbackQuery', { callback_query_id: query.id });
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  const tgUserId = String(query.from.id);
  const fallbackLang = langOf(query.from.language_code);
  const [kind, appointmentId] = String(query.data ?? '').split(':');
  if (bot === 'client' && kind === 'v') return reviewTap(query);
  if (bot === 'client' && (kind === 'l' || kind === 'k')) {
    if (query.message?.message_id) {
      await telegram(bot, 'editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
    return kind === 'l'
      ? mirrorLang(chatId, tgUserId, appointmentId, fallbackLang)
      : mirrorKnown(chatId, tgUserId, appointmentId === '1', fallbackLang);
  }
  if (!UUID.test(appointmentId ?? '')) return;

  if (kind === 'c') {
    await confirm(bot, appointmentId, tgUserId, null, query.from.username ?? null, chatId, fallbackLang);
    return;
  }
  // Only @Maestro_uzbot puts «Не пришёл» under a master's reminder.
  if (kind === 'n') return bot === 'staff' ? masterNoShow(appointmentId, tgUserId, chatId, query.message?.message_id) : undefined;
  // «Другой номер»: the contact the person shares confirms the hold instead.
  if (kind === 'p') {
    if (query.message?.message_id) {
      await telegram(bot, 'editMessageReplyMarkup', { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
    return askForContact(bot, chatId, botText(fallbackLang));
  }
  if (kind !== 'x') return;

  const { data, error } = await db.rpc('maestro_cancel_booking_by_client', {
    p_appointment_id: appointmentId,
    p_tg_user_id: tgUserId,
  });
  if (error) throw error;
  const text = botText(data?.lang || fallbackLang);
  if (!data?.ok) {
    if (data?.error === 'too_late') return send(bot, chatId, text.tooLate);
    if (data?.error === 'forbidden') return send(bot, chatId, text.notYours);
    return send(bot, chatId, text.notFound(SITE));
  }
  // The button under the old message no longer means anything.
  if (query.message?.message_id) {
    await telegram(bot, 'editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
  if (data.already_cancelled) return send(bot, chatId, text.cancelled(SITE));
  await send(bot, chatId, text.cancelled(SITE));
  await notifyStaff('cancelled', data);
}

// «Не пришёл» under a master's reminder: the same outcome as in the app, with
// the master as the actor, so only the booking's own master gets through.
async function masterNoShow(appointmentId: string, tgUserId: string, chatId: number, messageId?: number) {
  const { data: user, error: userError } = await db.from('app_users')
    .select('id, lang').eq('telegram_id', tgUserId).eq('active', true).maybeSingle();
  if (userError) throw userError;
  const replies = masterText(user?.lang).replies;
  if (!user) return send('staff', chatId, replies.notYours);
  const { data, error } = await db.rpc('maestro_set_appointment_outcome', {
    p_appointment_id: appointmentId,
    p_outcome: 'no_show',
    p_cancelled_by: null,
    p_reason_code: 'no_show_no_notice',
    p_reason_note: null,
    p_actor_user_id: user.id,
  });
  if (error) throw error;
  if (data?.error === 'forbidden') return send('staff', chatId, replies.notYours);
  if (messageId) {
    await telegram('staff', 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }
  return send('staff', chatId, data?.ok ? replies.noShow : replies.closed);
}

async function handleUpdate(bot: Bot, update: Record<string, any>) {
  // Whoever writes to the clients' bot may be written to: the rating after a
  // visit is asked only of them.
  const from = update.callback_query?.from ?? update.message?.from;
  if (bot === 'client' && from?.id && (update.callback_query || update.message?.chat?.type === 'private')) {
    const seen = await db.rpc('maestro_client_bot_seen', { p_tg_user_id: String(from.id) });
    if (seen.error) console.warn('[booking-bot] chat not kept', seen.error.message);
  }
  if (update.callback_query) return handleCallback(bot, update.callback_query);
  const message = update.message;
  if (!message || !message.from) return;
  // Groups are not the bot's business.
  if (message.chat?.type !== 'private') return;
  if (message.contact) return handleContact(bot, message);

  const fallbackLang = langOf(message.from.language_code);
  const start = String(message.text ?? '').match(/^\/start(?:@\w+)?\s+b_([A-Za-z0-9_-]{22,40})\s*$/);
  if (start) return handleStart(bot, message.chat.id, String(message.from.id), start[1], fallbackLang);
  if (bot === 'client') {
    const code = mirrorStartCode(message.text);
    if (code) return mirrorBegin(message.chat.id, message.from, code);
    const session = await mirrorSession(String(message.from.id));
    if (session && typeof message.text === 'string' && !message.text.startsWith('/')) {
      return mirrorText(message.chat.id, String(message.from.id), message.text, session, fallbackLang);
    }
    if (typeof message.text === 'string' && !message.text.startsWith('/')) {
      const waiting = await db.rpc('maestro_review_waiting_words', { p_tg_user_id: String(message.from.id) });
      if (waiting.error) throw waiting.error;
      if (waiting.data) return reviewWords(message.chat.id, String(message.from.id), message.text, fallbackLang);
    }
  }
  return send(bot, message.chat.id, botText(fallbackLang).help(SITE));
}

// ------------------------------------------------- the QR at the mirror
// Only @MaestroBarberia_bot asks these questions; the base keeps where each
// Telegram user is (mirror_sessions) and makes the card and the scan.

type MirrorView = {
  ok?: boolean;
  error?: string;
  next?: string;
  step?: string;
  lang?: string | null;
  first_name?: string | null;
  created?: boolean;
  master_name?: string;
  master_name_uz?: string;
};

const LANG_KEYBOARD = {
  inline_keyboard: [[{ text: 'Русский', callback_data: 'l:ru' }, { text: 'Oʻzbekcha', callback_data: 'l:uz' }]],
};
const NO_KEYBOARD = { remove_keyboard: true };

function mirrorMaster(view: MirrorView, lang: string) {
  return escapeHtml(lang === 'uz' ? view.master_name_uz || view.master_name : view.master_name);
}

async function mirrorSession(tgUserId: string): Promise<MirrorView | null> {
  const { data, error } = await db.rpc('maestro_mirror_session', { p_tg_user_id: tgUserId });
  if (error) throw error;
  return data ?? null;
}

function askContactForMirror(chatId: number, view: MirrorView, lang: string) {
  const text = botText(lang);
  return send('client', chatId, text.mirrorAskContact(mirrorMaster(view, lang)), {
    reply_markup: { keyboard: [[{ text: text.shareButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
  });
}

function askKnown(chatId: number, lang: string) {
  const text = botText(lang);
  return send('client', chatId, text.mirrorAskKnown, {
    reply_markup: { inline_keyboard: [[
      { text: text.mirrorKnownYes, callback_data: 'k:1' },
      { text: text.mirrorKnownNo, callback_data: 'k:0' },
    ]] },
  });
}

// Every answer of the base is said the same way, whichever question it closes.
function mirrorReply(chatId: number, view: MirrorView, fallbackLang: string) {
  const lang = langOf(view.lang || fallbackLang);
  const text = botText(lang);
  if (!view.ok) {
    if (view.error === 'no_session') return send('client', chatId, text.mirrorExpired, { reply_markup: NO_KEYBOARD });
    if (view.error === 'client_blocked') return send('client', chatId, text.mirrorBlocked, { reply_markup: NO_KEYBOARD });
    if (view.error === 'invalid_phone') return send('client', chatId, text.foreignContact);
    if (view.error === 'invalid_name') return send('client', chatId, text.mirrorBadName);
    if (view.error === 'not_asked') return send('client', chatId, text.mirrorUseButtons);
    return send('client', chatId, text.error);
  }
  const name = escapeHtml(view.first_name || '');
  if (view.next === 'done') {
    const line = view.created ? text.mirrorDone : text.mirrorWelcomeBack;
    return send('client', chatId, line(name, mirrorMaster(view, lang)), { reply_markup: NO_KEYBOARD });
  }
  if (view.next === 'first_name') return send('client', chatId, text.mirrorAskFirst, { reply_markup: NO_KEYBOARD });
  if (view.next === 'surname') return send('client', chatId, text.mirrorAskSurname(name), { reply_markup: NO_KEYBOARD });
  if (view.next === 'last_name') return send('client', chatId, text.mirrorAskLast);
  if (view.next === 'known_before') return askKnown(chatId, lang);
  return send('client', chatId, text.error);
}

async function mirrorBegin(chatId: number, from: Record<string, any>, code: string) {
  const { data, error } = await db.rpc('maestro_mirror_begin', {
    p_code: code,
    p_tg_user_id: String(from.id),
    p_tg_username: from.username ?? null,
  });
  if (error) throw error;
  const text = botText(langOf(from.language_code));
  if (!data?.ok) {
    return send('client', chatId, data?.error === 'staff_account' ? text.mirrorStaff : text.mirrorUnknownCode, { reply_markup: NO_KEYBOARD });
  }
  return send('client', chatId, text.mirrorPickLang, { reply_markup: LANG_KEYBOARD });
}

async function mirrorLang(chatId: number, tgUserId: string, lang: string, fallbackLang: string) {
  const { data, error } = await db.rpc('maestro_mirror_lang', { p_tg_user_id: tgUserId, p_lang: lang });
  if (error) throw error;
  if (!data?.ok) return mirrorReply(chatId, data ?? {}, fallbackLang);
  const chosen = langOf(data.lang);
  if (data.step === 'contact') return askContactForMirror(chatId, data, chosen);
  // The language changed halfway: the question he was at, again.
  return mirrorReply(chatId, { ...data, next: data.step }, chosen);
}

async function mirrorContact(chatId: number, tgUserId: string, phone: string, session: MirrorView, fallbackLang: string) {
  const { data, error } = await db.rpc('maestro_mirror_contact', { p_tg_user_id: tgUserId, p_phone: phone });
  if (error) throw error;
  return mirrorReply(chatId, { lang: session.lang, ...(data ?? {}) }, fallbackLang);
}

async function mirrorText(chatId: number, tgUserId: string, typed: string, session: MirrorView, fallbackLang: string) {
  const lang = langOf(session.lang || fallbackLang);
  const text = botText(lang);
  if (session.step === 'lang') return send('client', chatId, text.mirrorPickLang, { reply_markup: LANG_KEYBOARD });
  if (session.step === 'contact') return askContactForMirror(chatId, session, lang);
  if (session.step === 'known_before') return askKnown(chatId, lang);
  const { data, error } = await db.rpc('maestro_mirror_name', { p_tg_user_id: tgUserId, p_part: tidyNamePart(typed) });
  if (error) throw error;
  return mirrorReply(chatId, { lang: session.lang, ...(data ?? {}) }, fallbackLang);
}

async function mirrorKnown(chatId: number, tgUserId: string, knownBefore: boolean, fallbackLang: string) {
  const { data, error } = await db.rpc('maestro_mirror_known', { p_tg_user_id: tgUserId, p_known_before: knownBefore });
  if (error) throw error;
  return mirrorReply(chatId, data ?? {}, fallbackLang);
}

// ------------------------------------------------- the rating of a visit

type ReviewView = {
  ok?: boolean;
  error?: string;
  rated?: boolean;
  low?: boolean;
  review_id?: number;
  step?: number;
  lang?: string;
  quality?: number | null;
  service?: number | null;
  cleanliness?: number | null;
  comfort?: number | null;
  comment?: string | null;
  master_name?: string;
  master_name_uz?: string;
  client_name?: string | null;
  client_phone?: string | null;
  visit_date?: string;
};

function reviewMaster(view: ReviewView, lang: string) {
  return String(lang === 'uz' ? view.master_name_uz || view.master_name : view.master_name);
}

async function tellOwner(kind: 'low' | 'words', view: ReviewView) {
  await Promise.all((await ownerChats()).map((chatId) => send('staff', chatId, reviewOwnerNotice(kind, view))));
}

// Half an hour after a visit: the first of the four questions.
async function sendReviewInvites() {
  const { data, error } = await db.rpc('maestro_claim_review_invites', { p_limit: 20 });
  if (error) throw error;
  let sent = 0;
  for (const invite of data ?? []) {
    const lang = langOf(invite.lang);
    const result = await send('client', invite.tg_user_id, reviewQuestion({
      lang,
      master: lang === 'uz' ? invite.master_name_uz : invite.master_name,
      step: 1,
    }), { reply_markup: reviewKeyboard(invite.review_id, 1) });
    if (result.ok) {
      sent += 1;
      const messageId = (result.result as { message_id?: number } | undefined)?.message_id ?? null;
      await db.rpc('maestro_review_sent', { p_review_id: invite.review_id, p_message_id: messageId });
    } else if (String(result.description ?? '').startsWith('Forbidden')) {
      await db.rpc('maestro_review_unreachable', { p_review_id: invite.review_id });
    }
  }
  return { claimed: (data ?? []).length, sent };
}

// One tap: the next question in the same message, or after the fourth the
// scores and the offer of a few words.
async function reviewTap(query: Record<string, any>) {
  const [, reviewId, step, score] = String(query.data ?? '').split(':').map(Number);
  if (!reviewId || !step || !score) return;
  const { data, error } = await db.rpc('maestro_review_answer', {
    p_review_id: reviewId,
    p_tg_user_id: String(query.from.id),
    p_step: step,
    p_score: score,
  });
  if (error) throw error;
  const view = (data ?? {}) as ReviewView;
  // A second tap on a question already answered changes nothing.
  if (!view.ok) return;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const lang = langOf(view.lang);
  if (!view.rated) {
    return telegram('client', 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: reviewQuestion({ lang, master: reviewMaster(view, lang), step: Number(view.step) }),
      parse_mode: 'HTML',
      reply_markup: reviewKeyboard(reviewId, Number(view.step)),
    });
  }
  await telegram('client', 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: reviewSummary({ lang, quality: view.quality, service: view.service, cleanliness: view.cleanliness, comfort: view.comfort }),
    parse_mode: 'HTML',
  });
  // No «Без комментария»: offered a way out, nobody writes (owner, 2026-10-21).
  // Unanswered, the words are let go after a day; the scores stay.
  await send('client', chatId, botText(lang).reviewAskWords);
  if (view.low) await tellOwner('low', view);
}

async function reviewWords(chatId: number, tgUserId: string, typed: string, fallbackLang: string) {
  const { data, error } = await db.rpc('maestro_review_words', { p_tg_user_id: tgUserId, p_text: typed });
  if (error) throw error;
  const view = (data ?? {}) as ReviewView;
  const text = botText(langOf(view.lang || fallbackLang));
  if (!view.ok) {
    if (view.error === 'too_short') return send('client', chatId, text.reviewTooShort);
    return send('client', chatId, botText(fallbackLang).help(SITE));
  }
  await send('client', chatId, text.reviewWordsThanks);
  await tellOwner('words', view);
}

async function sendReminders() {
  const { data, error } = await db.rpc('maestro_claim_web_reminders', { p_limit: 25 });
  if (error) throw error;
  const notices = data ?? [];
  // Which bot each booking was confirmed with; one from before, @Maestro_uzbot.
  const ids = [...new Set(notices.map((notice: { appointment_id: string }) => String(notice.appointment_id)))];
  const botOf = new Map<string, Bot>();
  if (ids.length) {
    const bots = await db.from('appointments').select('id, booking_bot').in('id', ids);
    if (bots.error) throw bots.error;
    for (const row of bots.data ?? []) botOf.set(String(row.id), bookingBotOf(row.booking_bot) as Bot);
  }
  let sent = 0;
  for (const notice of notices) {
    const lang = langOf(notice.language);
    const text = botText(lang);
    const head = notice.kind === 'reminder_24h' ? text.reminder24 : text.reminder2;
    const lines = bookingLines({
      startsAt: notice.starts_at,
      masterName: notice.master_name,
      serviceName: notice.service_name,
      price: null,
    }, lang);
    const bot = botOf.get(String(notice.appointment_id)) ?? 'staff';
    const result = await send(bot, notice.telegram_chat_id, `${head}\n\n${lines}`, {
      reply_markup: cancelKeyboard(String(notice.appointment_id), lang),
    });
    if (result.ok) {
      sent += 1;
      await db.rpc('maestro_complete_appointment_notification', {
        p_notification_id: notice.notification_id,
        p_claim_token: notice.notification_claim_token,
      });
    } else {
      await db.rpc('maestro_fail_appointment_notification', {
        p_notification_id: notice.notification_id,
        p_claim_token: notice.notification_claim_token,
        p_error: String(result.description || 'send_failed').slice(0, 500),
      });
    }
  }
  return { claimed: notices.length, sent, masters: await sendMasterReminders() };
}

// A quarter of an hour after a booking ended still open, its master hears
// about it once, from @Maestro_uzbot: its «Открыть приложение» signs him in.
async function sendMasterReminders() {
  const { data, error } = await db.rpc('maestro_claim_master_reminders', { p_limit: 25 });
  if (error) throw error;
  let sent = 0;
  for (const notice of data ?? []) {
    if (!notice.master_chat_id) continue;
    const words = masterText(notice.master_lang);
    const result = await send('staff', notice.master_chat_id, masterReminder({
      startsAt: notice.starts_at,
      endsAt: notice.ends_at,
      clientName: notice.client_name,
      serviceName: notice.service_name,
      lang: notice.master_lang,
    }), {
      reply_markup: {
        inline_keyboard: [[
          { text: words.noShowButton, callback_data: `n:${notice.appointment_id}` },
          { text: words.openButton, web_app: { url: APP_URL } },
        ]],
      },
    });
    if (result.ok) sent += 1;
  }
  return { claimed: (data ?? []).length, sent };
}

async function handleService(action: string, input: Record<string, unknown>) {
  if (action === 'reminders') return reply({ ok: true, ...(await sendReminders()) });
  if (action === 'reviews') return reply({ ok: true, ...(await sendReviewInvites()) });
  const bot: Bot = input.bot === 'client' ? 'client' : 'staff';
  if (action === 'bot_info') {
    const me = await telegram(bot, 'getMe', {});
    const result = (me.result ?? {}) as Record<string, unknown>;
    return reply({ ok: me.ok, bot, username: result.username ?? null });
  }
  if (action === 'webhook_info') {
    const info = await telegram(bot, 'getWebhookInfo', {});
    const result = (info.result ?? {}) as Record<string, unknown>;
    return reply({
      ok: info.ok,
      bot,
      url: result.url ?? '',
      pending_update_count: result.pending_update_count ?? 0,
      last_error_message: result.last_error_message ?? null,
      ours: result.url === WEBHOOK_URL,
    });
  }
  if (action === 'set_webhook') {
    if (!WEBHOOK_SECRETS[bot]) return reply({ ok: false, error: 'no_webhook_secret', bot }, 500);
    // Never silently take over a webhook something else relies on.
    const info = await telegram(bot, 'getWebhookInfo', {});
    const current = String((info.result as Record<string, unknown> | undefined)?.url ?? '');
    if (current && current !== WEBHOOK_URL && input.force !== true) {
      return reply({ ok: false, error: 'webhook_exists', url: current }, 409);
    }
    const result = await telegram(bot, 'setWebhook', {
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRETS[bot],
      allowed_updates: ['message', 'callback_query'],
    });
    return reply({ ok: result.ok, bot, description: result.description ?? null });
  }
  if (action === 'set_profile') {
    // Only the clients' bot: @Maestro_uzbot's profile is the owner's.
    if (bot !== 'client') return reply({ ok: false, error: 'client_bot_only' }, 400);
    const results = [];
    for (const [lang, code] of [['ru', ''], ['uz', 'uz']] as const) {
      const words = CLIENT_BOT_PROFILE[lang];
      results.push(await telegram('client', 'setMyDescription', { description: words.description, language_code: code }));
      results.push(await telegram('client', 'setMyShortDescription', { short_description: words.short, language_code: code }));
    }
    return reply({ ok: results.every((result) => result.ok), refused: results.filter((result) => !result.ok).map((result) => result.description) });
  }
  return reply({ ok: false, error: 'unknown_action' }, 400);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return reply({ ok: false }, 405);

  if (request.headers.has('x-booking-cron-secret')) {
    if (!secretsMatch(request.headers.get('x-booking-cron-secret'), CRON_SECRET)) return reply({ ok: false }, 401);
    try {
      const input = await request.json().catch(() => ({})) as Record<string, unknown>;
      return await handleService(String(input.action ?? ''), input);
    } catch (error) {
      console.error('[booking-bot] service', error instanceof Error ? error.message : String(error));
      return reply({ ok: false, error: 'temporary_error' }, 500);
    }
  }

  const bot = webhookBot(request.headers.get('x-telegram-bot-api-secret-token'), WEBHOOK_SECRETS) as Bot | null;
  if (!bot) return reply({ ok: false }, 401);
  try {
    await handleUpdate(bot, await request.json());
  } catch (error) {
    // Telegram retries anything but 200; a broken update is logged, not replayed.
    console.error('[booking-bot] update', bot, error instanceof Error ? error.message : String(error));
  }
  return reply({ ok: true });
});
