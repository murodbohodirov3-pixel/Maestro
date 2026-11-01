-- Audit of 2026-11-01, №14 (owner's «да» of 2026-11-01): a script with many
-- addresses could hold every free hour of every master, ten minutes at a time,
-- and clients could not book. Now no master has more than three unconfirmed
-- site bookings on one day at once; the fourth goes to another master or is
-- told the time is taken. The rest is the hold of
-- 20261021120000_client_name_parts.sql unchanged (the function keeps its grants).
create or replace function public.maestro_hold_booking(
  p_token_hash text,
  p_service_ids text[],
  p_master_id bigint,
  p_starts_at timestamptz,
  p_client_name text,
  p_comment text,
  p_lang text,
  p_ip_hash text,
  p_client_first_name text default null,
  p_client_last_name text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  first_part text := public.maestro_name_part(p_client_first_name);
  last_part text := public.maestro_name_part(p_client_last_name);
  clean_name text;
  clean_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  service_record record;
  local_date date;
  today date := (now() at time zone 'Asia/Tashkent')::date;
  horizon integer;
  candidate record;
  appointment_record public.appointments;
  placed boolean := false;
begin
  if first_part is not null or last_part is not null then
    if not public.maestro_name_part_ok(first_part) or not public.maestro_name_part_ok(last_part) then
      return jsonb_build_object('ok', false, 'error', 'invalid_request');
    end if;
    clean_name := concat_ws(' ', first_part, last_part);
  else
    clean_name := nullif(btrim(coalesce(p_client_name, '')), '');
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_starts_at is null
     or coalesce(cardinality(p_service_ids), 0) not between 1 and 10
     or cardinality(p_service_ids) <> (select count(distinct item) from unnest(p_service_ids) as item)
     or clean_name is null or char_length(clean_name) > 81
     or char_length(coalesce(clean_comment, '')) > 300 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  if p_ip_hash is not null then
    if (select count(*) from public.appointments
        where booking_ip_hash = p_ip_hash and status = 'pending' and source = 'web'
          and hold_expires_at > now()) >= 3
       or not public.maestro_booking_rate_hit(p_ip_hash, 'hold', 10, interval '1 hour') then
      return jsonb_build_object('ok', false, 'error', 'rate_limited');
    end if;
  end if;

  perform public.maestro_expire_booking_holds();

  select count(*)::integer as service_count,
    string_agg(service.name_ru, ' + ' order by requested.position) as service_name,
    sum(service.price_uzs)::bigint as total_price_uzs,
    sum(service.duration_minutes)::integer as total_duration_minutes
  into service_record
  from unnest(p_service_ids) with ordinality as requested (service_id, position)
  join public.booking_services as service on service.id = requested.service_id and service.active;
  if service_record.service_count <> cardinality(p_service_ids) then
    return jsonb_build_object('ok', false, 'error', 'unknown_service');
  end if;
  if service_record.total_duration_minutes not between 5 and 600 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  select booking_horizon_days into horizon from public.settings where id = 1;
  if local_date < today or local_date > today + coalesce(horizon, 31) then
    return jsonb_build_object('ok', false, 'error', 'date_out_of_range');
  end if;

  if p_master_id is not null and not exists (
    select 1 from public.masters as master
    where master.id = p_master_id and master.active and master.show_online
      and (master.online_service_ids is null or p_service_ids <@ master.online_service_ids)
  ) then
    return jsonb_build_object('ok', false, 'error', 'unknown_master');
  end if;

  for candidate in
    select master.id
    from public.masters as master
    where master.active and master.show_online
      and (p_master_id is null or master.id = p_master_id)
      and (master.online_service_ids is null or p_service_ids <@ master.online_service_ids)
      and (
        select count(*) from public.appointments as held
        where held.master_id = master.id and held.status = 'pending' and held.source = 'web'
          and held.hold_expires_at > now()
          and (held.starts_at at time zone 'Asia/Tashkent')::date = local_date
      ) < 3
      and exists (
        select 1
        from public.maestro_booking_slots(
          service_record.total_duration_minutes, local_date, local_date,
          array[master.id], now() + interval '15 minutes'
        ) as slot
        where slot.slot_start = p_starts_at
      )
    order by (
      select count(*) from public.appointments as booked
      where booked.master_id = master.id
        and booked.status in ('pending', 'confirmed')
        and (booked.starts_at at time zone 'Asia/Tashkent')::date = local_date
    ), random()
  loop
    begin
      insert into public.appointments (
        master_id, service_id, service_ids, service_name, price_uzs, duration_minutes,
        starts_at, ends_at, client_name, client_first_name, client_last_name, notes, status, source,
        hold_expires_at, booking_token_hash, booking_lang, booking_ip_hash
      ) values (
        candidate.id, p_service_ids[1], p_service_ids, service_record.service_name,
        service_record.total_price_uzs, service_record.total_duration_minutes,
        p_starts_at, p_starts_at + make_interval(mins => service_record.total_duration_minutes),
        clean_name, first_part, last_part, clean_comment, 'pending', 'web',
        now() + interval '10 minutes', p_token_hash,
        case when p_lang = 'uz' then 'uz' else 'ru' end, p_ip_hash
      ) returning * into appointment_record;
      placed := true;
      exit;
    exception when exclusion_violation then
      placed := false;
    end;
  end loop;

  if not placed then
    return jsonb_build_object('ok', false, 'error', 'slot_taken');
  end if;

  insert into public.appointment_events (appointment_id, event_type, new_values)
  values (appointment_record.id, 'created', jsonb_build_object(
    'master_id', appointment_record.master_id,
    'service_ids', appointment_record.service_ids,
    'starts_at', appointment_record.starts_at,
    'status', appointment_record.status,
    'source', appointment_record.source,
    'hold_expires_at', appointment_record.hold_expires_at
  ));

  return jsonb_build_object('ok', true, 'booking', public.maestro_booking_view(appointment_record));
end;
$$;
