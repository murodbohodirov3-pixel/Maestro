create table public.clients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(btrim(full_name)) between 1 and 120),
  phone_e164 text not null unique check (phone_e164 ~ '^[+][1-9][0-9]{6,14}$'),
  telegram_user_id text unique,
  telegram_username text,
  preferred_language text not null default 'unknown' check (preferred_language in ('ru', 'uz', 'unknown')),
  lifecycle_status text not null default 'lead' check (lifecycle_status in ('lead', 'active', 'inactive', 'blocked')),
  marketing_consent text not null default 'unknown' check (marketing_consent in ('unknown', 'granted', 'denied')),
  marketing_consent_at timestamptz,
  first_source text not null default 'unknown',
  last_source text not null default 'unknown',
  first_contact_at timestamptz not null default now(),
  last_contact_at timestamptz not null default now(),
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  visit_count integer not null default 0 check (visit_count >= 0),
  notes text,
  created_by_user_id bigint references public.app_users(id) on delete set null,
  updated_by_user_id bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((marketing_consent = 'unknown' and marketing_consent_at is null)
    or marketing_consent <> 'unknown')
);

create table public.client_consent_events (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'phone', 'sms', 'whatsapp', 'email')),
  decision text not null check (decision in ('granted', 'denied', 'withdrawn')),
  consent_text_version text,
  source text not null,
  actor_user_id bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.client_events (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 2 and 60),
  source text not null,
  appointment_id uuid references public.appointments(id) on delete set null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  actor_user_id bigint references public.app_users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.appointments
  add column client_id uuid references public.clients(id) on delete restrict;

create index clients_last_visit_idx on public.clients (last_visit_at desc);
create index clients_marketing_idx on public.clients (marketing_consent, lifecycle_status, last_visit_at);
create index client_consent_events_client_idx on public.client_consent_events (client_id, created_at desc);
create index client_events_client_idx on public.client_events (client_id, occurred_at desc);
create index client_events_appointment_idx on public.client_events (appointment_id) where appointment_id is not null;
create index appointments_client_idx on public.appointments (client_id, starts_at desc) where client_id is not null;

alter table public.clients enable row level security;
alter table public.client_consent_events enable row level security;
alter table public.client_events enable row level security;

revoke all on table public.clients from anon, authenticated;
revoke all on table public.client_consent_events from anon, authenticated;
revoke all on table public.client_events from anon, authenticated;
revoke all on sequence public.client_consent_events_id_seq from anon, authenticated;
revoke all on sequence public.client_events_id_seq from anon, authenticated;

grant select, insert, update, delete on table public.clients to service_role;
grant select, insert, update, delete on table public.client_consent_events to service_role;
grant select, insert, update, delete on table public.client_events to service_role;
grant usage, select on sequence public.client_consent_events_id_seq to service_role;
grant usage, select on sequence public.client_events_id_seq to service_role;

create or replace function public.maestro_normalize_phone(p_phone text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  with normalized as (
    select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when length(digits) = 9 then '+998' || digits
    when length(digits) between 7 and 15 then '+' || digits
    else null
  end
  from normalized;
$$;

revoke execute on function public.maestro_normalize_phone(text) from public, anon, authenticated;
grant execute on function public.maestro_normalize_phone(text) to service_role;

create or replace function public.maestro_upsert_client(
  p_full_name text,
  p_phone text,
  p_source text,
  p_telegram_user_id text default null,
  p_telegram_username text default null,
  p_language text default 'unknown',
  p_actor_user_id bigint default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_phone text;
  client_id uuid;
begin
  normalized_phone := public.maestro_normalize_phone(p_phone);
  if normalized_phone is null or nullif(btrim(p_full_name), '') is null then
    return null;
  end if;

  insert into public.clients (
    full_name, phone_e164, telegram_user_id, telegram_username, preferred_language,
    first_source, last_source, created_by_user_id, updated_by_user_id
  ) values (
    btrim(p_full_name), normalized_phone, nullif(btrim(p_telegram_user_id), ''),
    nullif(btrim(p_telegram_username), ''),
    case when p_language in ('ru', 'uz') then p_language else 'unknown' end,
    coalesce(nullif(btrim(p_source), ''), 'unknown'),
    coalesce(nullif(btrim(p_source), ''), 'unknown'),
    p_actor_user_id, p_actor_user_id
  )
  on conflict (phone_e164) do update set
    full_name = excluded.full_name,
    telegram_user_id = coalesce(excluded.telegram_user_id, public.clients.telegram_user_id),
    telegram_username = coalesce(excluded.telegram_username, public.clients.telegram_username),
    preferred_language = case when excluded.preferred_language = 'unknown'
      then public.clients.preferred_language else excluded.preferred_language end,
    last_source = excluded.last_source,
    last_contact_at = now(),
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = now()
  returning id into client_id;

  insert into public.client_events (client_id, event_type, source, actor_user_id)
  values (client_id, 'contact_captured', coalesce(nullif(btrim(p_source), ''), 'unknown'), p_actor_user_id);

  return client_id;
end;
$$;

revoke execute on function public.maestro_upsert_client(text, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_upsert_client(text, text, text, text, text, text, bigint)
  to service_role;

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
      client_id, master_id, service_id, service_name, price_uzs, duration_minutes,
      starts_at, ends_at, client_name, client_phone, notes, status, source,
      created_by_user_id, updated_by_user_id
    ) values (
      resolved_client_id, p_master_id, service_record.id, service_record.name_ru,
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
    'service_id', appointment_record.service_id, 'starts_at', appointment_record.starts_at,
    'status', appointment_record.status, 'source', appointment_record.source
  ), p_actor_user_id);

  insert into public.client_events (client_id, event_type, source, appointment_id, actor_user_id, details)
  values (resolved_client_id, 'appointment_created', p_source, appointment_record.id,
    p_actor_user_id, jsonb_build_object('status', appointment_record.status));

  return jsonb_build_object('ok', true, 'appointment', to_jsonb(appointment_record));
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
  appointment_record public.appointments;
  old_status text;
begin
  if p_status not in ('pending', 'confirmed', 'completed', 'cancelled', 'no_show') then
    return jsonb_build_object('ok', false, 'error', 'invalid_appointment_status');
  end if;

  select * into appointment_record from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'appointment_not_found'); end if;

  old_status := appointment_record.status;
  update public.appointments set
    status = p_status, updated_by_user_id = p_actor_user_id, updated_at = now(),
    cancelled_at = case when p_status = 'cancelled' then now() else null end
  where id = p_appointment_id returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values, actor_user_id)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', old_status),
    jsonb_build_object('status', appointment_record.status), p_actor_user_id);

  if appointment_record.client_id is not null and old_status is distinct from p_status then
    insert into public.client_events (client_id, event_type, source, appointment_id, actor_user_id, details)
    values (appointment_record.client_id, 'appointment_status_changed', appointment_record.source,
      appointment_record.id, p_actor_user_id, jsonb_build_object('old_status', old_status, 'new_status', p_status));

    update public.clients as client set
      visit_count = stats.visit_count,
      first_visit_at = stats.first_visit_at,
      last_visit_at = stats.last_visit_at,
      lifecycle_status = case when stats.visit_count > 0 then 'active' else client.lifecycle_status end,
      updated_by_user_id = p_actor_user_id,
      updated_at = now()
    from (
      select count(*)::integer as visit_count, min(starts_at) as first_visit_at, max(starts_at) as last_visit_at
      from public.appointments
      where client_id = appointment_record.client_id and status = 'completed'
    ) as stats
    where client.id = appointment_record.client_id;
  end if;

  return jsonb_build_object('ok', true, 'appointment', to_jsonb(appointment_record));
end;
$$;

create view public.client_export
with (security_invoker = true)
as
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
  case when client.last_visit_at is null then null
    else (current_date - (client.last_visit_at at time zone 'Asia/Tashkent')::date) end as days_since_last_visit,
  (client.marketing_consent = 'granted' and client.lifecycle_status = 'active') as eligible_for_marketing
from public.clients as client;

revoke all on table public.client_export from public, anon, authenticated;
grant select on table public.client_export to service_role;
