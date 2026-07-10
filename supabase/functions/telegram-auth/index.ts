import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return result === 0;
}

async function hmacSha256(key: string | ArrayBuffer, data: string) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function validateTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');

  if (!hash) {
    return { ok: false as const, status: 401, error: 'invalid telegram signature' };
  }

  params.delete('hash');

  const authDate = params.get('auth_date');
  if (!authDate) {
    return { ok: false as const, status: 401, error: 'missing auth_date' };
  }

  const authTimestamp = Number(authDate);
  const nowTimestamp = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authTimestamp) || nowTimestamp - authTimestamp > 24 * 60 * 60) {
    return { ok: false as const, status: 401, error: 'telegram auth expired' };
  }

  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = await hmacSha256('WebAppData', botToken);
  const calculatedHash = bytesToHex(await hmacSha256(secretKey, dataCheckString));

  if (!timingSafeEqual(calculatedHash, hash)) {
    return { ok: false as const, status: 401, error: 'invalid telegram signature' };
  }

  const userValue = params.get('user');
  if (!userValue) {
    return { ok: false as const, status: 401, error: 'missing telegram user' };
  }

  let telegramUser: { id?: number | string };
  try {
    telegramUser = JSON.parse(userValue);
  } catch {
    return { ok: false as const, status: 401, error: 'invalid telegram user' };
  }

  if (!telegramUser.id) {
    return { ok: false as const, status: 401, error: 'missing telegram user id' };
  }

  return { ok: true as const, telegramId: String(telegramUser.id) };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
  }

  // BOT_TOKEN is the name already used by the legacy `api` function.
  // Keep it as a fallback while the React auth function is introduced.
  const telegramBotToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || Deno.env.get('BOT_TOKEN');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!telegramBotToken || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: 'server auth is not configured' }, 500);
  }

  let payload: { initData?: string };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid json payload' }, 400);
  }

  if (!payload.initData) {
    return jsonResponse({ ok: false, error: 'missing initData' }, 400);
  }

  const telegramCheck = await validateTelegramInitData(payload.initData, telegramBotToken);
  if (!telegramCheck.ok) {
    return jsonResponse({ ok: false, error: telegramCheck.error }, telegramCheck.status);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: user, error } = await supabase
    .from('app_users')
    .select('id,name,telegram_id,role,master_id,active')
    .eq('telegram_id', telegramCheck.telegramId)
    .maybeSingle();

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  if (!user) {
    return jsonResponse({ ok: false, error: 'user not allowed' }, 403);
  }

  if (!user.active) {
    return jsonResponse({ ok: false, error: 'user inactive' }, 403);
  }

  return jsonResponse({ ok: true, user });
});
