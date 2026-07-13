import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const CONTENT_SECRET = Deno.env.get('AGENTS_CONTENT_SECRET') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Row = Record<string, unknown>;
type JobStatus = 'draft' | 'approved' | 'generating' | 'completed' | 'failed' | 'cancelled';

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

function text(value: unknown, max = 5000) {
  return String(value || '').trim().slice(0, max);
}

function strings(value: unknown, maxItems = 20) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => text(item, 1000)).filter(Boolean)
    : [];
}

function owner(payload: Row) {
  const value = text(payload.ownerTelegramId, 32);
  if (!/^\d{3,32}$/.test(value)) throw new Error('invalid_owner');
  return value;
}

function jobId(payload: Row) {
  const value = Math.trunc(Number(payload.jobId));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_job_id');
  return value;
}

async function getJob(id: number, ownerTelegramId: string) {
  const { data, error } = await sb.from('agent_content_jobs')
    .select('*').eq('id', id).eq('owner_telegram_id', ownerTelegramId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('job_not_found');
  return data;
}

async function transition(
  id: number,
  ownerTelegramId: string,
  allowed: JobStatus[],
  next: JobStatus,
  extra: Row = {},
) {
  const current = await getJob(id, ownerTelegramId) as Row;
  if (!allowed.includes(String(current.status) as JobStatus)) throw new Error('invalid_status_transition');
  const { data, error } = await sb.from('agent_content_jobs').update({
    ...extra,
    status: next,
    updated_at: new Date().toISOString(),
  }).eq('id', id).eq('owner_telegram_id', ownerTelegramId).eq('status', current.status)
    .select('*').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('concurrent_update');
  return data;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!CONTENT_SECRET || !secureEqual(req.headers.get('x-agents-content-secret') || '', CONTENT_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const payload = await req.json() as Row;
    const action = text(payload.action, 30);
    const ownerTelegramId = owner(payload);

    if (action === 'create') {
      const draft = (payload.draft && typeof payload.draft === 'object' ? payload.draft : {}) as Row;
      const insert = {
        owner_telegram_id: ownerTelegramId,
        kind: text(draft.kind, 20) || 'reel',
        topic: text(draft.topic, 300),
        goal: text(draft.goal, 100),
        concept: text(draft.concept),
        hook: text(draft.hook),
        shot_list: strings(draft.shotList),
        voiceover: text(draft.voiceover),
        on_screen_text: strings(draft.onScreenText),
        higgsfield_prompt: text(draft.higgsfieldPrompt, 12000),
        negative_prompt: text(draft.negativePrompt),
        cover_text: text(draft.coverText, 200),
        caption: text(draft.caption),
        cta: text(draft.cta, 500),
        stories: strings(draft.stories),
        kpi: text(draft.kpi, 1000),
        metadata: { source: 'telegram-ai-team', version: 1 },
      };
      if (!insert.topic || !insert.goal || !insert.concept || !insert.higgsfield_prompt) {
        return json({ error: 'invalid_draft' }, 400);
      }
      const { data, error } = await sb.from('agent_content_jobs').insert(insert).select('*').single();
      if (error) throw error;
      return json({ job: data }, 201);
    }

    if (action === 'get') return json({ job: await getJob(jobId(payload), ownerTelegramId) });
    if (action === 'list') {
      const { data, error } = await sb.from('agent_content_jobs').select('*')
        .eq('owner_telegram_id', ownerTelegramId).order('created_at', { ascending: false }).limit(10);
      if (error) throw error;
      return json({ jobs: data || [] });
    }
    if (action === 'approve') {
      return json({ job: await transition(jobId(payload), ownerTelegramId, ['draft'], 'approved', {
        approved_at: new Date().toISOString(),
      }) });
    }
    if (action === 'cancel') {
      return json({ job: await transition(jobId(payload), ownerTelegramId, ['draft', 'approved'], 'cancelled') });
    }
    if (action === 'start') {
      return json({ job: await transition(jobId(payload), ownerTelegramId, ['approved'], 'generating', {
        provider_job_id: text(payload.providerJobId, 200),
        started_at: new Date().toISOString(),
      }) });
    }
    if (action === 'complete') {
      return json({ job: await transition(jobId(payload), ownerTelegramId, ['generating'], 'completed', {
        result_url: text(payload.resultUrl, 4000),
        completed_at: new Date().toISOString(),
        error_message: null,
      }) });
    }
    if (action === 'fail') {
      return json({ job: await transition(jobId(payload), ownerTelegramId, ['approved', 'generating'], 'failed', {
        error_message: text(payload.errorMessage, 1000) || 'generation_failed',
        completed_at: new Date().toISOString(),
      }) });
    }

    return json({ error: 'unknown_action' }, 400);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const clientErrors = ['invalid_owner', 'invalid_job_id', 'job_not_found', 'invalid_status_transition'];
    const status = clientErrors.includes(message) ? 409 : 500;
    console.error('[agents-content] failed', { error: message });
    return json({ error: status === 409 ? message : 'content_job_failed' }, status);
  }
});
