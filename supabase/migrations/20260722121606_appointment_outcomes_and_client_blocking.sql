alter table public.appointments
  add column cancelled_by text,
  add column status_reason_code text,
  add column status_reason_note text,
  add column no_show_at timestamptz;

alter table public.clients
  add column blocked_at timestamptz,
  add column blocked_reason text,
  add column blocked_by_user_id bigint references public.app_users(id) on delete set null,
  add column blocked_previous_status text;

alter table public.appointments
  add constraint appointments_cancelled_by_check
    check (cancelled_by is null or cancelled_by in ('client', 'salon')),
  add constraint appointments_status_reason_code_check
    check (status_reason_code is null or status_reason_code in (
      'no_show_no_notice',
      'no_show_unreachable',
      'no_show_late_arrival',
      'no_show_other',
      'client_changed_plans',
      'client_illness',
      'client_schedule_conflict',
      'client_late_cancellation',
      'client_other',
      'salon_master_unavailable',
      'salon_schedule_conflict',
      'salon_operational_issue',
      'salon_other'
    )),
  add constraint appointments_status_reason_note_check
    check (status_reason_note is null or char_length(btrim(status_reason_note)) between 1 and 500),
  add constraint appointments_outcome_metadata_check
    check (
      (
        status in ('pending', 'confirmed', 'completed')
        and cancelled_by is null
        and status_reason_code is null
        and status_reason_note is null
        and cancelled_at is null
        and no_show_at is null
      )
      or (
        status = 'no_show'
        and cancelled_by is null
        and cancelled_at is null
        and no_show_at is not null
        and status_reason_code in (
          'no_show_no_notice', 'no_show_unreachable', 'no_show_late_arrival', 'no_show_other'
        )
        and (status_reason_code <> 'no_show_other' or status_reason_note is not null)
      )
      or (
        status = 'cancelled'
        and cancelled_by in ('client', 'salon')
        and cancelled_at is not null
        and no_show_at is null
        and (
          (cancelled_by = 'client' and status_reason_code in (
            'client_changed_plans', 'client_illness', 'client_schedule_conflict',
            'client_late_cancellation', 'client_other'
          ))
          or (cancelled_by = 'salon' and status_reason_code in (
            'salon_master_unavailable', 'salon_schedule_conflict',
            'salon_operational_issue', 'salon_other'
          ))
        )
        and (
          status_reason_code not in ('client_other', 'salon_other')
          or status_reason_note is not null
        )
      )
    );

alter table public.clients
  add constraint clients_blocked_reason_check
    check (blocked_reason is null or char_length(btrim(blocked_reason)) between 1 and 500),
  add constraint clients_blocked_previous_status_check
    check (blocked_previous_status is null or blocked_previous_status in ('lead', 'active', 'inactive')),
  add constraint clients_block_metadata_check
    check (
      (
        lifecycle_status = 'blocked'
        and blocked_at is not null
        and blocked_reason is not null
        and blocked_previous_status is not null
      )
      or (
        lifecycle_status <> 'blocked'
        and
        blocked_at is null
        and blocked_reason is null
        and blocked_by_user_id is null
        and blocked_previous_status is null
      )
    );

create index clients_blocked_by_user_idx
  on public.clients (blocked_by_user_id)
  where blocked_by_user_id is not null;

create index appointments_client_no_show_idx
  on public.appointments (client_id, starts_at desc)
  where client_id is not null and status = 'no_show';

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
  actor_record record;
  service_record record;
  local_date date;
  appointment_record public.appointments;
  resolved_client_id uuid;
  normalized_phone text;
  client_status text;
begin
  normalized_phone := public.maestro_normalize_phone(p_client_phone);
  if p_master_id is null or p_service_id is null or p_starts_at is null
    or nullif(btrim(p_client_name), '') is null
    or normalized_phone is null
    or p_status not in ('pending', 'confirmed')
    or p_source <> 'admin' then
    return jsonb_build_object('ok', false, 'error', 'invalid_appointment');
  end if;

  select role, master_id into actor_record
  from public.app_users
  where id = p_actor_user_id and active;
  if not found or not (
    actor_record.role in ('owner', 'admin')
    or (actor_record.role = 'master' and actor_record.master_id = p_master_id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if exists (
    select 1 from public.clients
    where phone_e164 = normalized_phone and lifecycle_status = 'blocked'
  ) then
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  if not exists (select 1 from public.masters where id = p_master_id and active) then
    return jsonb_build_object('ok', false, 'error', 'master_not_found');
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
    p_client_name, normalized_phone, p_source, null, null, 'unknown', p_actor_user_id
  );
  if resolved_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_client');
  end if;

  select lifecycle_status into client_status
  from public.clients where id = resolved_client_id for update;
  if client_status = 'blocked' then
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
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
      btrim(p_client_name), normalized_phone, nullif(btrim(p_notes), ''),
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
  normalized_phone text;
  client_status text;
  local_date date;
begin
  normalized_phone := public.maestro_normalize_phone(p_client_phone);
  if p_external_booking_request_id is null
    or coalesce(cardinality(p_service_ids), 0) not between 1 and 10
    or cardinality(p_service_ids) <> (select count(distinct item) from unnest(p_service_ids) as item)
    or p_master_id is null or p_starts_at is null or p_starts_at <= now()
    or nullif(btrim(p_client_name), '') is null
    or normalized_phone is null then
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

  if exists (
    select 1 from public.clients
    where phone_e164 = normalized_phone and lifecycle_status = 'blocked'
  ) then
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
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
    p_client_name, normalized_phone, 'bot', p_telegram_user_id, p_telegram_username,
    p_language, null
  );
  if resolved_client_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_client');
  end if;

  select lifecycle_status into client_status
  from public.clients where id = resolved_client_id for update;
  if client_status = 'blocked' then
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
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
      btrim(p_client_name), normalized_phone, nullif(btrim(p_notes), ''),
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

create or replace function public.maestro_set_appointment_status(
  p_appointment_id uuid,
  p_status text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_record record;
  appointment_record public.appointments;
  old_status text;
begin
  if p_status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'error', 'invalid_appointment_status');
  end if;

  select role, master_id into actor_record
  from public.app_users
  where id = p_actor_user_id and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into appointment_record
  from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'appointment_not_found'); end if;

  if not (
    actor_record.role in ('owner', 'admin')
    or (actor_record.role = 'master' and actor_record.master_id = appointment_record.master_id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if appointment_record.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'unchanged', true, 'appointment', to_jsonb(appointment_record));
  end if;
  if appointment_record.status <> 'pending' then
    return jsonb_build_object(
      'ok', false, 'error', 'invalid_status_transition',
      'from_status', appointment_record.status, 'to_status', p_status
    );
  end if;

  old_status := appointment_record.status;
  update public.appointments set
    status = 'confirmed', updated_by_user_id = p_actor_user_id, updated_at = now()
  where id = p_appointment_id returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values, actor_user_id)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', old_status),
    jsonb_build_object('status', appointment_record.status), p_actor_user_id);

  if appointment_record.client_id is not null then
    insert into public.client_events (client_id, event_type, source, appointment_id, actor_user_id, details)
    values (appointment_record.client_id, 'appointment_status_changed', appointment_record.source,
      appointment_record.id, p_actor_user_id,
      jsonb_build_object('old_status', old_status, 'new_status', appointment_record.status));
  end if;

  return jsonb_build_object('ok', true, 'unchanged', false, 'appointment', to_jsonb(appointment_record));
end;
$$;

create or replace function public.maestro_set_appointment_outcome(
  p_appointment_id uuid,
  p_outcome text,
  p_cancelled_by text,
  p_reason_code text,
  p_reason_note text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_record record;
  appointment_record public.appointments;
  old_status text;
  normalized_note text;
  valid_reason boolean := false;
begin
  normalized_note := nullif(btrim(p_reason_note), '');
  if normalized_note is not null and char_length(normalized_note) > 500 then
    return jsonb_build_object('ok', false, 'error', 'invalid_reason_note');
  end if;
  if p_outcome not in ('completed', 'cancelled', 'no_show') then
    return jsonb_build_object('ok', false, 'error', 'invalid_outcome');
  end if;

  if p_outcome = 'completed' then
    valid_reason := p_cancelled_by is null and p_reason_code is null and normalized_note is null;
  elsif p_outcome = 'no_show' then
    valid_reason := p_cancelled_by is null and p_reason_code in (
      'no_show_no_notice', 'no_show_unreachable', 'no_show_late_arrival', 'no_show_other'
    );
  elsif p_cancelled_by = 'client' then
    valid_reason := p_reason_code in (
      'client_changed_plans', 'client_illness', 'client_schedule_conflict',
      'client_late_cancellation', 'client_other'
    );
  elsif p_cancelled_by = 'salon' then
    valid_reason := p_reason_code in (
      'salon_master_unavailable', 'salon_schedule_conflict',
      'salon_operational_issue', 'salon_other'
    );
  end if;

  if not valid_reason then
    if p_outcome = 'cancelled' and (p_cancelled_by is null or p_cancelled_by not in ('client', 'salon')) then
      return jsonb_build_object('ok', false, 'error', 'invalid_cancelled_by');
    end if;
    return jsonb_build_object('ok', false, 'error', 'invalid_reason_code');
  end if;
  if p_reason_code in ('no_show_other', 'client_other', 'salon_other') and normalized_note is null then
    return jsonb_build_object('ok', false, 'error', 'reason_note_required');
  end if;

  select role, master_id into actor_record
  from public.app_users
  where id = p_actor_user_id and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into appointment_record
  from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'appointment_not_found'); end if;

  if not (
    actor_record.role in ('owner', 'admin')
    or (actor_record.role = 'master' and actor_record.master_id = appointment_record.master_id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if appointment_record.status = p_outcome then
    if coalesce(appointment_record.cancelled_by, '') = coalesce(p_cancelled_by, '')
      and coalesce(appointment_record.status_reason_code, '') = coalesce(p_reason_code, '')
      and coalesce(appointment_record.status_reason_note, '') = coalesce(normalized_note, '') then
      return jsonb_build_object('ok', true, 'unchanged', true, 'appointment', to_jsonb(appointment_record));
    end if;
    return jsonb_build_object('ok', false, 'error', 'outcome_already_recorded');
  end if;

  if appointment_record.status not in ('pending', 'confirmed') then
    return jsonb_build_object(
      'ok', false, 'error', 'invalid_status_transition',
      'from_status', appointment_record.status, 'to_status', p_outcome
    );
  end if;
  if p_outcome in ('completed', 'no_show') and appointment_record.starts_at > now() then
    return jsonb_build_object('ok', false, 'error', 'outcome_before_start');
  end if;

  old_status := appointment_record.status;
  update public.appointments set
    status = p_outcome,
    cancelled_by = case when p_outcome = 'cancelled' then p_cancelled_by else null end,
    status_reason_code = case when p_outcome = 'completed' then null else p_reason_code end,
    status_reason_note = case when p_outcome = 'completed' then null else normalized_note end,
    cancelled_at = case when p_outcome = 'cancelled' then now() else null end,
    no_show_at = case when p_outcome = 'no_show' then now() else null end,
    updated_by_user_id = p_actor_user_id,
    updated_at = now()
  where id = p_appointment_id returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values, actor_user_id)
  values (
    appointment_record.id,
    'status_changed',
    jsonb_build_object('status', old_status),
    jsonb_build_object(
      'status', appointment_record.status,
      'cancelled_by', appointment_record.cancelled_by,
      'status_reason_code', appointment_record.status_reason_code,
      'status_reason_note', appointment_record.status_reason_note,
      'cancelled_at', appointment_record.cancelled_at,
      'no_show_at', appointment_record.no_show_at
    ),
    p_actor_user_id
  );

  if appointment_record.client_id is not null then
    insert into public.client_events (client_id, event_type, source, appointment_id, actor_user_id, details)
    values (
      appointment_record.client_id,
      'appointment_outcome_recorded',
      appointment_record.source,
      appointment_record.id,
      p_actor_user_id,
      jsonb_build_object(
        'old_status', old_status,
        'new_status', appointment_record.status,
        'cancelled_by', appointment_record.cancelled_by,
        'reason_code', appointment_record.status_reason_code
      )
    );

    if p_outcome = 'completed' then
      update public.clients as client set
        visit_count = stats.visit_count,
        first_visit_at = stats.first_visit_at,
        last_visit_at = stats.last_visit_at,
        lifecycle_status = case when client.lifecycle_status = 'blocked' then 'blocked' else 'active' end,
        updated_by_user_id = p_actor_user_id,
        updated_at = now()
      from (
        select count(*)::integer as visit_count, min(starts_at) as first_visit_at, max(starts_at) as last_visit_at
        from public.appointments
        where client_id = appointment_record.client_id and status = 'completed'
      ) as stats
      where client.id = appointment_record.client_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'unchanged', false, 'appointment', to_jsonb(appointment_record));
end;
$$;

create or replace function public.maestro_set_client_blocked(
  p_client_id uuid,
  p_blocked boolean,
  p_reason text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_record record;
  client_record public.clients;
  normalized_reason text;
  restored_status text;
begin
  select role into actor_record
  from public.app_users
  where id = p_actor_user_id and active;
  if not found or actor_record.role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  normalized_reason := nullif(btrim(p_reason), '');
  if p_blocked is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_block_state');
  end if;
  if p_blocked and (normalized_reason is null or char_length(normalized_reason) > 500) then
    return jsonb_build_object('ok', false, 'error', 'block_reason_required');
  end if;
  if not p_blocked and normalized_reason is not null then
    return jsonb_build_object('ok', false, 'error', 'invalid_block_reason');
  end if;

  select * into client_record
  from public.clients where id = p_client_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;

  if p_blocked then
    if client_record.lifecycle_status = 'blocked' then
      if coalesce(client_record.blocked_reason, '') = normalized_reason then
        return jsonb_build_object('ok', true, 'unchanged', true, 'client', to_jsonb(client_record));
      end if;
      return jsonb_build_object('ok', false, 'error', 'client_already_blocked');
    end if;

    update public.clients set
      lifecycle_status = 'blocked',
      blocked_at = now(),
      blocked_reason = normalized_reason,
      blocked_by_user_id = p_actor_user_id,
      blocked_previous_status = client_record.lifecycle_status,
      updated_by_user_id = p_actor_user_id,
      updated_at = now()
    where id = p_client_id returning * into client_record;

    insert into public.client_events (client_id, event_type, source, actor_user_id, details)
    values (p_client_id, 'client_blocked', 'web_app', p_actor_user_id,
      jsonb_build_object('reason', normalized_reason));
  else
    if client_record.lifecycle_status <> 'blocked' then
      return jsonb_build_object('ok', true, 'unchanged', true, 'client', to_jsonb(client_record));
    end if;

    restored_status := coalesce(
      client_record.blocked_previous_status,
      case when client_record.visit_count > 0 then 'active' else 'lead' end
    );
    update public.clients set
      lifecycle_status = restored_status,
      blocked_at = null,
      blocked_reason = null,
      blocked_by_user_id = null,
      blocked_previous_status = null,
      updated_by_user_id = p_actor_user_id,
      updated_at = now()
    where id = p_client_id returning * into client_record;

    insert into public.client_events (client_id, event_type, source, actor_user_id, details)
    values (p_client_id, 'client_unblocked', 'web_app', p_actor_user_id,
      jsonb_build_object('restored_status', restored_status));
  end if;

  return jsonb_build_object('ok', true, 'unchanged', false, 'client', to_jsonb(client_record));
end;
$$;

create or replace view public.client_export as
select
  client.id,
  client.full_name,
  client.phone_e164,
  client.telegram_username,
  client.preferred_language,
  client.lifecycle_status,
  client.marketing_consent,
  client.first_source,
  client.first_contact_at,
  client.last_contact_at,
  client.first_visit_at,
  client.last_visit_at,
  client.visit_count,
  case
    when client.last_visit_at is null then null::integer
    else current_date - (client.last_visit_at at time zone 'Asia/Tashkent')::date
  end as days_since_last_visit,
  client.marketing_consent = 'granted' and client.lifecycle_status = 'active' as eligible_for_marketing,
  client.blocked_at,
  client.blocked_reason,
  client.blocked_by_user_id,
  coalesce(no_show.no_show_count, 0) as no_show_count,
  no_show.last_no_show_at
from public.clients as client
left join lateral (
  select count(*)::integer as no_show_count, max(appointment.starts_at) as last_no_show_at
  from public.appointments as appointment
  where appointment.client_id = client.id and appointment.status = 'no_show'
) as no_show on true;

alter view public.client_export set (security_invoker = true);

revoke execute on function public.maestro_create_appointment(
  bigint, text, timestamptz, text, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.maestro_create_appointment(
  bigint, text, timestamptz, text, text, text, text, text, bigint
) to service_role;

revoke execute on function public.maestro_approve_external_booking(
  uuid, text[], bigint, timestamptz, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.maestro_approve_external_booking(
  uuid, text[], bigint, timestamptz, text, text, text, text, text, text, text
) to service_role;

revoke execute on function public.maestro_set_appointment_status(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_set_appointment_status(uuid, text, bigint)
  to service_role;

revoke execute on function public.maestro_set_appointment_outcome(uuid, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_set_appointment_outcome(uuid, text, text, text, text, bigint)
  to service_role;

revoke execute on function public.maestro_set_client_blocked(uuid, boolean, text, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_set_client_blocked(uuid, boolean, text, bigint)
  to service_role;
