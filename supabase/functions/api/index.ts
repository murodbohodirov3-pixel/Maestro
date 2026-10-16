// Pinned like the other functions: an unpinned major let a redeploy change the
// shape of error objects without a single line of code changing.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.2';
import { auditedDeleteResponse } from './deleteAudit.js';
import { captureEdgeException } from '../_shared/sentry.ts';
import {
  ADMIN_ROLE,
  adminMayCall,
  expenseForPartner,
  partnerMayCall,
  PARTNER_ROLE,
  stockForDesk,
} from '../_shared/access.js';

const BOT_TOKEN = Deno.env.get('BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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

async function fetchAppointments(filters: Record<string, string | number> = {}) {
  const rows: Record<string, unknown>[] = [];
  const fromDate = `${tashkentDate(-60)}T00:00:00+05:00`;
  const toDate = `${tashkentDate(180)}T00:00:00+05:00`;

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from('appointments').select('*, client:clients(lifecycle_status)');
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
      const { client: _privateClient, ...appointment } = row;
      return {
        ...appointment,
        client_is_blocked: client?.lifecycle_status === 'blocked',
      };
    }));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
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
        .select('id, role, master_id, active')
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
          .select('id, role, master_id, active')
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
        .select('id, role, master_id, active')
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
        .in('entity_type', ['fine', 'expense', 'debt', 'debt_payment', 'sale', 'attendance', 'product_receipts', 'product_sales', 'product_writeoffs'])
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
      return json({
        role: 'frontdesk',
        appRole: appUserResult.data.role,
        ...desk,
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
        const [sales, fines, attendance, expenses, debts, debt_payments, booking_services, master_day_statuses, appointments, master_schedule_rules, clients, products, product_receipts, product_sales, product_writeoffs] = await Promise.all([
          fetchAllRows('sales', 'd', {}, byDay),
          fetchAllRows('fines', 'id', {}, byDay),
          fetchAllRows('attendance', 'id', {}, byDay),
          fetchAllRows('expenses', 'date', {}, byDate),
          isAdmin ? fetchAllRows('debts', 'id') : Promise.resolve([]),
          isAdmin ? fetchAllRows('debt_payments', 'date', {}, byDate) : Promise.resolve([]),
          canManageCalendar ? fetchAllRows('booking_services', 'id') : Promise.resolve([]),
          // A partner reads the attendance register, and a day off is part of it.
          canManageCalendar || isPartner ? fetchAllRows('master_day_statuses', 'work_date') : Promise.resolve([]),
          canManageCalendar ? fetchAppointments() : Promise.resolve([]),
          // Everyone who sees attendance needs the schedule: a late arrival is
          // measured against the master's own shift, not only the salon cutoff.
          fetchAllRows('master_schedule_rules', 'iso_weekday'),
          canManageClients ? fetchAllRows('client_export', 'last_contact_at') : Promise.resolve([]),
          // Склад is small and bounded by the shelf, so it always comes whole.
          fetchStockRows('products', 'id'),
          fetchStockRows('product_receipts', 'receipt_date'),
          fetchStockRows('product_sales', 'sale_date'),
          fetchStockRows('product_writeoffs', 'writeoff_date'),
        ]);

        return json({
          role: 'admin',
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
          appRole: appUserResult.data.role,
          sessionToken: issuedSessionToken,
          windowSince: since,
        });
      }

      const [sales, fines, attendance, booking_services, master_day_statuses, appointments, master_schedule_rules] = await Promise.all([
        fetchAllRows('sales', 'd', { master: myMaster }, byDay),
        fetchAllRows('fines', 'id', { master: myMaster }, byDay),
        fetchAllRows('attendance', 'id', { master: myMaster }, byDay),
        fetchAllRows('booking_services', 'id'),
        fetchAllRows('master_day_statuses', 'work_date', { master_id: myMasterId! }),
        fetchAppointments({ master_id: myMasterId! }),
        fetchAllRows('master_schedule_rules', 'iso_weekday', { master_id: myMasterId! }),
      ]);
      const meOnly = masters.filter((master: { name: string }) => master.name === myMaster);

      return json({
        role: 'master',
        appRole: appUserResult.data.role,
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
        sessionToken: issuedSessionToken,
        windowSince: since,
      });
    }

    if (action === 'addSale') {
      const master = isAdmin ? payload.master : myMaster;
      const requiresOwnerApproval = !isAdmin;
      const cash = Math.max(0, Math.round(Number(payload.cash) || 0));
      const card = Math.max(0, Math.round(Number(payload.card) || 0));
      const qr = Math.max(0, Math.round(Number(payload.qr) || 0));
      const clientsCount = Math.max(0, Math.trunc(Number(payload.clients_count ?? payload.cl) || 0));
      const isNewClient = clientsCount === 0
        ? null
        : payload.is_new_client === true
          ? true
          : payload.is_new_client === false
            ? false
            : null;

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

      const row: Record<string, unknown> = {
        master,
        d,
        cash,
        card,
        qr,
        cl: clientsCount,
        clients_count: clientsCount,
        is_new_client: isNewClient,
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
        if (error.code === '23505') return json({ ok: true, deduplicated: true });
        // Deployed ahead of the migration that adds the column: keep the sale
        // rather than losing it, and fall back to the client-side guard.
        if (error.code === '42703' || error.code === 'PGRST204') {
          delete row.client_request_id;
          ({ error } = await sb.from('sales').insert(row));
        }
      }
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
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
      return json({ ok: true });
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
      return json({ ok: true });
    }

    if (action === 'setMasterDayOff') {
      if (!canManageCalendar) return json({ error: 'forbidden' }, 403);
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
