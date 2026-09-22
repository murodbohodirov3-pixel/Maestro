// Morning new-client digest for the marketing group.
//
// pg_cron (see supabase/migrations/*_marketing_digest_cron.sql) calls this at
// 05:00 UTC = 10:00 Tashkent with {action:"send"}. The function reads sales
// through the service key, builds the message in digest.js and posts it to the
// chat in MARKETING_DIGEST_CHAT_ID through the Maestro bot. Nothing here
// writes to the database, and no Telegram update ever reaches this function:
// the bot only speaks, it never listens, so there are no commands to abuse.
//
// Secrets: MARKETING_DIGEST_SECRET (shared with the cron job through Vault),
// BOT_TOKEN (already used by api for Telegram login), MARKETING_DIGEST_CHAT_ID.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.2';
import { buildDigest, digestRanges, isValidIsoDate, isoDateInTimeZone } from './digest.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const DIGEST_SECRET = Deno.env.get('MARKETING_DIGEST_SECRET') || '';
const BOT_TOKEN = Deno.env.get('BOT_TOKEN') || '';
const CHAT_ID = Deno.env.get('MARKETING_DIGEST_CHAT_ID') || '';
const PAGE_SIZE = 1000;

type Row = Record<string, unknown>;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function secureEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

async function fetchSales(from: string, to: string) {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    // Ordering by date alone leaves rows that share a date in an undefined
    // order, so a page boundary can repeat or skip one. id breaks the tie.
    const { data, error } = await sb.from('sales')
      .select('id,d,sale_date,cl,clients_count,is_new_client,status,comment')
      .gte('d', from)
      .lte('d', to)
      .order('d', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as Row[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function telegram(method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(`telegram_${method}_failed: ${response.status} ${payload.description || ''}`.trim());
  }
  return payload.result;
}

async function composeDigest(today: string) {
  const ranges = digestRanges(today);
  const sales = await fetchSales(ranges.load.from, ranges.load.to);
  return buildDigest(sales, today);
}

// Setup helper: after the bot is added to the marketing group, this lists the
// chats Telegram has queued for it so the owner can copy the group id into
// MARKETING_DIGEST_CHAT_ID. getUpdates refuses to work while a webhook is
// registered, so that state is reported instead of hidden.
async function listChats() {
  const me = await telegram('getMe', {}) as Row;
  const webhook = await telegram('getWebhookInfo', {}) as Row;
  if (webhook.url) {
    return { bot: me.username, webhook: webhook.url, chats: [], note: 'webhook_registered_getUpdates_unavailable' };
  }
  const updates = await telegram('getUpdates', { limit: 100 }) as Row[];
  const chats = new Map<string, Row>();
  for (const update of updates) {
    const chat = ((update.message as Row)?.chat || (update.my_chat_member as Row)?.chat) as Row | undefined;
    if (chat?.id != null) chats.set(String(chat.id), { id: chat.id, type: chat.type, title: chat.title || chat.username || chat.first_name || '' });
  }
  return { bot: me.username, webhook: null, chats: [...chats.values()] };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!DIGEST_SECRET || !secureEqual(req.headers.get('x-marketing-digest-secret') || '', DIGEST_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: Row = {};
  try {
    payload = await req.json() as Row;
  } catch {
    payload = {};
  }
  const action = String(payload.action || 'send');

  try {
    if (action === 'chats') return json(await listChats());

    // A date override exists so the message can be checked for any day before
    // the real one goes out; the cron job never sends one.
    const today = isValidIsoDate(payload.today) ? String(payload.today) : isoDateInTimeZone();
    if (action === 'preview') {
      const digest = await composeDigest(today);
      return json({ today, ...digest });
    }
    if (action !== 'send') return json({ error: 'unknown_action' }, 400);

    const chatId = String(payload.chat_id || CHAT_ID);
    if (!chatId) return json({ error: 'chat_not_configured' }, 500);
    const digest = await composeDigest(today);
    const message = await telegram('sendMessage', {
      chat_id: chatId,
      text: digest.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }) as Row;
    console.log('[marketing-digest] sent', { today, chatId, messageId: message.message_id });
    return json({ ok: true, today, chat_id: chatId, message_id: message.message_id, text: digest.text });
  } catch (error) {
    console.error('[marketing-digest] failed', { action, error: String(error) });
    return json({ error: 'digest_failed', detail: String(error).slice(0, 300) }, 500);
  }
});
