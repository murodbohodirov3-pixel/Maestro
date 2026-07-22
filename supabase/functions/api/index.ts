import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { auditedDeleteResponse } from './deleteAudit.js';

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
) {
  const rows: Record<string, unknown>[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from(table).select('*');
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);

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

async function fetchAppointments(filters: Record<string, string | number> = {}) {
  const rows: Record<string, unknown>[] = [];
  const fromDate = `${tashkentDate(-60)}T00:00:00+05:00`;
  const toDate = `${tashkentDate(180)}T00:00:00+05:00`;

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from('appointments').select('*');
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query
      .gte('starts_at', fromDate)
      .lt('starts_at', toDate)
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
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

async function verifyMiniApp(initData: string): Promise<{ id: number; first_name?: string } | null> {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

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

  try {
    const { initData, tgAuth, sessionToken, action, payload = {} } = await req.json();
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
      if (!user) return json({ error: 'unauthorized' }, 401);
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

    console.log('[maestro-api] authorized action', { action, role: appUserResult.data.role });

    const isAdmin = ['owner', 'admin', 'finance'].includes(appUserResult.data.role);
    const canManageCalendar = ['owner', 'admin'].includes(appUserResult.data.role);
    const canManageClients = ['owner', 'admin'].includes(appUserResult.data.role);
    let myMaster: string | null = null;
    let myMasterId: number | null = null;
    if (appUserResult.data.master_id) {
      const masterMatch = await sb
        .from('masters')
        .select('name, active')
        .eq('id', appUserResult.data.master_id)
        .maybeSingle();
      if (masterMatch.error) return json({ error: masterMatch.error.message }, 500);
      if (masterMatch.data?.active) {
        myMaster = masterMatch.data.name;
        myMasterId = Number(appUserResult.data.master_id);
      }
    }

    if (!isAdmin && !myMaster) return json({ error: 'not_in_list' }, 403);

    if (action === 'listAuditEvents') {
      if (appUserResult.data.role !== 'owner') return json({ error: 'forbidden' }, 403);

      const limit = Math.min(Math.max(Math.trunc(Number(payload.limit) || 50), 1), 100);
      const cursor = String(payload.cursor || '').trim();
      let query = sb
        .from('audit_events')
        .select('id,occurred_at,entity_type,entity_id,operation,event_name,actor_user_id,actor_name,actor_role,actor_external_id,source,correlation_id,changed_fields,old_values,new_values,metadata')
        .eq('operation', 'delete')
        .in('entity_type', ['fine', 'expense', 'debt', 'debt_payment'])
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

    if (action === 'load') {
      const masters = (await sb.from('masters').select('*').order('id')).data ?? [];
      const settings = (await sb.from('settings').select('*').eq('id', 1)).data ?? [];

      if (isAdmin) {
        const [sales, fines, attendance, expenses, debts, debt_payments, booking_services, master_day_statuses, appointments, master_schedule_rules, clients] = await Promise.all([
          fetchAllRows('sales', 'd'),
          fetchAllRows('fines', 'id'),
          fetchAllRows('attendance', 'id'),
          fetchAllRows('expenses', 'date'),
          fetchAllRows('debts', 'id'),
          fetchAllRows('debt_payments', 'date'),
          canManageCalendar ? fetchAllRows('booking_services', 'id') : Promise.resolve([]),
          canManageCalendar ? fetchAllRows('master_day_statuses', 'work_date') : Promise.resolve([]),
          canManageCalendar ? fetchAppointments() : Promise.resolve([]),
          canManageCalendar ? fetchAllRows('master_schedule_rules', 'iso_weekday') : Promise.resolve([]),
          canManageClients ? fetchAllRows('client_export', 'last_contact_at') : Promise.resolve([]),
        ]);

        return json({
          role: 'admin',
          masters,
          settings,
          sales,
          fines,
          attendance,
          expenses,
          debts,
          debt_payments,
          booking_services,
          master_day_statuses,
          appointments,
          master_schedule_rules,
          clients,
          appRole: appUserResult.data.role,
          sessionToken: issuedSessionToken,
        });
      }

      const [sales, fines, attendance, booking_services, master_day_statuses, appointments, master_schedule_rules] = await Promise.all([
        fetchAllRows('sales', 'd', { master: myMaster }),
        fetchAllRows('fines', 'id', { master: myMaster }),
        fetchAllRows('attendance', 'id', { master: myMaster }),
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

      if (!master || !payload.d || cash + card + qr <= 0) {
        return json({ error: 'invalid_sale' }, 400);
      }

      const { error } = await sb.from('sales').insert({
        master,
        d: payload.d,
        cash,
        card,
        qr,
        cl: clientsCount,
        clients_count: clientsCount,
        is_new_client: isNewClient,
        status: requiresOwnerApproval ? 'pending' : 'approved',
        approved_by: requiresOwnerApproval ? null : String(appUserResult.data.id),
        approved_at: requiresOwnerApproval ? null : new Date().toISOString(),
        comment: requiresOwnerApproval ? 'owner_approval_required' : null,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'setSaleApproval') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      if (!['approved', 'rejected'].includes(payload.status)) {
        return json({ error: 'invalid_sale_status' }, 400);
      }

      const existing = await sb
        .from('sales')
        .select('id, comment')
        .eq('id', payload.id)
        .maybeSingle();
      if (existing.error) return json({ error: existing.error.message }, 500);
      if (!existing.data || !['owner_approval_required', 'owner_approval_rejected'].includes(existing.data.comment)) {
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
        .eq('id', payload.id);
      if (error) {
        console.error('[maestro-api] sale approval failed', { saleId: payload.id, error: error.message });
        return json({ error: error.message }, 500);
      }
      console.log('[maestro-api] sale approval saved', { saleId: payload.id, status: payload.status });
      return json({ ok: true });
    }

    if (action === 'delSale') {
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
      await sb
        .from('attendance')
        .upsert({ master, d: payload.d, arrived: payload.arrived }, { onConflict: 'master,d' });
      return json({ ok: true });
    }

    if (action === 'delAttendance') {
      const master = isAdmin ? payload.master : myMaster;
      await sb.from('attendance').delete().eq('master', master).eq('d', payload.d);
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
        const conflict = ['slot_already_booked', 'master_day_off'].includes(result?.error);
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
      if (!result?.ok) return json(result, result?.error === 'appointment_not_found' ? 404 : 400);
      return json(result);
    }

    if (action === 'addFine') {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      const amount = Math.round(Number(payload.amount) || 0);
      if (!payload.master || !payload.d || amount <= 0) return json({ error: 'invalid_fine' }, 400);
      const { error } = await sb.from('fines').insert({ master: payload.master, d: payload.d, amount });
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
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
      await sb.from('settings').update(payload).eq('id', 1);
      return json({ ok: true });
    }

    if (['addExpense', 'delExpense', 'addDebt', 'addDebtPayment', 'delDebtPayment', 'delDebt', 'setDebtClosed'].includes(action)) {
      if (!isAdmin) return json({ error: 'forbidden' }, 403);
    }

    if (action === 'addExpense') {
      await sb.from('expenses').insert({
        date: payload.date,
        section: payload.section,
        name: payload.name,
        qty: payload.qty || null,
        amount_uzs: payload.amount_uzs,
        usd_rate: payload.usd_rate || null,
        minus_from: payload.minus_from || null,
        note: payload.note || null,
      });
      return json({ ok: true });
    }

    if (action === 'delExpense') {
      const { data: result, error } = await sb.rpc('maestro_delete_expense', {
        p_id: payload.id,
        p_actor_user_id: appUserResult.data.id,
        p_source: 'web_app',
      });
      const response = auditedDeleteResponse(action, result, error);
      return json(response.body, response.status);
    }

    if (action === 'addDebt') {
      await sb.from('debts').insert({
        counterparty: payload.counterparty,
        direction: payload.direction,
        amount: payload.amount,
        currency: payload.currency || 'UZS',
        start_date: payload.start_date || null,
        note: payload.note || null,
      });
      return json({ ok: true });
    }

    if (action === 'addDebtPayment') {
      await sb.from('debt_payments').insert({
        debt_id: payload.debt_id,
        date: payload.date,
        amount: payload.amount,
        note: payload.note || null,
      });
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
      await sb.from('debts').update({ is_closed: payload.is_closed }).eq('id', payload.id);
      return json({ ok: true });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (error) {
    console.error('[maestro-api] unhandled error', { action: 'unknown', error: String(error) });
    return json({ error: String(error) }, 500);
  }
});
