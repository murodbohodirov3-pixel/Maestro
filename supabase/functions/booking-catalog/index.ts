// GET /booking-catalog — the salon, its services and the masters a client can
// book online (Maestro-Booking/docs/API_CONTRACT.md §1). No personal data.
import { allowRead, answer, bookingSettings, db, fail, preflight } from '../_shared/bookingHttp.ts';

/** masters.work_photos → only well-formed entries, in their order. */
function workPhotos(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((photo) => photo && typeof photo.url === 'string' && typeof photo.thumb_url === 'string')
    .map((photo) => ({
      url: photo.url as string,
      thumb_url: photo.thumb_url as string,
      width: Number(photo.width) || null,
      height: Number(photo.height) || null,
    }));
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'GET') return fail(request, 'invalid_request');

  try {
    if (!await allowRead(request)) return fail(request, 'rate_limited');

    const [settings, categories, services, masters] = await Promise.all([
      bookingSettings(),
      db.from('booking_categories').select('id,name_ru,name_uz,sort_order').eq('active', true).order('sort_order'),
      db.from('booking_services')
        .select('id,category,name_ru,name_uz,description_ru,description_uz,price_uzs,duration_minutes,photo_url,sort_order')
        .eq('active', true)
        .order('sort_order')
        .order('id'),
      db.from('masters')
        .select('id,name,name_uz,level,photo_url,online_service_ids,experience_years,bio_ru,bio_uz,specialties_ru,specialties_uz,work_photos')
        .eq('active', true)
        .eq('show_online', true)
        .order('id'),
    ]);
    for (const result of [categories, services, masters]) if (result.error) throw result.error;

    return answer(request, {
      ok: true,
      salon: {
        name: settings.salon_name || 'Maestro Barberia',
        address_ru: settings.salon_address_ru || '',
        address_uz: settings.salon_address_uz || settings.salon_address_ru || '',
        phone: settings.salon_phone || '',
        lat: Number(settings.salon_lat ?? settings.salon_map_lat),
        lng: Number(settings.salon_lng ?? settings.salon_map_lng),
        instagram: settings.salon_instagram || null,
        telegram: settings.salon_telegram || null,
        hours: Array.isArray(settings.opening_hours) ? settings.opening_hours : [],
        booking_horizon_days: Number(settings.booking_horizon_days) || 31,
      },
      categories: categories.data ?? [],
      services: (services.data ?? []).map((service) => ({
        id: service.id,
        category: service.category,
        name_ru: service.name_ru,
        name_uz: service.name_uz,
        description_ru: service.description_ru,
        description_uz: service.description_uz,
        price_uzs: Number(service.price_uzs),
        duration_minutes: Number(service.duration_minutes),
        photo_url: service.photo_url,
        sort_order: Number(service.sort_order),
      })),
      masters: (masters.data ?? []).map((master) => ({
        id: Number(master.id),
        name_ru: master.name,
        name_uz: master.name_uz || master.name,
        level: master.level || 'barber',
        photo_url: master.photo_url,
        service_ids: Array.isArray(master.online_service_ids) ? master.online_service_ids : null,
        experience_years: master.experience_years == null ? null : Number(master.experience_years),
        bio_ru: master.bio_ru || null,
        bio_uz: master.bio_uz || null,
        specialties_ru: Array.isArray(master.specialties_ru) ? master.specialties_ru : [],
        specialties_uz: Array.isArray(master.specialties_uz) ? master.specialties_uz : [],
        works: workPhotos(master.work_photos),
      })),
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (error) {
    console.error('[booking-catalog]', error instanceof Error ? error.message : String(error));
    return fail(request, 'temporary_error');
  }
});
