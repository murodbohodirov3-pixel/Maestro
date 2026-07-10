import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BOT_TOKEN = Deno.env.get('BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

    const { data, error } = await query
      .order(orderColumn, { ascending: true })
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
    let myMaster: string | null = null;
    if (appUserResult.data.master_id) {
      const masterMatch = await sb
        .from('masters')
        .select('name, active')
        .eq('id', appUserResult.data.master_id)
        .maybeSingle();
      if (masterMatch.error) return json({ error: masterMatch.error.message }, 500);
      if (masterMatch.data?.active) myMaster = masterMatch.data.name;
    }

    if (!isAdmin && !myMaster) return json({ error: 'not_in_list' }, 403);

    if (action === 'load') {
      const masters = (await sb.from('masters').select('*').order('id')).data ?? [];
      const settings = (await sb.from('settings').select('*').eq('id', 1)).data ?? [];

      if (isAdmin) {
        const [sales, fines, attendance, expenses, debts, debt_payments] = await Promise.all([
          fetchAllRows('sales', 'd'),
          fetchAllRows('fines', 'id'),
          fetchAllRows('attendance', 'id'),
          fetchAllRows('expenses', 'date'),
          fetchAllRows('debts', 'id'),
          fetchAllRows('debt_payments', 'date'),
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
          sessionToken: issuedSessionToken,
        });
      }

      const [sales, fines, attendance] = await Promise.all([
        fetchAllRows('sales', 'd', { master: myMaster }),
        fetchAllRows('fines', 'id', { master: myMaster }),
        fetchAllRows('attendance', 'id', { master: myMaster }),
      ]);
      const meOnly = masters.filter((master: { name: string }) => master.name === myMaster);

      return json({ role: 'master', me: myMaster, masters: meOnly, settings, sales, fines, attendance, sessionToken: issuedSessionToken });
    }

    if (action === 'addSale') {
      const master = isAdmin ? payload.master : myMaster;
      const requiresOwnerApproval = !isAdmin;
      const { error } = await sb.from('sales').insert({
        master,
        d: payload.d,
        cash: payload.cash || 0,
        card: payload.card || 0,
        qr: payload.qr || 0,
        cl: payload.cl || 0,
        is_new_client: payload.is_new_client,
        status: requiresOwnerApproval ? 'pending' : 'approved',
        approved_by: requiresOwnerApproval ? null : String(uid),
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
          approved_by: String(uid),
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
      const existing = await sb.from('fines').select('id,d').eq('id', payload.id).maybeSingle();
      if (existing.error) return json({ error: existing.error.message }, 500);
      if (!existing.data) return json({ error: 'fine_not_found' }, 404);
      if (existing.data.d < tashkentDate(-7)) return json({ error: 'fine_delete_window_expired' }, 403);
      const { error } = await sb.from('fines').delete().eq('id', payload.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
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
      await sb.from('expenses').delete().eq('id', payload.id);
      return json({ ok: true });
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
      await sb.from('debt_payments').delete().eq('id', payload.id);
      return json({ ok: true });
    }

    if (action === 'delDebt') {
      await sb.from('debts').delete().eq('id', payload.id);
      return json({ ok: true });
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
