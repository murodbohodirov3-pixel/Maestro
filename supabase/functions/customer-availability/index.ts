// POST /customer-availability — free time for the booking page
// (Maestro-Booking/docs/API_CONTRACT.md §2): one day, each master's nearest
// times, or the days of a month that have any. A request without `mode` is the
// older single-day form the July bot used, answered as it always was.
import {
  addDays,
  groupDayTimes,
  isIsoDate,
  masterOffers,
  nearestByMaster,
  servicesTotal,
  tashkentDate,
} from '../_shared/bookingCore.js';
import { allowRead, answer, bookingSettings, db, fail, preflight, readJson } from '../_shared/bookingHttp.ts';

// With no service chosen yet the page asks for an hour, then checks again.
const DEFAULT_DURATION = 60;

async function loadServices(serviceIds: string[]) {
  if (!serviceIds.length) return { services: [], ok: true };
  const { data, error } = await db.from('booking_services')
    .select('id,name_ru,name_uz,price_uzs,duration_minutes')
    .in('id', serviceIds)
    .eq('active', true);
  if (error) throw error;
  const byId = new Map((data ?? []).map((service) => [service.id, service]));
  const services = serviceIds.map((id) => byId.get(id)).filter(Boolean);
  return { services, ok: services.length === serviceIds.length };
}

async function onlineMasters() {
  const { data, error } = await db.from('masters')
    .select('id,name,online_service_ids')
    .eq('active', true)
    .eq('show_online', true)
    .order('id');
  if (error) throw error;
  return data ?? [];
}

// Clients are offered times at least 15 minutes ahead.
function notBefore() {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

function serviceIdsOf(input: Record<string, unknown>) {
  if (!Array.isArray(input.service_ids)) return null;
  const ids = [...new Set(input.service_ids.map((value) => String(value).trim()).filter(Boolean))];
  if (ids.length > 10 || ids.some((id) => id.length > 80)) return null;
  return ids;
}

async function legacyDay(request: Request, input: Record<string, unknown>) {
  const requestedServiceIds = Array.isArray(input.service_ids)
    ? input.service_ids.map((value) => String(value).trim()).filter(Boolean)
    : [String(input.service_id ?? '').trim()].filter(Boolean);
  const serviceIds = [...new Set(requestedServiceIds)];
  const workDate = String(input.date ?? '').trim();
  const masterId = input.master_id == null || input.master_id === '' ? null : Number(input.master_id);
  if (!serviceIds.length || serviceIds.length > 10 || !isIsoDate(workDate)) {
    return answer(request, { ok: false, status: 'invalid_request' }, 400);
  }
  const today = tashkentDate();
  if (workDate < today || workDate > addDays(today, 31)) {
    return answer(request, { ok: false, status: 'date_out_of_range' }, 400);
  }
  const { services, ok } = await loadServices(serviceIds);
  if (!ok) return answer(request, { ok: false, status: 'unknown_service' }, 404);
  const total = servicesTotal(services);
  const { data: masters, error: mastersError } = await db.from('masters').select('id,name').eq('active', true).order('id');
  if (mastersError) throw mastersError;
  const allowed = (masters ?? []).filter((master) => masterId == null || Number(master.id) === masterId);
  if (masterId != null && !allowed.length) return answer(request, { ok: false, status: 'unknown_master' }, 404);
  const { data: slots, error } = await db.rpc('maestro_get_available_slots_for_duration', {
    p_duration_minutes: total.duration, p_work_date: workDate, p_master_id: masterId, p_step_minutes: 15,
  });
  if (error) throw error;
  const names = new Map(allowed.map((master) => [Number(master.id), master.name]));
  const visible = (slots ?? [])
    .filter((slot: { master_id: number }) => names.has(Number(slot.master_id)))
    .slice(0, 120)
    .map((slot: { master_id: number; slot_start: string; slot_end: string }) => ({
      master_id: Number(slot.master_id),
      master_name: names.get(Number(slot.master_id)),
      starts_at: slot.slot_start,
      ends_at: slot.slot_end,
    }));
  return answer(request, {
    ok: true,
    status: visible.length ? 'available' : 'no_slots',
    date: workDate,
    timezone: 'Asia/Tashkent',
    service: services.length === 1 ? services[0] : null,
    services,
    total_duration_minutes: total.duration,
    total_price_uzs: total.price,
    slots: visible,
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return fail(request, 'invalid_request');

  try {
    const input = await readJson(request);
    if (!input) return fail(request, 'invalid_request');
    if (!await allowRead(request)) return fail(request, 'rate_limited');
    if (input.mode === undefined) return await legacyDay(request, input);

    const mode = String(input.mode);
    const serviceIds = serviceIdsOf(input);
    if (!['day', 'nearest', 'month'].includes(mode) || serviceIds === null) return fail(request, 'invalid_request');

    const masterId = input.master_id == null ? null : Number(input.master_id);
    if (masterId !== null && (!Number.isSafeInteger(masterId) || masterId <= 0)) return fail(request, 'invalid_request');

    const [{ services, ok }, masters, settings] = await Promise.all([
      loadServices(serviceIds),
      onlineMasters(),
      bookingSettings(),
    ]);
    if (!ok) return fail(request, 'unknown_service');
    const total = services.length ? servicesTotal(services) : { duration: DEFAULT_DURATION, price: 0 };

    const capable = masters.filter((master) => masterOffers(master, serviceIds));
    let masterIds = capable.map((master) => Number(master.id));
    if (masterId !== null && mode !== 'nearest') {
      if (!masters.some((master) => Number(master.id) === masterId)) return fail(request, 'unknown_master');
      masterIds = masterIds.filter((id) => id === masterId);
    }

    const today = tashkentDate();
    const lastDay = addDays(today, Number(settings.booking_horizon_days) || 31);

    if (mode === 'day') {
      const date = String(input.date ?? '');
      if (!isIsoDate(date)) return fail(request, 'invalid_request');
      if (date < today || date > lastDay) return fail(request, 'date_out_of_range');
      const { data, error } = masterIds.length
        ? await db.rpc('maestro_booking_slots', {
          p_duration_minutes: total.duration, p_from: date, p_to: date,
          p_master_ids: masterIds, p_not_before: notBefore(),
        })
        : { data: [], error: null };
      if (error) throw error;
      return answer(request, {
        ok: true,
        date,
        total_duration_minutes: total.duration,
        total_price_uzs: total.price,
        times: groupDayTimes(data ?? []),
      });
    }

    if (mode === 'nearest') {
      const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 5), 10));
      const { data, error } = masterIds.length
        ? await db.rpc('maestro_booking_nearest', {
          p_duration_minutes: total.duration, p_from: today, p_to: lastDay,
          p_master_ids: masterIds, p_not_before: notBefore(), p_limit: limit,
        })
        : { data: [], error: null };
      if (error) throw error;
      // Every online master is listed, a master who cannot do these services
      // with no time at all.
      return answer(request, { ok: true, masters: nearestByMaster(data ?? [], masters.map((master) => Number(master.id))) });
    }

    // month
    const from = String(input.from ?? today);
    const days = Math.max(1, Math.min(Math.trunc(Number(input.days) || 31), 62));
    if (!isIsoDate(from)) return fail(request, 'invalid_request');
    if (from > lastDay) return fail(request, 'date_out_of_range');
    const start = from < today ? today : from;
    const end = addDays(from, days - 1) < lastDay ? addDays(from, days - 1) : lastDay;
    if (end < start || !masterIds.length) return answer(request, { ok: true, available_dates: [] });
    const { data, error } = await db.rpc('maestro_booking_days', {
      p_duration_minutes: total.duration, p_from: start, p_to: end,
      p_master_ids: masterIds, p_not_before: notBefore(),
    });
    if (error) throw error;
    return answer(request, {
      ok: true,
      available_dates: (data ?? []).map((row: { work_date: string }) => String(row.work_date).slice(0, 10)),
    });
  } catch (error) {
    console.error('[customer-availability]', error instanceof Error ? error.message : String(error));
    return fail(request, 'temporary_error');
  }
});
