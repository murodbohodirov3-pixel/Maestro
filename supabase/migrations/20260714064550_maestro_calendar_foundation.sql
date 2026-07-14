create extension if not exists pgcrypto;
create extension if not exists btree_gist with schema extensions;

create table public.booking_services (
  id text primary key,
  name_ru text not null,
  name_uz text not null,
  price_uzs bigint not null check (price_uzs >= 0),
  duration_minutes integer not null check (duration_minutes between 5 and 240),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.booking_services (id, name_ru, name_uz, price_uzs, duration_minutes) values
  ('mens_haircut', 'Мужская стрижка', 'Erkaklar soch turmagi', 150000, 60),
  ('clipper_haircut', 'Мужская стрижка под машинку', 'Mashinkada erkaklarni sochini olish', 100000, 40),
  ('kids_haircut_under_14', 'Детская стрижка до 14 лет', '14 yoshgacha bolalar soch turmagi', 100000, 60),
  ('mens_haircut_hair_coloring', 'Мужская стрижка + окраска волос', 'Erkaklar soch turmagi + soch bo''yash', 200000, 100),
  ('head_toning', 'Тонировка головы', 'Sochni tonlash', 100000, 30),
  ('styling', 'Укладка', 'Soch turmaklash', 60000, 30),
  ('edging', 'Окантовка', 'Soch chetlarini tekislash', 70000, 40),
  ('beard_modeling', 'Моделирование бороды', 'Soqolni modellashtirish', 70000, 30),
  ('beard_modeling_coloring', 'Моделирование бороды + окраска бороды', 'Soqolni modellashtirish + bo''yash', 100000, 60),
  ('haircut_beard_modeling', 'Стрижка + моделирование бороды', 'Soch turmagi + soqolni modellashtirish', 180000, 90),
  ('hair_coloring', 'Окраска волос', 'Soch bo''yash', 80000, 30),
  ('beard_coloring', 'Окраска бороды', 'Soqol bo''yash', 80000, 30),
  ('steam_face_cleansing', 'Чистка лица паровым аппаратом (скраб + маска)', 'Yuzni bug'' apparati bilan tozalash (skrab + niqob)', 100000, 40),
  ('face_mask', 'Чистка лица (маска)', 'Yuzni tozalash (niqob)', 35000, 20),
  ('waxing_one_zone', 'Удаление воском — 1 зона', 'Vosk bilan tozalash — 1 zona', 20000, 15),
  ('complex_head_massage', 'Комплексный массаж головы', 'Proffesional bosh massaji', 60000, 15),
  ('promo_haircut_mask_head_massage', 'Стрижка + маска + массаж головы', 'Soch turmagi + niqob + bosh massaji', 150000, 60);

create table public.master_schedule_rules (
  id uuid primary key default gen_random_uuid(),
  master_id bigint not null references public.masters(id) on delete restrict,
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (master_id, iso_weekday, starts_at, ends_at)
);

create table public.master_day_statuses (
  id uuid primary key default gen_random_uuid(),
  master_id bigint not null references public.masters(id) on delete restrict,
  work_date date not null,
  status text not null check (status in ('day_off')),
  note text,
  created_by_user_id bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (master_id, work_date)
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  master_id bigint not null references public.masters(id) on delete restrict,
  service_id text not null references public.booking_services(id) on delete restrict,
  service_name text not null,
  price_uzs bigint not null check (price_uzs >= 0),
  duration_minutes integer not null check (duration_minutes between 5 and 240),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  client_name text not null check (char_length(client_name) between 1 and 120),
  client_phone text,
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
  source text not null default 'admin' check (source in ('admin', 'bot')),
  created_by_user_id bigint references public.app_users(id) on delete set null,
  updated_by_user_id bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (ends_at > starts_at)
);

alter table public.appointments
  add constraint appointments_no_master_overlap
  exclude using gist (
    master_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending', 'confirmed'));

create table public.appointment_events (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  event_type text not null check (event_type in ('created', 'updated', 'status_changed', 'rescheduled')),
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  actor_user_id bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index master_schedule_rules_lookup_idx
  on public.master_schedule_rules (iso_weekday, master_id) where active;
create index master_day_statuses_lookup_idx
  on public.master_day_statuses (work_date, master_id);
create index appointments_calendar_idx
  on public.appointments (master_id, starts_at, ends_at);
create index appointments_status_start_idx
  on public.appointments (status, starts_at);
create index appointment_events_appointment_idx
  on public.appointment_events (appointment_id, created_at desc);

alter table public.booking_services enable row level security;
alter table public.master_schedule_rules enable row level security;
alter table public.master_day_statuses enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_events enable row level security;

revoke all on table public.booking_services from anon, authenticated;
revoke all on table public.master_schedule_rules from anon, authenticated;
revoke all on table public.master_day_statuses from anon, authenticated;
revoke all on table public.appointments from anon, authenticated;
revoke all on table public.appointment_events from anon, authenticated;

grant select, insert, update, delete on table public.booking_services to service_role;
grant select, insert, update, delete on table public.master_schedule_rules to service_role;
grant select, insert, update, delete on table public.master_day_statuses to service_role;
grant select, insert, update, delete on table public.appointments to service_role;
grant select, insert, update, delete on table public.appointment_events to service_role;
grant usage, select on sequence public.appointment_events_id_seq to service_role;

create or replace function public.maestro_set_master_day_off(
  p_master_id bigint,
  p_work_date date,
  p_enabled boolean,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  conflicts jsonb;
begin
  if p_master_id is null or p_work_date is null or p_enabled is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_day_off_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_master_id::text || ':' || p_work_date::text, 0));

  if p_enabled then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', appointment.id,
      'client_name', appointment.client_name,
      'starts_at', appointment.starts_at,
      'status', appointment.status
    ) order by appointment.starts_at), '[]'::jsonb)
    into conflicts
    from public.appointments as appointment
    where appointment.master_id = p_master_id
      and appointment.status in ('pending', 'confirmed')
      and appointment.starts_at < ((p_work_date + 1)::timestamp at time zone 'Asia/Tashkent')
      and appointment.ends_at > (p_work_date::timestamp at time zone 'Asia/Tashkent');

    if jsonb_array_length(conflicts) > 0 then
      return jsonb_build_object('ok', false, 'error', 'appointments_exist', 'appointments', conflicts);
    end if;

    insert into public.master_day_statuses (master_id, work_date, status, created_by_user_id)
    values (p_master_id, p_work_date, 'day_off', p_actor_user_id)
    on conflict (master_id, work_date) do update
      set status = 'day_off',
          created_by_user_id = excluded.created_by_user_id,
          updated_at = now();
  else
    delete from public.master_day_statuses
    where master_id = p_master_id and work_date = p_work_date and status = 'day_off';
  end if;

  return jsonb_build_object('ok', true, 'enabled', p_enabled);
end;
$$;

revoke execute on function public.maestro_set_master_day_off(bigint, date, boolean, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_set_master_day_off(bigint, date, boolean, bigint)
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
begin
  if p_master_id is null or p_service_id is null or p_starts_at is null
    or nullif(btrim(p_client_name), '') is null
    or p_status not in ('pending', 'confirmed')
    or p_source not in ('admin', 'bot') then
    return jsonb_build_object('ok', false, 'error', 'invalid_appointment');
  end if;

  select id, name_ru, price_uzs, duration_minutes
  into service_record
  from public.booking_services
  where id = p_service_id and active;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'service_not_found');
  end if;

  local_date := (p_starts_at at time zone 'Asia/Tashkent')::date;
  perform pg_advisory_xact_lock(hashtextextended(p_master_id::text || ':' || local_date::text, 0));

  if exists (
    select 1 from public.master_day_statuses
    where master_id = p_master_id and work_date = local_date and status = 'day_off'
  ) then
    return jsonb_build_object('ok', false, 'error', 'master_day_off');
  end if;

  begin
    insert into public.appointments (
      master_id, service_id, service_name, price_uzs, duration_minutes,
      starts_at, ends_at, client_name, client_phone, notes, status, source,
      created_by_user_id, updated_by_user_id
    ) values (
      p_master_id, service_record.id, service_record.name_ru, service_record.price_uzs,
      service_record.duration_minutes, p_starts_at,
      p_starts_at + make_interval(mins => service_record.duration_minutes),
      btrim(p_client_name), nullif(btrim(p_client_phone), ''), nullif(btrim(p_notes), ''),
      p_status, p_source, p_actor_user_id, p_actor_user_id
    ) returning * into appointment_record;
  exception
    when exclusion_violation then
      return jsonb_build_object('ok', false, 'error', 'slot_already_booked');
  end;

  insert into public.appointment_events (
    appointment_id, event_type, new_values, actor_user_id
  ) values (
    appointment_record.id,
    'created',
    jsonb_build_object(
      'master_id', appointment_record.master_id,
      'service_id', appointment_record.service_id,
      'starts_at', appointment_record.starts_at,
      'status', appointment_record.status,
      'source', appointment_record.source
    ),
    p_actor_user_id
  );

  return jsonb_build_object('ok', true, 'appointment', to_jsonb(appointment_record));
end;
$$;

revoke execute on function public.maestro_create_appointment(bigint, text, timestamptz, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_create_appointment(bigint, text, timestamptz, text, text, text, text, text, bigint)
  to service_role;

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

  select * into appointment_record
  from public.appointments
  where id = p_appointment_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'appointment_not_found');
  end if;

  old_status := appointment_record.status;
  update public.appointments
  set status = p_status,
      updated_by_user_id = p_actor_user_id,
      updated_at = now(),
      cancelled_at = case when p_status = 'cancelled' then now() else null end
  where id = p_appointment_id
  returning * into appointment_record;

  insert into public.appointment_events (
    appointment_id, event_type, old_values, new_values, actor_user_id
  ) values (
    appointment_record.id,
    'status_changed',
    jsonb_build_object('status', old_status),
    jsonb_build_object('status', appointment_record.status),
    p_actor_user_id
  );

  return jsonb_build_object('ok', true, 'appointment', to_jsonb(appointment_record));
end;
$$;

revoke execute on function public.maestro_set_appointment_status(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.maestro_set_appointment_status(uuid, text, bigint)
  to service_role;

create or replace function public.maestro_get_available_slots(
  p_service_id text,
  p_work_date date,
  p_master_id bigint default null,
  p_step_minutes integer default 15
)
returns table (master_id bigint, slot_start timestamptz, slot_end timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  with service as (
    select duration_minutes
    from public.booking_services
    where id = p_service_id and active
  ),
  candidates as (
    select
      rule.master_id,
      generated.slot_start,
      generated.slot_start + make_interval(mins => service.duration_minutes) as slot_end
    from public.master_schedule_rules as rule
    cross join service
    cross join lateral generate_series(
      (p_work_date + rule.starts_at) at time zone 'Asia/Tashkent',
      ((p_work_date + rule.ends_at) at time zone 'Asia/Tashkent')
        - make_interval(mins => service.duration_minutes),
      make_interval(mins => p_step_minutes)
    ) as generated(slot_start)
    where rule.active
      and rule.iso_weekday = extract(isodow from p_work_date)::smallint
      and (p_master_id is null or rule.master_id = p_master_id)
      and p_step_minutes between 5 and 60
      and not exists (
        select 1 from public.master_day_statuses as day_status
        where day_status.master_id = rule.master_id
          and day_status.work_date = p_work_date
          and day_status.status = 'day_off'
      )
  )
  select candidate.master_id, candidate.slot_start, candidate.slot_end
  from candidates as candidate
  where candidate.slot_start >= now()
    and not exists (
      select 1 from public.appointments as appointment
      where appointment.master_id = candidate.master_id
        and appointment.status in ('pending', 'confirmed')
        and tstzrange(appointment.starts_at, appointment.ends_at, '[)')
          && tstzrange(candidate.slot_start, candidate.slot_end, '[)')
    )
  order by candidate.slot_start, candidate.master_id;
$$;

revoke execute on function public.maestro_get_available_slots(text, date, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.maestro_get_available_slots(text, date, bigint, integer)
  to service_role;
