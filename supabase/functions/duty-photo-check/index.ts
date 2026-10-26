// duty-photo-check — is the duty master's photo of a zone clean? (owner's
// decisions of 2026-10-26). It runs in the Maestro AI project, where the
// Anthropic key already lives, so the key never leaves it; the Maestro api
// calls it with the shared secret DUTY_CHECK_SECRET:
//   POST {images: [<jpeg base64>, …1–3], zone: "Кухня", checklist: "стол, раковина, …"}
//   → {ok, checked, shows_zone, clean, reason_ru, reason_uz, model}
// The photos are one zone from different angles, judged together. A zone not
// shown, or shown dirty, comes back with a short reason in Russian and Uzbek;
// the api then does not count it.
// Deploy: supabase functions deploy duty-photo-check --project-ref
// kzqsqjfoctyyovtvykcc --no-verify-jwt (from the Maestro-App repository).
import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { secretsMatch } from '../_shared/bookingCore.js';
import { DUTY_CHECK_SCHEMA, DUTY_CHECK_SYSTEM, dutyCheckPrompt, dutyVerdict } from '../_shared/duty.js';

const SECRET = Deno.env.get('DUTY_CHECK_SECRET') || '';
// ANTHROPIC_API_KEY comes from the project's secrets.
const client = new Anthropic();

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return reply({ ok: false }, 405);
  if (!secretsMatch(request.headers.get('x-duty-check-secret'), SECRET)) return reply({ ok: false }, 401);

  const input = await request.json().catch(() => ({})) as Record<string, unknown>;
  const images = (Array.isArray(input.images) ? input.images : []).map((image) => String(image ?? ''));
  const zone = String(input.zone ?? '').slice(0, 40);
  const checklist = String(input.checklist ?? '').slice(0, 200);
  const isJpeg = (image: string) => image.length >= 1000 && image.length <= 3_000_000 && /^[A-Za-z0-9+/]+=*$/.test(image);
  if (!zone || images.length < 1 || images.length > 3 || !images.every(isJpeg)) {
    return reply({ ok: false, error: 'invalid_request' }, 400);
  }

  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      // A declined request is re-run on Anthropic's recommended fallback.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: DUTY_CHECK_SCHEMA },
      },
      system: DUTY_CHECK_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          ...images.map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: image } })),
          { type: 'text', text: dutyCheckPrompt(zone, checklist, images.length) },
        ],
      }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    // Every model in the chain declined: the photo is left unchecked, never
    // held against the master.
    if (response.stop_reason === 'refusal') return reply({ ok: true, checked: false, reason: 'refusal' });
    const text = response.content.find((block) => block.type === 'text');
    const verdict = dutyVerdict(text && 'text' in text ? text.text : '');
    if (!verdict) return reply({ ok: true, checked: false, reason: 'unparsed' });
    return reply({ ok: true, checked: true, ...verdict, model: response.model });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) console.warn('[duty-photo-check] rate limited');
    else if (error instanceof Anthropic.APIError) console.error('[duty-photo-check] api error', error.status, error.message);
    else console.error('[duty-photo-check] failed', error instanceof Error ? error.message : String(error));
    return reply({ ok: true, checked: false, reason: 'unavailable' });
  }
});
