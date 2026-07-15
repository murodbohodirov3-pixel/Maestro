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
  if (request.method === "GET") return json({ ok: true, service: "customer-notifications", writes: "delivery_log_only" });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expectedSecret = required("MAESTRO_BOOKING_APPROVAL_SECRET");
  if (!secretsMatch(request.headers.get("x-maestro-booking-secret"), expectedSecret)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8192) return json({ ok: false, error: "request_too_large" }, 413);

  try {
    const input = await request.json() as Record<string, unknown>;
    const action = String(input.action || "");
    const db = createClient(required("SUPABASE_URL"), getSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === "claim") {
      const requestedLimit = Number(input.limit ?? 25);
      const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 25;
      const { data, error } = await db.rpc("maestro_claim_due_appointment_notifications", { p_limit: limit });
      if (error) throw error;
      return json({ ok: true, notifications: data ?? [] });
    }

    const notificationId = String(input.notification_id ?? "").trim().toLowerCase();
    const claimToken = String(input.claim_token ?? "").trim().toLowerCase();
    if (!validUuid(notificationId) || !validUuid(claimToken)) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }

    if (action === "complete") {
      const { data, error } = await db.rpc("maestro_complete_appointment_notification", {
        p_notification_id: notificationId,
        p_claim_token: claimToken,
      });
      if (error) throw error;
      return json({ ok: Boolean(data) }, data ? 200 : 409);
    }

    if (action === "fail") {
      const { data, error } = await db.rpc("maestro_fail_appointment_notification", {
        p_notification_id: notificationId,
        p_claim_token: claimToken,
        p_error: String(input.error ?? "delivery_failed").slice(0, 1000),
      });
      if (error) throw error;
      return json({ ok: Boolean(data) }, data ? 200 : 409);
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (error) {
    console.error("customer-notifications", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "temporary_error" }, 500);
  }
});
