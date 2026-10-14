-- A master's hours change on a date, like his commission. Until now the table
-- held one week per master and an edit rewrote it in place, so moving a shift
-- also moved the yardstick for every day already worked: last month's on-time
-- arrivals could turn into lateness overnight.
--
-- Each row now belongs to a version that starts on effective_from. For any day
-- the version in force is the master's latest one that has started, and a
-- weekday missing from it is a day off. Rows written before this migration
-- form the version that has always been in force (2000-01-01), so nothing
-- already computed moves.
--
-- The owner edits schedules in Настройки → График мастеров. The api action
-- setMasterSchedule calls maestro_set_master_schedule, and delMasterSchedule
-- calls maestro_delete_master_schedule.

alter table public.master_schedule_rules
  add column if not exists effective_from date not null default '2000-01-01',
  add column if not exists created_by_user_id bigint references public.app_users (id) on delete set null;

-- The old key let a master have each (weekday, hours) once in all history, so
-- returning to an earlier week would have collided with it.
alter table public.master_schedule_rules
  drop constraint if exists master_schedule_rules_master_id_iso_weekday_starts_at_ends__key;
alter table public.master_schedule_rules
  drop constraint if exists master_schedule_rules_version_key;
alter table public.master_schedule_rules
  add constraint master_schedule_rules_version_key
  unique (master_id, effective_from, iso_weekday, starts_at, ends_at);

create or replace function public.maestro_schedule_version_on(p_master_id bigint, p_day date)
returns date
language sql
stable
set search_path = ''
as $$
  select max(rule.effective_from)
  from public.master_schedule_rules as rule
  where rule.master_id = p_master_id
    and rule.active
    and rule.effective_from <= p_day
$$;

-- Online booking is switched off, but its slot functions still read this
-- table. Without the version filter a master would be offered the hours of
-- every week he ever had.
create or replace function public.maestro_get_available_slots(p_service_id text, p_work_date date, p_master_id bigint DEFAULT NULL::bigint, p_step_minutes integer DEFAULT 15)
 RETURNS TABLE(master_id bigint, slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
      and rule.effective_from = public.maestro_schedule_version_on(rule.master_id, p_work_date)
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
$function$;

create or replace function public.maestro_get_available_slots_for_duration(p_duration_minutes integer, p_work_date date, p_master_id bigint DEFAULT NULL::bigint, p_step_minutes integer DEFAULT 15)
 RETURNS TABLE(master_id bigint, slot_start timestamp with time zone, slot_end timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with candidates as (
    select
      rule.master_id,
      generated.slot_start,
      generated.slot_start + make_interval(mins => p_duration_minutes) as slot_end
    from public.master_schedule_rules as rule
    cross join lateral generate_series(
      (p_work_date + rule.starts_at) at time zone 'Asia/Tashkent',
      ((p_work_date + rule.ends_at) at time zone 'Asia/Tashkent')
        - make_interval(mins => p_duration_minutes),
      make_interval(mins => p_step_minutes)
    ) as generated(slot_start)
    where rule.active
      and rule.iso_weekday = extract(isodow from p_work_date)::smallint
      and rule.effective_from = public.maestro_schedule_version_on(rule.master_id, p_work_date)
      and (p_master_id is null or rule.master_id = p_master_id)
      and p_duration_minutes between 5 and 600
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
$function$;

-- Saves one master's week from a date. p_days lists the working days only,
-- as [{iso_weekday, starts_at, ends_at}]; a weekday left out is a day off.
-- Saving again for the same date replaces that version, so a mistake made
-- today is corrected by saving today again.
create or replace function public.maestro_set_master_schedule(
  p_master_id bigint,
  p_effective_from date,
  p_days jsonb,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  day_count integer;
  weekday_count integer;
begin
  if p_master_id is null or p_effective_from is null or p_days is null or jsonb_typeof(p_days) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  end if;

  if not exists (select 1 from public.masters where id = p_master_id and active) then
    return jsonb_build_object('ok', false, 'error', 'master_not_active');
  end if;

  select count(*), count(distinct (day.value ->> 'iso_weekday'))
    into day_count, weekday_count
  from jsonb_array_elements(p_days) as day;
  -- A version with no working day cannot be told apart from no version at
  -- all; a holiday is a day off in Команда, not an empty week.
  if day_count = 0 then
    return jsonb_build_object('ok', false, 'error', 'schedule_needs_work_day');
  end if;
  if day_count > 7 or weekday_count <> day_count then
    return jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  end if;

  -- Two saves for one master must not interleave their delete and insert.
  perform pg_advisory_xact_lock(hashtextextended('master_schedule:' || p_master_id::text, 0));

  delete from public.master_schedule_rules
  where master_id = p_master_id and effective_from = p_effective_from;

  insert into public.master_schedule_rules (
    master_id, effective_from, iso_weekday, starts_at, ends_at, active, created_by_user_id
  )
  select
    p_master_id,
    p_effective_from,
    (day.value ->> 'iso_weekday')::smallint,
    (day.value ->> 'starts_at')::time,
    (day.value ->> 'ends_at')::time,
    true,
    p_actor_user_id
  from jsonb_array_elements(p_days) as day;

  return jsonb_build_object('ok', true, 'effective_from', p_effective_from, 'days', day_count);
exception
  -- The block rolls back on error, so a bad day never leaves the version
  -- half deleted.
  when check_violation or not_null_violation or invalid_datetime_format
    or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('ok', false, 'error', 'invalid_schedule');
end;
$$;

-- Cancels a change that has not started yet. A version already in force is
-- the record of how past days were judged and stays.
create or replace function public.maestro_delete_master_schedule(
  p_master_id bigint,
  p_effective_from date
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  removed integer;
begin
  if p_master_id is null or p_effective_from is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_schedule');
  end if;
  if p_effective_from <= (now() at time zone 'Asia/Tashkent')::date then
    return jsonb_build_object('ok', false, 'error', 'schedule_already_started');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('master_schedule:' || p_master_id::text, 0));

  delete from public.master_schedule_rules
  where master_id = p_master_id and effective_from = p_effective_from;
  get diagnostics removed = row_count;
  if removed = 0 then
    return jsonb_build_object('ok', false, 'error', 'schedule_not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- How lateness is measured. Until now one salon cutoff (shift_start, 10:10)
-- applied to everyone, except a master whose own shift began later. The
-- owner's decision of 2026-10-14: each master is late after his own scheduled
-- start plus the same grace for everyone, ten minutes. The new rule applies
-- from the day this migration runs. Earlier days keep the old one, so
-- September's lateness does not change; shift_start stays because those days
-- are still judged by it.
alter table public.settings
  add column if not exists late_grace_minutes integer not null default 10
    check (late_grace_minutes between 0 and 120),
  add column if not exists late_rule_since date;

update public.settings
   set late_rule_since = (now() at time zone 'Asia/Tashkent')::date
 where id = 1 and late_rule_since is null;

revoke execute on function public.maestro_schedule_version_on(bigint, date) from public, anon, authenticated;
revoke execute on function public.maestro_set_master_schedule(bigint, date, jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.maestro_delete_master_schedule(bigint, date) from public, anon, authenticated;
grant execute on function public.maestro_schedule_version_on(bigint, date) to service_role;
grant execute on function public.maestro_set_master_schedule(bigint, date, jsonb, bigint) to service_role;
grant execute on function public.maestro_delete_master_schedule(bigint, date) to service_role;
