// What every public booking function shares: the database client, answers
// with CORS for the page's own origins only, the caller's hashed address and
// the per-address rate limit. The contract is Maestro-Booking/docs/API_CONTRACT.md.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.2';
import { corsHeaders, parseOrigins } from './bookingCore.js';

export const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const ALLOWED_ORIGINS = parseOrigins(Deno.env.get('BOOKING_SITE_ORIGINS'));

export function cors(request: Request) {
  return corsHeaders(request.headers.get('origin'), ALLOWED_ORIGINS);
}

export function answer(request: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// The contract's error codes, with the status each one travels under.
const STATUS_OF: Record<string, number> = {
  invalid_request: 400,
  unknown_service: 404,
  unknown_master: 404,
  date_out_of_range: 400,
  slot_taken: 409,
  rate_limited: 429,
  not_found: 404,
  temporary_error: 500,
};

export function fail(request: Request, code: string) {
  const known = code in STATUS_OF ? code : 'temporary_error';
  return answer(request, { ok: false, error: known }, STATUS_OF[known]);
}

export function preflight(request: Request) {
  const headers = cors(request);
  return new Response(null, { status: headers['Access-Control-Allow-Origin'] ? 204 : 403, headers });
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function tokenHash(token: string) {
  return sha256Hex(`booking-token:${token}`);
}

// Only a salted hash of the caller's address is ever stored.
export function callerHash(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const address = forwarded || request.headers.get('cf-connecting-ip') || 'unknown';
  return sha256Hex(`${Deno.env.get('BOOKING_IP_SALT') || 'maestro'}:${address}`);
}

// Reads are generous (the page polls a booking every 3 seconds); a hold has
// its own, stricter limits inside maestro_hold_booking.
export async function allowRead(request: Request) {
  const { data, error } = await db.rpc('maestro_booking_rate_hit', {
    p_ip_hash: await callerHash(request),
    p_action: 'read',
    p_limit: 600,
    p_window: '10 minutes',
  });
  if (error) {
    console.error('[booking] rate limit check failed', error.message);
    return true;
  }
  return data !== false;
}

export function randomToken() {
  // 24 random bytes are 32 characters of base64url: inside the contract's
  // 22–40 and Telegram's 64-character start parameter.
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function readJson(request: Request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 8192) return null;
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function bookingSettings() {
  const { data, error } = await db.from('settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data ?? {};
}

export function telegramBotUsername() {
  return Deno.env.get('BOOKING_BOT_USERNAME') || 'Maestro_uzbot';
}
