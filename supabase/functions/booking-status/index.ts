// GET /booking-status?token=… — where a booking stands while the client
// confirms in Telegram (Maestro-Booking/docs/API_CONTRACT.md §4). The page
// polls it every three seconds.
import { bookingForPage, telegramStartUrl, TOKEN_PATTERN } from '../_shared/bookingCore.js';
import { allowRead, answer, db, fail, preflight, telegramBotUsername, tokenHash } from '../_shared/bookingHttp.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'GET') return fail(request, 'invalid_request');

  try {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    if (!TOKEN_PATTERN.test(token)) return fail(request, 'invalid_request');
    if (!await allowRead(request)) return fail(request, 'rate_limited');

    const { data, error } = await db.rpc('maestro_booking_by_token', { p_token_hash: await tokenHash(token) });
    if (error) throw error;
    if (!data?.ok) return fail(request, String(data?.error || 'not_found'));

    const booking = bookingForPage(data.booking, token);
    return answer(request, {
      ok: true,
      booking,
      telegram_url: booking.status === 'held' ? telegramStartUrl(telegramBotUsername(), token) : null,
    });
  } catch (error) {
    console.error('[booking-status]', error instanceof Error ? error.message : String(error));
    return fail(request, 'temporary_error');
  }
});
