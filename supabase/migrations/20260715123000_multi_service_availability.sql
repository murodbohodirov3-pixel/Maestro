create or replace function public.maestro_get_available_slots_for_duration(
  p_duration_minutes integer,
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
$$;

revoke execute on function public.maestro_get_available_slots_for_duration(integer, date, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.maestro_get_available_slots_for_duration(integer, date, bigint, integer)
  to service_role;
