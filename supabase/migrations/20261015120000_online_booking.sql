-- Online booking from the public page (Maestro-Booking), as decided by the
-- owner on 2026-10-14: a client books at once, with no administrator in the
-- loop, and proves a real phone number through Telegram.
--
-- The flow, end to end:
--   1. booking-hold creates an appointment with status 'pending', source 'web'
--      and hold_expires_at ten minutes ahead. The exclusion constraint already
--      covers pending rows, so the time is gone for everyone else at once.
--   2. The client opens the bot with /start b_<token>. The bot binds the hold
--      to his Telegram id, takes his own contact (never someone else's) and
--      confirms: status 'confirmed', client card upserted.
--   3. A hold nobody confirmed is cancelled by the system ('hold_expired'),
--      every minute by pg_cron and before every new hold.
-- The page's contract is Maestro-Booking/docs/API_CONTRACT.md. The token never
-- reaches the database in clear: only its SHA-256 is stored.

-- ---------------------------------------------------------------- appointments
alter table public.appointments
  add column if not exists hold_expires_at timestamptz,
  add column if not exists booking_token_hash text,
  add column if not exists booking_lang text,
  add column if not exists booking_ip_hash text,
  add column if not exists booking_tg_user_id text;

alter table public.appointments drop constraint if exists appointments_booking_lang_check;
alter table public.appointments add constraint appointments_booking_lang_check
  check (booking_lang is null or booking_lang in ('ru', 'uz'));
alter table public.appointments drop constraint if exists appointments_booking_token_hash_check;
alter table public.appointments add constraint appointments_booking_token_hash_check
  check (booking_token_hash is null or booking_token_hash ~ '^[0-9a-f]{64}$');

create unique index if not exists appointments_booking_token_key
  on public.appointments (booking_token_hash) where booking_token_hash is not null;
create index if not exists appointments_web_holds_idx
  on public.appointments (hold_expires_at) where status = 'pending' and source = 'web';
create index if not exists appointments_booking_tg_idx
  on public.appointments (booking_tg_user_id, created_at desc) where booking_tg_user_id is not null;

alter table public.appointments drop constraint if exists appointments_source_check;
alter table public.appointments add constraint appointments_source_check
  check (source = any (array['admin', 'bot', 'web']));

-- An unconfirmed hold that ran out is cancelled by the system, not by the
-- client or the salon, so the outcome rules learn one more case.
alter table public.appointments drop constraint if exists appointments_cancelled_by_check;
alter table public.appointments add constraint appointments_cancelled_by_check
  check (cancelled_by is null or cancelled_by = any (array['client', 'salon', 'system']));

alter table public.appointments drop constraint if exists appointments_status_reason_code_check;
alter table public.appointments add constraint appointments_status_reason_code_check
  check (status_reason_code is null or status_reason_code = any (array[
    'no_show_no_notice', 'no_show_unreachable', 'no_show_late_arrival', 'no_show_other',
    'client_changed_plans', 'client_illness', 'client_schedule_conflict',
    'client_late_cancellation', 'client_other',
    'salon_master_unavailable', 'salon_schedule_conflict', 'salon_operational_issue', 'salon_other',
    'hold_expired'
  ]));

alter table public.appointments drop constraint if exists appointments_outcome_metadata_check;
alter table public.appointments add constraint appointments_outcome_metadata_check check (
  (
    status = any (array['pending', 'confirmed', 'completed'])
    and cancelled_by is null and status_reason_code is null and status_reason_note is null
    and cancelled_at is null and no_show_at is null
  ) or (
    status = 'no_show' and cancelled_by is null and cancelled_at is null and no_show_at is not null
    and status_reason_code = any (array['no_show_no_notice', 'no_show_unreachable', 'no_show_late_arrival', 'no_show_other'])
    and (status_reason_code <> 'no_show_other' or status_reason_note is not null)
  ) or (
    status = 'cancelled' and cancelled_by = any (array['client', 'salon']) and cancelled_at is not null
    and no_show_at is null
    and (
      (cancelled_by = 'client' and status_reason_code = any (array[
        'client_changed_plans', 'client_illness', 'client_schedule_conflict',
        'client_late_cancellation', 'client_other'
      ])) or (cancelled_by = 'salon' and status_reason_code = any (array[
        'salon_master_unavailable', 'salon_schedule_conflict', 'salon_operational_issue', 'salon_other'
      ]))
    )
    and (status_reason_code <> all (array['client_other', 'salon_other']) or status_reason_note is not null)
  ) or (
    status = 'cancelled' and cancelled_by = 'system' and status_reason_code = 'hold_expired'
    and cancelled_at is not null and no_show_at is null
  )
);

-- ----------------------------------------------------------- the public catalog
create table if not exists public.booking_categories (
  id text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name_ru text not null check (char_length(btrim(name_ru)) between 1 and 60),
  name_uz text not null check (char_length(btrim(name_uz)) between 1 and 60),
  sort_order integer not null default 100,
  active boolean not null default true
);
alter table public.booking_categories enable row level security;
revoke all on public.booking_categories from anon, authenticated;

insert into public.booking_categories (id, name_ru, name_uz, sort_order) values
  ('haircut', 'Стрижки', 'Soch olish', 1),
  ('combo', 'Комплексы', 'Kompleks xizmatlar', 2),
  ('beard', 'Борода', 'Soqol', 3),
  ('color', 'Окрашивание', 'Bo''yash', 4),
  ('care', 'Уход', 'Parvarish', 5)
on conflict (id) do nothing;

alter table public.booking_services
  add column if not exists category text references public.booking_categories (id),
  add column if not exists description_ru text,
  add column if not exists description_uz text,
  add column if not exists photo_url text,
  add column if not exists sort_order integer not null default 100;

-- Where each service of the July price list goes. Prices and durations stay
-- as they are; the owner checks them against the current list.
update public.booking_services as service
   set category = placed.category, sort_order = placed.sort_order
  from (values
    ('mens_haircut', 'haircut', 1),
    ('clipper_haircut', 'haircut', 2),
    ('kids_haircut_under_14', 'haircut', 3),
    ('edging', 'haircut', 4),
    ('styling', 'haircut', 5),
    ('haircut_beard_modeling', 'combo', 1),
    ('mens_haircut_hair_coloring', 'combo', 2),
    ('promo_haircut_mask_head_massage', 'combo', 3),
    ('beard_modeling', 'beard', 1),
    ('beard_coloring', 'beard', 2),
    ('beard_modeling_coloring', 'beard', 3),
    ('hair_coloring', 'color', 1),
    ('head_toning', 'color', 2),
    ('complex_head_massage', 'care', 1),
    ('face_mask', 'care', 2),
    ('steam_face_cleansing', 'care', 3),
    ('waxing_one_zone', 'care', 4)
  ) as placed (id, category, sort_order)
 where service.id = placed.id and service.category is null;

alter table public.masters
  add column if not exists name_uz text,
  add column if not exists photo_url text,
  add column if not exists level text not null default 'barber',
  add column if not exists show_online boolean not null default true,
  -- null: the master does every service.
  add column if not exists online_service_ids text[];
alter table public.masters drop constraint if exists masters_level_check;
alter table public.masters add constraint masters_level_check check (level in ('barber', 'senior', 'top'));

update public.masters as master
   set name_uz = latin.name_uz
  from (values
    (1, 'Javohir'), (2, 'Ibrohim'), (3, 'Javlon'), (4, 'Jamoliddin'),
    (6, 'Mironshoh'), (21, 'Ziyodulla'), (24, 'Salim')
  ) as latin (id, name_uz)
 where master.id = latin.id and master.name_uz is null;

-- The salon as the page shows it. salon_lat/salon_lng already exist for the
-- check-in radius; the map uses them when set and the address pin otherwise.
alter table public.settings
  add column if not exists salon_name text not null default 'Maestro Barberia',
  add column if not exists salon_address_ru text,
  add column if not exists salon_address_uz text,
  add column if not exists salon_phone text,
  add column if not exists salon_instagram text,
  add column if not exists salon_telegram text,
  add column if not exists salon_map_lat double precision,
  add column if not exists salon_map_lng double precision,
  add column if not exists opening_hours jsonb,
  add column if not exists booking_horizon_days integer not null default 31;
alter table public.settings drop constraint if exists settings_booking_horizon_days_check;
alter table public.settings add constraint settings_booking_horizon_days_check
  check (booking_horizon_days between 1 and 62);

update public.settings set
  salon_address_ru = coalesce(salon_address_ru, 'ул. Чинабад, 8, Ташкент'),
  salon_address_uz = coalesce(salon_address_uz, 'Chinobod ko''chasi, 8, Toshkent'),
  salon_phone = coalesce(salon_phone, '+998200143000'),
  salon_instagram = coalesce(salon_instagram, 'https://www.instagram.com/maestro.barberia/'),
  salon_telegram = coalesce(salon_telegram, 'https://t.me/maestrobarberia'),
  salon_map_lat = coalesce(salon_map_lat, 41.3512479),
  salon_map_lng = coalesce(salon_map_lng, 69.2895722),
  opening_hours = coalesce(opening_hours, (
    select jsonb_agg(jsonb_build_object('iso_weekday', day, 'opens', '09:00', 'closes', '23:00') order by day)
    from generate_series(1, 7) as day
  ))
where id = 1;

-- ---------------------------------------------------------------- rate limits
-- Only a hash of the caller's address is kept, salted in the function.
create table if not exists public.booking_rate_events (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index if not exists booking_rate_events_lookup_idx
  on public.booking_rate_events (ip_hash, action, created_at desc);
alter table public.booking_rate_events enable row level security;
revoke all on public.booking_rate_events from anon, authenticated;

-- True when the call is allowed. A refused call is not counted, so waiting
-- out the window always works.
create or replace function public.maestro_booking_rate_hit(
  p_ip_hash text,
  p_action text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_ip_hash is null then return true; end if;
  if (select count(*) from public.booking_rate_events
      where ip_hash = p_ip_hash and action = p_action and created_at > now() - p_window) >= p_limit then
    return false;
  end if;
  insert into public.booking_rate_events (ip_hash, action) values (p_ip_hash, p_action);
  return true;
end;
$$;

-- ----------------------------------------------------------------- free time
-- Every free start, 15 minutes apart, for some masters over a range of days:
-- the version of each master's week in force that day, minus his days off,
-- minus every pending or confirmed appointment. The same rules as
-- maestro_get_available_slots_for_duration, over many days in one pass.
create or replace function public.maestro_booking_slots(
  p_duration_minutes integer,
  p_from date,
  p_to date,
  p_master_ids bigint[],
  p_not_before timestamptz,
  -- A booking being moved does not stand in its own way.
  p_except_appointment uuid default null
)
returns table (master_id bigint, slot_start timestamptz)
language sql
stable
set search_path = ''
as $$
  with days as (
    select day::date as work_date
    from generate_series(p_from, p_to, interval '1 day') as day
  ),
  rules as (
    select day.work_date, rule.master_id, rule.starts_at, rule.ends_at
    from days as day
    join public.master_schedule_rules as rule
      on rule.active
     and rule.iso_weekday = extract(isodow from day.work_date)::smallint
     and rule.effective_from = public.maestro_schedule_version_on(rule.master_id, day.work_date)
    where rule.master_id = any (p_master_ids)
      and not exists (
        select 1 from public.master_day_statuses as day_status
        where day_status.master_id = rule.master_id
          and day_status.work_date = day.work_date
          and day_status.status = 'day_off'
      )
  ),
  candidates as (
    select rule.master_id,
      generated.slot_start,
      generated.slot_start + make_interval(mins => p_duration_minutes) as slot_end
    from rules as rule
    cross join lateral generate_series(
      (rule.work_date + rule.starts_at) at time zone 'Asia/Tashkent',
      ((rule.work_date + rule.ends_at) at time zone 'Asia/Tashkent') - make_interval(mins => p_duration_minutes),
      interval '15 minutes'
    ) as generated (slot_start)
  )
  select candidate.master_id, candidate.slot_start
  from candidates as candidate
  where p_duration_minutes between 5 and 600
    and candidate.slot_start >= p_not_before
    and not exists (
      select 1 from public.appointments as appointment
      where appointment.master_id = candidate.master_id
        and appointment.status in ('pending', 'confirmed')
        and appointment.id is distinct from p_except_appointment
        and tstzrange(appointment.starts_at, appointment.ends_at, '[)')
          && tstzrange(candidate.slot_start, candidate.slot_end, '[)')
    )
  order by candidate.slot_start, candidate.master_id
$$;

-- The first day each master has free time, and its first few starts: the
-- list of masters shows these under every name.
create or replace function public.maestro_booking_nearest(
  p_duration_minutes integer,
  p_from date,
  p_to date,
  p_master_ids bigint[],
  p_not_before timestamptz,
  p_limit integer
)
returns table (master_id bigint, slot_start timestamptz)
language sql
stable
set search_path = ''
as $$
  with slots as (
    select slot.master_id, slot.slot_start, (slot.slot_start at time zone 'Asia/Tashkent')::date as work_date
    from public.maestro_booking_slots(p_duration_minutes, p_from, p_to, p_master_ids, p_not_before) as slot
  ),
  first_day as (
    select slots.master_id, min(slots.work_date) as work_date from slots group by slots.master_id
  ),
  ranked as (
    select slots.master_id, slots.slot_start,
      row_number() over (partition by slots.master_id order by slots.slot_start) as position
    from slots
    join first_day on first_day.master_id = slots.master_id and first_day.work_date = slots.work_date
  )
  select ranked.master_id, ranked.slot_start
  from ranked
  where ranked.position <= greatest(1, least(coalesce(p_limit, 5), 20))
  order by ranked.master_id, ranked.slot_start
$$;

-- The days with any free time at all: the calendar greys out the rest.
create or replace function public.maestro_booking_days(
  p_duration_minutes integer,
  p_from date,
  p_to date,
  p_master_ids bigint[],
  p_not_before timestamptz
)
returns table (work_date date)
language sql
stable
set search_path = ''
as $$
  select distinct (slot.slot_start at time zone 'Asia/Tashkent')::date
  from public.maestro_booking_slots(p_duration_minutes, p_from, p_to, p_master_ids, p_not_before) as slot
  order by 1
$$;

-- ------------------------------------------------------------- one booking
-- What the page and the bot are told about a booking. No phone, no client name.
create or replace function public.maestro_booking_view(p_appointment public.appointments)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', case
      when p_appointment.status = 'pending' and p_appointment.hold_expires_at > now() then 'held'
      when p_appointment.status = 'pending' then 'expired'
      when p_appointment.status in ('confirmed', 'completed', 'no_show') then 'confirmed'
      when p_appointment.status_reason_code = 'hold_expired' then 'expired'
      else 'cancelled'
    end,
    'hold_expires_at', p_appointment.hold_expires_at,
    'master_id', p_appointment.master_id,
    'starts_at', p_appointment.starts_at,
    'ends_at', p_appointment.ends_at,
    'service_ids', to_jsonb(p_appointment.service_ids),
    'total_price_uzs', p_appointment.price_uzs,
    'total_duration_minutes', p_appointment.duration_minutes
  )
$$;

-- Holds nobody confirmed in time give their time back. Run every minute by
-- pg_cron and at the start of every new hold.
create or replace function public.maestro_expire_booking_holds()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  expired_count integer;
begin
  with expired as (
    update public.appointments
       set status = 'cancelled',
           cancelled_by = 'system',
           status_reason_code = 'hold_expired',
           cancelled_at = now(),
           updated_at = now()
     where status = 'pending' and source = 'web' and hold_expires_at <= now()
    returning id
  )
  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  select expired.id, 'status_changed', jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'cancelled', 'cancelled_by', 'system', 'status_reason_code', 'hold_expired')
  from expired;
  get diagnostics expired_count = row_count;

  delete from public.booking_rate_events where created_at < now() - interval '2 days';
  return expired_count;
end;
$$;

-- Takes the time for ten minutes. With p_master_id null the master is chosen
-- here: the one with the fewest bookings that day, then at random. No locks:
-- the exclusion constraint settles a race, and the loser tries the next master.
create or replace function public.maestro_hold_booking(
  p_token_hash text,
  p_service_ids text[],
  p_master_id bigint,
  p_starts_at timestamptz,
  p_client_name text,
  p_comment text,
  p_lang text,
  p_ip_hash text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  clean_name text := nullif(btrim(coalesce(p_client_name, '')), '');
  clean_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  service_record record;
  local_date date;
  today date := (now() at time zone 'Asia/Tashkent')::date;
  horizon integer;
  candidate record;
  appointment_record public.appointments;
  placed boolean := false;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_starts_at is null
     or coalesce(cardinality(p_service_ids), 0) not between 1 and 10
     or cardinality(p_service_ids) <> (select count(distinct item) from unnest(p_service_ids) as item)
     or clean_name is null or char_length(clean_name) > 60
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
        starts_at, ends_at, client_name, notes, status, source,
        hold_expires_at, booking_token_hash, booking_lang, booking_ip_hash
      ) values (
        candidate.id, p_service_ids[1], p_service_ids, service_record.service_name,
        service_record.total_price_uzs, service_record.total_duration_minutes,
        p_starts_at, p_starts_at + make_interval(mins => service_record.total_duration_minutes),
        clean_name, clean_comment, 'pending', 'web',
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

create or replace function public.maestro_booking_by_token(p_token_hash text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  appointment_record public.appointments;
begin
  select * into appointment_record from public.appointments where booking_token_hash = p_token_hash;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'booking', public.maestro_booking_view(appointment_record));
end;
$$;

-- The client changed his mind before confirming in Telegram.
create or replace function public.maestro_release_booking(p_token_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
begin
  select * into appointment_record from public.appointments
  where booking_token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if appointment_record.status = 'cancelled' then return jsonb_build_object('ok', true); end if;
  if appointment_record.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  update public.appointments
     set status = 'cancelled', cancelled_by = 'client', status_reason_code = 'client_changed_plans',
         cancelled_at = now(), updated_at = now()
   where id = appointment_record.id;
  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'cancelled', 'cancelled_by', 'client', 'status_reason_code', 'client_changed_plans'));
  return jsonb_build_object('ok', true);
end;
$$;

-- What the bot needs to show a booking: the master, the services, and whether
-- this Telegram user's number is already known. Each call binds a held booking
-- to whoever opened the link last; only that user can confirm it.
create or replace function public.maestro_booking_for_bot(
  p_token_hash text,
  p_appointment_id uuid,
  p_tg_user_id text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  known record;
  master_name text;
begin
  if p_token_hash is not null then
    select * into appointment_record from public.appointments
    where booking_token_hash = p_token_hash for update;
  else
    select * into appointment_record from public.appointments
    where id = p_appointment_id for update;
  end if;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_token_hash is not null and appointment_record.status = 'pending'
     and appointment_record.hold_expires_at > now()
     and appointment_record.booking_tg_user_id is distinct from p_tg_user_id then
    update public.appointments set booking_tg_user_id = p_tg_user_id, updated_at = now()
     where id = appointment_record.id
    returning * into appointment_record;
  end if;

  select phone_e164, lifecycle_status into known
  from public.clients where telegram_user_id = p_tg_user_id;
  select name into master_name from public.masters where id = appointment_record.master_id;

  return jsonb_build_object(
    'ok', true,
    'appointment_id', appointment_record.id,
    'booking', public.maestro_booking_view(appointment_record),
    'mine', coalesce(appointment_record.booking_tg_user_id = p_tg_user_id, false)
      or exists (select 1 from public.clients where id = appointment_record.client_id and telegram_user_id = p_tg_user_id),
    'master_name', master_name,
    'service_name', appointment_record.service_name,
    'lang', coalesce(appointment_record.booking_lang, 'ru'),
    'known_phone', case when known.lifecycle_status is distinct from 'blocked' then known.phone_e164 end
  );
end;
$$;

-- The held booking this Telegram user opened most recently: a shared contact
-- arrives without the token, so it is found this way.
create or replace function public.maestro_latest_hold_for_telegram(p_tg_user_id text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select id from public.appointments
  where booking_tg_user_id = p_tg_user_id and status = 'pending' and source = 'web'
    and hold_expires_at > now()
  order by created_at desc
  limit 1
$$;

-- Confirms a held booking for the Telegram user it is bound to. p_phone comes
-- from a contact the bot has checked to be the user's own; null means "use the
-- number already on his card".
create or replace function public.maestro_confirm_booking(
  p_appointment_id uuid,
  p_tg_user_id text,
  p_phone text,
  p_tg_username text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  phone text;
  resolved_client_id uuid;
  client_status text;
  master_record record;
begin
  select * into appointment_record from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if appointment_record.booking_tg_user_id is distinct from p_tg_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if appointment_record.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'already_confirmed', true,
      'booking', public.maestro_booking_view(appointment_record));
  end if;
  if appointment_record.status <> 'pending' or appointment_record.hold_expires_at <= now() then
    perform public.maestro_expire_booking_holds();
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  phone := coalesce(
    public.maestro_normalize_phone(p_phone),
    (select phone_e164 from public.clients where telegram_user_id = p_tg_user_id)
  );
  if phone is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  select lifecycle_status into client_status from public.clients where phone_e164 = phone;
  if client_status = 'blocked' then
    update public.appointments
       set status = 'cancelled', cancelled_by = 'salon', status_reason_code = 'salon_other',
           status_reason_note = 'Клиент заблокирован', cancelled_at = now(), updated_at = now()
     where id = appointment_record.id;
    return jsonb_build_object('ok', false, 'error', 'client_blocked');
  end if;

  -- The Telegram account now belongs to this number; an older card that
  -- carried it under another number lets go of it.
  update public.clients set telegram_user_id = null, updated_at = now()
   where telegram_user_id = p_tg_user_id and phone_e164 <> phone;

  resolved_client_id := public.maestro_upsert_client(
    appointment_record.client_name, phone, 'web', p_tg_user_id, p_tg_username,
    coalesce(appointment_record.booking_lang, 'unknown'), null
  );
  if resolved_client_id is null then return jsonb_build_object('ok', false, 'error', 'invalid_phone'); end if;

  update public.appointments
     set status = 'confirmed', client_id = resolved_client_id, client_phone = phone,
         hold_expires_at = null, updated_at = now()
   where id = appointment_record.id
  returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'confirmed', 'client_id', resolved_client_id));
  insert into public.client_events (client_id, event_type, source, appointment_id, details)
  values (resolved_client_id, 'appointment_created', 'web', appointment_record.id,
    jsonb_build_object('status', 'confirmed'));

  select master.name,
    coalesce(
      (select app_user.telegram_id::text from public.app_users as app_user
        where app_user.master_id = master.id and app_user.active and app_user.telegram_id is not null
        limit 1),
      master.telegram_id::text
    ) as chat_id
  into master_record
  from public.masters as master where master.id = appointment_record.master_id;

  return jsonb_build_object(
    'ok', true,
    'already_confirmed', false,
    'appointment_id', appointment_record.id,
    'booking', public.maestro_booking_view(appointment_record),
    'master_name', master_record.name,
    'master_chat_id', master_record.chat_id,
    'service_name', appointment_record.service_name,
    'client_name', appointment_record.client_name,
    'client_phone', phone,
    'comment', appointment_record.notes,
    'lang', coalesce(appointment_record.booking_lang, 'ru')
  );
end;
$$;

-- The client cancels from the bot. Only the Telegram user the booking belongs
-- to may, and only before it starts.
create or replace function public.maestro_cancel_booking_by_client(
  p_appointment_id uuid,
  p_tg_user_id text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  appointment_record public.appointments;
  old_status text;
  reason text;
  master_record record;
begin
  select * into appointment_record from public.appointments where id = p_appointment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not (
    appointment_record.booking_tg_user_id = p_tg_user_id
    or exists (select 1 from public.clients where id = appointment_record.client_id and telegram_user_id = p_tg_user_id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if appointment_record.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'already_cancelled', true);
  end if;
  if appointment_record.status not in ('pending', 'confirmed') or appointment_record.starts_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'too_late');
  end if;

  old_status := appointment_record.status;
  reason := case when appointment_record.starts_at - now() < interval '2 hours'
    then 'client_late_cancellation' else 'client_changed_plans' end;
  update public.appointments
     set status = 'cancelled', cancelled_by = 'client', status_reason_code = reason,
         cancelled_at = now(), hold_expires_at = null, updated_at = now()
   where id = appointment_record.id
  returning * into appointment_record;

  insert into public.appointment_events (appointment_id, event_type, old_values, new_values)
  values (appointment_record.id, 'status_changed', jsonb_build_object('status', old_status),
    jsonb_build_object('status', 'cancelled', 'cancelled_by', 'client', 'status_reason_code', reason));
  if appointment_record.client_id is not null then
    insert into public.client_events (client_id, event_type, source, appointment_id, details)
    values (appointment_record.client_id, 'appointment_outcome_recorded', 'web', appointment_record.id,
      jsonb_build_object('new_status', 'cancelled', 'cancelled_by', 'client', 'reason_code', reason));
  end if;

  select master.name,
    coalesce(
      (select app_user.telegram_id::text from public.app_users as app_user
        where app_user.master_id = master.id and app_user.active and app_user.telegram_id is not null
        limit 1),
      master.telegram_id::text
    ) as chat_id
  into master_record
  from public.masters as master where master.id = appointment_record.master_id;

  return jsonb_build_object(
    'ok', true,
    'already_cancelled', false,
    'booking', public.maestro_booking_view(appointment_record),
    'master_name', master_record.name,
    'master_chat_id', master_record.chat_id,
    'service_name', appointment_record.service_name,
    'client_name', appointment_record.client_name,
    'client_phone', appointment_record.client_phone,
    'lang', coalesce(appointment_record.booking_lang, 'ru')
  );
end;
$$;

-- Reminders for confirmed web bookings, 24 hours and 2 hours ahead, through
-- the existing delivery journal. The older claim function serves the old bot
-- and is left as it was.
create or replace function public.maestro_claim_web_reminders(p_limit integer default 25)
returns table (
  notification_id uuid,
  notification_claim_token uuid,
  appointment_id uuid,
  kind text,
  telegram_chat_id text,
  starts_at timestamptz,
  service_name text,
  master_name text,
  language text
)
language plpgsql
set search_path = ''
as $$
declare
  safe_limit integer := greatest(1, least(coalesce(p_limit, 25), 50));
begin
  insert into public.appointment_notification_deliveries (appointment_id, kind, scheduled_for)
  select candidate.appointment_id, candidate.kind, candidate.scheduled_for
  from (
    select appointment.id as appointment_id, 'reminder_24h'::text as kind,
      appointment.starts_at - interval '24 hours' as scheduled_for
    from public.appointments as appointment
    join public.clients as client on client.id = appointment.client_id
    where appointment.source = 'web' and appointment.status = 'confirmed'
      and client.telegram_user_id is not null
      and appointment.starts_at > now() + interval '22 hours'
      and appointment.starts_at <= now() + interval '24 hours'
    union all
    select appointment.id, 'reminder_2h'::text, appointment.starts_at - interval '2 hours'
    from public.appointments as appointment
    join public.clients as client on client.id = appointment.client_id
    where appointment.source = 'web' and appointment.status = 'confirmed'
      and client.telegram_user_id is not null
      and appointment.starts_at > now() + interval '15 minutes'
      and appointment.starts_at <= now() + interval '2 hours'
  ) as candidate
  on conflict on constraint appointment_notification_deliveries_appointment_id_kind_key do nothing;

  update public.appointment_notification_deliveries as delivery
     set status = 'suppressed', claim_token = null, claimed_at = null, claim_expires_at = null,
         updated_at = now()
    from public.appointments as appointment
   where delivery.appointment_id = appointment.id
     and appointment.source = 'web'
     and delivery.kind in ('reminder_24h', 'reminder_2h')
     and delivery.status in ('pending', 'processing', 'failed')
     and appointment.status <> 'confirmed';

  return query
  with due as (
    select delivery.id
    from public.appointment_notification_deliveries as delivery
    join public.appointments as appointment on appointment.id = delivery.appointment_id
    join public.clients as client on client.id = appointment.client_id
    where appointment.source = 'web'
      and client.telegram_user_id is not null
      and delivery.kind in ('reminder_24h', 'reminder_2h')
      and delivery.attempts < 5
      and delivery.scheduled_for <= now()
      and coalesce(delivery.next_attempt_at, delivery.scheduled_for) <= now()
      and (delivery.status in ('pending', 'failed')
        or (delivery.status = 'processing' and delivery.claim_expires_at < now()))
      and appointment.status = 'confirmed'
      and appointment.starts_at > now() + interval '15 minutes'
    order by delivery.scheduled_for, delivery.id
    for update of delivery skip locked
    limit safe_limit
  ), claimed as (
    update public.appointment_notification_deliveries as delivery
       set status = 'processing', attempts = delivery.attempts + 1,
           claim_token = gen_random_uuid(), claimed_at = now(),
           claim_expires_at = now() + interval '10 minutes', last_error = null, updated_at = now()
      from due
     where delivery.id = due.id
    returning delivery.*
  )
  select claimed.id, claimed.claim_token, appointment.id, claimed.kind, client.telegram_user_id,
    appointment.starts_at, appointment.service_name, master.name,
    coalesce(appointment.booking_lang, case when client.preferred_language in ('ru', 'uz') then client.preferred_language else 'ru' end)
  from claimed
  join public.appointments as appointment on appointment.id = claimed.appointment_id
  join public.clients as client on client.id = appointment.client_id
  join public.masters as master on master.id = appointment.master_id
  order by claimed.scheduled_for, claimed.id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.maestro_booking_rate_hit(text, text, integer, interval)',
    'public.maestro_booking_slots(integer, date, date, bigint[], timestamptz, uuid)',
    'public.maestro_booking_nearest(integer, date, date, bigint[], timestamptz, integer)',
    'public.maestro_booking_days(integer, date, date, bigint[], timestamptz)',
    'public.maestro_booking_view(public.appointments)',
    'public.maestro_expire_booking_holds()',
    'public.maestro_hold_booking(text, text[], bigint, timestamptz, text, text, text, text)',
    'public.maestro_booking_by_token(text)',
    'public.maestro_release_booking(text)',
    'public.maestro_booking_for_bot(text, uuid, text)',
    'public.maestro_latest_hold_for_telegram(text)',
    'public.maestro_confirm_booking(uuid, text, text, text)',
    'public.maestro_cancel_booking_by_client(uuid, text)',
    'public.maestro_claim_web_reminders(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ----------------------------------------------------------------- schedules
-- Holds run out every minute. Reminders are sent by the booking-bot function
-- every five minutes; it checks a shared secret that is not in this file:
--   select vault.create_secret('<value>', 'booking_cron_secret');
-- with the same value as the BOOKING_CRON_SECRET function secret.
select cron.schedule(
  'maestro-booking-holds',
  '* * * * *',
  $job$ select public.maestro_expire_booking_holds(); $job$
);

select cron.schedule(
  'maestro-booking-reminders',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://ivowbhraaistxvoymxpf.supabase.co/functions/v1/booking-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-booking-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'booking_cron_secret')
    ),
    body := '{"action":"reminders"}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id
  where exists (select 1 from vault.decrypted_secrets where name = 'booking_cron_secret');
  $job$
);
