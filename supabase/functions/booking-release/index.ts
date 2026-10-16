// POST /booking-release — the client changed his mind before confirming in
// Telegram, and the time goes back (Maestro-Booking/docs/API_CONTRACT.md §5).
import { TOKEN_PATTERN } from '../_shared/bookingCore.js';
import { allowRead, answer, db, fail, preflight, readJson, tokenHash } from '../_shared/bookingHttp.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 'invalid_request');

  try {
    const input = await readJson(request);
    const token = String(input?.token ?? '');
    if (!TOKEN_PATTERN.test(token)) return fail(request, 'invalid_request');
    if (!await allowRead(request)) return fail(request, 'rate_limited');

    const { data, error } = await db.rpc('maestro_release_booking', { p_token_hash: await tokenHash(token) });
    if (error) throw error;
    if (!data?.ok) return fail(request, String(data?.error || 'temporary_error'));
    return answer(request, { ok: true });
  } catch (error) {
    console.error('[booking-release]', error instanceof Error ? error.message : String(error));
    return fail(request, 'temporary_error');
  }
});
