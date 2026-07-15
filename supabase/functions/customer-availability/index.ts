import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
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

function tashkentToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method === "GET") return json({ ok: true, service: "customer-availability", writes: false });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 4096) return json({ ok: false, error: "request_too_large" }, 413);

  try {
    const input = await request.json() as Record<string, unknown>;
    const requestedServiceIds = Array.isArray(input.service_ids)
      ? input.service_ids.map((value) => String(value).trim()).filter(Boolean)
      : [String(input.service_id ?? "").trim()].filter(Boolean);
    const serviceIds = [...new Set(requestedServiceIds)];
    const workDate = String(input.date ?? "").trim();
    const masterId = input.master_id == null || input.master_id === ""
      ? null
      : Number(input.master_id);

    if (!serviceIds.length || serviceIds.length > 10 || serviceIds.some((id) => id.length > 80) || !validDate(workDate)) {
      return json({ ok: false, status: "invalid_request" }, 400);
    }
    if (masterId != null && (!Number.isSafeInteger(masterId) || masterId <= 0)) {
      return json({ ok: false, status: "invalid_master" }, 400);
    }

    const today = tashkentToday();
    const maxDate = new Date(`${today}T00:00:00Z`);
    maxDate.setUTCDate(maxDate.getUTCDate() + 31);
    if (workDate < today || workDate > maxDate.toISOString().slice(0, 10)) {
      return json({ ok: false, status: "date_out_of_range" }, 400);
    }

    const db = createClient(required("SUPABASE_URL"), getSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [{ data: serviceRows, error: serviceError }, { data: masters, error: mastersError }] = await Promise.all([
      db.from("booking_services")
        .select("id,name_ru,name_uz,price_uzs,duration_minutes")
        .in("id", serviceIds)
        .eq("active", true),
      db.from("masters").select("id,name").eq("active", true).order("id"),
    ]);
    if (serviceError) throw serviceError;
    if (mastersError) throw mastersError;
    if (!serviceRows || serviceRows.length !== serviceIds.length) {
      return json({ ok: false, status: "unknown_service" }, 404);
    }
    const servicesById = new Map(serviceRows.map((service) => [service.id, service]));
    const services = serviceIds.map((id) => servicesById.get(id)!);
    const totalDurationMinutes = services.reduce((sum, service) => sum + Number(service.duration_minutes), 0);
    const totalPriceUzs = services.reduce((sum, service) => sum + Number(service.price_uzs), 0);

    const allowedMasters = (masters ?? []).filter((master) => masterId == null || Number(master.id) === masterId);
    if (masterId != null && !allowedMasters.length) {
      return json({ ok: false, status: "unknown_master" }, 404);
    }

    const { data: slots, error: slotsError } = await db.rpc("maestro_get_available_slots_for_duration", {
      p_duration_minutes: totalDurationMinutes,
      p_work_date: workDate,
      p_master_id: masterId,
      p_step_minutes: 15,
    });
    if (slotsError) throw slotsError;

    const masterNames = new Map(allowedMasters.map((master) => [Number(master.id), master.name]));
    const visibleSlots = (slots ?? [])
      .filter((slot: { master_id: number }) => masterNames.has(Number(slot.master_id)))
      .slice(0, 120)
      .map((slot: { master_id: number; slot_start: string; slot_end: string }) => ({
        master_id: Number(slot.master_id),
        master_name: masterNames.get(Number(slot.master_id)),
        starts_at: slot.slot_start,
        ends_at: slot.slot_end,
      }));

    return json({
      ok: true,
      status: visibleSlots.length ? "available" : "no_slots",
      date: workDate,
      timezone: "Asia/Tashkent",
      service: services.length === 1 ? services[0] : null,
      services,
      total_duration_minutes: totalDurationMinutes,
      total_price_uzs: totalPriceUzs,
      slots: visibleSlots,
    });
  } catch (error) {
    console.error("customer-availability", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "temporary_error" }, 500);
  }
});
