// POST /booking-hold — takes the chosen time for ten minutes while the client
// confirms in Telegram (Maestro-Booking/docs/API_CONTRACT.md §3). The phone is
// not asked here: the bot takes it from the client's own Telegram contact.
import { bookingForPage, isZonedMoment, telegramStartUrl } from '../_shared/bookingCore.js';
import {
  answer,
  callerHash,
  db,
  fail,
  preflight,
  randomToken,
  readJson,
  telegramBotUsername,
  tokenHash,
} from '../_shared/bookingHttp.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 'invalid_request');

  try {
    const input = await readJson(request);
    if (!input) return fail(request, 'invalid_request');

    const serviceIds = Array.isArray(input.service_ids)
      ? input.service_ids.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const masterId = input.master_id == null ? null : Number(input.master_id);
    const startsAt = String(input.starts_at ?? '');
    const clientName = String(input.client_name ?? '').trim();
    const comment = String(input.comment ?? '').trim();
    if (!serviceIds.length || serviceIds.length > 10 || serviceIds.some((id) => id.length > 80)
      || (masterId !== null && (!Number.isSafeInteger(masterId) || masterId <= 0))
      || !isZonedMoment(startsAt)
      || !clientName || clientName.length > 60 || comment.length > 300) {
      return fail(request, 'invalid_request');
    }

    const token = randomToken();
    const { data, error } = await db.rpc('maestro_hold_booking', {
      p_token_hash: await tokenHash(token),
      p_service_ids: serviceIds,
      p_master_id: masterId,
      p_starts_at: startsAt,
      p_client_name: clientName,
      p_comment: comment,
      p_lang: input.lang === 'uz' ? 'uz' : 'ru',
      p_ip_hash: await callerHash(request),
    });
    if (error) throw error;
    if (!data?.ok) return fail(request, String(data?.error || 'temporary_error'));

    return answer(request, {
      ok: true,
      booking: bookingForPage(data.booking, token),
      telegram_url: telegramStartUrl(telegramBotUsername(), token),
    });
  } catch (error) {
    console.error('[booking-hold]', error instanceof Error ? error.message : String(error));
    return fail(request, 'temporary_error');
  }
});
