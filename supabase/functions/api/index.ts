// Pinned like the other functions: an unpinned major let a redeploy change the
// shape of error objects without a single line of code changing.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.2';
import { auditedDeleteResponse } from './deleteAudit.js';
import { captureEdgeException } from '../_shared/sentry.ts';
import { masterBookingNotice, masterText } from '../_shared/bookingCore.js';
import { checkClientName, checkLastName } from '../_shared/clientName.js';
import { latestScanPerClient, MIRROR_SCAN_HOURS } from '../_shared/mirror.js';
import {
  ADMIN_ROLE,
  adminMayCall,
  expenseForPartner,
  maskPhoneForStaff,
  partnerMayCall,
  PARTNER_ROLE,
  seesFullPhones,
  stockForDesk,
} from '../_shared/access.js';

const BOT_TOKEN = Deno.env.get('BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('MAESTRO_APP_URL') || 'https://maestro-pied-two.vercel.app';
const TELEGRAM_OAUTH_CLIENT_ID = Deno.env.get('TELEGRAM_OAUTH_CLIENT_ID') || '8865126796';
const TELEGRAM_LOGIN_CLIENT_SECRET = Deno.env.get('TELEGRAM_LOGIN_CLIENT_SECRET') || '';
const TELEGRAM_ISSUER = 'https://oauth.telegram.org';

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const PAGE_SIZE = 1000;

function tashkentDate(offsetDays = 0) {
  const date = new Date(Date.now() + 5 * 60 * 60 * 1000);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function tashkentTime() {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Zero-padded 24-hour HH:MM, so two times compare correctly as strings.
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// A single haircut cannot cost this much. The ceiling exists so a stray extra
// digit is rejected at the door instead of skewing every report behind it.
const MAX_SALE_AMOUNT = 100_000_000;

function isValidIsoDate(value: unknown) {
  const text = String(value ?? '');
  if (!ISO_DATE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey',
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

async function fetchAllRows(
  table: string,
  orderColumn: string,
  filters: Record<string, string | number> = {},
  dateBound: { column: string; since: string } | null = null,
) {
  const rows: Record<string, unknown>[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from(table).select('*');
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    // Callers pass a bound only for tables that grow without limit. Rows older
    // than it are already on the client from the unbounded first load.
    if (dateBound) query = query.gte(dateBound.column, dateBound.since);

    let orderedQuery = query.order(orderColumn, { ascending: true });
    if (orderColumn !== 'id') {
      orderedQuery = orderedQuery.order('id', { ascending: true });
    }

    const { data, error } = await orderedQuery.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;

    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

// The stock tables arrive with their own migration. Until it has run, a missing
// table must cost the app its Склад screen, not the whole load.
async function fetchStockRows(table: string, orderColumn: string) {
  try {
    return await fetchAllRows(table, orderColumn);
  } catch (error) {
    const code = String((error as { code?: string })?.code || '');
    if (code === '42P01' || code === 'PGRST205') return [];
    throw error;
  }
}

// Bookings with what their cards show about the client. The hold's token,
// address and Telegram ids never leave the server; for a master the number is
// masked.
async function fetchAppointments(filters: Record<string, string | number> = {}, maskPhones = false) {
  const rows: Record<string, unknown>[] = [];
  const fromDate = `${tashkentDate(-60)}T00:00:00+05:00`;
  const toDate = `${tashkentDate(180)}T00:00:00+05:00`;

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from('appointments').select('*, client:clients(lifecycle_status, known_before, last_name)');
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query
      .gte('starts_at', fromDate)
      .lt('starts_at', toDate)
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []).map((row) => {
      const client = Array.isArray(row.client) ? row.client[0] : row.client;
      const {
        client: _privateClient,
        booking_token_hash: _token,
        booking_ip_hash: _address,
        booking_tg_user_id: _telegram,
        ...appointment
      } = row;
      return {
        ...appointment,
        client_phone: maskPhones ? maskPhoneForStaff(appointment.client_phone as string | null) : appointment.client_phone,
        client_is_blocked: client?.lifecycle_status === 'blocked',
        client_known_before: client?.known_before === true,
        client_needs_surname: Boolean(client) && !client.last_name,
        client_visit_count: 0,
      };
    }));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  if (clientIds.length) {
    const { data: counts, error } = await sb.rpc('maestro_clients_visit_counts', { p_client_ids: clientIds });
    if (!error) {
      const byClient = new Map((counts ?? []).map((row: { client_id: string; visit_count: number }) => [row.client_id, Number(row.visit_count)]));
      for (const row of rows) row.client_visit_count = byClient.get(row.client_id as string) ?? 0;
    }
  }
  return rows;
}

async function hmac(keyData: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

const toHex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');

async function tokenHash(token: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

function newSessionToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as T;
}

let telegramJwksCache: { keys: JsonWebKey[] } | null = null;

async function getTelegramJwks() {
  if (telegramJwksCache) return telegramJwksCache;
  const response = await fetch(`${TELEGRAM_ISSUER}/.well-known/jwks.json`);
  if (!response.ok) throw new Error('telegram_jwks_unavailable');
  telegramJwksCache = await response.json();
  return telegramJwksCache;
}

async function verifyTelegramIdToken(idToken: string): Promise<Record<string, unknown>> {
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error('invalid_id_token');

  const header = decodeJwtPart<{ alg?: string; kid?: string }>(encodedHeader);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unsupported_id_token_alg');

  const jwks = await getTelegramJwks();
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error('telegram_jwk_not_found');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error('invalid_id_token_signature');

  const payload = decodeJwtPart<Record<string, unknown>>(encodedPayload);
  if (payload.iss !== TELEGRAM_ISSUER) throw new Error('invalid_id_token_issuer');
  if (String(payload.aud) !== TELEGRAM_OAUTH_CLIENT_ID) throw new Error('invalid_id_token_audience');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('expired_id_token');

  return payload;
}

async function exchangeTelegramOAuthCode(payload: Record<string, string>) {
  if (!TELEGRAM_LOGIN_CLIENT_SECRET) throw new Error('telegram_oauth_not_configured');
  if (!payload?.code || !payload?.codeVerifier || !payload?.redirectUri) throw new Error('invalid_oauth_payload');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: payload.code,
    redirect_uri: payload.redirectUri,
    client_id: TELEGRAM_OAUTH_CLIENT_ID,
    code_verifier: payload.codeVerifier,
  });

  const tokenResponse = await fetch(`${TELEGRAM_ISSUER}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${TELEGRAM_OAUTH_CLIENT_ID}:${TELEGRAM_LOGIN_CLIENT_SECRET}`)}`,
    },
    body,
  });
  const tokenResult = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenResult.id_token) {
    console.error('[maestro-api] telegram oauth token exchange failed', {
      status: tokenResponse.status,
      error: tokenResult.error || tokenResult.error_description || 'token_exchange_failed',
    });
    throw new Error('telegram_oauth_exchange_failed');
  }

  const verifiedToken = await verifyTelegramIdToken(String(tokenResult.id_token));
  const telegramId = verifiedToken.id ?? verifiedToken.sub;
  if (!telegramId) throw new Error('telegram_oauth_missing_user_id');

  return { id: String(telegramId), first_name: verifiedToken.given_name ? String(verifiedToken.given_name) : undefined };
}

// Telegram credentials carry the moment they were issued. Without this check a
// blob captured once (a shared phone, a browser backup, the query string the
// widget redirect leaves in history) authenticates forever.
const TELEGRAM_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;

function authDateIsFresh(value: unknown) {
  const authDate = Number(value);
  if (!Number.isFinite(authDate) || authDate <= 0) return false;
  const ageSeconds = Date.now() / 1000 - authDate;
  return ageSeconds >= -300 && ageSeconds <= TELEGRAM_AUTH_MAX_AGE_SECONDS;
}

async function verifyMiniApp(initData: string): Promise<{ id: number; first_name?: string } | null> {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    if (!authDateIsFresh(params.get('auth_date'))) return null;

    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = await hmac(new TextEncoder().encode('WebAppData'), BOT_TOKEN);
    const computed = await hmac(secretKey, dataCheckString);
    if (toHex(computed) !== hash) return null;

    const user = params.get('user');
    return user ? JSON.parse(user) : null;
  } catch {
    return null;
  }
}

async function verifyWidget(auth: Record<string, unknown>): Promise<{ id: number; first_name?: string } | null> {
  try {
    if (!auth || !auth.hash) return null;
    if (!authDateIsFresh(auth.auth_date)) return null;

    const hash = String(auth.hash);
    const dataCheckString = Object.keys(auth)
      .filter((key) => key !== 'hash')
      .sort()
      .map((key) => `${key}=${auth[key]}`)
      .join('\n');
    const secretKey = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(BOT_TOKEN)));
    const computed = await hmac(secretKey, dataCheckString);
    if (toHex(computed) !== hash) return null;

    return {
      id: Number(auth.id),
      first_name: auth.first_name ? String(auth.first_name) : undefined,
    };
  } catch {
    return null;
  }
}

// Work that must not hold up the answer (a Telegram message): the runtime
// keeps the worker alive for it after the response has gone.
function inBackground(work: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  const guarded = work.catch((error) => console.warn('[maestro-api] background work failed', String(error)));
  if (runtime?.waitUntil) runtime.waitUntil(guarded);
}

function escapeHtml(text: unknown) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Messages to the owner through the same bot the app signs in with.
async function messageOwners(text: string) {
  const { data } = await sb.from('app_users').select('telegram_id').eq('role', 'owner').eq('active', true);
  await Promise.all((data ?? [])
    .filter((owner: { telegram_id: number | null }) => owner.telegram_id)
    .map((owner: { telegram_id: number }) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: owner.telegram_id, text, parse_mode: 'HTML' }),
    })));
}

// A master's Telegram chat and language: his own login, or the id the masters
// table kept from before logins.
async function masterChat(masterId: number) {
  const login = await sb.from('app_users').select('telegram_id, lang')
    .eq('master_id', masterId).eq('active', true).not('telegram_id', 'is', null).limit(1).maybeSingle();
  if (login.data?.telegram_id) return { chatId: String(login.data.telegram_id), lang: String(login.data.lang || 'ru') };
  const master = await sb.from('masters').select('telegram_id').eq('id', masterId).maybeSingle();
  return master.data?.telegram_id ? { chatId: String(master.data.telegram_id), lang: 'ru' } : null;
}

type BookingNoticeRow = {
  master_id: number | string;
  starts_at: string;
  client_name: string;
  client_phone: string | null;
  service_name: string | null;
};

// A booking taken, cancelled or moved by the desk reaches its master at once,
// with a button into the app where it sits in «Мои записи».
async function tellMaster(masterId: number, kind: 'new' | 'cancelled' | 'moved' | 'away', appointment: BookingNoticeRow, previousStartsAt: string | null = null) {
  const chat = await masterChat(masterId);
  if (!chat) return;
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat.chatId,
      text: masterBookingNotice({
        kind,
        lang: chat.lang,
        startsAt: appointment.starts_at,
        previousStartsAt,
        clientName: appointment.client_name,
        clientPhone: maskPhoneForStaff(appointment.client_phone),
        serviceName: appointment.service_name,
      }),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: masterText(chat.lang).openButton, web_app: { url: APP_URL } }]] },
    }),
  });
  if (!response.ok) console.warn('[maestro-api] booking notice refused', response.status, await response.text());
}

async function tellMasterAboutBooking(appointmentId: string) {
  const { data: appointment } = await sb.from('appointments')
    .select('master_id, starts_at, client_name, client_phone, service_name')
    .eq('id', appointmentId).maybeSingle();
  if (appointment) await tellMaster(Number(appointment.master_id), 'new', appointment);
}

// The attendance sheet names a master; the fines are keyed by his id.
async function masterIdFor(name: string) {
  const { data } = await sb.from('masters').select('id').eq('name', name).maybeSingle();
  return data?.id ? Number(data.id) : null;
}

function formatSum(value: number) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

type ClientRow = {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
  known_before: boolean;
  lifecycle_status?: string;
};
const CLIENT_COLUMNS = 'id, full_name, first_name, last_name, phone_e164, known_before, lifecycle_status';
// What a visit of a guest without a name shows where a client's name stands.
const GUEST_NAME = 'Гость без имени';

// A client as the caller may see him: the number whole for the owner, the
// administrator and the partner, masked for a master.
function clientForCaller(client: ClientRow & { visit_count?: number; last_visit?: string | null; last_master?: string | null }, fullPhone: boolean) {
  return {
    id: client.id,
    full_name: client.full_name,
    first_name: client.first_name ?? null,
    last_name: client.last_name ?? null,
    // A card from before the two parts (2026-10-21): the next visit adds it.
    needs_surname: !client.last_name,
    phone: fullPhone ? client.phone_e164 : maskPhoneForStaff(client.phone_e164),
    has_phone: Boolean(client.phone_e164),
    known_before: client.known_before === true,
    blocked: client.lifecycle_status === 'blocked',
    visit_count: Number(client.visit_count ?? 0),
    last_visit: client.last_visit ?? null,
    last_master: client.last_master ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const requestId = crypto.randomUUID();
  let monitoredAction = 'unknown';
  let monitoredRole = 'unauthenticated';

  try {
    const { initData, tgAuth, sessionToken, action, payload = {} } = await req.json();
    monitoredAction = typeof action === 'string' ? action : 'unknown';
    let appUserResult;
    let issuedSessionToken: string | null = null;

    if (action === 'telegramOAuth') {
      const user = await exchangeTelegramOAuthCode(payload);
      appUserResult = await sb
        .from('app_users')
        .select('id, role, master_id, active, lang')
        .eq('telegram_id', user.id)
        .maybeSingle();
      if (appUserResult.error) return json({ error: appUserResult.error.message }, 500);
      if (!appUserResult.data || !appUserResult.data.active) return json({ error: 'not_in_list' }, 403);

      issuedSessionToken = newSessionToken();
      await sb.from('app_sessions').insert({
        user_id: appUserResult.data.id,
        token_hash: await tokenHash(issuedSessionToken),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      return json({ ok: true, sessionToken: issuedSessionToken });
    }

    if (sessionToken) {
      const session = await sb
        .from('app_sessions')
        .select('user_id')
        .eq('token_hash', await tokenHash(String(sessionToken)))
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (!session.error && session.data) {
        appUserResult = await sb
          .from('app_users')
          .select('id, role, master_id, active, lang')
          .eq('id', session.data.user_id)
          .maybeSingle();
      }
    }

    if (!appUserResult) {
      let user = await verifyMiniApp(initData || '');
      if (!user && tgAuth) user = await verifyWidget(tgAuth);
      if (!user) {
        // The LoginGate renders this string verbatim, so an on-site failure
        // photo tells us whether Telegram data was absent or failed its
        // signature check. Keep the "unauthorized" prefix: the client's
        // substring match on it is what routes users to the login screen.
        const reason = initData
          ? 'unauthorized_bad_signature'
          : tgAuth
            ? 'unauthorized_bad_widget_auth'
            : 'unauthorized_no_telegram_data';
        console.log('[maestro-api] rejected login', {
          reason,
          hasSessionToken: Boolean(sessionToken),
        });
        return json({ error: reason }, 401);
      }
      appUserResult = await sb
        .from('app_users')
        .select('id, role, master_id, active, lang')
        .eq('telegram_id', user.id)
        .maybeSingle();
      if (!appUserResult.error && appUserResult.data) {
        issuedSessionToken = newSessionToken();
        await sb.from('app_sessions').insert({
          user_id: appUserResult.data.id,
          token_hash: await tokenHash(issuedSessionToken),
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        });
      }
    }
    if (appUserResult.error) return json({ error: appUserResult.error.message }, 500);
    if (!appUserResult.data || !appUserResult.data.active) return json({ error: 'not_in_list' }, 403);
    monitoredRole = String(appUserResult.data.role || 'unknown');

    console.log('[maestro-api] authorized action', { action, role: appUserResult.data.role });

    // isAdmin is the read gate for the salon's figures: the owner and a
    // bookkeeper. The role named 'admin' is the front-desk administrator and is
    // deliberately not in it (see isFrontDesk below).
    const isAdmin = ['owner', 'finance'].includes(appUserResult.data.role);
    const canManageCalendar = appUserResult.data.role === 'owner';
    const canManageClients = appUserResult.data.role === 'owner';
    // Approving a master's sale and rewriting salon settings are owner
    // decisions, and a bookkeeper should not inherit them just because he needs
    // to see the numbers.
    const canApproveSales = appUserResult.data.role === 'owner';
    const canEditSettings = appUserResult.data.role === 'owner';
    // A partner reads and never writes; the administrator sells goods and
    // nothing more. What each may ask for is listed in _shared/access.js, and
    // every other action stops here.
    const isPartner = appUserResult.data.role === PARTNER_ROLE;
    if (isPartner && !partnerMayCall(action)) return json({ error: 'forbidden' }, 403);
    const isFrontDesk = appUserResult.data.role === ADMIN_ROLE;
    if (isFrontDesk && !adminMayCall(action)) return json({ error: 'forbidden' }, 403);
    let myMaster: string | null = null;
    let myMasterId: number | null = null;
    let myMasterPct: number | null = null;
    if (appUserResult.data.master_id) {
      const masterMatch = await sb
        .from('masters')
        .select('name, pct, active')
        .eq('id', appUserResult.data.master_id)
        .maybeSingle();
      if (masterMatch.error) return json({ error: masterMatch.error.message }, 500);
      if (masterMatch.data?.active) {
        myMaster = masterMatch.data.name;
        myMasterId = Number(appUserResult.data.master_id);
        myMasterPct = Number(masterMatch.data.pct);
      }
    }

    if (!isAdmin && !isPartner && !isFrontDesk && !myMaster) return json({ error: 'not_in_list' }, 403);

    if (action === 'listAuditEvents') {
      if (appUserResult.data.role !== 'owner') return json({ error: 'forbidden' }, 403);

      const limit = Math.min(Math.max(Math.trunc(Number(payload.limit) || 50), 1), 100);
      const cursor = String(payload.cursor || '').trim();
      let query = sb
        .from('audit_events')
        .select('id,occurred_at,entity_type,entity_id,operation,event_name,actor_user_id,actor_name,actor_role,actor_external_id,source,correlation_id,changed_fields,old_values,new_values,metadata')
        .eq('operation', 'delete')
        .in('entity_type', ['fine', 'expense', 'debt', 'debt_payment', 'sale', 'attendance', 'product_receipts', 'product_sales', 'product_writeoffs', 'master_advances', 'master_payouts'])
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (/^\d+$/.test(cursor)) query = query.lt('id', cursor);

      const { data: rows, error } = await query;
      if (error) return json({ error: error.message }, 500);
      const events = (rows ?? []).slice(0, limit);
      const hasMore = (rows ?? []).length > limit;
      return json({
        events,
        nextCursor: hasMore && events.length ? String(events[events.length - 1].id) : null,
      });
    }

    // Each person's language (owner's decision of 2026-10-16).
    if (action === 'setLanguage') {
      const lang = String(payload.lang ?? '');
      if (!['ru', 'uz'].includes(lang)) return json({ error: 'invalid_language' }, 400);
      const { error } = await sb.from('app_users').update({ lang }).eq('id', appUserResult.data.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, lang });
    }

    if (action === 'load' && isFrontDesk) {
      // The administrator's Склад: names and quantities, her own recent sales,
      // nothing about prices, revenue or the masters.
      const [products, receipts, productSales, writeoffs] = await Promise.all([
        fetchStockRows('products', 'id'),
        fetchStockRows('product_receipts', 'receipt_date'),
        fetchStockRows('product_sales', 'sale_date'),
        fetchStockRows('product_writeoffs', 'writeoff_date'),
      ]);
      const desk = stockForDesk({
        products,
        receipts,
        sales: productSales,
        writeoffs,
        userId: appUserResult.data.id,
        since: tashkentDate(-1),
      });
      // And the bookings: every master's day, with numbers to call clients.
      const [deskMasters, appointments, bookingServices, scheduleRules, dayStatuses, deskSettings] = await Promise.all([
        sb.from('masters').select('id, name, active').eq('active', true).order('id'),
        fetchAppointments({}, false),
        fetchAllRows('booking_services', 'id'),
        fetchAllRows('master_schedule_rules', 'iso_weekday'),
        fetchAllRows('master_day_statuses', 'work_date'),
        // Only when the booking control started: older open bookings are not
        // shown as overdue.
        sb.from('settings').select('booking_control_since').eq('id', 1),
      ]);
      if (deskMasters.error) return json({ error: deskMasters.error.message }, 500);
      return json({
        role: 'frontdesk',
        appRole: appUserResult.data.role,
        lang: appUserResult.data.lang || 'ru',
        ...desk,
        masters: deskMasters.data ?? [],
        appointments,
        booking_services: bookingServices,
        master_schedule_rules: scheduleRules,
        master_day_statuses: dayStatuses,
        settings: deskSettings.data ?? [],
        sessionToken: issuedSessionToken,
      });
    }

    if (action === 'load') {
      const masters = (await sb.from('masters').select('*').order('id')).data ?? [];
      const settings = (await sb.from('settings').select('*').eq('id', 1)).data ?? [];

      // Optional lower bound for the tables that accumulate a row per sale, per
      // shift, per expense — the only ones whose size tracks how long the salon
      // has been open. The client sends it on its 15s poll and omits it on the
      // first load, so a refresh costs one period instead of all history.
      // Balances (debts) and reference data stay complete at every size.
      const since = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.since ?? ''))
        ? String(payload.since)
        : null;
      const byDay = since ? { column: 'd', since } : null;
      const byDate = since ? { column: 'date', since } : null;

      if (isAdmin || isPartner) {
        const [sales, fines, attendance, expenses, debts, debt_payments, booking_services, master_day_statuses, appointments, master_schedule_rules, clients, products, product_receipts, product_sales, product_writeoffs, master_advances, master_payouts] = await Promise.all([
          fetchAllRows('sales', 'd', {}, byDay),
          fetchAllRows('fines', 'id', {}, byDay),
          fetchAllRows('attendance', 'id', {}, byDay),
          fetchAllRows('expenses', 'date', {}, byDate),
          isAdmin ? fetchAllRows('debts', 'id') : Promise.resolve([]),
          isAdmin ? fetchAllRows('debt_payments', 'date', {}, byDate) : Promise.resolve([]),
          canManageCalendar || isPartner ? fetchAllRows('booking_services', 'id') : Promise.resolve([]),
          // A partner reads the attendance register, and a day off is part of it.
          canManageCalendar || isPartner ? fetchAllRows('master_day_statuses', 'work_date') : Promise.resolve([]),
          // The partner books too, and calls clients like the owner does.
          canManageCalendar || isPartner ? fetchAppointments() : Promise.resolve([]),
          // Everyone who sees attendance needs the schedule: a late arrival is
          // measured against the master's own shift, not only the salon cutoff.
          fetchAllRows('master_schedule_rules', 'iso_weekday'),
          canManageClients ? fetchAllRows('client_export', 'last_contact_at') : Promise.resolve([]),
          // Склад is small and bounded by the shelf, so it always comes whole.
          fetchStockRows('products', 'id'),
          fetchStockRows('product_receipts', 'receipt_date'),
          fetchStockRows('product_sales', 'sale_date'),
          fetchStockRows('product_writeoffs', 'writeoff_date'),
          // Advances and payouts: a row a week per master, small for years.
          fetchAllRows('master_advances', 'id'),
          fetchAllRows('master_payouts', 'id'),
        ]);

        return json({
          role: 'admin',
          lang: appUserResult.data.lang || 'ru',
          masters,
          settings,
          sales,
          fines,
          attendance,
          // What each expense was for never leaves the server for a partner.
          expenses: isPartner ? expenses.map(expenseForPartner) : expenses,
          debts,
          debt_payments,
          booking_services,
          master_day_statuses,
          appointments,
          master_schedule_rules,
          clients,
          products,
          product_receipts,
          product_sales,
          product_writeoffs,
          master_advances,
          master_payouts,
          appRole: appUserResult.data.role,
          sessionToken: issuedSessionToken,
          windowSince: since,
        });
      }

      const [sales, fines, attendance, booking_services, master_day_statuses, appointments, master_schedule_rules, master_advances, master_payouts] = await Promise.all([
        fetchAllRows('sales', 'd', { master: myMaster }, byDay),
        fetchAllRows('fines', 'id', { master: myMaster }, byDay),
        fetchAllRows('attendance', 'id', { master: myMaster }, byDay),
        fetchAllRows('booking_services', 'id'),
        fetchAllRows('master_day_statuses', 'work_date', { master_id: myMasterId! }),
        fetchAppointments({ master_id: myMasterId! }, true),
        fetchAllRows('master_schedule_rules', 'iso_weekday', { master_id: myMasterId! }),
        // His own advances and payouts: what he will get on Sunday.
        fetchAllRows('master_advances', 'id', { master_id: myMasterId! }),
        fetchAllRows('master_payouts', 'id', { master_id: myMasterId! }),
      ]);
      const meOnly = masters.filter((master: { name: string }) => master.name === myMaster);

      return json({
        role: 'master',
        appRole: appUserResult.data.role,
        lang: appUserResult.data.lang || 'ru',
        me: myMaster,
        masters: meOnly,
        settings,
        sales,
        fines,
        attendance,
        booking_services,
        master_day_statuses,
        appointments,
        master_schedule_rules,
        master_advances,
        master_payouts,
        sessionToken: issuedSessionToken,
        windowSince: since,
      });
    }

    // Client cards (owner's decision of 2026-10-16): a master finds the client
    // or makes a card for him before recording a visit. Only the owner sees a
    // number whole and reads a card's history.
    const isOwnerCaller = appUserResult.data.role === 'owner';
    const fullPhones = seesFullPhones(appUserResult.data.role);
    if (['searchClients', 'addClient', 'completeClientName'].includes(action) && !(isOwnerCaller || myMaster || isFrontDesk || isPartner)) {
      return json({ error: 'forbidden' }, 403);
    }

    // Who scanned a master's QR (owner's decisions of 2026-10-21): for two
    // hours, or until a visit of his is recorded. A master sees his own
    // mirror; the owner that of the master he records for.
    if (action === 'mirrorScans') {
      let masterId = myMasterId;
      if (isAdmin && payload.master) {
        const picked = await sb.from('masters').select('id').eq('name', String(payload.master)).maybeSingle();
        if (picked.error) return json({ error: picked.error.message }, 500);
        masterId = picked.data ? Number(picked.data.id) : null;
      }
      if (!masterId) return json({ scans: [] });
      const since = new Date(Date.now() - MIRROR_SCAN_HOURS * 60 * 60 * 1000).toISOString();
      const { data, error } = await sb.from('client_scans')
        .select(`id, scanned_at, client:clients(${CLIENT_COLUMNS})`)
        .eq('master_id', masterId)
        .is('used_at', null)
        .gte('scanned_at', since);
      if (error) return json({ error: error.message }, 500);
      const scans = await Promise.all(latestScanPerClient(data).map(async (row: { id: number; scanned_at: string; client: ClientRow }) => {
        const visits = await sb.rpc('maestro_client_visit_count', { p_client_id: row.client.id });
        return {
          id: row.id,
          scanned_at: row.scanned_at,
          client: clientForCaller({ ...row.client, visit_count: visits.data ?? 0 }, fullPhones),
        };
      }));
      return json({ scans });
    }

    if (action === 'searchClients') {
      const query = String(payload.query ?? '').trim().slice(0, 60);
      if (query.length < 2) return json({ clients: [] });
      const { data, error } = await sb.rpc('maestro_search_clients', { p_query: query, p_limit: 10 });
      if (error) return json({ error: error.message }, 500);
      return json({ clients: (data ?? []).map((row: ClientRow) => clientForCaller(row, fullPhones)) });
    }

    if (action === 'addClient') {
      // A name and a surname, both (owner's decision of 2026-10-21). An app
      // still open from before sends one full_name and gets an error: the
      // owner tells everyone to reopen it.
      const name = checkClientName(payload.first_name, payload.last_name);
      if (!name.ok) return json({ error: name.error }, 400);
      // A card always has a number: a client who will not give it is a guest
      // without a name (owner's decision of 2026-10-21).
      const phone = String(payload.phone ?? '').trim();
      if (!phone) return json({ error: 'client_phone_required' }, 400);
      const { data, error } = await sb.rpc('maestro_add_client_card', {
        p_first_name: name.first_name,
        p_last_name: name.last_name,
        p_phone: phone,
        p_known_before: payload.known_before === true,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) {
        if (data?.error === 'client_exists' && data.client_id) {
          // The number is already in the base: offer that card instead.
          const existing = await sb.from('clients').select(CLIENT_COLUMNS)
            .eq('id', data.client_id).maybeSingle();
          const visits = await sb.rpc('maestro_client_visit_count', { p_client_id: data.client_id });
          return json({
            error: 'client_exists',
            client: existing.data ? clientForCaller({ ...existing.data, visit_count: visits.data ?? 0 }, fullPhones) : null,
          }, 409);
        }
        return json({ error: data?.error || 'invalid_client' }, 400);
      }
      const created = await sb.from('clients').select(CLIENT_COLUMNS)
        .eq('id', data.client_id).maybeSingle();
      if (created.error || !created.data) return json({ error: created.error?.message || 'client_not_found' }, 500);
      return json({ ok: true, client: clientForCaller({ ...created.data, visit_count: 0 }, fullPhones) });
    }

    // A card made before the two parts gets its surname from whoever records
    // the client's visit or booking; its name stays as it is.
    if (action === 'completeClientName') {
      const clientId = String(payload.client_id ?? '');
      if (!UUID_PATTERN.test(clientId)) return json({ error: 'invalid_client' }, 400);
      const surname = checkLastName(payload.last_name);
      if (!surname.ok) return json({ error: surname.error }, 400);
      const { data, error } = await sb.rpc('maestro_complete_client_name', {
        p_client_id: clientId,
        p_last_name: surname.last_name,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) return json(data ?? { error: 'invalid_client' }, data?.error === 'client_not_found' ? 404 : 400);
      const completed = await sb.from('clients').select(CLIENT_COLUMNS).eq('id', clientId).maybeSingle();
      if (completed.error || !completed.data) return json({ error: completed.error?.message || 'client_not_found' }, 500);
      const visits = await sb.rpc('maestro_client_visit_count', { p_client_id: clientId });
      return json({ ok: true, client: clientForCaller({ ...completed.data, visit_count: visits.data ?? 0 }, fullPhones) });
    }

    // Bookings taken by phone or Telegram: the owner, the administrator and
    // the partner. A master books nobody; he records the clients who come.
    if (['bookingSlots', 'addBooking', 'moveBooking'].includes(action) && !(isOwnerCaller || isFrontDesk || isPartner)) {
      return json({ error: 'forbidden' }, 403);
    }

    if (action === 'bookingSlots') {
      const masterId = Number(payload.master_id);
      const date = String(payload.date ?? '');
      // Free times for moving a booking: its own length, and its own time is
      // not in its way.
      const movingId = UUID_PATTERN.test(String(payload.appointment_id ?? '')) ? String(payload.appointment_id) : null;
      const serviceIds = Array.isArray(payload.service_ids)
        ? [...new Set(payload.service_ids.map((value: unknown) => String(value)))].slice(0, 10)
        : [];
      if (!Number.isInteger(masterId) || !isValidIsoDate(date) || (!serviceIds.length && !movingId)) {
        return json({ error: 'invalid_booking' }, 400);
      }
      if (date < tashkentDate() || date > tashkentDate(62)) return json({ error: 'invalid_booking' }, 400);
      let duration = 0;
      if (movingId) {
        const moving = await sb.from('appointments').select('duration_minutes').eq('id', movingId).maybeSingle();
        if (moving.error) return json({ error: moving.error.message }, 500);
        if (!moving.data) return json({ error: 'appointment_not_found' }, 404);
        duration = Number(moving.data.duration_minutes);
      } else {
        const { data: services, error: servicesError } = await sb.from('booking_services')
          .select('id, duration_minutes').in('id', serviceIds).eq('active', true);
        if (servicesError) return json({ error: servicesError.message }, 500);
        if ((services ?? []).length !== serviceIds.length) return json({ error: 'service_not_found' }, 404);
        duration = (services ?? []).reduce((sum: number, service: { duration_minutes: number }) => sum + Number(service.duration_minutes), 0);
      }
      const { data, error } = await sb.rpc('maestro_booking_slots', {
        p_duration_minutes: duration,
        p_from: date,
        p_to: date,
        p_master_ids: [masterId],
        p_not_before: new Date().toISOString(),
        p_except_appointment: movingId,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ duration, times: (data ?? []).map((row: { slot_start: string }) => row.slot_start) });
    }

    if (action === 'addBooking') {
      const serviceIds = Array.isArray(payload.service_ids)
        ? payload.service_ids.map((value: unknown) => String(value)).slice(0, 10)
        : [];
      // The client of a booking has a surname too (owner's decision of 2026-10-21).
      if (UUID_PATTERN.test(String(payload.client_id ?? ''))) {
        const booked = await sb.from('clients').select('last_name').eq('id', String(payload.client_id)).maybeSingle();
        if (booked.error) return json({ error: booked.error.message }, 500);
        if (booked.data && !booked.data.last_name) return json({ error: 'client_surname_required' }, 409);
      }
      const { data, error } = await sb.rpc('maestro_book_appointment', {
        p_master_id: Number(payload.master_id),
        p_service_ids: serviceIds,
        p_starts_at: String(payload.starts_at ?? ''),
        p_client_id: UUID_PATTERN.test(String(payload.client_id ?? '')) ? String(payload.client_id) : null,
        p_notes: payload.notes ? String(payload.notes).slice(0, 300) : null,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) return json(data ?? { error: 'invalid_booking' }, data?.error === 'slot_unavailable' ? 409 : 400);
      if (data.appointment_id) inBackground(tellMasterAboutBooking(String(data.appointment_id)));
      return json(data);
    }

    // Another time or another master, by the same rule as a new booking. The
    // master hears of it; when the master changes, both do.
    if (action === 'moveBooking') {
      const appointmentId = UUID_PATTERN.test(String(payload.id ?? '')) ? String(payload.id) : null;
      const masterId = Number(payload.master_id);
      const startsAt = String(payload.starts_at ?? '');
      if (!appointmentId || !Number.isInteger(masterId) || Number.isNaN(Date.parse(startsAt))) {
        return json({ error: 'invalid_booking' }, 400);
      }
      const { data, error } = await sb.rpc('maestro_move_appointment', {
        p_appointment_id: appointmentId,
        p_master_id: masterId,
        p_starts_at: startsAt,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) {
        const code = data?.error;
        return json(data ?? { error: 'invalid_booking' }, code === 'appointment_not_found' ? 404 : ['slot_unavailable', 'appointment_closed'].includes(code) ? 409 : 400);
      }
      if (!data.unchanged) {
        const moved = data.appointment as BookingNoticeRow;
        const before = Number(data.previous_master_id);
        if (before === Number(moved.master_id)) {
          inBackground(tellMaster(before, 'moved', moved, data.previous_starts_at));
        } else {
          inBackground(tellMaster(before, 'away', { ...moved, starts_at: data.previous_starts_at }));
          inBackground(tellMaster(Number(moved.master_id), 'new', moved));
        }
      }
      return json(data);
    }

    // The owner corrects a card's name and number, and merges two cards of one
    // person (owner's request of 2026-10-17).
    if (action === 'updateClient') {
      if (!isOwnerCaller) return json({ error: 'forbidden' }, 403);
      const clientId = String(payload.client_id ?? '');
      if (!UUID_PATTERN.test(clientId)) return json({ error: 'invalid_client' }, 400);
      const name = checkClientName(payload.first_name, payload.last_name);
      if (!name.ok) return json({ error: name.error }, 400);
      const { data, error } = await sb.rpc('maestro_update_client_card', {
        p_client_id: clientId,
        p_first_name: name.first_name,
        p_last_name: name.last_name,
        p_phone: payload.phone ? String(payload.phone) : null,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) return json(data ?? { error: 'invalid_client' }, data?.error === 'client_exists' ? 409 : data?.error === 'client_not_found' ? 404 : 400);
      return json(data);
    }

    if (action === 'mergeClients') {
      if (!isOwnerCaller) return json({ error: 'forbidden' }, 403);
      const from = String(payload.from_id ?? '');
      const into = String(payload.into_id ?? '');
      if (!UUID_PATTERN.test(from) || !UUID_PATTERN.test(into)) return json({ error: 'invalid_merge' }, 400);
      const { data, error } = await sb.rpc('maestro_merge_clients', {
        p_from: from,
        p_into: into,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) return json(data ?? { error: 'invalid_merge' }, data?.error === 'client_not_found' ? 404 : 400);
      return json(data);
    }

    // How clients rated their visits (owner's decisions of 2026-10-21). The
    // owner reads every score and decides which words the site shows; a master
    // reads his own, every word included, without the comfort of the salon and
    // without knowing which words reached the site: he is to expect them all.
    if (action === 'reviews') {
      if (!isOwnerCaller && !myMasterId) return json({ error: 'forbidden' }, 403);
      const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
      let query = sb.from('visit_reviews')
        .select('id, master_id, quality, service, cleanliness, comfort, comment, comment_status, asked_at, sale:sales(d, client_id, client_name, status, comment)')
        .not('quality', 'is', null)
        .gte('asked_at', since)
        .order('asked_at', { ascending: false })
        .limit(300);
      if (!isOwnerCaller) query = query.eq('master_id', myMasterId!);
      const [rows, ratings] = await Promise.all([query, sb.rpc('maestro_master_ratings')]);
      if (rows.error) return json({ error: rows.error.message }, 500);
      if (ratings.error) return json({ error: ratings.error.message }, 500);
      const rejected = (sale: { status?: string | null; comment?: string | null }) =>
        String(sale.status ?? '').trim() === 'rejected' || sale.comment === 'owner_approval_rejected';
      const reviews = (rows.data ?? [])
        .filter((row: any) => row.sale && !rejected(row.sale))
        .map((row: any) => ({
          id: row.id,
          master_id: row.master_id,
          d: row.sale.d,
          client_id: isOwnerCaller ? row.sale.client_id : null,
          client_name: row.sale.client_name,
          quality: row.quality,
          service: row.service,
          cleanliness: row.cleanliness,
          comfort: isOwnerCaller ? row.comfort : null,
          comment: row.comment,
          comment_status: isOwnerCaller ? row.comment_status : null,
        }));
      const own = (ratings.data ?? [])
        .filter((row: any) => isOwnerCaller || Number(row.master_id) === myMasterId)
        .map((row: any) => (isOwnerCaller ? row : { ...row, comfort: null }));
      return json({ reviews, ratings: own });
    }

    if (action === 'decideReview') {
      if (!isOwnerCaller) return json({ error: 'forbidden' }, 403);
      const reviewId = Number(payload.review_id);
      if (!Number.isInteger(reviewId) || reviewId <= 0) return json({ error: 'review_not_found' }, 404);
      const { data, error } = await sb.rpc('maestro_decide_review_words', {
        p_review_id: reviewId,
        p_status: String(payload.status ?? ''),
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!data?.ok) return json({ error: data?.error === 'not_found' ? 'review_not_found' : 'invalid_review_status' }, 400);
      return json(data);
    }

    if (action === 'getClient') {
      if (!isOwnerCaller) return json({ error: 'forbidden' }, 403);
      const clientId = String(payload.client_id ?? '');
      if (!UUID_PATTERN.test(clientId)) return json({ error: 'invalid_client' }, 400);
      const { data, error } = await sb.rpc('maestro_client_card', { p_client_id: clientId });
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: 'client_not_found' }, 404);
      return json(data);
    }

    if (action === 'addSale') {
      const master = isAdmin ? payload.master : myMaster;
      const requiresOwnerApproval = !isAdmin;
      const cash = Math.max(0, Math.round(Number(payload.cash) || 0));
      const card = Math.max(0, Math.round(Number(payload.card) || 0));
      const qr = Math.max(0, Math.round(Number(payload.qr) || 0));
      const d = String(payload.d ?? '');
      if (!master || !isValidIsoDate(d) || cash + card + qr <= 0) {
        return json({ error: 'invalid_sale' }, 400);
      }
      // An unbounded date turns into a row nobody can delete: the admin window
      // is two days, so anything older is permanent once it is approved.
      if (!isAdmin && (d > tashkentDate(1) || d < tashkentDate(-7))) {
        return json({ error: 'sale_date_out_of_range' }, 400);
      }
      if (cash + card + qr > MAX_SALE_AMOUNT) {
        return json({ error: 'sale_amount_too_large' }, 400);
      }

      const masterRecord = isAdmin
        ? await sb.from('masters').select('id, pct, active').eq('name', master).maybeSingle()
        : { data: { id: myMasterId, pct: myMasterPct, active: true }, error: null };
      if (masterRecord.error) return json({ error: masterRecord.error.message }, 500);
      if (!masterRecord.data?.active || !Number.isFinite(Number(masterRecord.data.pct))) {
        return json({ error: 'master_not_active' }, 409);
      }

      // Every visit names its client, or is a guest without a name: one who
      // gives neither his name nor his number (owner's decision of
      // 2026-10-21). A guest has no card, each one a visit of his own, and
      // the master says whether he is new or has been coming.
      const isGuest = payload.guest === true;
      let clientId: string | null = null;
      let clientName = GUEST_NAME;
      let isNewClient: boolean;
      let noPhone = true;
      if (isGuest) {
        if (typeof payload.known_before !== 'boolean') return json({ error: 'guest_known_before_required' }, 400);
        isNewClient = !payload.known_before;
      } else {
        clientId = String(payload.client_id ?? '');
        if (!UUID_PATTERN.test(clientId)) return json({ error: 'client_required' }, 400);
        const clientRecord = await sb.from('clients')
          .select(CLIENT_COLUMNS)
          .eq('id', clientId)
          .maybeSingle();
        if (clientRecord.error) return json({ error: clientRecord.error.message }, 500);
        if (!clientRecord.data) return json({ error: 'client_not_found' }, 404);
        if (clientRecord.data.lifecycle_status === 'blocked') return json({ error: 'client_blocked' }, 409);
        if (!clientRecord.data.last_name) return json({ error: 'client_surname_required' }, 409);
        const visits = await sb.rpc('maestro_client_visit_count', { p_client_id: clientId });
        if (visits.error) return json({ error: visits.error.message }, 500);
        // New or returning is the base's to say, never the master's: «Был у
        // нас раньше?» is answered only when a card is made (owner's decision
        // of 2026-10-16), so a regular picked from the base cannot be passed
        // off as a first visit.
        const firstVisit = Number(visits.data) === 0;
        isNewClient = firstVisit && clientRecord.data.known_before !== true;
        noPhone = !clientRecord.data.phone_e164;
        clientName = clientRecord.data.full_name;
      }

      // A visit recorded from a booking closes it. A booking always has its
      // client's card, so it is never a guest's.
      const appointmentId = payload.appointment_id == null || payload.appointment_id === ''
        ? null
        : String(payload.appointment_id);
      if (appointmentId !== null && isGuest) return json({ error: 'guest_with_booking' }, 400);
      if (appointmentId !== null) {
        if (!UUID_PATTERN.test(appointmentId)) return json({ error: 'appointment_not_found' }, 404);
        const check = await sb.rpc('maestro_check_appointment_for_visit', {
          p_appointment_id: appointmentId,
          p_master_id: masterRecord.data.id,
          p_client_id: clientId,
        });
        if (check.error) return json({ error: check.error.message }, 500);
        if (!check.data?.ok) return json({ error: check.data?.error || 'appointment_closed' }, 409);
      }

      // A master whose booking has ended and is still open closes it before
      // recording anyone else (owner's decision of 2026-10-16): «Пришёл» turns
      // it into a visit, «Не пришёл» closes it without one. A visit that closes
      // a booking is always let through.
      if (!isAdmin && appointmentId === null) {
        const unclosed = await sb.rpc('maestro_unclosed_bookings', { p_master_id: masterRecord.data.id });
        if (unclosed.error) return json({ error: unclosed.error.message }, 500);
        if ((unclosed.data ?? []).length) {
          return json({ error: 'bookings_to_close', bookings: unclosed.data }, 409);
        }
      }

      const row: Record<string, unknown> = {
        master,
        d,
        cash,
        card,
        qr,
        cl: 1,
        clients_count: 1,
        is_new_client: isNewClient,
        client_id: clientId,
        client_name: clientName,
        client_no_phone: noPhone,
        is_guest: isGuest,
        appointment_id: appointmentId,
        master_id: masterRecord.data.id,
        commission_pct: Number(masterRecord.data.pct),
        status: requiresOwnerApproval ? 'pending' : 'approved',
        approved_by: requiresOwnerApproval ? null : String(appUserResult.data.id),
        approved_at: requiresOwnerApproval ? null : new Date().toISOString(),
        comment: requiresOwnerApproval ? 'owner_approval_required' : null,
      };

      // The client keeps one id across its own retries, so a resend of a
      // request that already landed is absorbed instead of doubling the sale.
      const requestId = String(payload.client_request_id ?? '');
      const hasRequestId = UUID_PATTERN.test(requestId);
      if (hasRequestId) row.client_request_id = requestId;

      let { error } = await sb.from('sales').insert(row);
      if (error && hasRequestId) {
        if (error.code === '23505' && !String(error.message).includes('sales_appointment_key')) {
          return json({ ok: true, deduplicated: true });
        }
        if (error.code === '23505') return json({ error: 'appointment_already_visited' }, 409);
        // Deployed ahead of the migration that adds the column: keep the sale
        // rather than losing it, and fall back to the client-side guard.
        if (error.code === '42703' || error.code === 'PGRST204') {
          delete row.client_request_id;
          ({ error } = await sb.from('sales').insert(row));
        }
      }
      if (error) return json({ error: error.message }, 500);

      // His scan at the mirror has done its work: it leaves every master's list.
      if (clientId) {
        const used = await sb.from('client_scans')
          .update({ used_at: new Date().toISOString() })
          .eq('client_id', clientId)
          .is('used_at', null);
        if (used.error) console.error('[maestro-api] scan not cleared', used.error.message);
      }

      if (appointmentId !== null) {
        const closed = await sb.rpc('maestro_complete_appointment_for_visit', {
          p_appointment_id: appointmentId,
          p_client_id: clientId,
          p_actor_user_id: appUserResult.data.id,
        });
        if (closed.error || !closed.data?.ok) {
          console.error('[maestro-api] visit written but booking not closed', {
            appointmentId,
            error: closed.error?.message || closed.data?.error,
          });
        }
      }

      // A guest, and a visit without a number, reach the owner at once, so he
      // can ask why they were not taken. His own entries he already knows about.
      if (noPhone && appUserResult.data.role !== 'owner') {
        const time = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(11, 16);
        inBackground(messageOwners([
          isGuest ? `⚠️ <b>${GUEST_NAME}</b>` : '⚠️ <b>Визит без номера</b>',
          `💈 ${escapeHtml(master)} · ${d === tashkentDate() ? time : d}`,
          isGuest ? (isNewClient ? '🆕 новый клиент' : '🔁 был раньше') : `👤 ${escapeHtml(clientName)}`,
          `💵 ${formatSum(cash + card + qr)} сум`,
        ].join('\n')));
      }
      return json({ ok: true, is_new_client: isNewClient });
    }

    if (action === 'setSaleApproval') {
      if (!canApproveSales) return json({ error: 'forbidden' }, 403);
      if (!['approved', 'rejected'].includes(payload.status)) {
        return json({ error: 'invalid_sale_status' }, 400);
      }

      // An already-approved row stays reversible: approving by mistake used to
      // be permanent once the two-day delete window closed.
      const decidable = ['owner_approval_required', 'owner_approval_rejected', 'owner_approval_approved'];
      const existing = await sb
        .from('sales')
        .select('id, comment')
        .eq('id', payload.id)
        .maybeSingle();
      if (existing.error) return json({ error: existing.error.message }, 500);
      if (!existing.data || !decidable.includes(existing.data.comment)) {
        return json({ error: 'sale_does_not_require_owner_approval' }, 409);
      }

      const { error } = await sb
        .from('sales')
        .update({
          status: payload.status,
          approved_by: String(appUserResult.data.id),
          approved_at: new Date().toISOString(),
          comment: payload.status === 'approved'
            ? 'owner_approval_approved'
            : 'owner_approval_rejected',
        })
        .eq('id', payload.id)
        // Keeping the guard on the write itself makes two racing decisions
        // resolve to one winner instead of an undefined interleaving.
        .in('comment', decidable);
      if (error) {
        console.error('[maestro-api] sale approval failed', { saleId: payload.id, error: error.message });
        return json({ error: error.message }, 500);
      }
      console.log('[maestro-api] sale approval saved', { saleId: payload.id, status: payload.status });
      return json({ ok: true });
    }

    if (action === 'delSale') {
      // Best effort: names the actor for the delete-audit trigger. Deliberately
      // not fatal, so a sale stays deletable if the journal is unavailable.
      await sb.rpc('maestro_set_audit_actor', {
        p_actor_user_id: appUserResult.data.id,
        p_source: 'web_app',
        p_correlation_id: requestId,
      }).then(() => undefined, () => undefined);

      if (isAdmin) {
        const existing = await sb.from('sales').select('id,d').eq('id', payload.id).maybeSingle();
        if (existing.error) return json({ error: existing.error.message }, 500);
        if (!existing.data) return json({ error: 'sale_not_found' }, 404);
        if (existing.data.d < tashkentDate(-2)) {
          return json({ error: 'sale_delete_window_expired' }, 403);
        }
        const { error } = await sb.from('sales').delete().eq('id', payload.id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      const { error } = await sb.from('sales').delete().eq('id', payload.id)
        .eq('master', myMaster).eq('status', 'pending').eq('comment', 'owner_approval_required');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'setAttendance') {
      const master = isAdmin ? payload.master : myMaster;
      if (!master) return json({ error: 'invalid_attendance' }, 400);
      // A master checking himself in does not get to choose when or for which
      // day: the device clock is his to change, and a late arrival is money.
      // An admin correcting the sheet does send both, and the "Я пришёл" button
      // sends neither — so an absent value means "stamp it now", not an error.
      const d = isAdmin && payload.d ? String(payload.d) : tashkentDate();
      const arrived = isAdmin && payload.arrived ? String(payload.arrived) : tashkentTime();
      if (!isValidIsoDate(d) || !/^\d{2}:\d{2}$/.test(arrived)) {
        return json({ error: 'invalid_attendance' }, 400);
      }
      const { error } = await sb
        .from('attendance')
        .upsert({ master, d, arrived }, { onConflict: 'master,d' });
      if (error) return json({ error: error.message }, 500);
      // A late arrival is fined on the spot (owner's decision of 2026-10-16);
      // the owner correcting it to on time takes that fine back. The arrival
      // stands either way, so a failure here is logged rather than returned.
      const masterId = await masterIdFor(master);
      let fine = null;
      if (masterId) {
        const settled = await sb.rpc('maestro_settle_late_fine', {
          p_master_id: masterId,
          p_day: d,
          p_arrived: arrived,
          p_actor_user_id: appUserResult.data.id,
        });
        if (settled.error) console.error('[maestro-api] late fine', settled.error.message);
        else if (settled.data?.fined) fine = settled.data;
      }
      return json({ ok: true, fine });
    }

    if (action === 'delAttendance') {
      const master = isAdmin ? payload.master : myMaster;
      const d = String(payload.d ?? '');
      if (!master || !isValidIsoDate(d)) return json({ error: 'invalid_attendance' }, 400);
      // Clearing today's mistaken check-in is fair; rewriting last week is not.
      if (!isAdmin && d !== tashkentDate()) {
        return json({ error: 'attendance_edit_window_expired' }, 403);
      }
      const { error } = await sb.from('attendance').delete().eq('master', master).eq('d', d);
      if (error) return json({ error: error.message }, 500);
      // The owner removing a wrong arrival removes the fine it brought. A
      // master clearing his own check-in keeps it: that is no way out of one.
      if (isAdmin) {
        const masterId = await masterIdFor(master);
        if (masterId) {
          const dropped = await sb.rpc('maestro_drop_auto_fine', {
            p_master_id: masterId,
            p_day: d,
            p_kind: 'late',
            p_actor_user_id: appUserResult.data.id,
          });
          if (dropped.error) console.error('[maestro-api] drop late fine', dropped.error.message);
        }
      }
      return json({ ok: true });
    }

    if (action === 'setMasterDayOff') {
      // Days off are the partner's to set (owner's decision of 2026-10-16).
      if (!canManageCalendar && !isPartner) return json({ error: 'forbidden' }, 403);
      const masterId = Number(payload.master_id);
      if (!Number.isInteger(masterId) || !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.work_date || ''))) {
        return json({ error: 'invalid_day_off_request' }, 400);
      }
      const { data: result, error } = await sb.rpc('maestro_set_master_day_off', {
        p_master_id: masterId,
        p_work_date: payload.work_date,
        p_enabled: payload.enabled === true,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) return json(result, result?.error === 'appointments_exist' ? 409 : 400);
      // A day off set after 18:00 takes back that day's «нет отметки» fine.
      if (payload.enabled === true) {
        const dropped = await sb.rpc('maestro_drop_auto_fine', {
          p_master_id: masterId,
          p_day: payload.work_date,
          p_kind: 'no_mark',
          p_actor_user_id: appUserResult.data.id,
        });
        if (dropped.error) console.error('[maestro-api] drop no-mark fine', dropped.error.message);
        else if (dropped.data) return json({ ...result, fine_dropped: dropped.data });
      }
      return json(result);
    }

    if (action === 'setMasterSchedule' || action === 'delMasterSchedule') {
      if (!canEditSettings) return json({ error: 'forbidden' }, 403);
    }

    if (action === 'setMasterSchedule') {
      const masterId = Number(payload.master_id);
      const effectiveFrom = String(payload.effective_from ?? '');
      const days = Array.isArray(payload.days) ? payload.days : null;
      if (!Number.isInteger(masterId) || !isValidIsoDate(effectiveFrom) || !days || days.length > 7) {
        return json({ error: 'invalid_schedule' }, 400);
      }
      // A wrong year in the date picker would otherwise re-judge a year of
      // attendance. Two months back is room enough to record a change late.
      if (effectiveFrom < tashkentDate(-62) || effectiveFrom > tashkentDate(366)) {
        return json({ error: 'schedule_date_out_of_range' }, 400);
      }
      const workDays: { iso_weekday: number; starts_at: string; ends_at: string }[] = [];
      for (const day of days) {
        const weekday = Number(day?.iso_weekday);
        const startsAt = String(day?.starts_at ?? '');
        const endsAt = String(day?.ends_at ?? '');
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7
          || !CLOCK_TIME.test(startsAt) || !CLOCK_TIME.test(endsAt) || endsAt <= startsAt) {
          return json({ error: 'invalid_schedule' }, 400);
        }
        workDays.push({ iso_weekday: weekday, starts_at: startsAt, ends_at: endsAt });
      }
      if (!workDays.length) return json({ error: 'schedule_needs_work_day' }, 400);

      const { data: result, error } = await sb.rpc('maestro_set_master_schedule', {
        p_master_id: masterId,
        p_effective_from: effectiveFrom,
        p_days: workDays,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) return json(result, result?.error === 'master_not_active' ? 409 : 400);
      return json(result);
    }

    if (action === 'delMasterSchedule') {
      const masterId = Number(payload.master_id);
      const effectiveFrom = String(payload.effective_from ?? '');
      if (!Number.isInteger(masterId) || !isValidIsoDate(effectiveFrom)) {
        return json({ error: 'invalid_schedule' }, 400);
      }
      const { data: result, error } = await sb.rpc('maestro_delete_master_schedule', {
        p_master_id: masterId,
        p_effective_from: effectiveFrom,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) return json(result, result?.error === 'schedule_not_found' ? 404 : 409);
      return json(result);
    }

    // Склад. The owner and an administrator keep the shelf; only the owner
    // decides on a sale, and an administrator's sale waits for him.
    const STOCK_ACTIONS = ['addProductReceipt', 'addProductSale', 'setProductSaleApproval', 'addProductWriteoff', 'delStockEntry', 'setProductActive'];
    if (STOCK_ACTIONS.includes(action)) {
      const role = appUserResult.data.role;
      // Deliveries, write-offs and decisions are the owner's. The administrator
      // records a sale and may take back her own while it still waits.
      const deskMay = ['addProductSale', 'delStockEntry'].includes(action);
      if (!(role === 'owner' || (role === ADMIN_ROLE && deskMay))) return json({ error: 'forbidden' }, 403);
    }
    const isOwner = appUserResult.data.role === 'owner';
    const stockResult = (result: Record<string, unknown> | null, error: { message: string } | null) => {
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) {
        const code = String(result?.error || 'stock_action_failed');
        const status = code === 'forbidden'
          ? 403
          : ['product_not_found', 'product_sale_not_found', 'stock_entry_not_found'].includes(code)
            ? 404
            : ['not_enough_stock', 'receipt_already_sold', 'product_still_in_stock', 'product_name_taken'].includes(code)
              ? 409
              : 400;
        return json(result, status);
      }
      return json(result);
    };
    const wholeNumber = (value: unknown) => {
      const number = Number(value);
      return Number.isInteger(number) ? number : null;
    };

    // Stock entries are dated by the server: a delivery, a sale or a write-off
    // is recorded the day it happens, never backdated.
    if (action === 'addProductReceipt') {
      const date = tashkentDate();
      const qty = wholeNumber(payload.qty);
      const unitCost = wholeNumber(payload.unit_cost);
      const productId = payload.product_id == null || payload.product_id === '' ? null : wholeNumber(payload.product_id);
      const productName = productId == null ? String(payload.product_name ?? '').trim().slice(0, 80) : null;
      const usdRate = Number(payload.usd_rate);
      if (qty == null || qty < 1 || qty > 100000
        || unitCost == null || unitCost < 1 || unitCost > MAX_SALE_AMOUNT
        || (productId == null && !productName)
        || !['ishxona', 'murod', 'jamshid', 'opening'].includes(String(payload.paid_by))
        || !['care', 'drinks', 'other'].includes(String(payload.category ?? 'care'))) {
        return json({ error: 'invalid_receipt' }, 400);
      }
      if (qty * unitCost > MAX_SALE_AMOUNT) return json({ error: 'receipt_amount_too_large' }, 400);
      const { data: result, error } = await sb.rpc('maestro_add_product_receipt', {
        p_product_id: productId,
        p_product_name: productName,
        p_category: String(payload.category ?? 'care'),
        p_receipt_date: date,
        p_qty: qty,
        p_unit_cost: unitCost,
        p_paid_by: String(payload.paid_by),
        p_usd_rate: Number.isFinite(usdRate) && usdRate > 0 ? usdRate : null,
        p_note: payload.note ? String(payload.note).trim().slice(0, 300) : null,
        p_actor_user_id: appUserResult.data.id,
      });
      return stockResult(result, error);
    }

    if (action === 'addProductSale') {
      const productId = wholeNumber(payload.product_id);
      const qty = wholeNumber(payload.qty);
      const amount = wholeNumber(payload.amount);
      const date = tashkentDate();
      const paymentMethod = String(payload.payment_method ?? '');
      if (productId == null || qty == null || qty < 1 || qty > 1000
        || amount == null || amount < 1
        || !['cash', 'card', 'qr'].includes(paymentMethod)) {
        return json({ error: 'invalid_product_sale' }, 400);
      }
      if (amount > MAX_SALE_AMOUNT) return json({ error: 'sale_amount_too_large' }, 400);
      const requestId = String(payload.client_request_id ?? '');
      const { data: result, error } = await sb.rpc('maestro_add_product_sale', {
        p_product_id: productId,
        p_sale_date: date,
        p_qty: qty,
        p_amount: amount,
        p_payment_method: paymentMethod,
        p_approved: isOwner,
        p_actor_user_id: appUserResult.data.id,
        p_client_request_id: UUID_PATTERN.test(requestId) ? requestId : null,
      });
      return stockResult(result, error);
    }

    if (action === 'setProductSaleApproval') {
      const { data: result, error } = await sb.rpc('maestro_set_product_sale_status', {
        p_id: wholeNumber(payload.id),
        p_status: String(payload.status ?? ''),
        p_actor_user_id: appUserResult.data.id,
      });
      return stockResult(result, error);
    }

    if (action === 'addProductWriteoff') {
      const productId = wholeNumber(payload.product_id);
      const qty = wholeNumber(payload.qty);
      const date = tashkentDate();
      if (productId == null || qty == null || qty < 1 || qty > 100000
        || !['used', 'gift', 'damaged', 'recount'].includes(String(payload.reason))) {
        return json({ error: 'invalid_writeoff' }, 400);
      }
      const { data: result, error } = await sb.rpc('maestro_add_product_writeoff', {
        p_product_id: productId,
        p_writeoff_date: date,
        p_qty: qty,
        p_reason: String(payload.reason),
        p_note: payload.note ? String(payload.note).trim().slice(0, 300) : null,
        p_actor_user_id: appUserResult.data.id,
      });
      return stockResult(result, error);
    }

    if (action === 'delStockEntry') {
      const kind = String(payload.kind ?? '');
      const id = wholeNumber(payload.id);
      if (!['receipt', 'sale', 'writeoff'].includes(kind) || id == null) {
        return json({ error: 'invalid_stock_entry' }, 400);
      }
      const { data: result, error } = await sb.rpc('maestro_delete_stock_entry', {
        p_kind: kind,
        p_id: id,
        p_actor_user_id: appUserResult.data.id,
        p_any_recent: isOwner,
        p_correlation_id: requestId,
      });
      return stockResult(result, error);
    }

    if (action === 'setProductActive') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      const { data: result, error } = await sb.rpc('maestro_set_product_active', {
        p_product_id: wholeNumber(payload.product_id),
        p_active: payload.active === true,
      });
      return stockResult(result, error);
    }

    if (action === 'addAppointment') {
      const appointmentMasterId = canManageCalendar
        ? Number(payload.master_id)
        : myMasterId;
      if (!appointmentMasterId) return json({ error: 'forbidden' }, 403);
      const { data: result, error } = await sb.rpc('maestro_create_appointment', {
        p_master_id: appointmentMasterId,
        p_service_id: String(payload.service_id || ''),
        p_starts_at: payload.starts_at,
        p_client_name: String(payload.client_name || ''),
        p_client_phone: payload.client_phone ? String(payload.client_phone) : null,
        p_notes: payload.notes ? String(payload.notes) : null,
        p_status: canManageCalendar && payload.status === 'pending' ? 'pending' : 'confirmed',
        p_source: 'admin',
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) {
        const conflict = ['slot_already_booked', 'master_day_off', 'client_blocked'].includes(result?.error);
        return json(result, conflict ? 409 : 400);
      }
      return json(result);
    }

    if (action === 'setAppointmentStatus') {
      if (!canManageCalendar) {
        if (!myMasterId) return json({ error: 'forbidden' }, 403);
        const existingAppointment = await sb
          .from('appointments')
          .select('id,master_id')
          .eq('id', payload.id)
          .maybeSingle();
        if (existingAppointment.error) return json({ error: existingAppointment.error.message }, 500);
        if (!existingAppointment.data) return json({ error: 'appointment_not_found' }, 404);
        if (Number(existingAppointment.data.master_id) !== myMasterId) {
          return json({ error: 'forbidden' }, 403);
        }
      }
      const { data: result, error } = await sb.rpc('maestro_set_appointment_status', {
        p_appointment_id: payload.id,
        p_status: payload.status,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) {
        if (result?.error === 'forbidden') return json(result, 403);
        if (result?.error === 'appointment_not_found') return json(result, 404);
        if (['invalid_status_transition', 'outcome_already_recorded'].includes(result?.error)) return json(result, 409);
        return json(result, 400);
      }
      return json(result);
    }

    if (action === 'setAppointmentOutcome') {
      // «Пришёл» is not a button of its own: the booking closes when the
      // master records the visit (addSale with appointment_id), so a client
      // can never be marked as come without the money.
      if (!['no_show', 'cancelled'].includes(String(payload.outcome))) {
        return json({ error: 'outcome_needs_visit' }, 400);
      }
      const { data: result, error } = await sb.rpc('maestro_set_appointment_outcome', {
        p_appointment_id: payload.id,
        p_outcome: String(payload.outcome || ''),
        p_cancelled_by: payload.cancelled_by ? String(payload.cancelled_by) : null,
        p_reason_code: payload.reason_code ? String(payload.reason_code) : null,
        p_reason_note: payload.reason_note ? String(payload.reason_note) : null,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) {
        if (result?.error === 'forbidden') return json(result, 403);
        if (result?.error === 'appointment_not_found') return json(result, 404);
        if (['invalid_status_transition', 'outcome_already_recorded', 'outcome_before_start'].includes(result?.error)) {
          return json(result, 409);
        }
        return json(result, 400);
      }
      // A booking cancelled by the desk reaches its master; one he closed
      // himself does not.
      const closed = result.appointment as BookingNoticeRow | undefined;
      if (payload.outcome === 'cancelled' && !result.unchanged && closed && Number(closed.master_id) !== myMasterId) {
        inBackground(tellMaster(Number(closed.master_id), 'cancelled', closed));
      }
      return json(result);
    }

    if (action === 'setClientBlocked') {
      if (!canManageClients) return json({ error: 'forbidden' }, 403);
      const { data: result, error } = await sb.rpc('maestro_set_client_blocked', {
        p_client_id: payload.id,
        p_blocked: payload.blocked === true,
        p_reason: payload.reason ? String(payload.reason) : null,
        p_actor_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) {
        if (result?.error === 'forbidden') return json(result, 403);
        if (result?.error === 'client_not_found') return json(result, 404);
        if (result?.error === 'client_already_blocked') return json(result, 409);
        return json(result, 400);
      }
      return json(result);
    }

    if (action === 'addFine') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const amount = Math.round(Number(payload.amount) || 0);
      const d = String(payload.d ?? '');
      if (!payload.master || !isValidIsoDate(d) || amount <= 0) return json({ error: 'invalid_fine' }, 400);
      // The column existed from the start and nothing ever wrote to it, so a
      // disputed fine had no record of what it was for.
      const reason = payload.reason ? String(payload.reason).trim().slice(0, 200) : null;
      const { error } = await sb.from('fines').insert({ master: payload.master, d, amount, reason });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'delFine') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const { data: result, error } = await sb.rpc('maestro_delete_fine', {
        p_id: payload.id,
        p_actor_user_id: appUserResult.data.id,
        p_source: 'web_app',
      });
      const response = auditedDeleteResponse(action, result, error);
      return json(response.body, response.status);
    }

    // Advances and weekly payouts (owner's decisions of 2026-10-16): the
    // owner's alone. An advance is the master's money paid early; it lowers
    // what is owed for its week and is neither a fine nor salon income.
    if (['addAdvance', 'delAdvance', 'markPayout', 'delPayout'].includes(action)) {
      if (!isOwnerCaller) return json({ error: 'forbidden' }, 403);
    }

    if (action === 'addAdvance') {
      const masterId = Number(payload.master_id);
      const amount = Math.round(Number(payload.amount));
      if (!Number.isInteger(masterId) || !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
        return json({ error: 'invalid_advance' }, 400);
      }
      const master = await sb.from('masters').select('id, name').eq('id', masterId).maybeSingle();
      if (master.error) return json({ error: master.error.message }, 500);
      if (!master.data) return json({ error: 'master_not_found' }, 404);
      const note = payload.note ? String(payload.note).trim().slice(0, 200) || null : null;
      const { error } = await sb.from('master_advances').insert({
        master_id: masterId,
        master: master.data.name,
        amount,
        given_on: tashkentDate(),
        note,
        created_by_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'markPayout') {
      const masterId = Number(payload.master_id);
      const weekStart = String(payload.week_start ?? '');
      const amount = Math.round(Number(payload.amount));
      const whole = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));
      const monday = isValidIsoDate(weekStart) && new Date(`${weekStart}T12:00:00Z`).getUTCDay() === 1;
      if (!Number.isInteger(masterId) || !monday || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
        return json({ error: 'invalid_payout' }, 400);
      }
      // A week not yet begun has nothing to pay.
      if (weekStart > tashkentDate()) return json({ error: 'invalid_payout' }, 400);
      const master = await sb.from('masters').select('id, name').eq('id', masterId).maybeSingle();
      if (master.error) return json({ error: master.error.message }, 500);
      if (!master.data) return json({ error: 'master_not_found' }, 404);
      const weekEnd = new Date(`${weekStart}T12:00:00Z`);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      const advances = await sb.from('master_advances').select('amount')
        .eq('master_id', masterId).gte('given_on', weekStart).lte('given_on', weekEnd.toISOString().slice(0, 10));
      if (advances.error) return json({ error: advances.error.message }, 500);
      const { error } = await sb.from('master_payouts').insert({
        master_id: masterId,
        master: master.data.name,
        week_start: weekStart,
        amount,
        earned: whole(payload.earned),
        fines: whole(payload.fines),
        advances: (advances.data ?? []).reduce((sum: number, row: { amount: number }) => sum + Number(row.amount), 0),
        paid_by_user_id: appUserResult.data.id,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (['delAdvance', 'delPayout'].includes(action)) {
      const id = Number(payload.id);
      if (!Number.isInteger(id)) return json({ error: 'invalid_request' }, 400);
      const { data: result, error } = await sb.rpc(
        action === 'delAdvance' ? 'maestro_delete_advance' : 'maestro_delete_payout',
        { p_id: id, p_actor_user_id: appUserResult.data.id },
      );
      if (error) return json({ error: error.message }, 500);
      if (!result?.ok) {
        const code = String(result?.error || 'invalid_request');
        return json(result, code.endsWith('_not_found') ? 404 : 409);
      }
      return json(result);
    }

    if (action === 'setSettings') {
      if (!canEditSettings) return json({ error: 'forbidden' }, 403);
      // The only place a client names columns. Passing the payload straight
      // through let it rewrite the row's own id and orphan every setting.
      const allowed = ['shift_start', 'salon_lat', 'salon_lng', 'salon_radius'];
      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (payload[key] !== undefined) patch[key] = payload[key];
      }
      // The month's revenue target. Null clears it; anything else must be a
      // whole, non-negative sum, the same bound the column's check enforces.
      if (payload.monthly_revenue_goal !== undefined) {
        const goal = payload.monthly_revenue_goal === null ? null : Math.round(Number(payload.monthly_revenue_goal));
        if (goal !== null && (!Number.isFinite(goal) || goal < 0 || goal > 100_000_000_000)) {
          return json({ error: 'invalid_goal' }, 400);
        }
        patch.monthly_revenue_goal = goal;
      }
      // Minutes after a master's own scheduled start before he counts as late.
      if (payload.late_grace_minutes !== undefined) {
        const grace = Number(payload.late_grace_minutes);
        if (!Number.isInteger(grace) || grace < 0 || grace > 120) {
          return json({ error: 'invalid_late_grace' }, 400);
        }
        patch.late_grace_minutes = grace;
      }
      // The automatic fines: for a late arrival, and for no mark by 18:00.
      for (const key of ['late_fine_amount', 'no_mark_fine_amount']) {
        if (payload[key] === undefined) continue;
        const amount = Number(payload[key]);
        if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000) {
          return json({ error: 'invalid_fine' }, 400);
        }
        patch[key] = amount;
      }
      if (!Object.keys(patch).length) return json({ error: 'no_settings_to_update' }, 400);
      const { error } = await sb.from('settings').update(patch).eq('id', 1);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (['addExpense', 'addRentOffset', 'delExpense', 'addDebt', 'addDebtPayment', 'delDebtPayment', 'delDebt', 'setDebtClosed'].includes(action)) {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
    }

    if (action === 'addExpense') {
      const date = String(payload.date ?? '');
      const amountUzs = Math.round(Number(payload.amount_uzs));
      if (!isValidIsoDate(date) || !Number.isFinite(amountUzs) || amountUzs <= 0) {
        return json({ error: 'invalid_expense' }, 400);
      }
      const { error } = await sb.from('expenses').insert({
        date,
        section: payload.section,
        name: payload.name,
        qty: payload.qty || null,
        amount_uzs: amountUzs,
        usd_rate: payload.usd_rate || null,
        minus_from: payload.minus_from || null,
        note: payload.note || null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'addRentOffset') {
      const owner = String(payload.owner || '');
      const amountUsd = Number(payload.amount_usd);
      const usdRate = Number(payload.usd_rate);
      const amountUzs = Math.round(amountUsd * usdRate);
      const date = String(payload.date || '');
      if (!['murod', 'jamshid'].includes(owner)
        || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(amountUsd)
        || !Number.isFinite(usdRate)
        || amountUsd <= 0
        || usdRate <= 0
        || amountUzs <= 0) {
        return json({ error: 'invalid_rent_offset' }, 400);
      }
      const ownerName = owner === 'murod' ? 'Мурод' : 'Жамшид';
      const { error } = await sb.from('expenses').insert({
        date,
        section: 'ishxona',
        category: 'rent_offset',
        name: `Взаимозачёт аренды · ${ownerName}`,
        qty: null,
        amount_uzs: amountUzs,
        usd_rate: usdRate,
        minus_from: owner,
        note: payload.note ? String(payload.note).trim().slice(0, 500) : null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'delExpense') {
      // A purchase for Склад is removed with its receipt, or the shelf would
      // keep goods nobody paid for.
      const linked = await sb.from('product_receipts').select('id').eq('expense_id', payload.id).maybeSingle();
      if (!linked.error && linked.data) return json({ error: 'expense_belongs_to_stock' }, 409);
      const { data: result, error } = await sb.rpc('maestro_delete_expense', {
        p_id: payload.id,
        p_actor_user_id: appUserResult.data.id,
        p_source: 'web_app',
      });
      const response = auditedDeleteResponse(action, result, error);
      return json(response.body, response.status);
    }

    if (action === 'addDebt') {
      const amount = Number(payload.amount);
      const currency = payload.currency === 'USD' ? 'USD' : 'UZS';
      if (!payload.counterparty || !Number.isFinite(amount) || amount <= 0) {
        return json({ error: 'invalid_debt' }, 400);
      }
      const { error } = await sb.from('debts').insert({
        counterparty: payload.counterparty,
        direction: payload.direction,
        amount,
        currency,
        start_date: payload.start_date || null,
        note: payload.note || null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'addDebtPayment') {
      const amount = Number(payload.amount);
      const date = String(payload.date ?? '');
      if (!payload.debt_id || !isValidIsoDate(date) || !Number.isFinite(amount) || amount <= 0) {
        return json({ error: 'invalid_debt_payment' }, 400);
      }
      const { error } = await sb.from('debt_payments').insert({
        debt_id: payload.debt_id,
        date,
        amount,
        note: payload.note || null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'delDebtPayment') {
      const { data: result, error } = await sb.rpc('maestro_delete_debt_payment', {
        p_id: payload.id,
        p_actor_user_id: appUserResult.data.id,
        p_source: 'web_app',
      });
      const response = auditedDeleteResponse(action, result, error);
      return json(response.body, response.status);
    }

    if (action === 'delDebt') {
      const { data: result, error } = await sb.rpc('maestro_delete_debt', {
        p_id: payload.id,
        p_actor_user_id: appUserResult.data.id,
        p_source: 'web_app',
      });
      const response = auditedDeleteResponse(action, result, error);
      return json(response.body, response.status);
    }

    if (action === 'setDebtClosed') {
      if (!payload.id || typeof payload.is_closed !== 'boolean') {
        return json({ error: 'invalid_debt_state' }, 400);
      }
      const { error } = await sb.from('debts')
        .update({ is_closed: payload.is_closed })
        .eq('id', payload.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (error) {
    console.error('[maestro-api] unhandled error', { action: monitoredAction, error: String(error) });
    await captureEdgeException(error, {
      function: 'api',
      action: monitoredAction,
      http_status: 500,
      role_class: monitoredRole,
      request_id: requestId,
    });
    return json({ error: String(error) }, 500);
  }
});
