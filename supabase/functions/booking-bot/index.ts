// booking-bot — the Telegram side of online booking.
//
// Telegram calls it as a webhook (header X-Telegram-Bot-Api-Secret-Token):
//   /start b_<token>  → the held booking, then «Поделиться номером» (or one
//                       button if this Telegram user's number is known)
//   contact           → only the user's own contact; confirms his latest hold
//   c:<id> / x:<id>   → confirm with the known number / cancel
//   n:<id>            → a master marks his booking «Не пришёл»
// pg_cron calls it with x-booking-cron-secret: {"action":"reminders"} sends the
// clients' 24 h and 2 h reminders and the masters' «закройте запись» half an
// hour into an open booking; {"action":"webhook_info"} and {"action":"set_webhook"}
// manage the webhook without the bot token ever leaving the server.
import {
  bookingLines,
  botText,
  langOf,
  MASTER_REPLIES,
  maskPhone,
  masterReminder,
  staffNotice,
} from '../_shared/bookingCore.js';
import { bookingSettings, db, tokenHash } from '../_shared/bookingHttp.ts';
import { maskPhoneForStaff } from '../_shared/access.js';

const BOT_TOKEN = Deno.env.get('BOT_TOKEN') || '';
const WEBHOOK_SECRET = Deno.env.get('BOOKING_BOT_WEBHOOK_SECRET') || '';
const CRON_SECRET = Deno.env.get('BOOKING_CRON_SECRET') || '';
const SITE = Deno.env.get('BOOKING_SITE_URL') || 'https://maestro-booking.vercel.app';
const ADMIN_CHAT = Deno.env.get('BOOKING_ADMIN_CHAT_ID') || '';
const APP_URL = Deno.env.get('MAESTRO_APP_URL') || 'https://maestro-pied-two.vercel.app';
const WEBHOOK_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/booking-bot`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretsMatch(actual: string | null, expected: string) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function telegram(method: string, body: Record<string, unknown>) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
    if (!result.ok) console.warn('[booking-bot] telegram refused', method, result.description);
    return result as { ok: boolean; description?: string; result?: unknown };
  } catch (error) {
    console.warn('[booking-bot] telegram unreachable', method, String(error));
    return { ok: false, description: 'unreachable' };
  }
}

function send(chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
  return telegram('sendMessage', {
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

// The master in person, if he ever opened the bot, and the administrators'
// group. The group calls clients and reads the number whole; the master gets
// it masked, as everywhere he sees it. A failed delivery is logged and never
// stops the client's answer.
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
  await Promise.all([
    ADMIN_CHAT && ADMIN_CHAT !== masterChat ? send(ADMIN_CHAT, textWith(phone)) : null,
    masterChat ? send(masterChat, textWith(maskPhoneForStaff(phone) || '')) : null,
  ]);
}

async function confirm(appointmentId: string, tgUserId: string, phone: string | null, username: string | null, chatId: number, fallbackLang: string) {
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
    if (code === 'expired') return send(chatId, text.expired(SITE), { reply_markup: { remove_keyboard: true } });
    if (code === 'client_blocked') {
      const settings = await bookingSettings();
      return send(chatId, text.blocked(settings.salon_phone || ''), { reply_markup: { remove_keyboard: true } });
    }
    if (code === 'forbidden') return send(chatId, text.notYours);
    if (code === 'not_found') return send(chatId, text.notFound(SITE));
    if (code === 'invalid_phone') return send(chatId, text.foreignContact);
    return send(chatId, text.error);
  }
  if (data.already_confirmed) return send(chatId, text.already);

  const settings = await bookingSettings();
  const address = lang === 'uz' ? (settings.salon_address_uz || settings.salon_address_ru) : settings.salon_address_ru;
  await send(chatId, `${text.confirmed}\n\n${linesOf(data, lang)}\n\n${text.address(address || '')}`, {
    reply_markup: cancelKeyboard(String(data.appointment_id), lang),
  });
  await notifyStaff('created', data);
}

async function handleStart(chatId: number, tgUserId: string, token: string, fallbackLang: string) {
  const { data, error } = await db.rpc('maestro_booking_for_bot', {
    p_token_hash: await tokenHash(token),
    p_appointment_id: null,
    p_tg_user_id: tgUserId,
  });
  if (error) throw error;
  if (!data?.ok) return send(chatId, botText(fallbackLang).notFound(SITE));

  const lang = langOf(data.lang);
  const text = botText(lang);
  const status = data.booking.status;
  if (status === 'expired') return send(chatId, text.expired(SITE));
  if (status === 'cancelled') return send(chatId, text.cancelledBefore(SITE));
  if (status === 'confirmed') {
    if (!data.mine) return send(chatId, text.notYours);
    return send(chatId, `${text.already}\n\n${linesOf(data, lang)}`, {
      reply_markup: cancelKeyboard(String(data.appointment_id), lang),
    });
  }

  const head = `<b>${text.title}</b>\n\n${linesOf(data, lang)}`;
  if (data.known_phone) {
    // A returning client: one button, no contact again.
    return send(chatId, `${head}\n\n${text.knownNumber(maskPhone(data.known_phone))}`, {
      reply_markup: { inline_keyboard: [[{ text: text.confirmButton, callback_data: `c:${data.appointment_id}` }]] },
    });
  }
  return send(chatId, `${head}\n\n${text.askContact}`, {
    reply_markup: {
      keyboard: [[{ text: text.shareButton, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function handleContact(message: Record<string, any>) {
  const chatId = message.chat.id;
  const tgUserId = String(message.from.id);
  const fallbackLang = langOf(message.from.language_code);
  // Only the user's own number: a contact forwarded from the address book
  // carries someone else's user_id, or none.
  if (String(message.contact?.user_id ?? '') !== tgUserId) {
    return send(chatId, botText(fallbackLang).foreignContact);
  }
  const { data: appointmentId, error } = await db.rpc('maestro_latest_hold_for_telegram', { p_tg_user_id: tgUserId });
  if (error) throw error;
  if (!appointmentId) {
    return send(chatId, botText(fallbackLang).noHold(SITE), { reply_markup: { remove_keyboard: true } });
  }
  return confirm(String(appointmentId), tgUserId, String(message.contact.phone_number ?? ''), message.from.username ?? null, chatId, fallbackLang);
}

async function handleCallback(query: Record<string, any>) {
  await telegram('answerCallbackQuery', { callback_query_id: query.id });
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  const tgUserId = String(query.from.id);
  const fallbackLang = langOf(query.from.language_code);
  const [kind, appointmentId] = String(query.data ?? '').split(':');
  if (!UUID.test(appointmentId ?? '')) return;

  if (kind === 'c') {
    await confirm(appointmentId, tgUserId, null, query.from.username ?? null, chatId, fallbackLang);
    return;
  }
  if (kind === 'n') return masterNoShow(appointmentId, tgUserId, chatId, query.message?.message_id);
  if (kind !== 'x') return;

  const { data, error } = await db.rpc('maestro_cancel_booking_by_client', {
    p_appointment_id: appointmentId,
    p_tg_user_id: tgUserId,
  });
  if (error) throw error;
  const text = botText(data?.lang || fallbackLang);
  if (!data?.ok) {
    if (data?.error === 'too_late') return send(chatId, text.tooLate);
    if (data?.error === 'forbidden') return send(chatId, text.notYours);
    return send(chatId, text.notFound(SITE));
  }
  // The button under the old message no longer means anything.
  if (query.message?.message_id) {
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
  if (data.already_cancelled) return send(chatId, text.cancelled(SITE));
  await send(chatId, text.cancelled(SITE));
  await notifyStaff('cancelled', data);
}

// «Не пришёл» under a master's reminder: the same outcome as in the app, with
// the master as the actor, so only the booking's own master gets through.
async function masterNoShow(appointmentId: string, tgUserId: string, chatId: number, messageId?: number) {
  const { data: user, error: userError } = await db.from('app_users')
    .select('id').eq('telegram_id', tgUserId).eq('active', true).maybeSingle();
  if (userError) throw userError;
  if (!user) return send(chatId, MASTER_REPLIES.notYours);
  const { data, error } = await db.rpc('maestro_set_appointment_outcome', {
    p_appointment_id: appointmentId,
    p_outcome: 'no_show',
    p_cancelled_by: null,
    p_reason_code: 'no_show_no_notice',
    p_reason_note: null,
    p_actor_user_id: user.id,
  });
  if (error) throw error;
  if (data?.error === 'forbidden') return send(chatId, MASTER_REPLIES.notYours);
  if (messageId) {
    await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }
  return send(chatId, data?.ok ? MASTER_REPLIES.noShow : MASTER_REPLIES.closed);
}

async function handleUpdate(update: Record<string, any>) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const message = update.message;
  if (!message || !message.from) return;
  // A group is only ever written to, except /chatid: it answers with the
  // group's id, which BOOKING_ADMIN_CHAT_ID needs.
  if (message.chat?.type !== 'private') {
    if (/^\/chatid(@\w+)?\s*$/.test(String(message.text ?? ''))) {
      return send(message.chat.id, `chat_id: <code>${message.chat.id}</code>`);
    }
    return;
  }
  if (message.contact) return handleContact(message);

  const fallbackLang = langOf(message.from.language_code);
  const start = String(message.text ?? '').match(/^\/start(?:@\w+)?\s+b_([A-Za-z0-9_-]{22,40})\s*$/);
  if (start) return handleStart(message.chat.id, String(message.from.id), start[1], fallbackLang);
  return send(message.chat.id, botText(fallbackLang).help(SITE));
}

async function sendReminders() {
  const { data, error } = await db.rpc('maestro_claim_web_reminders', { p_limit: 25 });
  if (error) throw error;
  let sent = 0;
  for (const notice of data ?? []) {
    const lang = langOf(notice.language);
    const text = botText(lang);
    const head = notice.kind === 'reminder_24h' ? text.reminder24 : text.reminder2;
    const lines = bookingLines({
      startsAt: notice.starts_at,
      masterName: notice.master_name,
      serviceName: notice.service_name,
      price: null,
    }, lang);
    const result = await send(notice.telegram_chat_id, `${head}\n\n${lines}`, {
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
  return { claimed: (data ?? []).length, sent, masters: await sendMasterReminders() };
}

// Half an hour into a booking still open, its master hears about it once.
async function sendMasterReminders() {
  const { data, error } = await db.rpc('maestro_claim_master_reminders', { p_limit: 25 });
  if (error) throw error;
  let sent = 0;
  for (const notice of data ?? []) {
    if (!notice.master_chat_id) continue;
    const result = await send(notice.master_chat_id, masterReminder({
      startsAt: notice.starts_at,
      clientName: notice.client_name,
      serviceName: notice.service_name,
    }), {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Не пришёл', callback_data: `n:${notice.appointment_id}` },
          { text: 'Открыть приложение', web_app: { url: APP_URL } },
        ]],
      },
    });
    if (result.ok) sent += 1;
  }
  return { claimed: (data ?? []).length, sent };
}

async function handleService(action: string, input: Record<string, unknown>) {
  if (action === 'reminders') return reply({ ok: true, ...(await sendReminders()) });
  if (action === 'webhook_info') {
    const info = await telegram('getWebhookInfo', {});
    const result = (info.result ?? {}) as Record<string, unknown>;
    return reply({ ok: info.ok, url: result.url ?? '', pending_update_count: result.pending_update_count ?? 0, ours: result.url === WEBHOOK_URL });
  }
  if (action === 'set_webhook') {
    // Never silently take over a webhook something else relies on.
    const info = await telegram('getWebhookInfo', {});
    const current = String((info.result as Record<string, unknown> | undefined)?.url ?? '');
    if (current && current !== WEBHOOK_URL && input.force !== true) {
      return reply({ ok: false, error: 'webhook_exists', url: current }, 409);
    }
    const result = await telegram('setWebhook', {
      url: WEBHOOK_URL,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
    });
    return reply({ ok: result.ok, description: result.description ?? null });
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

  if (!secretsMatch(request.headers.get('x-telegram-bot-api-secret-token'), WEBHOOK_SECRET)) {
    return reply({ ok: false }, 401);
  }
  try {
    await handleUpdate(await request.json());
  } catch (error) {
    // Telegram retries anything but 200; a broken update is logged, not replayed.
    console.error('[booking-bot] update', error instanceof Error ? error.message : String(error));
  }
  return reply({ ok: true });
});
