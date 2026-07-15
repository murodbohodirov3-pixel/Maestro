import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getSecretKey(): string {
  const direct = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (direct) return direct;
  const keyMap = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keyMap) {
    const parsed = JSON.parse(keyMap) as Record<string, string>;
    if (parsed.default) return parsed.default;
  }
  return required("SUPABASE_SERVICE_ROLE_KEY");
}

function secretsMatch(actual: string | null, expected: string): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (request) => {
  if (request.method === "GET") return json({ ok: true, service: "customer-booking-approval" });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expectedSecret = required("MAESTRO_BOOKING_APPROVAL_SECRET");
  if (!secretsMatch(request.headers.get("x-maestro-booking-secret"), expectedSecret)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8192) return json({ ok: false, error: "request_too_large" }, 413);

  try {
    const input = await request.json() as Record<string, unknown>;
    const bookingRequestId = String(input.booking_request_id ?? "").trim().toLowerCase();
    const serviceIds = Array.isArray(input.service_ids)
      ? [...new Set(input.service_ids.map((value) => String(value).trim()).filter(Boolean))]
      : [];
    const masterId = Number(input.barber_id);
    const startsAt = String(input.starts_at ?? "").trim();
    const clientName = String(input.client_name ?? "").trim();
    const clientPhone = String(input.client_phone ?? "").trim();

    if (!validUuid(bookingRequestId) || !serviceIds.length || serviceIds.length > 10
      || !Number.isSafeInteger(masterId) || masterId <= 0 || Number.isNaN(Date.parse(startsAt))
      || !clientName || clientName.length > 120 || !clientPhone) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }

    const db = createClient(required("SUPABASE_URL"), getSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db.rpc("maestro_approve_external_booking", {
      p_external_booking_request_id: bookingRequestId,
      p_service_ids: serviceIds,
      p_master_id: masterId,
      p_starts_at: startsAt,
      p_client_name: clientName,
      p_client_phone: clientPhone,
      p_notes: input.notes == null ? null : String(input.notes).slice(0, 500),
      p_telegram_user_id: input.telegram_user_id == null ? null : String(input.telegram_user_id),
      p_telegram_username: input.telegram_username == null ? null : String(input.telegram_username),
      p_language: input.language === "ru" || input.language === "uz" ? input.language : "unknown",
      p_approved_by_external_user_id: input.approved_by_telegram_user_id == null
        ? null
        : String(input.approved_by_telegram_user_id),
    });
    if (error) throw error;
    if (!data?.ok) {
      const permanent = [
        "invalid_booking", "master_not_found", "service_not_found",
        "invalid_client", "slot_no_longer_available",
      ].includes(String(data?.error));
      return json(data ?? { ok: false, error: "approval_failed" }, permanent ? 409 : 500);
    }
    return json(data);
  } catch (error) {
    console.error("customer-booking-approval", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "temporary_error" }, 500);
  }
});
