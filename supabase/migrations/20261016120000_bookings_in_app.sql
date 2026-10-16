-- The calendar comes back to the app (owner's decisions of 2026-10-16):
-- Команда → «Записи» for the owner and the administrator, «Мои записи» for a
-- master. A booking made in the salon names a client card, like a visit. A
-- booking ends one of three ways: the client came (the master records the
-- visit, which closes the booking), did not come, or cancelled.
--
-- Needs 20261015120000_online_booking (maestro_booking_slots) and
-- 20261016100000_client_visits (sales.appointment_id, client cards).

-- How many counted visits each client has, for the booking cards.
create or replace function public.maestro_clients_visit_counts(p_client_ids uuid[])
returns table (client_id uuid, visit_count integer, last_visit date)
language sql
stable
set search_path = ''
as $$
  select sale.client_id, count(*)::integer, max(sale.d)
  from public.sales as sale
  where sale.client_id = any (p_client_ids)
    and not public.maestro_sale_is_rejected(sale.status, sale.comment)
  group by sale.client_id
$$;

-- A booking taken in the salon or over the phone: a client card, services
-- and a time that is free by the master's schedule.
create or replace function public.maestro_book_appointment(
  p_master_id bigint,
  p_service_ids text[],
  p_starts_at timestamptz,
  p_client_id uuid,
  p_notes text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  service_record record;
  client_record record;
  local_date date;
  appointment_record public.appointments;
begin
  if p_master_id is null or p_starts_at is null or p_client_id is null
     or coalesce(cardinality(p_service_ids), 0) not between 1 and 10
     or cardinality(p_service_ids) <> (select count(distinct item) from unnest(p_service_ids) as item)
     or char_length(coalesce(p_notes, '')) > 300 then
    return jsonb_build_object('ok', false, 'error', 'invalid_booking');
  end if;

  select id, full_name, phone_e164, lifecycle_status into client_record
  from public.clients where id = p_client_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;
  if client_record.lifecycle_status = 'blocked' then
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  if not exists (select 1 from public.masters where id = p_master_id and active) then
    return jsonb_build_object('ok', false, 'error', 'master_not_active');
  end if;

  select count(*)::integer as service_count,
    string_agg(service.name_ru, ' + ' order by requested.position) as service_name,
    sum(service.price_uzs)::bigint as total_price_uzs,
    sum(service.duration_minutes)::integer as total_duration_minutes
  into service_record
  from unnest(p_service_ids) with ordinality as requested (service_id, position)
  join public.booking_services as service on service.id = requested.service_id and service.active;
  if service_record.service_count <> cardinality(p_service_ids)
     or service_record.total_duration_minutes not between 5 and 600 then
    return jsonb_build_object('ok', false, 'error', 'service_not_found');
  end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  if not exists (
    select 1
    from public.maestro_booking_slots(service_record.total_duration_minutes, local_date, local_date,
      array[p_master_id], now()) as slot
    where slot.slot_start = p_starts_at
  ) then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;

  begin
    insert into public.appointments (
      client_id, master_id, service_id, service_ids, service_name, price_uzs, duration_minutes,
      starts_at, ends_at, client_name, client_phone, notes, status, source,
      created_by_user_id, updated_by_user_id
    ) values (
      client_record.id, p_master_id, p_service_ids[1], p_service_ids, service_record.service_name,
      service_record.total_price_uzs, service_record.total_duration_minutes,
      p_starts_at, p_starts_at + make_interval(mins => service_record.total_duration_minutes),
      client_record.full_name, client_record.phone_e164, nullif(btrim(coalesce(p_notes, '')), ''),
      'confirmed', 'admin', p_actor_user_id, p_actor_user_id
    ) returning * into appointment_record;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end;

  insert into public.appointment_events (appointment_id, event_type, new_values, actor_user_id)
  values (appointment_record.id, 'created', jsonb_build_object(
    'client_id', appointment_record.client_id, 'master_id', appointment_record.master_id,
    'service_ids', appointment_record.service_ids, 'starts_at', appointment_record.starts_at,
    'status', appointment_record.status, 'source', appointment_record.source
  ), p_actor_user_id);
  insert into public.client_events (client_id, event_type, source, appointment_id, actor_user_id, details)
  values (client_record.id, 'appointment_created', 'salon', appointment_record.id, p_actor_user_id,
    jsonb_build_object('status', 'confirmed'));

  return jsonb_build_object('ok', true, 'appointment_id', appointment_record.id);
end;
$$;

-- Whether a visit may close this booking: same master, the booking still
-- open, its client the visit's client, and its time reached (from half an
-- hour before). Checked before the visit is written.
create or replace function public.maestro_check_appointment_for_visit(
  p_appointment_id uuid,
  p_master_id bigint,
  p_client_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  appointment_record public.appointments;
begin
  select * into appointment_record from public.appointments where id = p_appointment_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'appointment_not_found'); end if;
  if appointment_record.master_id <> p_master_id then
    return jsonb_build_object('ok', false, 'error', 'appointment_master_mismatch');
  end if;
  if appointment_record.status = 'completed' then
    return jsonb_build_object('ok', false, 'error', 'appointment_already_visited');
  end if;
  if not (appointment_record.status = 'confirmed'
          or (appointment_record.status = 'pending' and appointment_record.source <> 'web')) then
    return jsonb_build_object('ok', false, 'error', 'appointment_closed');
  end if;
  if appointment_record.starts_at > now() + interval '30 minutes' then
    return jsonb_build_object('ok', false, 'error', 'appointment_not_started');
  end if;
  if appointment_record.client_id is not null and appointment_record.client_id <> p_client_id then
    return jsonb_build_object('ok', false, 'error', 'appointment_client_mismatch');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- The visit was written: the booking is done.
create or replace function public.maestro_complete_appointment_for_visit(
  p_appointment_id uuid,
  p_client_id uuid,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  old_status text;
begin
  select * into appointment_record from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'appointment_not_found'); end if;
  if appointment_record.status = 'completed' then return jsonb_build_object('ok', true); end if;
  if appointment_record.status not in ('pending', 'confirmed') then
    return jsonb_build_object('ok', false, 'error', 'appointment_closed');
  end if;

  old_status := appointment_record.status;
  update public.appointments
     set status = 'completed', client_id = coalesce(client_id, p_client_id), hold_expires_at = null,
         updated_by_user_id = p_actor_user_id, updated_at = now()
   where id = p_appointment_id
  returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values, actor_user_id)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', old_status),
    jsonb_build_object('status', 'completed', 'via', 'visit'), p_actor_user_id);
  return jsonb_build_object('ok', true);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_clients_visit_counts(uuid[])',
    'public.maestro_book_appointment(bigint, text[], timestamptz, uuid, text, bigint)',
    'public.maestro_check_appointment_for_visit(uuid, bigint, uuid)',
    'public.maestro_complete_appointment_for_visit(uuid, uuid, bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
