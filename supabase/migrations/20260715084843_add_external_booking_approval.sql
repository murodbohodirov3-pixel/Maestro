alter table public.appointments
  add column service_ids text[],
  add column external_booking_request_id uuid,
  add column approved_by_external_user_id text;

update public.appointments
set service_ids = array[service_id]
where service_ids is null;

alter table public.appointments
  alter column service_ids set not null,
  add constraint appointments_service_ids_check
    check (cardinality(service_ids) between 1 and 10),
  add constraint appointments_external_booking_request_id_key
    unique (external_booking_request_id),
  drop constraint appointments_duration_minutes_check,
  add constraint appointments_duration_minutes_check
    check (duration_minutes between 5 and 600);

create or replace function public.maestro_create_appointment(
  p_master_id bigint,
  p_service_id text,
  p_starts_at timestamptz,
  p_client_name text,
  p_client_phone text,
  p_notes text,
  p_status text,
  p_source text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  service_record record;
  local_date date;
  appointment_record public.appointments;
  resolved_client_id uuid;
begin
  if p_master_id is null or p_service_id is null or p_starts_at is null
    or nullif(btrim(p_client_name), '') is null
    or public.maestro_normalize_phone(p_client_phone) is null
    or p_status not in ('pending', 'confirmed')
    or p_source not in ('admin', 'bot') then
    return jsonb_build_object('ok', false, 'error', 'invalid_appointment');
  end if;

  select id, name_ru, price_uzs, duration_minutes into service_record
  from public.booking_services where id = p_service_id and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'service_not_found'); end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  perform pg_advisory_xact_lock(hashtextextended(p_master_id::text || ':' || local_date::text, 0));

  if exists (select 1 from public.master_day_statuses
    where master_id = p_master_id and work_date = local_date and status = 'day_off') then
    return jsonb_build_object('ok', false, 'error', 'master_day_off');
  end if;

  resolved_client_id := public.maestro_upsert_client(
    p_client_name, p_client_phone, p_source, null, null, 'unknown', p_actor_user_id
  );
  if resolved_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_client');
  end if;

  begin
    insert into public.appointments (
      client_id, master_id, service_id, service_ids, service_name, price_uzs, duration_minutes,
      starts_at, ends_at, client_name, client_phone, notes, status, source,
      created_by_user_id, updated_by_user_id
    ) values (
      resolved_client_id, p_master_id, service_record.id, array[service_record.id], service_record.name_ru,
      service_record.price_uzs, service_record.duration_minutes, p_starts_at,
      p_starts_at + make_interval(mins => service_record.duration_minutes),
      btrim(p_client_name), public.maestro_normalize_phone(p_client_phone), nullif(btrim(p_notes), ''),
      p_status, p_source, p_actor_user_id, p_actor_user_id
    ) returning * into appointment_record;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'slot_already_booked');
  end;

  insert into public.appointment_events (appointment_id, event_type, new_values, actor_user_id)
  values (appointment_record.id, 'created', jsonb_build_object(
    'client_id', appointment_record.client_id, 'master_id', appointment_record.master_id,
    'service_id', appointment_record.service_id, 'service_ids', appointment_record.service_ids,
    'starts_at', appointment_record.starts_at, 'status', appointment_record.status,
    'source', appointment_record.source
  ), p_actor_user_id);

  insert into public.client_events (client_id, event_type, source, appointment_id, actor_user_id, details)
  values (resolved_client_id, 'appointment_created', p_source, appointment_record.id,
    p_actor_user_id, jsonb_build_object('status', appointment_record.status));

  return jsonb_build_object('ok', true, 'appointment', to_jsonb(appointment_record));
end;
$$;

create or replace function public.maestro_approve_external_booking(
  p_external_booking_request_id uuid,
  p_service_ids text[],
  p_master_id bigint,
  p_starts_at timestamptz,
  p_client_name text,
  p_client_phone text,
  p_notes text,
  p_telegram_user_id text,
  p_telegram_username text,
  p_language text,
  p_approved_by_external_user_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  master_record record;
  service_record record;
  resolved_client_id uuid;
  local_date date;
begin
  if p_external_booking_request_id is null
    or coalesce(cardinality(p_service_ids), 0) not between 1 and 10
    or cardinality(p_service_ids) <> (select count(distinct item) from unnest(p_service_ids) as item)
    or p_master_id is null or p_starts_at is null or p_starts_at <= now()
    or nullif(btrim(p_client_name), '') is null
    or public.maestro_normalize_phone(p_client_phone) is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_booking');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_external_booking_request_id::text, 0));

  select * into appointment_record
  from public.appointments
  where external_booking_request_id = p_external_booking_request_id;
  if found then
    select name into master_record from public.masters where id = appointment_record.master_id;
    return jsonb_build_object(
      'ok', true,
      'already_confirmed', true,
      'appointment', to_jsonb(appointment_record),
      'master_name', master_record.name
    );
  end if;

  select id, name into master_record
  from public.masters
  where id = p_master_id and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'master_not_found'); end if;

  select
    count(*)::integer as service_count,
    string_agg(service.name_ru, ' + ' order by requested.ordinality) as service_name,
    sum(service.price_uzs)::bigint as total_price_uzs,
    sum(service.duration_minutes)::integer as total_duration_minutes
  into service_record
  from unnest(p_service_ids) with ordinality as requested(service_id, ordinality)
  join public.booking_services as service
    on service.id = requested.service_id and service.active;

  if service_record.service_count <> cardinality(p_service_ids)
    or service_record.total_duration_minutes not between 5 and 600 then
    return jsonb_build_object('ok', false, 'error', 'service_not_found');
  end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  perform pg_advisory_xact_lock(hashtextextended(p_master_id::text || ':' || local_date::text, 0));

  if not exists (
    select 1
    from public.maestro_get_available_slots_for_duration(
      service_record.total_duration_minutes, local_date, p_master_id, 15
    ) as slot
    where slot.slot_start = p_starts_at
  ) then
    return jsonb_build_object('ok', false, 'error', 'slot_no_longer_available');
  end if;

  resolved_client_id := public.maestro_upsert_client(
    p_client_name, p_client_phone, 'bot', p_telegram_user_id, p_telegram_username,
    p_language, null
  );
  if resolved_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_client');
  end if;

  begin
    insert into public.appointments (
      client_id, master_id, service_id, service_ids, service_name, price_uzs, duration_minutes,
      starts_at, ends_at, client_name, client_phone, notes, status, source,
      external_booking_request_id, approved_by_external_user_id
    ) values (
      resolved_client_id, p_master_id, p_service_ids[1], p_service_ids, service_record.service_name,
      service_record.total_price_uzs, service_record.total_duration_minutes, p_starts_at,
      p_starts_at + make_interval(mins => service_record.total_duration_minutes),
      btrim(p_client_name), public.maestro_normalize_phone(p_client_phone), nullif(btrim(p_notes), ''),
      'confirmed', 'bot', p_external_booking_request_id,
      nullif(btrim(p_approved_by_external_user_id), '')
    ) returning * into appointment_record;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'slot_no_longer_available');
  end;

  insert into public.appointment_events (appointment_id, event_type, new_values)
  values (appointment_record.id, 'created', jsonb_build_object(
    'client_id', appointment_record.client_id,
    'master_id', appointment_record.master_id,
    'service_ids', appointment_record.service_ids,
    'starts_at', appointment_record.starts_at,
    'status', appointment_record.status,
    'source', appointment_record.source,
    'external_booking_request_id', appointment_record.external_booking_request_id,
    'approved_by_external_user_id', appointment_record.approved_by_external_user_id
  ));

  insert into public.client_events (client_id, event_type, source, appointment_id, details)
  values (resolved_client_id, 'appointment_created', 'bot', appointment_record.id,
    jsonb_build_object(
      'status', appointment_record.status,
      'external_booking_request_id', appointment_record.external_booking_request_id
    ));

  return jsonb_build_object(
    'ok', true,
    'already_confirmed', false,
    'appointment', to_jsonb(appointment_record),
    'master_name', master_record.name
  );
end;
$$;

revoke execute on function public.maestro_approve_external_booking(
  uuid, text[], bigint, timestamptz, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.maestro_approve_external_booking(
  uuid, text[], bigint, timestamptz, text, text, text, text, text, text, text
) to service_role;
